# Design notes

Decisions that are not obvious from the code, and the reasoning to check before changing them.

## CSRF and cross-origin rules

Tailscale Serve tells the API who is calling with the `Tailscale-User-Login` header. That identifies a **device**, not a
page: a script on any website open in the owner's browser can make that browser send a request to the assistant, and
the request arrives with the owner's identity. The API therefore does not rely on identity alone. Three rules apply to
every `/api/*` request, with auth on or off:

1. **`Host` allowlist** (`apps/server/src/http/guard.ts`). `Host` must be `127.0.0.1:<port>`, `localhost:<port>`,
   `[::1]:<port>` or a name in `ASSISTANT_PUBLIC_HOST`. This stops DNS rebinding, where an attacker's domain is re-pointed
   at 127.0.0.1 so that the browser treats the API as same-origin with the attacker's page. Behind the Next dev proxy
   (which rewrites `Host`), `X-Forwarded-Host` must also be one of those names.
2. **`Sec-Fetch-Site`**. A POST/PUT/PATCH/DELETE that the browser marks as anything other than `same-origin` or `none` is
   refused. Requests without the header (curl, older browsers) are not refused by this rule.
3. **JSON-only writes** (`validation.ts`). Every POST/PUT/PATCH/DELETE must carry `Content-Type: application/json`. A page
   cannot send that cross-origin without a CORS preflight, and the server never answers preflights. This is what protects
   browsers that do not send `Sec-Fetch-Site`.

No cookies or CSRF tokens exist, so there is nothing to steal or forget.

### M2 uploads (`POST /api/uploads`, multipart)

A multipart body cannot satisfy rule 3. The plan, to be done when uploads are built (no upload code exists yet):

- Exempt **only** that route from the JSON rule, by an explicit route-level allowance, never by loosening the middleware.
- Rely on rules 1 and 2 for it, and make rule 2 **required** on that route: a request without `Sec-Fetch-Site`, or with a
  value other than `same-origin`/`none`, is refused. Every browser the owner uses sends it; curl callers add
  `-H 'Sec-Fetch-Site: none'`.
- Apply its own body limit (the global one is 256 KB), a file-type allowlist, and store files under `<data>/files` with
  server-generated names.
- Add a test per rule: wrong `Host` → 403, `cross-site` → 403, missing `Sec-Fetch-Site` → 403, and a JSON POST to the same
  path still → 415.

## Two databases, two durability levels

`app.sqlite` is opened with `synchronous=FULL` (every commit is flushed), Durable's `durable.sqlite` with
`synchronous=NORMAL` (Chord's SQLite adapter; the last commits can be lost after a **power cut**, not after a crash of the
process). After a power cut `app.sqlite` can therefore be ahead of Durable: an `agents` row pointing at a conversation
Durable no longer has, which the server refuses at start with an explanation. It cannot happen on a process crash or a
normal shutdown. The laptop is on mains power but has no UPS. Accepted for M1 (the only cross-database reference is the
agent's conversation id, created once). **Revisit in M2**, when rows start referencing Durable task ids: either raise
Durable's database to `FULL` on the adapter before `SqliteStorage.open`, or make each reference self-healing.

## One server per data directory

`<data>/server.lock` (apps/server/src/file-lock.ts) is taken before anything else is opened, and the port is bound before
Durable is opened. Durable has no fence between processes: `Harness.open()` marks every running task as restarted, so a
second process on the same data would steal the first one's work and count crashes that never happened. The lock records
the pid and, on Linux, the process start time, so a lock left by a crash, or by a boot before which the pid was reused,
is recognised as stale. Two processes taking over the same stale lock at the very same instant is narrowed, not
eliminated; that is accepted for one person's laptop.

## What is not retried

A task that Durable parked (`restart_limit`) stays parked: the server reports it (error log at every start, a count in
`GET /api/agents`, a banner in the web app) but never calls `retryTask()` itself, because the usual cause is something
that keeps killing the process (out of memory, a bad input) and retrying would loop. A retry command is future work.
