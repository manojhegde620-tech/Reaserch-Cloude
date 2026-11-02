// T-Rex "promises vs delivery": for each management commitment whose date has passed, ask the AI whether it was delivered —
// using ONLY evidence we hand it: what the company itself said/reported in LATER documents (checked numbers and quotes from the
// deep reading) and its quarterly results from the NSE filings. The verdict names the evidence it relied on, and that evidence
// is shown in the app next to the promise, so every verdict can be checked by eye.
const KIND_METRICS = {
  revenue_growth: ["revenue", "revenue_share", "sales_volume", "guidance"], volume_growth: ["sales_volume", "production", "revenue", "guidance"],
  profit: ["ebitda", "margin", "revenue", "guidance"], margin: ["margin", "ebitda", "guidance"],
  capacity: ["capacity", "capacity_addition", "utilisation", "production", "plants", "capex"], commissioning: ["capacity", "capacity_addition", "plants", "capex", "production"],
  capex: ["capex", "capacity_addition", "capacity"], launch: ["revenue", "revenue_share", "guidance"], order_inflow: ["order_book", "guidance", "revenue"],
  debt: ["other", "guidance"], market_share: ["market_share", "guidance"], other: ["guidance", "revenue", "capacity", "order_book"],
};
const KIND_NOTES = { capacity: ["plants", "guidance"], commissioning: ["plants", "guidance"], capex: ["plants", "guidance"], launch: ["what_they_do", "guidance"], market_share: ["market_position", "guidance"] };
const when = d => { const t = Date.parse(String(d || "").replace(/-/g, " ")); return isNaN(t) ? 0 : t; };
export function dueOf(by) {                      // end of the period a commitment names (ms) — same rules as the app
  const s = String(by || "").toUpperCase().replace(/[’']/g, ""); let m; const E = (y, mo) => Date.UTC(y, mo, 0) + 864e5 - 1;
  if ((m = s.match(/Q([1-4]) ?FY ?(\d{2,4})/))) { const q = +m[1], y = +m[2] < 100 ? 2000 + +m[2] : +m[2]; return E(q < 4 ? y - 1 : y, [6, 9, 12, 3][q - 1]); }
  if ((m = s.match(/H([12]) ?FY ?(\d{2,4})/))) { const y = +m[2] < 100 ? 2000 + +m[2] : +m[2]; return +m[1] === 1 ? E(y - 1, 9) : E(y, 3); }
  if ((m = s.match(/FY ?(\d{2,4})(?: ?[-–\/] ?(\d{2,4}))?/))) { const v = m[2] || m[1]; const y = +v < 100 ? 2000 + +v : +v; return E(y, 3); }
  const mo = s.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*\b/), yr = s.match(/(20\d{2})/);
  if (mo && yr) return E(+yr[1], { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }[mo[1]]);
  if (yr) return E(+yr[1], 12);
  return null;
}
export const promiseId = c => [c.doc, c.page, String(c.quote || "").slice(0, 60)].join("|");
// evidence the AI may use: later facts/quotes from the company + quarterly results from the filings
export function evidenceFor(c, co, quarters) {
  const said = when(c.date), docs = Object.fromEntries((co.docs || []).map(d => [d.doc, d]));
  const later = d => when((docs[d] || {}).date) > said;
  const mets = KIND_METRICS[c.kind] || KIND_METRICS.other, notes = KIND_NOTES[c.kind] || ["guidance"];
  const ev = [];
  for (const f of co.facts || []) {
    if (!later(f.doc)) continue;
    const isNote = /^note:/.test(f.metric);
    if (isNote ? !notes.includes(f.metric.slice(5)) : !mets.includes(f.metric)) continue;
    const d = docs[f.doc] || {};
    ev.push({ doc: f.doc, page: f.page, date: d.date || "", quote: f.quote || "", text: isNote ? `“${f.quote}”` : `${f.item} — ${f.metric}${f.period ? " " + f.period : ""}: ${f.vtext ?? f.value} ${f.unit || ""}`, src: `${d.type || "document"} ${d.date || ""} p.${f.page}` });
  }
  for (const x of co.commitments || []) if (x.kind === c.kind && later(x.doc) && promiseId(x) !== promiseId(c))
    ev.push({ doc: x.doc, page: x.page, date: x.date, quote: x.quote, text: `(later commitment) “${x.quote}”`, src: `${(docs[x.doc] || {}).type || "document"} ${x.date || ""} p.${x.page}` });
  ev.sort((a, b) => when(b.date) - when(a.date));
  const out = ev.slice(0, 36).map((e, i) => ({ ...e, id: "E" + (i + 1) }));
  // quarterly results from the filings (₹ Cr)
  const qs = (quarters || []).filter(q => q.qe && when(q.qe) > said - 120 * 864e5).sort((a, b) => b.qe.localeCompare(a.qe)).slice(0, 8);
  qs.forEach((q, i) => out.push({ id: "F" + (i + 1), filing: true, qe: q.qe, text: `Quarter ended ${q.qe} (${q.basis === "S" ? "standalone" : "consolidated"}): sales ₹${q.sales ?? "?"} Cr, operating margin ${q.opm ?? "?"}%, net profit ₹${q.np ?? "?"} Cr${q.yoySales != null ? `, sales growth vs same quarter last year ${q.yoySales}%` : ""}${q.yoyNp != null ? `, profit growth ${q.yoyNp}%` : ""}`, src: `NSE results filing, quarter ended ${q.qe}`, doc: q.pdf || q.xbrl || "" }));
  return out;
}
export function judgePrompt(name, c, ev) {
  const system = "You check whether an Indian listed company delivered on a commitment its management made. Use ONLY the evidence listed. Reply with JSON only.";
  const prompt = `Company: ${name}.
Commitment made on ${c.date || "?"} (${c.kind}): "${c.quote}"
Target: ${c.target || "—"}; deadline: ${c.by || "none given"}.

Evidence from LATER company documents and NSE results filings (₹ crore):
${ev.map(e => `${e.id}: ${e.text} [${e.src}]`).join("\n")}

Decide, strictly from the evidence above:
- "delivered": the evidence shows the target was met (or clearly exceeded) by the deadline;
- "partly": clearly part of it was achieved, or achieved late;
- "missed": the evidence shows it was not achieved by the deadline (including the same promise pushed to a later date);
- "unclear": the evidence does not say enough. Prefer "unclear" over guessing. Never use outside knowledge.
Reply as {"verdict":"delivered|partly|missed|unclear","why":"one short sentence citing the numbers","evidence":["E1","F2"]}`;
  return { system, prompt };
}
export function parseVerdict(text, ev) {
  let j = null; try { const s = String(text || ""); j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch (e) { return null; }
  const s = String(j.verdict || "").toLowerCase(); if (!["delivered", "partly", "missed", "unclear"].includes(s)) return null;
  const ids = new Set((Array.isArray(j.evidence) ? j.evidence : []).map(String)); const used = ev.filter(e => ids.has(e.id));
  if (s !== "unclear" && !used.length) return { s: "unclear", why: "No evidence was named for a verdict.", ev: [] };   // a verdict without evidence is not accepted
  return { s, why: String(j.why || "").slice(0, 300), ev: used.slice(0, 4).map(e => ({ doc: e.doc, page: e.page || null, quote: e.filing ? e.text : e.quote, date: e.date || e.qe || "", filing: !!e.filing })) };
}
// evaluate the due commitments of one company (in place); returns how many were judged
export async function evaluatePromises(sym, co, { ask, quarters, now = Date.now(), log = () => {} }) {
  let n = 0;
  for (const c of co.commitments || []) {
    const due = dueOf(c.by); const said = when(c.date);
    const ripe = due ? due < now - 20 * 864e5 : said && said < now - 400 * 864e5;           // its date has passed (results take ~3 weeks to file)
    if (!ripe) continue;
    if (c.verdict && c.verdict.s !== "unclear") continue;
    if (c.verdict && c.verdict.s === "unclear" && now - (c.verdict.t || 0) < 90 * 864e5) continue;     // look again after 3 months
    const ev = evidenceFor(c, co, quarters);
    if (!ev.length) { c.verdict = { s: "unclear", why: "No later document or result covers this yet.", ev: [], t: now }; continue; }
    const { system, prompt } = judgePrompt(co.name || sym, c, ev);
    let ans; try { ans = await ask(system, prompt); } catch (e) { if (e.fatal || e.config) throw e; continue; }
    const v = parseVerdict(ans && ans.text, ev); if (!v) continue;
    c.verdict = { ...v, t: now, model: ans.model }; n++;
  }
  return n;
}
