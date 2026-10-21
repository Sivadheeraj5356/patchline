# Auth / private-access design (pre-hosting, awaiting hosting choice)

The server currently has NO authentication: it is designed for localhost or a
private network. Before any hosted deployment, one of these layers is required.
The choice depends on the hosting decision, which is pending.

## Option A: shared-secret header (any host, ~50 lines)

- Server checks `x-patchline-key` on every request except `/api/health`.
- Key stored as a host secret env var; UI stores it in sessionStorage after a
  one-time prompt.
- Single user, single key; rotation = redeploy with a new secret.
- Adequate for a private single-user deployment on Render/Fly/Oracle VM.

## Option B: Cloudflare Access (only if Cloudflare is chosen)

- Access sits in front of the Worker/Pages site; email OTP login, free for
  small teams. No app-code change beyond optionally verifying the CF JWT.
- Best fit if the Cloudflare port happens; not portable to other hosts.

## Option C: GitHub OAuth device flow (heavier, only if multi-user ever matters)

- Real per-user identity, but requires an OAuth app, session storage and CSRF
  handling. Out of scope for a single-user private deployment.

## Non-goals (all options)

- No multi-tenant data model: watches/events remain a single namespace.
- No public anonymous access to /api/* ; the UI itself can be public-read
  only if the user later chooses to publish a demo (separate decision).

## Data protection notes for any hosted version

- Spec URLs and repo URLs in watches.json are user-supplied and may be private;
  the data dir must live on persistent, non-public storage.
- A repo-scoped PAT (for private consumer repos) would be stored as a host
  secret, never in watches.json, and never logged.
