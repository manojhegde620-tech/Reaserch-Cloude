// T-Rex COMPANY LOGOS — runs on GitHub Actions (free), never on Cloudflare.
// Sources, each matched ONLY by an exact identifier (never by guessing a name), so a wrong logo is not possible by design:
//   0) logopack/*.tar — the owner's own collection, one SYMBOL.webp per NSE symbol (first choice)
//   a) collector/sites.json — each company's own website as the company itself registered it with BSE
//      (BSE "Company information": NSE symbol → BSE code → ISIN → website). Refreshed by hand now and then.
//   b) Wikidata, the open database behind Wikipedia: the NSE listing with its ticker, or the ISIN (from a),
//      the official website and (often) the logo file.
//   1) logo file on Wikimedia Commons (P154) → a 128-px PNG thumbnail
//   2) otherwise the company's website → the site's own app icon / favicon (largest one the site offers, at least 32 px)
// Saved in the "logo-data" branch: l/SYMBOL.png (or .ico/.svg), l/index.json. One commit replaces the branch.
// Companies without either keep the coloured initials in the app. Logos are public, so these files are not sealed.
// Run: node collector/logos.mjs   (needs TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const BRANCH = "logo-data";
const UA = "T-Rex-logo-collector/1.0 (+https://github.com/manojhegde620-tech/Reaserch-Cloude)";
const WDQ = "https://query.wikidata.org/sparql";
const MAXB = 90 * 1024;                                   // a logo bigger than this is skipped
export const normTicker = t => String(t || "").toUpperCase().replace(/^(NSE|NSEI|NSE\s*INDIA)\s*[:\-]\s*/, "").replace(/\.NS$/, "").trim();
// NSE's list of equities (SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE) → ISIN → symbol
export function isinMap(csv) {
  const lines = String(csv || "").split(/\r?\n/).filter(Boolean); if (!lines.length) return {};
  const head = lines[0].split(",").map(h => h.trim().toUpperCase()); const si = head.indexOf("SYMBOL"), ii = head.findIndex(h => h.startsWith("ISIN"));
  if (si < 0 || ii < 0) return {}; const out = {};
  for (const l of lines.slice(1)) { const c = l.split(","); const sym = (c[si] || "").trim().toUpperCase(), isin = (c[ii] || "").trim().toUpperCase(); if (/^IN[A-Z0-9]{10}$/.test(isin) && sym) out[isin] = sym; }
  return out;
}
// a website as companies write it ("www.x.com", "http://x.co.in/", "NA", "-") → "https://www.x.com" or ""
export function cleanSite(u) {
  const s = String(u || "").trim().split(/[\s,;]+/)[0].replace(/^(https?:)?\/*/i, "").replace(/\/+$/, "");
  if (!s || /\s/.test(s) || !/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(s) || /(^|\.)(bseindia|nseindia|gmail|yahoo|rediffmail)\./i.test(s)) return "";
  return "https://" + s.toLowerCase();
}
// pixel size of an image (largest side) — PNG / ICO / GIF; null when unknown (JPEG, WebP, SVG)
export function imgSide(buf, type) {
  const b = buf || new Uint8Array(0);
  if (type === "png" && b.length >= 24) return Math.max((b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0);
  if (type === "gif" && b.length > 10) return Math.max(b[6] | b[7] << 8, b[8] | b[9] << 8);
  if (type === "ico" && b.length > 6) { const n = b[4] | b[5] << 8; let m = 0; for (let i = 0; i < n && 6 + 16 * i + 1 < b.length; i++) m = Math.max(m, b[6 + 16 * i] || 256, b[7 + 16 * i] || 256); return m; }
  return null;
}
export const hashOf = b => createHash("sha1").update(b).digest("hex").slice(0, 20);
// two websites of one business family ("adani.com" / "adanigreenenergy.com"): same first 4+ letters of the main name
export function sameFamily(a, b) {
  const core = d => String(d || "").toLowerCase().replace(/^www\./, "").split(".").filter(x => !/^(com|co|in|net|org|ltd|biz|bank|ai|tech|group|global|one|info)$/.test(x)).sort((x, y) => y.length - x.length)[0] || "";
  const x = core(a), y = core(b); if (!x || !y) return false; let i = 0; while (i < x.length && x[i] === y[i]) i++; return i >= 4 || x.includes(y) || y.includes(x);
}
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
  const server = (o.server || process.env.TREX_SERVER || "https://trex.agilenox.in").replace(/\/$/, "");
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
  catch (e) { log("Logos: Wikidata did not answer — " + String(e.message || e).slice(0, 80)); rows = []; }
  const info = {}; for (const b of rows) { const t = normTicker(b.ticker && b.ticker.value); if (!t || !want.has(t)) continue; const c = info[t] = info[t] || { web: [], logo: [] };
    if (b.web && !c.web.includes(b.web.value)) c.web.push(b.web.value); if (b.logo && !c.logo.includes(b.logo.value)) c.logo.push(b.logo.value); }
  const nTick = Object.keys(info).length;
  // 2a) each company's own website as registered with BSE (collector/sites.json: {sites:{SYM:{isin,web}}})
  let sites = o.sites || null;
  if (!sites) { try { sites = JSON.parse(readFileSync(new URL("./sites.json", import.meta.url), "utf8")).sites || {}; } catch (e) { sites = {}; } }
  const im = {}; let bySite = 0;
  for (const [s, v] of Object.entries(sites)) { const t = String(s).toUpperCase(); if (!want.has(t) || !v) continue;
    if (v.isin && /^IN[A-Z0-9]{10}$/.test(v.isin)) im[String(v.isin).toUpperCase()] = t;
    const w = cleanSite(v.web); if (!w) continue; if (!info[t]) bySite++; const c = info[t] = info[t] || { web: [], logo: [] };
    if (!c.web.some(x => domainOf(x) === domainOf(w))) c.web.unshift(w); }   // the company's own registered site first
  log(`Logos: ${Object.keys(sites).length} company websites on file (BSE); ${bySite} more companies covered that way.`);
  // 2b) Wikidata by ISIN (P946) — ISINs from the same file
  let byIsin = 0;
  try {
    const nIsin = Object.keys(im).length;
    if (nIsin) {
      const q2 = `SELECT ?isin ?web ?logo WHERE { ?item wdt:P946 ?isin . FILTER(STRSTARTS(?isin, "INE")) OPTIONAL { ?item wdt:P856 ?web } OPTIONAL { ?item wdt:P154 ?logo } }`;
      const r2 = await get(`${WDQ}?format=json&query=${encodeURIComponent(q2)}`, 90000, { Accept: "application/sparql-results+json" }); const j2 = await r2.json();
      for (const b of (j2.results && j2.results.bindings) || []) { const t = im[String(b.isin && b.isin.value || "").toUpperCase()]; if (!t || !want.has(t)) continue;
        if (!info[t]) byIsin++; const c = info[t] = info[t] || { web: [], logo: [] };
        if (b.web && !c.web.includes(b.web.value)) c.web.push(b.web.value); if (b.logo && !c.logo.includes(b.logo.value)) c.logo.push(b.logo.value); }
    }
    log(`Logos: ${nIsin} ISINs checked on Wikidata; ${byIsin} more companies matched by ISIN.`);
  } catch (e) { log("Logos: ISIN match skipped this time — " + String(e.message || e).slice(0, 80)); }
  log(`Logos: Wikidata lists ${rows.length} NSE listings (${nTick} T-Rex companies by ticker); ${Object.keys(info).length} of ${want.size} companies covered in all (${Object.values(info).filter(c => c.logo.length).length} with a logo file, ${Object.values(info).filter(c => c.web.length).length} with a website).`);
  // 3) fetch the image for each matched company that has none yet (or whose last try was > 30 days ago)
  let changed = false;
  if (ix.sv !== 2) {                                       // the website list is new: give every company a fresh try once,
    ix.tried = {}; ix.sv = 2; changed = true;              // and drop earlier icons too small to look sharp (< 32 px)
    for (const [s, v] of Object.entries(ix.logos)) { try { const p = join(dir, "l", v.f), b = readFileSync(p); const side = imgSide(b, imgType(b));
      if (side != null && side < 32) { delete ix.logos[s]; rmSync(p, { force: true }); } } catch (e) { delete ix.logos[s]; } }
  }
  // generic placeholder icons (WordPress "W", web-host defaults, Google's grey globe) are not the company's logo:
  // their fingerprints are kept in ix.bad and refused from then on
  // the logo pack (logopack/*.tar in this repository: SYMBOL.webp, 96 px, collected by the owner) — first choice for every
  // company it covers; read again only when the pack files change
  try {
    const packDir = o.packDir || fileURLToPath(new URL("../logopack/", import.meta.url));
    const tars = existsSync(packDir) ? readdirSync(packDir).filter(f => /\.tar$/i.test(f)).sort() : [];
    const bsePath = join(packDir, "bse.json");
    const sig = tars.map(f => f + ":" + statSync(join(packDir, f)).size).join("|") + (existsSync(bsePath) ? "|bse:" + statSync(bsePath).size : "");
    if (tars.length && ix.pack !== sig) {
      const tmp = join(tmpdir(), "trex-pack-" + Date.now()); mkdirSync(tmp, { recursive: true }); let n = 0;
      for (const t of tars) execFileSync("tar", ["-xf", join(packDir, t), "-C", tmp], { stdio: ["ignore", "pipe", "pipe"] });
      for (const f of readdirSync(tmp)) {
        const m = f.match(/^([A-Z0-9&\-]{1,20})\.(webp|png|jpg)$/i); if (!m) continue;
        const b = readFileSync(join(tmp, f)); const type = imgType(b); if (!type || type === "svg" || b.length > MAXB || b.length < 100) continue;
        const s = m[1].toUpperCase(), nf = `${s}.${type}`, old = ix.logos[s];
        if (old && old.f !== nf) rmSync(join(dir, "l", old.f), { force: true });
        writeFileSync(join(dir, "l", nf), b); ix.logos[s] = { f: nf, src: "pack", t: now, h: hashOf(b) }; n++;
      }
      // BSE: the scrip code (how T-Rex names BSE listings, e.g. 500002.BO) → the same company's logo. "same" = the NSE
      // symbol of the same company (logo already in the NSE pack); "bseOnly" = files CODE.webp in the bse tars.
      let nb = 0;
      try { const bm = existsSync(bsePath) ? JSON.parse(readFileSync(bsePath, "utf8")) : null;
        for (const [code, sym] of Object.entries((bm && bm.same) || {})) { if (!/^\d{6}$/.test(code)) continue; const t = ix.logos[String(sym).toUpperCase()]; if (t && t.src === "pack") { ix.logos[code] = { f: t.f, src: "pack", t: now, h: t.h, alias: String(sym).toUpperCase() }; nb++; } }
        for (const [code, sym] of Object.entries((bm && bm.bseOnly) || {})) { const t = ix.logos[code]; const S = String(sym).toUpperCase();
          if (t && sites && sites[S] && !ix.logos[S]) ix.logos[S] = { ...t, alias: code };    // the NSE symbol too, only when BSE's own list ties it to this company
          if (t) nb++; }
      } catch (e) {}
      rmSync(tmp, { recursive: true, force: true }); ix.pack = sig; changed = true; log(`Logos: ${n} logos taken from the logo pack (${nb} BSE codes covered).`);
    }
  } catch (e) { log("Logos: logo pack skipped — " + String(e.message || e).slice(0, 80)); }
  ix.bad = ix.bad || {};
  const siteOf = s => (ix.logos[s] && ix.logos[s].d) || domainOf((info[s] && info[s].web[0]) || (sites[s] && cleanSite(sites[s].web)) || "");
  try { const r = await get("https://www.google.com/s2/favicons?domain=no-such-site.invalid&sz=128", 12000); const b = new Uint8Array(await r.arrayBuffer()); if (b.length) ix.bad[hashOf(b)] = "google-default"; } catch (e) {}
  const dropGeneric = () => {                              // the same picture for companies of different groups = a placeholder
    const g = {}; let n = 0;
    for (const [s, v] of Object.entries(ix.logos)) { if (v.src !== "site") continue; try { const h = v.h || (v.h = hashOf(readFileSync(join(dir, "l", v.f)))); (g[h] = g[h] || []).push(s); } catch (e) {} }
    for (const [h, list] of Object.entries(g)) {
      const fam = list.map(siteOf); const one = list.length > 1 && fam.every(d => sameFamily(d, fam[0]));
      if (!ix.bad[h] && (list.length < 2 || one)) continue;
      ix.bad[h] = ix.bad[h] || "shared"; for (const s of list) { rmSync(join(dir, "l", ix.logos[s].f), { force: true }); delete ix.logos[s]; delete ix.tried[s]; n++; }
    }
    if (n) changed = true; return n;
  };
  const dropped0 = dropGeneric(); if (dropped0) log(`Logos: ${dropped0} placeholder icons removed (not real company logos).`);
  const save = (sym, buf, type, src, d) => { if (!type || buf.length > MAXB || buf.length < 100) return false;
    if (src === "site" && type === "svg") return false;      // site SVGs can carry scripts / odd sizes — keep to bitmaps
    const side = imgSide(buf, type); if (side != null && side < 32) return false;   // a 16-px favicon would look blurred
    const h = hashOf(buf); if (ix.bad[h]) return false;      // a known placeholder
    const f = `${sym}.${type}`; writeFileSync(join(dir, "l", f), buf); ix.logos[sym] = { f, src, t: now, h, ...(d ? { d } : {}) }; return true; };
  const fetchBuf = async (url, ms) => { const r = await get(url, ms); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return b; };
  let added = 0, tried = 0; const todo = Object.keys(info).filter(s => !ix.logos[s] && (!ix.tried[s] || now - ix.tried[s] > 30 * 864e5)).slice(0, o.max || 3000);
  const until = now + (o.budgetMs || 40 * 60e3);           // stop in time to save; the rest is picked up next run
  const one = async sym => {
    tried++; ix.tried[sym] = now; const c = info[sym]; let ok = false;
    for (const lf of c.logo.slice(0, 2)) {                 // Commons file → PNG thumbnail 128 px wide
      if (ok) break; const name = decodeURIComponent(String(lf).split("/").pop() || ""); if (!name) continue;
      try { const b = await fetchBuf(`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=128`, 20000); ok = !!(b && save(sym, b, imgType(b), "wikidata")); } catch (e) {}
    }
    for (const w of c.web.slice(0, 2)) {                   // the company's own site: its biggest app icon / favicon
      if (ok) break; const d = domainOf(w); if (!d) continue;
      let icons = [];
      try { const r = await get(w, 15000, { Accept: "text/html" }); const html = r.ok ? (await r.text()).slice(0, 300000) : ""; icons = pageIcons(html, r.url || w); } catch (e) {}
      for (const u of [...icons.map(x => x.url).slice(0, 6), `https://${d}/apple-touch-icon.png`, `https://www.${d}/apple-touch-icon.png`, `https://${d}/favicon.ico`, `https://www.${d}/favicon.ico`,
                       `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`]) {   // last: Google's copy of the same site's icon
        try { const b = await fetchBuf(u, 12000); if (b && save(sym, b, imgType(b), "site", d)) { ok = true; break; } } catch (e) {} }
    }
    if (ok) added++;
    if (o.gap) await new Promise(r => setTimeout(r, o.gap));
  };
  let next = 0, timeUp = false;                            // 6 companies at a time (different websites, so no site is hurried)
  const worker = async () => { while (next < todo.length) { if (!o.now && Date.now() > until) { timeUp = true; break; } await one(todo[next++]); } };
  await Promise.all(Array.from({ length: o.parallel || 6 }, worker));
  if (timeUp) log("Logos: time is up for this run — the rest next time.");
  const dropped1 = dropGeneric(); if (dropped1) { added = Math.max(0, added - dropped1); log(`Logos: ${dropped1} placeholder icons removed (not real company logos).`); }
  ix.t = now; ix.v = 1; writeFileSync(ixPath, JSON.stringify(ix));
  // the small list the app downloads: symbol → file (index.json also keeps the collector's own notes)
  const appPath = join(dir, "l", "app.json"); if (!existsSync(appPath)) changed = true;
  writeFileSync(appPath, JSON.stringify({ t: now, logos: Object.fromEntries(Object.entries(ix.logos).map(([k, v]) => [k, v.f + "?v=" + (v.t || 0)])) }));
  const total = Object.keys(ix.logos).length;
  log(`Logos: ${added} new logos this run (${tried} companies tried) · ${total} companies have a logo in total.`);
  if (!o.skipGit && (added || changed || !existsSync(join(dir, ".git", "refs", "heads", BRANCH)))) {
    try { git("add", "-A"); const tree = git("write-tree"); const c = git("commit-tree", tree, "-m", `logos: ${total} companies`); git("update-ref", "HEAD", c);
      git("push", "--quiet", "--force", "origin", "HEAD:" + BRANCH); log("Logos: saved to GitHub."); }
    catch (e) { log("Logos: could not save — " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  }
  return { ok: true, matched: Object.keys(info).length, added, total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runLogos({ gap: 150 }).then(() => process.exit(0)).catch(e => { console.error(String(e && e.message || e)); process.exit(0); });
