// T-Rex collector — runs on GitHub Actions (every 3 hours) or anywhere with Node 18+.
// Downloads NSE's results-filings list, the XBRL files and closing prices, and hands them to T-Rex
// (POST /api/collect, protected by the sync secret). T-Rex checks, parses and stores them with the same
// code as always — this script only carries files. Safe to stop at any time; the next run continues.
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-integrated-filing";
const LIST = p => `https://www.nseindia.com/api/integrated-filing-results?type=Integrated%20Filing-%20Financials&page=${p}&size=200`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function run(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://trex.agilenox.in").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY;
  const F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const t0 = Date.now(); let until = t0 + (o.maxMinutes || +process.env.TREX_MAX_MINUTES || 40) * 60e3;
  const parallel = o.parallel || 4, gap = o.gap ?? 120, waitBase = o.waitBase ?? 20000;
  const source = o.source || process.env.TREX_SOURCE || "github";
  if (!key) { log("TREX_KEY (your T-Rex sync secret) is not set — add it under GitHub → Settings → Secrets and variables → Actions."); return { ok: false }; }

  /* --- NSE with a cookie session, like a browser --- */
  const jar = new Map();
  const keep = r => { const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  async function session() { try { const r = await F(REF, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html" }, signal: AbortSignal.timeout(20000) }); keep(r); await r.arrayBuffer(); } catch (e) {} }
  async function nse(url, ms) {                   // → { code, body: Buffer|null }
    try {
      const r = await F(url, { headers: { "User-Agent": UA, "Accept": "*/*", "Accept-Language": "en-US,en;q=0.9", "Referer": REF, ...(jar.size ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(ms || 45000) });
      keep(r); const body = Buffer.from(await r.arrayBuffer()); return { code: r.status, body };
    } catch (e) { return { code: 0, body: null, why: String((e && e.cause && (e.cause.code || e.cause.message)) || (e && (e.name === "TimeoutError" ? "timed out" : e.message)) || e) }; }
  }
  /* --- big PDFs (presentations, annual reports): a fresh connection every time, then curl as a second way ---
     NSE's archive server drops idle connections without telling; Node then waits on a dead connection and the
     download fails ("HTTP 0"). A new connection per PDF avoids that; curl is the fallback. */
  async function httpsGet(url, ms, hops = 0) {
    const https = await import("node:https");
    return new Promise(res => {
      let done = false; const fin = v => { if (!done) { done = true; clearTimeout(tm); res(v); } };
      const req = https.get(url, { agent: false, headers: { "User-Agent": UA, "Accept": "application/pdf,*/*", "Accept-Encoding": "identity", "Accept-Language": "en-US,en;q=0.9", "Referer": REF, "Connection": "close", ...(jar.size ? { Cookie: cookie() } : {}) } }, r => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) { r.resume(); if (!done) { done = true; clearTimeout(tm); res(httpsGet(new URL(r.headers.location, url).href, ms, hops + 1)); } return; }
        const parts = []; r.on("data", c => parts.push(c)); r.on("end", () => fin({ code: r.statusCode, body: Buffer.concat(parts) })); r.on("error", e => fin({ code: 0, body: null, why: e.code || e.message }));
      });
      const tm = setTimeout(() => { req.destroy(); fin({ code: 0, body: null, why: "timed out" }); }, ms);
      req.on("error", e => fin({ code: 0, body: null, why: e.code || e.message }));
    });
  }
  async function curlGet(url, ms) {
    try {
      const { execFile } = await import("node:child_process"); const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
      const tmp = path.join(os.tmpdir(), "trex-" + Date.now() + ".pdf");
      const args = ["-sSL", "--max-time", String(Math.round(ms / 1000)), "-A", UA, "-e", REF, "-H", "Accept: application/pdf,*/*", "-o", tmp, "-w", "%{http_code}", ...(jar.size ? ["-H", "Cookie: " + cookie()] : []), url];
      const code = await new Promise(r => execFile("curl", args, { timeout: ms + 5000 }, (e, out) => r(e ? 0 : +String(out).trim() || 0)));
      let body = null; try { body = fs.readFileSync(tmp); fs.unlinkSync(tmp); } catch (e) {}
      return { code, body, why: code ? "" : "curl failed" };
    } catch (e) { return { code: 0, body: null, why: "curl unavailable" }; }
  }
  async function pdfGet(url, ms) {
    if (o.fetch) return nse(url, ms);                                   // tests: the stand-in fetch
    let r = await curlGet(url, Math.min(ms, 90000));                    // curl first: seen to be the quickest and steadiest with NSE's archive
    if (r.code === 200 && r.body && r.body.length >= 1000) return r;
    const first = r.why || "HTTP " + r.code;
    await session();                                                    // fresh NSE cookies, then Node's own https
    r = await httpsGet(url, ms);
    if (!(r.code === 200 && r.body && r.body.length >= 1000)) r.why = `${first}; then ${r.why || "HTTP " + r.code}`;
    return r;
  }
  /* --- T-Rex --- */
  async function trex(action, params, body, gz) {
    const qs = new URLSearchParams({ action, ...(params || {}) });
    const slow = action === "ai", tries = slow ? 1 : 3;              // the AI call is slow by nature: one attempt, longer wait
    for (let t = 1; t <= tries; t++) {
      try {
        const h = { "x-trex-key": key }; let b = body;
        if (body != null && gz) { h["x-trex-gz"] = "1"; b = zlib.gzipSync(Buffer.isBuffer(body) ? body : Buffer.from(body)); }
        const r = await F(`${server}/api/collect?${qs}`, { method: "POST", headers: h, body: b, signal: AbortSignal.timeout(slow ? 150000 : 90000) });
        const txt = await r.text();
        if (r.status >= 500 && t < tries) { await sleep(5000 * t); continue; }
        try { return JSON.parse(txt); } catch (e) { return { ok: false, error: `T-Rex answered ${r.status}: ${txt.slice(0, 150)}` }; }
      } catch (e) { if (t >= tries) return { ok: false, error: "could not reach T-Rex: " + (e.message || e) }; await sleep(5000 * t); }
    }
  }

  let pages = 0, files = 0, failed = 0, built = 0, writes = 0, note = "";
  const st = await trex("status");
  if (!st || !st.ok) { log("Could not use T-Rex: " + (st && st.error)); return { ok: false }; }
  // GitHub gives a private repository 2,000 free minutes a month (more is blocked, never charged, on the free plan).
  // T-Rex counts the minutes used and spreads what is left over the rest of the month, so the runs never stop mid-month.
  if (source === "github" && st.ghMinutes && !o.maxMinutes) {
    const cap = +process.env.TREX_MONTH_MINUTES || 1700, d = new Date(), dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const left = Math.max(0, cap - (st.ghMinutes.used || 0)), runsLeft = Math.max(1, (dim - d.getUTCDate() + 1) * 12 - Math.floor(d.getUTCHours() / 2));
    const per = Math.max(2, Math.min((until - t0) / 60e3, left / runsLeft * 1.5 - 1));          // ~1 minute of each run is GitHub's own setup
    until = t0 + per * 60e3;
    log(`GitHub minutes this month: ${st.ghMinutes.used || 0} of ${cap} used — this run may take up to ${Math.round(per)} min.`);
  }
  const DAILY = o.dailyWrites || 60000;               // free database: ~100,000 row writes a day — stay well below
  let budget = DAILY - ((st.budget && st.budget.used) || 0);
  log(`T-Rex has ${st.companies} companies; ${st.toRead} filings still to read; today's write budget left ≈ ${budget}.`);
  await session();

  // 1) the filings list (newest first)
  let p = 1, blocked = 0, total = st.listTotal || null, complete = false, odd = 0;
  while (Date.now() < until) {
    const r = await nse(LIST(p));
    let res = null;
    if (r.code === 200 && r.body && r.body.length) res = await trex("list", {}, r.body, true);
    if (!res || !res.ok) {
      blocked++; log(`List page ${p}: ${res ? "not accepted — " + res.error : "NSE answered " + r.code}`);
      if (blocked >= 4) { note = "list refused"; break; }
      await sleep(waitBase * blocked); await session(); continue;
    }
    blocked = 0; pages++; writes += res.found + 2; budget -= res.found + 2;
    if (res.total && (!total || res.total > total)) total = res.total;        // trust the largest total seen (NSE sometimes answers a short page)
    if (pages === 1 || pages % 20 === 0) log(`List page ${p}${total ? " of " + Math.ceil(total / 200) : ""}: ${res.found} new filings`);
    if (res.rows < 200 && total && p * 200 < total - 200) {                   // a short page in the middle of the list: NSE glitch, not the end
      odd++; log(`List page ${p}: only ${res.rows} rows although NSE has ${total} filings — asking again`);
      if (odd >= 3) { note = "list incomplete"; break; }
      await sleep(waitBase); await session(); continue;
    }
    if (res.rows < 200 || (total && p * 200 >= total)) { complete = true; break; }
    if (st.fullDone && res.found === 0 && p >= 2) break;          // later runs: only new filings
    p++; await sleep(500);
  }
  if (complete && !st.fullDone) { const d = await trex("listdone", {}, JSON.stringify({ total })); log(d && d.ok ? `Whole NSE filings list read (${total} filings).` : `List not finished yet: ${d && d.error}`); }

  // 1b) company documents (investor presentations, annual reports) for watchlist companies: product & capacity facts
  let ins = { docs: 0, facts: 0 };
  if (!o.skipInsights && Date.now() < until - 120000) {
    try { const { runInsights } = await import("./insights.mjs");
      // when today's database budget for filings is used up, the whole run is free for reading documents
      const docsOnly = budget <= 50;
      ins = await runInsights({ trex, nse, pdfGet, log, until: docsOnly ? until - 60e3 : Math.min(until, Date.now() + 10 * 60e3), geminiKey: o.geminiKey ?? process.env.GEMINI_KEY, fetch: F, ...(o.pdfText ? { pdfText: o.pdfText } : {}), maxDocs: o.maxDocs || (docsOnly ? 25 : 6), extra: o.extra || process.env.TREX_EXTRA || "" });
    } catch (e) { log("Documents step skipped: " + (e.message || e)); }
  }

  // 1c) company info for the Key ratios block (shareholding, pledges, face value; industries weekly) — a few small requests
  if (!o.skipCompanyInfo && !(o.fetch && !o.companyInfo) && Date.now() < until - 90000) {   // (tests with a stand-in fetch test it separately)
    try { const { runCompanyInfo } = await import("./companyinfo.mjs"); await runCompanyInfo({ trex, nse, log, until }); }
    catch (e) { log("Company info step skipped: " + (e.message || e)); }
  }

  // 2) XBRL files, a few at a time
  const seen = new Set(); let blocks = 0, stop = false; const touched = new Set();
  while (!stop && Date.now() < until && budget > 50) {
    const pend = await trex("pending", { limit: 200 });
    if (!pend || !pend.ok) { log("T-Rex problem: " + (pend && pend.error)); break; }
    const todo = (pend.files || []).filter(f => !seen.has(f.xbrl)); if (!todo.length) break;
    todo.forEach(f => seen.add(f.xbrl));
    let i = 0;
    async function worker() {
      while (!stop && i < todo.length) {
        if (Date.now() > until) { note = note || "time limit"; stop = true; break; }
        if (budget < 10) { note = "daily write limit"; stop = true; log("Reached today's safe database limit — the next run continues."); break; }
        const f = todo[i++]; await sleep(gap);
        const r = await nse(f.xbrl);
        if (r.code === 200 && r.body && r.body.length > 300) {
          const res = await trex("file", { symbol: f.symbol, qe: f.qe, xbrl: f.xbrl }, r.body, true);
          if (res && res.ok) { files++; writes += 5; budget -= 5; touched.add(f.symbol); blocks = 0; if (files % 200 === 0) log(`${files} filings read`); }
          else { failed++; log(`Not accepted: ${f.symbol} ${f.qe} — ${res && res.error}`); }
        } else if (r.code === 404 || r.code === 410) { await trex("fail", {}, JSON.stringify({ symbol: f.symbol, qe: f.qe, xbrl: f.xbrl })); failed++; }
        else {
          blocks++; log(`NSE answered ${r.code} for ${f.symbol} — pausing`); seen.delete(f.xbrl);
          if (blocks >= 6) { note = "files refused"; stop = true; log("NSE keeps refusing — stopping; the next run continues."); break; }
          await sleep(waitBase * 1.5 * blocks); await session();
        }
      }
    }
    await Promise.all(Array.from({ length: parallel }, worker));
    const list = [...touched]; touched.clear();
    for (let k = 0; k < list.length; k += 4) { const b = await trex("build", {}, JSON.stringify({ symbols: list.slice(k, k + 4) })); if (b && b.ok) built += b.built; }
  }

  // 3) closing prices (market cap & P/E)
  const ist = new Date(Date.now() + 5.5 * 3600e3);
  for (let d = 0; d < 6; d++) {
    const day = new Date(ist.getTime() - d * 864e5), iso = day.toISOString().slice(0, 10);
    if (st.priceDate && st.priceDate >= iso) break;
    const dd = iso.slice(8, 10) + iso.slice(5, 7) + iso.slice(0, 4);
    const r = await nse(`https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_${dd}.csv`);
    if (r.code === 200 && r.body && r.body.length > 10000) { const res = await trex("prices", { date: iso }, r.body, true); if (res && res.ok) log(`Closing prices of ${iso} sent (${res.prices} stocks).`); break; }
  }

  await trex("done", {}, JSON.stringify({ pages, files, failed, built, writes, note, source, docs: ins.docs, facts: ins.facts, minutes: Math.ceil((Date.now() - t0) / 60e3) + 1 }));
  log(`Finished: ${pages} list pages, ${files} filings read, ${failed} not readable, ${built} companies updated.`);
  const st2 = await trex("status"); if (st2 && st2.ok) log(`T-Rex now has ${st2.companies} companies; ${st2.toRead} filings still to read.`);
  return { ok: true, pages, files, failed, built, note, docs: ins.docs, facts: ins.facts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run().then(r => process.exit(r && r.ok ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
