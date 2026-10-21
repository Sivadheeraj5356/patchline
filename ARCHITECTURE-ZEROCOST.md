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

D. HOSTED INTERACTIVE PRODUCT - offload route RESEARCHED (2026-10-22).
   What measurement rules out is narrow: running the consumer scan
   in-request on a 10ms-CPU free worker (400-file scan ~130ms). The
   researched alternative keeps every heavy operation in GitHub Actions and
   uses the free worker only as a thin proxy + static host:

   Architecture: "dispatch-offload".
   1. Cloudflare Workers free serves the UI (static asset requests are FREE
      AND UNLIMITED on the free plan - verified on the current pricing page;
      only dynamic API invocations count against 100k/day at 10ms CPU).
   2. Interactive ops (ad-hoc diff, consumer scan, watch check, add watch)
      become JOBS: the worker calls
      POST /repos/{owner}/{repo}/actions/workflows/{id}/dispatches
      (verified current GitHub docs: requires a fine-grained PAT with the
      "Actions: write" repository permission; PAT tokens supported) with a
      job payload, returns a job id, and the UI polls for the result.
   3. A job workflow (workflow_dispatch with inputs) runs the SAME engines
      on the Actions runner and commits the result JSON to
      patchline-data/jobs/<id>.json. The worker reads it back via the
      contents API (Contents: read on the same repo-scoped PAT).
   4. Small reads keep the measured 1-3ms path (snapshot viewer). All
      worker-side work per interactive call is 1-3 GitHub API subrequests,
      far under the 50-subrequest and 10ms free limits.
   5. Auth: the same shared-secret gate in front of every dynamic route.

   Security scope of the ONE new credential (repo-scoped fine-grained PAT
   with Actions:write + Contents:read on patchline only): if leaked, an
   attacker can dispatch workflows and read this one repo/branch. Compute
   abuse is capped by the account's Actions budget hard-blocked at $0
   (verified on the billing budgets page 2026-10-22) - abuse stops, it
   cannot bill. No account-level permissions; one-click revocation; expiry.
   This is deliberately the minimum scope the dispatch API accepts.

   Verified inputs (current docs/measurements, sources in repo history):
   - Dispatch endpoint + exact permission (Actions:write, PAT supported).
   - CF free: static free+unlimited, 100k dynamic req/day, 10ms CPU, KV
     available. Worker proxy CPU measured 1-3ms class.
   - Result hand-off payload: KBs per job (measured 2.5-4.1KB events).
   - Actions $0 hard-block verified; free minutes shared across repos.

   Honestly unverified (need owner activation steps to measure):
   - Dispatch-to-result latency (pickup is seconds-to-minutes, no SLA;
     unmeasured until a real run is allowed).
   - Whether Cloudflare free signup asks for a card (pricing pages show
     $0/mo free plan; signup flow itself untested - no account created).
   - No live proof of any host's billed-CPU accounting for this workload;
     all CPU numbers are local measurements/emulation, labeled as such.

   Job path implementation status (2026-10-22): BUILT and locally
   integration-tested, never run hosted.
   - scripts/actions-job.mjs: one "analyze" job = spec diff + optional
     consumer impact + PR draft (the product's steps 02-04), result to
     <data>/jobs/<job_id>.json. 15 local integration tests cover: happy
     path with a live fixture, traversal job_id rejected, wrong type
     rejected, non-github repoUrl rejected, oversized URL rejected, missing
     input rejected, dedupe replay is a no-op, SSRF layering (private
     target without the test override lands as an error-status result, no
     fetch), and result files contain no token material.
   - workers/patchline-worker.mjs (+ scripts/build-worker.mjs bundling the
     real UI): the proxy host itself. 22 miniflare integration tests against
     a mock GitHub API cover the binding the route depends on: gate 401s
     (missing/wrong key), UI served openly, branch read-back for watches/
     events/results, job validation (https-only URLs, github.com-only
     repoUrl, size caps), dispatch shape (exact endpoint, ref main, PAT in
     the upstream authorization header only, validated inner payload), KV
     dedupe (identical payload -> same job id, no second dispatch), hourly
     rate limit (429 past the cap), unknown job id -> 404, and secret
     hygiene (neither the PAT nor the gate key appears in any response
     body). Mock-based: proves the proxy logic, not the live GitHub path.
   - ci/job.workflow.yml: the job workflow CONTENT, staged outside
     .github/workflows/ so the code-only deploy PAT can carry it. It is
     inert until the owner copies it to .github/workflows/job.yml via the
     GitHub web UI (one paste). workflow_dispatch only; the payload is
     never interpolated into a shell command (env-var to file, validated
     inside the runner); concurrency group serializes branch writes;
     push step retries with rebase; first run bootstraps patchline-data.
   - 144 tests green overall.

   Security model of the job queue (design commitments, not yet
   attack-tested on a live deployment):
   - Request size: dispatch payload capped at 10KB in the workflow; URLs
     capped at 2048 chars in the runner; results capped at 200KB with a
     truncation flag.
   - Rate: one job per dispatch; dedupe by job_id makes replays no-ops;
     per-caller rate limiting belongs to the hosted worker at activation
     (e.g. N jobs/hour behind the key gate) - NOT implemented locally.
   - Durable job IDs + authorization: job ids are random uuids; result
     files are addressable only by uuid and served only behind the shared
     -secret gate. An attacker without the key cannot create or read jobs;
     an attacker WITH a leaked key can spend Actions minutes, capped by the
     verified $0 hard-block.
   - Snapshot exposure: the static snapshot contains watch URLs, repo URLs
     and change details - it is as sensitive as the user's API inventory
     and must stay behind the gate; raw spec text is never baked in.
   - No arbitrary shell/workflow inputs: the workflow runs one fixed
     command; the payload is data validated by the runner (enum type,
     uuid id, https URLs, github.com-only repoUrl).
   - Token-free artifacts: results contain only engine output; tests
     assert no GITHUB_TOKEN/PAT-shaped strings land in result files.
   - SSRF/archive constraints: all fetches go through the pinned-DNS
     per-hop guard (private ranges refused); repo access is github.com
     only through the bounded archive extractor (size/file-count/traversal
     caps).
   - Concurrent branch writes: workflow concurrency group + rebase-retry
     push; worst case is a failed run after 3 retries, never a clobber.

   Sources (exact URLs, fetched 2026-10-21/22):
   - Dispatch endpoint + fine-grained PAT permission (Actions: write):
     https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
     (POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches)
   - workflow_dispatch semantics:
     https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch
   - Cloudflare Workers free pricing (static assets free+unlimited,
     100k req/day, 10ms CPU):
     https://developers.cloudflare.com/workers/platform/pricing/
   - Cloudflare Workers limits (subrequests, KV, cron):
     https://developers.cloudflare.com/workers/platform/limits/
   - Account Actions budget hard-blocked at $0: live billing budgets page
     screenshot (repo artifact evidence, 2026-10-22).

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

## The one candidate architecture (no variant shopping)

Candidate: "scheduled watch + static snapshot viewer" - BUILT and preview-
verified locally (2026-10-22), nothing hosted.
- scripts/export-static.mjs bakes watches/events into one self-contained
  index.html running the real UI in read-only static mode (static-mode shim:
  GET /api/watches + /api/events resolve from the baked snapshot; all other
  /api calls refuse with a clear 501 message; add-watch form hidden; watch
  rows marked read-only; baked payload escapes </script> - test-covered).
- The Actions runner renders the snapshot at the end of every run into
  <data>/dist (best-effort, never fails the watch) - so the workflow commits
  state + viewer artifact together when (and only when) the owner activates.
- Verified end-to-end locally: live fixture -> baseline -> spec change ->
  event -> export, all in one runner pass, 0 errors. Viewer pixels verified
  (banner, baked watch row + events, no action buttons, no auth overlay).
  129 tests green (7 export tests incl. the XSS escape guard).
- The viewer host (C) would serve exactly this static output behind the
  existing key gate. Delivery to a host is a deploy-step question answered
  at activation time with the owner's chosen host (scoped deploy credential
  the owner creates then). No account exists; none was created.
- Local preview of the exact viewer experience needs no account:
  `node scripts/export-static.mjs --data <data> --out dist` + any static
  file server.

Remaining unknowns (not decided, not hidden):
- Which free host, if any, the owner wants an account on (owner decision;
  none created).
- Hosted interactivity via job offload (section D) - unresearched.
- Custom domain/TLS; whether a hosted demo belongs in the profile at all.

## Exact activation decision (the whole owner-facing package)

1. To activate B (hosted watch): uncomment one cron line in
   .github/workflows/watch.yml from the GitHub web UI (the deploy PAT
   deliberately cannot), which also authorizes patchline-data bot commits
   and shared-minutes consumption (budget hard-blocked at zero, verified).
2. To activate C (hosted viewer): choose whether to create one free host
   account for the static snapshot; the deploy credential and host choice
   are made then. No account exists today.
3. If hosted interactivity is wanted: say so, and the job-offload research
   (D) gets done before anything is built - it is not ruled in or out.
4. Profile addition stays gated on the user's own completion bar for both
   products (Patchline + Shellcode) - unchanged.
