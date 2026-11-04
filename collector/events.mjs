// T-Rex IMPORTANT ANNOUNCEMENTS — only the company events a serious investor needs, sized against the company.
// Runs on GitHub Actions (free). Every NSE announcement of the day is first sorted by simple rules (no AI, no cost):
// routine filings (newspaper copies, trading window, AGM notices, ESOPs, compliance letters …) are dropped at once.
// Only possible big events (orders, capacity, new / exited businesses, acquisitions, mergers, JVs, fund raising, buybacks,
// rating changes, auditor / CFO / MD exits, legal action, insolvency, promoter offers for sale) are read by Claude Haiku
// from the filing itself. A number is kept ONLY when its sentence is found on the filing's page and the number in that
// sentence matches. Then the event is sized against the company (last 4 quarters' revenue, market value from the
// T-Rex database) and kept only when it matters for a company of that size. Facts only — no opinion, no advice.
// Saved per company in the "event-data" branch: e/SYM.json (sealed when DATA_KEY is set) + e/index.json (progress).
// Run: node collector/events.mjs   (needs ANTHROPIC_API_KEY, TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pdfTextPoppler, askClaude, claudeCost } from "./insights.mjs";
import { sealText, openText, sealOn } from "./seal.mjs";

export const BRANCH = "event-data";
export const EV_VERSION = 2;                 // v2: amount types, routine rules, one card per event
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dmy = d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
const isoDay = t => new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);           // IST calendar day
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// NSE dates: "04-Nov-2026 15:42:10" → "2026-11-04"
export function nseDay(s) { const m = String(s || "").match(/(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s](\d{4})/); if (m && MON[m[2].toLowerCase()]) return `${m[3]}-${String(MON[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`; const n = String(s || "").match(/(\d{4})-(\d{2})-(\d{2})/); return n ? n[0] : ""; }

// ---------- 1) the free first sort: is this filing possibly a big event? (subject + NSE's one-line text) ----------
const ROUTINE = /newspaper|trading window|record date|book closure|shareholders meeting|agm|egm notice|esop|esos|esps|loss of share|duplicate share|certificate under|compliance certificate|statement of investor complaints|reg(ulation)?\.? ?74|closure of trading|change in (registered )?address|address change|investor meet|con\. ?call|analysts?\/institutional|monitoring agency|statement of deviation|integrated filing|financial results|clarification|price movement|spurt in volume|news verification|committee meeting|dividend|retirement|change in company secretary|cessation|appointment|change in director/i;
const RULES = [
  ["order", /bagging|receiving of orders|awarding of order|order\(s\)\/contract|contracts?$/i, null],
  ["capacity", /capacity addition|commencement of (commercial )?(production|operation)/i, null],
  ["deal", /^acquisition|amalgamation|merger|scheme of arrangement|sale or disposal|joint venture|demerger|restructuring|disinvest/i, null],
  ["fund", /issue of securities|allotment of securities|preferential|qualified institution|\bqip\b|rights issue|fund raising/i, null],
  ["buyback", /buy ?back/i, null],
  ["rating", /credit rating/i, null],
  ["auditor", /statutory auditor|change in auditors/i, /resign|cessation|withdraw/i],
  ["person", /resignation of director\/kmp|resignation$|change in management/i, /\b(cfo|chief financial|ceo|chief executive|managing director|whole[- ]?time director)\b/i],
  ["legal", /action\(s\) (taken|initiated)|orders? passed|pendency of litigation|penalt|insolvency|default/i, null],
  ["ofs", /offer for sale/i, null],
  ["licence", /key licen[cs]es|regulatory approvals/i, null],
];
// general subjects ("Updates", "Press Release", "Outcome of Board Meeting" …) only with these words in NSE's one-line text
const GENERAL = /^(general updates|updates|press release|outcome of board meeting|board meeting outcome|disclosure under regulation 30|monthly business updates|product launch)/i;
const WORDS = [
  ["order", /\b(order|contract|letter of award|\bloa\b|work order|letter of intent)\b/i, /\b(receiv|bag|secur|award|win|won|bags|declared l1|lowest bidder)/i],
  ["capacity", /commission|commercial (production|operation)|capacity (expansion|addition)|new (plant|facility|unit|line)|greenfield|brownfield|capex/i, null],
  ["deal", /acqui|joint venture|\bjv\b|strategic (investment|partnership|stake)|stake (sale|purchase)|divest|slump sale|demerg|business transfer|amalgamat|merger|sale of (its )?(business|division|undertaking|unit|subsidiary)/i, null],
  ["newbiz", /foray|diversif|new (business|segment|vertical)|enter(s|ed|ing)? (into )?(the )?[a-z ]{0,30}(business|market|segment|sector)|discontinu|closure of (the )?(plant|unit|business|division)|shut ?down|exit(s|ed|ing)? (from )?(the )?[a-z ]{0,30}business/i, null],
  ["fund", /\bqip\b|qualified institutional|preferential (issue|allotment)|rights issue|fund rais/i, null],
  ["buyback", /buy ?back/i, null],
];
export function candidate(row) {
  const subj = String(row.desc || "").replace(/\s+/g, " ").trim(), text = String(row.attchmntText || "").replace(/\s+/g, " ").trim(), both = subj + " " + text;
  for (const [k, a, b] of RULES) if (a.test(subj) && (!b || b.test(both))) return k;
  if (ROUTINE.test(subj)) return null;
  if (GENERAL.test(subj)) for (const [k, a, b] of WORDS) if (a.test(text) && (!b || b.test(text))) return k;
  return null;
}

// ---------- 2) amounts: the sentence must be on the page, the number must be in that sentence ----------
const norm = s => String(s || "").toLowerCase().replace(/[₹]/g, " rs ").replace(/(\d),(?=\d)/g, "$1").replace(/[^a-z0-9.]+/g, " ").replace(/\.(?!\d)|(?<!\d)\./g, " ").replace(/\s+/g, " ").trim();
export function quoteOnPage(quote, pagesText) { const q = norm(quote); return q.length >= 8 && norm(pagesText).includes(q); }
const UNIT_CR = { crore: 1, crores: 1, cr: 1, lakh: 0.01, lakhs: 0.01, lac: 0.01, lacs: 0.01, million: 0.1, mn: 0.1, billion: 100, bn: 100, rupees: 1e-7, rs: 1e-7 };
// → value in ₹ Crore (INR), or for other currencies the value in millions of that currency (sized with an exchange rate later)
export function toCrore(value, unit, currency = "INR", fx = {}) {
  const v = +value; if (!isFinite(v) || v <= 0) return null; const u = String(unit || "").toLowerCase().replace(/[^a-z]/g, "");
  const cur = String(currency || "INR").toUpperCase();
  if (cur === "INR" || cur === "RS") { const f = UNIT_CR[u] ?? (u ? null : 1e-7); return f == null ? null : v * f; }
  const rate = fx[cur]; if (!rate) return null;                                    // 1 unit of the currency in ₹
  const mult = { million: 1e6, mn: 1e6, billion: 1e9, bn: 1e9, thousand: 1e3, k: 1e3 }[u] ?? (u ? null : 1); if (mult == null) return null;
  return v * mult * rate / 1e7;
}
// the number Claude gave must appear in its quote (commas, "Rs." and spacing ignored) — also when the filing writes the
// same amount in another unit (e.g. "Rs 23,89,50,000" for 23.895 crore)
export function numberInQuote(value, quote, unit = "") {
  const nums = (String(quote || "").replace(/(\d),(?=\d)/g, "$1").match(/\d+(?:\.\d+)?/g) || []).map(Number); const v = +value; if (!isFinite(v) || v <= 0) return false;
  const u = String(unit || "").toLowerCase();
  const asRupees = /crore|cr/.test(u) ? v * 1e7 : /lakh|lac/.test(u) ? v * 1e5 : /million|mn/.test(u) ? v * 1e6 : /billion|bn/.test(u) ? v * 1e9 : v;
  const forms = [v, asRupees, asRupees / 1e5, asRupees / 1e6, asRupees / 1e7, asRupees / 1e9];
  return nums.some(n => forms.some(f => Math.abs(n - f) <= Math.max(0.005, Math.abs(f) * 0.001)));
}

// ---------- 3) size against the company, decide if it matters ----------
const WARN = new Set(["auditor_exit", "key_person_exit", "legal", "insolvency", "offer_for_sale"]);
// which kind of amount may size which kind of event (anything else — a rated loan facility, a "sales potential", a
// disputed income figure — is kept out of the size, so it can never look bigger than it is)
const AMOUNT_OK = { order: ["order_value"], capacity: ["capex"], acquisition: ["deal_value"], merger: ["deal_value"], demerger: ["deal_value"], joint_venture: ["deal_value"],
  strategic_investment: ["deal_value"], exit_business: ["deal_value"], new_business: ["capex", "deal_value"], buyback: ["buyback_size"], fund_raise: ["issue_size"],
  legal: ["tax_demand", "penalty", "claim", "default", "relief"], offer_for_sale: ["issue_size", "deal_value"], insolvency: ["default", "claim"] };
export function sizeOf(ev, co) {
  const out = {}; if (ev.amt == null) return out;
  if (co && co.rev > 0) out.rev = Math.round(ev.amt / co.rev * 1000) / 10;          // % of last 4 quarters' revenue
  if (co && co.mcap > 0) out.mcap = Math.round(ev.amt / co.mcap * 1000) / 10;      // % of market value
  return out;
}
export function material(ev) {
  if (ev.routine) return false; const s = ev.size || {}, k = ev.k;
  switch (k) {
    case "order": return s.rev != null ? s.rev >= 5 : ev.amt != null && ev.amt >= 500;
    case "capacity": return s.rev != null ? s.rev >= 3 : true;
    case "new_business": case "exit_business": case "merger": case "demerger": return s.mcap != null ? s.mcap >= 1 : true;
    case "acquisition": case "joint_venture": case "strategic_investment": return s.mcap != null ? s.mcap >= 3 : false;
    case "fund_raise": return /equity|warrant|convertible/.test(ev.ins || "") && (s.mcap != null ? s.mcap >= 3 : false);
    case "buyback": case "auditor_exit": case "offer_for_sale": return true;
    case "insolvency": return true;                                                     // only the big steps reach here (see the prompt)
    case "rating": return !!(ev.r && /upgrade|downgrade/.test(ev.r.dir || ""));
    case "key_person_exit": return /\b(cfo|ceo|md|managing director|chief (financial|executive)|whole[- ]?time)\b/i.test((ev.p && ev.p.role) || "");
    case "legal": return ev.at === "default" || (s.mcap != null && s.mcap >= 1) || (s.rev != null && s.rev >= 2);
    case "licence": return true;
    default: return false;
  }
}
const cpKey = s => String(s || "").toLowerCase().replace(/\b(limited|ltd|private|pvt|inc|llc|corporation|corp|company|co|the|and|of)\b/g, "").replace(/[^a-z0-9]+/g, "");
const LIFE = new Set(["acquisition", "merger", "demerger", "joint_venture", "strategic_investment", "exit_business", "new_business", "fund_raise", "buyback", "offer_for_sale", "insolvency"]);
const near = (a, b, days) => Math.abs(Date.parse(a) - Date.parse(b)) <= days * 864e5;
const sameAmt = (a, b) => a == null || b == null ? a == null && b == null : Math.abs(a - b) <= Math.max(1, Math.max(a, b) * 0.01);
// add an event to a company's list: one event = one card. The same thing filed twice is marked as a repeat; the next
// step of the same deal / buyback / fund raise joins its first card; several commissionings close together share one card.
export function addEvent(list, ev) {
  if (list.some(x => x.id === ev.id)) return "seen";
  const cp = cpKey(ev.cp);
  const step = (first, how) => { first.steps = (first.steps || []).concat({ d: ev.d, st: ev.st || "", u: ev.u, t: ev.t }).sort((a, b) => a.d < b.d ? -1 : 1).slice(-8);
    if (ev.d >= first.d && ev.st) first.st = ev.st; if (first.amt == null && ev.amt != null) { first.amt = ev.amt; first.q = ev.q; first.size = ev.size; } return how; };
  // the same order / rating / exit / anything filed again within 3 weeks (same amount, same other party)
  const rep = list.find(x => x.k === ev.k && near(x.d, ev.d, ev.k === "order" ? 120 : 21) && sameAmt(x.amt, ev.amt) && (!cp || !cpKey(x.cp) || cpKey(x.cp) === cp)
    && (ev.k !== "rating" || !x.r || !ev.r || cpKey(x.r.a) === cpKey(ev.r.a)) && (ev.k !== "key_person_exit" || cpKey(x.p && x.p.role) === cpKey(ev.p && ev.p.role)));
  if (rep && !LIFE.has(ev.k)) { rep.rep = (rep.rep || []).concat({ d: ev.d, u: ev.u }).slice(-5); return "repeat"; }
  if (LIFE.has(ev.k)) {
    const first = list.find(x => x.k === ev.k && ((cp && cpKey(x.cp) === cp && near(x.d, ev.d, 400)) || (near(x.d, ev.d, 45) && (!cp || !cpKey(x.cp)) && (sameAmt(x.amt, ev.amt) || x.amt == null || ev.amt == null))));
    if (first) return step(first, "step");
  }
  if (ev.k === "capacity") { const first = list.find(x => x.k === "capacity" && near(x.d, ev.d, 45)); if (first) return step(first, "step"); }
  list.push(ev); list.sort((a, b) => a.d < b.d ? 1 : -1); return "new";
}

// ---------- the Claude prompt ----------
export const EV_SYSTEM = `You read ONE stock-exchange filing of an Indian listed company and report the event in it as JSON only (no other text).
Rules: facts only, in plain English. Never give an opinion, a verdict or advice. Never use words like "major", "big", "strong", "huge", "positive", "negative", "boost".
Every number you give must be copied from the filing, and "quote" must be the exact words of the filing (one sentence or phrase) that contain that number. Never calculate an amount yourself.
Set "routine": true for anything an investor would not need to know, for example:
- incorporating a small subsidiary, a clarification, an intimation of a meeting, newspaper copies, an ESOP allotment, a reaffirmed or newly assigned rating;
- borrowing or debt raised by issuing NCDs, bonds or commercial paper (only equity, warrants or convertibles are a fund raise that matters);
- a merger of wholly owned subsidiaries into the company, and procedural steps of any scheme (hearing dates, meeting orders, no-objection letters, filings);
- insolvency process updates (committee of creditors meetings, extensions, lists of creditors, cost approvals) — only the start of insolvency, a resolution plan approved, a liquidation order or the process ending are not routine;
- a CFO / CEO / MD being re-designated or replaced in a planned way with no departure, a company secretary or independent director change;
- routine registrations and certificates (RERA project registration, FSSAI / FDA facility registration, ISO); a licence is not routine only when it lets the company start a new business or product, or when it is a regulator's inspection outcome or warning;
- anything the company itself says has no material impact.`;
export function evPrompt(row, kindHint, pages) {
  return `Company: ${row.sm_name || row.symbol} (NSE: ${row.symbol})
Filing subject: ${row.desc || ""}
Filing date: ${nseDay(row.an_dt || row.sort_date)}
NSE summary: ${String(row.attchmntText || "").slice(0, 600)}
Likely type: ${kindHint}

Filing text (first pages):
"""
${pages.slice(0, 14000)}
"""

Reply with JSON only:
{"kind": "order|capacity|new_business|exit_business|acquisition|merger|demerger|joint_venture|strategic_investment|fund_raise|buyback|rating|auditor_exit|key_person_exit|legal|insolvency|offer_for_sale|licence|other",
 "routine": true|false,
 "title": "what happened, max 14 words, e.g. 'Order of Rs 2,090 crore for a water supply project'",
 "title_no_amount": "the same title without any money amount, e.g. 'Order for a water supply project'",
 "detail": "one more short factual line or empty",
 "amount": {"value": number, "unit": "crore|lakh|million|billion|rupees", "currency": "INR|USD|EUR|GBP|...", "type": "order_value|capex|deal_value|buyback_size|issue_size|tax_demand|penalty|claim|default|relief|other", "quote": "exact words from the filing with this number"} or null,
 "instrument": "equity|warrants|convertible|debt|" (for fund_raise),
 "counterparty": "the other party (client, target company, partner, buyer) or empty",
 "months": number of months to execute / complete, or null,
 "status": "announced|approved|completed|lowest_bidder|letter_of_intent|signed|",
 "rating": {"agency": "", "from": "", "to": "", "dir": "upgrade|downgrade|reaffirmed|new|withdrawn"} or null,
 "person": {"role": "", "reason": ""} or null}
The amount must be the value of the event itself (the order, the deal price, the buyback size, the issue size, the capex, the tax demand or penalty) — never a sales potential, revenue potential, project value estimate, a bank facility that was rated, or a disputed income figure (use null then).
For several orders in one filing give the TOTAL only if the filing states the total; otherwise the largest one.`;
}
export function parseEv(text) { try { const s = String(text || ""); const a = s.indexOf("{"), b = s.lastIndexOf("}"); return a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : null; } catch (e) { return null; } }
const KINDS = new Set(["order", "capacity", "new_business", "exit_business", "acquisition", "merger", "demerger", "joint_venture", "strategic_investment", "fund_raise", "buyback", "rating", "auditor_exit", "key_person_exit", "legal", "insolvency", "offer_for_sale", "licence", "other"]);
const BANNED = /\b(major|big|huge|strong|massive|positive|negative|boost|bullish|bearish|robust|significant)\b/gi;
const clean = (s, n) => String(s || "").replace(BANNED, "").replace(/\s{2,}/g, " ").replace(/\s+([,.])/g, "$1").trim().slice(0, n);
const MONEY = /(rs\.?|inr|₹|usd|us\$|\$|€|eur|£|gbp)\s*[\d,.]+\s*(crores?|cr\.?|lakhs?|lacs?|million|mn|billion|bn)?/i;
// Claude's answer + the filing text → a checked event (or null)
export function buildEvent(row, ans, pagesText, co, fx) {
  const a = ans || {}; const k = KINDS.has(a.kind) ? a.kind : "other";
  const ev = { id: String(row.seq_id || row.attchmntFile || ""), d: nseDay(row.an_dt || row.sort_date), k, t: clean(a.title, 120), x: clean(a.detail, 160), u: String(row.attchmntFile || ""), routine: !!a.routine };
  if (!ev.t || !ev.d) return null;
  const am = a.amount, typeOk = am && (AMOUNT_OK[k] || []).includes(String(am.type || "").toLowerCase());
  if (typeOk && am.quote && quoteOnPage(am.quote, pagesText) && numberInQuote(am.value, am.quote, am.unit)) {
    const cr = toCrore(am.value, am.unit, am.currency, fx);
    if (cr != null && cr < 5e6) { ev.amt = Math.round(cr * 100) / 100; ev.q = String(am.quote).slice(0, 240); ev.at = String(am.type).toLowerCase(); if (String(am.currency || "INR").toUpperCase() !== "INR") ev.cur = String(am.currency).toUpperCase(); }
  }
  if (ev.amt == null && MONEY.test(ev.t)) {                                         // an amount we could not confirm is not shown
    const alt = clean(a.title_no_amount, 120); ev.t = alt && !MONEY.test(alt) ? alt : "";
    if (!ev.t) return null;
  }
  if (MONEY.test(ev.x) && ev.amt == null) ev.x = "";
  if (a.instrument) ev.ins = String(a.instrument).toLowerCase().replace(/[^a-z]/g, "").slice(0, 12);
  if (a.counterparty) ev.cp = clean(a.counterparty, 80);
  if (a.months != null && isFinite(+a.months) && +a.months > 0 && +a.months < 240) ev.m = Math.round(+a.months);
  if (a.status) ev.st = String(a.status).replace(/[^a-z_]/gi, "").slice(0, 20);
  if (a.rating && a.rating.dir) ev.r = { a: clean(a.rating.agency, 40), f: clean(a.rating.from, 30), to: clean(a.rating.to, 30), dir: String(a.rating.dir).toLowerCase().slice(0, 12) };
  if (a.person && a.person.role) ev.p = { role: clean(a.person.role, 60), why: clean(a.person.reason, 120) };
  ev.size = sizeOf(ev, co);
  ev.w = WARN.has(k) || (k === "rating" && ev.r && ev.r.dir === "downgrade") ? 1 : 0;
  return ev;
}

// ---------- the run ----------
export async function runEvents(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, ckey = o.claudeKey ?? process.env.ANTHROPIC_API_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const now = o.now || Date.now(), until = Date.now() + (o.maxMinutes || +process.env.TREX_EVENTS_MINUTES || 40) * 60e3;
  const monthCap = +(o.monthBudgetUsd || process.env.TREX_EVENTS_BUDGET_USD || 40);
  const backDays = o.backDays ?? +(process.env.TREX_EVENTS_BACK_DAYS || 730);
  const dir = o.dir || "events";
  if (!ckey) { log("Events: no ANTHROPIC_API_KEY secret — nothing to do."); return { ok: true, skipped: true }; }
  if (!key) { log("Events: TREX_KEY is not set."); return { ok: false }; }
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  if (!o.skipGit) {
    rmSync(dir, { recursive: true, force: true });
    const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) { log("Events: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return { ok: false }; }
    const remote = `https://x-access-token:${tok}@github.com/${repo}.git`;
    try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", BRANCH, remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { mkdirSync(dir, { recursive: true }); git("init", "--quiet"); git("remote", "add", "origin", remote); git("checkout", "--quiet", "--orphan", BRANCH); log("Events: creating the event-data branch."); }
    git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  } else mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "e"), { recursive: true });
  const ixPath = join(dir, "e", "index.json");
  let ix = { v: EV_VERSION, days: {}, seen: {}, month: "", monthSpent: 0, spent: 0, n: 0 };
  try { if (existsSync(ixPath)) ix = { ...ix, ...JSON.parse(readFileSync(ixPath, "utf8")) }; } catch (e) {}
  if (ix.v !== EV_VERSION) {                               // better rules: read everything again once with them
    for (const f of readdirSync(join(dir, "e"))) if (f !== "index.json") rmSync(join(dir, "e", f), { force: true });
    ix = { ...ix, v: EV_VERSION, days: {}, seen: {}, n: 0, _reset: 1 }; log(`Events: rules version ${EV_VERSION} — starting again from the newest day.`);
  }
  const month = isoDay(now).slice(0, 7); if (ix.month !== month) { ix.month = month; ix.monthSpent = 0; }
  if (ix.monthSpent >= monthCap) { log(`Events: this month's budget of $${monthCap} is used — waiting for next month.`); return { ok: true, capped: true }; }
  const st = {}; const spentNow = () => claudeCost(st);
  let dirty = !!ix._reset; delete ix._reset;
  const saveCo = async (sym, c) => { c.t = Date.now(); writeFileSync(join(dir, "e", sym + ".json"), await sealText(c)); dirty = true; };
  const loadCo = async sym => { try { const x = await openText(readFileSync(join(dir, "e", sym + ".json"), "utf8")); if (x) return x; } catch (e) {} return { symbol: sym, v: EV_VERSION, events: [] }; };
  const publish = async msg => {
    ix.t = Date.now(); writeFileSync(ixPath, JSON.stringify(ix));
    if (o.skipGit || !dirty) return; dirty = false;
    try { git("add", "-A"); git("commit", "--quiet", "-m", msg); git("push", "--quiet", "origin", "HEAD:" + BRANCH); log("Events: saved to GitHub."); }
    catch (e) { log("Events: could not save — " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  };
  // company sizes from the T-Rex database: revenue of the last 4 quarters (₹ Cr) and market value (₹ Cr)
  let sizes = o.sizes || null;
  if (!sizes) {
    sizes = {};
    try {
      const get = qe => F(`${server}/api/db?screen=1&all=1${qe ? "&qe=" + qe : ""}`, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(90000) }).then(r => r.json()).catch(() => null);
      const first = await get(""); const qe0 = first && first.qe;
      if (qe0) {
        const back = m => { let [y, mo] = qe0.split("-").map(Number); mo -= m; while (mo <= 0) { mo += 12; y--; } const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return `${y}-${String(mo).padStart(2, "0")}-${last}`; };
        const sets = [first, await get(back(3)), await get(back(6)), await get(back(9))].map(j => Object.fromEntries(((j && j.rows) || []).map(r => [r.s, r])));
        const syms = new Set(sets.flatMap(s => Object.keys(s)));
        for (const s of syms) {
          const i = sets.findIndex(x => x[s]); if (i < 0) continue; const a = sets[i][s], b = sets[i + 2] && sets[i + 2][s];
          const rev = a && b && [a.sales, a.salesP, b.sales, b.salesP].every(v => v != null) ? a.sales + a.salesP + b.sales + b.salesP : null;
          sizes[s] = { rev: rev != null ? Math.round(rev) : null, mcap: (sets[0][s] || a).mcap ?? null };
        }
      }
    } catch (e) {}
    log(`Events: company sizes known for ${Object.keys(sizes).length} companies.`);
  }
  // exchange rates for orders in other currencies (₹ per unit)
  let fx = o.fx || null;
  if (!fx) { fx = {}; for (const [c, y] of [["USD", "USDINR=X"], ["EUR", "EURINR=X"], ["GBP", "GBPINR=X"]]) {
    try { const j = await F(`https://query1.finance.yahoo.com/v8/finance/chart/${y}?range=5d&interval=1d`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).then(r => r.json()); const p = j.chart.result[0].meta.regularMarketPrice; if (p > 1) fx[c] = p; } catch (e) {} } }
  // NSE with a cookie session; PDFs with curl
  const jar = new Map();
  const keep = r => { const sc = r.headers && r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  const session = async () => { try { const r = await F(REF, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(20000) }); keep(r); await r.arrayBuffer(); } catch (e) {} };
  const nseJson = o.nseJson || (async url => { try { const r = await F(url, { headers: { "User-Agent": UA, "Accept": "*/*", "Referer": REF, ...(jar.size ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(45000) }); keep(r); if (r.status !== 200) return { code: r.status }; return { code: 200, j: JSON.parse(await r.text()) }; } catch (e) { return { code: 0 }; } });
  const pdfGet = o.pdfGet || (url => new Promise(res => {
    const tmp = join(tmpdir(), "trexe-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".pdf");
    execFile("curl", ["-sSL", "--max-time", "60", "-A", UA, "-e", REF, "-H", "Accept: application/pdf,*/*", "-o", tmp, "-w", "%{http_code}", ...(jar.size ? ["-H", "Cookie: " + cookie()] : []), url], { timeout: 70000 }, (e, out) => {
      let body = null; try { body = readFileSync(tmp); unlinkSync(tmp); } catch (x) {} res({ code: e ? 0 : +String(out).trim() || 0, body }); });
  }));
  const pdfText = o.pdfText || pdfTextPoppler;
  if (!o.nseJson) await session();
  // days to do: today and yesterday always (new filings), then older days not done yet, newest first
  const days = [];
  for (let i = 0; i <= backDays; i++) { const d = isoDay(now - i * 864e5); if (i < 2 || !ix.days[d]) days.push(d); }
  let nRead = 0, nKept = 0, nCand = 0, nRows = 0, stop = false, blocked = 0, daysDone = 0;
  const one = async row => {
    if (stop || Date.now() > until - 90e3) return;
    const sym = String(row.symbol || "").toUpperCase(); const id = String(row.seq_id || row.attchmntFile || ""); if (!sym || !id || ix.seen[id]) return;
    const kind = candidate(row); if (!kind) return; nCand++;
    let pages = ""; const url = String(row.attchmntFile || "");
    if (/\.pdf$/i.test(url)) { try { const r = await pdfGet(url); if (r.code === 200 && r.body && r.body.length > 500) pages = (await pdfText(r.body, false)).slice(0, 5).join("\n\n"); } catch (e) {} }
    if (!pages) pages = String(row.attchmntText || "");
    if (pages.length < 40) { ix.seen[id] = 1; return; }
    let ans;
    try { ans = await askClaude(F, ckey, EV_SYSTEM, evPrompt(row, kind, pages), null, st); }
    catch (e) { if (e.fatal || e.config) { stop = true; log("Events: Claude key problem — " + String(e.message).slice(0, 120)); } return; }   // not marked seen: tried again next run
    nRead++; ix.seen[id] = 1;
    const ev = buildEvent(row, parseEv(ans.text), pages, sizes[sym], fx); if (!ev || !material(ev)) return;
    delete ev.routine; const c = await loadCo(sym); c.name = row.sm_name || c.name || sym;
    const how = addEvent(c.events, ev); if (how === "seen") return; c.events = c.events.slice(0, 120); await saveCo(sym, c); nKept++;
    if (ix.monthSpent + spentNow() >= monthCap) { stop = true; log(`Events: this month's budget of $${monthCap} is reached.`); }
  };
  let lastSave = Date.now();
  for (const d of days) {
    if (stop || Date.now() > until - 90e3) break;
    const dd = new Date(d + "T00:00:00Z");
    const r = await nseJson(`https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=${dmy(dd)}&to_date=${dmy(dd)}`);
    if (r.code !== 200) { blocked++; if (blocked >= 4) { log("Events: NSE keeps refusing — stopping for this run."); break; } await sleep(10000 * blocked); await session(); continue; }
    blocked = 0; const rows = Array.isArray(r.j) ? r.j : ((r.j && r.j.data) || []); nRows += rows.length;
    let next = 0; const par = Math.max(1, o.parallel || +process.env.TREX_EVENTS_PARALLEL || 6);
    const worker = async () => { while (next < rows.length && !stop) await one(rows[next++]); };
    await Promise.all(Array.from({ length: par }, worker));
    if (!stop && Date.now() <= until - 90e3 && d !== isoDay(now)) { ix.days[d] = 1; daysDone++; }
    if (Date.now() - lastSave > 8 * 60e3) { ix.monthSpent = +(ix.monthSpent + spentNow()).toFixed(4); ix.spent = +(ix.spent + spentNow()).toFixed(4); st.cost = 0; st.inTok = 0; st.outTok = 0; await publish(`events: ${d}`); lastSave = Date.now(); }
  }
  ix.monthSpent = +(ix.monthSpent + spentNow()).toFixed(4); ix.spent = +(ix.spent + spentNow()).toFixed(4); ix.n = (ix.n || 0) + nKept;
  const left = days.filter(d => !ix.days[d]).length;
  await publish(`events: ${nKept} kept`);
  log(`Events: ${nRows} filings looked at, ${nCand} possible events, ${nRead} read by AI, ${nKept} important ones kept · ${daysDone} days finished, ${left} to go · this month ≈ $${ix.monthSpent.toFixed(2)} of $${monthCap}.`);
  if (!o.skipGit && left > 2 && !stop) { try { writeFileSync(join(tmpdir(), "trex-events-more"), "1"); if (!daysDone) writeFileSync(join(tmpdir(), "trex-events-wait"), "1"); } catch (e) {} }
  return { ok: true, rows: nRows, cand: nCand, read: nRead, kept: nKept, left };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runEvents().then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(0); });
