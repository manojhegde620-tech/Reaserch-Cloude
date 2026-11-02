// T-Rex document reader: what a company sells, where, to whom, its capacity & utilisation, market position, guidance and
// cost drivers — from company documents on NSE (earnings-call transcripts, investor presentations, BRSR, annual reports)
// for the companies on your watchlists. Numbers AND short quotes are kept only if found on the page.
//  • Each new document is read ONCE: its text is taken out of the PDF here, the most relevant pages are sent to an AI
//    (Google Gemini free tier first, Cloudflare's own AI as the backup) which lists the numbers it finds.
//  • Every number the AI returns is checked against the PDF text: it must appear on the page the AI named (or on exactly
//    one other page). Anything that cannot be found word-for-word is thrown away. The stored quote is cut from the PDF itself.
//  • Results are labelled "AI-extracted — verify" in the app and kept apart from the filing data.
import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const METRICS = ["revenue", "revenue_share", "sales_volume", "production", "capacity", "utilisation", "capacity_addition", "capex", "realisation", "margin", "ebitda", "order_book",
  "market_share", "market_size", "export_share", "geography_revenue", "countries_served", "customer_share", "customer_count", "plants", "cost_share", "guidance", "other"];
export const NOTE_TOPICS = ["what_they_do", "customers", "markets", "plants", "market_position", "guidance", "costs"];
export const READER_VERSION = 2;
export const COMMIT_KINDS = ["revenue_growth", "volume_growth", "margin", "profit", "capacity", "capex", "commissioning", "launch", "order_inflow", "debt", "market_share", "other"];                              // documents read by an older reader are read again once
const KW = /capacit|utili[sz]|\bMTPA\b|\bKTPA\b|\bTPA\b|\btonnes?\b|\bMT\b|\bKL\b|\bKLPD\b|\bMW\b|\bGW\b|volume|production|product|segment|revenue mix|sales mix|plant|expansion|capex|commission|realis|realiz|market share|order book|EBITDA|margin|units|brownfield|greenfield|debottleneck/gi;
// each kind of fact has its own words, so the best pages for EVERY kind are sent — not only the capacity pages
const CATS = {
  products: KW,
  geo: /export|domestic|geograph|outside India|overseas|countries|international|region|North America|Europe|\bUSA?\b|Middle East|Africa|South East Asia/gi,
  customers: /customer|client|\bOEMs?\b|single external customer|top (?:five|ten|5|10|3|three)|key accounts|offtake|tie-?up|repeat order|supplier to/gi,
  market: /market share|market leader|largest|leading|position|\brank|No\.\s?1|second largest|duopoly|monopoly|competitor/gi,
  guidance: /guidance|outlook|expect|going forward|next year|target|visibility|pipeline|order (?:book|inflow)|we see|we plan|we aim|by FY\d\d/gi,
  brsr: /Products\/Services sold|Markets served|Number of locations|NIC Code|of total Turnover|contribution of exports|types of customers|Details of business activities/gi,
  costs: /raw material|cost of materials|power and fuel|freight|input cost|commodity|cotton|steel|polymer|crude|pricing|pass[- ]?through/gi,
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dmy = d => `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;

export function pdfTextPoppler(buf, layout = true) {        // → array of page texts (needs poppler's pdftotext); layout=false keeps reading order (better for sentences)
  return new Promise(async (resolve, reject) => {
    const f = join(tmpdir(), "trex-" + Math.random().toString(36).slice(2) + ".pdf");
    await writeFile(f, buf);
    execFile("pdftotext", [...(layout ? ["-layout"] : []), "-enc", "UTF-8", f, "-"], { maxBuffer: 128 * 1024 * 1024, timeout: 120000 }, async (err, out) => {
      await rm(f, { force: true });
      if (err) return reject(err);
      resolve(String(out).split("\f").map(s => s.replace(/[ \t]+$/gm, "")));
    });
  });
}

// pick the pages most likely to hold useful facts, within a size budget: the best 2 pages for EACH kind of fact first,
// then the best remaining pages overall
export function budgetFor(type) { return /transcript/i.test(type) ? 36000 : /annual report/i.test(type) ? 42000 : /brsr/i.test(type) ? 30000 : 26000; }
export function selectPages(pages, budget = 22000) {
  const valid = pages.map((t, i) => ({ i, t })).filter(p => p.t.trim().length > 40);
  const nums = t => Math.min((t.match(/\d[\d,.]*/g) || []).length, 60);
  const cnt = (t, re) => (t.match(re) || []).length;
  const pick = new Map(); let used = 0;
  const take = p => { if (pick.has(p.i)) return true; const t = p.t.replace(/[ ]{3,}/g, "   ").slice(0, 6000); if (used + t.length > budget && pick.size) return false; pick.set(p.i, t); used += t.length; return true; };
  for (const re of Object.values(CATS)) {
    const best = valid.map(p => ({ p, k: cnt(p.t, re), s: cnt(p.t, re) * 3 + nums(p.t) * 0.2 })).filter(x => x.k >= 2).sort((a, b) => b.s - a.s).slice(0, 2);
    for (const x of best) take(x.p);
  }
  const all = valid.map(p => ({ p, s: Object.values(CATS).reduce((a, re) => a + cnt(p.t, re), 0) * 2 + nums(p.t) * 0.3 })).filter(x => x.s > 2).sort((a, b) => b.s - a.s);
  for (const x of all) { if (used > budget) break; take(x.p); }
  return [...pick].map(([i, text]) => ({ page: i + 1, text })).sort((a, b) => a.page - b.page);
}

export function buildPrompt(company, symbol, type, date, sel, opt = {}) {
  const system = "You extract business facts from an Indian listed company's document for investors. Reply with JSON only.";
  const prompt = `Company: ${company} (NSE: ${symbol}). Document: ${type}, dated ${date}.
Read the pages below and list what an investor needs to understand the business on the ground.

A) "facts": numbers written in the text about:
 - what they sell: revenue / sales / share of revenue by product, segment or business line; sales volume; realisation (price per unit); segment margin or EBITDA
 - capacity: installed capacity, production, capacity utilisation, capacity being added (with timeline), capex, number of plants
 - where they sell: export share of revenue, revenue by country/region (domestic vs export), number of countries served
 - who buys: share of revenue from the largest customer / top 5 / top 10 customers, number of customers, a named customer's share
 - market position: market share in % (with the market it refers to); market size of the industry (metric market_size, NOT market_share)
 - orders & guidance: order book, management targets or guidance (growth %, margin %, capacity by a date)
 - costs: a raw material or cost item as % of sales or of costs
 For each: "item" (product / segment / plant / region / customer group / cost item, as written), "metric" (one of ${METRICS.join(", ")}),
 "period" (as written, e.g. "Q2 FY27", "FY26", "by FY28"; "" if not stated), "value" (the number exactly as written, no commas),
 "unit" (as written: "%", "Rs Cr", "MTPA", "units", "countries", …), "page" (the PAGE number it is on).

B) "notes": short sentences COPIED WORD-FOR-WORD from the pages (not summaries) that say, in words, things numbers cannot:
 what the company makes and does, who its main customers are (names if written), which markets/countries it serves,
 where its plants are, its market position or competitive edge, management guidance/outlook, raw-material and pricing comments.
 For each: "topic" (one of ${NOTE_TOPICS.join(", ")}), "text" (the exact sentence or phrase from the page, 8–45 words), "page".

Rules: copy numbers and sentences exactly; never calculate, convert, round, summarise or guess; skip anything unclear;
at most 100 facts and 24 notes (at most 4 notes per topic); prefer the most recent period.
${opt.ext ? `
C) "commitments": forward-looking promises or targets stated by management (growth, margins, capacity, capex, plant commissioning,
 product launches, order inflow, debt reduction, market share). For each: "what" (short, as written), "kind" (one of ${COMMIT_KINDS.join(", ")}),
 "target" (the target exactly as written, e.g. "18-20%", "₹500 crore", "1 MTPA"), "value" (the main number in the target, or null), "unit",
 "by" (the deadline/period exactly as written, e.g. "FY27", "Q3 FY27", "by March 2027"; "" if none), "text" (the sentence COPIED word-for-word, 8–45 words), "page". At most 12.
${/transcript/i.test(type) ? `D) "concerns": the most important questions analysts asked about risks, problems or doubts. For each: "topic" (2–4 words),
 "text" (the question COPIED word-for-word, 8–45 words), "answer" (management's key reply sentence COPIED word-for-word, or "" if none), "page". At most 6.
` : ""}E) "competitors": names of other companies mentioned as competitors or peers, exactly as written. At most 8.
F) "tags": 3–6 short lowercase product/industry categories that describe what this company sells (e.g. "centrifugal pumps", "industrial valves").
Reply as {"facts":[...],"notes":[...],"commitments":[{"what":"","kind":"","target":"","value":null,"unit":"","by":"","text":"","page":0}],"concerns":[{"topic":"","text":"","answer":"","page":0}],"competitors":[""],"tags":[""]}` : `Reply as {"facts":[{"item":"","metric":"","period":"","value":"","unit":"","page":0}],"notes":[{"topic":"","text":"","page":0}]}`}
${sel.map(p => `\n=== PAGE ${p.page} ===\n${p.text}`).join("\n")}`;
  return { system, prompt };
}

// an answer cut off at the length limit: keep every complete fact/note and close the brackets
export function salvageJson(s) {
  const a = s.indexOf("{"); if (a < 0) return null; const t = s.slice(a);
  let inStr = false, esc = false; const stack = []; let lastOk = -1, lastStack = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{" || c === "[") stack.push(c); else if (c === "}" || c === "]") { stack.pop(); if (c === "}" && stack[stack.length - 1] === "[") { lastOk = i; lastStack = stack.slice(); } }
  }
  if (lastOk < 0) return null;
  const close = lastStack.slice().reverse().map(c => c === "{" ? "}" : "]").join("");
  try { return JSON.parse(t.slice(0, lastOk + 1) + close); } catch (e) { return null; }
}
function parseJson(text) {
  if (!text) return null; const s = String(text); const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) { const c = s.indexOf("["), d = s.lastIndexOf("]"); if (c >= 0 && d > c) { try { return JSON.parse(s.slice(c, d + 1)); } catch (e) {} } return null; }
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return salvageJson(s); }
}
export function parseFacts(text) { const j = parseJson(text); if (!j) return null; return Array.isArray(j.facts) ? j.facts : (Array.isArray(j) ? j : null); }
export function parseNotes(text) { const j = parseJson(text); return j && Array.isArray(j.notes) ? j.notes : []; }

// keep only notes whose words really are on the page; the stored quote is cut from the PDF itself (never the AI's wording)
export function verifyNotes(notes, pagesSets) {
  const toks = s => String(s || "").split(/\s+/).filter(Boolean);
  const nrm = w => w.toLowerCase().replace(/[^a-z0-9%]/g, "");
  const out = [], seen = new Set(), per = {};
  for (const n of notes || []) {
    if (!n || typeof n !== "object") continue;
    const topic = NOTE_TOPICS.includes(String(n.topic || "").toLowerCase()) ? String(n.topic).toLowerCase() : null; if (!topic) continue;
    const want = toks(n.text).map(nrm).filter(w => w.length >= 2); if (want.length < 6 || want.length > 70) continue;
    if ((per[topic] || 0) >= 4) continue;
    let best = null;
    const tryPage = (pages, pi) => {
      if (pi < 0 || pi >= pages.length || !pages[pi]) return;
      const orig = toks(pages[pi]), low = orig.map(nrm), L = want.length, W = L + Math.ceil(L * 0.3);
      for (let s = 0; s + Math.min(L, low.length) <= low.length; s++) {
        if (low[s] !== want[0] && low[s] !== want[1] && low[s] !== want[2]) continue;   // a quote starts (almost) where the sentence starts
        const win = low.slice(s, s + W); const bag = new Map(); win.forEach(w => bag.set(w, (bag.get(w) || 0) + 1));
        let hit = 0; for (const w of want) { const c = bag.get(w) || 0; if (c > 0) { hit++; bag.set(w, c - 1); } }
        const cov = hit / L; if (cov >= 0.86 && (!best || cov > best.cov)) {
          let e = s; let k = 0; for (let j = s; j < Math.min(low.length, s + W) && k < L; j++) { if (want.includes(low[j])) { k++; e = j; } }
          best = { cov, page: pi + 1, quote: orig.slice(s, e + 1).join(" ").slice(0, 400) };
        }
      }
    };
    const pg = Math.round(+n.page) - 1;
    for (const pages of pagesSets) { if (pages) tryPage(pages, pg); if (best && best.cov === 1) break; }
    if (!best) for (const pages of pagesSets) { if (!pages) continue; for (let i = 0; i < pages.length && !best; i++) if (i !== pg) tryPage(pages, i); if (best) break; }
    if (!best) continue;
    const key = best.quote.toLowerCase(); if (seen.has(key)) continue; seen.add(key); per[topic] = (per[topic] || 0) + 1;
    out.push({ item: best.quote.slice(0, 80), metric: "note:" + topic, period: "", value: null, vtext: topic, unit: "", page: best.page, quote: best.quote });
  }
  return out;
}

// one sentence the AI says it copied: find it on the page (or elsewhere in the document) — returns the quote cut from the PDF itself
export function findQuote(text, page, pagesSets) {
  const toks = s => String(s || "").split(/\s+/).filter(Boolean), nrm = w => w.toLowerCase().replace(/[^a-z0-9%]/g, "");
  const want = toks(text).map(nrm).filter(w => w.length >= 2); if (want.length < 5 || want.length > 80) return null;
  let best = null;
  const tryPage = (pages, pi) => {
    if (pi < 0 || pi >= pages.length || !pages[pi]) return;
    const orig = toks(pages[pi]), low = orig.map(nrm), L = want.length, W = L + Math.ceil(L * 0.3);
    for (let s = 0; s + Math.min(L, low.length) <= low.length; s++) {
      if (low[s] !== want[0] && low[s] !== want[1] && low[s] !== want[2]) continue;
      const bag = new Map(); low.slice(s, s + W).forEach(w => bag.set(w, (bag.get(w) || 0) + 1));
      let hit = 0; for (const w of want) { const c = bag.get(w) || 0; if (c > 0) { hit++; bag.set(w, c - 1); } }
      const cov = hit / L; if (cov >= 0.86 && (!best || cov > best.cov)) { let e = s, k = 0; for (let j = s; j < Math.min(low.length, s + W) && k < L; j++) if (want.includes(low[j])) { k++; e = j; } best = { cov, page: pi + 1, quote: orig.slice(s, e + 1).join(" ").slice(0, 420) }; }
    }
  };
  const pg = Math.round(+page) - 1;
  for (const pages of pagesSets) { if (pages) tryPage(pages, pg); if (best && best.cov === 1) break; }
  if (!best) for (const pages of pagesSets) { if (!pages) continue; for (let i = 0; i < pages.length && !best; i++) if (i !== pg) tryPage(pages, i); if (best) break; }
  return best;
}
// commitments, analyst concerns, competitors and product tags (deep reader): sentences must be on the page, names in the document
export function parseExtras(text, pagesSets) {
  let j = null; { const s = String(text || ""); const a = s.indexOf("{"), b = s.lastIndexOf("}"); try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { j = salvageJson(s); } }
  const out = { commitments: [], concerns: [], competitors: [], tags: [] }; if (!j) return out;
  const all = (pagesSets.find(Boolean) || []).join("\n").toLowerCase();
  for (const c of (Array.isArray(j.commitments) ? j.commitments : []).slice(0, 15)) {
    if (!c || typeof c !== "object") continue; const q = findQuote(c.text, c.page, pagesSets); if (!q) continue;
    const v = c.value == null || c.value === "" ? null : Number(String(c.value).replace(/,/g, ""));
    out.commitments.push({ what: String(c.what || "").slice(0, 120), kind: COMMIT_KINDS.includes(String(c.kind)) ? String(c.kind) : "other", target: String(c.target || "").slice(0, 60), value: isFinite(v) ? v : null, unit: String(c.unit || "").slice(0, 20), by: String(c.by || "").slice(0, 40), quote: q.quote, page: q.page });
  }
  for (const c of (Array.isArray(j.concerns) ? j.concerns : []).slice(0, 8)) {
    if (!c || typeof c !== "object") continue; const q = findQuote(c.text, c.page, pagesSets); if (!q) continue;
    const a = c.answer ? findQuote(c.answer, c.page, pagesSets) : null;
    out.concerns.push({ topic: String(c.topic || "").slice(0, 40), quote: q.quote, page: q.page, answer: a ? a.quote : "", apage: a ? a.page : null });
  }
  out.competitors = [...new Set((Array.isArray(j.competitors) ? j.competitors : []).map(x => String(x || "").trim()).filter(x => x.length >= 3 && x.length <= 60 && all.includes(x.toLowerCase())))].slice(0, 10);
  out.tags = [...new Set((Array.isArray(j.tags) ? j.tags : []).map(x => String(x || "").toLowerCase().replace(/[^a-z0-9 &\-]/g, "").trim()).filter(x => x.length >= 3 && x.length <= 40))].slice(0, 6);
  return out;
}

// keep only facts whose number is really on the page (the PDF text decides, not the AI)
export function verifyFacts(facts, pages) {
  const norm = t => String(t).replace(/(\d),(?=\d)/g, "$1");                    // 1,20,000 → 120000
  const npages = pages.map(norm);
  const out = [], seen = new Set();
  for (const f of facts || []) {
    if (!f || typeof f !== "object") continue;
    let raw = String(f.value ?? "").trim().replace(/,/g, "").replace(/^\+/, ""); if (!/^-?\d+(\.\d+)?$/.test(raw)) continue;
    const variants = new Set([raw, raw.replace(/\.0+$/, ""), raw.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")]);
    const re = new RegExp(`(?<![\\d.])(${[...variants].map(v => v.replace(/[.\-]/g, m => "\\" + m)).join("|")})(?![\\d])`);
    const item = String(f.item || "").replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim().slice(0, 80); if (!item) continue;
    const words = item.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    const ok = i => i >= 0 && i < npages.length && re.test(npages[i]) && (!words.length || words.some(w => npages[i].toLowerCase().includes(w)));
    let pg = Math.round(+f.page) - 1;
    if (!ok(pg)) { const hits = npages.map((_, i) => i).filter(ok); if (hits.length !== 1) continue; pg = hits[0]; }
    const orig = new RegExp(`(?<![\\d.,])(${[...variants].map(v => v.replace(/\d(?=\d)/g, "$&,?").replace(/\./g, "\\.")).join("|")})(?![\\d])`);
    const m = pages[pg].match(orig) || npages[pg].match(re); const src = pages[pg].match(orig) ? pages[pg] : npages[pg]; const at = m ? m.index : 0;
    const quote = src.slice(Math.max(0, at - 70), at + 70).replace(/\s+/g, " ").trim();
    const metric = METRICS.includes(String(f.metric || "").toLowerCase()) ? String(f.metric).toLowerCase() : "other";
    const period = String(f.period || "").trim().slice(0, 40);
    const key = [item.toLowerCase(), metric, period.toLowerCase(), raw].join("|"); if (seen.has(key)) continue; seen.add(key);
    out.push({ item, metric, period, value: +raw, vtext: raw, unit: String(f.unit || "").trim().slice(0, 20), page: pg + 1, quote });
  }
  return out;
}

async function pickGeminiModel(F, key) {
  const r = await F("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error("Gemini model list: HTTP " + r.status);
  const j = await r.json();
  const list = (j.models || []).filter(m => /gemini/i.test(m.name) && /flash/i.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent") && !/image|tts|audio|live|embed|exp/i.test(m.name));
  const score = m => { const v = parseFloat((m.name.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]); return (/preview/i.test(m.name) ? 0 : 1000) + v * 10 - (/lite/i.test(m.name) ? 1 : 0); };   // stable before preview, newest first
  return list.sort((a, b) => score(b) - score(a)).map(m => m.name);
}
// Google counts the free allowance per project AND per model: when one model's limit is reached, the others may still have
// theirs. `used` remembers, for this run, which models are spent (daily) or resting (per-minute), so they are skipped.
async function askGemini(F, key, models, system, prompt, log, used = new Map()) {
  let last = "", fails = 0;
  const short = n => n.replace(/^models\//, "");
  const resting = n => { const u = used.get(n); return u === "day" || (typeof u === "number" && u > Date.now()); };
  for (const name of models) {
    if (resting(name)) continue;
    if (fails >= 3) break;                                   // three slow / busy answers in a row: leave it for now
    let quotaHit = false;
    for (const think of [true, false]) {                     // ask for no long "thinking" (much faster); older models may not accept that setting
      const t0 = Date.now(); let r;
      const gc = { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192, ...(think ? { thinkingConfig: { thinkingBudget: 0 } } : {}) };
      try { r = await F(`https://generativelanguage.googleapis.com/v1beta/${name}:generateContent`, { method: "POST", signal: AbortSignal.timeout(110000),
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: gc }) }); }
      catch (e) { last = `${short(name)}: no answer in ${Math.round((Date.now() - t0) / 1000)}s`; log && log("    " + last); fails++; break; }
      const txt = await r.text();
      if (r.status === 429) {                                // this model's free limit: per day (resets midnight Pacific) or per minute
        const daily = /per ?day|PerDay|daily/i.test(txt); used.set(name, daily ? "day" : Date.now() + 61000); quotaHit = true;
        last = `${short(name)}: free ${daily ? "daily" : "per-minute"} limit reached`; log && log(`    ${last} — trying the next model`); break; }
      if (r.status === 400 && think) continue;
      if (!r.ok) { let m = ""; try { m = JSON.parse(txt).error.message; } catch (e) { m = txt; }
        last = `${short(name)}: HTTP ${r.status}${r.status === 503 ? " (Google busy)" : ""} ${String(m || "").replace(/\s+/g, " ").slice(0, 90)}`; log && log("    " + last); fails++; break; }
      try { const j = JSON.parse(txt); const out = ((j.candidates || [])[0] || {}).content; const t = ((out && out.parts) || []).map(p => p.text || "").join("");
        if (t) { log && log(`    ${short(name)} answered in ${Math.round((Date.now() - t0) / 1000)}s`);
          const k = models.indexOf(name); if (k > 0) { models.splice(k, 1); models.unshift(name); }      // keep using the model that answered
          return { model: short(name), text: t }; } last = name + ": empty answer"; }
      catch (e) { last = name + ": unreadable answer"; }
      fails++; break;
    }
    if (quotaHit) continue;
  }
  if (models.length && models.every(resting)) {               // every model has reached its free limit
    const e = new Error("Gemini free limit reached on every model"); e.quota = true; e.daily = models.every(n => used.get(n) === "day"); throw e; }
  throw new Error(last || "Gemini unavailable");
}

// Claude (your own Anthropic API key, paid from the plan's monthly API credit): fast and steady. Cheapest suitable model first.
// Throws with .fatal when the key is missing / expired / out of credit (then the other AIs take over for good).
export const CLAUDE_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
// which Claude models this key may use (asked once): the cheapest suitable (Haiku) first, then Sonnet
export async function claudeModels(F, key, st = {}) {
  if (st.models) return st.models;
  let ids = [];
  try {
    const r = await F("https://api.anthropic.com/v1/models?limit=100", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(30000) });
    if (r.status === 401 || r.status === 403) { const e = new Error("Claude: the API key is not valid (HTTP " + r.status + ")"); e.fatal = true; throw e; }
    if (r.ok) { const j = await r.json(); ids = (j.data || []).map(m => m.id).filter(Boolean); }
  } catch (e) { if (e.fatal) throw e; }
  const ver = id => parseFloat((String(id).match(/(\d+)[-.](\d+)/) || [0, 0, 0]).slice(1).join(".")) || parseFloat((String(id).match(/-(\d+)(?:-|$)/) || [0, 0])[1]) || 0;
  const pick = re => ids.filter(id => re.test(id)).sort((a, b) => ver(b) - ver(a));
  const hk = pick(/haiku/i); const found = hk.length ? hk : pick(/sonnet/i);
  st.models = found.length ? [...new Set([...found.slice(0, 3)])] : CLAUDE_MODELS.slice();
  st.modelList = ids;
  return st.models;
}
export async function askClaude(F, key, system, prompt, log, st = {}) {
  let last = "", notAvail = 0;
  const models = await claudeModels(F, key, st);
  let busy = 0;
  for (const model of models) {
    let temp = true;
    for (let t = 0; t < 8; t++) {
      const t0 = Date.now(); let r, txt = "";
      try { r = await F("https://api.anthropic.com/v1/messages", { method: "POST", signal: AbortSignal.timeout(150000),
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: 16000, ...(temp ? { temperature: 0 } : {}), system, messages: [{ role: "user", content: prompt }] }) }); txt = await r.text(); }
      catch (e) { last = `${model}: no answer in ${Math.round((Date.now() - t0) / 1000)}s`; log && log("    " + last); await sleep(5000); continue; }
      let j = null; try { j = JSON.parse(txt); } catch (e) {}
      const msg = String((j && j.error && j.error.message) || txt).replace(/\s+/g, " ").slice(0, 160);
      if (r.status === 429 || r.status === 529 || r.status >= 500) {           // busy / rate limit: wait as told, then again
        const wait = Math.min(90, Math.max(5, +(r.headers.get("retry-after") || 0) || 10 * (t + 1))); busy++; last = `${model}: HTTP ${r.status} (${r.status === 429 ? "rate limit" : "busy"})`; log && log(`    ${last} — waiting ${wait}s`); await sleep(wait * 1000); continue; }
      if (r.status === 401 || r.status === 403 || (r.status >= 400 && /credit balance|billing|disabled|expired/i.test(msg))) {
        const e = new Error(`Claude: ${r.status === 401 ? "the API key is not valid any more" : msg}`); e.fatal = true; throw e; }
      if (r.status === 400 && temp && /temperature/i.test(msg)) { temp = false; continue; }   // a model that sets its own temperature
      if (r.status === 404 || (r.status === 400 && /model/i.test(msg))) { last = `${model}: not available (${msg})`; notAvail++; break; }       // try the next model
      if (!r.ok) { last = `${model}: HTTP ${r.status} ${msg}`; log && log("    " + last); const e = new Error(last); e.busy = r.status === 408 || r.status === 409; throw e; }   // a problem with this request: try it again next run — never move to a dearer model for it
      const text = ((j && j.content) || []).filter(c => c.type === "text").map(c => c.text).join("");
      const u = (j && j.usage) || {}; st.inTok = (st.inTok || 0) + (u.input_tokens || 0); st.outTok = (st.outTok || 0) + (u.output_tokens || 0);
      const pr = claudePrice(model); st.cost = (st.cost || 0) + ((u.input_tokens || 0) * pr[0] + (u.output_tokens || 0) * pr[1]) / 1e6;
      if (text) { log && log(`    ${model} answered in ${Math.round((Date.now() - t0) / 1000)}s`); return { model, text }; }
      last = `${model}: empty answer (${(j && j.stop_reason) || "?"})`; log && log("    " + last); throw new Error(last);
    }
    if (/rate limit|busy/.test(last) && last.startsWith(model)) break;     // still busy after waiting: try this document again next run (no dearer model)
  }
  const e = new Error(last || "Claude unavailable");
  if (notAvail && notAvail === models.length) e.config = true;
  if (/rate limit|busy|no answer/.test(last)) e.busy = true;   // no model can be used with this key: a set-up problem, not the document's fault
  throw e;
}
// approximate cost in US$ of the tokens used (Haiku 5.5 list price per million tokens: $0.10 in, $0.50 out — check the Claude pricing page)
// US$ per million tokens (input, output) — Claude pricing page, Nov 2026; unknown models are counted at the dearest Haiku rate
export const claudePrice = m => /haiku-5/i.test(m) ? [0.10, 0.50] : /haiku/i.test(m) ? [1, 5] : /sonnet/i.test(m) ? [2, 10] : /opus/i.test(m) ? [4, 20] : [1, 5];
export const claudeCost = st => st.cost != null ? st.cost : ((st.inTok || 0) * 0.10 + (st.outTok || 0) * 0.50) / 1e6;

// main: called from collect.mjs with its NSE session + T-Rex helpers
export async function runInsights({ trex, nse, pdfGet, log: log0, until, geminiKey, claudeKey = process.env.ANTHROPIC_API_KEY || "", fetch: F = globalThis.fetch, pdfText = pdfTextPoppler, maxDocs = 6, extra = "", publicLog = process.env.TREX_PUBLIC_LOG === "1", geminiKey2 = process.env.GEMINI_KEY_2 || "" }) {
  const stats = { docs: 0, facts: 0, model: {} };
  const tg = await trex("aitargets", extra ? { extra } : {});
  // public repository: its run logs can be read by anyone, so your watchlist company names are hidden in them
  const hide = [...new Set([...((tg && tg.symbols) || [])])].sort((a, b) => b.length - a.length);
  const log = m => log0(publicLog ? hide.reduce((s, x) => s.replace(new RegExp(`\\b${x.replace(/[.*+?^${}()|[\]\\&-]/g, "\\$&")}\\b`, "g"), "[company]"), String(m)) : m);
  if (!tg || !tg.ok) { log("Documents: T-Rex problem: " + (tg && tg.error)); return stats; }
  if (!tg.symbols.length) { log("Documents: no watchlist companies yet (T-Rex reads your watchlist from the cloud backup)."); return stats; }
  const done = new Set(tg.done || []);
  const to = new Date(), from = new Date(Date.now() - 400 * 864e5);
  const queue = [];
  for (const sym of tg.symbols) {
    if (Date.now() > until - 60000) break;
    const a = await nse(`https://www.nseindia.com/api/corporate-announcements?index=equities&symbol=${encodeURIComponent(sym)}&from_date=${dmy(from)}&to_date=${dmy(to)}`);
    let rows = []; try { const j = JSON.parse(a.body ? a.body.toString("utf8") : "[]"); rows = Array.isArray(j) ? j : (j.data || []); } catch (e) {}
    const txt = r => `${r.desc || ""} ${r.attchmntText || ""} ${r.attchmntFile || ""}`;
    const mk = type => r => ({ symbol: sym, name: r.sm_name || sym, doc: r.attchmntFile, type, date: String(r.an_dt || r.sort_date || "").slice(0, 11) });
    const pdf = r => /\.pdf$/i.test(String(r.attchmntFile || ""));
    const pres = rows.filter(r => pdf(r) && /investor presentation/i.test(String(r.desc || ""))).slice(0, 2).map(mk("Investor presentation"));
    // earnings-call transcripts (SEBI: filed within 5 working days of each call) — management on capacity, customers, market share, guidance
    const trs = rows.filter(r => pdf(r) && /transcript/i.test(txt(r)) && !/investor presentation/i.test(String(r.desc || ""))).slice(0, 2).map(mk("Earnings call transcript"));
    // BRSR: products' share of turnover, exports %, plants, markets and customer types in a fixed format
    const brsr = rows.filter(r => pdf(r) && /business responsibility|\bBRSR\b/i.test(txt(r))).slice(0, 1).map(mk("BRSR"));
    const ar = await nse(`https://www.nseindia.com/api/annual-reports?index=equities&symbol=${encodeURIComponent(sym)}`);
    let ars = []; try { const j = JSON.parse(ar.body ? ar.body.toString("utf8") : "{}"); ars = (j.data || []).filter(r => /\.pdf$/i.test(String(r.fileName || ""))).slice(0, 1)
      .map(r => ({ symbol: sym, name: r.companyName || sym, doc: r.fileName, type: `Annual report ${r.fromYr || ""}-${r.toYr || ""}`, date: String(r.broadcast_dttm || "").slice(0, 11) })); } catch (e) {}
    for (const d of [...trs, ...pres, ...brsr, ...ars]) if (d.doc && !done.has(d.doc) && !queue.some(q => q.doc === d.doc)) queue.push(d);
    await sleep(400);
  }
  if (!queue.length) { log(`Documents: nothing new for ${tg.symbols.length} watchlist companies.`); return stats; }
  // newest first; on the same day: transcript, presentation, BRSR, annual report — and one company does not hog a run
  const rank = t => /transcript/i.test(t) ? 0 : /presentation/i.test(t) ? 1 : /brsr/i.test(t) ? 2 : 3;
  const when = d => { const t = Date.parse(String(d.date || "").replace(/-/g, " ")); return isNaN(t) ? 0 : t; };
  queue.sort((a, b) => when(b) - when(a) || rank(a.type) - rank(b.type));
  const kinds = {}; queue.forEach(d => { const k = d.type.replace(/ \d.*$/, ""); kinds[k] = (kinds[k] || 0) + 1; });
  log(`Documents: ${queue.length} new to read for your watchlist (${Object.entries(kinds).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(", ")}).`);
  if (!geminiKey && geminiKey2) geminiKey = geminiKey2;
  let gModels = null, geminiOff = !geminiKey, cfOff = false, cfFails = 0, claudeOff = !claudeKey; const gUsed = new Map(), cSt = {};
  for (const d of queue.slice(0, maxDocs)) {
    if (Date.now() > until - 90000) break;
    const r = await (pdfGet || nse)(d.doc, 180000);           // big PDFs: allow up to 3 minutes
    if (r.code !== 200 || !r.body || r.body.length < 1000) { log(`  ${d.symbol}: could not download ${d.type} (${r.code ? "HTTP " + r.code : r.why || "no answer"})`); continue; }
    if (r.body.length > 40 * 1024 * 1024) { await trex("insights", {}, JSON.stringify({ ...d, status: 2, note: "file too large" })); continue; }
    let pages = []; try { pages = await pdfText(r.body); } catch (e) {               // damaged PDF: tried again on the next runs, given up after 3
      await trex("insights", {}, JSON.stringify({ ...d, status: 0, note: "PDF damaged or incomplete: " + String(e.message || e).split("\n").find(x => /error/i.test(x) && !/^Command/.test(x))?.slice(0, 120) }));
      log(`  ${d.symbol}: ${d.type} — the PDF file is damaged or incomplete; will try again (gives up after 3 tries)`); continue; }
    if (pages.join("").replace(/\s/g, "").length < 120) { await trex("insights", {}, JSON.stringify({ ...d, status: 2, note: "no text in PDF (scanned images)" })); log(`  ${d.symbol}: ${d.type} is scanned images — skipped`); continue; }
    if (!/presentation|annual report/i.test(d.type) && pages.filter(p => p.trim().length > 200).length <= 2 && pages.join("").length < 5000) {   // only a covering letter / link to the website
      await trex("insights", {}, JSON.stringify({ ...d, status: 1, items: [], model: "", note: "covering letter only — the document itself is on the company's website" })); log(`  ${d.symbol}: ${d.type} is only a covering letter — skipped`); continue; }
    let pagesRaw = null; if (pdfText === pdfTextPoppler) { try { pagesRaw = await pdfTextPoppler(r.body, false); } catch (e) {} }   // reading-order text: for checking sentences
    const sel = selectPages(pages, budgetFor(d.type)); if (!sel.length) { await trex("insights", {}, JSON.stringify({ ...d, status: 1, items: [], model: "", note: "no product or capacity pages found" })); continue; }
    const { system, prompt } = buildPrompt(d.name, d.symbol, d.type, d.date, sel);
    log(`  ${d.symbol}: ${d.type} (${d.date}) — ${pages.length} pages, ${sel.length} sent to the AI`);
    let ans = null, why = "";
    if (claudeKey && !claudeOff) {                               // your Claude API key first (when set), then the free AIs
      try { ans = await askClaude(F, claudeKey, system, prompt, log, cSt); }
      catch (e) { why = String(e.message || e); if (e.fatal || e.config) { claudeOff = true; log(`  ${why} — using Gemini / Cloudflare AI from now on.`); } }
    }
    if (!ans && !geminiOff) {
      try { if (!gModels) { gModels = await pickGeminiModel(F, geminiKey);
          const fast = tg.model && gModels.indexOf("models/" + String(tg.model).replace(/^models\//, "")); if (fast > 0) gModels.unshift(gModels.splice(fast, 1)[0]);   // the model that answered last time goes first
          log(`  Gemini models available (${gModels.length}): ${gModels.slice(0, 5).map(m => m.replace(/^models\//, "")).join(", ")}${gModels.length > 5 ? ", …" : ""}`); } ans = await askGemini(F, geminiKey, gModels, system, prompt, log, gUsed); await sleep(7000); }
      catch (e) { why = String(e.message || e);
        if (e.quota && !e.daily && Date.now() < until - 4 * 60e3) {             // a per-minute limit: wait a minute and try once more
          log("  Gemini's per-minute free limit reached — waiting a minute."); await sleep(62000);
          try { ans = await askGemini(F, geminiKey, gModels, system, prompt, log, gUsed); await sleep(7000); } catch (e2) { why = String(e2.message || e2); if (e2.quota) e.daily = true; }
        }
        if (!ans && e.quota && geminiKey2 && geminiKey !== geminiKey2) {      // a second Gemini key (GEMINI_KEY_2): carry on with it
          geminiKey = geminiKey2; gModels = null; gUsed.clear(); log("  First Gemini key has used its limit — continuing with the second key.");
          try { gModels = await pickGeminiModel(F, geminiKey); ans = await askGemini(F, geminiKey, gModels, system, prompt, log, gUsed); await sleep(7000); } catch (e3) { why = String(e3.message || e3); if (e3.quota) e.daily = e3.daily; } }
        if (!ans && e.quota) { geminiOff = true; log(`  Every Gemini model has used its free${e.daily ? " daily" : ""} limit for now — switching to Cloudflare AI.`); } }
    }
    if (!ans && !cfOff) { const t0 = Date.now();
      const small = buildPrompt(d.name, d.symbol, d.type, d.date, selectPages(pages, 14000));   // Cloudflare's models are slower: a shorter extract
      const c = await trex("ai", {}, JSON.stringify(small));
      if (c && c.ok) { cfFails = 0; ans = { model: c.model, text: c.text }; log(`    Cloudflare AI (${String(c.model).replace(/^@cf\//, "")}) answered in ${Math.round((Date.now() - t0) / 1000)}s`); }
      else { cfFails++; const ce = "Cloudflare AI: " + String((c && c.error) || "no answer").slice(0, 160); log("    " + ce); why += (why ? " | " : "") + ce;
        if (geminiOff && cfFails >= 2) { cfOff = true; log("  Both AIs are unavailable right now — the remaining documents wait for the next run."); } } }
    if (!ans && cfOff && geminiOff) { await trex("insights", {}, JSON.stringify({ ...d, status: 0, transient: true, note: (why || "AI unavailable").slice(0, 190) })); break; }
    // the AI being busy is not the document's fault: it is tried again next run and does not count towards giving up on it
    if (!ans) { await trex("insights", {}, JSON.stringify({ ...d, status: 0, transient: true, note: why.slice(0, 190) })); log(`  ${d.symbol}: no AI available right now — will retry next run`); continue; }
    const raw = parseFacts(ans.text);
    if (!raw) { await trex("insights", {}, JSON.stringify({ ...d, status: 0, note: `${ans.model}: answer was not readable` })); continue; }
    const facts = verifyFacts(raw, pages);
    const rawNotes = parseNotes(ans.text), notes = verifyNotes(rawNotes, [pagesRaw, pages]);
    const res = await trex("insights", {}, JSON.stringify({ ...d, status: 1, model: ans.model, reader: READER_VERSION, items: [...facts, ...notes], note: `${raw.length} numbers found by AI, ${facts.length} confirmed on the page; ${notes.length} of ${rawNotes.length} quotes confirmed` }));
    stats.docs++; stats.facts += facts.length + notes.length; stats.model[ans.model] = (stats.model[ans.model] || 0) + 1;
    log(`  ${d.symbol}: ${d.type} (${d.date}) — ${facts.length} of ${raw.length} numbers and ${notes.length} of ${rawNotes.length} quotes confirmed on their pages [${ans.model}]${res && res.ok ? "" : " — not stored: " + (res && res.error)}`);
  }
  return stats;
}
