// T-Rex one-time DEEP READING of every listed company with your Claude API key (Anthropic, paid from the plan's API credit).
// For each company: its latest annual report, investor presentation and earnings-call transcript on NSE are read once —
// what it sells, capacity, customers, markets, market position, guidance, costs. Every number and quote is checked on its
// page exactly like the watchlist reader (insights.mjs). Results are saved as one file per company in the "deep-data"
// branch of this public repository (company documents are public), so they stay even after the key ends, and the app
// shows them in the Business · AI tab. Nothing is written to the Cloudflare database (no daily-limit pressure).
// Run: node collector/deepread.mjs   (needs ANTHROPIC_API_KEY, TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { selectPages, budgetFor, buildPrompt, parseFacts, parseNotes, verifyFacts, verifyNotes, parseExtras, pdfTextPoppler, askClaude, claudeCost, claudeModels, READER_VERSION } from "./insights.mjs";
import { shpPledge, xbrlNum } from "./companyinfo.mjs";
import { evaluatePromises, dueOf, JUDGE_RULES } from "./promises.mjs";
import { tidyCompany, TIDY_VERSION } from "./tidy.mjs";
import { sealText, openText, sealOn, sealTree } from "./seal.mjs";
export const DEEP_VERSION = 2;                 // v2: + management commitments, analyst concerns, competitors, product tags, red flags, holding, insider trades

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dmy = d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
export const BRANCH = "deep-data";

// which documents of a company to read: the latest transcript, the latest presentation, the latest annual report
export function pickDocs(sym, ann, ars, nTr = 1) {
  const txt = r => `${r.desc || ""} ${r.attchmntText || ""} ${r.attchmntFile || ""}`;
  const pdf = r => /\.pdf$/i.test(String(r.attchmntFile || ""));
  const mk = type => r => ({ symbol: sym, name: r.sm_name || sym, doc: r.attchmntFile, type, date: String(r.an_dt || r.sort_date || "").slice(0, 11) });
  const out = [
    ...ann.filter(r => pdf(r) && /transcript/i.test(txt(r)) && !/investor presentation/i.test(String(r.desc || ""))).filter((r, i, arr) => arr.findIndex(x => x.attchmntFile === r.attchmntFile) === i).slice(0, nTr).map(mk("Earnings call transcript")),
    ...ann.filter(r => pdf(r) && /investor presentation/i.test(String(r.desc || ""))).slice(0, 1).map(mk("Investor presentation")),
    ...ars.filter(r => /\.pdf$/i.test(String(r.fileName || ""))).slice(0, 1).map(r => ({ symbol: sym, name: r.companyName || sym, doc: r.fileName, type: `Annual report ${r.fromYr || ""}-${r.toYr || ""}`, date: String(r.broadcast_dttm || "").slice(0, 11) })),
  ];
  return out.filter(d => d.doc);
}

// SECOND READING (midcaps and smallcaps, Nov 2026): more of each company's own documents, only those from 2025 on — up to 4
// earnings-call transcripts, 2 investor presentations and the annual reports for 2024-25 and 2025-26. Documents already
// read are never read again (only the new ones cost anything).
export const DEEP2_SINCE = "2025-01-01";
const annDay = r => { const t = Date.parse(String(r.an_dt || r.sort_date || "").slice(0, 11).replace(/-/g, " ") + " UTC"); return isNaN(t) ? 0 : t; };
export function pickDocs2(sym, ann, ars, since = DEEP2_SINCE) {
  const t0 = Date.parse(since + "T00:00:00Z");
  const txt = r => `${r.desc || ""} ${r.attchmntText || ""} ${r.attchmntFile || ""}`, pdf = r => /\.pdf$/i.test(String(r.attchmntFile || ""));
  const mk = type => r => ({ symbol: sym, name: r.sm_name || sym, doc: r.attchmntFile, type, date: String(r.an_dt || r.sort_date || "").slice(0, 11) });
  const recent = ann.filter(r => pdf(r) && annDay(r) >= t0), uniq = (r, i, arr) => arr.findIndex(x => x.attchmntFile === r.attchmntFile) === i;
  const out = [
    ...recent.filter(r => /transcript/i.test(txt(r)) && !/investor presentation/i.test(String(r.desc || ""))).filter(uniq).slice(0, 4).map(mk("Earnings call transcript")),
    ...recent.filter(r => /investor presentation/i.test(String(r.desc || ""))).filter(uniq).slice(0, 2).map(mk("Investor presentation")),
    ...ars.filter(r => /\.pdf$/i.test(String(r.fileName || "")) && +r.toYr >= 2025).filter((r, i, arr) => arr.findIndex(x => x.fileName === r.fileName) === i).slice(0, 2)
      .map(r => ({ symbol: sym, name: r.companyName || sym, doc: r.fileName, type: `Annual report ${r.fromYr || ""}-${r.toYr || ""}`, date: String(r.broadcast_dttm || "").slice(0, 11) })),
  ];
  return out.filter(d => d.doc);
}

// red flags and notable events from the company's own NSE announcements (no AI: the announcement subject decides)
// v2 (10 Nov 2026): routine filings were being shown as red flags — a merger scheme sanctioned by the NCLT, a quarterly
// results filing ("year ended … attached" matched an Enforcement-Directorate rule), merger hearings and creditors'
// meetings, and the head of INTERNAL audit leaving (shown as "Auditor resigned"). Those are no longer flags.
export const FLAG_VERSION = 2;
const ROUTINE = /scheme of (amalgamation|arrangement)|amalgamation|demerger|\bmerger\b|first motion|second motion|meetings? of (the )?(equity )?(shareholders|creditors|unsecured creditors|secured creditors)|newspaper (publication|advertisement)|financial results|integrated filing|outcome of (the )?board meeting|trading window|investor (meet|presentation)|analyst/i;
const FLAG_RULES = [
  ["red", "Auditor resigned", /\b(statutory|secretarial|cost|joint statutory)?\s*auditors?\b/i, /resign|cessation|withdraw/i, /internal audit|head of (internal )?audit|audit committee/i],
  ["red", "Key person resigned", /\b(cfo|chief financial|ceo|chief executive|managing director|whole[- ]?time director|company secretary|compliance officer|key managerial|kmp)\b/i, /resign|cessation/i, null],
  ["red", "Rating downgrade / negative watch", /rating/i, /downgrad|negative (outlook|watch)|watch with negative|withdraw|suspend|default/i, null],
  ["red", "Default / delay in payment", /default|delay in (payment|servicing)|non[- ]payment|overdue/i, null, ROUTINE],
  ["red", "Regulatory / legal action", /penalt|show cause|tax demand|demand notice|search (and|&) seizure|\braid\b|fraud|insolvency|\bcirp\b|forensic|adjudication|sebi order|enforcement directorate/i, null, ROUTINE],
  ["amber", "Promoter pledge / encumbrance", /pledge|encumbr/i, null, null],
  ["amber", "Director resigned", /director/i, /resign|cessation/i, null],
  ["green", "Rating upgrade", /rating/i, /upgrad|positive outlook/i, null],
  ["green", "Buyback / bonus / split", /buy ?back|bonus|split|sub-division/i, null, null],
  ["green", "Order / contract won", /order|contract|letter of award|\bloa\b|work order/i, /receiv|win|won|bag|secur|award/i, null],
  ["green", "Capacity / plant commissioned", /commission|commercial production|capacity expansion|new plant/i, null, null],
  ["info", "Acquisition / merger / fund raise", /acquisi|amalgamat|merger|scheme of arrangement|preferential|\bqip\b|rights issue|fund raising/i, null, null],
];
// the rules before 10 Nov 2026 — only to recognise flags that were raised by mistake (see recheckFlags)
const OLD_RULES = [["Auditor resigned", /auditor/i, /resign|cessation|withdraw/i], ["Default / delay in payment", /default|delay in (payment|servicing)|non[- ]payment|overdue/i, null],
  ["Regulatory / legal action", /penalt|show cause|tax demand|demand notice|search (and|&) seizure|\braid\b|fraud|insolvency|\bnclt\b|\bcirp\b|forensic|adjudication|sebi order|ed\b.*attach/i, null]];
export function flagOf(txt) {
  for (const [lvl, label, a, b, not] of FLAG_RULES) { if (!a.test(txt) || (b && !b.test(txt)) || (not && not.test(txt))) continue; return { lvl, label }; }
  return null;
}
export function deepSignals(ann) {
  const flags = [], seen = new Set();
  for (const r of ann || []) {
    const txt = `${r.desc || ""} ${r.attchmntText || ""}`.replace(/\s+/g, " ").trim(); if (!txt) continue;
    const f = flagOf(txt); if (!f) continue;
    const k = f.label + "|" + String(r.an_dt || r.sort_date || "").slice(0, 11); if (seen.has(k)) continue; seen.add(k);
    flags.push({ lvl: f.lvl, label: f.label, date: String(r.an_dt || r.sort_date || "").slice(0, 11), text: txt.slice(0, 220), url: r.attchmntFile || "" });
  }
  return flags.slice(0, 40);
}
// saved flags, checked again with the new rules from their saved text (no NSE call, no AI). A flag the old rules raised on
// that same text and the new rules do not is dropped; a flag whose reason lies beyond the saved text is kept as it was.
export function recheckFlags(flags) {
  const out = [];
  for (const f of flags || []) {
    if (f.lvl !== "red") { out.push(f); continue; }
    const n = flagOf(f.text || "");
    if (n) { out.push({ ...f, lvl: n.lvl, label: n.label }); continue; }
    const old = OLD_RULES.find(([label, a, b]) => label === f.label && a.test(f.text || "") && (!b || b.test(f.text || "")));
    if (!old && f.label !== "Auditor resigned") out.push(f);          // the old reason is not in the saved text: keep
  }
  return out;
}

// FACT FINDER summary of one company (Nov 2026): the few facts the fact-finder screen filters on, each with the document
// and page it comes from (the app opens the company file for the exact sentence). Only documents dated from 2025.
export const SC_VERSION = 3;
// v2 (11 Nov 2026): tax demands, GST orders, penalties and show-cause notices are routine for many companies — they are kept
// apart as "tax / regulatory notices" (with the NSE subject); only an auditor leaving, a rating cut, a default, or fraud /
// insolvency / raids / forensic audit / SEBI or ED orders count as serious flags.
const GRAVE = /fraud|insolvency|\bcirp\b|forensic|search (and|&) seizure|\braid\b|enforcement directorate|sebi order|\bwilful\b/i;
const flSubj = t => String(t || "").replace(/\s+/g, " ").trim().slice(0, 120);
// v3 (11 Nov 2026), from the live list: a rating withdrawn or affirmed is not a downgrade; a fine, a tax / GST demand or a stay
// order is a notice; a bank reporting a borrower's or an employee's fraud is a routine bank disclosure; buying a company out of
// insolvency, forfeiting unpaid shares, or a results / board-meeting filing is no flag at all
const SC_DROP = /outcome of (the )?board meeting|financial results|integrated filing|trading window|forfeit|acquisition of|\bacquir|resolution applicant|resolution plan (has been |was )?approved|successful resolution/i;
const SC_RATING = /downgrad|negative (outlook|watch|implication)|watch with negative|\bdefault\b|suspend|not cooperating|non[- ]cooperat/i;
const SC_NOTICE = /demand notice|tax demand|show cause|penalt|payment of fines|fines?\s*\/\s*penalt|stay order|\bgst\b/i;
export function flKind(f, name) {                                       // "S" serious, "N" notice, "" not a flag
  const t = String(f.text || "");
  if (SC_DROP.test(t)) return "";
  if (/^Rating/.test(f.label)) return SC_RATING.test(t) ? "S" : "";
  if (/^Auditor/.test(f.label)) return "S";
  if (/^Default/.test(f.label)) return SC_NOTICE.test(t) || (/\bbank\b/i.test(String(name || "")) && /fraud/i.test(t)) ? "N" : "S";
  if (/^Regulatory/.test(f.label)) return GRAVE.test(t) && !(/\bbank\b/i.test(String(name || "")) && /fraud/i.test(t) && !/forensic/i.test(t)) ? "S" : "N";
  return "";
}
const SINCE25 = Date.UTC(2025, 0, 1);
const dayOf = s => { const t = Date.parse(String(s || "").slice(0, 11).replace(/-/g, " ") + " UTC"); return isNaN(t) ? 0 : t; };
export function toCr(v, u) {
  const x = +v, t = String(u || "").toLowerCase(); if (!isFinite(x) || x <= 0) return null;
  if (/usd|us\$|\$|eur|€|gbp|£/.test(t)) return null;                       // foreign currency: not converted
  if (/crore|\bcr\b|\bcrs?\b|cr\.?$/.test(t)) return x; if (/lakh|\blac/.test(t)) return x / 100;
  if (/billion|\bbn\b/.test(t)) return x * 100; if (/million|\bmn\b/.test(t)) return x / 10; return null;
}
const OB_TOTAL = /^(the )?(total |consolidated |overall |current |outstanding |unexecuted |net |closing |company'?s )?(order ?book|orders? (in hand|on hand)|(order )?backlog|unexecuted orders?)( (stands|position|size|value|level))?$/i;
const OB_NOT = /\bnew\b|inflow|booked|received|added|\bl1\b|\bbid|pipeline|enquir|prospect|potential|expected|once|target|guidance|aspir|segment|division|domestic|export|international/i;
export function screenOf(co, rank, now = Date.now()) {
  const docs = Object.fromEntries((co.docs || []).map(d => [d.doc, d])), dd = f => dayOf((docs[f.doc] || {}).date);
  const facts = (co.facts || []).filter(f => dd(f) >= SINCE25);
  const newest = list => { const m = Math.max(0, ...list.map(dd)); return list.filter(f => dd(f) === m); };
  const ref = f => ({ doc: f.doc, pg: f.page, dt: (docs[f.doc] || {}).date || "", as: String(f.period || "").slice(0, 40) });
  // order book: a company-wide figure from its newest document (never a division, a bid or a pipeline)
  const obs = facts.filter(f => f.metric === "order_book" && OB_TOTAL.test(String(f.item || "").trim()) && !OB_NOT.test(`${f.item} ${f.period}`) && toCr(f.value, f.unit));
  const ob1 = newest(obs).sort((a, b) => toCr(b.value, b.unit) - toCr(a.value, a.unit))[0];
  const pct = f => /%|per ?cent/i.test(String(f.unit || "")) && +f.value > 0 && +f.value <= 100;
  const ex1 = newest(facts.filter(f => f.metric === "export_share" && pct(f) && !/segment|division/i.test(f.item))).sort((a, b) => b.value - a.value)[0];
  const cc1 = newest(facts.filter(f => f.metric === "customer_share" && pct(f) && /\btop\b|largest|single|one customer|biggest/i.test(f.item))).sort((a, b) => b.value - a.value)[0];
  // new capacity / projects the company said would be ready in the next 12 months
  const cap = (co.commitments || []).filter(c => /capacity|commissioning/.test(c.kind) && dayOf(c.date) >= SINCE25)
    .map(c => ({ c, due: dueOf(c.by) })).filter(x => x.due && x.due > now - 30 * 864e5 && x.due <= now + 366 * 864e5)
    .sort((a, b) => a.due - b.due).filter((x, i, arr) => arr.findIndex(y => String(y.c.what).toLowerCase() === String(x.c.what).toLowerCase()) === i).slice(0, 3)
    .map(x => ({ w: String(x.c.what || "").slice(0, 90), due: x.due, by: String(x.c.by || "").slice(0, 30), doc: x.c.doc, pg: x.c.page, dt: x.c.date || "" }));
  const cm = co.commitments || [], vc = v => cm.filter(c => c.verdict && c.verdict.s === v).length;
  const ins = co.insider && co.insider.promoters; const h = (co.holding || []).slice().sort((a, b) => dayOf(b.d) - dayOf(a.d));
  const h0 = h[0], h1 = h0 ? h.find(x => dayOf(x.d) <= dayOf(h0.d) - 330 * 864e5) : null;
  const yr = (co.flags || []).filter(f => f.lvl === "red" && dayOf(f.date) > now - 366 * 864e5);
  const fl = yr.filter(f => flKind(f, co.name) === "S").slice(0, 4).map(f => ({ l: f.label, d: f.date, u: f.url || "", t: flSubj(f.text) }));
  const nt = yr.filter(f => flKind(f, co.name) === "N").slice(0, 4).map(f => ({ d: f.date, u: f.url || "", t: flSubj(f.text) }));
  return { r: rank || null, n: String(co.name || co.symbol || "").slice(0, 70), tg: (co.tags || []).slice(0, 3),
    ob: ob1 ? { v: Math.round(toCr(ob1.value, ob1.unit)), ...ref(ob1) } : null,
    ex: ex1 ? { v: +ex1.value, ...ref(ex1) } : null, cc: cc1 ? { v: +cc1.value, i: String(cc1.item || "").slice(0, 60), ...ref(cc1) } : null,
    cap, pd: [vc("delivered"), vc("partly"), vc("missed"), cm.filter(c => !c.verdict || c.verdict.s === "unclear").length],
    pb: ins ? Math.round(((ins.buy || 0) - (ins.sell || 0)) / 1e5) / 100 : null,                   // ₹ crore, promoters' net buying in the market (12 months)
    hp: h0 ? [h0.p, h1 ? h1.p : null] : null, fl, nt, nd: (co.docs || []).filter(d => d.status === 1).length, nf: (co.facts || []).length };
}

export async function runDeep(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, ckey = o.claudeKey ?? process.env.ANTHROPIC_API_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const t0 = Date.now(), until = t0 + (o.maxMinutes || +process.env.TREX_DEEP_MINUTES || 40) * 60e3;
  const cap = +(o.budgetUsd || process.env.TREX_CLAUDE_BUDGET_USD || 150);            // never spend more than this in total
  const dir = o.dir || "deep", maxDocs = o.maxDocs || 400;
  if (!ckey) { log("Deep reading: no ANTHROPIC_API_KEY secret — nothing to do."); return { ok: true, skipped: true }; }
  if (!key) { log("Deep reading: TREX_KEY is not set."); return { ok: false }; }
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  // 1) the files saved so far (or a new, empty branch)
  if (!o.skipGit) {
    rmSync(dir, { recursive: true, force: true });
    const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) { log("Deep reading: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return { ok: false }; }
    const remote = `https://x-access-token:${tok}@github.com/${repo}.git`;
    try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", BRANCH, remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { mkdirSync(dir, { recursive: true }); git("init", "--quiet"); git("remote", "add", "origin", remote); git("checkout", "--quiet", "--orphan", BRANCH); log("Deep reading: creating the deep-data branch."); }
    git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  } else mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "d"), { recursive: true });
  const ixPath = join(dir, "d", "index.json");
  let ix = { v: 1, companies: {}, docs: {}, spent: 0, inTok: 0, outTok: 0 }; try { if (existsSync(ixPath)) { const o = await openText(readFileSync(ixPath, "utf8")); if (o) ix = { ...ix, ...o }; } } catch (e) {}
  if (!(ix.v >= 2)) { for (const [k, v] of Object.entries(ix.docs || {})) if (v.s === 0) delete ix.docs[k]; ix.v = 2; }
  if (ix.spent >= cap) { log(`Deep reading: the budget of $${cap} is used ($${ix.spent.toFixed(2)}) — stopping.`); return { ok: true, done: true }; }
  if (ix.keyDead && Date.now() - ix.keyDead < 12 * 3600e3) { log("Deep reading: the Claude key stopped working recently — trying again later."); return { ok: true }; }
  let dirty = false;
  const rankMap = new Map();                                        // company size rank (1 = largest), for the fact finder
  const saveCo = async (sym, co) => { writeFileSync(join(dir, "d", sym + ".json"), await sealText(co)); dirty = true;   // sealed when DATA_KEY is set
    const c = ix.companies[sym]; if (c) { try { c.sc = screenOf(co, rankMap.get(sym)); c.scv = SC_VERSION; c.fv = FLAG_VERSION; } catch (e) {} } };
  const loadCo = async sym => { try { const o = await openText(readFileSync(join(dir, "d", sym + ".json"), "utf8")); if (o) return o; } catch (e) {} return { symbol: sym, docs: [], facts: [] }; };
  if (sealOn()) { try { const n = await sealTree(join(dir, "d")); if (n) { dirty = true; log(`Deep reading: ${n} older files sealed (encrypted).`); } } catch (e) {} }
  const publish = async (msg) => {
    writeFileSync(ixPath, await sealText(ix));
    // small index for the app's peer comparison: company name, product tags, competitors named in its documents
    const pe = {}; for (const [k, v] of Object.entries(ix.companies || {})) if (v && (v.tg || v.n)) pe[k] = [v.n || "", v.tg || [], v.cp || []];
    writeFileSync(join(dir, "d", "peers.json"), await sealText(pe));
    // fact finder: one small summary per company ranked 1–1000 by market value (the app filters and sorts these)
    const sc = {}; for (const [k, v] of Object.entries(ix.companies || {})) if (v && v.sc && v.sc.r && v.sc.r <= 1000) sc[k] = v.sc;
    writeFileSync(join(dir, "d", "screen.json"), await sealText({ v: SC_VERSION, t: Date.now(), rows: sc }));
    if (o.skipGit || !dirty) return; dirty = false;
    try { git("add", "-A"); git("commit", "--quiet", "-m", msg); git("push", "--quiet", "origin", "HEAD:" + BRANCH); log("Deep reading: saved to GitHub (" + msg + ")."); }
    catch (e) { log("Deep reading: could not save to GitHub: " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  };
  // 2) companies, big ones first
  const tg = await F(`${server}/api/collect?action=deeptargets`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!tg || !tg.ok) { log("Deep reading: T-Rex problem: " + (tg && tg.error)); return { ok: false }; }
  // ranks by market value + one pass over the saved companies: red flags checked again with the new rules, fact-finder
  // summaries built (no NSE call, no AI — only the saved files)
  { const rk = await F(`${server}/api/collect?action=deeptargets2&from=1&to=5000`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()).catch(() => null);
    if (rk && rk.ok && Array.isArray(rk.symbols)) rk.symbols.forEach((x, i) => rankMap.set(x, i + 1));
    let nf = 0, ns = 0;
    for (const [sym, c] of Object.entries(ix.companies)) {
      if (!c || !c.t) continue;
      const needF = c.fv !== FLAG_VERSION, needS = c.scv !== SC_VERSION || (rankMap.size && (!c.sc || c.sc.r !== (rankMap.get(sym) || null)));
      if (!needF && !needS) continue;
      if (!needF && c.sc && c.scv === SC_VERSION) { c.sc.r = rankMap.get(sym) || null; ns++; continue; }         // only the rank moved (a new summary version is always rebuilt)
      const co = await loadCo(sym); if (!co || !co.docs) continue;
      if (needF) { const before = JSON.stringify(co.flags || []); co.flags = recheckFlags(co.flags || []); if (JSON.stringify(co.flags) !== before) { writeFileSync(join(dir, "d", sym + ".json"), await sealText(co)); dirty = true; nf++; }
        c.flags = (co.flags || []).filter(f => f.lvl === "red").length; c.fv = FLAG_VERSION; }
      try { c.sc = screenOf(co, rankMap.get(sym)); c.scv = SC_VERSION; ns++; } catch (e) {}
    }
    if (ns) dirty = true;
    if (nf || ns) log(`Deep reading: red flags re-checked (${nf} companies corrected), fact-finder summaries for ${ns} companies.`); }
  // NSE with a cookie session (like a browser); PDFs with curl (steadiest with NSE's archive)
  const jar = new Map();
  const keep = r => { const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  const session = async () => { try { const r = await F(REF, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(20000) }); keep(r); await r.arrayBuffer(); } catch (e) {} };
  const nseJson = async url => { try { const r = await F(url, { headers: { "User-Agent": UA, "Accept": "*/*", "Referer": REF, ...(jar.size ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(40000) }); keep(r); if (r.status !== 200) return { code: r.status }; return { code: 200, j: JSON.parse(await r.text()) }; } catch (e) { return { code: 0 }; } };
  // PDFs: curl first (like the main collector, with the same headers), then Node's own https on a fresh connection
  const curlGet = url => new Promise(res => {
    const tmp = join(tmpdir(), "trexd-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".pdf");
    execFile("curl", ["-sSL", "--max-time", "90", "-A", UA, "-e", REF, "-H", "Accept: application/pdf,*/*", "-o", tmp, "-w", "%{http_code}", ...(jar.size ? ["-H", "Cookie: " + cookie()] : []), url], { timeout: 100000 }, (e, out, err) => {
      let body = null; try { body = readFileSync(tmp); unlinkSync(tmp); } catch (x) {}
      res({ code: e ? 0 : +String(out).trim() || 0, body, why: e ? String(err || e.message || "curl failed").trim().slice(0, 80) : "" });
    });
  });
  const httpsGet = async (url, ms = 120000, hops = 0) => { const https = await import("node:https"); return new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; clearTimeout(tm); res(v); } };
    const req = https.get(url, { agent: false, headers: { "User-Agent": UA, "Accept": "application/pdf,*/*", "Accept-Encoding": "identity", "Referer": REF, "Connection": "close", ...(jar.size ? { Cookie: cookie() } : {}) } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) { r.resume(); done = true; clearTimeout(tm); res(httpsGet(new URL(r.headers.location, url).href, ms, hops + 1)); return; }
      const parts = []; r.on("data", c => parts.push(c)); r.on("end", () => fin({ code: r.statusCode, body: Buffer.concat(parts) })); r.on("error", e => fin({ code: 0, body: null, why: e.code || e.message }));
    });
    const tm = setTimeout(() => { req.destroy(); fin({ code: 0, body: null, why: "timed out" }); }, ms);
    req.on("error", e => fin({ code: 0, body: null, why: e.code || e.message }));
  }); };
  const good = r => r.code === 200 && r.body && r.body.length >= 1000;
  const pdfGet = o.pdfGet || (async url => {
    let r = await curlGet(url); if (good(r)) return r;
    const first = r.why || "HTTP " + r.code; await session();
    r = await httpsGet(url); if (!good(r)) r.why = `${first}; then ${r.why || "HTTP " + r.code}`; return r;
  });
  const pdfText = o.pdfText || pdfTextPoppler;
  await session();
  const st = { inTok: 0, outTok: 0 }, spent0 = ix.spent || 0; let docs = 0, facts = 0, cos = 0, blocked = 0, sinceSave = 0, busyRun = 0, stopRun = false, lastPub = Date.now();
  const to = new Date(), from = new Date(Date.now() - 400 * 864e5), from2 = new Date(Date.now() - 800 * 864e5);
  let dn = 0; const dlog = (id, m) => log(`  doc ${id}: ${m}`);                 // (public log: no company names)
  let gateT = 0; const gate = async () => { const w = Math.max(0, gateT - Date.now()); gateT = Math.max(Date.now(), gateT) + (o.nseGap ?? 450); if (w) await sleep(w); };   // NSE: one request at a time, spaced
  const nseG = async url => { await gate(); return nseJson(url); };
  const deepTr = o.deepTranscripts || 4, deepN = o.deepCount || 300;      // big companies + your watchlist: 4 transcripts (for promises vs delivery), others: 2
  const order = new Map(tg.symbols.map((x, i) => [x, i]));
  async function readDoc(sym, co, d, mult) {
    const id = ++dn;
    const mark = (s, note, extra = {}) => { const tries = ((ix.docs[d.doc] || {}).n || 0) + (s === 0 && !extra.transient ? 1 : 0); ix.docs[d.doc] = { s: s === 0 && tries >= 3 ? 2 : s, n: tries, v: DEEP_VERSION };
      co.docs = co.docs.filter(x => x.doc !== d.doc); co.docs.push({ doc: d.doc, symbol: sym, type: d.type, date: d.date, status: ix.docs[d.doc].s, model: extra.model || "", n: extra.n || 0, note, t: Date.now(), source: "deep" }); };
    const tD = Date.now(); const r = await pdfGet(d.doc); const dlS = Math.round((Date.now() - tD) / 1000);
    if (r.code !== 200 || !r.body || r.body.length < 1000) { mark(0, `could not download (${r.why || "HTTP " + r.code})`); dlog(id, `could not download after ${dlS}s (${r.why || "HTTP " + r.code})`); return; }
    if (r.body.length > 40 * 1024 * 1024) { mark(2, "file too large"); return; }
    let pages = []; try { pages = await pdfText(r.body); } catch (e) { mark(0, "PDF damaged or incomplete"); return; }
    if (pages.join("").replace(/\s/g, "").length < 120) { mark(2, "no text in PDF (scanned images)"); return; }
    if (!/presentation|annual report/i.test(d.type) && pages.filter(p => p.trim().length > 200).length <= 2 && pages.join("").length < 5000) { mark(1, "covering letter only — the document itself is on the company's website"); return; }
    let pagesRaw = null; if (pdfText === pdfTextPoppler) { try { pagesRaw = await pdfTextPoppler(r.body, false); } catch (e) {} }
    const sel = selectPages(pages, Math.round(budgetFor(d.type) * (mult || 1.5)));     // second reading: more pages per document if (!sel.length) { mark(1, "no business pages found"); return; }
    const { system, prompt } = buildPrompt(d.name, sym, d.type, d.date, sel, { ext: true });
    let ans; const tA = Date.now();
    try { ans = await askClaude(F, ckey, system, prompt, m => dlog(id, m.trim()), st); }
    catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); stopRun = true; log("Deep reading: " + e.message + (st.modelList ? ` [models this key can use: ${st.modelList.slice(0, 12).join(", ") || "none listed"}]` : "") + " — stopping (the normal readers carry on with the free AIs)."); return; }
      if (e.busy) { mark(0, String(e.message || e).slice(0, 150), { transient: true }); dlog(id, String(e.message || e).slice(0, 120)); if (++busyRun >= 3) { log("Deep reading: Claude keeps saying busy / rate limit — stopping this run."); stopRun = true; } return; }
      mark(0, String(e.message || e).slice(0, 150)); return; }
    const raw = parseFacts(ans.text); if (!raw) { const t = String(ans.text || ""); mark(0, `${ans.model}: answer was not readable`); dlog(id, `${ans.model}: answer was not readable (${t.length} chars; starts "${t.slice(0, 60).replace(/\s+/g, " ")}" … ends "${t.slice(-60).replace(/\s+/g, " ")}")`); return; }
    const fv = verifyFacts(raw, pages), rawNotes = parseNotes(ans.text), nv = verifyNotes(rawNotes, [pagesRaw, pages]);
    const ex = parseExtras(ans.text, [pagesRaw, pages]);
    co.facts = co.facts.filter(x => x.doc !== d.doc).concat([...fv, ...nv].map(x => ({ symbol: sym, doc: d.doc, ...x })));
    co.commitments = (co.commitments || []).filter(x => x.doc !== d.doc).concat(ex.commitments.map(c => ({ doc: d.doc, date: d.date, type: d.type, ...c })));
    co.concerns = (co.concerns || []).filter(x => x.doc !== d.doc).concat(ex.concerns.map(c => ({ doc: d.doc, date: d.date, ...c })));
    co.competitors = [...new Set([...(co.competitors || []), ...ex.competitors])].slice(0, 15);
    const tg2 = { ...(co.tagN || {}) }; for (const t of ex.tags) tg2[t] = (tg2[t] || 0) + 1; co.tagN = tg2; co.tags = Object.entries(tg2).sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 8);
    mark(1, `${raw.length} numbers found by AI, ${fv.length} confirmed on the page; ${nv.length} of ${rawNotes.length} quotes confirmed; ${ex.commitments.length} commitments`, { model: ans.model, n: fv.length + nv.length });
    docs++; facts += fv.length + nv.length; busyRun = 0;
    dlog(id, `download ${dlS}s, AI ${Math.round((Date.now() - tA) / 1000)}s — ${fv.length + nv.length} checked facts, ${ex.commitments.length} commitments, ${ex.concerns.length} concerns [${ans.model}]`);
  }
  async function companyExtras(sym, co) {             // promoter holding + pledge (shareholding pattern) and insider trades — refreshed monthly
    if (co.hx && Date.now() - co.hx < 30 * 864e5) return;
    try {
      const sh = await nseG(`https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(sym)}`);
      const list0 = sh.j ? (Array.isArray(sh.j) ? sh.j : (sh.j.data || [])) : []; const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
      const dtp = x => { const d = Date.parse(String(x || "").replace(/-/g, " ")); return isNaN(d) ? 0 : d; };
      const list = list0.filter(r => r && r.date && num(r.pr_and_prgrp) != null).sort((a, b) => dtp(b.date) - dtp(a.date)); const seen = new Set();
      if (list.length) co.holding = list.filter(r => !seen.has(r.date) && seen.add(r.date)).slice(0, 8).map(r => ({ d: r.date, p: num(r.pr_and_prgrp), pub: num(r.public_val) }));
      if (list[0] && list[0].xbrl && !o.skipShp) { await gate(); const x = await pdfGet(list[0].xbrl); if (x.code === 200 && x.body) { const xml = x.body.toString("utf8"); co.pledge = { ...shpPledge(xml), totalShares: xbrlNum(xml, "NumberOfShares"), d: list[0].date }; } }
    } catch (e) {}
    try {
      const pit = await nseG(`https://www.nseindia.com/api/corporates-pit?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(from)}&to_date=${dmy(to)}`);
      const rows = pit.j ? (Array.isArray(pit.j) ? pit.j : (pit.j.data || [])) : [];
      if (pit.code === 200) {
        const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
        const tr = rows.map(r => ({ d: String(r.acqfromDt || r.date || r.intimDt || "").slice(0, 11), who: String(r.acqName || "").slice(0, 60), cat: String(r.personCategory || "").slice(0, 40), type: String(r.tdpTransactionType || r.acqMode || "").slice(0, 30), qty: num(r.secAcq), val: num(r.secVal) }));
        const sum = re => { let b = 0, s2 = 0; for (const t of tr) if (re.test(t.cat)) { if (/buy|acqui/i.test(t.type)) b += t.val; else if (/sell|dispos/i.test(t.type)) s2 += t.val; } return { buy: Math.round(b), sell: Math.round(s2) }; };
        co.insider = { t: Date.now(), promoters: sum(/promoter/i), directors: sum(/director|kmp|key managerial|designated/i), rows: tr.slice(0, 30) };
      }
    } catch (e) {}
    co.hx = Date.now();
  }
  // promises vs delivery: judge the commitments whose date has passed, from later documents + the filings
  const ripeCount = co => (co.commitments || []).filter(c => { const d = dueOf(c.by); return d && d < Date.now() - 20 * 864e5 && (!c.verdict || (c.verdict.s !== "unclear" && (c.verdict.r || 0) < JUDGE_RULES) || (c.verdict.s === "unclear" && Date.now() - (c.verdict.t || 0) > 90 * 864e5)); }).length;
  async function judgeCo(sym, co) {
    if (!stopRun && ripeCount(co) && !o.skipPromises) {
      try {
        let quarters = [];
        const j = await F(`${server}/api/db?symbol=${encodeURIComponent(sym)}`, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => null);
        if (j && j.ok) { const qs = j.quarters || []; const basis = qs.some(q => q.basis === "C") ? "C" : "S"; const mine = qs.filter(q => q.basis === basis);
          const by = Object.fromEntries(mine.map(q => [q.qe, q])); const ly = qe => { const [y, m] = qe.split("-"); return `${+y - 1}-${m}-${qe.slice(8)}`; };
          const g = (a, b) => a != null && b ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : null;
          quarters = mine.map(q => { const p = by[ly(q.qe)] || mine.find(x => x.qe.slice(0, 7) === ly(q.qe).slice(0, 7)); return { qe: q.qe, basis, sales: q.sales, opm: q.opm, np: q.np, pdf: q.pdf || null, xbrl: q.xbrl || null, yoySales: p ? g(q.sales, p.sales) : null, yoyNp: p ? g(q.np, p.np) : null }; }); }
        const nj = await evaluatePromises(sym, co, { quarters, ask: (sys, pr) => askClaude(F, ckey, sys, pr, null, st) });
        if (nj) co.judged = (co.judged || 0) + nj;
      } catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); stopRun = true; } }
    }
    co.jt = Date.now();
  }
  // tidy-up: one standard name + group per number name (so the app lines numbers up by quarter); your watchlist also gets
  // the numbers read by the 2-hourly watchlist reader (T-Rex database) tidied, re-checked twice a day
  const watchSet = new Set(tg.symbols.slice(0, tg.watch || 0));
  async function tidyCo(sym, co) {
    if (stopRun || o.skipTidy) return;
    let extra = [];
    if (watchSet.has(sym)) { const j = await F(`${server}/api/db?insights=${encodeURIComponent(sym)}`, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => null); if (j && j.ok) extra = j.facts || []; }
    try { const n = await tidyCompany(sym, co, extra, (sys, pr) => askClaude(F, ckey, sys, pr, null, st)); co.tdt = Date.now(); co.tv = TIDY_VERSION; return n; }
    catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); stopRun = true; } return 0; }
  }
  async function processCo(sym) {
    const c = ix.companies[sym]; if (c && c.t && c.v >= DEEP_VERSION && Date.now() - c.t < 120 * 864e5) return;          // read in the last 4 months
    const nTr = (order.get(sym) ?? 9999) < deepN ? deepTr : 2;
    const a = await nseG(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(nTr > 2 ? from2 : from)}&to_date=${dmy(to)}`);
    const ar = await nseG(`https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(sym)}`);
    if (a.code !== 200 && ar.code !== 200) { blocked++; if (blocked >= 5) { log("Deep reading: NSE keeps refusing — stopping for this run."); stopRun = true; return; } await sleep(15000 * blocked); await session(); return; }
    blocked = 0;
    const ann = a.j ? (Array.isArray(a.j) ? a.j : (a.j.data || [])) : []; const ars = ar.j ? (ar.j.data || []) : [];
    const list = pickDocs(sym, ann, ars, nTr).filter(d => { const x = ix.docs[d.doc]; return !(x && (x.s === 2 || (x.s === 1 && x.v >= DEEP_VERSION))); });
    const co = await loadCo(sym);
    co.flags = deepSignals(ann.filter(r => Date.parse(String(r.an_dt || r.sort_date || "").replace(/-/g, " ")) > Date.now() - 400 * 864e5));
    await companyExtras(sym, co);
    for (const d of list) { if (stopRun || Date.now() > until - 120000 || docs >= maxDocs) break; await readDoc(sym, co, d); }
    co.name = (list[0] && list[0].name) || co.name || (ann[0] && ann[0].sm_name) || sym; co.t = Date.now(); co.reader = READER_VERSION; co.v = DEEP_VERSION;
    await judgeCo(sym, co);
    await tidyCo(sym, co);
    const pending = co.docs.some(x => x.status === 0) || list.some(d => !ix.docs[d.doc]);     // a document to retry / not reached → back next run
    ix.companies[sym] = { ...(ix.companies[sym] && ix.companies[sym].v2 ? { v2: ix.companies[sym].v2 } : {}), t: pending ? 0 : Date.now(), v: DEEP_VERSION, docs: co.docs.filter(x => x.status === 1).length, facts: co.facts.length, commitments: (co.commitments || []).length, flags: (co.flags || []).filter(f => f.lvl === "red").length, n: String(co.name || "").slice(0, 60), tg: (co.tags || []).slice(0, 6), cp: (co.competitors || []).slice(0, 10), ripe: ripeCount(co), jt: co.jt || 0, tv: co.tv || 0, tdt: co.tdt || 0 };
    await saveCo(sym, co); cos++; sinceSave++;
    ix.spent = +(spent0 + claudeCost(st)).toFixed(4);
    if (ix.spent >= cap) { log(`Deep reading: budget of $${cap} reached.`); stopRun = true; }
    if (sinceSave >= 20 || Date.now() - lastPub > 8 * 60e3) { sinceSave = 0; lastPub = Date.now(); await publish(`deep reading: ${Object.keys(ix.companies).length} companies`); }   // saved at least every 8 minutes
  }
  // first: commitments of companies read earlier whose deadline has now passed (weekly check, a few minutes per run)
  { const jUntil = Math.min(until - 120000, Date.now() + (o.judgeMinutes ?? 8) * 60e3); let jn = 0;
    const due = Object.entries(ix.companies).filter(([, c]) => c && c.v >= DEEP_VERSION && c.t && (c.ripe == null || c.ripe > 0 || (c.jr || 0) < JUDGE_RULES) && (Date.now() - (c.jt || 0) > 7 * 864e5 || (c.jr || 0) < JUDGE_RULES)).map(([s]) => s);
    for (const sym of due) { if (stopRun || Date.now() > jUntil) break; const co = await loadCo(sym); const before = co.judged || 0; await judgeCo(sym, co);
      Object.assign(ix.companies[sym], { ripe: ripeCount(co), jt: co.jt || Date.now(), jr: JUDGE_RULES }); await saveCo(sym, co); jn += (co.judged || 0) - before; }
    if (due.length) log(`Deep reading: promises checked for ${Math.min(due.length, jn ? due.length : due.length)} compan${due.length === 1 ? "y" : "ies"} — ${jn} verdicts.`); }
  // then: tidy-up of companies read earlier (once), and of your watchlist companies twice a day — several at once
  let tidyLeft = 0, tidyDone = 0;
  { const tUntil = Math.min(until - 120000, Date.now() + (o.tidyMinutes ?? 12) * 60e3); let tn = 0, tc = 0;
    const due = Object.entries(ix.companies).filter(([s, c]) => c && c.v >= DEEP_VERSION && c.t && (c.tv !== TIDY_VERSION || (watchSet.has(s) && Date.now() - (c.tdt || 0) > 12 * 3600e3)))
      .map(([s]) => s).sort((a, b) => (order.get(a) ?? 9e9) - (order.get(b) ?? 9e9));
    let nx = 0; const tw = async () => { while (!stopRun && Date.now() < tUntil) { const sym = due[nx++]; if (sym === undefined) break;
      try { const co = await loadCo(sym); tn += (await tidyCo(sym, co)) || 0; if (co.tv === TIDY_VERSION) { Object.assign(ix.companies[sym], { tv: co.tv, tdt: co.tdt }); await saveCo(sym, co); tc++; } } catch (e) {} } };
    await Promise.all(Array.from({ length: Math.max(1, o.parallel || +process.env.TREX_DEEP_PARALLEL || 4) }, tw));
    tidyLeft = due.length - tc; tidyDone = tc;
    if (due.length) { log(`Deep reading: tidied ${tc} of ${due.length} companies waiting (${tn} number names given a standard name).`); ix.spent = +(spent0 + claudeCost(st)).toFixed(4); if (tc) await publish(`tidy-up: ${tc} companies`); } }
  // several companies at once (each still reads its documents one by one); NSE requests stay spaced out
  let next = 0; const par = Math.max(1, o.parallel || +process.env.TREX_DEEP_PARALLEL || 4);
  const worker = async () => { while (!stopRun && Date.now() < until - 120000 && docs < maxDocs) { const sym = tg.symbols[next++]; if (sym === undefined) break; try { await processCo(sym); } catch (e) { log("Deep reading: a company was skipped after an error: " + String(e.message || e).slice(0, 120)); } } };
  await Promise.all(Array.from({ length: par }, worker));
  // SECOND READING of midcaps and smallcaps (SEBI ranks by market value, default 101–1000), largest first, with its own budget
  const cap2 = +(o.budget2Usd ?? process.env.TREX_DEEP2_BUDGET_USD ?? 0); let d2 = { left: 0, done: 0, docs: 0, total: 0, hit: false };
  if (cap2 > 0 && !stopRun && !ix.keyDead && Date.now() < until - 120000) {
    const [rf, rt] = String(o.ranks2 || process.env.TREX_DEEP2_RANKS || "101-1000").split("-").map(Number);
    const t2 = await F(`${server}/api/collect?action=deeptargets2&from=${rf || 101}&to=${rt || 1000}`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()).catch(() => null);
    const list2 = (t2 && t2.ok && Array.isArray(t2.symbols)) ? t2.symbols : [];
    const base2 = ix.v2spent || 0, c0 = claudeCost(st), spent2 = () => +(base2 + claudeCost(st) - c0).toFixed(4);
    const to2 = new Date(), from2b = new Date(DEEP2_SINCE + "T00:00:00Z");
    async function processCo2(sym) {
      const c = ix.companies[sym]; if (c && c.v2) return;
      if (spent2() >= cap2) { d2.hit = true; return; }
      const a = await nseG(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(from2b)}&to_date=${dmy(to2)}`);
      const ar = await nseG(`https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(sym)}`);
      if (a.code !== 200 && ar.code !== 200) { blocked++; if (blocked >= 5) { log("Deep reading: NSE keeps refusing — stopping for this run."); stopRun = true; return; } await sleep(15000 * blocked); await session(); return; }
      blocked = 0;
      const ann = a.j ? (Array.isArray(a.j) ? a.j : (a.j.data || [])) : []; const ars = ar.j ? (ar.j.data || []) : [];
      const list = pickDocs2(sym, ann, ars).filter(d => { const x = ix.docs[d.doc]; return !(x && (x.s === 2 || (x.s === 1 && x.v >= DEEP_VERSION))); });
      const co = await loadCo(sym); let read = 0;
      for (const d of list) { if (stopRun || Date.now() > until - 120000 || docs >= maxDocs) break; if (spent2() >= cap2) { d2.hit = true; break; } await readDoc(sym, co, d, 2); read++; }
      if (read) { co.name = (list[0] && list[0].name) || co.name || sym; await judgeCo(sym, co); await tidyCo(sym, co); }
      const pending = list.some(d => !ix.docs[d.doc] || ix.docs[d.doc].s === 0);
      const prev = ix.companies[sym] || {};
      ix.companies[sym] = { ...prev, v2: pending ? 0 : Date.now(), docs: co.docs.filter(x => x.status === 1).length, facts: co.facts.length, commitments: (co.commitments || []).length,
        n: prev.n || String(co.name || "").slice(0, 60), tg: (co.tags || []).slice(0, 6), cp: (co.competitors || []).slice(0, 10), ripe: ripeCount(co), jt: co.jt || prev.jt || 0, tv: co.tv || prev.tv || 0, tdt: co.tdt || prev.tdt || 0 };
      if (read) await saveCo(sym, co);
      d2.docs += read; if (!pending) d2.done++;
      ix.v2spent = spent2(); ix.spent = +(spent0 + claudeCost(st)).toFixed(4);
      if (ix.spent >= cap) { log(`Deep reading: budget of $${cap} reached.`); stopRun = true; }
      if (++sinceSave >= 20 || Date.now() - lastPub > 8 * 60e3) { sinceSave = 0; lastPub = Date.now(); await publish(`second reading: ${list2.filter(s => ix.companies[s] && ix.companies[s].v2).length} of ${list2.length} companies`); }
    }
    let n2 = 0; const w2 = async () => { while (!stopRun && !d2.hit && Date.now() < until - 120000 && docs < maxDocs) { const sym = list2[n2++]; if (sym === undefined) break; try { await processCo2(sym); } catch (e) { log("Deep reading: a company was skipped after an error: " + String(e.message || e).slice(0, 120)); } } };
    await Promise.all(Array.from({ length: par }, w2));
    ix.v2spent = spent2(); d2.total = list2.length; d2.left = list2.filter(s => !(ix.companies[s] && ix.companies[s].v2)).length;
    log(`Second reading (midcaps and smallcaps, ranks ${rf}–${rt}): ${d2.docs} new documents this run · ${d2.total - d2.left} of ${d2.total} companies done · $${ix.v2spent.toFixed(2)} of $${cap2} used${d2.hit || ix.v2spent >= cap2 ? " — budget reached, stopping" : ""}.`);
    // ACCURACY CHECK (after the second reading, in the time left): a stronger model re-reads the page of up to 8 numbers per
    // company (smallcaps first) and says whether each number really belongs to that item, period and unit. A number shown
    // to be wrong is taken out of the company file (kept in "dropped" with the reason); right ones are marked checked.
    const cap3 = +(o.checkUsd ?? process.env.TREX_DEEP_CHECK_BUDGET_USD ?? 0);
    if (cap3 > 0 && !stopRun && !ix.keyDead && (d2.left === 0 || d2.hit || (ix.v2spent || 0) >= cap2) && Date.now() < until - 120000) {
      await claudeModels(F, ckey, st); const ids = st.modelList || [];
      const ver = id => parseFloat((String(id).match(/(\d+)[-.](\d+)/) || [0, 0, 0]).slice(1).join(".")) || 0;
      const strong = (o.checkModel ? [o.checkModel] : ids.filter(id => /sonnet/i.test(id)).sort((x, y) => ver(y) - ver(x))).slice(0, 1);
      const ck = ix.ck = ix.ck || { n: 0, ok: 0, bad: 0, unclear: 0, spent: 0 };
      if (!strong.length) log("Accuracy check: no stronger model available for this key — skipped.");
      else {
        const st3 = { models: strong }; const base3 = ck.spent || 0, spent3 = () => +(base3 + claudeCost(st3)).toFixed(4);
        const rankOf = new Map(list2.map((x, i) => [x, i + (rf || 101)]));
        const todo = list2.filter(x => ix.companies[x] && ix.companies[x].v2 && !ix.companies[x].ck).sort((a2, b2) => ((rankOf.get(b2) >= 251) - (rankOf.get(a2) >= 251)) || (rankOf.get(a2) - rankOf.get(b2)));
        const pj = t => { const m = String(t || "").match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
        let c3 = 0; const t3 = { n: 0, ok: 0, bad: 0, unclear: 0 };
        async function checkCo(sym) {
          const co = await loadCo(sym); const since = Date.parse(DEEP2_SINCE + "T00:00:00Z");
          const docsOk = (co.docs || []).filter(x => x.status === 1 && Date.parse(String(x.date || "").replace(/-/g, " ") + " UTC") >= since && (co.facts || []).some(f => f.doc === x.doc));
          const d = docsOk.sort((x, y) => (co.facts.filter(f => f.doc === y.doc).length) - (co.facts.filter(f => f.doc === x.doc).length))[0];
          if (!d) { ix.companies[sym].ck = Date.now(); return; }
          const fs = co.facts.filter(f => f.doc === d.doc && f.value != null && !f.ck).slice(0, 8); if (!fs.length) { ix.companies[sym].ck = Date.now(); return; }
          const r = await pdfGet(d.doc); if (r.code !== 200 || !r.body || r.body.length < 1000) return;      // could not download: next run
          let pages = []; try { pages = await pdfText(r.body); } catch (e) { return; }
          const pg = [...new Set(fs.map(f => f.page))].filter(n => n >= 1 && n <= pages.length).slice(0, 6);
          const claims = fs.filter(f => pg.includes(f.page)).map((f, i) => ({ id: i + 1, f }));
          if (!claims.length) { ix.companies[sym].ck = Date.now(); return; }
          const system = "You check numbers that were taken from an Indian listed company's own document. Be strict and literal. Reply with JSON only.";
          const prompt = `Company: ${co.name || sym} (NSE: ${sym}). Document: ${d.type}, dated ${d.date}.
For each claim below, read the page it cites and answer:
- "ok": the page clearly gives this number for this item and this period, in this unit / scale
- "wrong": the number on the page belongs to something else (another item, another period or year, another unit, crore vs lakh vs million), or the page does not say it
- "unclear": you cannot tell from the page
For "wrong" add "why" (at most 20 words). Reply exactly as {"checks":[{"id":1,"verdict":"ok"},{"id":2,"verdict":"wrong","why":"…"}]}.

Claims:
${claims.map(c => `${c.id}. ${c.f.item} — ${c.f.metric}${c.f.period ? " — " + c.f.period : ""}: ${c.f.vtext || c.f.value} ${c.f.unit || ""} (page ${c.f.page})`).join("\n")}

${pg.map(n => `=== PAGE ${n} ===\n${String(pages[n - 1] || "").slice(0, 6000)}`).join("\n\n")}`;
          const before = claudeCost(st3);
          let ans; try { ans = await askClaude(F, ckey, system, prompt, null, st3); } catch (e) { if (e.fatal || e.config) { ix.keyDead = e.fatal ? Date.now() : ix.keyDead; stopRun = true; } return; }
          st.cost = (st.cost != null ? st.cost : claudeCost(st)) + (claudeCost(st3) - before);       // counted in the total too
          const j = pj(ans.text); const list = (j && Array.isArray(j.checks)) ? j.checks : null; if (!list) return;
          const drop = new Set();
          for (const c of claims) { const v = list.find(x => +x.id === c.id); const verdict = v && String(v.verdict || "").toLowerCase(); t3.n++;
            if (verdict === "ok") { c.f.ck = 1; t3.ok++; }
            else if (verdict === "wrong") { drop.add(c.f); t3.bad++; co.dropped = (co.dropped || []).concat([{ ...c.f, why: String(v.why || "").slice(0, 160), t: Date.now(), by: ans.model }]).slice(-200); }
            else t3.unclear++; }
          if (drop.size) co.facts = co.facts.filter(f => !drop.has(f));
          await saveCo(sym, co); ix.companies[sym].ck = Date.now(); ix.companies[sym].facts = co.facts.length; c3++;
        }
        let n3 = 0; const w3 = async () => { while (!stopRun && Date.now() < until - 120000 && spent3() < cap3) { const sym = todo[n3++]; if (sym === undefined) break; try { await checkCo(sym); } catch (e) {} ck.spent = spent3(); } };
        await Promise.all(Array.from({ length: par }, w3));
        ck.spent = spent3(); ck.n += t3.n; ck.ok += t3.ok; ck.bad += t3.bad; ck.unclear += t3.unclear; d2.ckLeft = spent3() < cap3 ? todo.length - c3 : 0; d2.ck = c3;
        ix.spent = +(spent0 + claudeCost(st)).toFixed(4);
        log(`Accuracy check: ${c3} companies, ${t3.n} numbers this run (${t3.ok} right, ${t3.bad} wrong and taken out, ${t3.unclear} unclear) · total ${ck.n} checked, ${ck.bad} taken out · $${ck.spent.toFixed(2)} of $${cap3} used [${strong[0]}].`);
      }
    }
  }
  if (ix.keyDead) { ix.spent = +(spent0 + claudeCost(st)).toFixed(4); await publish(`stop: key not usable`); return { ok: true, keyDead: true, docs }; }
  ix.inTok = (ix.inTok || 0) + st.inTok; ix.outTok = (ix.outTok || 0) + st.outTok; ix.t = Date.now();
  await publish(`deep reading: ${Object.keys(ix.companies).length} companies`);
  const total = tg.symbols.length, have = Object.keys(ix.companies).length;
  log(`Deep reading: ${cos} companies, ${docs} documents, ${facts} checked facts this run · ${have} of ${total} companies done · Claude cost so far ≈ $${ix.spent.toFixed(2)} (this run ≈ $${claudeCost(st).toFixed(2)}).`);
  // more to read → tell the workflow to start the next run straight away (no waiting for the clock). Companies never tried
  // count always; companies left half-done (a document to retry) and the tidy-up count only while this run made progress on
  // them — otherwise the hourly timer retries them, instead of a run every 15 minutes that changes nothing.
  const unread = tg.symbols.filter(s => !ix.companies[s]).length;
  const halfDone = tg.symbols.filter(s => { const c = ix.companies[s]; return c && !(c.v >= DEEP_VERSION && c.t); }).length;
  const more2 = (cap2 > 0 && d2.left > 0 && !d2.hit && (ix.v2spent || 0) < cap2 && (d2.docs > 0 || d2.done > 0)) || ((d2.ckLeft || 0) > 0 && (d2.ck || 0) > 0);
  if (!o.skipGit && !ix.keyDead && ix.spent < cap && (deepMore({ unread, halfDone, docs, tidyLeft, tidyDone }) || more2)) {
    // GitHub's hourly timer is unreliable for this repository, so each run starts the next one; a run that got nothing done
    // (NSE refusing, Claude busy) asks the workflow to wait 15 minutes first
    try { writeFileSync(join(tmpdir(), "trex-deep-more"), "1"); if (docs === 0 && !tidyDone) writeFileSync(join(tmpdir(), "trex-deep-wait"), "1"); } catch (e) {} }
  return { ok: true, companies: cos, docs, facts, spent: ix.spent, have, total };
}
// start the next run at once? — yes while companies were never tried, or while this run made progress on half-done ones / the tidy-up
export function deepMore(x) { return x.unread > 0 || (x.halfDone > 0 && x.docs > 0) || (x.tidyLeft > 0 && x.tidyDone > 0); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDeep().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(0); });
