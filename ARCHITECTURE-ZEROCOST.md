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
  log - not a live web UI. A hosted read UI would need either a public repo
  (GitHub Pages, not approved) or a free Cloudflare signup (owner decision).
- Spec size: unbounded on Actions (no 10ms limit), unlike a Workers port.

## Explicitly NOT done

- No Cloudflare port: measured CPU limits show the repo scan cannot fit the
  free tier honestly. A paid Workers plan ($) would be needed for hosted
  server-side scanning - outside the $0 decision.
- No Render/Railway/Fly: sleep/ephemeral/paid issues documented earlier.
- No public publish; repo stays private until the owner chooses otherwise.
