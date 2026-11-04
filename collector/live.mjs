// T-Rex LIVE COMPANY FILES — a ready-made file for every company, kept up to date as results are filed.
// Runs on GitHub Actions (public repository: free). Every 5 minutes (07:30–24:00 IST) it looks at NSE's list of new
// results filings; for each new one it asks T-Rex for that company's quarters (the same answer the app gets) and saves it as
// c/SYMBOL.json in the "co-data" branch of this repository. The app opens a company from that file at once (like Screener)
// and only asks T-Rex itself when the file is old. Every other company is filled in the background and refreshed weekly.
// T-Rex is asked for its database copy only (?dbonly=1 — never a slow NSE read), so Cloudflare's free limits are hardly used.
// Logs are public: they show counts only, never company names.
// Run: node collector/live.mjs   (needs TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runWorld } from "./world.mjs";
import { sealText, openText, sealOn, sealTree } from "./seal.mjs";

export const LIVE_VERSION = 1;
export const BRANCH = "co-data";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-integrated-filing";
const LIST = p => `https://www.nseindia.com/api/integrated-filing-results?type=Integrated%20Filing-%20Financials&page=${p}&size=200`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MON = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
export function qeKey(s) { const m = String(s || "").toUpperCase().match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/); return m ? `${m[3]}-${MON[m[2]]}-${m[1].padStart(2, "0")}` : (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : ""); }
const isStand = b => /^(stand|non-con)/i.test(String(b || ""));
// IST clock: active 07:30–24:00 (results are filed in the day and evening)
export function activeNow(t = Date.now()) { const d = new Date(t + 5.5 * 3600e3); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 7 * 60 + 30; }
const sig = j => JSON.stringify(((j && j.quarters) || []).map(x => [x.qe, x.sales, x.np, x.opProfit, x.eps]));
export function hasQe(file, qe, basis) {
  const v = (isStand(basis) ? [file && file.s, file && file.c] : [file && file.c, file && file.s]).filter(Boolean);
  return v.some(j => (j.quarters || []).some(x => x.qe === qe && !x.error));
}

export async function runLive(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://trex.agilenox.in").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const now = o.now || (() => Date.now());
  const t0 = now(), until = t0 + (o.maxMinutes ?? (+process.env.TREX_LIVE_MINUTES || 340)) * 60e3;
  const loopMs = o.loopMs ?? 5 * 60e3, backfillMs = o.backfillMs ?? 150e3, dir = o.dir || "codata";
  if (!key) { log("Live company files: TREX_KEY is not set."); return { ok: false }; }
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  // 1) the files saved so far (or a new, empty branch)
  if (!o.skipGit) {
    rmSync(dir, { recursive: true, force: true });
    const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) { log("Live company files: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return { ok: false }; }
    const remote = `https://x-access-token:${tok}@github.com/${repo}.git`;
    try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", BRANCH, remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { mkdirSync(dir, { recursive: true }); git("init", "--quiet"); git("remote", "add", "origin", remote); git("checkout", "--quiet", "--orphan", BRANCH); log("Live company files: creating the co-data branch."); }
    git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  } else mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "c"), { recursive: true });
  const stPath = join(dir, "c", "_state.json");
  let st = { v: LIVE_VERSION, seen: {}, pend: {}, cursor: 0, full: 0, n: 0 }; try { if (existsSync(stPath)) st = { ...st, ...JSON.parse(readFileSync(stPath, "utf8")) }; } catch (e) {}
  const fileOf = sym => join(dir, "c", sym + ".json");
  const load = async sym => { try { return await openText(readFileSync(fileOf(sym), "utf8")); } catch (e) { return null; } };   // sealed or plain
  const ageT = sym => { try { const o = JSON.parse(readFileSync(fileOf(sym), "utf8")); return (o && o.t) || 0; } catch (e) { return null; } };   // the time is outside the seal
  let sealedN = 0; if (sealOn()) { try { const n = await sealTree(join(dir, "c"), undefined, new Set(["_state.json"])); sealedN = n; if (n) { log(`Live company files: ${n} older files sealed (encrypted).`); } } catch (e) { log("Live company files: sealing skipped — " + String(e.message || e).slice(0, 80)); } }
  let dirty = 0, stDirty = 0, lastPush = now();
  dirty += sealedN;                              // older plain files were sealed: save them (one commit replaces the branch)
  const publish = (msg, force) => {
    // keep only the newest seen-marks (10 days) so the state file stays small
    const cut = now() - 10 * 864e5; for (const [k, t] of Object.entries(st.seen)) if (t < cut) delete st.seen[k];
    writeFileSync(stPath, JSON.stringify(st));
    if (o.skipGit || !(dirty || (stDirty && (force || now() - lastPush > 30 * 60e3)))) return; dirty = 0; stDirty = 0; lastPush = now();
    try { git("add", "-A"); const tree = git("write-tree"); const c = git("commit-tree", tree, "-m", msg); git("update-ref", "HEAD", c);   // one commit only: the branch never grows
      git("push", "--quiet", "--force", "origin", "HEAD:" + BRANCH); log("Live company files: saved to GitHub (" + msg + ")."); }
    catch (e) { log("Live company files: could not save to GitHub: " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  };
  // 2) T-Rex: the company's quarters from its database (never NSE), or — for a brand-new filing — read fresh once
  const ask = async (url, ms = 30000) => { try { const r = await F(url, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(ms) }); return await r.json(); } catch (e) { return null; } };
  const view = (sym, v, fresh) => ask(`${server}/api/results?symbol=${encodeURIComponent(sym)}&n=16&view=${v}${fresh ? "&fresh=1" : "&dbonly=1"}`, fresh ? 45000 : 30000);
  const good = j => j && j.ok && !j.partial && Array.isArray(j.quarters) && j.quarters.length;
  let freshLeft = 0;                             // fresh NSE reads through T-Rex: at most 8 per check (NSE stays friendly)
  async function build(sym, need) {              // → true when the file is complete (and has the quarter needed, if any)
    const old = await load(sym);
    let c = await view(sym, "consolidated"), s = await view(sym, "standalone");
    let file = { v: LIVE_VERSION, sym, t: now(), name: (good(c) && c.name) || (good(s) && s.name) || (old && old.name) || sym, c: good(c) ? c : (old && old.c) || null, s: good(s) ? s : (old && old.s) || null };
    if (need && !hasQe(file, need.qe, need.basis) && freshLeft > 0 && (!st.pend[need.k] || now() - (st.pend[need.k].f || 0) > 30 * 60e3)) {
      freshLeft--;   // not in the database yet: read fresh (at most every 30 min)
      st.pend[need.k] = { ...(st.pend[need.k] || { t: now() }), f: now() };
      const fv = isStand(need.basis) ? "standalone" : "consolidated"; const j = await view(sym, fv, true);
      if (good(j)) file[fv === "standalone" ? "s" : "c"] = j;
    }
    if (!file.c && !file.s) return false;
    if (!old || sig(old.c) !== sig(file.c) || sig(old.s) !== sig(file.s) || !old.t || now() - old.t > 6 * 864e5) { writeFileSync(fileOf(sym), await sealText(file)); dirty++; st.n = (st.n || 0) + (old ? 0 : 1); }
    return need ? hasQe(file, need.qe, need.basis) : true;
  }
  // 3) NSE's list of new filings — from GitHub directly; if NSE refuses, T-Rex's own copy of the same list
  const jar = new Map();
  const keep = r => { const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  const session = async () => { try { const r = await F(REF, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(20000) }); keep(r); await r.arrayBuffer(); } catch (e) {} };
  let nseFails = 0;
  async function newFilings() {
    if (nseFails < 3) {
      try { if (!jar.size) await session();
        const r = await F(LIST(1), { headers: { "User-Agent": UA, "Accept": "*/*", "Referer": REF, ...(jar.size ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(30000) }); keep(r);
        if (r.status === 200) { const j = JSON.parse(await r.text()); nseFails = 0; return { src: "nse", rows: (j.data || []).map(x => ({ symbol: x.symbol, qe: qeKey(x.qe_Date), basis: x.consolidated, filed: x.broadcast_Date || x.creation_Date })) }; }
        nseFails++; jar.clear();
      } catch (e) { nseFails++; jar.clear(); }
    }
    if (nseFails >= 3 && nseFails++ > 12) nseFails = 0;                // try NSE again after about an hour
    const rows = [];
    for (const p of [1, 2]) { const j = await ask(`${server}/api/results?feed=1&page=${p}`); if (!j || !j.ok) break; for (const x of j.rows || []) rows.push({ symbol: x.symbol, qe: x.qe, basis: x.consolidated || (x.sum && x.sum.basis) || "", filed: x.filed }); if ((j.rows || []).length < 60) break; }
    return { src: "trex", rows };
  }
  // 4) every company once (then weekly) — alphabetical, so the order says nothing about your watchlist
  let all = null;
  async function everyone() {
    if (all) return all;
    if (st.list && st.list.length && now() - (st.listT || 0) < 864e5) return (all = st.list);
    try { const r = await F(`${server}/api/collect?action=deeptargets`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }); const j = await r.json();
      if (j && j.ok && j.symbols.length) { st.list = j.symbols.filter(x => /^[A-Z0-9&\-]{1,20}$/.test(x)).sort(); st.listT = now(); stDirty = 1; } }
    catch (e) {}
    return (all = st.list || []);
  }
  // 5) the loop: every 5 minutes in the day (07:30–24:00 IST), every 30 minutes at night
  let loops = 0, built = 0, newOnes = 0, filled = 0, worldT = 0;
  const worldEvery = o.worldEvery ?? 30 * 60e3, doWorld = o.world || runWorld;
  while (now() < until - 60e3) {
    const tl = now(); loops++; const day = activeNow(tl) || o.always;
    // a) new filings
    const nf = await newFilings(); let done = 0; freshLeft = o.maxFresh ?? 8;
    const want = new Map();
    for (const r of nf.rows) { if (!r.symbol || !r.qe || !/^[A-Z0-9&\-]{1,20}$/.test(r.symbol)) continue; const k = `${r.symbol}|${r.qe}|${isStand(r.basis) ? "S" : "C"}`; if (st.seen[k]) continue;
      if (!want.has(r.symbol)) want.set(r.symbol, { k, qe: r.qe, basis: r.basis, more: [] }); else want.get(r.symbol).more.push(k); }
    for (const [sym, need] of [...want].slice(0, o.maxNew || 40)) {
      if (now() > until - 60e3) break;
      const ok = await build(sym, need); built++; stDirty = 1;
      if (ok) { st.seen[need.k] = now(); for (const k of need.more) st.seen[k] = now(); delete st.pend[need.k]; done++; }
      else { const p = st.pend[need.k] = st.pend[need.k] || { t: now() }; if (now() - p.t > 8 * 3600e3) { st.seen[need.k] = now(); delete st.pend[need.k]; } }   // give up after 8 hours (the weekly refresh catches it)
    }
    newOnes += done;
    if (want.size && nf.src === "nse" && done < want.size) await ask(`${server}/api/results?feed=1&page=1`);   // nudge T-Rex to notice them too
    // b) the background fill: every company once, then weekly (3 at a time)
    const list = await everyone(); const bUntil = Math.min(now() + backfillMs, until - 60e3);
    if (list.length) {
      if (st.cursor >= list.length && now() - (st.full || 0) > 7 * 864e5) st.cursor = 0;
      st.miss = st.miss || {};
      const one = async () => { while (st.cursor < list.length && now() < bUntil) { const sym = list[st.cursor++]; stDirty = 1; const ft = ageT(sym); if (ft != null && now() - ft < 6 * 864e5) continue;
        if (await build(sym, null)) { filled++; delete st.miss[sym]; } else st.miss[sym] = now(); if (o.gap) await sleep(o.gap); } };
      await Promise.all([one(), one(), one()]);
      // companies whose database copy was not complete yet: tried again every 30 minutes (database only — never NSE)
      const again = Object.entries(st.miss).filter(([, t]) => now() - t > 30 * 60e3).slice(0, 40);
      for (const [sym] of again) { if (now() > until - 60e3) break; if (await build(sym, null)) { filled++; delete st.miss[sym]; } else st.miss[sym] = now(); stDirty = 1; }
      if (st.cursor >= list.length && now() - (st.full || 0) > 7 * 864e5) st.full = now();
    }
    // c) World watch every 30 minutes: saved here (the app reads it from GitHub) and sent to T-Rex for change alerts
    if (!o.skipWorld && now() - worldT >= worldEvery) { worldT = now();
      try { const wp = join(dir, "c", "_world.json"); let prevW = null; try { prevW = await openText(readFileSync(wp, "utf8")); } catch (e) {}
        const wr = await doWorld({ server, key, fetch: F, log, now: now(), ...(prevW ? { prev: prevW } : {}) });
        if (wr && wr.snap) { writeFileSync(wp, await sealText(wr.snap)); dirty++; } } catch (e) { log("World watch: skipped this time — " + String(e.message || e).slice(0, 80)); } }
    publish(`company files: ${done} new results, ${filled} filled`);
    log(`Live company files: check ${loops} — ${want.size} new filings (${done} saved, list from ${nf.src}); background ${Math.min(st.cursor, list.length)} of ${list.length} companies.`);
    if (o.once) break;
    const wait = (day ? loopMs : (o.nightMs ?? 30 * 60e3)) - (now() - tl);
    if (wait > 0) { if (now() + wait >= until - 60e3) break; await sleep(wait); }
  }
  publish("company files", true);
  // keep going: start the next run straight away (GitHub's own timer is unreliable) — unless this run ended early by mistake
  if (!o.skipGit && now() - t0 > 20 * 60e3) { try { writeFileSync(join(tmpdir(), "trex-live-more"), "1"); } catch (e) {} }
  log(`Live company files: ${loops} checks, ${newOnes} new results saved, ${filled} companies filled · ${Object.keys(st.seen).length} filings tracked.`);
  return { ok: true, loops, built, newOnes, filled, cursor: st.cursor, total: all ? all.length : 0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runLive().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(0); });
