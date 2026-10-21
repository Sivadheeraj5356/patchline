PATCHLINE - working prototype for the YC Fall 2026 RFS idea "Self-Maintaining APIs"

Open index.html in Chrome, Edge, Firefox or Safari. No installation, server or network required.
Flow: 01 Specs (sample pair preloaded, or paste your own pair in the same simplified JSON shape) -> 02 API diff -> 03 Consumer impact -> 04 Fix PR.
Exports: PR markdown (copy or .md download) and full analysis (.json download).

What it is: deterministic spec diff + consumer call-site impact scan + drafted migration PR.
What it is NOT: no AI inference, no network calls, no account connections. All sample data is fictional
(Northwind Billing API). Removed endpoints are flagged for manual review, never auto-rewritten.

source/engines.mjs        standalone deterministic logic
source/test-engines.mjs   32 tests - run: node source/test-engines.mjs
fixtures/                 the sample spec pair + 4-file sample consumer app
screenshots/              pixel-verified captures of each app screen (21 Oct 2026)
report/                   the RFS comparison + recommendation PDF (and its HTML source)

A YC RFS signals partner interest, not validated demand. Built 21 October 2026.
