// T-Rex one-time DEEP READING of every listed company with your Claude API key (Anthropic, paid from the plan's API credit).
// For each company: its latest annual report, investor presentation and earnings-call transcript on NSE are read once —
// what it sells, capacity, customers, markets, market position, guidance, costs. Every number and quote is checked on its
// page exactly like the watchlist reader (insights.mjs). Results are saved as one file per company in the "deep-data"
// branch of this public repository (company documents are public), so they stay even after the key ends, and the app
// shows them in the Business · AI tab. Nothing is written to the Cloudflare database (no daily-limit pressure).
// Run: node collector/deepread.mjs   (needs ANTHROPIC_API_KEY, TREX_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY — set by the workflow)
import { execFileSync, execFile } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { selectPages, budgetFor, buildPrompt, parseFacts, parseNotes, verifyFacts, verifyNotes, pdfTextPoppler, askClaude, claudeCost, READER_VERSION } from "./insights.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dmy = d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
export const BRANCH = "deep-data";

// which documents of a company to read: the latest transcript, the latest presentation, the latest annual report
export function pickDocs(sym, ann, ars) {
  const txt = r => `${r.desc || ""} ${r.attchmntText || ""} ${r.attchmntFile || ""}`;
  const pdf = r => /\.pdf$/i.test(String(r.attchmntFile || ""));
  const mk = type => r => ({ symbol: sym, name: r.sm_name || sym, doc: r.attchmntFile, type, date: String(r.an_dt || r.sort_date || "").slice(0, 11) });
  const out = [
    ...ann.filter(r => pdf(r) && /transcript/i.test(txt(r)) && !/investor presentation/i.test(String(r.desc || ""))).slice(0, 1).map(mk("Earnings call transcript")),
    ...ann.filter(r => pdf(r) && /investor presentation/i.test(String(r.desc || ""))).slice(0, 1).map(mk("Investor presentation")),
    ...ars.filter(r => /\.pdf$/i.test(String(r.fileName || ""))).slice(0, 1).map(r => ({ symbol: sym, name: r.companyName || sym, doc: r.fileName, type: `Annual report ${r.fromYr || ""}-${r.toYr || ""}`, date: String(r.broadcast_dttm || "").slice(0, 11) })),
  ];
  return out.filter(d => d.doc);
}

export async function runDeep(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key || process.env.TREX_KEY, ckey = o.claudeKey ?? process.env.ANTHROPIC_API_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const t0 = Date.now(), until = t0 + (o.maxMinutes || +process.env.TREX_DEEP_MINUTES || 40) * 60e3;
  const cap = +(o.budgetUsd || process.env.TREX_CLAUDE_BUDGET_USD || 150);            // never spend more than this in total
  const dir = o.dir || "deep", maxDocs = o.maxDocs || 400;
  if (!ckey) { log("Deep reading: no ANTHROPIC_API_KEY secret — nothing to do."); return { ok: true, skipped: true }; }
  if (!key) { log("Deep reading: TREX_KEY is not set."); return { ok: false }; }
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString();
  // 1) the files saved so far (or a new, empty branch)
  if (!o.skipGit) {
    rmSync(dir, { recursive: true, force: true });
    const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) { log("Deep reading: GITHUB_REPOSITORY / GITHUB_TOKEN missing."); return { ok: false }; }
    const remote = `https://x-access-token:${tok}@github.com/${repo}.git`;
    try { execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", BRANCH, remote, dir], { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { mkdirSync(dir, { recursive: true }); git("init", "--quiet"); git("remote", "add", "origin", remote); git("checkout", "--quiet", "--orphan", BRANCH); log("Deep reading: creating the deep-data branch."); }
    git("config", "user.name", "T-Rex collector"); git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  } else mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "d"), { recursive: true });
  const ixPath = join(dir, "d", "index.json");
  let ix = { v: 1, companies: {}, docs: {}, spent: 0, inTok: 0, outTok: 0 }; try { if (existsSync(ixPath)) ix = { ...ix, ...JSON.parse(readFileSync(ixPath, "utf8")) }; } catch (e) {}
  if (!(ix.v >= 2)) { for (const [k, v] of Object.entries(ix.docs || {})) if (v.s === 0) delete ix.docs[k]; ix.v = 2; }
  if (ix.spent >= cap) { log(`Deep reading: the budget of $${cap} is used ($${ix.spent.toFixed(2)}) — stopping.`); return { ok: true, done: true }; }
  if (ix.keyDead && Date.now() - ix.keyDead < 12 * 3600e3) { log("Deep reading: the Claude key stopped working recently — trying again later."); return { ok: true }; }
  let dirty = false;
  const saveCo = (sym, co) => { writeFileSync(join(dir, "d", sym + ".json"), JSON.stringify(co)); dirty = true; };
  const loadCo = sym => { try { return JSON.parse(readFileSync(join(dir, "d", sym + ".json"), "utf8")); } catch (e) { return { symbol: sym, docs: [], facts: [] }; } };
  const publish = (msg) => {
    writeFileSync(ixPath, JSON.stringify(ix));
    if (o.skipGit || !dirty) return; dirty = false;
    try { git("add", "-A"); git("commit", "--quiet", "-m", msg); git("push", "--quiet", "origin", "HEAD:" + BRANCH); log("Deep reading: saved to GitHub (" + msg + ")."); }
    catch (e) { log("Deep reading: could not save to GitHub: " + String((e.stderr && e.stderr.toString()) || e.message || e).replace(/x-access-token:[^@]+@/g, "x-access-token:***@").slice(0, 200)); }
  };
  // 2) companies, big ones first
  const tg = await F(`${server}/api/collect?action=deeptargets`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  if (!tg || !tg.ok) { log("Deep reading: T-Rex problem: " + (tg && tg.error)); return { ok: false }; }
  // NSE with a cookie session (like a browser); PDFs with curl (steadiest with NSE's archive)
  const jar = new Map();
  const keep = r => { const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; for (const c of sc) { const [kv] = c.split(";"); const i = kv.indexOf("="); if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } };
  const cookie = () => [...jar].map(([k, v]) => k + "=" + v).join("; ");
  const session = async () => { try { const r = await F(REF, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: AbortSignal.timeout(20000) }); keep(r); await r.arrayBuffer(); } catch (e) {} };
  const nseJson = async url => { try { const r = await F(url, { headers: { "User-Agent": UA, "Accept": "*/*", "Referer": REF, ...(jar.size ? { Cookie: cookie() } : {}) }, signal: AbortSignal.timeout(40000) }); keep(r); if (r.status !== 200) return { code: r.status }; return { code: 200, j: JSON.parse(await r.text()) }; } catch (e) { return { code: 0 }; } };
  const pdfGet = o.pdfGet || (async url => {
    const tmp = join(tmpdir(), "trexd-" + Date.now() + ".pdf");
    const code = await new Promise(r => execFile("curl", ["-sSL", "--max-time", "150", "-A", UA, "-e", REF, "-o", tmp, "-w", "%{http_code}", ...(jar.size ? ["-H", "Cookie: " + cookie()] : []), url], { timeout: 160000 }, (e, out) => r(e ? 0 : +String(out).trim() || 0)));
    let body = null; try { body = readFileSync(tmp); unlinkSync(tmp); } catch (e) {} return { code, body };
  });
  const pdfText = o.pdfText || pdfTextPoppler;
  await session();
  const st = { inTok: 0, outTok: 0 }, spent0 = ix.spent || 0; let docs = 0, facts = 0, cos = 0, blocked = 0, sinceSave = 0;
  const to = new Date(), from = new Date(Date.now() - 400 * 864e5);
  for (const sym of tg.symbols) {
    if (Date.now() > until - 120000 || docs >= maxDocs) break;
    const c = ix.companies[sym]; if (c && c.t && Date.now() - c.t < 120 * 864e5) continue;          // read in the last 4 months
    const a = await nseJson(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(from)}&to_date=${dmy(to)}`);
    const ar = await nseJson(`https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(sym)}`);
    if (a.code !== 200 && ar.code !== 200) { blocked++; if (blocked >= 5) { log("Deep reading: NSE keeps refusing — stopping for this run."); break; } await sleep(15000 * blocked); await session(); continue; }
    blocked = 0;
    const ann = a.j ? (Array.isArray(a.j) ? a.j : (a.j.data || [])) : []; const ars = ar.j ? (ar.j.data || []) : [];
    const list = pickDocs(sym, ann, ars).filter(d => !(ix.docs[d.doc] && (ix.docs[d.doc].s === 1 || ix.docs[d.doc].s === 2)));
    const co = loadCo(sym);
    for (const d of list) {
      if (Date.now() > until - 120000 || docs >= maxDocs) break;
      const mark = (s, note, extra = {}) => { const tries = ((ix.docs[d.doc] || {}).n || 0) + (s === 0 ? 1 : 0); ix.docs[d.doc] = { s: s === 0 && tries >= 3 ? 2 : s, n: tries };
        co.docs = co.docs.filter(x => x.doc !== d.doc); co.docs.push({ doc: d.doc, symbol: sym, type: d.type, date: d.date, status: ix.docs[d.doc].s, model: extra.model || "", n: extra.n || 0, note, t: Date.now(), source: "deep" }); };
      const r = await pdfGet(d.doc);
      if (r.code !== 200 || !r.body || r.body.length < 1000) { mark(0, `could not download (HTTP ${r.code})`); continue; }
      if (r.body.length > 40 * 1024 * 1024) { mark(2, "file too large"); continue; }
      let pages = []; try { pages = await pdfText(r.body); } catch (e) { mark(0, "PDF damaged or incomplete"); continue; }
      if (pages.join("").replace(/\s/g, "").length < 120) { mark(2, "no text in PDF (scanned images)"); continue; }
      if (!/presentation|annual report/i.test(d.type) && pages.filter(p => p.trim().length > 200).length <= 2 && pages.join("").length < 5000) { mark(1, "covering letter only — the document itself is on the company's website"); continue; }
      let pagesRaw = null; if (pdfText === pdfTextPoppler) { try { pagesRaw = await pdfTextPoppler(r.body, false); } catch (e) {} }
      const sel = selectPages(pages, Math.round(budgetFor(d.type) * 1.5)); if (!sel.length) { mark(1, "no business pages found"); continue; }
      const { system, prompt } = buildPrompt(d.name, sym, d.type, d.date, sel);
      let ans;
      try { ans = await askClaude(F, ckey, system, prompt, null, st); }
      catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); ix.spent = +(spent0 + claudeCost(st)).toFixed(4); log("Deep reading: " + e.message + (st.modelList ? ` [models this key can use: ${st.modelList.slice(0, 12).join(", ") || "none listed"}]` : "") + " — stopping (the normal readers carry on with the free AIs)."); publish(`stop: key not usable`); return { ok: true, keyDead: true, docs }; }
        mark(0, String(e.message || e).slice(0, 150)); continue; }
      const raw = parseFacts(ans.text); if (!raw) { mark(0, `${ans.model}: answer was not readable`); continue; }
      const fv = verifyFacts(raw, pages), rawNotes = parseNotes(ans.text), nv = verifyNotes(rawNotes, [pagesRaw, pages]);
      co.facts = co.facts.filter(x => x.doc !== d.doc).concat([...fv, ...nv].map(x => ({ symbol: sym, doc: d.doc, ...x })));
      mark(1, `${raw.length} numbers found by AI, ${fv.length} confirmed on the page; ${nv.length} of ${rawNotes.length} quotes confirmed`, { model: ans.model, n: fv.length + nv.length });
      docs++; facts += fv.length + nv.length;
    }
    co.name = (list[0] && list[0].name) || co.name || sym; co.t = Date.now(); co.reader = READER_VERSION;
    const pending = co.docs.some(x => x.status === 0);       // a document to retry → the company comes back next run
    ix.companies[sym] = { t: pending ? 0 : Date.now(), docs: co.docs.filter(x => x.status === 1).length, facts: co.facts.length };
    saveCo(sym, co); cos++; sinceSave++;
    ix.spent = +(spent0 + claudeCost(st)).toFixed(4);
    if (ix.spent >= cap) { log(`Deep reading: budget of $${cap} reached.`); break; }
    if (sinceSave >= 15) { sinceSave = 0; publish(`deep reading: ${Object.keys(ix.companies).length} companies`); }
    await sleep(300);
  }
  ix.inTok = (ix.inTok || 0) + st.inTok; ix.outTok = (ix.outTok || 0) + st.outTok; ix.t = Date.now();
  publish(`deep reading: ${Object.keys(ix.companies).length} companies`);
  const total = tg.symbols.length, have = Object.keys(ix.companies).length;
  log(`Deep reading: ${cos} companies, ${docs} documents, ${facts} checked facts this run · ${have} of ${total} companies done · Claude cost so far ≈ $${ix.spent.toFixed(2)} (this run ≈ $${claudeCost(st).toFixed(2)}).`);
  return { ok: true, companies: cos, docs, facts, spent: ix.spent, have, total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDeep().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(0); });
