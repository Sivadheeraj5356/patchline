# Reproduction & verification guide

## Test suites (101 checks)

```
npm install   # one dependency: undici@6 (DNS-pinned HTTP agent)
npm test
```

- `test/test-engines.mjs` (45): diff/scan/fix/PR rules, rename-inference guards
  (ambiguity, cross-side request/response collisions), suggestion dedupe,
  cross-endpoint scoping.
- `test/test-openapi.mjs` (20): real OpenAPI 3.x parsing - YAML, local $ref,
  requestBody, allOf, path params, deprecation, security schemes.
- `test/test-net.mjs` (26): SSRF guard (private IP classes, scheme allowlist,
  DNS-resolved private hostnames), DNS pinning, redirect hop-by-hop behavior
  and hop cap, clone guard rejecting private/non-http targets.
- `test/test-server.mjs` (10): end-to-end HTTP - parse, analyze, watch
  lifecycle with a live local fixture change, persistence across restart,
  SSRF refusal without test mode, watch-to-repo impact linking.

## What is proven vs. not

Proven by tests:
- Parsing and diffing of the bundled fixtures plus a live fetch+parse of the
  public petstore3 OpenAPI document (validated manually during development).
- Watch flow against a LOCAL fixture server (PATCHLINE_ALLOW_PRIVATE=1):
  baseline, content change, event with diff, consumer impact when repoUrl set.
- SSRF: private/loopback/link-local refused on every fetch path
  (fetch-spec proxy, analyze URLs, watch polling, repo clone pre-check);
  redirect hops re-validated; DNS pinned between check and connect.

Not proven / known limits:
- No real external vendor change has been watched end-to-end; the live-watch
  evidence is a controlled localhost fixture.
- Rename/enum-replacement detection is heuristic. Inferred renames are
  suggested, never auto-applied (opt-in `--apply-inferred`), and ambiguous
  cases (multiple candidates, or a name shared across request/response
  without a consistent cross-side mapping) stay removed+added.
- Files that call no known endpoint are still scanned (uncertainty beats a
  false clean); files calling a different known endpoint are excluded.
- Repo clone's DNS pre-check has a short TOCTOU window: git resolves DNS
  itself. Because of this, server-side remote cloning is DISABLED by default
  (PATCHLINE_ALLOW_REMOTE_CLONE=1 opts in, intended for local/operator
  deployments only) until a pinned archive-fetch + bounded extractor replaces
  git clone on server paths. When cloning is enabled: redirects (initial
  only), submodules, file/ext protocols and credential prompts are disabled
  via git flags and a scrubbed env.
- Consumer scanning is TEXT-BASED leaf matching, not AST analysis. A query
  parameter and a body field sharing a name cannot be told apart in source
  text, so such renames are never inferred: they are reported as
  removed + added-for-review entries instead.
- The CLI (`src/cli.mjs`) fetches spec URLs with plain fetch: it is a local
  developer tool run on the operator's own input; the SSRF guard covers the
  server's network-exposed paths.

## Running locally

```
node src/server.mjs --port 8484     # UI at http://localhost:8484
PATCHLINE_ALLOW_PRIVATE=1 node src/server.mjs   # allow localhost fixtures (testing only)
node src/cli.mjs --old v1.json --new v2.json --repo ./consumer --write --branch
```
