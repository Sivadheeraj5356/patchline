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
- Consumer repos on SERVER paths are read via pinned archive fetch + bounded
  in-memory extraction (src/archive.mjs): github.com URLs map to codeload
  tarballs, other hosts must serve a tar.gz directly. DNS is resolved once
  and pinned per redirect hop (no second resolution window - the git-clone
  TOCTOU is gone from the server). The extractor never writes to disk,
  never follows links, never executes code; caps: 20MB compressed, 64MB
  decompressed total, 512KB/file, 2000 files; traversal/absolute paths
  rejected, symlinks/devices skipped. Watch-to-repo impact linking is
  covered end-to-end by a server test.
- git clone remains in the operator-run CLI only (local, user-supplied URLs;
  bounded by redirect/submodule/protocol/env flags).
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
