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
 "what": one plain sentence of what it is (your words, max 30 words),
 "quote": the sentence from the page that proves the stage, COPIED word-for-word (10–45 words),
 "page": the PAGE number of that sentence,
 "nums": numbers written in that same sentence about this line (capex, capacity, order value, revenue, target date): [{"v":"110","u":"Rs Cr","what":"capex"}].
Rules: copy the quote exactly; never invent; if nothing new is described reply {"lines":[]}; at most 8 lines.
Reply as {"lines":[{"line":"","theme":"","stage":"","what":"","quote":"","page":0,"nums":[]}]}
${sel.map(p => `\n=== PAGE ${p.page} ===\n${p.text}`).join("\n")}`;
  return { system, prompt };
}
// keep a line only when its quote is found in the document; numbers only when written in that quote
export function ventVerify(text, pagesSets, doc) {
  let j = null; try { j = JSON.parse(String(text).replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { j = salvageJson(text); }
  const raw = j && Array.isArray(j.lines) ? j.lines : [], out = [];
  const digits = s => String(s || "").replace(/[,\s]/g, "");
  for (const x of raw) {
    if (!x || !x.line || !x.quote) continue;
    const f = findQuote(x.quote, x.page, pagesSets); if (!f) continue;
    const q = digits(f.quote);
    out.push({ line: String(x.line).slice(0, 90), theme: VENT_THEMES.includes(x.theme) ? x.theme : "other", stage: VENT_STAGES.includes(x.stage) ? x.stage : "talked",
      what: String(x.what || "").slice(0, 240), quote: f.quote, page: f.page, doc: doc.url, type: doc.type, date: doc.date,
      nums: (Array.isArray(x.nums) ? x.nums : []).filter(n => n && n.v != null && String(n.v).trim() && q.includes(digits(n.v))).slice(0, 6) });
  }
  return { raw: raw.length, lines: out };
}

async function main() {
  const server = (process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, ""), KEY = process.env.TREX_KEY, CKEY = process.env.ANTHROPIC_API_KEY;
  const log = m => console.log(new Date().toISOString().slice(11, 19) + "  " + m);
  if (!KEY || !CKEY) { log("New ventures pilot: TREX_KEY / ANTHROPIC_API_KEY missing."); return; }
  const budget = +(process.env.TREX_VENT_BUDGET_USD || 1), N = +(process.env.TREX_VENT_N || 20);
  const trex = (action, qs = "", body) => fetch(`${server}/api/collect?action=${action}${qs}`, { method: "POST", headers: { "x-trex-key": KEY, ...(body ? { "x-trex-gz": "1" } : {}) }, body: body ? gzipSync(JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(90000) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  const stat = await trex("vent", "&stat=1"); if (!stat.ok) { log("New ventures pilot: T-Rex problem: " + stat.error); return; }
  if (stat.stop) { log(`New ventures pilot: the cap of $${stat.cap} is used ($${stat.spent}) — nothing to do.`); return; }
  // the deep-reading files (read only)
  const dir = "ventdeep", repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", "deep-data", `https://x-access-token:${tok}@github.com/${repo}.git`, dir], { stdio: ["ignore", "pipe", "pipe"] });
  const loadCo = async s => { try { return await openText(readFileSync(join(dir, "d", s + ".json"), "utf8")); } catch (e) { return null; } };
  // companies: the owner's examples first, then small and midcaps spread across the ranks
  const rk = await trex("deeptargets2", "&from=101&to=1000"), ranked = (rk && rk.symbols) || [], rank = new Map(ranked.map((s, i) => [s, i + 101]));
  const want = String(process.env.TREX_VENT_SYMS || "TIMETECHNO,OLAELEC").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const step = Math.max(1, Math.floor(ranked.length / (N * 2)));
  const pool = [...want, ...ranked.filter((_, i) => i % step === 0)], picked = [];
  const recent = Date.UTC(2025, 6, 1);
  for (const s of pool) { if (picked.length >= N) break; if (picked.some(p => p.s === s) || !existsSync(join(dir, "d", s + ".json"))) continue;
    const co = await loadCo(s); if (!co || !Array.isArray(co.docs)) continue;
    const ok = co.docs.filter(d => d.status === 1 && /transcript|presentation/i.test(d.type || "") && docTime(d.date) >= recent && /^https:\/\/\S+\.pdf$/i.test(d.doc || ""));
    const tr = ok.filter(d => /transcript/i.test(d.type)).sort((a, b) => docTime(b.date) - docTime(a.date))[0], pr = ok.filter(d => /presentation/i.test(d.type)).sort((a, b) => docTime(b.date) - docTime(a.date))[0];
    const docs = [tr, pr].filter(Boolean); if (docs.length) picked.push({ s, name: co.name || s, docs }); }
  log(`New ventures pilot: ${picked.length} companies picked (cap $${stat.cap}, spent so far $${stat.spent}).`);
  const curl = url => new Promise(res => { const tmp = join(tmpdir(), "vent-" + Date.now() + Math.random().toString(36).slice(2) + ".pdf");
    execFile("curl", ["-sSL", "--max-time", "90", "-A", UA, "-e", REF, "-o", tmp, "-w", "%{http_code}", url], { timeout: 100000 }, (e, out) => { let b = null; try { b = readFileSync(tmp); unlinkSync(tmp); } catch (x) {} res(!e && +String(out).trim() === 200 && b && b.length > 1000 ? b : null); }); });
  const getPdf = async url => { const b = await curl(url); if (b) return b;
    try { const r = await fetch(`${server}/api/collect?action=nsedoc&u=${encodeURIComponent(url)}`, { method: "POST", headers: { "x-trex-key": KEY }, signal: AbortSignal.timeout(120000) }); if (r.ok) { const x = Buffer.from(await r.arrayBuffer()); if (x.length > 1000) return x; } } catch (e) {} return null; };
  const st = { inTok: 0, outTok: 0 }; let n = 0, kept = 0;
  for (const c of picked) {
    if ((st.cost || 0) >= budget) { log("New ventures pilot: this run's budget is used — stopping."); break; }
    const c0 = st.cost || 0, lines = []; let raw = 0, model = "", err = null;
    for (const d of c.docs) {
      const buf = await getPdf(d.doc); if (!buf) { err = "could not download a document"; continue; }
      let pages = [], pagesRaw = null; try { pages = await pdfTextPoppler(buf); pagesRaw = await pdfTextPoppler(buf, false); } catch (e) { err = "PDF unreadable"; continue; }
      const sel = ventPages(pages); if (!sel.length) continue;
      const { system, prompt } = ventPrompt(c.name, c.s, d.type, d.date, sel);
      let ans; try { ans = await askClaude(fetch, CKEY, system, prompt, null, st); } catch (e) { err = String(e.message || e).slice(0, 100); if (e.fatal || e.config) { log("New ventures pilot: Claude key problem — stopping."); return; } continue; }
      model = ans.model; const v = ventVerify(ans.text, [pagesRaw, pages], { url: d.doc, type: d.type, date: d.date }); raw += v.raw;
      for (const l of v.lines) if (!lines.some(x => x.line.toLowerCase() === l.line.toLowerCase())) lines.push(l);
    }
    const cost = Math.round(((st.cost || 0) - c0) * 1e5) / 1e5; n++; kept += lines.length;
    const r = await trex("vent", "", { s: c.s, name: c.name, rank: rank.get(c.s) || null, docs: c.docs.map(d => ({ type: d.type, date: d.date })), lines, cost, model, raw, err });
    log(`  company ${n}: ${lines.length} of ${raw} lines kept (quote found on the page), $${cost}`);
    if (r && r.stop) { log("New ventures pilot: T-Rex says the cap is reached — stopping."); break; }
  }
  log(`New ventures pilot: ${n} companies, ${kept} lines kept, $${Math.round((st.cost || 0) * 1e4) / 1e4} this run.`);
}
if (process.argv[1] && process.argv[1].endsWith("ventures.mjs")) main();
