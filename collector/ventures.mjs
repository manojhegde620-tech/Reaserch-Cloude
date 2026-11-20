// T-Rex · New ventures PILOT (owner's "go ahead", 20 Nov 2026 — design mockups/new-ventures.html; his example: Time Technoplast's
// hydrogen / composite cylinders). For a few companies, reads the latest earnings-call transcript and investor presentation already
// listed in T-Rex's deep-reading files, and asks one question: which NEW business lines (products, businesses, technologies or
// markets that are new for this company) does it describe, and how far along is each one (the 7-step ladder)?
//  • Every line must come with a sentence copied from the document; the sentence is looked for on the page (findQuote) and the
//    line is dropped when it is not there. Numbers are kept only when they appear in that sentence.
//  • Results go to T-Rex (POST /api/collect?action=vent) for Mr. T-Rex's review; nothing is published, nothing is saved on GitHub.
//  • Hard money cap: T-Rex counts the spend across runs and says stop at TREX_VENT_CAP (default $1); this run also stops at
//    TREX_VENT_BUDGET_USD. This public log shows no company names.
import { execFileSync, execFile } from "node:child_process";
import { readFileSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pdfTextPoppler, askClaude, findQuote, salvageJson } from "./insights.mjs";
import { openText } from "./seal.mjs";

export const VENT_THEMES = ["hydrogen_gas", "ev_batteries", "defence_aerospace", "semiconductors_electronics", "solar_green_power", "railways", "data_centres", "medical_devices", "speciality_chemicals", "other"];
export const VENT_STAGES = ["talked", "approval", "partner", "money", "first_order", "production", "in_numbers"];
// (pilot v2, 20 Nov 2026 — the first run's noise: new brands in an existing range, equipment a hospital bought, a wealth manager's new
// fund tagged "defence") the reader must say what kind of newness it is and the company's role; only real new businesses it makes or sells are kept
export const VENT_KINDS = ["new_business", "new_technology", "new_market", "new_variant"];
export const VENT_ROLES = ["maker_seller", "user", "investor_financier"];
const KW = /new (product|business|segment|vertical|venture|technolog|line|market|categor|geograph)|foray|diversif|forward integration|backward integration|enter(ed|ing|s)? (into|the)|launch|pilot|prototype|trials?\b|approval|certif|PESO|\bBIS\b|DGCA|RDSO|DRDO|qualif|validat|\bMoU\b|tie-?up|collaborat|partnership|joint venture|\bJV\b|subsidiar|greenfield|capex|new plant|commission|first order|maiden order|hydrogen|batter|\bcells?\b|semiconductor|defen[cs]e|drone|solar|electroly|\bEVs?\b|electric vehicle|data cent|CDMO|green ammonia|biofuel|ethanol|export/gi;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export const docTime = d => { const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(d || "")); return m ? Date.UTC(+m[3], MON[m[2].toLowerCase()], +m[1]) : (Date.parse(d) || 0); };

// the pages most about new things (and their neighbours), within a character budget
export function ventPages(pages, budget = 24000) {
  const sc = pages.map((t, i) => ({ i, n: (String(t).match(KW) || []).length, len: String(t).length })).filter(x => x.n > 0 && x.len > 60).sort((a, b) => b.n - a.n);
  const pick = new Set(); let used = 0;
  for (const x of sc) { if (used + x.len > budget) continue; pick.add(x.i); used += x.len; if (used > budget * 0.92) break; }
  return [...pick].sort((a, b) => a - b).map(i => ({ page: i + 1, text: pages[i] }));
}
export function ventPrompt(company, symbol, type, date, sel) {
  const system = "You find new business lines in an Indian listed company's document for investors. Reply with JSON only.";
  const prompt = `Company: ${company} (NSE: ${symbol}). Document: ${type}, dated ${date}.
List the NEW business lines this document describes: products, businesses, technologies or markets that are NEW for this company
(started in the last ~3 years, being developed, or planned) — NOT its long-established core business, NOT routine capacity additions
of existing products, NOT general industry talk.
For each line:
 "line": short name as the company calls it (e.g. "Type IV composite hydrogen cylinders"),
 "theme": one of ${VENT_THEMES.join(", ")},
 "stage": the furthest step the document itself states: talked (only mentioned / being developed or tested), approval (licence,
   certification, regulatory approval received), partner (technology tie-up, JV, MoU signed), money (capex approved, plant or subsidiary
   set up for it), first_order (an order or named customer won), production (commercial production / supplies started),
   in_numbers (revenue or volume of this line stated),
 "kind": new_business (a business or product category the company was not in before), new_technology (a new technology it will make or sell),
   new_market (an existing product sold into a clearly new industry or customer group), new_variant (a new brand, model, size or SKU inside a
   category it already sells — these are NOT new business lines),
 "role": maker_seller (the company will make or sell it), user (it buys or uses it for its own operations — e.g. a hospital's new machine),
   investor_financier (it invests in, lends to or runs a fund for it),
 "what": one plain sentence of what it is (your words, max 30 words),
 "quote": the sentence from the page that proves the stage, COPIED word-for-word (10–45 words),
 "page": the PAGE number of that sentence,
 "nums": numbers written in that same sentence about this line (capex, capacity, order value, revenue, target date): [{"v":"110","u":"Rs Cr","what":"capex"}].
Rules: copy the quote exactly; never invent; if nothing new is described reply {"lines":[]}; at most 8 lines.
Reply as {"lines":[{"line":"","kind":"","role":"","theme":"","stage":"","what":"","quote":"","page":0,"nums":[]}]}
${sel.map(p => `\n=== PAGE ${p.page} ===\n${p.text}`).join("\n")}`;
  return { system, prompt };
}
// keep a line only when its quote is found in the document; numbers only when written in that quote
// the same line said twice — in one document or across the transcript and the presentation ("LFP cells" / "In-house LFP cells",
// "Indrajal" / "Indrajaal", "CAR T-cell" / "CAR-T cell"): one line, the furthest step kept
export function ventKey(name) {
  return String(name || "").toLowerCase().replace(/[-–/]/g, " ").replace(/[^a-z0-9 ]/g, " ").replace(/([a-z])\1+/g, "$1").split(/\s+/)
    .filter(w => w.length > 1 && !/^(own|new|the|and|for|with|in|of|house|production|products?|business|systems?|solutions?|platform)$/.test(w)).sort();
}
export function ventMerge(lines) {
  const keep = [], evOf = l => ({ stage: l.stage, quote: l.quote, page: l.page, doc: l.doc, type: l.type, date: l.date, nums: l.nums || [] });
  for (const l of lines) { const b = ventKey(l.line), i = keep.findIndex(m => { const a = new Set(ventKey(m.line)); return b.length && a.size && b.filter(w => a.has(w)).length / Math.min(a.size, b.length) >= 0.75; });
    if (i < 0) { keep.push({ ...l, first: l.date || null, ev: l.ev ? [...l.ev] : [evOf(l)] }); continue; }
    const k = keep[i], ev = [...k.ev, ...(l.ev || [evOf(l)])];
    const top = VENT_STAGES.indexOf(l.stage) > VENT_STAGES.indexOf(k.stage) ? { ...l } : { ...k };
    top.line = k.line; top.ev = ev; top.first = [k.first, l.first || l.date].filter(Boolean).sort((x, y) => docTime(x) - docTime(y))[0] || null; keep[i] = top; }
  // evidence oldest first, at most 6 (the furthest step's own sentence always kept)
  for (const k of keep) { const seen = new Set(); k.ev = k.ev.filter(e => { const q = e.quote ? String(e.quote).slice(0, 80) : `${e.stage}|${e.date}|${e.doc}`; if (seen.has(q)) return false; seen.add(q); return true; }).sort((a, b) => docTime(a.date) - docTime(b.date));
    if (k.ev.length > 6) { const top = k.ev.find(e => e.quote === k.quote); k.ev = [...k.ev.slice(0, 5), ...(top && !k.ev.slice(0, 5).includes(top) ? [top] : [k.ev[k.ev.length - 1]])]; } }
  return keep;
}
export const VENT_RV = 3;   // reader version of the full run (companies read by an older version are read again)
export function ventVerify(text, pagesSets, doc) {
  let j = null; try { j = JSON.parse(String(text).replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { j = salvageJson(text); }
  const raw = j && Array.isArray(j.lines) ? j.lines : [], out = []; let dropped = 0;
  const digits = s => String(s || "").replace(/[,\s]/g, "");
  for (const x of raw) {
    if (!x || !x.line || !x.quote) continue;
    if (x.role !== "maker_seller" || !["new_business", "new_technology", "new_market"].includes(x.kind)) { dropped++; continue; }   // only real new businesses the company makes or sells
    const f = findQuote(x.quote, x.page, pagesSets); if (!f) continue;
    const q = digits(f.quote);
    out.push({ line: String(x.line).slice(0, 90), theme: VENT_THEMES.includes(x.theme) ? x.theme : "other", stage: VENT_STAGES.includes(x.stage) ? x.stage : "talked",
      kind: VENT_KINDS.includes(x.kind) ? x.kind : null, role: VENT_ROLES.includes(x.role) ? x.role : null,
      what: String(x.what || "").slice(0, 240), quote: f.quote, page: f.page, doc: doc.url, type: doc.type, date: doc.date,
      nums: (Array.isArray(x.nums) ? x.nums : []).filter(n => n && n.v != null && String(n.v).trim() && q.includes(digits(n.v))).slice(0, 6) });
  }
  const keep = ventMerge(out);
  return { raw: raw.length, dropped, lines: keep };
}

// CLEAN-UP (owner 20 Nov 2026, "yes, add the clean-up"): one short question per company over the lines ALREADY saved (no documents read
// again): which lines are the same thing said in different words (folded into one), and which are the company's long-standing business
// rather than something new (hidden with the reason). Lines are only folded or hidden — never reworded — so nothing new can be made up.
export const VENT_TV = 2;   // v2 (20 Nov 2026): names the core business first, then hides lines inside it (v1 kept Mazagon Dock's ONGC offshore orders)
export function ventTidyPrompt(company, symbol, lines) {
  const system = "You tidy a list of new business lines found in an Indian listed company's own documents, for investors. Reply with JSON only.";
  const prompt = `Company: ${company} (NSE: ${symbol}).
These lines were found in its call transcripts, investor presentation and annual report (2025 onwards), each with the company's own sentences:
${lines.map(l => `${l.k}: "${l.line}" (${l.theme}, step: ${l.stage}${l.kind ? ", " + l.kind : ""})${l.what ? " — " + l.what : ""}\n   sentences: ${l.quotes.map(q => `"${q}"`).join(" | ")}`).join("\n")}
Three tasks:
1. "same": groups of keys that are clearly the SAME product, project or business described in different words (e.g. "5 GWh battery
   assembly plant" and "5 GWh BESS assembly facility"; "multipurpose cargo vessels for a European client" and "multipurpose vessel for
   Denmark client"). Put the clearest name first. Do NOT group lines that are only related (e.g. "LFP cells" and "battery packs").
2. "core": first write one sentence naming the businesses this company has been in for many years (from what you know of the company
   and from these sentences).
3. "old": keys that are NOT new for this company: the same kind of product or service, for the same kind of customers, as that
   long-established core business — even when the order, project, plant or customer itself is new. Examples: a shipbuilder that has built
   offshore platforms and vessels for ONGC for decades winning more ONGC offshore orders; a bank's new loan products; a drug maker's routine
   new generic launches in markets it already sells in; a cable maker's bigger cable plant. A line stays (not "old") when it is a product
   category, technology or customer industry the company was not in before (e.g. a defence shipbuilder's first commercial cargo ships, a
   cylinder maker's first hydrogen cylinders). Give a short reason. When unsure, leave it out.
Reply as {"same":[["L0","L3"]],"core":"","old":[{"k":"L2","why":""}]} — empty lists when nothing applies.`;
  return { system, prompt };
}
// only keys that exist; a key in at most one group; reasons kept short
export function ventTidyCheck(text, keys) {
  let j = null; try { j = JSON.parse(String(text).replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { j = salvageJson(text); }
  if (!j || typeof j !== "object") return null;
  const K = new Set(keys), used = new Set(), groups = [], old = [];
  for (const g of Array.isArray(j.same) ? j.same : []) { const ks = [...new Set((Array.isArray(g) ? g : []).map(String))].filter(k => K.has(k) && !used.has(k));
    if (ks.length >= 2) { ks.forEach(k => used.add(k)); groups.push(ks); } }
  for (const x of Array.isArray(j.old) ? j.old : []) { const k = String((x && x.k) || ""); if (K.has(k) && !old.some(o => o.k === k)) old.push({ k, why: String((x && x.why) || "").slice(0, 120) }); }
  return { groups, old };
}

async function main() {
  const server = (process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, ""), KEY = process.env.TREX_KEY, CKEY = process.env.ANTHROPIC_API_KEY;
  const log = m => console.log(new Date().toISOString().slice(11, 19) + "  " + m);
  if (!KEY || !CKEY) { log("New ventures: TREX_KEY / ANTHROPIC_API_KEY missing."); return; }
  const budget = +(process.env.TREX_VENT_BUDGET_USD || 1), N = +(process.env.TREX_VENT_N || 1000);
  const trex = (action, qs = "", body) => fetch(`${server}/api/collect?action=${action}${qs}`, { method: "POST", headers: { "x-trex-key": KEY, ...(body ? { "x-trex-gz": "1" } : {}) }, body: body ? gzipSync(JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(90000) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  const stat = await trex("vent", `&stat=1&rv=${VENT_RV}&tv=${VENT_TV}`); if (!stat.ok) { log("New ventures: T-Rex problem: " + stat.error); return; }
  const st = { inTok: 0, outTok: 0, cost: 0 }; let tidyStop = !stat.tidy || stat.tidy.stop, tidied = 0, tidyCost = 0;
  // (20 Nov 2026) each company's cost is counted on its OWN counter: with 4 companies read at once, "run total after − before" also
  // caught the other three's spend (run #3 counted ~4× the real cost). The run total is the sum of the companies' own counters.
  const own = () => { const c = Object.create(st); c.cost = 0; c.inTok = 0; c.outTok = 0; return c; };
  const add = c => { st.cost += c.cost; st.inTok += c.inTok; st.outTok += c.outTok; if (c.models && !st.models) { st.models = c.models; st.modelList = c.modelList; } if (c.noTemp && !st.noTemp) st.noTemp = c.noTemp; };
  // the clean-up of one company: its saved lines (given, or read back from T-Rex) → one short question → fold / hide
  async function tidyOne(s, name, given) {
    if (tidyStop) return;
    let L = given; if (!L) { const g = await trex("vent", "&get=" + encodeURIComponent(s)); if (!g || !g.ok) return; L = g.lines || []; name = g.name || name || s; }
    let groups = [], old = [], cost = 0;
    if (L.length) { const { system, prompt } = ventTidyPrompt(name || s, s, L), cs = own(); let ans = null;
      try { ans = await askClaude(fetch, CKEY, system, prompt, null, cs); } catch (e) { if (e.fatal || e.config) { tidyStop = true; } }
      add(cs); cost = Math.round(cs.cost * 1e5) / 1e5; tidyCost += cs.cost;
      const ck = ans && ventTidyCheck(ans.text, L.map(l => l.k)); if (!ck) return;           // no usable answer: tried again next run
      groups = ck.groups; old = ck.old; }
    const r = await trex("vent", "&tidy=1", { s, tv: VENT_TV, groups, old, cost }); if (r && r.ok) tidied++; if (r && r.stop) { tidyStop = true; log("New ventures: the clean-up cap is reached."); }
  }
  // first the clean-up of companies read before it existed (no documents: a few minutes)
  const untidy = (stat.untidy || []).slice(), tUntil = Date.now() + 15 * 60e3;
  if (untidy.length && !tidyStop) { log(`New ventures: cleaning up ${untidy.length} companies already read (cap $${stat.tidy.cap}, spent $${stat.tidy.spent}).`);
    await Promise.all(Array.from({ length: 4 }, async () => { while (untidy.length && !tidyStop && Date.now() < tUntil) await tidyOne(untidy.shift()); }));
    log(`  cleaned ${tidied} companies, $${Math.round(tidyCost * 1e4) / 1e4}.`); }
  if (stat.stop) { log(`New ventures: the reading cap of $${stat.cap} is used ($${stat.spent}) — nothing more to read.`); return; }
  // the deep-reading files (read only)
  const dir = "ventdeep", repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", "deep-data", `https://x-access-token:${tok}@github.com/${repo}.git`, dir], { stdio: ["ignore", "pipe", "pipe"] });
  const loadCo = async s => { try { return await openText(readFileSync(join(dir, "d", s + ".json"), "utf8")); } catch (e) { return null; } };
  // companies: ranks TREX_VENT_RANKS (small + midcaps), the owner's examples first; those already read by this reader version are skipped
  const [r0, r1] = String(process.env.TREX_VENT_RANKS || "101-1000").split("-").map(Number);
  const rk = await trex("deeptargets2", `&from=${r0}&to=${r1}`), ranked = (rk && rk.symbols) || [], rank = new Map(ranked.map((s, i) => [s, i + r0]));
  const done = new Set(stat.done || []), want = String(process.env.TREX_VENT_SYMS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const pool = [...new Set([...want, ...ranked])].filter(s => !done.has(s)).slice(0, N), since = Date.UTC(2025, 0, 1), picked = [];
  for (const s of pool) { if (!existsSync(join(dir, "d", s + ".json"))) continue;
    const co = await loadCo(s); if (!co || !Array.isArray(co.docs)) continue;
    const ok = co.docs.filter(d => d.status === 1 && /transcript|presentation|annual report/i.test(d.type || "") && docTime(d.date) >= since && /^https:\/\/\S+\.pdf$/i.test(d.doc || "")).sort((a, b) => docTime(b.date) - docTime(a.date));
    const docs = [...ok.filter(d => /transcript/i.test(d.type)).slice(0, 2), ...ok.filter(d => /presentation/i.test(d.type)).slice(0, 1), ...ok.filter(d => /annual report/i.test(d.type)).slice(0, 1)]
      .sort((a, b) => docTime(a.date) - docTime(b.date));                                     // oldest first: the first mention is dated
    picked.push({ s, name: co.name || s, docs }); }
  log(`New ventures: ${picked.length} companies to read this run (${done.size} done; cap $${stat.cap}, spent $${stat.spent}).`);
  const curl = url => new Promise(res => { const tmp = join(tmpdir(), "vent-" + Date.now() + Math.random().toString(36).slice(2) + ".pdf");
    execFile("curl", ["-sSL", "--max-time", "90", "-A", UA, "-e", REF, "-o", tmp, "-w", "%{http_code}", url], { timeout: 100000 }, (e, out) => { let b = null; try { b = readFileSync(tmp); unlinkSync(tmp); } catch (x) {} res(!e && +String(out).trim() === 200 && b && b.length > 1000 ? b : null); }); });
  const getPdf = async url => { const b = await curl(url); if (b) return b;
    try { const r = await fetch(`${server}/api/collect?action=nsedoc&u=${encodeURIComponent(url)}`, { method: "POST", headers: { "x-trex-key": KEY }, signal: AbortSignal.timeout(120000) }); if (r.ok) { const x = Buffer.from(await r.arrayBuffer()); if (x.length > 1000) return x; } } catch (e) {} return null; };
  let n = 0, kept = 0, stop = false;
  const until = Date.now() + (+process.env.TREX_VENT_MINUTES || 50) * 60e3;
  async function one(c) {
    const cs = own(), lines = []; let raw = 0, dropped = 0, model = "", err = null;
    for (const d of c.docs) {
      const buf = await getPdf(d.doc); if (!buf) { err = "could not download a document"; continue; }
      let pages = [], pagesRaw = null; try { pages = await pdfTextPoppler(buf); pagesRaw = await pdfTextPoppler(buf, false); } catch (e) { err = "PDF unreadable"; continue; }
      const sel = ventPages(pages, /annual report/i.test(d.type) ? 30000 : 24000); if (!sel.length) continue;
      const { system, prompt } = ventPrompt(c.name, c.s, d.type, d.date, sel);
      let ans; try { ans = await askClaude(fetch, CKEY, system, prompt, null, cs); } catch (e) { err = String(e.message || e).slice(0, 100); if (e.fatal || e.config) { log("New ventures: Claude key problem — stopping."); stop = true; add(cs); return; } continue; }
      model = ans.model; const v = ventVerify(ans.text, [pagesRaw, pages], { url: d.doc, type: d.type, date: d.date }); raw += v.raw; dropped += v.dropped;
      lines.push(...v.lines);
    }
    const merged = ventMerge(lines);
    add(cs); const cost = Math.round(cs.cost * 1e5) / 1e5; n++; kept += merged.length;
    const r = await trex("vent", "", { s: c.s, name: c.name, rank: rank.get(c.s) || null, rv: VENT_RV, docs: c.docs.map(d => ({ type: d.type, date: d.date })), lines: merged, cost, model, raw, dropped, err });
    if (n % 25 === 0) log(`  ${n} companies read, ${kept} lines kept, $${Math.round(st.cost * 1e4) / 1e4} this run (clean-up $${Math.round(tidyCost * 1e4) / 1e4})`);
    if (r && r.stop) { log("New ventures: T-Rex says the cap is reached — stopping."); stop = true; }
    // then its clean-up, on the lines exactly as T-Rex saved them (keys L0.., at most 12)
    if (r && r.ok && merged.length) await tidyOne(c.s, c.name, merged.slice(0, 12).map((l, i) => ({ k: "L" + i, line: l.line, theme: l.theme, stage: l.stage, kind: l.kind, what: l.what,
      quotes: [...new Set((l.ev && l.ev.length ? l.ev : [l]).map(e => String(e.quote || "").slice(0, 300)).filter(Boolean))].slice(0, 3) })));
  }
  const queue = picked.slice(), par = Math.max(1, +process.env.TREX_VENT_PARALLEL || 4);
  await Promise.all(Array.from({ length: par }, async () => { while (queue.length && !stop && Date.now() < until && st.cost < budget) await one(queue.shift()); }));
  log(`New ventures: ${n} companies read, ${kept} lines kept, ${tidied} cleaned up; $${Math.round(st.cost * 1e4) / 1e4} this run (clean-up $${Math.round(tidyCost * 1e4) / 1e4}); ${queue.length} left for the next run.`);
}
if (process.argv[1] && process.argv[1].endsWith("ventures.mjs")) main();
