# Nova AI — Medical AI Assistant (HIPAA-Safe Chat + Scribe Platform)

## Nova HTTP API (frontend integration)

Base path: `/api/nova/…` on the Fastify API host (e.g. local `http://localhost:3001`, production `https://api.enscribe.online`).

**Auth:** every route requires a valid **Bearer JWT** (same Supabase session / `Authorization: Bearer <access_token>` pattern as the rest of the API). Unauthenticated requests are rejected by the server before Nova logic runs.

**Listing:** `GET /api/nova/chat-sessions` returns paginated **metadata** from Supabase (`chatId`, **`title`**, org, token counters, timestamps). It does **not** require Redis. Load full transcript + summary with `GET …/:chatId` (Redis first, then hydrate).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/nova/chat-sessions` | List the signed-in user’s sessions (query: `limit`, `offset`, `sortBy`, `order`; see below). |
| `POST` | `/api/nova/chat-sessions` | Create a new chat; returns `chatId` + initial `session`. |
| `GET` | `/api/nova/chat-sessions/:chatId` | Load session (Redis first, else hydrate from Supabase). |
| `PATCH` | `/api/nova/chat-sessions/:chatId` | Update `summary`, `token_estimate`, `messages`, `appendMessages`, or **`title`**. |
| `POST` | `/api/nova/chat-sessions/:chatId/completions` | Enqueue one user turn: persists **user** message immediately; returns **202** + job id (or **200** idempotent replay if that `client_message_id` already completed). Bedrock runs asynchronously in-process (`setImmediate`, same pattern as `POST /api/jobs/prompt-llm/generate-note`). |
| `GET` | `/api/nova/chat-sessions/:chatId/completion-jobs/:jobId` | Poll completion job until `complete` or `failed`. While `running`, may include growing `assistant_partial` (see [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream)). Terminal `complete` includes `assistant`, `usage`, `session`. |
| `POST` | `/api/nova/chat-sessions/:chatId/token-usage` | Record token usage (optional path if the client meters separately). |

`:chatId` must be a UUID. Validation errors return **400** with a serialized Zod `error` payload.

### `session` object (API shape)

Mirrors Redis working state; use it to render the transcript and optional indicators:

- **`chat_id`** — session id (same as URL `:chatId` once created).
- **`messages`** — array of `{ role: 'user' \| 'assistant' \| 'system', content: string }`; **full transcript** in order. After a completion job **finishes**, the API has appended the assistant reply (the user line is written when the job is **accepted**).
- **`summary`** — rolling text summary (may be empty for new chats).
- **`summary_covered_message_count`** — how many leading `messages` are treated as folded into `summary` for model context (advanced; usually you still render all `messages` for the user).
- **`summarize_pending`** — `true` when a rolling summarization job is queued or due; safe to show a subtle “updating memory…” or ignore.
- **`token_estimate`**, **`last_active`** — hints / bookkeeping.
- **`title`** — human-readable thread label for sidebar / history (default **`"New Chat"`**; optional create override; user `PATCH`; Haiku after first successful completion).

Server-side env knobs (context limits, summarize thresholds, queue timing) **do not** need to be configured in the frontend.

### `GET /api/nova/chat-sessions`

**Query (optional):** `limit` (default **50**, max **100**), `offset` (default **0**), `sortBy` = `last_active_at` \| `created_at` \| `updated_at` (default `last_active_at`), `order` = `asc` \| `desc` (default `desc`).

**Success (200):** paginated rows from `chat_sessions` for the JWT user. Does **not** load Redis or decrypt messages; use `GET …/:chatId` for the full `<Session>`.

### `POST …/completions`

**Body (JSON, strict):**

```json
{
  "model": "haiku",
  "message": "User message for this turn (non-empty string)",
  "client_message_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

`model` is one of: **`haiku`**, **`sonnet`**, **`opus`** (presets; server maps to Bedrock model ids). **`client_message_id`** must be a **UUID** per turn from the client (idempotency: same id returns the same **200** replay after success, or the same **202** job while still `pending`/`running`).

**Success (202 Accepted)** — new job (or in-flight duplicate of the same `client_message_id`):

```json
{
  "id": "<job-uuid>",
  "status": "pending",
  "chat_id": "<chatId>"
}
```

**Success (200 OK)** — idempotent replay after the job already **`complete`** for this `client_message_id` (same shape as a terminal poll):

```json
{
  "id": "<job-uuid>",
  "status": "complete",
  "chat_id": "<chatId>",
  "assistant": { "role": "assistant", "content": "…" },
  "usage": { "input_tokens": 1234, "output_tokens": 56, "total_tokens": 1290, "model": "…" },
  "session": { }
}
```

`usage` may be **`null`** when Bedrock did not return usage for that turn; tolerate it in the UI.

**Behavior:** `POST` returns quickly after persisting the **user** line (first attempt) and enqueueing work, or after accepting a **retry** for the same `client_message_id` when a prior job **`failed`** (no second user row — same text must match the pending user line at end of session). Poll **`GET …/completion-jobs/:jobId`** until `status` is `complete` or `failed`. While `running`, the poll may include **`assistant_partial`** (cumulative assistant text; not in `session.messages` until `complete`) — see [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream). The **user** message **stays** in the transcript when a job fails (no server-side delete). At most **one** non-terminal job per `chatId` (Postgres partial unique index); a second turn with a different `client_message_id` while another job is active yields **409** `NOVA_COMPLETION_IN_FLIGHT`. Bedrock or persist failures set the job to `status: failed`; see poll response below.

### `GET …/completion-jobs/:jobId`

**Success (200):** while **`pending`** (no assistant text yet):

```json
{ "id": "<job-uuid>", "status": "pending", "chat_id": "<chatId>" }
```

While **`running`** — same base fields; once Bedrock has emitted at least one token, the poll may also include:

```json
{
  "id": "<job-uuid>",
  "status": "running",
  "chat_id": "<chatId>",
  "assistant_partial": "The reply accumulated so far…",
  "partial_revision": 12
}
```

`assistant_partial` is the **full** assistant text so far (not a delta). `partial_revision` increments on each server-side partial write (~every 150 ms while streaming). Omit both fields when still waiting for the first token.

When **`complete`** (unchanged — source of truth for the persisted transcript):

```json
{
  "id": "<job-uuid>",
  "status": "complete",
  "chat_id": "<chatId>",
  "assistant": { "role": "assistant", "content": "…" },
  "usage": { } ,
  "session": { }
}
```

No `assistant_partial` on `complete`. Replace any in-flight assistant bubble from **`session.messages`** (last assistant line).

When **`failed`**:

```json
{
  "id": "<job-uuid>",
  "status": "failed",
  "chat_id": "<chatId>",
  "code": "NOVA_BEDROCK_FAILED",
  "error": "…",
  "assistant_partial": "Text received before failure, if any",
  "partial_revision": 12
}
```

`assistant_partial` on **`failed`** is **poll-only** — it is **not** written to `session.messages`. The user line remains in the transcript. Whether to keep showing the partial in the UI is a **frontend** choice (see [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream)).

**404:** `NOVA_COMPLETION_JOB_NOT_FOUND` — wrong `jobId`, or job does not belong to this `:chatId`.

### `PATCH …/:chatId`

Body must include **at least one** of: `summary`, `token_estimate`, `messages`, `appendMessages`, **`title`** (trimmed, max **40** chars; empty after trim → **400**).

- **`messages`** — replace the full transcript (and the server resets `summary_covered_message_count` to `0`).
- **`appendMessages`** — append-only array of new `{ role, content }`; do **not** send both `messages` and `appendMessages` in the same request.

Caps (from schema): e.g. up to **500** messages on full replace, **50** on append; content length limits per field apply — see `src/fastify/schemas/novaChatRequests.js` for exact numbers.

### `POST /api/nova/chat-sessions` (create)

**Body (optional, strict):** `{}` or `{ "title": "…" }` only. **`title`** — trimmed, **1–40** chars; server default **`"New Chat"`** when omitted.

**Success (201):** `{ "chatId": "<uuid>", "session": <Session> }` — `session.title` matches what was stored (default or override).

### Session title (frontend)

Shipped on **`session.title`** (full session) and list row **`title`** (sidebar / history). Plaintext on the server — same PHI trust model as showing the transcript.

| Source | Field | When to use |
|--------|--------|-------------|
| `GET /api/nova/chat-sessions` | `sessions[].title` | Sidebar / history list **without** loading transcripts |
| `POST` create, `GET …/:chatId`, `PATCH`, terminal completion poll | `session.title` | Open thread header, detail view, after mutations |

**Rules the UI should respect**

1. **Default label** — Treat missing/`null` as **`"New Chat"`** only as a fallback; prefer the API value once integrated.
2. **Create** — `POST` with no body or `{}` → `"New Chat"`. Optional `{ "title": "Custom label" }` (max **40** chars after trim) skips AI title generation later.
3. **User rename** — `PATCH { "title": "New label" }` (only field required). Empty/whitespace → **400**. Updates list + open session on next GET/list refresh.
4. **AI title (async)** — After the **first successful completion**, the server may replace `"New Chat"` with a short Haiku-generated label (**fire-and-forget**). The **completion poll** when `status: complete` may still show `"New Chat"`; the title can appear seconds later.
5. **Refresh strategy** — After a job completes, optionally:
   - merge `response.session.title` immediately (may still be `"New Chat"`), then
   - re-fetch **`GET …/:chatId`** or **`GET /api/nova/chat-sessions`** once (or poll lightly for ~30s) if the sidebar/header should show the AI label; or refresh on next navigation/focus.
6. **Never overwrite from the client** — Do not keep a local-only title after the server sends a different one; do not expect a second AI rename on later turns (server runs at most once; user **`PATCH`** is the only way to change a settled title).
7. **List vs open thread** — Keep **`chatId` → title** in client state from the list; when opening a thread, prefer **`GET …/:chatId`** `session.title` if the user may have renamed on another device.

**Example — create with custom title**

```json
POST /api/nova/chat-sessions
{ "title": "Billing question" }
→ 201 { "chatId": "…", "session": { "title": "Billing question", "messages": [], … } }
```

**Example — rename**

```json
PATCH /api/nova/chat-sessions/:chatId
{ "title": "Renamed thread" }
→ 200 { "session": { "title": "Renamed thread", … } }
```

### `POST …/:chatId/token-usage`

**Body:**

```json
{
  "input_tokens": 1000,
  "output_tokens": 200,
  "model": "optional-string",
  "cost_usd": 0
}
```

**Success (201):** `{ "ok": true, "total_tokens": … }` (running total from the insert path). Most chat UIs can rely on **`usage` from completions** instead of calling this.

### Error responses (stable `code` where provided)

| HTTP | `code` (when present) | When |
|------|------------------------|------|
| 400 | (Zod / validation) | Bad `chatId`, body schema, or invalid `model` preset (`NOVA_MODEL_INVALID`). |
| 400 | `NOVA_CLIENT_MESSAGE_MISMATCH` | Retry after a **failed** job with the same `client_message_id` but `message` does not match the pending user line at end of session. |
| 400 | `NOVA_COMPLETION_RETRY_INVALID_STATE` | Retry requested (prior **`failed`** job for this `client_message_id`) but the session does not end with the expected user message (e.g. reload needed). |
| 404 | `NOVA_SESSION_NOT_FOUND` | Unknown chat or no access. |
| 404 | `NOVA_COMPLETION_JOB_NOT_FOUND` | Unknown job id, or job does not belong to this `:chatId`. |
| 409 | `NOVA_COMPLETION_IN_FLIGHT` | Second `POST …/completions` for the same chat while another job is `pending`/`running` (different `client_message_id`); poll the active job or wait. |
| 503 | `REDIS_UNAVAILABLE` | Create, load, patch, or completions path requires Redis (`REDIS_URL`); **not** returned for `GET /api/nova/chat-sessions` (list is Supabase-only). |
| 500 | `NOVA_SESSION_PERSIST_FAILED`, `NOVA_TOKEN_USAGE_FAILED`, `NOVA_SESSION_LIST_FAILED`, etc. | Persistence or internal errors. |
| 401 | — | Missing or invalid Bearer JWT: `{ "error": "<message>" }` (e.g. token required, invalid/expired). Same auth as the rest of the API; refresh tokens like other authenticated routes. |

Non-production errors may include a **`detail`** string (e.g. Bedrock message).

### Response envelopes & HTTP status (frontend)

All successful bodies are JSON. `<Session>` means the [session object](#session-object-api-shape) (`chat_id`, **`title`**, `messages`, `summary`, …).

| Route | Success HTTP | Response body |
|--------|----------------|----------------|
| `GET /api/nova/chat-sessions` | **200** | `{ "sessions": [ { "chatId", "organizationId", "title", "token_estimate", "total_tokens", "created_at", "updated_at", "last_active_at" } ], "total": <number>, "limit": <number>, "offset": <number> }` — metadata only; no transcript. |
| `POST /api/nova/chat-sessions` | **201** | `{ "chatId": "<uuid>", "session": <Session> }` — optional body `{ "title": "…" }` (trimmed, max **40** chars); default **`"New Chat"`**. |
| `GET /api/nova/chat-sessions/:chatId` | **200** | `{ "session": <Session> }` |
| `PATCH /api/nova/chat-sessions/:chatId` | **200** | `{ "session": <Session> }` |
| `POST /api/nova/chat-sessions/:chatId/completions` | **202** | `{ "id": "<job-uuid>", "status": "pending" \| "running", "chat_id": "<chatId>" }` — also **200** when replaying a finished turn with the same `client_message_id` (see POST section). |
| `GET /api/nova/chat-sessions/:chatId/completion-jobs/:jobId` | **200** | `{ "id", "status", "chat_id" }` — when `status` is `complete`, includes `assistant`, `usage` (\| null), `session`; when `failed`, includes `code`, `error`; while `running`, optional `assistant_partial`, `partial_revision`; on `failed`, optional last `assistant_partial` (see [Completion partial streaming](#completion-partial-streaming)). |
| `POST /api/nova/chat-sessions/:chatId/token-usage` | **201** | `{ "ok": true, "total_tokens": <number> }` |

**Headers:** send **`Authorization: Bearer <access_token>`** on every call. For routes with a JSON body, use **`Content-Type: application/json`**.

**Validation (400):** many schema failures return `{ "error": { "name": "ZodError", "message": "<string — JSON-encoded Zod `issues` array>" } }`. Production UIs often show a generic invalid-request message; parse `error.message` when you need field-level detail in dev or support tooling.

### Suggested chat UI flow (minimal)

1. **New thread:** `POST /api/nova/chat-sessions` (optional `{ "title": "…" }`) → persist `chatId`; show **`session.title`** in header/sidebar (default **`"New Chat"`**). Render `session.messages` (starts empty).
2. **Open existing:** `GET /api/nova/chat-sessions/:chatId`; on **404** (`NOVA_SESSION_NOT_FOUND`), treat as unknown/expired id and start a new session or show an error.
3. **Send a turn:** `POST …/completions` with `{ "model": "haiku" \| "sonnet" \| "opus", "message": "<non-empty string>", "client_message_id": "<uuid>" }` → **202** + `id` (job id). Poll **`GET …/completion-jobs/:id`** until `status` is `complete` or `failed`. The **user** message appears in `session.messages` as soon as **202** is returned (refresh `GET …/:chatId` if needed). While `running`, poll may return growing **`assistant_partial`** — render that in **local UI state** until `complete` (see [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream)). **Retry after `failed`:** same `client_message_id` and **same** `message` → **202** for a new job **without** duplicating the user row; if `message` does not match the pending user line, the API returns **400** (`NOVA_CLIENT_MESSAGE_MISMATCH` or `NOVA_COMPLETION_RETRY_INVALID_STATE`).
4. **After a successful job:** drive the transcript from **`response.session.messages`** on the terminal poll (or **200** idempotent replay). Update **`session.title`** from the same payload; if still **`"New Chat"`** after the **first** completion, optionally re-fetch session or list once for the [async AI title](#session-title-frontend). Optionally show **`response.usage`**; tolerate **`usage: null`**.
5. **Rolling summary in the UI:** if you surface `summary` or “memory,” refresh via **`GET …/:chatId`** while `summarize_pending` is true (poll lightly or on focus) — the worker updates Redis/DB in the background. The next completion’s `session` is also fine without polling.
6. **Session list / sidebar:** `GET /api/nova/chat-sessions` for **metadata** (ids, **`title`**, activity, token totals). Bind row **`title`** in the list; refresh the list after create, rename **`PATCH`**, or when you detect an AI title update on the open thread. For transcript content, call `GET …/:chatId` when the user opens a thread (or prefetch sparingly).
7. **`PATCH`:** use for **user rename** (`{ "title": "…" }`), transcript edits, or summary/token hints — see the PATCH section and [Session title (frontend)](#session-title-frontend) above.

Reference tests: API **`tests/nova-chat-sessions-completions.test.js`**; Bedrock + title E2E **`tests/nova-chat-sessions-completions.e2e.test.js`** (`npm run test:nova-chat-sessions-completions-e2e`).

### Frontend: partial completions (poll pseudo-stream)

**Shipped.** The API exposes incremental assistant text during an in-flight job by extending the existing **202 + poll** flow. There is **no** SSE or WebSocket — the frontend polls `GET …/completion-jobs/:jobId` and reads optional `assistant_partial` while `status` is `running`.

Full backend notes: [Completion partial streaming](#completion-partial-streaming) (debounce, Redis TTL, feature flag).

#### What changed vs the pre-partial API

| Area | Before | Now |
|------|--------|-----|
| `POST …/completions` | **202** + `{ id, status, chat_id }` | **Unchanged** |
| Poll while `pending` / early `running` | `{ id, status, chat_id }` only | Same until first token; then optional `assistant_partial` |
| Poll on `complete` | `assistant`, `usage`, `session` | **Unchanged** — no partial fields |
| Poll on `failed` | `code`, `error` | Same + optional **last** `assistant_partial` (ephemeral) |
| `GET …/:chatId` during a turn | User line present; **no** assistant line until job completes | **Still true** — partial text exists **only** on the job poll, not in `session.messages` |
| Client integration | Show a loading placeholder until terminal poll | May render a **local** assistant bubble from `assistant_partial` while polling |

**Additive only:** clients that ignore unknown JSON keys keep working. To opt out server-side (e.g. staging), set `NOVA_COMPLETION_PARTIAL=0` — poll responses revert to the old shape and Bedrock uses non-streaming invoke.

#### New poll fields (frontend contract)

| Field | Type | When present |
|-------|------|----------------|
| `assistant_partial` | string | `running` and ≥1 token received; or `failed` if any text was streamed before failure. **Omit** on `pending`, when empty, and on `complete`. |
| `partial_revision` | integer | Present whenever `assistant_partial` is present. Monotonic per job; use to skip redundant re-renders when unchanged. |

`assistant_partial` is always the **cumulative** assistant reply, not a token delta.

#### Recommended UI pattern

1. **After `POST …/completions` → 202:** show the user message (refresh `GET …/:chatId` or optimistically append locally). Start polling with `jobId`.
2. **While `pending` or `running` without `assistant_partial`:** show a typing / loading indicator for the assistant (same as before partials shipped).
3. **When `assistant_partial` appears:** render one **local** assistant bubble bound to `assistant_partial` (do **not** expect it in `session.messages` yet). Update the bubble text on each poll when `partial_revision` changes.
4. **On `complete`:** stop polling. **Discard** the local partial bubble and render from **`response.session.messages`** (or `response.assistant.content`). Persisted transcript is authoritative.
5. **On `failed`:** stop polling. Either keep showing the last `assistant_partial` with an error + retry affordance, or clear the bubble — partial is **not** saved server-side until a successful `complete`.

Do **not** append `assistant_partial` into your persisted message list; wait for `complete` (or use `GET …/:chatId` after success).

#### Poll intervals (suggested)

| Job state | Suggested interval |
|-----------|-------------------|
| `pending` | 500 ms – 1 s |
| `running`, no `assistant_partial` yet | 300 – 500 ms |
| `running`, `assistant_partial` updating | 200 – 400 ms |
| `complete` or `failed` | Stop polling |
| HTTP 5xx / network error | Exponential backoff, cap ~5 s |

Compare `partial_revision` (or string length) before updating the DOM.

#### Reload / tab refresh

There is **no** `GET …/active-completion-job` in v1. After **202**, persist in `sessionStorage` (or equivalent):

```javascript
{ chatId, jobId, client_message_id }
```

On thread mount: if the stored `chatId` matches, resume polling `GET …/completion-jobs/:jobId` until terminal. Duplicate `POST …/completions` with the same `client_message_id` while still in-flight returns the **same** job id — resume polling; do not create a second assistant bubble.

#### Animation (suggested)

While `running`, prefer a **cursor at the end** of `assistant_partial` and replace text directly each poll. Avoid typewriter animation over text already received via poll.

#### Minimal poll handler sketch

```javascript
let lastRevision = -1;

async function pollCompletionJob(chatId, jobId) {
  const res = await fetch(`/api/nova/chat-sessions/${chatId}/completion-jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const job = await res.json();

  if (job.status === 'running' && job.assistant_partial != null) {
    if (job.partial_revision !== lastRevision) {
      lastRevision = job.partial_revision;
      setInFlightAssistantText(job.assistant_partial); // local UI state only
    }
    return 'continue';
  }

  if (job.status === 'complete') {
    setTranscriptFromSession(job.session); // replaces in-flight bubble
    return 'done';
  }

  if (job.status === 'failed') {
    // optional: job.assistant_partial + job.error + retry
    return 'failed';
  }

  return 'continue'; // pending / running, no partial yet
}
```

#### Explicitly not provided to the frontend

- SSE / WebSocket streaming
- `assistant_partial` on `GET …/:chatId` or in `session.messages` until `complete`
- Server-enforced poll rate limits
- Persisted partial text after `failed` (retry starts a **new** job; same `client_message_id` + same `message` does not duplicate the user row)

### UX tips for the client

- After **201** create, keep `chatId`, **`session.title`**, and use **`session.messages`** for the thread.
- **Titles:** max **40** characters; server trims. Show list **`title`** without loading the full session; re-list or **GET …/:chatId** after rename or first completion if you want the AI label in the sidebar.
- On **409**, another turn is already queued or running for this chat; poll the active job or wait before sending a **different** `client_message_id`.
- **Partial completions:** while a job is `running`, bind a local assistant bubble to poll `assistant_partial`; on `complete`, switch to `session.messages`. See [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream).
- **Summarization** runs in a **background worker**; the chat reply path does not block on it. `summarize_pending` may flicker `true` then `false` after a poll or next completion.

Deeper behavior (Redis keys, worker queue, encryption, Bedrock prompt assembly) is described below in this same document.

---

## Overview

This document defines the architecture for a HIPAA-compliant AI assistant built on AWS Bedrock (Claude) designed for clinicians. The system functions as a secure, general-purpose “ChatGPT for healthcare professionals,” supporting both clinical and non-clinical workflows (for example documentation, insurance contracts, billing, and general medical reasoning).

The system is built around a **stateless LLM with stateful application memory layers**.

### Implementation status (this repository)

| Area | Status |
|------|--------|
| Session list (metadata) | **Done** — `GET /api/nova/chat-sessions` (Supabase `chat_sessions` for JWT user; pagination + sort; no Redis). |
| Redis hot session cache | **Done** — keys `nova:chat:{userId}:{chatId}`, TTL `NOVA_REDIS_SESSION_TTL_SEC`; optional `REDIS_URL` (Nova returns 503 if cache unavailable for routes that need it). |
| Redis AUTH (ElastiCache vs local dev) | **Done** — optional `REDIS_AUTH_TOKEN` merged into the connection URL when `REDIS_URL` has no embedded password (typical ElastiCache). For passwordless local Redis (`127.0.0.1`, `localhost`, `::1`), AUTH is not sent so a prod token in `.env.local` does not break local runs. |
| Supabase session + message persistence | **Done** — tables `chat_sessions`, `chat_messages`; summary and message bodies encrypted with the user’s wrapped master key (same pattern as notes); RLS + `organization_id` (personal org via `ensurePersonalOrganization`). |
| Reload Redis from Supabase | **Done** — GET misses cache: decrypt from Postgres, repopulate Redis. |
| Token usage rows + session aggregate | **Done** — `chat_token_usage` + `POST .../token-usage`; `total_tokens` on `chat_sessions` incremented per event (per-seat `user_id` for metering). |
| AWS Bedrock orchestration (chat turn) | **Done (async job + poll)** — `POST …/completions` returns **202** + job id, persists user message, `setImmediate` runs `novaChatCompletionProcessor` (JWT Supabase + Bedrock, same idea as prompt-llm jobs). Poll `GET …/completion-jobs/:jobId`. Table `nova_chat_completion_jobs` (`status` is Postgres enum `nova_chat_completion_job_status`); partial unique one active job per `chat_id`. |
| Automated tests (completions) | **Done** — `tests/nova-chat-sessions-completions.test.js` (`npm run test:nova-chat-sessions-completions`; in `runAll.js` suite 2.15). **Bedrock E2E** (opt-in, `.e2e.test.js`, not in runAll): `npm run test:nova-chat-sessions-completions-e2e` — 2× completions, usage shape, AI `session.title` after first turn. Unit: `tests/novaBedrockChat.unit.test.js`, `tests/novaSummarize.unit.test.js`, `tests/novaChatTitle.unit.test.js`. **Summarize queue E2E:** `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` in `.env.local` (dev/staging only; server `NODE_ENV=production` ignores it), restart Fastify, then `npm run test:nova-summarize-queue-e2e` — spawns worker subprocess, two completion rounds after rolling summarize, asserts full persisted transcript length, `summary_covered_message_count`, and that the next Bedrock turn uses a single-message dialog (no duplicated pre-checkpoint pairs); writes `test-results/nova-summarize-queue-e2e.json`. |
| Deploy secrets (Redis on EC2) | **Done** — GitHub Actions deploy writes `REDIS_URL` (required) and optional `REDIS_AUTH_TOKEN` into EC2 `.env.local`. |
| Chat persistence path | **Done** — Nova create / PATCH persist synchronously; each completion **accept** appends the user message to Postgres + Redis; the async processor appends the assistant when Bedrock succeeds. **Deferred:** Postgres outbox / write-behind — only if synchronous writes become a bottleneck; there is **no** separate background worker process for chat completions today (in-process continuation only). |
| Background worker (rolling summarization) | **Done** — `npm run worker:nova-summarize` (`src/workers/novaSummarizeWorker.js`): drains Redis list `nova:summarize:queue`, **sweep** re-queues members of `nova:summarize:due` on an interval. API enqueues after a completion job **finishes** when Bedrock `usage.input_tokens` ≥ `NOVA_SUMMARIZE_CONTEXT_THRESHOLD` (default `0.7`) of the preset context limit (non-production tests may use `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` to enqueue without hitting threshold). Worker uses `SUPABASE_SERVICE_ROLE_KEY` and `getOrCreateUserMasterKey` to decrypt/load and encrypt/persist session summary + messages. |
| Per-chat active completion guard | **Done** — Postgres partial unique index on `nova_chat_completion_jobs(chat_id)` where `status` ∈ (`pending`,`running`); second **different** turn → **409** `NOVA_COMPLETION_IN_FLIGHT`. Same `client_message_id` while in-flight → same **202** job id. |
| Chat session display title | **Done** — `session.title`, Postgres `chat_sessions.title`, optional create/`PATCH`, Haiku fire-and-forget after first successful completion (`src/utils/novaChatTitleService.js`). |
| Full transcript vs Bedrock message list | **Done** — After each completion, `session.messages` is the **full** ordered transcript (append user + assistant). The Bedrock request uses **`novaPriorDialogMessagesForBedrock`**: `messages.slice(summary_covered_message_count)` only, so turns already folded into the rolling summary are not duplicated in the model’s `messages` array. |
| Redis failure → regenerate summary | **Partial** — history reloads from Supabase; rolling summary is whatever was last persisted. **Rolling LLM summarize** runs via worker when enqueued; not automatically replayed on cold Redis rebuild unless a job remains in `nova:summarize:due`. |
| Completion partial streaming (poll) | **Done** — pseudo-stream via frequent poll + `assistant_partial` on `running`/`failed`; Bedrock streams server-side only. **No SSE/WebSocket.** See [Completion partial streaming](#completion-partial-streaming). Disable with `NOVA_COMPLETION_PARTIAL=0`. |

#### What is still partial, deferred, or not implemented?

- **Deferred (by design):** **Postgres outbox / write-behind** — optional pattern if per-turn Supabase + Redis ever becomes too slow; not a “chat message worker”; normal turns stay on the API path above.
- **Partial:** **Redis cold / loss** — full message history reloads from Supabase; rolling `summary` is last-persisted only. The summarize worker does not auto-run unless a job remains queued (`nova:summarize:queue` / `nova:summarize:due`). **`summarize_pending` and `summary_covered_message_count` are not faithfully restored from Postgres on hydrate** — `loadNovaChatSessionFromSupabase` resets `summarize_pending` to `false` and derives checkpoint from summary vs messages only; durable flags + reconciliation described in [Total Redis loss](#total-redis-loss-flush-new-cluster-prolonged-outage) are recommendations, not fully implemented.
- **Planned (not shipped):** [Rolling summary — structured JSON](#rolling-summary--structured-json-planned) (`schema_version` 1: `facts`, `decisions`, `constraints`, `follow_ups`, `open_questions`).
- **Doc vs code:** [Failure Handling](#failure-handling) “buffer in Redis / retry async persistence” on Supabase failure is an **architectural option**, not the current Nova completion path (today a failed persist surfaces as an error to the client after Bedrock may already have run).
- **Not implemented:** **Client-side streaming** (SSE/WebSocket) for assistant output; vector / RAG, multimodal, encounter-linked sessions — see [Future enhancements](#future-enhancements) and [Implementation open questions](#implementation-open-questions). (**Note:** `client_message_id` on `POST …/completions` is implemented for idempotent / retry semantics.)

### Chat session title (shipped)

Per-thread **display title** for session lists and the open thread header.

#### Product rules

| Rule | Decision |
|------|----------|
| **Default** | Server writes **`"New Chat"`** into Postgres on `POST /api/nova/chat-sessions` create. |
| **Create override** | Optional request body `{ "title": "…" }` (trimmed, max **40** chars). If omitted, default `"New Chat"`. |
| **User rename** | `PATCH /api/nova/chat-sessions/:chatId` accepts **`title`** (trimmed, max **40** chars; reject empty after trim with **400**). |
| **AI generation trigger** | **Once**, after the **first successful completion** (first user + first assistant both persisted). **Fire-and-forget** at end of `novaChatCompletionProcessor` — do **not** block the completion poll on title Bedrock. |
| **Skip AI when** | At first completion, `title !== "New Chat"` (FE set a custom title at create, or user already renamed). |
| **Never overwrite** | AI runs at most once; later turns do not replace an AI or user title. User `PATCH` is the only way to change a non-default title after AI. |
| **AI failure** | **Fail open** — keep current title (`"New Chat"` or user-set); log; no user-visible error. |
| **Model** | **Haiku** one-liner Bedrock pass (`resolveNovaBedrockModelId('haiku')` or dedicated env override). |
| **Billing** | Title generation does **not** count toward **`NOVA_RESPONSE`** usage limits (no `assertUsageAllowed` / `recordUsageSuccess` on this path). |
| **Prompt input** | First **user** message + first **assistant** reply only (truncate each for prompt bounds if needed). |
| **Prompt guidance** | Ask for a short label: **&lt;6 words**, ~**25** chars target, plain text only, no quotes or preamble. |
| **Post-process** | Trim; if over **40** chars, truncate to fit (word-aware strip preferred). Same **40** char cap as user PATCH. |
| **Encryption** | **Plaintext** `title` column on `chat_sessions` (sidebar must list without decrypting message bodies). Titles may echo PHI from the first turn — same trust model as showing the transcript in the UI. |

#### API / session shape

- **`title` lives on `<Session>`** as **`session.title`** everywhere the session object is returned (`POST` create, `GET …/:chatId`, `PATCH`, terminal completion poll / idempotent **200** replay). Keeps one object for render state.
- **`GET /api/nova/chat-sessions` list rows** also include **`title`** (read from Postgres; no Redis required).
- **Breaking change?** **Additive only** for HTTP clients: new field on existing envelopes. Clients that ignore unknown keys keep working. **Frontend:** bind **`session.title`** / list row **`title`**; stop hardcoding `"New Chat"` except as a display fallback when the field is absent (legacy rows).

#### Persistence

- **Postgres:** add `chat_sessions.title text not null default 'New Chat'` (backfill existing rows to default).
- **Redis:** include **`title`** in the hot-session JSON (`nova:chat:{userId}:{chatId}`); load/save with other session fields; hydrate from Supabase on cache miss.

#### Implementation checklist

- [x] Migration: `chat_sessions.title` (`sql/migrations/20260616_chat_sessions_title.sql`)
- [x] `createEmptyNovaSession` / `normalizeNovaSessionShape` / load & persist paths
- [x] `POST` create optional body; `PATCH` `title`; list select + map
- [x] Haiku title helper + fire-and-forget hook after first successful completion
- [x] Tests + [Response envelopes](#response-envelopes--http-status-frontend) table updated

---

### Completion partial streaming

**Status: shipped** (API v1). Server-side Bedrock streaming + Redis partial cache; client consumes via poll only.

Expose **incremental assistant text** during an in-flight completion job by extending the existing **202 + poll** flow. **No SSE / WebSocket.** The server invokes Bedrock with **response streaming internally**, debounces accumulated text into Redis, and returns it on **`GET …/completion-jobs/:jobId`** while `status` is `running`. Terminal behavior (`complete` / `failed`) stays compatible with the pre-partial contract.

**Frontend integration:** [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream) (recommended starting point for UI work).

#### Rationale

- Polling is resilient on flaky networks (each poll is a stateless authenticated GET).
- Aligns with the shipped async job model; no long-lived HTTP connections or proxy timeout issues.
- Additive API change — clients that ignore new fields keep working.

#### Locked decisions

| # | Topic | Decision |
|---|--------|----------|
| 1 | **Reload recovery** | **FE `sessionStorage` (option A).** Persist `{ chatId, jobId, client_message_id }` after **202**; on mount, resume polling if job is non-terminal. **No new backend “active job” endpoint in v1.** |
| 2 | **Failed after partial** | **Option B — FE may keep showing last partial in the UI.** Backend **includes** `assistant_partial` (and `partial_revision`) on **`failed`** poll responses when any text was accumulated; **does not persist** partial to Postgres / `session.messages`. Whether to display or clear that text is a **frontend** choice. |
| 3 | **In-flight idempotent replay** | **Yes.** Same `client_message_id` while job is `pending`/`running` → **202** with same job id; FE resumes poll and consumes partials. |
| 4 | **V1 scope** | **API-only** in `enscribe-api`: processor, Redis partial cache, poll payload extension, tests, docs. Frontend UX (animation, pre-first-token spinner, etc.) is **out of scope** for v1. |
| 5 | **Pre-first-token UX** | **Frontend decision** (out of scope for API v1). |
| 6 | **Animation** | **Frontend decision** (out of scope for API v1). Suggested: cursor at end of growing text, not full typewriter over already-received partials. |
| 7 | **Poll intervals** | **Frontend decision** — suggested defaults documented below (guidance only, not enforced by API). |
| 8 | **Redis write debounce** | **150 ms** between partial writes while Bedrock streams. |
| 9 | **Partial Redis TTL** | **30 minutes** (or job max duration + buffer). Key deleted on `complete`; expires automatically if job stalls without terminal status. |
| 10 | **Poll rate limit** | **None** in v1. |

#### API contract

**Unchanged routes**

- `POST /api/nova/chat-sessions/:chatId/completions` — still **202** + `{ id, status, chat_id }` (or **200** idempotent replay when already `complete`).
- Terminal **`complete`** poll — unchanged: `assistant`, `usage`, full `session` (source of truth for persisted transcript).

**Extended poll response — `GET …/completion-jobs/:jobId`**

While `pending` or `running` (additive fields; omit when not applicable):

```json
{
  "id": "<job-uuid>",
  "status": "pending | running",
  "chat_id": "<chatId>",
  "assistant_partial": "<full assistant text accumulated so far>",
  "partial_revision": 12
}
```

| Field | Type | When present |
|-------|------|----------------|
| `assistant_partial` | string | `running` and at least one token received; **omit** on `pending` and when empty |
| `partial_revision` | integer | Monotonic counter incremented on each Redis partial write; FE may skip re-render when unchanged |

On `failed` (extends current shape):

```json
{
  "id": "<job-uuid>",
  "status": "failed",
  "chat_id": "<chatId>",
  "code": "NOVA_BEDROCK_FAILED",
  "error": "Model request failed",
  "assistant_partial": "<last accumulated text, if any>",
  "partial_revision": 12
}
```

- `assistant_partial` on **`failed`** is **ephemeral** (poll-only); not written to `session.messages`.
- Retry semantics unchanged: same `client_message_id` + same `message` → new job without duplicating the user row.

On **`complete`** — no partial fields; partial Redis key is deleted. FE should replace any in-flight bubble from **`response.session.messages`**.

#### Backend behavior

1. **`novaChatCompletionProcessor`** calls Bedrock via **`InvokeModelWithResponseStream`** (stream server-side only).
2. Accumulate text chunks in memory; **debounce Redis writes every 150 ms** (and flush on stream end).
3. **Redis key:** `nova:completion:partial:{jobId}` — JSON `{ text, revision }` or equivalent; **TTL 30 min**; scoped to job id (RLS on poll still enforced via job row ownership).
4. **Poll handler:** if job `status` is `running`, read partial from Redis and attach to JSON. If `failed`, attach last partial if key still exists, then delete key.
5. **On successful `complete`:** persist full assistant message (existing path), update job row, delete partial key.
6. **Billing / usage:** unchanged — recorded only on successful **`complete`**.
7. **Feature flag (optional):** `NOVA_COMPLETION_PARTIAL=0` disables partial writes (poll behaves as today).

**PHI / trust model:** partial text in Redis is **plaintext**, same as the hot session cache — user-scoped, short-lived.

#### Frontend guidance (summary)

Normative detail for UI integration lives in [Frontend: partial completions](#frontend-partial-completions-poll-pseudo-stream) at the top of this document. Quick reference:

- **Reload recovery** — after **202**, store `{ chatId, jobId, client_message_id }`; resume poll on mount.
- **Failed after partial** — optional `assistant_partial` on `failed` poll; not persisted until `complete`.
- **In-flight replay** — same `client_message_id` → same job id → resume poll; one assistant bubble.
- **Poll intervals & animation** — see the frontend section above.

#### Explicitly out of scope (v1)

- SSE / WebSocket streaming to the client
- `GET …/active-completion-job` or `active_completion_job_id` on session GET
- Server-enforced poll rate limits
- Persisting partial assistant text on **`failed`**
- Frontend implementation in this repo

#### Implementation checklist (API v1)

- [x] `claudeStreamModel` in `bedrockClient.js` using `InvokeModelWithResponseStreamCommand`
- [x] Redis partial read/write helpers + TTL (`src/utils/novaCompletionPartial.js`)
- [x] Processor: stream → debounced partial writes → flush on end → existing persist path
- [x] `buildNovaCompletionPollPayload`: attach partial on `running` and `failed`
- [x] Unit tests (stream chunk parse; poll shape for `running` / `failed` / disabled flag)
- [x] Update implementation status table in this document

---

## Core Design Principles

- LLMs are **stateless compute engines** (no built-in memory)
- All memory is handled at the application layer
- Full auditability of all interactions is required (HIPAA compliance)
- Optimize for low latency during active sessions
- Separate:
  - Live session state (Redis)
  - Source of truth (Supabase/Postgres)
  - Reasoning engine (AWS Bedrock Claude)

---

## High-Level Architecture

```
User (Doctor)
   ↓
Frontend Chat UI (Sessions + Messages)
   ↓
API Gateway / Backend Service
   ↓
┌──────────────────────────────┐
│ Session Layer (Redis Cache)  │ ← hot memory
└──────────────────────────────┘
   ↓
LLM Orchestration Layer
(AWS Bedrock - Claude)
   ↓
┌──────────────────────────────┐
│ Supabase (Postgres)          │ ← source of truth
└──────────────────────────────┘
   ↓
Background Worker (Nova summarize)
- rolling summarization (~70% context threshold + sweep retries)
- run `npm run worker:nova-summarize` (separate process / systemd unit)
```

---

## Session Model (ChatGPT-style UX)

Each conversation is a **chat session**:

- `chat_id` = unique session identifier
- Doctor can:
  - create new chat
  - resume previous chats
  - switch between sessions

### Session Lifecycle

- Active session: stored in Redis
- Inactive session: persisted in Supabase only
- Expired session: Redis cleared after TTL

---

## Redis (Hot Session Cache)

Redis stores real-time working memory.

### Key format (implemented)

```
nova:chat:{user_id}:{chat_id}
```

Scoped by Supabase `user_id` so a `chat_id` UUID alone cannot access another user’s cache.

### Authentication (implemented)

- **ElastiCache / TLS URLs without a password segment:** the app can append `REDIS_AUTH_TOKEN` at connect time when the URL does not already include credentials.
- **Local passwordless Redis:** loopback hosts skip sending AUTH so developers can keep a production token in `.env.local` while using `redis://127.0.0.1:6379` without ACL/password.

### Stored structure

```json
{
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "summary": "Compressed clinical + context summary",
  "last_active": 1710000000,
  "token_estimate": 3200,
  "summary_covered_message_count": 4,
  "summarize_pending": false,
  "title": "New Chat"
}
```

### Responsibilities

- Store last N conversation turns
- Maintain rolling summary
- Enable ultra-fast session reconstruction
- Serve as primary runtime memory

### TTL

- 15–60 minutes inactivity timeout

---

## Supabase (System of Record)

Supabase is the **immutable audit log**.

### Responsibilities

- Store full chat history
- Store token usage logs
- Store session metadata
- Enable recovery of Redis state

### Tables (implemented)

#### chat_sessions

- `id` (uuid, same as API `chat_id`)
- `user_id` (auth user; session owner)
- `organization_id` (billing / tenancy; personal org ensured on create)
- `encrypted_summary`, `summary_iv` (AES via user master key; empty summary stored as null ciphertext)
- `token_estimate` (runtime hint, mirrored in Redis)
- `total_tokens` (running sum; incremented when token-usage rows are recorded)
- `created_at`, `updated_at`, `last_active_at`
- `title` — plaintext display label, default **`'New Chat'`**

#### chat_messages

- `id` (uuid)
- `chat_id`, `user_id` (owner; per-seat attribution)
- `role` (`user` | `assistant` | `system`)
- `encrypted_content`, `content_iv`
- `sort_order` (conversation order)
- `created_at`

#### chat_token_usage

- `id` (uuid)
- `chat_id`, `user_id`, `organization_id`
- `input_tokens`, `output_tokens`, `total_tokens` (constraint: sum of in + out)
- `cost_usd`, `model` (optional)
- `created_at`

API: `POST /api/nova/chat-sessions/:chatId/token-usage` with a Bearer JWT (RLS-enforced).

---

## LLM Layer (AWS Bedrock - Claude)

### Key property

- Fully stateless
- No persistent memory

### Input context construction

Each Nova completion **job** (async Bedrock invoke) builds the prompt from:

1. System instructions  
2. Rolling **summary** (plaintext from Redis / `encrypted_summary` when hydrated)  
3. **Verbatim dialog tail** — for the model only: `messages` from index `summary_covered_message_count` onward (older turns are not duplicated in the message list; they are assumed folded into the summary), then capped by `NOVA_BEDROCK_MAX_PRIOR_MESSAGES`. The **last** message in that tail is the pending **user** line persisted at job accept; it is passed once as `userMessage` to Bedrock (not duplicated in the prior tail). **Persistence:** Redis / Supabase still store the **complete** `messages` array; each turn appends user then assistant. Only the Bedrock payload uses the tail slice.

---

## Memory Strategy

### 1. Sliding Window

- Keep last 10–30 message turns

### 2. Summary Memory

- Periodically compress older conversation into structured summary

### 3. Context Injection

```
FINAL_PROMPT =
  SYSTEM +
  SUMMARY +
  RECENT_MESSAGES +
  USER_INPUT
```

---

## Summarization strategy

Chat messages are persisted to Supabase on create / PATCH; each completion **accept** appends the user line, and the async processor appends the assistant when Bedrock returns. The **summarization worker** performs **LLM-based rolling summaries** only (not write-behind for messages).

### Triggers

1. **Primary — threshold after completion** — After a successful completion **job** (assistant persisted), if estimated prompt/context use is **~≥70%** of the active model’s context window, enqueue or schedule a summarization run for that session.
2. **Secondary — cron / sweep** — Periodic job retries **failed** summarizations, and finds sessions **over threshold** that never got a fresh summary (missed enqueue, restart, throttling). This complements the event trigger; it does not replace it.

### Token signal (Bedrock → Redis / DB)

- **`claudeInvokeModel`** maps Bedrock’s `responseBody.usage` to `input_tokens` / `output_tokens` when present; **`usage` may be `null`** if the provider omits it — code must handle that and avoid false triggers.
- **Thresholding:** compare **prompt size for that turn** (typically guided by latest `input_tokens`, optionally combined with a running estimate) to the **model’s context limit** for the preset in use (`haiku` / `sonnet` / `opus`).
- **Live state:** Redis (and mirrored fields such as `token_estimate` on `chat_sessions`) is appropriate for fast checks; Supabase remains audit/source of truth for history and token-usage rows.

*Integration tests expect numeric `usage` on healthy Bedrock completions; production should still tolerate `null`.*

### What gets summarized vs what the chat model sees

| Step | Content |
|------|--------|
| **Summarizer model input** | All messages **since the last summary checkpoint** only. **Do not** include the previous summary text in the blob being summarized (avoid “summary of summaries”). Apply a **lenient cap** on summarizer input size so the job stays bounded. |
| **Normal completion prompt** | **Current rolling summary** + **verbatim messages since that summary** (plus system / user turn as today). |

### Persistence

- Worker writes the new summary to **Supabase** (`encrypted_summary`, IV, metadata as today), then **refreshes Redis** so the hot cache matches the source of truth.

### Failure and UX

- **Fail open** — If summarization fails, users **keep chatting** using the **previous** summary and full recent history (higher token use until they start a new chat or a later summarize succeeds). No hard block of the main assistant reply for v1.
- **In-flight dedupe** — Avoid starting a **second** summarization for the same session while one is already running (implementation detail; not the same as a time-based rate cap).

### Concurrency (multi-tab / multi-device)

- **One non-terminal completion job per `chat_id`:** a partial unique index on `nova_chat_completion_jobs` ensures at most one row in `pending` or `running` per chat. A second `POST …/completions` with a **different** `client_message_id` while one is active returns **409 Conflict** (`NOVA_COMPLETION_IN_FLIGHT`). Retrying the **same** `client_message_id` returns the same **202** payload (`id`, `status`) as the active job.

### Rolling summary — structured JSON (planned)

Today the persisted rolling summary is **plain text** in `encrypted_summary`. The target is to store **validated JSON** (same encryption path, or a dedicated column) so the UI and prompts can rely on stable slots. Nova is an **assistant for clinicians** but **not** limited to clinical threads: fields are intentionally **generic**, with a **slight bias** toward capturing safety-relevant constraints (allergies, avoidances) when they appear.

#### Schema (`schema_version` 1)

| Field | Type | Purpose |
|-------|------|--------|
| `schema_version` | integer | **Required.** Start at `1`; bump when fields are added/renamed. |
| `facts` | string[] | Short bullet strings: what was **stated or established** in the thread (clinical or non-clinical). |
| `decisions` | string[] | Conclusions, agreements, or **committed plans** (“we will…”, “chosen option…”). |
| `constraints` | string[] | Hard or soft **limits**: allergies, drugs/foods to avoid, policy constraints, “do not …”, user preferences that must be respected. |
| `follow_ups` | string[] | **Next steps**, reminders, deadlines, or action items (for the user or the assistant). |
| `open_questions` | string[] | **Unresolved** items that a future turn might answer. |

**Rules for the summarizer model**

- Output **only** JSON matching this shape (no markdown fence, no commentary).
- Use **empty arrays** when a section has nothing to say (do not omit keys).
- Each array entry is one **concise** line (a single bullet); avoid long paragraphs inside strings.
- For **non-medical** chats, `facts` / `decisions` / `follow_ups` carry the weight; `constraints` may capture preferences (“keep answers short”) or contractual/legal cautions when relevant.
- **Do not invent** clinical facts; if unsure, put uncertainty in `open_questions`.

**Example (mixed generic + clinical)**

```json
{
  "schema_version": 1,
  "facts": [
    "User is comparing two payer contract clauses on telehealth reimbursement.",
    "User reports penicillin allergy documented in chart.",
    "Blood pressure home readings in the 150s on current regimen."
  ],
  "decisions": [
    "Agreed to prioritize clause 4(b) for legal review before signing.",
    "User will log AM BP for one week before next medication change."
  ],
  "constraints": [
    "Avoid beta-lactam antibiotics (penicillin allergy).",
    "User wants concise bullet replies unless they ask for depth."
  ],
  "follow_ups": [
    "Send draft redlines to counsel by Friday.",
    "Recheck BP log at follow-up visit."
  ],
  "open_questions": [
    "Whether payer allows audio-only telehealth in NJ for established patients.",
    "Whether lightheadedness is orthostatic vs medication-related."
  ]
}
```

**Implementation notes (when shipped)**

- Validate with JSON Schema or Zod after model output; on failure, **fail open**: keep previous summary text and log (same as today).
- **Rendering for Bedrock** can remain a compact plaintext projection of these arrays (sorted sections) until the chat stack consumes JSON directly.
- A single-field JSON wrapper (e.g. only `text`) is **not** worth it; stay on plain text until this multi-field schema ships.

---

## Token Usage Tracking

### Per completion (Bedrock)

The Messages-style InvokeModel response includes **`usage`** with at least `input_tokens` and `output_tokens` when the provider supplies it; the API maps these in `claudeInvokeModel` and may receive **`usage: null`**. Use these fields for metering and for **context-threshold** logic (compare to the deployed model’s context window).

### Stored per session and per message

- **input_tokens / output_tokens / total_tokens** — persisted to `chat_token_usage` and session aggregates when usage is available
- **cost estimate** — optional / future

### Storage

- Primary: Supabase (audit + billing)
- Redis / `token_estimate`: live hints and threshold checks

---

## Data Flow (Per Message)

### 1. User sends message

If another completion job is already **pending** or **running** for this `chat_id`, respond with **409 Conflict** before enqueueing (unless the request is an idempotent replay of the same `client_message_id` as the active job).

### 2. Backend loads context

- Redis summary
- last N messages

### 3. Build prompt

### 4. Call AWS Bedrock (Claude)

Async processor (`novaChatCompletionProcessor`), not the `POST` request thread.

### 5. Save response

- Redis (refreshed after successful Postgres writes on Nova create / PATCH and after each completion **job** finishes)
- Supabase (user line on job **accept**; assistant + token usage when the processor completes)

### 6. Token logging

- Supabase row in `chat_token_usage` (+ bump `chat_sessions.total_tokens`) when Bedrock returns `usage` on the completion job, or via `POST …/token-usage` for client-reported usage

### 7. Summarization

- After step 6, if usage crosses the **~70% context** rule (and `usage` is present), the processor enqueues a Redis job and sets `summarize_pending` on the session. The **worker** (`worker:nova-summarize`) drains the queue; **sweep** re-queues `nova:summarize:due` periodically. Main chat path stays **fail open** if summarization fails.

---

## Failure Handling

### Redis failure

- Rebuild session from Supabase (decrypt and repopulate cache on GET)
- Regenerate summary (optional product behavior; not automatic in API today)

### Total Redis loss (flush, new cluster, prolonged outage)

**What lives only in Redis today:** hot session blobs (`nova:chat:{userId}:{chatId}`), the summarize **queue list** (`nova:summarize:queue`), and the **due set** (`nova:summarize:due`). The worker **sweep** re-pushes jobs from the due set to the list; if Redis is **empty**, sweep has **nothing** to recover.

**Without an outbox** (acceptable for Nova chat: no strict exactly-once, duplicate summarize jobs are tolerable):

1. **Baseline (already true):** **Messages** and the **last persisted** rolling summary load from Supabase; users can keep chatting. Context may be **large** until summarization runs again.
2. **Recommended when you want faster recovery (pick one or combine):**
   - **Durable flags on `chat_sessions`** — persist `summarize_pending` and `summary_covered_message_count` (today hydration resets some of this from Redis-only state). After Redis rebuild, a **reconciliation** step (cron or worker startup) reads rows with `summarize_pending = true` and **re-enqueues** `{ userId, chatId }` to Redis. Duplicate jobs are OK: the second run usually sees **no delta** after checkpointing.
   - **Lazy re-enqueue** — on first `GET` or `POST …/completions` after a cold cache, if a cheap heuristic says context is heavy (e.g. `token_estimate` or message count) and summary is stale vs messages, enqueue **one** summarize job (rate-limit per chat).
   - **Minimal** — do nothing extra: the **next** completion that crosses the **~70% context** threshold enqueues summarize again; simplest, but some sessions may stay “fat” until then.

**Dupes:** Two summarize passes for the same chat close together are **wasted tokens** but typically **harmless** if merge + checkpoint are correct; no need for a transactional outbox for this product tier.

### Supabase failure

- Buffer in Redis temporarily
- Retry async persistence

### LLM failure

- Retry request
- Maintain idempotent message handling

---

## Security & HIPAA Considerations

### Redis (AWS ElastiCache)

- Enable encryption at rest
- Enable TLS in transit
- Deploy inside VPC private subnet

### Supabase

- Row Level Security (RLS)
- Encrypted storage at rest (provider)
- Chat message bodies and session summary: **application-layer encryption** with the user’s master key (same model as clinical notes); Redis holds decrypted payloads only for the active hot cache.

### General

- BAA-covered AWS services
- No public exposure of Redis

---

## Scalability (Current vs Future)

### Current assumptions

- 20–50 doctors
- ~1 active session per doctor
- low concurrency

### Design allows future scaling to

- multi-session per user
- distributed Redis cluster
- background queue workers
- vector retrieval layer (optional)

---

## Key Design Insight

This system is **not** “a chatbot with memory.” It is **a stateful application that uses a stateless LLM as a reasoning engine**.

Memory is entirely application-controlled for:

- compliance
- auditability
- cost control
- clinical safety

---

## Future Enhancements

- **Async Nova completions** — **Shipped:** job table + **202** + poll under `/api/nova/chat-sessions/…`; optional later: dedicated queue workers.
- **Completion partial streaming (poll)** — **Done:** [pseudo-stream via poll](#completion-partial-streaming) (`assistant_partial` while `running`); **not** client SSE/WebSocket. Disable with `NOVA_COMPLETION_PARTIAL=0`.
- **Chat session title** — **Shipped:** `session.title`, Haiku after first completion, plaintext DB column (`NOVA_TITLE_BEDROCK_MODEL_ID` optional override).
- Vector database for long-term semantic retrieval
- Multi-modal inputs (audio, EMR integration)
- Insurance contract reasoning module
- Encounter-based structured SOAP extraction
- Per-doctor personalization layer

---

## Summary

The architecture combines:

- Redis → real-time session memory
- Supabase → audit + persistence layer
- Bedrock Claude → reasoning engine

This separation ensures:

- HIPAA compliance
- low latency chat experience
- scalable cost model
- full traceability

---

## Implementation open questions

These are not blockers for the architecture; they refine product and compliance boundaries before build-out.

1. **BAA coverage** — Confirm BAAs (or equivalent) for every subprocessors in the path: AWS (Bedrock, ElastiCache), Supabase (HIPAA add-on if required), and any logging/observability that might see message bodies.
2. **PHI in prompts** — Define policy for when chat content is clinical PHI vs internal ops (e.g. billing templates); whether system prompts and summaries are allowed to echo identifiers, and whether de-identification is required for any analytics.
3. **Identity and tenancy** — **Partially settled in code:** `user_id` is the Supabase auth user; sessions are private to that user (RLS). `organization_id` is set from the user’s personal org for billing alignment; clinic-wide pools vs personal org for Nova may still be a product choice.
4. **Idempotency and ordering** — **Largely settled in code:** `client_message_id` (UUID) on `POST …/completions` for idempotent replay (`complete` → **200**) and retry-after-`failed` without double user append; **409** when another job is `pending`/`running` for the same `chat_id`. Further product choices: server-assigned ids only, or edit-and-resend semantics.
5. **Integration with scribe/encounters** — Whether Nova sessions can attach to `patient_encounter` (or similar) for audit context, or remain strictly standalone general chat.
6. **Summary regeneration** — After Redis loss, whether to re-summarize from full history in one shot, cap history length, or replay through a dedicated “rebuild” job with rate limits. **Rolling summarization** for active chats is covered in [Summarization strategy](#summarization-strategy).
