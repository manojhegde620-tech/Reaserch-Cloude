// T-Rex · READING TEST (owner: "go ahead, be careful", 17 Nov 2026). Question: does Claude read a company document just as
// accurately WITHOUT thinking first? Answers without thinking came back 3–4× faster with about as many checked facts.
// How: a small sample of midcap/smallcap documents (2025 on, spread over ranks 101–1500) is read twice with the same pages:
//   A = as the deep reader reads today (thinking; one retry without thinking when the thinking used the whole limit)
//   B = without thinking from the start
// Every number is checked on its page (the deep reader's own rules), then the accuracy checker (the stronger model, the same
// question as the deep reader's accuracy check) judges up to 8 numbers of each answer.
// Nothing is saved anywhere. This public log shows only counts (no company names, no numbers from the documents).
// Hard cap: TREX_AB_USD (default $2), counted from Claude's own usage figures; it stops before a document would pass it.
// Run: node collector/abtest.mjs   (needs ANTHROPIC_API_KEY and TREX_KEY — set by the workflow abtest.yml, manual only)
import { pathToFileURL } from "node:url";
import { selectPages, budgetFor, buildPrompt, parseFacts, parseNotes, verifyFacts, verifyNotes, parseExtras, pdfTextPoppler, askClaude, claudeCost, claudeModels } from "./insights.mjs";
import { pickDocs2, DEEP2_SINCE } from "./deepread.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const dmy = d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

// the numbers the checker sees: up to 8, picked the same way for A and B (a fixed shuffle, not the model's own order),
// only on pages that exist, at most 6 different pages — like the deep reader's accuracy check
export function sample8(facts, pages, seed = 0) {
  const fs = (facts || []).filter(f => f && f.value != null && f.page >= 1 && f.page <= pages.length)
    .map(f => [hash(seed + "|" + f.item + "|" + f.metric + "|" + f.period + "|" + f.vtext + "|" + f.page), f]).sort((a, b) => a[0] - b[0]).map(x => x[1]).slice(0, 8);
  const pg = [...new Set(fs.map(f => f.page))].slice(0, 6);
  return { pg, claims: fs.filter(f => pg.includes(f.page)).map((f, i) => ({ id: i + 1, f })) };
}
// the accuracy checker's question — the same words as in deepread.mjs (ACCURACY CHECK), so the verdicts compare
export function checkPrompt(name, sym, d, claims, pages, pg) {
  const system = "You check numbers that were taken from an Indian listed company's own document. Be strict and literal. Reply with JSON only.";
  const prompt = `Company: ${name || sym} (NSE: ${sym}). Document: ${d.type}, dated ${d.date}.
For each claim below, read the page it cites and answer:
- "ok": the page clearly gives this number for this item and this period, in this unit / scale
- "wrong": the number on the page belongs to something else (another item, another period or year, another unit, crore vs lakh vs million), or the page does not say it
- "unclear": you cannot tell from the page
For "wrong" add "why" (at most 20 words). Reply exactly as {"checks":[{"id":1,"verdict":"ok"},{"id":2,"verdict":"wrong","why":"…"}]}.

Claims:
${claims.map(c => `${c.id}. ${c.f.item} — ${c.f.metric}${c.f.period ? " — " + c.f.period : ""}: ${c.f.vtext || c.f.value} ${c.f.unit || ""} (page ${c.f.page})`).join("\n")}

${pg.map(n => `=== PAGE ${n} ===\n${String(pages[n - 1] || "").slice(0, 6000)}`).join("\n\n")}`;
  return { system, prompt };
}

export async function runAB(o = {}) {
  const server = (o.server || process.env.TREX_SERVER || "https://t-rex-cloude.manojhegde620.workers.dev").replace(/\/$/, "");
  const key = o.key ?? process.env.TREX_KEY, ckey = o.claudeKey ?? process.env.ANTHROPIC_API_KEY, F = o.fetch || globalThis.fetch;
  const log = o.log || (m => console.log(new Date().toISOString().slice(11, 19) + "  " + m));
  const CAP = +(o.capUsd ?? process.env.TREX_AB_USD ?? 2), NDOCS = Math.max(2, +(o.docs ?? process.env.TREX_AB_DOCS ?? 16));
  const until = Date.now() + (o.maxMinutes ?? 35) * 60e3, pdfText = o.pdfText || pdfTextPoppler, gap = o.gap ?? 4000;
  if (!ckey || !key) { log("Reading test: ANTHROPIC_API_KEY / TREX_KEY missing — nothing to do."); return { ok: false }; }
  // NSE refuses GitHub's computers: lists and documents come through T-Rex's server (robot key), gently spaced
  let gateT = 0;
  const trex = async (action, u) => { const w = Math.max(0, gateT - Date.now()); gateT = Math.max(Date.now(), gateT) + gap; if (w) await sleep(w);
    return F(`${server}/api/collect?action=${action}&u=${encodeURIComponent(u)}`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(120000) }); };
  const nseList = async u => { try { const r = await trex("nseapi", u); const j = await r.json().catch(() => null); return j && j.ok ? j.data : null; } catch (e) { return null; } };
  const pdfGet = async u => { try { const r = await trex("nsedoc", u); if (!r.ok) return null; const b = Buffer.from(await r.arrayBuffer()); return b.length >= 1000 ? b : null; } catch (e) { return null; } };
  const t2 = await F(`${server}/api/collect?action=deeptargets2&from=101&to=1500`, { method: "POST", headers: { "x-trex-key": key }, signal: AbortSignal.timeout(60000) }).then(r => r.json()).catch(() => null);
  const list = t2 && t2.ok && Array.isArray(t2.symbols) ? t2.symbols : [];
  if (!list.length) { log("Reading test: T-Rex gave no company list — nothing done."); return { ok: false }; }
  // models: the reader's Haiku for A and B, the newest Sonnet for the checker (as the deep reader's accuracy check)
  const stA = {}, stB = { noThinking: true }, stC = {};
  const models = await claudeModels(F, ckey, stA); stB.models = models; stB.noTemp = stA.noTemp = new Set();
  const ver = id => parseFloat((String(id).match(/(\d+)[-.](\d+)/) || [0, 0, 0]).slice(1).join(".")) || 0;
  const strong = (stA.modelList || []).filter(id => /sonnet/i.test(id)).sort((x, y) => ver(y) - ver(x)).slice(0, 1); stC.models = strong;
  const spent = () => claudeCost(stA) + claudeCost(stB) + claudeCost(stC);
  // documents: companies spread over the list (midcaps to small smallcaps), 2 documents each of different kinds
  const want = Math.ceil(NDOCS / 2), stepN = Math.max(1, Math.floor(list.length / (want * 2 + 1)));
  const cands = []; for (let i = stepN; i < list.length && cands.length < want * 2; i += stepN) cands.push(list[i]);
  const to = new Date(), from = new Date(DEEP2_SINCE + "T00:00:00Z"), docs = [];
  for (const [ci, sym] of cands.entries()) {
    if (docs.length >= NDOCS || Date.now() > until - 25 * 60e3) break;
    const a = await nseList(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(from)}&to_date=${dmy(to)}`);
    const ar = await nseList(`https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(sym)}`);
    const ann = a ? (Array.isArray(a) ? a : (a.data || [])) : [], ars = ar ? (ar.data || []) : [];
    const all = pickDocs2(sym, ann, ars), kinds = ["Earnings call transcript", "Investor presentation", "Annual report"];
    const pref = [...kinds.slice(ci % 3), ...kinds.slice(0, ci % 3)], got = [];
    for (const k of pref) { const d = all.find(x => x.type.startsWith(k)); if (d && got.length < 2) got.push(d); }
    docs.push(...got.slice(0, NDOCS - docs.length));
  }
  log(`Reading test: ${docs.length} documents from ${new Set(docs.map(d => d.symbol)).size} companies (ranks 101–1500, 2025 on) · cap $${CAP} · checker ${strong[0] || "none"}.`);
  const S = { A: { n: 0, raw: 0, fv: 0, nv: 0, com: 0, s: 0, usd: 0, fail: 0, retry: 0, ck: 0, ok: 0, wrong: 0, unclear: 0 }, B: { n: 0, raw: 0, fv: 0, nv: 0, com: 0, s: 0, usd: 0, fail: 0, retry: 0, ck: 0, ok: 0, wrong: 0, unclear: 0 }, docs: 0, same: 0, skipped: 0, stop: "" };
  const pj = t => { const m = String(t || "").match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch (e) { return null; } };
  for (const [i, d] of docs.entries()) {
    const id = i + 1, kind = d.type.replace(/\s*\d{4}-\d{4}$/, "");
    if (spent() + 0.15 > CAP) { S.stop = "cap"; log(`Reading test: stopping before document ${id} — the $${CAP} cap would be passed.`); break; }
    if (Date.now() > until - 4 * 60e3) { S.stop = "time"; log(`Reading test: stopping before document ${id} — time is up.`); break; }
    const buf = await pdfGet(d.doc); if (!buf) { S.skipped++; log(`  doc ${id} (${kind}): could not download — skipped`); continue; }
    let pages = []; try { pages = await pdfText(buf); } catch (e) { S.skipped++; log(`  doc ${id} (${kind}): PDF damaged — skipped`); continue; }
    if (pages.join("").replace(/\s/g, "").length < 120) { S.skipped++; log(`  doc ${id} (${kind}): no text (scanned) — skipped`); continue; }
    let pagesRaw = null; if (pdfText === pdfTextPoppler) { try { pagesRaw = await pdfTextPoppler(buf, false); } catch (e) {} }
    const sel = selectPages(pages, Math.round(budgetFor(d.type) * 2));
    if (!sel.length) { S.skipped++; log(`  doc ${id} (${kind}): no business pages — skipped`); continue; }
    const { system, prompt } = buildPrompt(d.name, d.symbol, d.type, d.date, sel, { ext: true });
    const one = async st => { const c0 = claudeCost(st), t0 = Date.now(); let retry = false;
      try { const ans = await askClaude(F, ckey, system, prompt, m => { if (/asking again without thinking/.test(m)) retry = true; }, st);
        const raw = parseFacts(ans.text) || [], fv = verifyFacts(raw, pages), nv = verifyNotes(parseNotes(ans.text), [pagesRaw, pages]), ex = parseExtras(ans.text, [pagesRaw, pages]);
        return { ok: true, raw: raw.length, fv, nv: nv.length, com: ex.commitments.length, s: (Date.now() - t0) / 1000, usd: claudeCost(st) - c0, retry }; }
      catch (e) { if (e.fatal || e.config) throw e; return { ok: false, fv: [], raw: 0, nv: 0, com: 0, s: (Date.now() - t0) / 1000, usd: claudeCost(st) - c0, retry }; } };
    let ra, rb; try { [ra, rb] = await Promise.all([one(stA), one(stB)]); }
    catch (e) { S.stop = "key"; log("Reading test: Claude key problem — stopping."); break; }
    const check = async r => { if (!r.ok || !r.fv.length || !strong.length) return { n: 0, ok: 0, wrong: 0, unclear: 0 };
      const { pg, claims } = sample8(r.fv, pages, id); if (!claims.length) return { n: 0, ok: 0, wrong: 0, unclear: 0 };
      const q = checkPrompt(d.name, d.symbol, d, claims, pages, pg);
      let ans; try { ans = await askClaude(F, ckey, q.system, q.prompt, null, stC); } catch (e) { if (e.fatal || e.config) throw e; return { n: 0, ok: 0, wrong: 0, unclear: 0 }; }
      const j = pj(ans.text), L = j && Array.isArray(j.checks) ? j.checks : [], c = { n: 0, ok: 0, wrong: 0, unclear: 0 };
      for (const v of L) { if (!claims.some(x => x.id === v.id)) continue; const k = String(v.verdict || "").toLowerCase(); c.n++; if (k === "ok") c.ok++; else if (k === "wrong") c.wrong++; else c.unclear++; }
      return c; };
    let ca, cb; try { [ca, cb] = await Promise.all([check(ra), check(rb)]); } catch (e) { S.stop = "key"; log("Reading test: Claude key problem — stopping."); break; }
    const kA = new Set(ra.fv.map(f => f.page + "|" + f.vtext)), same = rb.fv.filter(f => kA.has(f.page + "|" + f.vtext)).length;
    S.docs++; S.same += same;
    for (const [T, r, c] of [[S.A, ra, ca], [S.B, rb, cb]]) { T.n++; if (!r.ok) T.fail++; if (r.retry) T.retry++; T.raw += r.raw; T.fv += r.fv.length; T.nv += r.nv; T.com += r.com; T.s += r.s; T.usd += r.usd; T.ck += c.n; T.ok += c.ok; T.wrong += c.wrong; T.unclear += c.unclear; }
    const side = (r, c) => r.ok ? `${r.fv.length} numbers on the page of ${r.raw} found, ${r.nv} quotes, ${r.com} commitments, ${Math.round(r.s)}s, $${r.usd.toFixed(4)}${r.retry ? " (asked again without thinking)" : ""} · checker ${c.ok} right / ${c.wrong} wrong / ${c.unclear} unclear` : `no answer, ${Math.round(r.s)}s, $${r.usd.toFixed(4)}`;
    log(`  doc ${id} (${kind}): A ${side(ra, ca)}`);
    log(`  doc ${id} (${kind}): B ${side(rb, cb)} · ${same} numbers same as A`);
  }
  const pct = (a, b) => b ? (100 * a / b).toFixed(1) + "%" : "—";
  for (const [k, T] of [["A (as today, thinking)", S.A], ["B (without thinking)", S.B]])
    log(`Reading test ${k}: ${T.n} documents, ${T.fail} without answer, ${T.retry} asked again · ${T.fv} numbers confirmed on the page of ${T.raw} found (${pct(T.fv, T.raw)}), ${T.nv} quotes, ${T.com} commitments · checker: ${T.ok} right, ${T.wrong} wrong (${pct(T.wrong, T.ck)}), ${T.unclear} unclear of ${T.ck} · ${T.n ? Math.round(T.s / T.n) : 0}s and $${(T.n ? T.usd / T.n : 0).toFixed(4)} a document.`);
  const total = spent();
  log(`Reading test: ${S.docs} documents compared, ${S.skipped} skipped · numbers found by both: ${S.same} · spent $${total.toFixed(3)} of the $${CAP} cap (A $${claudeCost(stA).toFixed(3)}, B $${claudeCost(stB).toFixed(3)}, checker $${claudeCost(stC).toFixed(3)}).`);
  return { ok: true, ...S, spent: total };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAB().then(() => process.exit(0)).catch(e => { console.error("Reading test stopped: " + String(e && e.message || e).slice(0, 200)); process.exit(0); });
