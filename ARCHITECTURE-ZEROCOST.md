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
