# Patchline - self-maintaining API clients

An API provider ships a breaking change. Patchline notices, finds where your code
uses the affected surface, drafts the fix, and prepares a reviewable pull request.
Deterministic rules - no AI inference by default, no paid services.

Built for the YC Fall 2026 RFS idea "Self-Maintaining APIs"
(a neutral third-party service tracking changes across vendors - "Dependabot for APIs").

## What works today

- **Real OpenAPI 3.x**: YAML or JSON, local `$ref` resolution (cycles cut safely),
  `requestBody`, content-wrapped response schemas, `allOf` merging, path-level
  parameters, deprecations and security schemes. Validated against live public specs.
- **Change classification**: breaking / additive / warning, with an explicit
  `review` flag separating auto-proposable mechanical fixes (renames, path moves,
  enum mappings) from judgment calls (removed endpoints, type changes, removed
  response codes, auth changes, new required fields) that are flagged, never guessed.
- **Consumer impact scan**: finds affected call sites in JS/TS/Python/Ruby/Go/Java/
  PHP/Kotlin/C# codebases by leaf-name and endpoint matching.
- **Migration PR draft**: markdown PR with proposed edits (diff format) and
  manual-review flags. Copy/download from the UI, or `--md` from the CLI.
- **Live watching**: the server polls spec URLs on your cadence (min 60 min,
  conditional GETs so quiet specs cost one 304), keeps snapshots, and records a
  full diff event when the served spec actually changes.

## Run it

```bash
npm install          # one dependency: yaml
npm start            # hosted app on http://localhost:8484 (UI + API + watcher)
npm test             # 60 tests: engine, OpenAPI parsing, server e2e
```

Standalone mode: open `ui/index.html` directly in a browser - paste JSON specs,
no server needed (YAML, URL loading and watches require the hosted app).

## CLI

```bash
node src/cli.mjs analyze --old old.yaml --new https://api.example/openapi.json \
  --repo ./my-app            # dry run: report + PR markdown
  --md migration.md --json report.json
  --write                    # apply auto-proposable edits in place (review-flagged spots untouched)
```

`--repo` also accepts a public git URL (shallow-cloned for the scan).

## Boundaries (by design)

- Removed endpoints are never auto-rewritten; they are flagged for manual review.
- Opening a real PR against a third-party repo requires the repo owner's review -
  Patchline prepares the branch content and markdown, a human files it.
- No customer code is sent to any AI provider. There is no AI code path today;
  if one is added it will be opt-in per workspace.
- Swagger 2.0 and external (cross-file) `$ref`s are not supported yet; the parser
  says so plainly instead of guessing.

## Layout

```
src/engines.mjs    diff / scan / fix / PR engines (single source of truth, tested)
src/openapi.mjs    real OpenAPI 3.x parsing, $ref resolution, normalization
src/server.mjs     hosted app: UI, parse/fetch/analyze APIs, spec watcher
src/cli.mjs        command-line analysis
ui/template.html   UI template; scripts/build-ui.mjs injects the current engine
test/              60 tests across engine, OpenAPI, and server layers
fixtures/          fictional billing API (demo) + Acme Payments OpenAPI 3.x pair
```
