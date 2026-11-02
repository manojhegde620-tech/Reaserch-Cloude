// T-Rex "tidy-up" of a company's AI-read business numbers (Claude Haiku, a fraction of a cent per company).
// Each document names the same thing differently ("Total Revenue", "Revenue from operations", "Q4 FY26 Revenue",
// the company's own name …). This pass gives every distinct name ONE standard key + a clean label + an investor
// group, so the app can line the numbers up by quarter like Screener. It never changes a number, unit or page:
// the values stay exactly as checked on the company's pages; units are converted and checked against the NSE
// filings in the app. The result is stored in the company's deep file (co.canon) — no Cloudflare database use.
import { salvageJson } from "./insights.mjs";
export const TIDY_VERSION = 1;
export const TIDY_GROUPS = {
  fin: "Key financials (total revenue, EBITDA, profit, margins, EPS, company-level growth)",
  mix: "Business mix (revenue or share by segment / product / service line)",
  growth: "Growth engines (new businesses, launches, fast-growing lines the company highlights)",
  ops: "Capacity, network and volumes (plants, centres, stores, capacity, utilisation, production, volumes, employees)",
  mkt: "Customers and markets (customers, exports, regions, countries, market share)",
  cost: "Costs and raw materials",
  cash: "Cash, debt and capex (capex, borrowings, receivable days, working capital, dividends, cash)",
  plans: "Orders, guidance and plans (order book, targets, pipeline, guidance)",
  ind: "Industry and economy (market size, government budgets, sector data — not the company itself)",
  other: "Anything else"
};
export const factKey = f => String(f.metric || "") + "|" + String(f.item || "").replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim().toLowerCase();

export function tidyPrompt(name, sym, items, known) {
  const system = "You organise numbers already extracted from an Indian listed company's documents for a stock investor. Reply with JSON only.";
  const prompt = `Company: ${name || sym} (NSE: ${sym}).
Each line below is one NAME used for a number in the company's documents: #id | type | name | unit | example periods = values.
Give every line a standard key so the SAME measure gets the SAME key across documents, quarters and years.

Rules:
- Same key only when it is truly the same measure for the same scope: e.g. "Total Revenue", "Revenue from operations", "Revenue", "Sales", "Q4 FY26 Revenue", "Revenue (stated in crores)" and a line named just after the company → "revenue". Units and periods may differ — that is fine (the app converts units and lines up periods).
- Keep different things apart: standalone vs consolidated (add "_standalone"), each segment / product / region separately ("seg_pathology_share", "seg_radiology_revenue", "region_south_share"), growth-rate lines separately ("revenue_growth_yoy", "revenue_growth_qoq", "pat_growth_yoy"), targets separately from actuals only if the name says target/planned ("capex_planned").
- Standard keys when they fit: revenue, ebitda, ebitda_margin, pat, pat_margin, eps, revenue_growth_yoy, ebitda_growth_yoy, pat_growth_yoy, export_share, order_book, order_inflow, capex, capex_planned, net_debt, gross_debt, receivable_days, dividend_per_share, capacity_utilisation, employees, market_share.
- Reuse these keys already used for this company where they fit: ${known.length ? known.slice(0, 120).join(", ") : "(none yet)"}.
- "l": a short clear label an investor understands (max 40 characters, no period or unit in it), e.g. "Revenue", "Pathology share of revenue", "Retail touch points".
- "g": one group code — ${Object.entries(TIDY_GROUPS).map(([k, v]) => `${k} = ${v}`).join("; ")}.
- "h": 1 only if the line tells an investor nothing about this company (e.g. a zero placeholder like "Manufacturing plants 0" for a service company, "International countries 0", a pure restatement that duplicates another line). Otherwise 0.

Reply as {"map":[{"i":1,"k":"revenue","l":"Revenue","g":"fin","h":0}, …]} with one entry for EVERY line.

${items.map(x => `#${x.i} | ${x.metric} | ${x.item} | ${x.unit || "-"} | ${x.ex}`).join("\n")}`;
  return { system, prompt };
}

export function parseTidy(text, n) {
  let j = null; const s = String(text || ""); const a = s.indexOf("{"), b = s.lastIndexOf("}");
  try { j = JSON.parse(s.slice(a, b + 1)); } catch (e) { j = null; }
  if (!j) { try { j = salvageJson(s); } catch (e) {} }
  const arr = j && Array.isArray(j.map) ? j.map : [];
  const out = {};
  for (const x of arr) {
    const i = +x.i; if (!(i >= 1 && i <= n)) continue;
    const k = String(x.k || "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48); if (!k) continue;
    const g = TIDY_GROUPS[x.g] ? x.g : "other";
    out[i] = [k, String(x.l || "").replace(/\s+/g, " ").trim().slice(0, 48) || k, g, x.h ? 1 : 0];
  }
  return out;
}

// facts → the names not tidied yet → ask (in batches) → co.canon.map[factKey] = [key, label, group, hide]
export async function tidyCompany(sym, co, extraFacts, ask, opt = {}) {
  const nums = [...(co.facts || []), ...(extraFacts || [])].filter(f => f && f.metric && !/^note:/.test(f.metric) && f.item);
  const canon = co.canon && co.canon.v === TIDY_VERSION ? co.canon : { v: TIDY_VERSION, map: {} };
  const by = new Map();
  for (const f of nums) { const k = factKey(f); if (canon.map[k]) continue; if (!by.has(k)) by.set(k, { metric: f.metric, item: String(f.item).replace(/\s+/g, " ").trim().slice(0, 90), unit: String(f.unit || "").slice(0, 24), ex: [] }); const e = by.get(k); if (e.ex.length < 3) e.ex.push(`${String(f.period || "undated").slice(0, 24)} = ${f.value}`); }
  const todo = [...by.entries()];
  if (!todo.length) { co.canon = canon; return 0; }
  const size = opt.batch || 140; let done = 0;
  for (let s = 0; s < todo.length; s += size) {
    const part = todo.slice(s, s + size).map(([k, e], i) => ({ i: i + 1, key: k, ...e, ex: e.ex.join("; ") }));
    const known = [...new Set(Object.values(canon.map).map(v => v[0]))];
    const { system, prompt } = tidyPrompt(co.name, sym, part, known);
    const ans = await ask(system, prompt);
    const m = parseTidy(ans && ans.text, part.length);
    for (const x of part) if (m[x.i]) { canon.map[x.key] = m[x.i]; done++; }
  }
  canon.t = Date.now(); canon.n = Object.keys(canon.map).length; co.canon = canon;
  return done;
}
