// T-Rex · RESTATED QUARTERS OF RESTRUCTURED COMPANIES (owner's option B, 18 Nov 2026 — HEG Advanced Materials: its graphite
// business was demerged and Bhilwara Energy merged in; the company restated its earlier quarters, but NSE's data file carries
// only the current quarter, so T-Rex compared the new company with the old one's filings).
//   1. T-Rex lists the restructured filings whose restated year-ago (and previous) quarter it still needs (rstargets).
//   2. The company's own Results PDF on NSE is downloaded; its text comes from the PDF itself.
//   3. Claude reads the profit-and-loss statement of the right basis (consolidated / standalone), copying every number as printed.
//   4. Every number must be in its OWN row on the page and the totals must add up; the statement's current quarter must equal
//      the company's NSE filing (proof that it is the right table, basis and unit) — T-Rex checks that again before keeping it.
//   5. The checked figures go to T-Rex (rsfig). Nothing is saved on GitHub; this public log shows no company names or numbers.
// Hard caps: TREX_RS_BUDGET_USD in total and TREX_RS_MONTH_USD a month, counted by T-Rex across all runs.
import { execFile } from "node:child_process";
import { writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import { askClaude, salvageJson } from "./insights.mjs";
import { pageTexts, onPage, unitFactor, readPdf } from "./bsepilot.mjs";

const server = (process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
const KEY = process.env.TREX_KEY || "", CKEY = process.env.ANTHROPIC_API_KEY || "";
const CAP = +(process.env.TREX_RS_BUDGET_USD || 0), MCAP = +(process.env.TREX_RS_MONTH_USD || 0), N = Math.min(40, Math.max(1, +(process.env.TREX_RS_N || 20)));
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const log = (...a) => console.log(...a);
const sh = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, timeout: 180000 }, (e, out) => e ? rej(e) : res(String(out))));
const trex = (action, qs = "", body) => fetch(`${server}/api/collect?action=${action}${qs}`, { method: "POST", headers: { "x-trex-key": KEY, ...(body ? { "x-trex-gz": "1" } : {}) },
  body: body ? gzipSync(JSON.stringify(body)) : undefined, signal: AbortSignal.timeout(90000) });
const isPdf = b => b && b.length > 1000 && b.subarray(0, 5).toString() === "%PDF-";
const qeAdd = (qe, months) => { let [y, m] = qe.split("-").map(Number); m += months; while (m <= 0) { m += 12; y--; } while (m > 12) { m -= 12; y++; }
  return `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`; };

// NSE's archive answers with its own link (nseindia.com or .in — the same file); curl with a browser's headers, then the other host
async function getNsePdf(u) {
  const alt = /nseindia\.in\//.test(u) ? u.replace("nseindia.in/", "nseindia.com/") : u.replace("nseindia.com/", "nseindia.in/");
  for (const url of [u, alt]) {
    const tmp = join(tmpdir(), "rsr-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".pdf");
    try { await sh("curl", ["-sSL", "--max-time", "90", "-A", UA, "-e", REF, "-H", "Accept: application/pdf,*/*", "-o", tmp, url]); const b = await readFile(tmp); if (isPdf(b)) return b; } catch (e) {}
    finally { await rm(tmp, { force: true }).catch(() => {}); }
  }
  return null;
}

// the pages holding the profit-and-loss statement of the wanted basis
const KW = /revenue from operations|income from operations|total income|profit before tax|total expenses|earnings per share|discontinued operation/gi;
export function rsPick(pages, basis) {
  const want = basis === "S" ? /standalone/i : /consolidated/i, other = basis === "S" ? /consolidated/i : /standalone/i;
  const sc = pages.map((t, i) => { const s = String(t || ""), k = (s.match(KW) || []).length; return { i, s: k < 3 ? 0 : k + (want.test(s) ? 8 : 0) - (other.test(s) && !want.test(s) ? 6 : 0) }; })
    .filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.i).sort((a, b) => a - b);
  return sc;
}

// is the number in the right ROW? The line holding it carries the row's label — or, when the label wrapped onto the line
// above, the two lines together (seen on HEG's PDF: "…from continuing and discontinued / operations (X + XI) 306.07")
const ROW = {
  revenue: [/revenue from operation|income from operation|net sales|\bsales\b|turnover/i, /total|other income|discontinued/i],
  other_income: [/other income/i, /total/i], total_income: [/total (income|revenue)/i, /comprehensive/i], total_expenses: [/total expen/i, /discontinued/i],
  finance_costs: [/finance cost|interest/i, /discontinued/i], depreciation: [/depreciation|amorti[sz]ation/i, /discontinued/i],
  pbt: [/before tax/i, /exceptional items and tax|before exceptional|discontinued operations? before|from discontinued/i],
  tax: [/tax/i, /before tax|after tax|discontinued|deferred|current tax|earlier years|re-?measurement|relating/i],
  np_cont: [/continuing operation/i, /before tax|discontinued/i], np_disc: [/discontinued operation/i, /before tax|tax expense|tax credit|revenue|income|expenses|comprehensive/i],
  net_profit: [/profit|loss/i, /before tax|comprehensive|attributable|non.?controlling|share of|owners/i], np_owners: [/owners|equity holders|shareholders of/i, /non.?controlling|comprehensive/i],
  eps_basic: [/basic|earnings? per share|\beps\b/i, /diluted/i] };
export function onRowR(v, text, field) {
  if (!onPage(v, text)) return false; const r = ROW[field]; if (!r) return true;
  const L = String(text || "").split(/\r?\n/).map(l => l.replace(/(\d),(?=\d)/g, "$1")), a = Math.abs(+v);
  const forms = [String(a), a.toFixed(2), a.toFixed(1), a.toFixed(0)].filter(f => Math.abs(+f - a) < 1e-9).map(f => new RegExp(`(?<![\\d.])${f.replace(".", "\\.")}(?![\\d])`));
  const lab = l => String(l || "").replace(/[-\d.,()\s]+$/g, " ");
  const fits = t => r[0].test(t) && !(r[1] && r[1].test(t));
  for (let i = 0; i < L.length; i++) { if (!forms.some(re => re.test(L[i]))) continue;
    const own = lab(L[i]); if (fits(own) || fits(lab(L[i - 1]) + " " + own) || (!/[a-z]{3}/i.test(own) && (fits(lab(L[i - 1])) || fits(lab(L[i + 1]))))) return true; }
  return false;
}
const F_ALL = ["revenue", "other_income", "total_income", "total_expenses", "finance_costs", "depreciation", "pbt", "tax", "np_cont", "np_disc", "net_profit", "np_owners", "eps_basic"];
// checks one statement → the current quarter (for T-Rex's anchor) and the restated columns in ₹ crore, keyed for T-Rex
export function rsCheck(st, pageOf, qe) {
  const f = unitFactor(st && st.unit), out = { factor: f, cols: [], cur: null, found: 0, total: 0 };
  if (!st || !f) return out;
  const near = (x, y) => x != null && y != null && Math.abs(x - y) <= Math.max(1.5, Math.abs(y) * 0.003);
  for (const c of st.columns || []) {
    const txt = pageOf(c.page), ok = {}; for (const k of F_ALL) { if (c[k] == null) continue; out.total++; ok[k] = onRowR(+c[k], txt, k); if (ok[k]) out.found++; }
    const v = k => c[k] == null || c[k] === "" || !isFinite(+c[k]) ? null : +c[k];
    const sums = { income: v("total_income") == null || v("revenue") == null ? null : near(v("revenue") + (v("other_income") || 0), v("total_income")),
      cont: v("np_cont") == null || v("pbt") == null || v("tax") == null ? null : near(v("pbt") - v("tax"), v("np_cont")),
      total: v("net_profit") == null || v("np_cont") == null ? null : near(v("np_cont") + (v("np_disc") || 0), v("net_profit")) };
    const good = !!(ok.revenue && ok.total_income && ok.net_profit && sums.income === true && sums.cont !== false && sums.total !== false && (v("np_cont") == null || ok.np_cont) && (v("np_disc") == null || ok.np_disc));
    const end = String(c.end || ""), m = +c.months || null; if (!good || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    const cr = k => v(k) == null ? null : Math.round(v(k) * f * 100) / 100;
    const op = [v("total_income"), v("total_expenses")].every(x => x != null) ? Math.round(((v("total_income") - v("total_expenses")) + (v("finance_costs") || 0) + (v("depreciation") || 0) - (v("other_income") || 0)) * f * 100) / 100 : null;
    const row = { months: m, sales: cr("revenue"), op, oi: cr("other_income"), interest: cr("finance_costs"), dep: cr("depreciation"), pbt: cr("pbt"), tax: cr("tax"), np: cr("net_profit"), own: cr("np_owners"), eps: ok.eps_basic ? v("eps_basic") : null };
    let key = null;
    if (m === 3 && end === qe) out.cur = row;
    else if (m === 3 && end === qeAdd(qe, -3)) key = end;
    else if (m === 3 && end === qeAdd(qe, -12)) key = end;
    if (m > 3 && m < 12 && end === qe) key = "ytd0"; else if (m > 3 && m < 12 && end === qeAdd(qe, -12)) key = "ytd1";
    else if (m === 12 && end === qe) key = "ytd0"; else if (m === 12 && end < qe && end >= qeAdd(qe, -12)) key = "fy1";
    if (key) out.cols.push({ qe: key, ...row });
  }
  return out;
}

const SYSTEM = "You read the financial results PDFs of Indian listed companies. Answer with JSON only. Copy every number exactly as printed in the table (same unit, no conversion, no rounding); write negatives / numbers in brackets with a minus sign; never guess — use null when a line is not printed.";
const prompt = (pages, basis, gap) => `The attached document holds pages ${pages.map(p => p + 1).join(", ")} of a company's results PDF, in that order. ${gap ? "The company listed recently, so its earlier periods are known only from these tables." : "The company restructured (demerger / merger), so its earlier periods are restated in these tables."}
Find the ${basis === "S" ? "STANDALONE" : "CONSOLIDATED"} statement of financial results (profit and loss) and return EVERY column of it (this quarter, previous quarter, same quarter last year, year-to-date, previous year-to-date, previous year):
{"statements":[{"basis":"standalone"|"consolidated","unit":"exactly as printed, e.g. ₹ in Crores","columns":[{"label":"as printed","end":"YYYY-MM-DD","months":3|6|9|12,"page":<1-based page of the ATTACHED document>,"revenue":n,"other_income":n,"total_income":n,"total_expenses":n,"finance_costs":n,"depreciation":n,"pbt":n,"tax":n,"np_cont":n,"np_disc":n,"net_profit":n,"np_owners":n,"eps_basic":n}]}]}
revenue = revenue from operations of the continuing operations; total_income, total_expenses, finance_costs, depreciation, pbt (profit before tax) and tax (total tax expense) = continuing operations; np_cont = profit after tax from continuing operations; np_disc = profit after tax from discontinued operations (null if none); net_profit = profit for the period from continuing AND discontinued operations; np_owners = profit attributable to owners of the parent (null if not printed); eps_basic = basic EPS for continuing and discontinued operations, in rupees. If there is no such table, answer {"statements":[]}.`;

// (19 Nov 2026) NEW LISTINGS: the first live runs read 10 of their Results PDFs and kept none ("no results table found" — the
// tables are scanned pictures — or "current quarter did not pass"). They are now read with the BSE reader's proven tools
// (bsepilot.mjs readPdf: first six pages always shown, OCR witnesses 220/300 dpi, sideways scans, picture fallback for big
// scans, a column looked for on the other pages, arithmetic to rounding, one more reading told what failed). Only columns that
// passed EVERY one of those checks are turned into T-Rex's figures (₹ crore) — and T-Rex keeps them only when the current
// quarter equals the company's NSE filing (rsfig).
export function gapCols(statements, basis, qe) {
  const want = basis === "S" ? /stand/i : /cons/i, s0 = (statements || []).find(s => want.test(String(s.basis || ""))) || null;
  const out = { cur: null, cols: [] }; if (!s0) return out; const f = unitFactor(s0.unit); if (!f) return out;
  for (const c of s0.columns || []) {
    const end = String(c.end || ""), m = +c.months || null, on = c.onPage || {}; if (!c.ok || !/^\d{4}-\d{2}-\d{2}$/.test(end)) continue;
    const v = k => c[k] == null || c[k] === "" || !isFinite(+c[k]) ? null : +c[k], cf = k => v(k) == null || !on[k] ? null : Math.round(v(k) * f * 100) / 100;
    const fd = c.teEx ? 0 : v("finance_costs") == null || v("depreciation") == null || !on.finance_costs || !on.depreciation ? null : v("finance_costs") + v("depreciation");   // EBIDT only when both lines are confirmed on the page
    const op = cf("revenue") != null && cf("total_expenses") != null && fd != null ? Math.round((v("revenue") - v("total_expenses") + fd) * f * 100) / 100 : null;
    const row = { months: m, sales: cf("revenue"), op, oi: cf("other_income"), interest: cf("finance_costs"), dep: cf("depreciation"), pbt: cf("pbt"), tax: cf("tax"), np: cf("net_profit"), own: null, eps: on.eps_basic ? v("eps_basic") : null };
    if (row.sales == null || row.np == null) continue;
    let key = null;
    if (m === 3 && end === qe) out.cur = row;
    else if (m === 3 && (end === qeAdd(qe, -3) || end === qeAdd(qe, -12))) key = end;
    else if (m > 3 && m < 12 && end === qe) key = "ytd0"; else if (m > 3 && m < 12 && end === qeAdd(qe, -12)) key = "ytd1";
    else if (m === 12 && end < qe && end >= qeAdd(qe, -12)) key = "fy1";
    if (key) out.cols.push({ qe: key, ...row });
  }
  return out;
}
async function main() {
  if (!KEY || !CKEY) { log("Restated quarters: TREX_KEY or ANTHROPIC_API_KEY missing — nothing done."); return; }
  if (!(CAP > 0)) { log("Restated quarters: no budget set (TREX_RS_BUDGET_USD) — nothing done."); return; }
  const tg = await trex("rstargets", "&n=" + N).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!tg.ok) { log("Restated quarters: could not get the list from T-Rex: " + (tg.error || "?")); process.exitCode = 1; return; }
  let spent = +tg.spent || 0, spentM = +tg.spentMonth || 0; log(`Restated quarters: ${tg.rows.length} Results PDFs to read; spent so far $${spent.toFixed(4)} of $${CAP}${MCAP ? `, this month $${spentM.toFixed(4)} of $${MCAP}` : ""}.`);
  const st = {}; let k = 0, kept = 0; const until = Date.now() + Math.max(1, +(process.env.TREX_RS_MINUTES || 22)) * 60e3;   // the job has 30 minutes
  for (const row of tg.rows) {
    if (Date.now() > until) { log(`Restated quarters: time is up — ${tg.rows.length - k} left for the next run.`); break; }
    k++; if (spent >= CAP - 0.05 || (MCAP && spentM >= MCAP - 0.05)) { log(`Restated quarters: budget reached ($${spent.toFixed(4)} in total, $${spentM.toFixed(4)} this month) — stopping.`); break; }
    const dir = await mkdtemp(join(tmpdir(), "rsr-")), id = `doc ${k}`, c0 = st.cost || 0; let cost = 0;
    try {
      const pdf = await getNsePdf(row.pdf); if (!pdf) { log(`  ${id}: could not download`); await trex("rsfig", "", { symbol: row.symbol, basis: row.basis, qe: row.qe, ok: false, cost: 0, err: "download failed" }); continue; }
      const file = join(dir, "a.pdf"); await writeFile(file, pdf);
      if (row.gap) {                                                    // a new listing: the BSE reader's tools (see gapCols)
        const R = await readPdf(dir, file, { name: row.name || row.symbol, code: "NSE " + row.symbol, scrip: row.symbol }, (sys, content, stt) => askClaude(fetch, CKEY, sys, content, null, stt), st, Math.min(until, Date.now() + 8 * 60e3));
        cost = (st.cost || 0) - c0; spent += cost; spentM += cost;
        const g = gapCols(R.best.statements, row.basis, row.qe), ok = !!(g.cur && g.cols.some(c => (row.want || []).includes(c.qe)));
        const r = await trex("rsfig", "", { symbol: row.symbol, basis: row.basis, qe: row.qe, ok, cost, model: R.best.model, cur: g.cur, cols: g.cols, err: ok ? null : (!R.best.statements.length ? "no results table found in the PDF" : !g.cur ? "current quarter did not pass the checks" : "no earlier quarter passed the checks") }).then(x => x.json()).catch(() => null);
        if (r && r.kept && r.kept.length) kept++;
        log(`  ${id}: new listing, ${R.nPages} pages${R.ocr.length ? " (scanned / pictures, read by OCR)" : ""}, ${R.best.ck.ok} of ${R.best.ck.cols} columns passed${R.tries > 1 ? " (read twice)" : ""} — ${r && r.kept && r.kept.length ? "kept" : "not kept"} · $${cost.toFixed(4)}`);
        continue;
      }
      const nPages = +((await sh("pdfinfo", [file]).catch(() => "")).match(/Pages:\s+(\d+)/) || [0, 0])[1] || 1;
      const { pages } = await pageTexts(dir, file, nPages);
      const pick = rsPick(pages, row.basis); if (!pick.length) { log(`  ${id}: no results table found`); await trex("rsfig", "", { symbol: row.symbol, basis: row.basis, qe: row.qe, ok: false, cost: 0, err: "no results table found in the PDF" }); continue; }
      const parts = []; for (const p of pick) { await sh("pdfseparate", ["-f", String(p + 1), "-l", String(p + 1), file, join(dir, "s-%d.pdf")]); parts.push(join(dir, `s-${p + 1}.pdf`)); }
      const sub = join(dir, "sub.pdf"); if (parts.length > 1) await sh("pdfunite", [...parts, sub]); else await writeFile(sub, await readFile(parts[0]));
      const ans = await askClaude(fetch, CKEY, SYSTEM, [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: (await readFile(sub)).toString("base64") } }, { type: "text", text: prompt(pick, row.basis, row.gap) }], null, st);
      cost = (st.cost || 0) - c0; spent += cost; spentM += cost;
      let j = null; try { j = JSON.parse(String(ans.text).replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch (e) { j = salvageJson(ans.text); }
      const want = row.basis === "S" ? /stand/i : /cons/i, sts = (j && Array.isArray(j.statements)) ? j.statements : [];
      const s0 = sts.find(s => want.test(String(s.basis || ""))) || null;
      const pageOf = n => pages[pick[Math.max(0, Math.min(pick.length - 1, Math.round(+n || 1) - 1))]] || "";
      const ck = rsCheck(s0, pageOf, row.qe);
      const ok = !!(ck.cur && ck.cols.some(c => (row.want || []).includes(c.qe)));
      const r = await trex("rsfig", "", { symbol: row.symbol, basis: row.basis, qe: row.qe, ok, cost, model: ans.model, cur: ck.cur, cols: ck.cols, err: ok ? null : (!s0 ? "no statement of that basis" : !ck.cur ? "current quarter did not pass the checks" : "no restated quarter passed the checks") }).then(x => x.json()).catch(() => null);
      if (r && r.kept && r.kept.length) kept++;
      log(`  ${id}: ${pick.length} page(s) read, ${ck.found} of ${ck.total} numbers found in their rows, ${ck.cols.length} column(s) passed — ${r && r.kept && r.kept.length ? "kept" : "not kept"} · $${cost.toFixed(4)}`);
    } catch (e) { const c1 = (st.cost || 0) - c0; if (c1 > cost) { spent += c1 - cost; spentM += c1 - cost; cost = c1; }
      log(`  ${id}: ${String(e.message || e).replace(/https?:\/\/\S+/g, "[link]").slice(0, 140)}`); if (e.fatal) break;
      // a busy / out-of-room answer is not the document's fault: only its cost is counted, the try is not (tries < 2)
      try { await trex("rsfig", "", { symbol: row.symbol, basis: row.basis, qe: row.qe, ok: false, cost, err: "reading failed", again: !!(e.busy || /tried again later/.test(String(e.message))) }); } catch (x) {} }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  log(`Restated quarters: done — ${kept} kept. Spent this run $${(st.cost || 0).toFixed(4)}; in total about $${spent.toFixed(4)} of $${CAP}.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
