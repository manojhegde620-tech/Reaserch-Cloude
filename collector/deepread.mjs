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
import { selectPages, budgetFor, buildPrompt, parseFacts, parseNotes, verifyFacts, verifyNotes, parseExtras, pdfTextPoppler, askClaude, claudeCost, READER_VERSION } from "./insights.mjs";
import { shpPledge, xbrlNum } from "./companyinfo.mjs";
import { evaluatePromises, dueOf, JUDGE_RULES } from "./promises.mjs";
import { tidyCompany, TIDY_VERSION } from "./tidy.mjs";
import { sealText, openText, sealOn, sealTree } from "./seal.mjs";
export const DEEP_VERSION = 2;                 // v2: + management commitments, analyst concerns, competitors, product tags, red flags, holding, insider trades

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const REF = "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dmy = d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
export const BRANCH = "deep-data";

// which documents of a company to read: the latest transcript, the latest presentation, the latest annual report
export function pickDocs(sym, ann, ars, nTr = 1) {
  const txt = r => `${r.desc || ""} ${r.attchmntText || ""} ${r.attchmntFile || ""}`;
  const pdf = r => /\.pdf$/i.test(String(r.attchmntFile || ""));
  const mk = type => r => ({ symbol: sym, name: r.sm_name || sym, doc: r.attchmntFile, type, date: String(r.an_dt || r.sort_date || "").slice(0, 11) });
  const out = [
    ...ann.filter(r => pdf(r) && /transcript/i.test(txt(r)) && !/investor presentation/i.test(String(r.desc || ""))).filter((r, i, arr) => arr.findIndex(x => x.attchmntFile === r.attchmntFile) === i).slice(0, nTr).map(mk("Earnings call transcript")),
    ...ann.filter(r => pdf(r) && /investor presentation/i.test(String(r.desc || ""))).slice(0, 1).map(mk("Investor presentation")),
    ...ars.filter(r => /\.pdf$/i.test(String(r.fileName || ""))).slice(0, 1).map(r => ({ symbol: sym, name: r.companyName || sym, doc: r.fileName, type: `Annual report ${r.fromYr || ""}-${r.toYr || ""}`, date: String(r.broadcast_dttm || "").slice(0, 11) })),
  ];
  return out.filter(d => d.doc);
}

// red flags and notable events from the company's own NSE announcements (no AI: the announcement subject decides)
const FLAG_RULES = [
  ["red", "Auditor resigned", /auditor/i, /resign|cessation|withdraw/i],
  ["red", "Key person resigned", /\b(cfo|chief financial|ceo|chief executive|managing director|whole[- ]?time director|company secretary|compliance officer|key managerial|kmp)\b/i, /resign|cessation/i],
  ["red", "Rating downgrade / negative watch", /rating/i, /downgrad|negative (outlook|watch)|watch with negative|withdraw|suspend|default/i],
  ["red", "Default / delay in payment", /default|delay in (payment|servicing)|non[- ]payment|overdue/i, null],
  ["red", "Regulatory / legal action", /penalt|show cause|tax demand|demand notice|search (and|&) seizure|\braid\b|fraud|insolvency|\bnclt\b|\bcirp\b|forensic|adjudication|sebi order|ed\b.*attach/i, null],
  ["amber", "Promoter pledge / encumbrance", /pledge|encumbr/i, null],
  ["amber", "Director resigned", /director/i, /resign|cessation/i],
  ["green", "Rating upgrade", /rating/i, /upgrad|positive outlook/i],
  ["green", "Buyback / bonus / split", /buy ?back|bonus|split|sub-division/i, null],
  ["green", "Order / contract won", /order|contract|letter of award|\bloa\b|work order/i, /receiv|win|won|bag|secur|award/i],
  ["green", "Capacity / plant commissioned", /commission|commercial production|capacity expansion|new plant/i, null],
  ["info", "Acquisition / merger / fund raise", /acquisi|amalgamat|merger|scheme of arrangement|preferential|\bqip\b|rights issue|fund raising/i, null],
];
export function deepSignals(ann) {
  const flags = [], seen = new Set();
  for (const r of ann || []) {
    const txt = `${r.desc || ""} ${r.attchmntText || ""}`.replace(/\s+/g, " ").trim(); if (!txt) continue;
    for (const [lvl, label, a, b] of FLAG_RULES) {
      if (!a.test(txt) || (b && !b.test(txt))) continue;
      const k = label + "|" + String(r.an_dt || r.sort_date || "").slice(0, 11); if (seen.has(k)) break; seen.add(k);
      flags.push({ lvl, label, date: String(r.an_dt || r.sort_date || "").slice(0, 11), text: txt.slice(0, 220), url: r.attchmntFile || "" }); break;
    }
  }
  return flags.slice(0, 40);
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
  let ix = { v: 1, companies: {}, docs: {}, spent: 0, inTok: 0, outTok: 0 }; try { if (existsSync(ixPath)) { const o = await openText(readFileSync(ixPath, "utf8")); if (o) ix = { ...ix, ...o }; } } catch (e) {}
  if (!(ix.v >= 2)) { for (const [k, v] of Object.entries(ix.docs || {})) if (v.s === 0) delete ix.docs[k]; ix.v = 2; }
  if (ix.spent >= cap) { log(`Deep reading: the budget of $${cap} is used ($${ix.spent.toFixed(2)}) — stopping.`); return { ok: true, done: true }; }
  if (ix.keyDead && Date.now() - ix.keyDead < 12 * 3600e3) { log("Deep reading: the Claude key stopped working recently — trying again later."); return { ok: true }; }
  let dirty = false;
  const saveCo = async (sym, co) => { writeFileSync(join(dir, "d", sym + ".json"), await sealText(co)); dirty = true; };   // sealed when DATA_KEY is set
  const loadCo = async sym => { try { const o = await openText(readFileSync(join(dir, "d", sym + ".json"), "utf8")); if (o) return o; } catch (e) {} return { symbol: sym, docs: [], facts: [] }; };
  if (sealOn()) { try { const n = await sealTree(join(dir, "d")); if (n) { dirty = true; log(`Deep reading: ${n} older files sealed (encrypted).`); } } catch (e) {} }
  const publish = async (msg) => {
    writeFileSync(ixPath, await sealText(ix));
    // small index for the app's peer comparison: company name, product tags, competitors named in its documents
    const pe = {}; for (const [k, v] of Object.entries(ix.companies || {})) if (v && (v.tg || v.n)) pe[k] = [v.n || "", v.tg || [], v.cp || []];
    writeFileSync(join(dir, "d", "peers.json"), await sealText(pe));
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
  // PDFs: curl first (like the main collector, with the same headers), then Node's own https on a fresh connection
  const curlGet = url => new Promise(res => {
    const tmp = join(tmpdir(), "trexd-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".pdf");
    execFile("curl", ["-sSL", "--max-time", "90", "-A", UA, "-e", REF, "-H", "Accept: application/pdf,*/*", "-o", tmp, "-w", "%{http_code}", ...(jar.size ? ["-H", "Cookie: " + cookie()] : []), url], { timeout: 100000 }, (e, out, err) => {
      let body = null; try { body = readFileSync(tmp); unlinkSync(tmp); } catch (x) {}
      res({ code: e ? 0 : +String(out).trim() || 0, body, why: e ? String(err || e.message || "curl failed").trim().slice(0, 80) : "" });
    });
  });
  const httpsGet = async (url, ms = 120000, hops = 0) => { const https = await import("node:https"); return new Promise(res => {
    let done = false; const fin = v => { if (!done) { done = true; clearTimeout(tm); res(v); } };
    const req = https.get(url, { agent: false, headers: { "User-Agent": UA, "Accept": "application/pdf,*/*", "Accept-Encoding": "identity", "Referer": REF, "Connection": "close", ...(jar.size ? { Cookie: cookie() } : {}) } }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 3) { r.resume(); done = true; clearTimeout(tm); res(httpsGet(new URL(r.headers.location, url).href, ms, hops + 1)); return; }
      const parts = []; r.on("data", c => parts.push(c)); r.on("end", () => fin({ code: r.statusCode, body: Buffer.concat(parts) })); r.on("error", e => fin({ code: 0, body: null, why: e.code || e.message }));
    });
    const tm = setTimeout(() => { req.destroy(); fin({ code: 0, body: null, why: "timed out" }); }, ms);
    req.on("error", e => fin({ code: 0, body: null, why: e.code || e.message }));
  }); };
  const good = r => r.code === 200 && r.body && r.body.length >= 1000;
  const pdfGet = o.pdfGet || (async url => {
    let r = await curlGet(url); if (good(r)) return r;
    const first = r.why || "HTTP " + r.code; await session();
    r = await httpsGet(url); if (!good(r)) r.why = `${first}; then ${r.why || "HTTP " + r.code}`; return r;
  });
  const pdfText = o.pdfText || pdfTextPoppler;
  await session();
  const st = { inTok: 0, outTok: 0 }, spent0 = ix.spent || 0; let docs = 0, facts = 0, cos = 0, blocked = 0, sinceSave = 0, busyRun = 0, stopRun = false, lastPub = Date.now();
  const to = new Date(), from = new Date(Date.now() - 400 * 864e5), from2 = new Date(Date.now() - 800 * 864e5);
  let dn = 0; const dlog = (id, m) => log(`  doc ${id}: ${m}`);                 // (public log: no company names)
  let gateT = 0; const gate = async () => { const w = Math.max(0, gateT - Date.now()); gateT = Math.max(Date.now(), gateT) + (o.nseGap ?? 450); if (w) await sleep(w); };   // NSE: one request at a time, spaced
  const nseG = async url => { await gate(); return nseJson(url); };
  const deepTr = o.deepTranscripts || 4, deepN = o.deepCount || 300;      // big companies + your watchlist: 4 transcripts (for promises vs delivery), others: 2
  const order = new Map(tg.symbols.map((x, i) => [x, i]));
  async function readDoc(sym, co, d) {
    const id = ++dn;
    const mark = (s, note, extra = {}) => { const tries = ((ix.docs[d.doc] || {}).n || 0) + (s === 0 && !extra.transient ? 1 : 0); ix.docs[d.doc] = { s: s === 0 && tries >= 3 ? 2 : s, n: tries, v: DEEP_VERSION };
      co.docs = co.docs.filter(x => x.doc !== d.doc); co.docs.push({ doc: d.doc, symbol: sym, type: d.type, date: d.date, status: ix.docs[d.doc].s, model: extra.model || "", n: extra.n || 0, note, t: Date.now(), source: "deep" }); };
    const tD = Date.now(); const r = await pdfGet(d.doc); const dlS = Math.round((Date.now() - tD) / 1000);
    if (r.code !== 200 || !r.body || r.body.length < 1000) { mark(0, `could not download (${r.why || "HTTP " + r.code})`); dlog(id, `could not download after ${dlS}s (${r.why || "HTTP " + r.code})`); return; }
    if (r.body.length > 40 * 1024 * 1024) { mark(2, "file too large"); return; }
    let pages = []; try { pages = await pdfText(r.body); } catch (e) { mark(0, "PDF damaged or incomplete"); return; }
    if (pages.join("").replace(/\s/g, "").length < 120) { mark(2, "no text in PDF (scanned images)"); return; }
    if (!/presentation|annual report/i.test(d.type) && pages.filter(p => p.trim().length > 200).length <= 2 && pages.join("").length < 5000) { mark(1, "covering letter only — the document itself is on the company's website"); return; }
    let pagesRaw = null; if (pdfText === pdfTextPoppler) { try { pagesRaw = await pdfTextPoppler(r.body, false); } catch (e) {} }
    const sel = selectPages(pages, Math.round(budgetFor(d.type) * 1.5)); if (!sel.length) { mark(1, "no business pages found"); return; }
    const { system, prompt } = buildPrompt(d.name, sym, d.type, d.date, sel, { ext: true });
    let ans; const tA = Date.now();
    try { ans = await askClaude(F, ckey, system, prompt, m => dlog(id, m.trim()), st); }
    catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); stopRun = true; log("Deep reading: " + e.message + (st.modelList ? ` [models this key can use: ${st.modelList.slice(0, 12).join(", ") || "none listed"}]` : "") + " — stopping (the normal readers carry on with the free AIs)."); return; }
      if (e.busy) { mark(0, String(e.message || e).slice(0, 150), { transient: true }); dlog(id, String(e.message || e).slice(0, 120)); if (++busyRun >= 3) { log("Deep reading: Claude keeps saying busy / rate limit — stopping this run."); stopRun = true; } return; }
      mark(0, String(e.message || e).slice(0, 150)); return; }
    const raw = parseFacts(ans.text); if (!raw) { const t = String(ans.text || ""); mark(0, `${ans.model}: answer was not readable`); dlog(id, `${ans.model}: answer was not readable (${t.length} chars; starts "${t.slice(0, 60).replace(/\s+/g, " ")}" … ends "${t.slice(-60).replace(/\s+/g, " ")}")`); return; }
    const fv = verifyFacts(raw, pages), rawNotes = parseNotes(ans.text), nv = verifyNotes(rawNotes, [pagesRaw, pages]);
    const ex = parseExtras(ans.text, [pagesRaw, pages]);
    co.facts = co.facts.filter(x => x.doc !== d.doc).concat([...fv, ...nv].map(x => ({ symbol: sym, doc: d.doc, ...x })));
    co.commitments = (co.commitments || []).filter(x => x.doc !== d.doc).concat(ex.commitments.map(c => ({ doc: d.doc, date: d.date, type: d.type, ...c })));
    co.concerns = (co.concerns || []).filter(x => x.doc !== d.doc).concat(ex.concerns.map(c => ({ doc: d.doc, date: d.date, ...c })));
    co.competitors = [...new Set([...(co.competitors || []), ...ex.competitors])].slice(0, 15);
    const tg2 = { ...(co.tagN || {}) }; for (const t of ex.tags) tg2[t] = (tg2[t] || 0) + 1; co.tagN = tg2; co.tags = Object.entries(tg2).sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 8);
    mark(1, `${raw.length} numbers found by AI, ${fv.length} confirmed on the page; ${nv.length} of ${rawNotes.length} quotes confirmed; ${ex.commitments.length} commitments`, { model: ans.model, n: fv.length + nv.length });
    docs++; facts += fv.length + nv.length; busyRun = 0;
    dlog(id, `download ${dlS}s, AI ${Math.round((Date.now() - tA) / 1000)}s — ${fv.length + nv.length} checked facts, ${ex.commitments.length} commitments, ${ex.concerns.length} concerns [${ans.model}]`);
  }
  async function companyExtras(sym, co) {             // promoter holding + pledge (shareholding pattern) and insider trades — refreshed monthly
    if (co.hx && Date.now() - co.hx < 30 * 864e5) return;
    try {
      const sh = await nseG(`https://www.nseindia.com/api/corporate-share-holdings-master?index=equities&symbol=${encodeURIComponent(sym)}`);
      const list0 = sh.j ? (Array.isArray(sh.j) ? sh.j : (sh.j.data || [])) : []; const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : null; };
      const dtp = x => { const d = Date.parse(String(x || "").replace(/-/g, " ")); return isNaN(d) ? 0 : d; };
      const list = list0.filter(r => r && r.date && num(r.pr_and_prgrp) != null).sort((a, b) => dtp(b.date) - dtp(a.date)); const seen = new Set();
      if (list.length) co.holding = list.filter(r => !seen.has(r.date) && seen.add(r.date)).slice(0, 8).map(r => ({ d: r.date, p: num(r.pr_and_prgrp), pub: num(r.public_val) }));
      if (list[0] && list[0].xbrl && !o.skipShp) { await gate(); const x = await pdfGet(list[0].xbrl); if (x.code === 200 && x.body) { const xml = x.body.toString("utf8"); co.pledge = { ...shpPledge(xml), totalShares: xbrlNum(xml, "NumberOfShares"), d: list[0].date }; } }
    } catch (e) {}
    try {
      const pit = await nseG(`https://www.nseindia.com/api/corporates-pit?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(from)}&to_date=${dmy(to)}`);
      const rows = pit.j ? (Array.isArray(pit.j) ? pit.j : (pit.j.data || [])) : [];
      if (pit.code === 200) {
        const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isFinite(n) ? n : 0; };
        const tr = rows.map(r => ({ d: String(r.acqfromDt || r.date || r.intimDt || "").slice(0, 11), who: String(r.acqName || "").slice(0, 60), cat: String(r.personCategory || "").slice(0, 40), type: String(r.tdpTransactionType || r.acqMode || "").slice(0, 30), qty: num(r.secAcq), val: num(r.secVal) }));
        const sum = re => { let b = 0, s2 = 0; for (const t of tr) if (re.test(t.cat)) { if (/buy|acqui/i.test(t.type)) b += t.val; else if (/sell|dispos/i.test(t.type)) s2 += t.val; } return { buy: Math.round(b), sell: Math.round(s2) }; };
        co.insider = { t: Date.now(), promoters: sum(/promoter/i), directors: sum(/director|kmp|key managerial|designated/i), rows: tr.slice(0, 30) };
      }
    } catch (e) {}
    co.hx = Date.now();
  }
  // promises vs delivery: judge the commitments whose date has passed, from later documents + the filings
  const ripeCount = co => (co.commitments || []).filter(c => { const d = dueOf(c.by); return d && d < Date.now() - 20 * 864e5 && (!c.verdict || (c.verdict.s !== "unclear" && (c.verdict.r || 0) < JUDGE_RULES) || (c.verdict.s === "unclear" && Date.now() - (c.verdict.t || 0) > 90 * 864e5)); }).length;
  async function judgeCo(sym, co) {
    if (!stopRun && ripeCount(co) && !o.skipPromises) {
      try {
        let quarters = [];
        const j = await F(`${server}/api/db?symbol=${encodeURIComponent(sym)}`, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => null);
        if (j && j.ok) { const qs = j.quarters || []; const basis = qs.some(q => q.basis === "C") ? "C" : "S"; const mine = qs.filter(q => q.basis === basis);
          const by = Object.fromEntries(mine.map(q => [q.qe, q])); const ly = qe => { const [y, m] = qe.split("-"); return `${+y - 1}-${m}-${qe.slice(8)}`; };
          const g = (a, b) => a != null && b ? Math.round((a - b) / Math.abs(b) * 1000) / 10 : null;
          quarters = mine.map(q => { const p = by[ly(q.qe)] || mine.find(x => x.qe.slice(0, 7) === ly(q.qe).slice(0, 7)); return { qe: q.qe, basis, sales: q.sales, opm: q.opm, np: q.np, pdf: q.pdf || null, xbrl: q.xbrl || null, yoySales: p ? g(q.sales, p.sales) : null, yoyNp: p ? g(q.np, p.np) : null }; }); }
        const nj = await evaluatePromises(sym, co, { quarters, ask: (sys, pr) => askClaude(F, ckey, sys, pr, null, st) });
        if (nj) co.judged = (co.judged || 0) + nj;
      } catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); stopRun = true; } }
    }
    co.jt = Date.now();
  }
  // tidy-up: one standard name + group per number name (so the app lines numbers up by quarter); your watchlist also gets
  // the numbers read by the 2-hourly watchlist reader (T-Rex database) tidied, re-checked twice a day
  const watchSet = new Set(tg.symbols.slice(0, tg.watch || 0));
  async function tidyCo(sym, co) {
    if (stopRun || o.skipTidy) return;
    let extra = [];
    if (watchSet.has(sym)) { const j = await F(`${server}/api/db?insights=${encodeURIComponent(sym)}`, { headers: { "x-trex-key": key }, signal: AbortSignal.timeout(30000) }).then(r => r.json()).catch(() => null); if (j && j.ok) extra = j.facts || []; }
    try { const n = await tidyCompany(sym, co, extra, (sys, pr) => askClaude(F, ckey, sys, pr, null, st)); co.tdt = Date.now(); co.tv = TIDY_VERSION; return n; }
    catch (e) { if (e.fatal || e.config) { ix.keyDead = Date.now(); stopRun = true; } return 0; }
  }
  async function processCo(sym) {
    const c = ix.companies[sym]; if (c && c.t && c.v >= DEEP_VERSION && Date.now() - c.t < 120 * 864e5) return;          // read in the last 4 months
    const nTr = (order.get(sym) ?? 9999) < deepN ? deepTr : 2;
    const a = await nseG(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(nTr > 2 ? from2 : from)}&to_date=${dmy(to)}`);
    const ar = await nseG(`https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(sym)}`);
    if (a.code !== 200 && ar.code !== 200) { blocked++; if (blocked >= 5) { log("Deep reading: NSE keeps refusing — stopping for this run."); stopRun = true; return; } await sleep(15000 * blocked); await session(); return; }
    blocked = 0;
    const ann = a.j ? (Array.isArray(a.j) ? a.j : (a.j.data || [])) : []; const ars = ar.j ? (ar.j.data || []) : [];
    const list = pickDocs(sym, ann, ars, nTr).filter(d => { const x = ix.docs[d.doc]; return !(x && (x.s === 2 || (x.s === 1 && x.v >= DEEP_VERSION))); });
    const co = await loadCo(sym);
    co.flags = deepSignals(ann.filter(r => Date.parse(String(r.an_dt || r.sort_date || "").replace(/-/g, " ")) > Date.now() - 400 * 864e5));
    await companyExtras(sym, co);
    for (const d of list) { if (stopRun || Date.now() > until - 120000 || docs >= maxDocs) break; await readDoc(sym, co, d); }
    co.name = (list[0] && list[0].name) || co.name || (ann[0] && ann[0].sm_name) || sym; co.t = Date.now(); co.reader = READER_VERSION; co.v = DEEP_VERSION;
    await judgeCo(sym, co);
    await tidyCo(sym, co);
    const pending = co.docs.some(x => x.status === 0) || list.some(d => !ix.docs[d.doc]);     // a document to retry / not reached → back next run
    ix.companies[sym] = { t: pending ? 0 : Date.now(), v: DEEP_VERSION, docs: co.docs.filter(x => x.status === 1).length, facts: co.facts.length, commitments: (co.commitments || []).length, flags: (co.flags || []).filter(f => f.lvl === "red").length, n: String(co.name || "").slice(0, 60), tg: (co.tags || []).slice(0, 6), cp: (co.competitors || []).slice(0, 10), ripe: ripeCount(co), jt: co.jt || 0, tv: co.tv || 0, tdt: co.tdt || 0 };
    await saveCo(sym, co); cos++; sinceSave++;
    ix.spent = +(spent0 + claudeCost(st)).toFixed(4);
    if (ix.spent >= cap) { log(`Deep reading: budget of $${cap} reached.`); stopRun = true; }
    if (sinceSave >= 20 || Date.now() - lastPub > 8 * 60e3) { sinceSave = 0; lastPub = Date.now(); await publish(`deep reading: ${Object.keys(ix.companies).length} companies`); }   // saved at least every 8 minutes
  }
  // first: commitments of companies read earlier whose deadline has now passed (weekly check, a few minutes per run)
  { const jUntil = Math.min(until - 120000, Date.now() + (o.judgeMinutes ?? 8) * 60e3); let jn = 0;
    const due = Object.entries(ix.companies).filter(([, c]) => c && c.v >= DEEP_VERSION && c.t && (c.ripe == null || c.ripe > 0 || (c.jr || 0) < JUDGE_RULES) && (Date.now() - (c.jt || 0) > 7 * 864e5 || (c.jr || 0) < JUDGE_RULES)).map(([s]) => s);
    for (const sym of due) { if (stopRun || Date.now() > jUntil) break; const co = await loadCo(sym); const before = co.judged || 0; await judgeCo(sym, co);
      Object.assign(ix.companies[sym], { ripe: ripeCount(co), jt: co.jt || Date.now(), jr: JUDGE_RULES }); await saveCo(sym, co); jn += (co.judged || 0) - before; }
    if (due.length) log(`Deep reading: promises checked for ${Math.min(due.length, jn ? due.length : due.length)} compan${due.length === 1 ? "y" : "ies"} — ${jn} verdicts.`); }
  // then: tidy-up of companies read earlier (once), and of your watchlist companies twice a day — several at once
  let tidyLeft = 0, tidyDone = 0;
  { const tUntil = Math.min(until - 120000, Date.now() + (o.tidyMinutes ?? 12) * 60e3); let tn = 0, tc = 0;
    const due = Object.entries(ix.companies).filter(([s, c]) => c && c.v >= DEEP_VERSION && c.t && (c.tv !== TIDY_VERSION || (watchSet.has(s) && Date.now() - (c.tdt || 0) > 12 * 3600e3)))
      .map(([s]) => s).sort((a, b) => (order.get(a) ?? 9e9) - (order.get(b) ?? 9e9));
    let nx = 0; const tw = async () => { while (!stopRun && Date.now() < tUntil) { const sym = due[nx++]; if (sym === undefined) break;
      try { const co = await loadCo(sym); tn += (await tidyCo(sym, co)) || 0; if (co.tv === TIDY_VERSION) { Object.assign(ix.companies[sym], { tv: co.tv, tdt: co.tdt }); await saveCo(sym, co); tc++; } } catch (e) {} } };
    await Promise.all(Array.from({ length: Math.max(1, o.parallel || +process.env.TREX_DEEP_PARALLEL || 4) }, tw));
    tidyLeft = due.length - tc; tidyDone = tc;
    if (due.length) { log(`Deep reading: tidied ${tc} of ${due.length} companies waiting (${tn} number names given a standard name).`); ix.spent = +(spent0 + claudeCost(st)).toFixed(4); if (tc) await publish(`tidy-up: ${tc} companies`); } }
  // several companies at once (each still reads its documents one by one); NSE requests stay spaced out
  let next = 0; const par = Math.max(1, o.parallel || +process.env.TREX_DEEP_PARALLEL || 4);
  const worker = async () => { while (!stopRun && Date.now() < until - 120000 && docs < maxDocs) { const sym = tg.symbols[next++]; if (sym === undefined) break; try { await processCo(sym); } catch (e) { log("Deep reading: a company was skipped after an error: " + String(e.message || e).slice(0, 120)); } } };
  await Promise.all(Array.from({ length: par }, worker));
  if (ix.keyDead) { ix.spent = +(spent0 + claudeCost(st)).toFixed(4); await publish(`stop: key not usable`); return { ok: true, keyDead: true, docs }; }
  ix.inTok = (ix.inTok || 0) + st.inTok; ix.outTok = (ix.outTok || 0) + st.outTok; ix.t = Date.now();
  await publish(`deep reading: ${Object.keys(ix.companies).length} companies`);
  const total = tg.symbols.length, have = Object.keys(ix.companies).length;
  log(`Deep reading: ${cos} companies, ${docs} documents, ${facts} checked facts this run · ${have} of ${total} companies done · Claude cost so far ≈ $${ix.spent.toFixed(2)} (this run ≈ $${claudeCost(st).toFixed(2)}).`);
  // more to read → tell the workflow to start the next run straight away (no waiting for the clock). Companies never tried
  // count always; companies left half-done (a document to retry) and the tidy-up count only while this run made progress on
  // them — otherwise the hourly timer retries them, instead of a run every 15 minutes that changes nothing.
  const unread = tg.symbols.filter(s => !ix.companies[s]).length;
  const halfDone = tg.symbols.filter(s => { const c = ix.companies[s]; return c && !(c.v >= DEEP_VERSION && c.t); }).length;
  if (!o.skipGit && !ix.keyDead && ix.spent < cap && deepMore({ unread, halfDone, docs, tidyLeft, tidyDone })) {
    // GitHub's hourly timer is unreliable for this repository, so each run starts the next one; a run that got nothing done
    // (NSE refusing, Claude busy) asks the workflow to wait 15 minutes first
    try { writeFileSync(join(tmpdir(), "trex-deep-more"), "1"); if (docs === 0 && !tidyDone) writeFileSync(join(tmpdir(), "trex-deep-wait"), "1"); } catch (e) {} }
  return { ok: true, companies: cos, docs, facts, spent: ix.spent, have, total };
}
// start the next run at once? — yes while companies were never tried, or while this run made progress on half-done ones / the tidy-up
export function deepMore(x) { return x.unread > 0 || (x.halfDone > 0 && x.docs > 0) || (x.tidyLeft > 0 && x.tidyDone > 0); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDeep().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(0); });
