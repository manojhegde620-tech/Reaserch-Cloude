// T-Rex COMPANY LOGOS — runs on GitHub Actions (free), never on Cloudflare.
// Source: Wikidata, the open database behind Wikipedia. For each company it records the exchange listing with its
// ticker, its official website and (often) its logo file. A company is matched ONLY by its exact NSE ticker on
// Wikidata — never by guessing a name or a web address — so a wrong logo is not possible by design.
//   1) logo file on Wikimedia Commons (P154) → a 128-px PNG thumbnail
//   2) otherwise the official website (P856) → the site's own app icon / favicon (largest one the site offers)
// Saved in the "logo-data" branch: l/SYMBOL.png (or .ico/.svg), l/index.json. One commit replaces the branch.
// Companies without either keep the coloured initials in the app. Logos are public, so these files are not sealed.
// Run: node collector/logos.mjs   (needs TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const BRANCH = "logo-data";
const UA = "T-Rex-logo-collector/1.0 (+https://github.com/manojhegde620-tech/Reaserch-Cloude)";
const WDQ = "https://query.wikidata.org/sparql";
const MAXB = 90 * 1024;                                   // a logo bigger than this is skipped
export const normTicker = t => String(t || "").toUpperCase().replace(/^(NSE|NSEI|NSE\s*INDIA)\s*[:\-]\s*/, "").replace(/\.NS$/, "").trim();
export const domainOf = u => { try { const x = new URL(/^https?:/i.test(u) ? u : "https://" + u); return x.hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return ""; } };
// image type from the first bytes (never trust the server's word for it)
export function imgType(buf) {
  const b = buf && buf.length ? buf : new Uint8Array(0);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
  if (b[0] === 0xFF && b[1] === 0xD8) return "jpg";
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "ico";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "webp";
  const head = new TextDecoder().decode(b.slice(0, 300)).trim().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return null;
}
// icons a home page offers: <link rel="apple-touch-icon" / "icon" sizes="…" href="…"> → biggest first
export function pageIcons(html, base) {
  const out = [];
  for (const m of String(html || "").matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0]; const rel = (tag.match(/\brel\s*=\s*["']([^"']+)["']/i) || [])[1] || ""; if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
    const href = (tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || [])[1]; if (!href || /^data:/i.test(href)) continue;
    const sz = (tag.match(/\bsizes\s*=\s*["'](\d+)x\d+/i) || [])[1];
    let url; try { url = new URL(href, base).href; } catch (e) { continue; }
    out.push({ url, size: sz ? +sz : (/apple-touch/i.test(rel) ? 180 : 32) });
  }
  return out.sort((a, b) => b.size - a.size);
}

export async function runLogos(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const dir = o.dir || "logodata", now = o.now || Date.now();
  const get = (url, ms = 15000, extra = {}) => F(url, { headers: { "User-Agent": UA, ...extra }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  if (!o.skipGit) {
    rmSync(dir, { recursive: true, force: true });
    const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) { log("Logos: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return { ok: false }; }
    const remote = `https://x-access-token:${tok}@github.com/${repo}.git`;
    try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", BRANCH, remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { mkdirSync(dir, { recursive: true }); git("init", "--quiet"); git("remote", "add", "origin", remote); git("checkout", "--quiet", "--orphan", BRANCH); log("Logos: creating the logo-data branch."); }
    git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  } else mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "l"), { recursive: true });
  const ixPath = join(dir, "l", "index.json");
  let ix = { v: 1, t: 0, logos: {}, tried: {} }; try { if (existsSync(ixPath)) ix = { ...ix, ...JSON.parse(readFileSync(ixPath, "utf8")) }; } catch (e) {}
  // 1) the companies T-Rex knows (all listed companies with results)
  let syms = o.symbols || null;
  if (!syms) { try { const j = await F(`${server}/api/collect?action=deeptargets`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()); syms = j && j.ok ? j.symbols : null; } catch (e) {} }
  if (!syms || !syms.length) { log("Logos: could not get the company list from T-Rex."); return { ok: false }; }
  const want = new Set(syms.map(s => String(s).toUpperCase()));
  // 2) Wikidata: every item listed on the National Stock Exchange of India with its ticker, website and logo
  const q = `SELECT ?ticker ?web ?logo WHERE {
    ?ex rdfs:label "National Stock Exchange of India"@en .
    ?item p:P414 ?st . ?st ps:P414 ?ex ; pq:P249 ?ticker .
    OPTIONAL { ?item wdt:P856 ?web } OPTIONAL { ?item wdt:P154 ?logo } }`;
  let rows = [];
  try { const r = await get(`${WDQ}?format=json&query=${encodeURIComponent(q)}`, 90000, { Accept: "application/sparql-results+json" }); const j = await r.json(); rows = (j.results && j.results.bindings) || []; }
  catch (e) { log("Logos: Wikidata did not answer — " + String(e.message || e).slice(0, 80)); return { ok: false }; }
  const info = {}; for (const b of rows) { const t = normTicker(b.ticker && b.ticker.value); if (!t || !want.has(t)) continue; const c = info[t] = info[t] || { web: [], logo: [] };
    if (b.web && !c.web.includes(b.web.value)) c.web.push(b.web.value); if (b.logo && !c.logo.includes(b.logo.value)) c.logo.push(b.logo.value); }
  log(`Logos: Wikidata lists ${rows.length} NSE listings; ${Object.keys(info).length} of ${want.size} T-Rex companies matched by ticker (${Object.values(info).filter(c => c.logo.length).length} with a logo file, ${Object.values(info).filter(c => c.web.length).length} with a website).`);
  // 3) fetch the image for each matched company that has none yet (or whose last try was > 30 days ago)
  const save = (sym, buf, type, src) => { if (!type || buf.length > MAXB || buf.length < 100) return false; const f = `${sym}.${type}`; writeFileSync(join(dir, "l", f), buf); ix.logos[sym] = { f, src, t: now }; return true; };
  const fetchBuf = async (url, ms) => { const r = await get(url, ms); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return b; };
  let added = 0, tried = 0; const todo = Object.keys(info).filter(s => !ix.logos[s] && (!ix.tried[s] || now - ix.tried[s] > 30 * 864e5)).slice(0, o.max || 400);
  for (const sym of todo) {
    tried++; ix.tried[sym] = now; const c = info[sym]; let ok = false;
    for (const lf of c.logo.slice(0, 2)) {                 // Commons file → PNG thumbnail 128 px wide
      if (ok) break; const name = decodeURIComponent(String(lf).split("/").pop() || ""); if (!name) continue;
      try { const b = await fetchBuf(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=128`, 20000); ok = !!(b && save(sym, b, imgType(b), "wikidata")); } catch (e) {}
    }
    for (const w of c.web.slice(0, 1)) {                   // the company's own site: its biggest app icon / favicon
      if (ok) break; const d = domainOf(w); if (!d) continue;
      try { const r = await get(w, 15000, { Accept: "text/html" }); const html = r.ok ? (await r.text()).slice(0, 300000) : ""; const icons = pageIcons(html, r.url || w);
        for (const u of [...icons.map(x => x.url), `https://${d}/apple-touch-icon.png`, `https://www.${d}/apple-touch-icon.png`, `https://${d}/favicon.ico`]) {
          try { const b = await fetchBuf(u, 12000); if (b && save(sym, b, imgType(b), "site")) { ok = true; break; } } catch (e) {} }
      } catch (e) {}
    }
    if (ok) added++;
    if (o.gap) await new Promise(r => setTimeout(r, o.gap));
  }
  ix.t = now; ix.v = 1; writeFileSync(ixPath, JSON.stringify(ix));
  const total = Object.keys(ix.logos).length;
  log(`Logos: ${added} new logos this run (${tried} companies tried) · ${total} companies have a logo in total.`);
  if (!o.skipGit && (added || !existsSync(join(dir, ".git", "refs", "heads", BRANCH)))) {
    try { git("add", "-A"); const tree = git("write-tree"); const c = git("commit-tree", tree, "-m", `logos: ${total} companies`); git("update-ref", "HEAD", c);
      git("push", "--quiet", "--force", "origin", "HEAD:" + BRANCH); log("Logos: saved to GitHub."); }
    catch (e) { log("Logos: could not save — " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  }
  return { ok: true, matched: Object.keys(info).length, added, total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runLogos({ gap: 150 }).then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(0); });
