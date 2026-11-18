// T-Rex · the $1 pilot (owner's OK, 16 Nov 2026): read the figures in the results PDFs of BSE-only companies and check
// EVERY number on its page. BSE refuses its figures service to cloud computers, so the company's own results PDF is
// read instead.
//   1. T-Rex (D1 bseann, from BSE's public feed) gives the most-traded BSE-only companies' newest results PDFs.
//   2. The PDF is downloaded from BSE (or through T-Rex's server if BSE refuses this computer).
//   3. Its text comes from the PDF itself, or from OCR (tesseract) when the PDF is a scan.
//   4. Claude reads the results table of the pages that hold it, copying every number exactly as printed.
//   5. Every number must be found on its page in the text/OCR, and the totals must add up; anything else is marked unchecked.
//   6. The figures go to T-Rex (POST /api/collect?action=bsefig). Nothing is saved on GitHub, and this public log shows
//      no company names or figures.
// Hard cap: TREX_BSEPILOT_BUDGET_USD (default $1), counted across all runs by T-Rex.
import { execFile } from "node:child_process";
import { writeFile, readFile, rm, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { askClaude, pdfTextPoppler, salvageJson } from "./insights.mjs";

const server = (process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
const KEY = process.env.TREX_KEY || "", CKEY = process.env.ANTHROPIC_API_KEY || "";
const CAP = +(process.env.TREX_BSEPILOT_BUDGET_USD || 1), N = Math.min(80, +(process.env.TREX_BSEPILOT_N || 10));
const MCAP = +(process.env.TREX_BSEPDF_MONTH_USD || 0);          // (17 Nov 2026, owner: read every BSE-only results PDF) cap per month; 0 = only the total cap
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const log = (...a) => console.log(...a);
const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 180000 }, (e, out) => e ? rej(e) : res(String(out))));
const trex = (action, qs = "", body) => fetch(`${server}/api/collect?action=${action}${qs}`, { method: "POST", headers: { "x-trex-key": KEY, ...(body ? { "x-trex-gz": "1" } : {}) },
  body: body ? gzipSync(JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(90000) });
const isPdf = b => b && b.length > 1000 && b.subarray(0, 5).toString() === "%PDF-";

export async function getPdf(u, F = fetch) {
  try { const r = await F(u, { headers: { "User-Agent": UA, Referer: "https://www.bseindia.com/", Accept: "application/pdf,*/*" }, signal: AbortSignal.timeout(60000) });
    if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (isPdf(b)) return { b, via: "direct" }; } } catch (e) {}
  try { const r = await trex("bsepdf", "&u=" + encodeURIComponent(u)); if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (isPdf(b)) return { b, via: "server" }; } } catch (e) {}
  return null;
}
// pdftotext ends every page with a page break, so the piece after the last break is not a page (18 Nov 2026: with "always the
// first six pages" a 3-page PDF was asked for a 4th page and could not be read). n = pages counted by pdfinfo (0 = unknown).
export const realPages = (pages, n) => { const p = (pages || []).slice(0, n > 0 ? n : Math.max(1, (pages || []).length - 1)); while (p.length < (n || 0)) p.push(""); return p; };
// page texts: the PDF's own text; pages without text (scans) are read by OCR
export async function pageTexts(dir, file, nPages) {
  let pages = []; try { pages = await pdfTextPoppler(await readFile(file)); } catch (e) {}
  pages = realPages(pages, nPages); nPages = pages.length;
  const ocr = [];
  for (let i = 0; i < Math.min(nPages, 12); i++) {
    if ((pages[i] || "").replace(/\s+/g, "").length >= 300) continue;
    try { const pre = join(dir, "p" + (i + 1)); await sh("pdftoppm", ["-r", "220", "-gray", "-png", "-f", String(i + 1), "-l", String(i + 1), "-singlefile", file, pre]);
      pages[i] = await sh("tesseract", [pre + ".png", "-", "--psm", "6"]); ocr.push(i + 1); } catch (e) {}
  }
  return { pages, ocr };
}
const KW = /revenue from operations|income from operations|total income|profit before tax|net profit|total expenses|profit \/ ?\(loss\)|earnings per share/gi;
export const kwScore = t => (String(t || "").match(KW) || []).length;
// The pages shown to the reader: the four with the most results-table words — and (v4, seen in the first v3 run: a 19-page PDF
// whose table sat on page 5 as a picture, while pages 9 and 11 had the words) ALWAYS the first six pages too, eight at most.
// A results table that is a picture or a poor scan has no words to find, and it is nearly always among the first pages.
export function pickPages(pages) {
  const set = new Set(pages.map((t, i) => ({ i, s: kwScore(t) })).filter(x => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, 4).map(x => x.i));
  for (let i = 0; i < pages.length && i < 6 && set.size < 8; i++) set.add(i);
  return [...set].sort((a, b) => a - b);
}
// (v3, 18 Nov 2026) one page read by OCR — free, and only when needed: a results table that is a picture inside a "text" PDF,
// a PDF whose own text is unreadable, or a scan that the first OCR pass read poorly. dpi 220 / 300; mode 6 = one block of text,
// mode 4 = columns of text. Each reading is one more WITNESS of what is printed: a number counts when any witness shows it
// in its own row.
export async function ocrPage(dir, file, i, dpi = 300, psm = 6) {
  const pre = join(dir, `o${i + 1}-${dpi}`);
  try { await sh("pdftoppm", ["-r", String(dpi), "-gray", "-png", "-f", String(i + 1), "-l", String(i + 1), "-singlefile", file, pre]);
    return await sh("tesseract", [pre + ".png", "-", "--psm", String(psm)]); } catch (e) { return ""; }
}
// a number as printed (1,23,456.78 / (123.45) / -12) → is it on this page?
const numForms = v => { const a = Math.abs(+v); return [...new Set([String(a), a.toFixed(2), a.toFixed(1), a.toFixed(0)].filter(f => Math.abs(+f - a) < 1e-9))].map(f => new RegExp(`(?<![\\d.])${f.replace(".", "\\.")}(?![\\d])`)); };
export function onPage(v, text) {
  if (v == null || !isFinite(+v)) return false;
  const t = String(text || "").replace(/(\d),(?=\d)/g, "$1");                 // 1,23,456.78 → 123456.78
  return numForms(v).some(re => re.test(t));
}
// …and is it in the right ROW? (pilot, 16 Nov 2026: a scanned PDF gave "total income" as sales — the number was on the page,
// but in another row). The line holding the number (or the line just above / below it, for labels that wrap) must carry the
// row's own label. [accepted label, refused label]
const ROW = {
  // (v3) finance companies print "Total revenue from operations" (interest + fees + …) and then "Other income" → "Total income";
  // a highlights table says "Revenues" / "Operating income", "PBT", "PAT" (seen 18 Nov 2026) — the arithmetic still has to hold
  revenue: [/(revenue|income) from operation|net sales|sales|turnover|operating (income|revenue)|^\W*(\w{1,3}[.)]\s*)?(net )?revenues?\W*$/i, /total (?!revenue from operation)|other|margin/i],
  other_income: [/other income/i], total_income: [/total (revenue|income)|total income from operation/i, /total revenue from operation/i],
  total_expenses: [/total\W{0,3}expen/i], finance_costs: [/finance (cost|expense|charge)|interest/i], depreciation: [/depreciation|amorti[sz]ation/i],
  exceptional: [/exceptional/i, /before|after/i], share_associates: [/share (of|in) .{0,24}(profit|loss|result)|associate|joint venture/i, /before|after|attributable|total/i],
  pbt: [/before tax|\bPBT\b/i, /exceptional items and tax|before exceptional|before share|margin/i],
  tax: [/tax/i, /before tax|after tax/i], net_profit: [/profit|loss|\bPAT\b/i, /before tax|exceptional|discontinued|comprehensive|attributable|margin|\bPBT\b/i], eps_basic: [/basic|earnings? per share|eps/i] };
// where is this number on the page, and is that line the right row?
//   → { ok, label: the row's own words, dec: decimals as printed, near: the labels of other rows holding the number, or "absent" }
export function rowHit(v, text, field) {
  if (v == null || !isFinite(+v)) return { ok: false, near: "absent" };
  const r = ROW[field], L = String(text || "").split(/\r?\n/).map(l => l.replace(/(\d),(?=\d)/g, "$1")), forms = numForms(v), near = [];
  const lab = l => String(l || "").replace(/[-\d.,()\s]+$/g, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < L.length; i++) { let m = null; for (const re of forms) { m = re.exec(L[i]); if (m) break; } if (!m) continue;
    const tail = /^\.(\d+)/.exec(L[i].slice(m.index + m[0].length)), dec = Math.min(4, ((m[0].split(".")[1] || "").length) + (tail ? tail[1].length : 0));
    if (!r) return { ok: true, label: lab(L[i]).slice(0, 48), dec };
    const own = lab(L[i]), ks = /[a-z]{3}/i.test(own) ? [i] : [i - 1, i + 1];        // a label of its own decides; neighbours only when it wrapped
    for (const k of ks) { const t = lab(L[k] || ""); if (r[0].test(t) && !(r[1] && r[1].test(t))) return { ok: true, label: t.slice(0, 48), dec }; }
    if (near.length < 2) near.push((own || lab(L[i - 1] || "")).slice(0, 48)); }
  return { ok: false, near: near.length ? near : "absent" };
}
export function onRow(v, text, field) { return rowHit(v, text, field).ok; }
// ₹ crore per printed unit; null when the unit is not clear (then nothing is shown)
export function unitFactor(u) {
  const s = String(u || "").toLowerCase();
  if (/lakh|lac/.test(s)) return 0.01; if (/crore|\bcr\b/.test(s)) return 1; if (/million|mn\b/.test(s)) return 0.1;
  if (/thousand|'000|000s|in 000/.test(s)) return 1e-4; if (/rupees|rs\.?$|inr$|₹$/.test(s.trim())) return 1e-7; return null;
}
const FIELDS = ["revenue", "other_income", "total_income", "total_expenses", "finance_costs", "depreciation", "exceptional", "share_associates", "pbt", "tax", "net_profit", "eps_basic"];
const KEYF = ["revenue", "total_income", "total_expenses", "pbt", "tax", "net_profit"];
function colHits(c, txt) {
  const on = {}, rows = {}, miss = {}; let n = 0, dec = 0;
  for (const f of FIELDS) { if (c[f] == null) continue; const h = rowHit(c[f], txt, f); on[f] = h.ok;
    if (h.ok) { n++; if (KEYF.includes(f)) rows[f] = h.label; if (f !== "eps_basic" && h.dec > dec) dec = h.dec; } else miss[f] = h.near; }
  return { on, rows, miss, n, dec };
}
// (v3, accuracy first) the totals must add up to ROUNDING — half a unit of the last printed decimal per number — not "within
// 1.5": on a small company's table 1.5 lakh is a large error. A gap between income − expenses and profit before tax must be
// explained by a line found in its own row: exceptional items, the share of associates' profit, or an expenses total printed
// before finance costs and depreciation.
export function sumsOf(c, on, d) {
  const v = k => (c[k] == null || !isFinite(+c[k])) ? null : +c[k], has = k => v(k) != null && !!on[k];
  const nr = (x, y, n) => Math.abs(x - y) <= 0.5 * n * Math.pow(10, -d) + 1e-9;
  const out = { income: v("total_income") == null || v("revenue") == null ? null : nr(v("revenue") + (v("other_income") || 0), v("total_income"), 3), pbt: null, np: null };
  if (v("total_income") != null && v("total_expenses") != null && v("pbt") != null) {
    const base = v("total_income") - v("total_expenses"), P = v("pbt"), ex = has("exceptional") ? v("exceptional") : null, sh = has("share_associates") ? v("share_associates") : null,
      fd = has("finance_costs") && has("depreciation") ? v("finance_costs") + v("depreciation") : null, T = [["", base, 3]];
    if (ex != null) T.push(["x", base + ex, 4], ["x", base - ex, 4]);
    if (sh != null) T.push(["s", base + sh, 4]);
    if (ex != null && sh != null) T.push(["xs", base + ex + sh, 5], ["xs", base - ex + sh, 5]);
    if (fd != null) { T.push(["fd", base - fd, 5]); if (ex != null) T.push(["fdx", base - fd + ex, 6], ["fdx", base - fd - ex, 6]); }
    const hit = T.find(t => nr(t[1], P, t[2])); out.pbt = !!hit; if (hit && hit[0]) out.pbtHow = hit[0];
  }
  if (v("pbt") != null && v("tax") != null && v("net_profit") != null) {
    const base = v("pbt") - v("tax"), N = v("net_profit"), sh = has("share_associates") ? v("share_associates") : null, T = [["", base, 3]]; if (sh != null) T.push(["s", base + sh, 4]);
    const hit = T.find(t => nr(t[1], N, t[2])); out.np = !!hit; if (hit && hit[0]) out.npHow = hit[0];
  }
  return out;
}
// pageOf(n) = the text of attached page n as the reader gave it; cands (optional) = [{ p, text }] every attached page: a column
// whose numbers are not on its stated page is looked for on the others — the whole column on ONE page.
export function check(statements, pageOf, cands) {
  let found = 0, total = 0, cols = 0, okCols = 0;
  for (const s of statements || []) {
    s.factor = unitFactor(s.unit);
    const hits = [];
    for (const c of s.columns || []) {
      const need = FIELDS.filter(f => c[f] != null).length; let best = colHits(c, pageOf(c.page)), at = null;
      if (best.n < need && cands) for (const k of cands) { const r = colHits(c, k.text); if (r.n > best.n) { best = r; at = k.p; } }
      if (at != null) c.page = at;
      hits.push(best); total += need; found += best.n;
    }
    const vals = (s.columns || []).flatMap(c => FIELDS.filter(f => f !== "eps_basic" && c[f] != null).map(f => { const t = String(c[f]), i = t.indexOf("."); return i < 0 ? 0 : t.length - i - 1; }));
    const d = Math.min(4, Math.max(0, ...hits.map(h => h.dec), ...vals));           // decimals as printed in this table
    (s.columns || []).forEach((c, i) => { const h = hits[i]; c.onPage = h.on; c.rows = h.rows; if (Object.keys(h.miss).length) c.miss = h.miss; else delete c.miss;
      c.sums = sumsOf(c, h.on, d);
      // a statement called consolidated must say so on its page (a standalone table must never be shown as consolidated)
      const bOk = !/^cons/i.test(String(s.basis || "")) || /consolidated/i.test(cands ? (cands.find(k => k.p === c.page) || { text: pageOf(c.page) }).text : pageOf(c.page));
      // shown only when sales, total income and profit are each in their own row on the page, sales + other income = total
      // income, no other total disagrees and the unit is clear
      c.ok = !!(s.factor && bOk && h.on.revenue && h.on.total_income && h.on.net_profit && c.sums.income === true && c.sums.np !== false && c.sums.pbt !== false);
      if (c.sums.pbtHow && /^fd/.test(c.sums.pbtHow)) c.teEx = 1; else delete c.teEx;      // "total expenses" printed before finance costs and depreciation
      c.why = c.ok ? undefined : !s.factor ? "unit" : !bOk ? "basis" : c.revenue == null ? "no sales" : !h.on.revenue ? "sales row" : c.total_income == null ? "no total income" : !h.on.total_income ? "total income row"
        : c.net_profit == null ? "no profit" : !h.on.net_profit ? "profit row" : c.sums.income !== true ? "income sum" : c.sums.pbt === false ? "pbt sum" : "profit sum";
      if (c.why === undefined) delete c.why; cols++; if (c.ok) okCols++; });
    s.dec = d;
  }
  return { found, total, cols, ok: okCols };
}
const SYSTEM = "You read the financial results PDFs of Indian listed companies. Answer with JSON only. Copy every number exactly as printed in the table (same unit, same decimals, no conversion, no rounding); write negatives / numbers in brackets with a minus sign; never guess — use null when a line is not printed.";
const prompt = (co, pages) => `The attached document holds pages ${pages.map(p => p + 1).join(", ")} of the results PDF of ${co.name} (BSE code ${co.scrip}), in that order.
Find the statement(s) of financial results (profit and loss). For EACH statement present (standalone and/or consolidated) return every column of the table (this quarter, previous quarter, same quarter last year, half-years, year):
{"statements":[{"basis":"standalone"|"consolidated","unit":"exactly as printed, e.g. Rs. in Lakhs","columns":[{"label":"as printed","end":"YYYY-MM-DD","months":3|6|9|12,"page":<position of the page in the ATTACHED document: 1 = its first page>,"revenue":n,"other_income":n,"total_income":n,"total_expenses":n,"finance_costs":n,"depreciation":n,"exceptional":n,"share_associates":n,"pbt":n,"tax":n,"net_profit":n,"eps_basic":n}]}]}
revenue = revenue from operations (or income from operations; for a finance company "total revenue from operations"); total_income = revenue + other income, as printed; total_expenses = the "total expenses" line as printed; exceptional = exceptional items (null if none); share_associates = share of profit/(loss) of associates and joint ventures (null if none); pbt = profit before tax (after exceptional items); tax = total tax expense; net_profit = profit for the period after tax; eps_basic = basic EPS in rupees. If there is no results table (for example a press release or a newspaper extract), answer {"statements":[]}.`;
// the picked pages for the reader: one small PDF; when the PDF cannot be cut (protected or damaged — seen 18 Nov 2026), its
// pages are drawn again, and as a last resort sent as pictures
export async function attach(dir, file, pick) {
  const one = async (p, tool) => { const out = join(dir, `s-${p + 1}.pdf`);
    if (tool === "cut") await sh("pdfseparate", ["-f", String(p + 1), "-l", String(p + 1), file, join(dir, "s-%d.pdf")]); else await sh("pdftocairo", ["-pdf", "-f", String(p + 1), "-l", String(p + 1), file, out]);
    return out; };
  for (const tool of ["cut", "draw"]) {
    try { const parts = []; for (const p of pick) parts.push(await one(p, tool));
      const sub = join(dir, "sub.pdf"); if (parts.length > 1) await sh("pdfunite", [...parts, sub]); else await writeFile(sub, await readFile(parts[0]));
      return [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: (await readFile(sub)).toString("base64") } }]; } catch (e) {}
  }
  const out = []; for (const p of pick) { const pre = join(dir, `i-${p + 1}`); await sh("pdftoppm", ["-r", "130", "-png", "-f", String(p + 1), "-l", String(p + 1), "-singlefile", file, pre]);
    out.push({ type: "image", source: { type: "base64", media_type: "image/png", data: (await readFile(pre + ".png")).toString("base64") } }); }
  return out;
}
export const RV = 5;                                    // version of the reader's checks (older readings are read again once)

async function main() {
  if (!KEY || !CKEY) { log("Pilot: TREX_KEY or ANTHROPIC_API_KEY missing — nothing done."); return; }
  const until = Date.now() + Math.max(3, +(process.env.TREX_BSEPILOT_MINUTES || 22)) * 60e3;      // the job has 30 minutes: no new PDF after this
  // first the PDFs read by an older version of these checks (read again), then new ones
  const re = await trex("bsepdfs", "&redo=1&n=" + N).then(r => r.json()).catch(() => ({ rows: [] }));
  const tg = await trex("bsepdfs", "&n=" + N).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!tg.ok) { log("Pilot: could not get the list from T-Rex: " + (tg.error || "?")); process.exitCode = 1; return; }
  tg.rows = [...(re.rows || []), ...tg.rows];
  let spent = +tg.spent || 0, spentM = +tg.spentMonth || 0; log(`BSE PDFs: ${tg.rows.length} to read; spent so far $${spent.toFixed(4)} of $${CAP}${MCAP ? `, this month $${spentM.toFixed(4)} of $${MCAP}` : ""}.`);
  const st = {}; let k = 0, docs = 0, passed = 0;
  for (const co of tg.rows) {
    k++; if (spent >= CAP - 0.05 || (MCAP && spentM >= MCAP - 0.05)) { log(`BSE PDFs: budget reached ($${spent.toFixed(4)} in total, $${spentM.toFixed(4)} this month) — stopping.`); break; }
    if (Date.now() > until) { log(`BSE PDFs: time is up — ${tg.rows.length - k + 1} left for the next run.`); break; }
    const dir = await mkdtemp(join(tmpdir(), "bsep-")); const id = `doc ${k}`, c0 = st.cost || 0; let counted = false;
    try {
      const got = await getPdf(co.pdf); if (!got) { log(`  ${id}: could not download`); await trex("bsefig", "", { scrip: co.scrip, pdf: co.pdf, ok: false, cost: 0, data: { rv: RV, arv: RV, err: "download failed", again: 1 } }); continue; }
      const file = join(dir, "a.pdf"); await writeFile(file, got.b);
      const { pages, ocr } = await pageTexts(dir, file, +((await sh("pdfinfo", [file]).catch(() => "")).match(/Pages:\s+(\d+)/) || [0, 0])[1] || 0), nPages = pages.length;
      const texts = pages.map(t => [t || ""]), joined = i => (texts[i] || []).filter(Boolean).join("\n");       // per page: the PDF's own text, then OCR readings
      // (v3) no page of the PDF's own text shows a results table (it is a picture, or the text is unreadable): pages 7–14 are
      // read by OCR as well, to find a table further back (the first six pages are always shown to the reader)
      if (!pages.some(t => kwScore(t) >= 2)) for (let i = 6; i < Math.min(nPages, 14) && Date.now() < until; i++) { if (ocr.includes(i + 1)) continue;
        const t = await ocrPage(dir, file, i, 220, 6); if (t.replace(/\s+/g, "").length > 50) { texts[i].push(t); ocr.push(i + 1); } }
      const pick = pickPages(texts.map((_, i) => joined(i)));
      const doc = await attach(dir, file, pick);
      const ans = await askClaude(fetch, CKEY, SYSTEM, [...doc, { type: "text", text: prompt(co, pick) }], null, st);
      const cost = (st.cost || 0) - c0; spent += cost; spentM += cost; counted = true;
      let j = null; try { j = JSON.parse(String(ans.text).replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { j = salvageJson(ans.text); }
      const statements = (j && Array.isArray(j.statements)) ? j.statements.slice(0, 4) : [];
      const at = n => pick[Math.max(0, Math.min(pick.length - 1, Math.round(+n || 1) - 1))] ?? 0;
      const pageOf = n => joined(at(n)), cands = () => pick.map((p, x) => ({ p: x + 1, text: joined(p) }));
      let ck = check(statements, pageOf, cands()); const wit = [];
      // a key number not found in its row: the attached pages are read again by OCR (sharper, then as columns) — more witnesses
      // of what is printed, never a looser check
      for (const [dpi, psm] of [[300, 6], [300, 4]]) {
        if (Date.now() > until || !statements.some(s => (s.columns || []).some(c => !c.ok && c.miss && KEYF.some(f => c.miss[f])))) break;
        const need = new Set(statements.flatMap(s => (s.columns || []).filter(c => !c.ok).map(c => at(c.page))));       // the pages those columns are on
        for (const p of need) { const t = await ocrPage(dir, file, p, dpi, psm); if (t) texts[p].push(t); }
        wit.push(dpi + "/" + psm); ck = check(statements, pageOf, cands());
      }
      for (const s of statements) for (const c of s.columns || []) c.page = at(c.page) + 1;   // page of the original PDF
      const ok = statements.some(s => (s.columns || []).some(c => c.ok));
      await trex("bsefig", "", { scrip: co.scrip, pdf: co.pdf, model: ans.model, cost, ok, data: { rv: RV, via: got.via, pages: nPages, read: pick.map(p => p + 1), ocr, wit, statements, found: ck.found, numbers: ck.total, cols: ck.cols, okCols: ck.ok } });
      docs++; if (ok) passed++;
      log(`  ${id}: ${nPages} pages (${ocr.length ? "scanned / pictures, read by OCR" : "text"}), ${statements.length} statement(s), ${ck.found} of ${ck.total} numbers found in their rows, ${ck.ok} of ${ck.cols} columns passed${wit.length ? ` (read again by OCR ${wit.length}×)` : ""} — $${cost.toFixed(4)}`);
    } catch (e) { const cost = Math.max(0, (st.cost || 0) - c0); if (!counted) { spent += cost; spentM += cost; }
      log(`  ${id}: ${String(e.message || e).replace(/https?:\/\/\S+/g, "[link]").slice(0, 140)}`); if (e.fatal) break;
      // a read that failed (busy, no answer…): its cost is counted and T-Rex offers the PDF again — three tries at most
      try { await trex("bsefig", "", { scrip: co.scrip, pdf: co.pdf, ok: false, cost, data: { rv: RV, arv: RV, err: "reading failed", again: 1 } }); } catch (x) {} }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  log(`Pilot: done — ${passed} of ${docs} PDFs gave figures that passed every check. Spent this run $${(st.cost || 0).toFixed(4)}; in total about $${spent.toFixed(4)} of $${CAP}.`);
}
if (process.argv[1] && process.argv[1].endsWith("bsepilot.mjs")) main();
