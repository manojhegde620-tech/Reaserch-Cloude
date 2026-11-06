// T-Rex company info: for the companies on your watchlists, the figures the Key ratios block needs that are not in the
// results filings themselves — promoter holding (last 8 quarters) and pledged shares from NSE's shareholding-pattern
// filings, and the face value / paid-up capital from the latest results filing. Plus, once a week, every company's
// industry from the Nifty index lists (for the industry P/E). Everything comes from NSE / NSE Indices; nothing is estimated.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const x = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(x) ? x : null; };

// first numeric value of an XBRL element (any namespace prefix)
export function xbrlNum(xml, tag) {
  const m = String(xml).match(new RegExp(`<[A-Za-z0-9\\-]+:${tag}\\b[^>]*>\\s*(-?[0-9.,Ee+\\-]+)\\s*<`));
  return m ? num(m[1]) : null;
}
export function xbrlText(xml, tag) {
  const m = String(xml).match(new RegExp(`<[A-Za-z0-9\\-]+:${tag}\\b[^>]*>\\s*([^<]{1,200})<`)); return m ? m[1].trim() : null;
}
// shareholding-pattern XBRL: are any promoter shares pledged, and how many (as % of the promoters' shares)
export function shpPledge(xml) {
  const flag = xbrlText(xml, "WhetherAnySharesHeldByPromotersAreEncumberedUnderPledgedForPromoterAndPromoterGroup") || xbrlText(xml, "WhetherAnySharesHeldByPromotersAreEncumberedUnderPledged");
  if (flag && /^no$/i.test(flag)) return { pledged: false, pct: 0 };
  // pledged share counts are reported per shareholder and per total row; take the largest pledged count (= the promoter-group total)
  const re = /<([A-Za-z0-9\-]+):(\w*Pledge\w*|\w*Encumbered\w*)\b[^>]*>\s*([0-9.,]+)\s*</g; let best = null, m;
  while ((m = re.exec(xml))) { if (/^Whether|Percentage/i.test(m[2])) continue; const v = num(m[3]); if (v != null && (best == null || v > best)) best = v; }
  const pctTags = []; const rp = /<([A-Za-z0-9\-]+):(\w*(?:Pledge|Encumbered)\w*Percentage\w*|Percentage\w*(?:Pledge|Encumbered)\w*)\b[^>]*>\s*([0-9.,]+)\s*</g;
  while ((m = rp.exec(xml))) { const v = num(m[3]); if (v != null) pctTags.push(v); }
  return { pledged: flag ? /^yes$/i.test(flag) : best > 0, pledgedShares: best, pctReported: pctTags.length ? Math.max(...pctTags) : null };
}

// the sector from NSE's quote-page data (equityResponse[0].secInfo.sector); null when the page has none
export function quoteSector(txt) {
  try { const j = JSON.parse(txt); const e = Array.isArray(j && j.equityResponse) ? j.equityResponse[0] : null;
    const v = e && e.secInfo && typeof e.secInfo.sector === "string" ? e.secInfo.sector.replace(/\s+/g, " ").trim() : "";
    return v && !/^(-|na|n\/a|null)$/i.test(v) ? v.slice(0, 60) : null; } catch (e) { return null; }
}

export async function runCompanyInfo({ trex, nse, log, until, publicLog = process.env.TREX_PUBLIC_LOG === "1", gap = 700 }) {
  const st = { companies: 0, industries: 0, sectors: 0 };
  const tg = await trex("cinfotargets");
  if (!tg || !tg.ok) { log("Company info: T-Rex problem: " + (tg && tg.error)); return st; }
  const name = s => publicLog ? "[company]" : s;
  // 1) industries for the industry P/E (weekly)
  if (tg.industriesDue && Date.now() < until - 60e3) {
    const rows = [];
    for (const f of ["ind_niftytotalmarket_list.csv", "ind_niftymicrocap250_list.csv"]) {
      // NSE's own archive first (reachable from GitHub); niftyindices.com as the second way (it times out from GitHub)
      let r = await nse(`https://nsearchives.nseindia.com/content/indices/${f}`, 40000);
      if (r.code !== 200 || !r.body || r.body.length < 1000) r = await nse(`https://www.niftyindices.com/IndexConstituent/${f}`, 40000);
      if (r.code !== 200 || !r.body) { log(`  Industry list ${f}: HTTP ${r.code}`); continue; }
      const lines = r.body.toString("utf8").split(/\r?\n/); const h = (lines.shift() || "").split(",").map(x => x.trim().toLowerCase());
      const iS = h.indexOf("symbol"), iI = h.indexOf("industry"); if (iS < 0 || iI < 0) continue;
      for (const l of lines) { const c = l.split(","); if (c[iS] && c[iI]) rows.push([c[iS].trim().toUpperCase(), c[iI].trim()]); }
    }
    const uniq = [...new Map(rows.map(r => [r[0], r])).values()];
    if (uniq.length >= 100) { const res = await trex("industries", {}, JSON.stringify({ rows: uniq })); if (res && res.ok) { st.industries = uniq.length; log(`Company info: industries of ${uniq.length} companies updated (Nifty index lists).`); } }
  }
  // 1b) industry of every other company (results or announcements, not in the index lists): NSE's own classification from
  //     the company's quote page — the same sector names as the index lists. A few minutes per run until all are done.
  if (Date.now() < until - 90e3) {
    const it = await trex("indtargets");
    const todo = (it && it.ok && it.symbols) || [], stopAt = Math.min(until - 60e3, Date.now() + 4 * 60e3), rows = [], odd = []; let bad = 0, asked = 0, found = 0;
    for (const sym of todo) {
      if (Date.now() > stopAt || bad >= 8) break;
      const r = await nse(`https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=EQ&symbol=${encodeURIComponent(sym)}`, 20000);
      if (r.code !== 200 || !r.body) { bad++; rows.push([sym, null]); await sleep(gap * 2); continue; }   // asked again in 7 days; NSE busy / blocked: stop after a few
      let sec = quoteSector(r.body.toString("utf8"));
      if (!sec) {                                                    // some trade in another series (BE, BZ …): ask NSE which, then once more
        await sleep(gap); const m = await nse(`https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getMetaData&symbol=${encodeURIComponent(sym)}`, 20000);
        let ser = null, mt = "N"; try { const j = JSON.parse(m.body ? m.body.toString("utf8") : "{}"); ser = (j.activeSeries || [])[0] || null; mt = /^[A-Z]$/.test(j.marketType || "") ? j.marketType : "N"; } catch (e) {}
        if (ser && /^[A-Z0-9]{1,3}$/.test(ser) && (ser !== "EQ" || mt !== "N")) { await sleep(gap);
          const r2 = await nse(`https://www.nseindia.com/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=${mt}&series=${ser}&symbol=${encodeURIComponent(sym)}`, 20000);
          if (r2.code === 200 && r2.body) sec = quoteSector(r2.body.toString("utf8")); }
      }
      rows.push([sym, sec]); asked++; if (sec) found++; bad = 0;
      if (rows.length >= 50) { const res = await trex("industry1", {}, JSON.stringify({ rows: rows.splice(0) })); odd.push(...((res && res.odd) || [])); }
      await sleep(gap);
    }
    if (rows.length) { const res = await trex("industry1", {}, JSON.stringify({ rows })); odd.push(...((res && res.odd) || [])); }
    st.sectors = found;
    if (todo.length) log(`Company info: industry looked up on NSE for ${asked} compan${asked === 1 ? "y" : "ies"} (${found} found; ${Math.max(0, ((it && it.left) || 0) - asked)} still waiting${bad >= 8 ? "; NSE not answering, will retry next run" : ""}).`);
    if (odd.length) log(`  Industry names not recognised (not stored): ${odd.slice(0, 5).join("; ")}`);
  }
  // 2) per company: shareholding pattern (promoter %, pledges) + face value / paid-up capital
  for (const t of tg.targets || []) {
    if (Date.now() > until - 60e3) break;
    const have = t.have || {}; const fresh = have.t && Date.now() - have.t < 12 * 3600e3;
    if (fresh && have.resXbrl === t.resXbrl) continue;
    const data = { t: Date.now() };
    try {
      const sh = await nse(`https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(t.symbol)}`, 30000);
      let list = []; try { const j = JSON.parse(sh.body ? sh.body.toString("utf8") : "[]"); list = Array.isArray(j) ? j : (j.data || []); } catch (e) {}
      const dt = s => { const d = Date.parse(String(s || "").replace(/-/g, " ")); return isNaN(d) ? 0 : d; };
      list = list.filter(r => r && r.date && num(r.pr_and_prgrp) != null).sort((a, b) => dt(b.date) - dt(a.date));
      const seen = new Set(); data.sh = list.filter(r => !seen.has(r.date) && seen.add(r.date)).slice(0, 8).map(r => ({ d: r.date, p: num(r.pr_and_prgrp), pub: num(r.public_val) }));
      const shp = list[0] && list[0].xbrl;
      if (shp) {
        data.shpXbrl = shp; data.shpDate = list[0].date;
        if (shp === have.shpXbrl && have.pledge) data.pledge = have.pledge;
        else { await sleep(500); const x = await nse(shp, 60000);
          if (x.code === 200 && x.body) { const xml = x.body.toString("utf8"); const pl = shpPledge(xml);
            const tot = xbrlNum(xml, "NumberOfShares"); data.pledge = pl; data.totalShares = tot; } }
      }
      if (t.resXbrl) {
        data.resXbrl = t.resXbrl;
        await sleep(500); const x = await nse(t.resXbrl, 60000);
        if (x.code === 200 && x.body) { const xml = x.body.toString("utf8");
          data.fv = xbrlNum(xml, "FaceValueOfEquityShareCapital"); data.paidUp = xbrlNum(xml, "PaidUpValueOfEquityShareCapital"); }
      }
    } catch (e) { log(`  ${name(t.symbol)}: company info error ${e.message || e}`); continue; }
    const r = await trex("cinfo", {}, JSON.stringify({ symbol: t.symbol, data }));
    if (r && r.ok) st.companies++;
    await sleep(400);
  }
  if (st.companies) log(`Company info: shareholding, pledges and face value updated for ${st.companies} watchlist compan${st.companies === 1 ? "y" : "ies"}.`);
  return st;
}
