// T-Rex "World watch" — trade routes, disasters, air traffic, military aircraft and news pulse.
// Runs on GitHub after the collector (no AI, no keys). Builds ONE small snapshot and sends it to T-Rex
// (POST /api/collect?action=world). T-Rex keeps it in one database row and notifies you when a status changes.
// Free public sources:
//   • IMF PortWatch — daily ship transits through the world's sea chokepoints (updated weekly, ~1 week behind)
//   • GDACS (UN / European Commission) — earthquake, cyclone, flood, volcano alerts
//   • adsb.lol — live aircraft positions from volunteer receivers (incl. military aircraft that broadcast)
//   • Google News RSS — how much is being written about shipping, airspace, conflict and oil supply
// Run: node collector/world.mjs   (needs TREX_KEY)
import { pathToFileURL } from "node:url";

const UA = "Mozilla/5.0 (compatible; T-Rex/2.0; +https://t-rex-cloude.manojhegde620.workers.dev)";
const DAY = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const median = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const avg = a => { const s = a.filter(x => x != null && isFinite(x)); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
const r1 = x => x == null ? null : Math.round(x * 10) / 10;

/* ---------- what is watched ---------- */
export const SEA = [
  { id: "chokepoint6", key: "hormuz", name: "Strait of Hormuz", impact: "crude oil, LPG & LNG imports" },
  { id: "chokepoint4", key: "babelmandeb", name: "Bab el-Mandeb (Red Sea)", impact: "India–Europe trade, freight costs" },
  { id: "chokepoint1", key: "suez", name: "Suez Canal", impact: "India–Europe trade, freight costs" },
  { id: "chokepoint7", key: "cape", name: "Cape of Good Hope", impact: "diversion route when the Red Sea is avoided" },
  { id: "chokepoint5", key: "malacca", name: "Malacca Strait", impact: "India–East Asia trade (electronics, chemicals)" },
  { id: "chokepoint11", key: "taiwan", name: "Taiwan Strait", impact: "semiconductors & electronics supply" },
  { id: "chokepoint3", key: "bosporus", name: "Bosporus (Black Sea)", impact: "sunflower oil, wheat, fertiliser" },
];
export const AIR = [
  { id: "gulf", name: "Gulf air hub (Dubai · Doha · Abu Dhabi)", lat: 25.3, lon: 54.0, r: 250, impact: "India's main air link to the Gulf & Europe" },
  { id: "emed", name: "Eastern Mediterranean (Israel · Lebanon · Jordan)", lat: 32.0, lon: 35.0, r: 150, impact: "conflict signal near Israel" },
  { id: "nindia", name: "North India (Delhi) — reference", lat: 28.6, lon: 77.1, r: 200, control: true },
];
export const MIL = [
  { id: "me", name: "Middle East & Gulf", box: [12, 38, 32, 63] },
  { id: "indpak", name: "India · Pakistan", box: [6, 37, 60, 97] },
  { id: "scs", name: "Taiwan · South China Sea", box: [5, 30, 105, 125] },
  { id: "blk", name: "Black Sea · Ukraine", box: [40, 53, 27, 42] },
];
export const NEWS = [
  { id: "ship", name: "Shipping & sea routes", q: '("Strait of Hormuz" OR "Red Sea" OR "Suez Canal" OR "Bab el-Mandeb" OR Houthi) (shipping OR tanker OR vessel)' },
  { id: "air", name: "Airspace & flights", q: '("airspace closed" OR "airspace closure" OR "flights suspended" OR "flights cancelled" OR "airspace reopened")' },
  { id: "conflict", name: "Conflict near India & the Gulf", q: '(Pakistan OR "Line of Control" OR "India China border" OR Iran OR Israel OR "Taiwan Strait") (military OR missile OR airstrike OR troops)' },
  { id: "oil", name: "Oil & gas supply", q: '("crude oil" OR OPEC OR LNG OR Brent) (supply OR disruption OR output OR sanctions)' },
];
// GDACS: countries that matter for Indian companies (suppliers, buyers, routes)
const KEY_CC = new Set(["IN", "CN", "TW", "JP", "KR", "ID", "MY", "VN", "TH", "BD", "LK", "PK", "NP", "MM", "AE", "SA", "IR", "OM", "QA", "KW", "IQ", "YE", "EG", "SG", "PH", "US"]);

/* ---------- sea routes: IMF PortWatch ---------- */
const PW = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query";
// The service answers at most 1,000 rows per request and refuses bursts of requests ("Invalid URL"),
// so the dates are asked in a few windows of under 1,000 rows each, a few seconds apart, with patient retries.
async function pwQuery(F, where, wait = 4000) {
  const p = new URLSearchParams({ where, outFields: "portid,date,n_total,n_tanker,n_container", orderByFields: "date ASC", returnGeometry: "false", resultRecordCount: "1000", f: "json" });
  let last = "";
  for (let t = 0; t < 4; t++) {
    if (t) await new Promise(r => setTimeout(r, wait * t * t));
    try {
      const r = await F(PW + "?" + p, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
      if (!r.ok) { last = "HTTP " + r.status; continue; }
      const j = await r.json(); if (j.error) { last = j.error.message || "error"; continue; }
      return (j.features || []).map(f => f.attributes);
    } catch (e) { last = e.message || String(e); }
  }
  throw new Error("PortWatch: " + last);
}
export async function pwRows(F, now, wait = 4000) {
  const ids = SEA.map(s => `'${s.id}'`).join(",");                 // 7 routes × ≤130 days ≈ 910 rows per window
  const wins = [[now - 200 * DAY, now - 100 * DAY], [now - 100 * DAY, now + DAY], [now - 470 * DAY, now - 340 * DAY]];
  const rows = [];
  for (const [a, b] of wins) {
    rows.push(...await pwQuery(F, `portid IN (${ids}) AND date > DATE '${iso(a)}' AND date <= DATE '${iso(b)}'`, wait));
    await new Promise(r => setTimeout(r, wait / 2));
  }
  return rows;
}
export function seaStatus(ratio, base) {
  if (base == null || base < 3 || ratio == null) return "na";
  return ratio < 0.5 ? "red" : ratio < 0.8 ? "amber" : ratio > 1.3 ? "busy" : "green";
}
export function buildSea(rows, now = Date.now()) {
  const by = {}; for (const a of rows) (by[a.portid] = by[a.portid] || []).push(a);
  const routes = [];
  for (const def of SEA) {
    const rs = (by[def.id] || []).map(a => ({ d: iso(a.date), t: +a.date, n: a.n_total, k: a.n_tanker, c: a.n_container })).sort((x, y) => x.t - y.t);
    const cur = rs.filter(x => x.t > now - 200 * DAY);
    if (!cur.length) { routes.push({ ...def, status: "na", note: "no data" }); continue; }
    const last = cur[cur.length - 1].t;
    const win = (from, to) => rs.filter(x => x.t > from && x.t <= to);
    const w7 = win(last - 7 * DAY, last), ly = win(last - 364 * DAY - 14 * DAY, last - 364 * DAY);
    const now7 = avg(w7.map(x => x.n)), ly14 = avg(ly.map(x => x.n));
    const tk7 = avg(w7.map(x => x.k)), tkLy = avg(ly.map(x => x.k));
    let base = ly14, baseKind = "same weeks last year";
    if (base == null) { base = avg(win(last - 120 * DAY, last - 30 * DAY).map(x => x.n)); baseKind = "previous 3 months"; }
    const ratio = now7 != null && base ? now7 / base : null;
    const series = win(last - 90 * DAY, last).map(x => [x.d, x.n]);
    const lyMap = new Map(rs.map(x => [x.d, x.n]));
    const lySeries = series.map(([d]) => lyMap.get(iso(Date.parse(d) - 364 * DAY)) ?? null);
    routes.push({ ...def, dataTo: iso(last), now7: r1(now7), base: r1(base), baseKind, ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
      tanker7: r1(tk7), tankerBase: r1(tkLy), status: seaStatus(ratio, base), series, lySeries });
  }
  return routes;
}

/* ---------- disasters: GDACS ---------- */
export function buildDisasters(features, now = Date.now()) {
  const out = [];
  for (const f of features || []) {
    const p = f.properties || {}; const type = p.eventtype, level = p.alertlevel;
    const cc = (p.affectedcountries || []).map(c => c.iso2).filter(Boolean);
    const india = cc.includes("IN"), key = cc.some(c => KEY_CC.has(c));
    const to = Date.parse(p.todate || p.fromdate || 0), from = Date.parse(p.fromdate || 0);
    if (!(to >= now - 7 * DAY || from >= now - 10 * DAY)) continue;
    const keep = type === "DR" ? (india && (level === "Orange" || level === "Red")) : (level === "Red" || (level === "Orange" && (india || key)));
    if (!keep) continue;
    out.push({ id: `${type}-${p.eventid}`, ep: p.episodeid, type, level, name: String(p.name || p.eventname || "").slice(0, 90), countries: cc.slice(0, 8),
      india, from: iso(from || now), to: iso(to || now), sev: String((p.severitydata && p.severitydata.severitytext) || "").slice(0, 90),
      url: (p.url && p.url.report) || "", lat: f.geometry && f.geometry.coordinates ? r1(f.geometry.coordinates[1]) : null, lon: f.geometry && f.geometry.coordinates ? r1(f.geometry.coordinates[0]) : null });
  }
  const rank = d => (d.level === "Red" ? 0 : 1) * 10 + (d.india ? 0 : 1);
  return [...new Map(out.map(d => [d.id, d])).values()].sort((a, b) => rank(a) - rank(b) || b.from.localeCompare(a.from)).slice(0, 15);
}

/* ---------- news pulse: Google News RSS ---------- */
const pick = (s, tag) => { const m = s.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i")); return m ? m[1].trim() : ""; };
const clean = s => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, "").trim();
export function parseRss(xml, now = Date.now()) {
  const items = [];
  for (const b of String(xml).split(/<item>/).slice(1)) {
    const it = b.split(/<\/item>/)[0];
    let title = clean(pick(it, "title")); const link = clean(pick(it, "link")); const pub = Date.parse(pick(it, "pubDate")) || null;
    let source = clean(pick(it, "source")); if (!source && title.includes(" - ")) source = title.slice(title.lastIndexOf(" - ") + 3);
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));
    if (title && link && /^https:\/\//.test(link)) items.push({ title: title.slice(0, 200), link, source: source.slice(0, 60), pub });
  }
  const n24 = items.filter(x => x.pub && x.pub > now - DAY).length;
  return { n24, items: items.filter(x => x.pub).sort((a, b) => b.pub - a.pub).slice(0, 6) };
}
export function newsStatus(n24, usual, days) {
  if (n24 == null) return "unknown";
  if (days < 3 || usual == null) return "learning";
  return n24 >= Math.max(15, usual * 2.5) ? "high" : "normal";
}

/* ---------- air traffic & military aircraft: adsb.lol ---------- */
export function airUsual(hist, now, tod = true) {
  const tday = t => (t % DAY) / 6e4;                     // minutes since midnight UTC
  const m = tday(now);
  const prior = (hist || []).filter(([t, n]) => n != null && t < now - 12 * 3600e3 && t > now - 8 * DAY && (!tod || Math.min(Math.abs(tday(t) - m), 1440 - Math.abs(tday(t) - m)) <= 75));
  return { usual: median(prior.map(x => x[1])), samples: prior.length };
}
export function airStatus(n, usual, samples) {
  if (n == null) return "unknown";
  if (samples < 3 || usual == null) return "learning";
  if (usual < 8) return "na";
  const r = n / usual; return r < 0.4 ? "red" : r < 0.65 ? "amber" : "green";
}
const posOf = a => { const lat = a.lat ?? a.rr_lat ?? (a.lastPosition && a.lastPosition.lat); const lon = a.lon ?? a.rr_lon ?? (a.lastPosition && a.lastPosition.lon); return lat != null && lon != null ? [lat, lon] : null; };
export function milCounts(ac) {
  const res = {};
  for (const r of MIL) res[r.id] = { n: 0, types: {} };
  for (const a of ac || []) {
    if (a.alt_baro === "ground" || a.t === "TWR" || /^TEST/.test(String(a.flight || "").trim())) continue;
    const p = posOf(a); if (!p) continue;
    for (const r of MIL) { const [la0, la1, lo0, lo1] = r.box; if (p[0] >= la0 && p[0] <= la1 && p[1] >= lo0 && p[1] <= lo1) { res[r.id].n++; const t = a.t || "unknown"; res[r.id].types[t] = (res[r.id].types[t] || 0) + 1; } }
  }
  return res;
}
const keepHist = (h, now, days = 9) => (h || []).filter(([t]) => t > now - days * DAY).slice(-200);

/* ---------- the run ---------- */
export async function runWorld(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, F = o.fetch || globalThis.fetch, now = o.now || Date.now();
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  if (!key) { log("World watch: TREX_KEY is not set."); return { ok: false }; }
  const get = async (url, ms = 30000) => { const r = await F(url, { headers: { "User-Agent": UA, "Accept": "*/*" }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error("HTTP " + r.status); return r; };
  // the previous snapshot (history for "what is usual")
  let prev = {}; try { const j = await (await get(`${server}/api/db?world=1&fresh=1`, 30000)).json(); if (j && j.ok && j.world) prev = j.world; } catch (e) {}
  const snap = { v: 1, t: now, sea: prev.sea || null, disasters: prev.disasters || [], air: { regions: [], hist: {} }, mil: { regions: [], hist: {} }, news: { topics: [], hist: {} }, errors: [] };

  // 1) sea routes — PortWatch updates weekly, so once every 12 hours is plenty
  if (!prev.sea || !prev.sea.t || now - prev.sea.t > 12 * 3600e3 || o.forceSea) {
    try {
      const rows = await pwRows(F, now, o.pwWait ?? 4000);
      const routes = buildSea(rows, now);
      if (routes.some(r => r.status !== "na")) snap.sea = { t: now, routes };
      log(`World watch: sea routes — ${routes.map(r => `${r.name} ${r.status}${r.ratio != null ? " (" + Math.round(r.ratio * 100) + "% of usual)" : ""}`).join("; ")}.`);
    } catch (e) { snap.errors.push("sea: " + (e.message || e)); log("World watch: PortWatch not available — " + (e.message || e)); }
  }
  // 2) disasters — GDACS (Red and Orange alerts, last 10 days)
  try {
    const feats = [];
    for (const lvl of ["Red", "Orange"]) {
      const r = await F(`https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?alertlevel=${lvl}&fromdate=${iso(now - 10 * DAY)}&todate=${iso(now + DAY)}`, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: AbortSignal.timeout(30000) });
      if (r.status === 204) continue; if (!r.ok) throw new Error("GDACS HTTP " + r.status);
      const txt = await r.text(); if (!txt.trim()) continue; const j = JSON.parse(txt); feats.push(...(j.features || []));
    }
    snap.disasters = buildDisasters(feats, now);
    log(`World watch: ${snap.disasters.length} disaster alerts that matter (${snap.disasters.filter(d => d.india).length} in India).`);
  } catch (e) { snap.errors.push("disasters: " + (e.message || e)); log("World watch: GDACS not available — " + (e.message || e)); }
  // 3) air traffic in a few regions (+ Delhi as a reference to spot receiver gaps)
  const airRes = {};
  for (const a of AIR) {
    let n = null;
    try { const j = await (await get(`https://api.adsb.lol/v2/point/${a.lat}/${a.lon}/${a.r}`, 25000)).json(); n = (j.ac || []).filter(x => x.alt_baro !== "ground" && posOf(x)).length; } catch (e) { snap.errors.push(`air ${a.id}: ${e.message || e}`); }
    const hist = keepHist([...((prev.air && prev.air.hist && prev.air.hist[a.id]) || []), ...(n != null ? [[now, n]] : [])], now);
    const { usual, samples } = airUsual(hist, now);
    airRes[a.id] = { n, usual, samples, ratio: n != null && usual ? n / usual : null };
    snap.air.hist[a.id] = hist;
  }
  const ctl = airRes.nindia;
  for (const a of AIR) {
    const x = airRes[a.id]; let status = airStatus(x.n, x.usual, x.samples);
    if (!a.control && (status === "red" || status === "amber") && ctl && ctl.ratio != null && ctl.ratio < 0.6) status = "gap";   // everything dropped → receiver/data gap, not a closure
    snap.air.regions.push({ id: a.id, name: a.name, impact: a.impact || "", control: !!a.control, now: x.n, usual: x.usual == null ? null : Math.round(x.usual), ratio: x.ratio == null ? null : Math.round(x.ratio * 100) / 100, status });
  }
  // 4) military aircraft that broadcast their position (many do not) — counted per region
  try {
    const j = await (await get("https://api.adsb.lol/v2/mil", 30000)).json(); const c = milCounts(j.ac || []);
    for (const r of MIL) {
      const hist = keepHist([...((prev.mil && prev.mil.hist && prev.mil.hist[r.id]) || []), [now, c[r.id].n]], now);
      const { usual, samples } = airUsual(hist, now, false);
      const status = samples < 8 || usual == null ? "learning" : c[r.id].n >= Math.max(6, usual * 2.5) ? "high" : "normal";
      snap.mil.hist[r.id] = hist;
      snap.mil.regions.push({ id: r.id, name: r.name, now: c[r.id].n, usual: usual == null ? null : Math.round(usual * 10) / 10, status, types: Object.entries(c[r.id].types).sort((a, b) => b[1] - a[1]).slice(0, 6) });
    }
  } catch (e) { snap.errors.push("military: " + (e.message || e)); if (prev.mil) { snap.mil = prev.mil; } }
  // 5) news pulse
  const today = iso(now + 5.5 * 3600e3);
  for (const t of NEWS) {
    let res = null;
    try { const r = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(t.q + " when:1d")}&hl=en-IN&gl=IN&ceid=IN:en`, 25000); res = parseRss(await r.text(), now); } catch (e) { snap.errors.push(`news ${t.id}: ${e.message || e}`); }
    const h = { ...((prev.news && prev.news.hist && prev.news.hist[t.id]) || {}) };
    if (res) h[today] = Math.max(h[today] || 0, res.n24);
    for (const d of Object.keys(h)) if (d < iso(now - 15 * DAY)) delete h[d];
    const past = Object.entries(h).filter(([d]) => d < today && d >= iso(now - 8 * DAY)).map(([, n]) => n);
    const usual = median(past);
    snap.news.hist[t.id] = h;
    snap.news.topics.push({ id: t.id, name: t.name, n24: res ? res.n24 : null, usual: usual == null ? null : Math.round(usual), status: newsStatus(res ? res.n24 : null, usual, past.length), items: res ? res.items : ((prev.news && (prev.news.topics || []).find(x => x.id === t.id) || {}).items || []) });
  }
  // send to T-Rex (one database write; T-Rex compares with the last snapshot and notifies on changes)
  if (o.dryRun) return { ok: true, snap };
  try {
    const r = await F(`${server}/api/collect?action=world`, { method: "POST", headers: { "x-trex-key": key, "content-type": "application/json" }, body: JSON.stringify(snap), signal: AbortSignal.timeout(60000) });
    const j = await r.json();
    log(j && j.ok ? `World watch: saved${j.alerts ? ` — ${j.alerts} change(s) notified` : ""}.` : "World watch: T-Rex problem — " + (j && j.error));
    return { ok: !!(j && j.ok), snap, alerts: j && j.alerts };
  } catch (e) { log("World watch: could not reach T-Rex — " + (e.message || e)); return { ok: false, snap }; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runWorld().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(0); });
