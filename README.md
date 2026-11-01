# T-Rex collector

A small scheduled job (GitHub Actions, every 2 hours) that downloads public NSE filings and company documents
and hands them to a private T-Rex app. It contains no data and no keys: the app's address is public, and the
two secrets it needs (`TREX_KEY`, `GEMINI_KEY`) are stored in this repository's Actions secrets, which are never
shown in code, logs or forks.

- `collector/collect.mjs` — NSE results filings, closing prices; runs the document reader.
- `collector/insights.mjs` — reads earnings-call transcripts, investor presentations, BRSR and annual reports;
  keeps only numbers and quotes found word-for-word on the cited page.
