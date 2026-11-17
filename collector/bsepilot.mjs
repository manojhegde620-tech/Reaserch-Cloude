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
// page texts: the PDF's own text; pages without text (scans) are read by OCR
async function pageTexts(dir, file, nPages) {
  let pages = []; try { pages = await pdfTextPoppler(await readFile(file)); } catch (e) {}
  while (pages.length < nPages) pages.push("");
  const ocr = [];
  for (let i = 0; i < Math.min(nPages, 12); i++) {
    if ((pages[i] || "").replace(/\s+/g, "").length >= 300) continue;
    try { const pre = join(dir, "p" + (i + 1)); await sh("pdftoppm", ["-r", "220", "-gray", "-png", "-f", String(i + 1), "-l", String(i + 1), "-singlefile", file, pre]);
      pages[i] = await sh("tesseract", [pre + ".png", "-", "--psm", "6"]); ocr.push(i + 1); } catch (e) {}
  }
  return { pages, ocr };
}
const KW = /revenue from operations|income from operations|total income|profit before tax|net profit|total expenses|profit \/ ?\(loss\)|earnings per share/gi;
export function pickPages(pages) {
  const sc = pages.map((t, i) => ({ i, s: (String(t).match(KW) || []).length })).filter(x => x.s >= 2).sort((a, b) => b.s - a.s).slice(0, 4).map(x => x.i).sort((a, b) => a - b);
  return sc.length ? sc : pages.slice(0, 6).map((_, i) => i);
}
// a number as printed (1,23,456.78 / (123.45) / -12) → is it on this page?
export function onPage(v, text) {
  if (v == null || !isFinite(+v)) return false;
  const a = Math.abs(+v), t = String(text || "").replace(/(\d),(?=\d)/g, "$1");                 // 1,23,456.78 → 123456.78
  const forms = new Set([String(a), a.toFixed(2), a.toFixed(1), a.toFixed(0)].filter(f => +f === a || Math.abs(+f - a) < 1e-9));
  return [...forms].some(f => new RegExp(`(?<![\\d.])${f.replace(".", "\\.")}(?![\\d])`).test(t));
}
// …and is it in the right ROW? (pilot, 16 Nov 2026: a scanned PDF gave "total income" as sales — the number was on the page,
// but in another row). The line holding the number (or the line just above / below it, for labels that wrap) must carry the
// row's own label.
const ROW = { revenue: [/(revenue|income) from operation|net sales|sales|turnover/i, /total|other/i], other_income: [/other income/i], total_income: [/total (revenue|income)|total income from operation/i],
  total_expenses: [/total expen/i], finance_costs: [/finance cost|interest/i], depreciation: [/depreciation|amorti[sz]ation/i], pbt: [/before tax/i, /exceptional items and tax|before exceptional/i],
  tax: [/tax/i, /before tax|after tax/i], net_profit: [/profit|loss/i, /before tax|exceptional|discontinued|comprehensive|attributable/i], eps_basic: [/basic|earnings? per share|eps/i] };
export function onRow(v, text, field) {
  if (!onPage(v, text)) return false; const r = ROW[field]; if (!r) return true;
  const L = String(text || "").split(/\r?\n/).map(l => l.replace(/(\d),(?=\d)/g, "$1")), a = Math.abs(+v);
  const forms = [String(a), a.toFixed(2), a.toFixed(1), a.toFixed(0)].filter(f => Math.abs(+f - a) < 1e-9).map(f => new RegExp(`(?<![\\d.])${f.replace(".", "\\.")}(?![\\d])`));
  const lab = l => l.replace(/[-\d.,()\s]+$/g, " ");
  for (let i = 0; i < L.length; i++) { if (!forms.some(re => re.test(L[i]))) continue;
    const own = lab(L[i]), ks = /[a-z]{3}/i.test(own) ? [i] : [i - 1, i + 1];        // a label of its own decides; neighbours only when it wrapped
    for (const k of ks) { const t = lab(L[k] || ""); if (r[0].test(t) && !(r[1] && r[1].test(t))) return true; } }
  return false;
}
// ₹ crore per printed unit; null when the unit is not clear (then nothing is shown)
export function unitFactor(u) {
  const s = String(u || "").toLowerCase();
  if (/lakh|lac/.test(s)) return 0.01; if (/crore|\bcr\b/.test(s)) return 1; if (/million|mn\b/.test(s)) return 0.1;
  if (/thousand|'000|000s|in 000/.test(s)) return 1e-4; if (/rupees|rs\.?$|inr$|₹$/.test(s.trim())) return 1e-7; return null;
}
const FIELDS = ["revenue", "other_income", "total_income", "total_expenses", "finance_costs", "depreciation", "pbt", "tax", "net_profit", "eps_basic"];
export function check(statements, pageOf) {
  let found = 0, total = 0;
  for (const s of statements || []) {
    s.factor = unitFactor(s.unit);
    for (const c of s.columns || []) {
      const txt = pageOf(c.page); c.onPage = {};
      for (const f of FIELDS) { if (c[f] == null) continue; total++; c.onPage[f] = onRow(c[f], txt, f); if (c.onPage[f]) found++; }
      const near = (x, y) => x != null && y != null && Math.abs(x - y) <= Math.max(1.5, Math.abs(y) * 0.003);
      c.sums = { income: c.total_income == null || c.revenue == null ? null : near((+c.revenue) + (+c.other_income || 0), +c.total_income),
        pbt: c.total_income == null || c.total_expenses == null || c.pbt == null ? null : near(+c.total_income - +c.total_expenses, +c.pbt),
        np: c.pbt == null || c.tax == null || c.net_profit == null ? null : near(+c.pbt - +c.tax, +c.net_profit) };
      // shown only when sales, total income and profit are each in their own row on the page, sales + other income = total
      // income, no other total disagrees and the unit is clear
      c.ok = !!(s.factor && c.onPage.revenue && c.onPage.total_income && c.onPage.net_profit && c.sums.income === true && c.sums.np !== false && c.sums.pbt !== false);
    }
  }
  return { found, total };
}
const SYSTEM = "You read the financial results PDFs of Indian listed companies. Answer with JSON only. Copy every number exactly as printed in the table (same unit, no conversion, no rounding); write negatives / numbers in brackets with a minus sign; never guess — use null when a line is not printed.";
const prompt = (co, pages) => `The attached document holds pages ${pages.map(p => p + 1).join(", ")} of the results PDF of ${co.name} (BSE code ${co.scrip}), in that order.
Find the statement(s) of financial results (profit and loss). For EACH statement present (standalone and/or consolidated) return every column of the table (this quarter, previous quarter, same quarter last year, half-years, year):
{"statements":[{"basis":"standalone"|"consolidated","unit":"exactly as printed, e.g. Rs. in Lakhs","columns":[{"label":"as printed","end":"YYYY-MM-DD","months":3|6|9|12,"page":<1-based page of the ATTACHED document>,"revenue":n,"other_income":n,"total_income":n,"total_expenses":n,"finance_costs":n,"depreciation":n,"pbt":n,"tax":n,"net_profit":n,"eps_basic":n}]}]}
revenue = revenue from operations (or income from operations); pbt = profit before tax; tax = total tax expense; net_profit = profit for the period after tax; eps_basic = basic EPS in rupees. If there is no results table, answer {"statements":[]}.`;

async function main() {
  if (!KEY || !CKEY) { log("Pilot: TREX_KEY or ANTHROPIC_API_KEY missing — nothing done."); return; }
  // first the PDFs read by an older version of these checks (read again), then new ones
  const re = await trex("bsepdfs", "&redo=1&n=" + N).then(r => r.json()).catch(() => ({ rows: [] }));
  const tg = await trex("bsepdfs", "&n=" + N).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!tg.ok) { log("Pilot: could not get the list from T-Rex: " + (tg.error || "?")); process.exitCode = 1; return; }
  tg.rows = [...(re.rows || []), ...tg.rows];
  let spent = +tg.spent || 0, spentM = +tg.spentMonth || 0; log(`BSE PDFs: ${tg.rows.length} to read; spent so far $${spent.toFixed(4)} of $${CAP}${MCAP ? `, this month $${spentM.toFixed(4)} of $${MCAP}` : ""}.`);
  const st = {}; let k = 0;
  for (const co of tg.rows) {
    k++; if (spent >= CAP - 0.05 || (MCAP && spentM >= MCAP - 0.05)) { log(`BSE PDFs: budget reached ($${spent.toFixed(4)} in total, $${spentM.toFixed(4)} this month) — stopping.`); break; }
    const dir = await mkdtemp(join(tmpdir(), "bsep-")); const id = `doc ${k}`;
    try {
      const got = await getPdf(co.pdf); if (!got) { log(`  ${id}: could not download`); await trex("bsefig", "", { scrip: co.scrip, pdf: co.pdf, ok: false, cost: 0, data: { err: "download failed" } }); continue; }
      const file = join(dir, "a.pdf"); await writeFile(file, got.b);
      const nPages = +((await sh("pdfinfo", [file]).catch(() => "")).match(/Pages:\s+(\d+)/) || [0, 0])[1] || 1;
      const { pages, ocr } = await pageTexts(dir, file, nPages);
      const pick = pickPages(pages);
      const parts = []; for (const p of pick) { await sh("pdfseparate", ["-f", String(p + 1), "-l", String(p + 1), file, join(dir, "s-%d.pdf")]); parts.push(join(dir, `s-${p + 1}.pdf`)); }
      const sub = join(dir, "sub.pdf"); if (parts.length > 1) await sh("pdfunite", [...parts, sub]); else await writeFile(sub, await readFile(parts[0]));
      const c0 = st.cost || 0;
      const ans = await askClaude(fetch, CKEY, SYSTEM, [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: (await readFile(sub)).toString("base64") } }, { type: "text", text: prompt(co, pick) }], null, st);
      const cost = (st.cost || 0) - c0; spent += cost; spentM += cost;
      let j = null; try { j = JSON.parse(String(ans.text).replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { j = salvageJson(ans.text); }
      const statements = (j && Array.isArray(j.statements)) ? j.statements.slice(0, 4) : [];
      const pageOf = n => pages[pick[Math.max(0, Math.min(pick.length - 1, Math.round(+n || 1) - 1))]] || "";
      const ck = check(statements, pageOf);
      for (const s of statements) for (const c of s.columns || []) c.page = (pick[Math.max(0, Math.min(pick.length - 1, Math.round(+c.page || 1) - 1))] ?? 0) + 1;   // page of the original PDF
      const ok = statements.some(s => (s.columns || []).some(c => c.ok));
      await trex("bsefig", "", { scrip: co.scrip, pdf: co.pdf, model: ans.model, cost, ok, data: { rv: 2, via: got.via, pages: nPages, read: pick.map(p => p + 1), ocr, statements, found: ck.found, numbers: ck.total } });
      log(`  ${id}: ${nPages} pages (${ocr.length ? "scanned, read by OCR" : "text"}), ${statements.length} statement(s), ${ck.found} of ${ck.total} numbers found on the page — $${cost.toFixed(4)}`);
    } catch (e) { log(`  ${id}: ${String(e.message || e).slice(0, 140)}`); if (e.fatal) break; }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  log(`Pilot: done. Spent this run $${(st.cost || 0).toFixed(4)}; in total about $${spent.toFixed(4)} of $${CAP}.`);
}
if (process.argv[1] && process.argv[1].endsWith("bsepilot.mjs")) main();
