// T-Rex ownership & delivery collector — runs on GitHub Actions (every 2 hours) or anywhere with Node 18+.
// Reads NSE's public data and hands it to T-Rex (POST /api/own, protected by the sync secret):
//   1. the whole market's FII / DII buying and selling (daily)
//   2. each stock's delivered quantity (NSE's daily file) — the last ~65 trading days, then one day at a time
//   3. insider / promoter trades (NSE insider-trading filings, one small file each)
//   4. bulk and block deals
//   5. quarterly shareholding (promoter, foreign and domestic institutions, mutual funds, public — by share count)
// Every step is limited in time and number, and is safe to stop at any point: the next run continues where this one left off.
// Nothing is estimated here — files are read and the numbers sent as found; T-Rex checks them again before storing.
import { pathToFileURL } from "node:url";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-insider-trading";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { if (v == null) return null; const x = parseFloat(String(v).replace(/,/g, "").trim()); return isFinite(x) ? x : null; };
const dmy = iso => iso.slice(8, 10) + "-" + iso.slice(5, 7) + "-" + iso.slice(0, 4);

/* ---------- readers (exported for the tests) ---------- */
// all leaf values of an XBRL file, grouped by context: { context: { element: text } }
export function xbrlFacts(xml) {
  const out = {}; const re = /<([A-Za-z0-9_\-]+):([A-Za-z0-9_]+)\b([^>]*?)>([^<]*)<\/\1:\2>/g; let m;
  while ((m = re.exec(String(xml)))) { const cr = /contextRef\s*=\s*"([^"]+)"/.exec(m[3]); if (!cr) continue; const v = m[4].trim(); if (!v) continue;
    const o = out[cr[1]] = out[cr[1]] || {}; if (!(m[2] in o)) o[m[2]] = v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"'); }
  return out;
}
// NSE insider-trading filing → { s, reg, rows:[{cat, nm, ins, typ, mode, qty, val, pre, post, fd, td}] }
export function pitParse(xml) {
  const f = xbrlFacts(xml), main = f.MainI || {}; const rows = [];
  for (const [ctx, o] of Object.entries(f)) {
    if (ctx === "MainI" || !("SecuritiesAcquiredOrDisposedNumberOfSecurity" in o)) continue;
    const pick = (...ks) => { for (const k of ks) if (o[k] != null) return o[k]; return null; };
    rows.push({ cat: o.CategoryOfPerson || "", nm: o.NameOfThePerson || "", ins: o.TypeOfInstrument || "",
      typ: o.SecuritiesAcquiredOrDisposedTransactionType || "", mode: o.ModeOfAcquisitionOrDisposal || "",
      qty: num(o.SecuritiesAcquiredOrDisposedNumberOfSecurity), val: num(o.SecuritiesAcquiredOrDisposedValueOfSecurity),
      pre: num(pick("SecuritiesHeldPriorToAcquisitionOrDisposalNumberOfSecurity")), post: num(pick("SecuritiesHeldPostAcquistionOrDisposalNumberOfSecurity", "SecuritiesHeldPostAcquisitionOrDisposalNumberOfSecurity")),
      fd: pick("DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyFromDate") || "", td: pick("DateOfAllotmentAdviceOrAcquisitionOfSharesOrSaleOfSharesSpecifyToDate") || "",
      n: +(ctx.match(/(\d+)$/) || [0, 0])[1] });
  }
  rows.sort((a, b) => a.n - b.n); rows.forEach(r => delete r.n);
  return { s: (main.Symbol || "").toUpperCase(), reg: main.DisclosureUnderRegulation || "", rows };
}
// NSE shareholding-pattern filing → share counts by group (null when the file has no such group)
export function shpParse(xml) {
  const f = xbrlFacts(xml);
  const sh = c => { const o = f[c + "_ContextI"]; if (!o) return null; return num(o.NumberOfShares ?? o.NumberOfFullyPaidUpEquityShares); };
  const tot = sh("ShareholdingPattern"), pro = sh("ShareholdingOfPromoterAndPromoterGroup"), pub = sh("PublicShareholding");
  let fii = sh("InstitutionsForeign"); if (fii == null) { const a = sh("InstitutionsForeignPortfolioInvestorCategoryOne"), b = sh("InstitutionsForeignPortfolioInvestorCategoryTwo"); if (a != null || b != null) fii = (a || 0) + (b || 0); }
  return { tot, pro, pub, fii, dii: sh("InstitutionsDomestic"), mf: sh("MutualFundsOrUTI") };
}
// NSE "sec_bhavdata_full" CSV → { date, rows:[[SYM, traded qty, delivered qty, close]] } (EQ preferred, then BE / BZ / SM / ST)
export function dlvParse(text) {
  const lines = String(text || "").split(/\r?\n/); const h = (lines[0] || "").split(",").map(x => x.trim().toUpperCase());
  const iS = h.indexOf("SYMBOL"), iR = h.indexOf("SERIES"), iV = h.indexOf("TTL_TRD_QNTY"), iQ = h.indexOf("DELIV_QTY"), iC = h.indexOf("CLOSE_PRICE"), iD = h.indexOf("DATE1");
  if (iS < 0 || iV < 0 || iQ < 0 || iC < 0) return { err: "unexpected file format" };
  const RANK = { EQ: 4, BE: 3, BZ: 2, SM: 1, ST: 1 }, best = {}; let date = null;
  for (let k = 1; k < lines.length; k++) { const c = lines[k].split(","); if (c.length <= Math.max(iS, iV, iQ, iC)) continue;
    const s = c[iS].trim(), w = RANK[(c[iR] || "").trim()] || 0; if (!s || !w) continue; if (!date && iD >= 0) date = (c[iD] || "").trim();
    const v = num(c[iV]), q = num(c[iQ]), cl = num(c[iC]); if (!(v > 0) || q == null || !(cl > 0)) continue;   // "-" = no delivery figure that day
    if (!best[s] || w > best[s][4]) best[s] = [s, v, q, cl, w]; }
  const rows = Object.values(best).map(r => r.slice(0, 4)); return rows.length < 500 ? { err: "file looked incomplete" } : { date, rows };
}
// NSE bulk / block deals (JSON) → [{d, s, kind, who, side, qty, px}]
export function dealsParse(j, kind) {
  const list = Array.isArray(j) ? j : (j && Array.isArray(j.data) ? j.data : []); const out = [];
  for (const r of list) { const g = (...ks) => { for (const k of ks) if (r && r[k] != null && r[k] !== "") return r[k]; return null; };
    const d = g("BD_DT_DATE", "date", "mTIMESTAMP"), s = g("BD_SYMBOL", "symbol"), who = g("BD_CLIENT_NAME", "clientName"), side = g("BD_BUY_SELL", "buySell"), qty = num(g("BD_QTY_TRD", "qty")), px = num(g("BD_TP_WATP", "watp"));
    if (d && s && who && side && qty > 0 && px > 0) out.push({ d: String(d), s: String(s).toUpperCase(), kind, who: String(who), side: String(side).toUpperCase(), qty, px }); }
  return out;
}

// the last n quarter-ends before the current quarter: Nov 2026 → 2026-09-30, 2026-06-30, 2026-03-31, 2025-12-31, 2025-09-30
export function quarterEnds(ist, n) { const y = ist.getUTCFullYear(), q = Math.floor(ist.getUTCMonth() / 3), out = [];
  for (let k = 1; k <= n; k++) { let qq = q - k; const yy = y + Math.floor(qq / 4); qq = ((qq % 4) + 4) % 4; out.push(new Date(Date.UTC(yy, qq * 3 + 3, 0)).toISOString().slice(0, 10)); }
  return out; }

export async function runOwn(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY; const F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const t0 = Date.now(), until = t0 + (o.maxMinutes || +process.env.TREX_MAX_MINUTES || 14) * 60e3, gap = o.gap ?? 300;
  if (!key) { log("TREX_KEY (your T-Rex sync secret) is not set — add it under GitHub → Settings → Secrets and variables → Actions."); return { ok: false }; }
  const jar = new Map();
  const keep = r => { const sc = r.headers && r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  async function session() { try { const r = await F(REF, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html" }, signal: AbortSignal.timeout(20000) }); keep(r); await r.arrayBuffer(); } catch (e) {} }
  async function nse(url, ms) {
    try { const r = await F(url, { headers: { "User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": REF, ...(jar.size ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(ms || 45000) });
      keep(r); return { code: r.status, text: await r.text() }; } catch (e) { return { code: 0, text: "" }; }
  }
  async function trex(body) {
    for (let t = 1; t <= 3; t++) {
      try { const r = await F(`${server}/api/own`, { method: "POST", headers: { "x-trex-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
        const txt = await r.text(); if (r.status >= 500 && t < 3) { await sleep(4000 * t); continue; }
        try { return JSON.parse(txt); } catch (e) { return { ok: false, error: `T-Rex answered ${r.status}` }; }
      } catch (e) { if (t >= 3) return { ok: false, error: "could not reach T-Rex" }; await sleep(4000 * t); }
    }
  }
  const st = await trex({ action: "status" }); if (!st || !st.ok) { log("Could not use T-Rex: " + (st && st.error)); return { ok: false }; }
  await session(); const done = { fii: 0, days: 0, pit: 0, deals: 0, shp: 0 };
  const left = ms => Date.now() < until - (ms || 0);

  // 1) FII / DII (whole market, ₹ Cr)
  { const r = await nse("https://www.nseindia.com/api/fiidiiTradeReact", 20000); let rows = []; try { rows = JSON.parse(r.text); } catch (e) {}
    if (Array.isArray(rows) && rows.length) { const res = await trex({ action: "fii", rows }); if (res && res.ok) done.fii = res.saved; } }

  // 2) delivery: the last ~65 weekdays not stored yet (newest first), at most 12 files a run
  { const have = new Set([...(st.days || []), ...(st.miss || [])]); const ist = new Date(Date.now() + 5.5 * 3600e3); const want = [];
    for (let d = 0; want.length < 66 && d < 110; d++) { const day = new Date(ist.getTime() - d * 864e5); const wd = day.getUTCDay(); if (wd === 0 || wd === 6) continue; const iso = day.toISOString().slice(0, 10);
      if (d === 0 && ist.getUTCHours() < 19) continue;                     // today's file appears in the evening
      want.push(iso); }
    let n = 0;
    for (const iso of want) { if (have.has(iso)) continue; if (n >= (o.maxDays || 12) || !left(60e3)) break; n++;
      const r = await nse(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(0, 4)}.csv`, 45000);
      if (r.code === 404 || r.code === 403 && /not\s*found/i.test(r.text)) {             // no file: a holiday — remembered only once the day is safely past (a late file is not lost)
        if (iso < new Date(ist.getTime() - 3 * 864e5).toISOString().slice(0, 10)) await trex({ action: "dlvmiss", date: iso }); continue; }
      if (r.code !== 200 || r.text.length < 10000) { log(`Delivery ${iso}: NSE answered ${r.code}`); continue; }
      const p = dlvParse(r.text); if (p.err) { log(`Delivery ${iso}: ${p.err}`); continue; }
      const res = await trex({ action: "dlv", date: iso, rows: p.rows, rebuild: false }); if (res && res.ok) done.days++; else log(`Delivery ${iso}: ${res && res.error}`);
      await sleep(gap); }
    if (done.days) { const b = await trex({ action: "dlvbuild" }); log(`Delivery: ${done.days} trading day(s) added (${b && b.days} days kept).`); } }

  // 3) insider / promoter trades: the list (≈ 6 months), then each new filing's small file
  if (left(90e3)) { const r = await nse("https://www.nseindia.com/api/corporates-pit-gg?index=equities", 60000); let list = [];
    try { const j = JSON.parse(r.text); list = Array.isArray(j) ? j : (j.data || []); } catch (e) {}
    list = list.filter(x => x && x.appId && x.symbol && x.xmlFileName && /^https:\/\/nsearchives\.nseindia\.com\//.test(x.xmlFileName));
    const idOf = x => String(x.appId) + "-" + String(x.broadcastDateTime || "").replace(/\D/g, "").slice(0, 14);
    const ask = await trex({ action: "pitnew", ids: list.map(idOf) }); const fresh = new Set((ask && ask.fresh) || []);
    const todo = list.filter(x => fresh.has(idOf(x))).slice(0, o.maxPit || 600); const backfill = !st.pit; const batch = [];
    const stopPit = Math.min(until - 45e3, Date.now() + (o.pitMinutes || 5) * 60e3);       // leave time for the other steps
    for (const x of todo) { if (Date.now() > stopPit) break;
      const f = await nse(x.xmlFileName, 30000); if (f.code !== 200 || !/<xbrl|<xbrli:xbrl/i.test(f.text)) { await sleep(gap * 3); continue; }
      const p = pitParse(f.text); batch.push({ id: idOf(x), s: p.s || String(x.symbol).toUpperCase(), bd: String(x.broadcastDateTime || "").slice(0, 11), rev: /revis/i.test(String(x.typeOfSubmission || "")), rows: p.rows });
      if (batch.length >= 40) { const res = await trex({ action: "pit", filings: batch.splice(0), backfill }); if (res && res.ok) done.pit += res.rows; }
      await sleep(gap); }
    if (batch.length) { const res = await trex({ action: "pit", filings: batch, backfill }); if (res && res.ok) done.pit += res.rows; }
    if (todo.length) log(`Insider trades: ${todo.length} new filing(s) read, ${done.pit} trade row(s) stored.`); }

  // 4) bulk and block deals: the last 7 days each run; the first runs also go back 6 months, 30 days at a time
  if (left(60e3)) { const ist = Date.now() + 5.5 * 3600e3, iso = t => new Date(t).toISOString().slice(0, 10); const spans = [[iso(ist - 7 * 864e5), iso(ist)]];
    const from = st.dealsFrom || iso(ist); if (from > iso(ist - 180 * 864e5)) { const end = new Date(Date.parse(from) - 864e5).getTime(); spans.push([iso(end - 29 * 864e5), iso(end)]); }
    for (const [a, b] of spans) { const rows = [];
      for (const kind of ["bulk", "block"]) { const r = await nse(`https://www.nseindia.com/api/historicalOR/bulk-block-short-deals?optionType=${kind}_deals&from=${dmy(a)}&to=${dmy(b)}`, 40000);
        try { rows.push(...dealsParse(JSON.parse(r.text), kind)); } catch (e) {} await sleep(gap); }
      const res = await trex({ action: "deals", rows, from: a }); if (res && res.ok) done.deals += res.saved; } }

  // 5) quarterly shareholding: NSE's list for the last five quarters, then the files still missing (most useful first)
  if (left(120e3)) { const ist = new Date(Date.now() + 5.5 * 3600e3), rows = [];
    const ends = quarterEnds(ist, 5);
    for (const qe of ends) { if (!left(90e3)) break;
      const a = new Date(Date.parse(qe) + 864e5).toISOString().slice(0, 10), b = new Date(Date.parse(qe) + 75 * 864e5).toISOString().slice(0, 10);
      const r = await nse(`https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&from_date=${dmy(a)}&to_date=${dmy(b)}`, 60000);
      let list = []; try { const j = JSON.parse(r.text); list = Array.isArray(j) ? j : (j.data || []); } catch (e) {}
      for (const x of list) { if (!x || !x.symbol || !x.xbrl || !x.date) continue; const mm = String(x.date).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/); if (!mm) continue;
        const mon = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].indexOf(mm[2].toUpperCase()) + 1; const d = `${mm[3]}-${String(mon).padStart(2, "0")}-${mm[1].padStart(2, "0")}`;
        if (d === qe) rows.push([String(x.symbol).toUpperCase(), d, x.xbrl, num(x.pr_and_prgrp), String(x.submissionDate || x.broadcastDate || "")]); }
      await sleep(gap); }
    const info = new Map(rows.map(r => [r[0] + "|" + r[1], r]));
    const tg = rows.length ? await trex({ action: "shptargets", rows: rows.map(r => r.slice(0, 4)), limit: o.maxShp || 500 }) : null; const todo = (tg && tg.todo) || []; const batch = []; let bad = 0;
    for (const t of todo) { if (!left(40e3)) break;
      const f = await nse(t[2], 60000); if (f.code !== 200 || f.text.length < 2000) { bad++; if (bad >= 8) { log("Shareholding: NSE not answering — next run continues."); break; } await sleep(gap * 4); await session(); continue; }
      bad = 0; const v = shpParse(f.text), meta = info.get(t[0] + "|" + t[1]) || [];
      batch.push({ s: t[0], qe: t[1], file: t[2], np: t[3], filed: meta[4] || null, ...v });
      if (batch.length >= 25) { const res = await trex({ action: "shp", rows: batch.splice(0) }); if (res && res.ok) { done.shp += res.saved; if (res.bad && res.bad.length) log(`  Shareholding not stored (numbers did not add up): ${res.bad.slice(0, 5).join(", ")}`); } }
      await sleep(gap); }
    if (batch.length) { const res = await trex({ action: "shp", rows: batch }); if (res && res.ok) { done.shp += res.saved; if (res.bad && res.bad.length) log(`  Shareholding not stored (numbers did not add up): ${res.bad.slice(0, 5).join(", ")}`); } }
    if (todo.length) log(`Shareholding: ${done.shp} quarter(s) stored this run; ${Math.max(0, ((tg && tg.left) || 0) - done.shp)} still waiting.`); }

  log(`Finished: FII/DII ${done.fii} day(s), delivery ${done.days} day(s), insider trades ${done.pit}, deals ${done.deals}, shareholding ${done.shp} — ${Math.round((Date.now() - t0) / 1000)} s.`);
  return { ok: true, ...done };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runOwn().then(r => process.exit(r && r.ok ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
