// T-Rex GitHub copy ("mirror") of the public market data.
// After each collector run, the answers T-Rex gives for public market data — company results (both views, with
// segments, balance sheet and cash flow), the results list, the whole-market table, Business · AI and company info
// for watchlist companies — are saved as files in the "gh-pages" branch of this public repository. The app reads them
// from raw.githubusercontent.com whenever Cloudflare (or its database) cannot answer. Clients and holdings are never
// included. The branch is kept as ONE commit (replaced each run), so the repository does not grow with history.
// Run: node collector/mirror.mjs   (needs TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// the same key the app uses for its saved copies (offline-cache.js → ocKey): path + sorted query, cache-busters removed
export function mirrorKey(url) {
  const u = new URL(url, "https://x.invalid"); ["v", "fresh", "_", "t"].forEach(p => u.searchParams.delete(p)); u.searchParams.sort();
  return u.pathname.replace(/^\/\.netlify\/functions\//, "/api/") + "?" + u.searchParams.toString();
}
export const mirrorPath = key => { const h = createHash("sha1").update(key).digest("hex"); return `m/${h.slice(0, 2)}/${h}.json`; };
const good = j => j && typeof j === "object" && j.ok !== false && !j.error && !j.partial;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const istDates = n => { const out = []; const now = Date.now() + 5.5 * 3600e3; for (let i = 0; i < n; i++) { const d = new Date(now - i * 864e5); out.push(`${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`); } return out; };

export async function runMirror(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const dir = o.dir || "site", until = Date.now() + (o.maxMinutes || +process.env.TREX_MIRROR_MINUTES || 10) * 60e3;
  const maxCo = o.maxCompanies || 250;
  if (!key) { log("Mirror: TREX_KEY is not set."); return { ok: false }; }
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  // 1) the current copy (or a fresh, empty branch the first time)
  if (!o.skipGit) {
    rmSync(dir, { recursive: true, force: true });
    const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) { log("Mirror: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return { ok: false }; }
    const remote = `https://x-access-token:${tok}@github.com/${repo}.git`;
    try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", "gh-pages", remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { mkdirSync(dir, { recursive: true }); git("init", "--quiet"); git("remote", "add", "origin", remote); log("Mirror: creating the gh-pages branch for the first time."); }
  } else mkdirSync(dir, { recursive: true });
  const manPath = join(dir, "m", "manifest.json");
  let man = { companies: {}, t: 0 }; try { if (existsSync(manPath)) man = JSON.parse(readFileSync(manPath, "utf8")); } catch (e) {}
  man.companies = man.companies || {};
  let saved = 0, failed = 0;
  const save = async (path) => {                                  // fetch one T-Rex answer and store it under the app's key
    try {
      const r = await F(server + path, { signal: AbortSignal.timeout(45000) }); if (!r.ok) { failed++; return null; }
      const j = await r.json(); if (!good(j)) return null;
      j._mirror = Date.now(); const p = join(dir, mirrorPath(mirrorKey(path)));
      mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify(j)); saved++; return j;
    } catch (e) { failed++; return null; }
  };
  // 2) what to copy
  const lr = await F(`${server}/api/collect?action=mirrorlist`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()).catch(e => ({ ok: false, error: String(e.message || e) }));
  if (!lr || !lr.ok) { log("Mirror: T-Rex problem: " + (lr && lr.error)); return { ok: false }; }
  // whole-market table (default order) + database progress — every 6 hours (each page is a big database query)
  await save("/api/db?stats=1");
  await save("/api/db?world=1");                                   // World watch (public data only)
  if (!man.screenT || Date.now() - man.screenT > 6 * 3600e3) { man.screenT = Date.now();
    // ONE database query per view (all rows), cut here into the same 100-row pages the app asks for — instead of ~50 paged queries
    for (const v of ["consolidated", "standalone"]) for (const qe of [null, lr.qe].filter((x, i) => i === 0 || x)) {
      const base = { screen: "1", view: v, sort: "mcap", dir: "desc" }; if (qe) base.qe = qe;
      let j = null; try { const r = await F(`${server}/api/db?${new URLSearchParams({ ...base, all: "1" })}`, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }); if (r.ok) j = await r.json(); } catch (e) {}
      if (!good(j) || !j.all) { failed++; continue; }
      const rows = j.rows || [];
      for (let p = 0; p * 100 < Math.max(1, rows.length) && p < 60; p++) {
        const page = { ok: true, qe: j.qe, view: j.view, sort: j.sort, dir: j.dir, page: p, size: 100, total: j.total, rows: rows.slice(p * 100, p * 100 + 100), _mirror: Date.now() };
        const fp = join(dir, mirrorPath(mirrorKey("/api/db?" + new URLSearchParams({ ...base, page: String(p) })))); mkdirSync(join(fp, ".."), { recursive: true }); writeFileSync(fp, JSON.stringify(page)); saved++;
        if (p === 0) { const fp0 = join(dir, mirrorPath(mirrorKey("/api/db?" + new URLSearchParams(base)))); mkdirSync(join(fp0, ".."), { recursive: true }); writeFileSync(fp0, JSON.stringify(page)); }   // the app may ask without page=0
      }
    } }
  // results list: latest + each of the last 7 days, and the result cards the list does not already carry
  const cards = new Set();
  for (const d of [null, ...istDates(7)]) {
    if (Date.now() > until) break;
    const j = await save(`/api/results?feed=1&page=1${d ? "&date=" + d : ""}`);
    for (const r of (j && j.rows) || []) if (r.symbol && r.qe && !(r.sum && r.sum.v === 2)) cards.add(r.symbol + "|" + r.qe);
  }
  let nc = 0;
  for (const c of cards) { if (Date.now() > until || nc >= 200) break; const [s, qe] = c.split("|");
    await save(`/api/results?summary=${encodeURIComponent(s)}&qe=${qe}&view=consolidated`); nc++; }
  // watchlist companies: Business · AI and company info
  for (const s of lr.watch || []) { if (Date.now() > until) break; await save(`/api/db?insights=${encodeURIComponent(s)}`); await save(`/api/db?cinfo=${encodeURIComponent(s)}`); }
  // company views: new or changed companies first (watchlist first), a few hundred per run
  const todo = (lr.companies || []).filter(c => man.companies[c.s] !== c.t);
  const w = new Set(lr.watch || []); todo.sort((a, b) => (w.has(b.s) - w.has(a.s)) || ((man.companies[a.s] ? 1 : 0) - (man.companies[b.s] ? 1 : 0)));
  let nco = 0;
  for (const c of todo) {
    if (Date.now() > until || nco >= maxCo) break;
    const a = await save(`/api/results?symbol=${encodeURIComponent(c.s)}&n=16&view=consolidated`);
    const b = await save(`/api/results?symbol=${encodeURIComponent(c.s)}&n=16&view=standalone`);
    if (a || b) { man.companies[c.s] = c.t; nco++; }
    await sleep(50);
  }
  man.t = Date.now(); man.server = server; mkdirSync(join(dir, "m"), { recursive: true }); writeFileSync(manPath, JSON.stringify(man));
  writeFileSync(join(dir, "README.md"), "Public market-data copy for T-Rex (results from companies' NSE filings). Generated automatically; replaced on every run. Contains no personal data.\n");
  const total = Object.keys(man.companies).length;
  log(`Mirror: ${saved} files saved (${nco} companies updated, ${total} of ${(lr.companies || []).length} companies in the GitHub copy)${failed ? `, ${failed} not available` : ""}.`);
  // 3) one fresh commit replaces the branch (no history kept → the repository stays small)
  if (!o.skipGit) {
    try {
      git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
      git("checkout", "--quiet", "--orphan", "trex-new"); git("add", "-A"); git("commit", "--quiet", "-m", `T-Rex market-data copy ${new Date().toISOString().slice(0, 16)}Z`);
      git("push", "--quiet", "--force", "origin", "trex-new:gh-pages"); log("Mirror: published to the gh-pages branch.");
    } catch (e) { log("Mirror: could not publish: " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 300)); return { ok: false, saved }; }
  }
  return { ok: true, saved, companies: nco, total };
}
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) runMirror().then(r => process.exit(r && r.ok ? 0 : 0));
