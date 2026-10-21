# $0 hosting architecture (user decision 2026-10-21: $0 only)

## Measured constraints (grounding, not guesses)

Local CPU measurements on this codebase (sandbox CPU; Workers isolates are
comparable order-of-magnitude):

| Operation | Median | Fits CF Workers free (10ms CPU)? |
| --- | --- | --- |
| Parse+normalize 17KB OpenAPI spec | ~2ms | yes |
| Diff two specs | ~1ms | yes |
| Parse+normalize 121KB spec | ~7ms (p95 ~11ms) | borderline / no |
| Scan a 400-file consumer repo vs a real diff | ~130ms | NO (13x over) |
| Scan + fix generation, same repo | ~210ms | NO (20x over) |
| gunzip 5MB archive payload | ~7ms | barely |

Cloudflare Workers free tier (verified 2026-10-21, developers.cloudflare.com/
workers/platform/limits): 10ms CPU per request AND per cron trigger, 50
subrequests/request, 100k requests/day, 5 cron triggers/account, KV free
100k reads + 1k writes/day. A full watch+scan cycle does not fit that budget;
chunked continuation would stretch one scan over many cron ticks.

GitHub Actions (verified current docs): private repos include 2,000 free
minutes/month. A scheduled hourly ~2-minute run uses ~1,440 minutes. No CPU
millisecond ceiling; the EXISTING engines run unmodified.

## Chosen architecture (no new accounts, no card, $0)

1. Watch + scan run in GitHub Actions on this private repo:
   - `.github/workflows/watch.yml` + `scripts/actions-watch.mjs` reuse the
     exact server engines (pinned fetch, archive extractor, diff, scan, PR
     draft).
   - State (watches, events, snapshots) lives on the `patchline-data` branch,
     committed back by the workflow with the built-in GITHUB_TOKEN. No PAT,
     no new secrets.
   - The schedule is COMMENTED OUT: activation is a deliberate owner step
     (uncomment the cron line). Manual runs work now via workflow_dispatch.
2. Local UI + CLI stay the primary interface (full features, `npm start`).
3. Auth (shared-secret, PATCHLINE_AUTH_KEY) is implemented for any future
   network-exposed deployment; local mode stays keyless.

## Honest tradeoffs of the $0 path

- Watch cadence: scheduled GitHub workflows are best-effort and can be
  delayed under platform load. Hourly is a target, not a guarantee.
- Minutes budget: heavy use beyond hourly checks could exhaust the 2,000
  free minutes; the workflow has a 10-minute timeout and concurrency guard.
- Results surface as commits on the patchline-data branch and the Actions
  log - not a live web UI. A hosted read UI is a separate, still-unverified
  design question; see "Hosted read UI - candidate design (unverified)".
- Spec size: unbounded on Actions (no 10ms limit), unlike a Workers port.

## Explicitly NOT done

- No Cloudflare port: measured CPU limits show the repo scan cannot fit the
  free tier honestly. A paid Workers plan ($) would be needed for hosted
  server-side scanning - outside the $0 decision.
- No Render/Railway/Fly: sleep/ephemeral/paid issues documented earlier.
- No public publish; repo stays private until the owner chooses otherwise.

## Hosted read UI - candidate design (target-level, NOT yet verified)

Status: design-stage. Nothing below is provisioned or measured end-to-end.
Recorded so the investigation continues from verified constraints instead of
signup choices.

Verified inputs to the design:
- All heavy compute (spec fetch, diff, consumer scan) is already isolated in
  the Actions runner and does not need to move. Its output is plain JSON on
  the patchline-data branch.
- Measured CPU (this machine, same engines): 17KB spec diff ~3ms; 121KB spec
  ~7-11ms; 400-file consumer scan ~130ms. Serving static UI + JSON reads is
  ~1-3ms of work per request by construction (no scan on the read path).
- The account's Actions budget is hard-blocked at $0 (verified on the billing
  budgets page 2026-10-22): exceeding free minutes stops runs, never bills.
- The auth gate (shared secret, timing-safe compare, sessionStorage unlock
  overlay) is implemented and test-covered; it ports 1:1 to any thin host.

Candidate shape ("read-through worker", no scan on the host):
1. Actions workflow (already built) remains the only writer of watch state.
2. A thin read host serves the existing UI assets plus a tiny JSON endpoint
   that returns the latest precomputed state (events, diffs, impact) that the
   Actions run produced. No spec fetching, no diffing, no scanning on the
   host - so host CPU stays in the 1-3ms band measured above.
3. Auth: same shared-secret gate in front of every route.
4. State transfer options (to be measured, not chosen yet):
   a. Host reads the patchline-data branch through the pinned fetch path
      (needs a read credential - adds a secret; least preferred).
   b. Actions pushes the rendered state JSON to the host's store at the end
      of each run (push model; no read credential on the host).
   c. Static export mode: the server gains an export command that renders
      state to static files; the host serves those files verbatim.

Emulation result (2026-10-22, local workerd/miniflare, no account created):
- A candidate read-through worker serving the real 60KB UI HTML plus a
  realistic 350KB precomputed state JSON (150 events with diffs) behind the
  same timing-safe key gate measured: p50 ~0ms, p95 1ms, p99 1ms, max 2ms
  handler time over 200 requests (workerd, warm; Buffer-free constant-time
  compare). Comfortably inside a 10ms free CPU budget.
- Honesty limits of this measurement: handler wall time via performance.now
  in local workerd, NOT a host's billed CPU metric; cold starts excluded;
  no account exists anywhere yet.

What remains unverified (do not present as decided):
- Real deployment on any host - needs an owner decision before any account
  is created; emulation only shows the shape is CPU-plausible.
- State-transfer option (a/b/c) - needs measurement of payload sizes and
  freshness requirements.
- Custom domain/TLS and whether the user's profile link should point at a
  hosted demo at all (user decision, gated on product completion).

## Verified component split (2026-10-22) - read viewer vs interactive product

Do not read "hosted" as one thing. The pieces verify differently at $0:

A. LOCAL INTERACTIVE PRODUCT - verified usable today.
   Full server + UI + CLI: add/configure watches, run ad-hoc diff and
   consumer scan, auth gate, all engines. 122 tests green; UI pixel-verified.
   Cost: $0. Activation: `npm start` on any machine the owner controls.

B. HOSTED WATCH (write path) - code-verified, activation owner-gated.
   The Actions runner executes the same engines headless and commits state
   to the patchline-data branch. Verified locally end-to-end against a live
   fixture (baseline -> change -> 5-breaking/1-additive/1-review event,
   2026-10-22). Runner hardened during validation: hand-seeded watches
   without intervalMinutes no longer crash (60-min default, same as server).
   Never run hosted: schedule commented out, no manual dispatch ever made.
   Activation requires: owner uncomments the cron line (via GitHub web UI -
   the deploy PAT was narrowed back to code-only and cannot push workflow
   changes) AND accepts that runs write bot commits to patchline-data and
   consume shared free minutes (budget hard-blocked at $0 - verified).

C. HOSTED READ-ONLY VIEWER - emulation-plausible, nothing provisioned.
   A thin host serving the UI + precomputed state JSON behind the existing
   key gate. Local workerd emulation 2026-10-22: 60KB UI + 350KB realistic
   state, p50 ~0ms / p95 1ms / p99 1ms / max 2ms handler time (200 requests,
   warm; handler wall time, not billed CPU). CPU-plausible for a 10ms free
   budget; no host account exists or was created.

D. HOSTED INTERACTIVE PRODUCT - NOT viable under verified $0 constraints.
   Ad-hoc consumer scan measured ~130ms for 400 files: 13x over the 10ms
   free CPU budget. A hosted write path (configure watches, trigger scans
   from the hosted UI) would additionally need a host->GitHub credential -
   a new secret the current design deliberately avoids. So at $0, hosted =
   scheduled watcher (B) + read-only viewer (C); interactive configuration
   and ad-hoc analysis stay in the local product (A). This is THE material
   narrowing of the original "hosted usable product" scope and needs the
   owner's explicit acceptance - it is stated here, not hidden.

## State transfer (for component C) - measured payload sizes

Real runner output, live fixture, 2026-10-22:
- Change event, no repo impact (6 changes incl. review flag): 2,454 B raw.
- Change event WITH consumer impact (35-file repo scan + PR draft): 4,104 B.
- events.json gzip: 628 B (1 event), 1,136 B (2 events incl. impact).
- events.json is capped at 200 events by the runner: projected ceiling
  ~0.5 MB raw / well under 150 KB gz for ordinary histories; pathological
  ceiling if all 200 events carry a 50 KB PR body (the cap): ~10 MB raw.
- Transfer cadence at hourly checks: 24 writes/day/watch - far under free
  KV-style write quotas (1,000/day) IF a KV-like store is chosen.
- Conclusion: option (b) push-model payload is small and bounded; no payload
  obstacle. Option choice (a/b/c) still requires a real host decision first.

## Exact activation decision (the whole owner-facing package)

1. Accept the component split: interactive product stays local (A); hosted
   at $0 is scheduled watch (B) + optional read-only viewer (C). If the
   owner wants hosted interactivity, that is a paid-host conversation, not
   a $0 configuration.
2. To activate B: uncomment one cron line in .github/workflows/watch.yml
   from the GitHub web UI (PAT deliberately cannot), which also authorizes
   patchline-data bot commits and shared-minutes consumption ($0-blocked).
3. To activate C: choose whether to create one free host account; only then
   pick state-transfer option and domain. No account exists today.
4. Profile addition stays gated on the user's own completion bar for both
   products (Patchline + Shellcode) - unchanged.
