# Nova AI — Medical AI Assistant (HIPAA-Safe Chat + Scribe Platform)

## Nova HTTP API (frontend integration)

Base path: `/api/nova/…` on the Fastify API host (e.g. local `http://localhost:3001`, production `https://api.enscribe.online`).

**Auth:** every route requires a valid **Bearer JWT** (same Supabase session / `Authorization: Bearer <access_token>` pattern as the rest of the API). Unauthenticated requests are rejected by the server before Nova logic runs.

**Listing:** `GET /api/nova/chat-sessions` returns paginated **metadata** from Supabase (`chatId`, org, token counters, timestamps). It does **not** require Redis. Load full transcript + summary with `GET …/:chatId` (Redis first, then hydrate).

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/nova/chat-sessions` | List the signed-in user’s sessions (query: `limit`, `offset`, `sortBy`, `order`; see below). |
| `POST` | `/api/nova/chat-sessions` | Create a new chat; returns `chatId` + initial `session`. |
| `GET` | `/api/nova/chat-sessions/:chatId` | Load session (Redis first, else hydrate from Supabase). |
| `PATCH` | `/api/nova/chat-sessions/:chatId` | Update `summary`, `token_estimate`, `messages`, or `appendMessages`. |
| `POST` | `/api/nova/chat-sessions/:chatId/completions` | Enqueue one user turn: persists **user** message immediately; returns **202** + job id (or **200** idempotent replay if that `client_message_id` already completed). Bedrock runs asynchronously in-process (`setImmediate`, same pattern as `POST /api/jobs/prompt-llm/generate-note`). |
| `GET` | `/api/nova/chat-sessions/:chatId/completion-jobs/:jobId` | Poll completion job until `complete` or `failed` (then includes `assistant`, `usage`, `session` when complete). |
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

**Behavior:** `POST` returns quickly after persisting the **user** line (first attempt) and enqueueing work, or after accepting a **retry** for the same `client_message_id` when a prior job **`failed`** (no second user row — same text must match the pending user line at end of session). Poll **`GET …/completion-jobs/:jobId`** until `status` is `complete` or `failed`. The **user** message **stays** in the transcript when a job fails (no server-side delete). At most **one** non-terminal job per `chatId` (Postgres partial unique index); a second turn with a different `client_message_id` while another job is active yields **409** `NOVA_COMPLETION_IN_FLIGHT`. Bedrock or persist failures set the job to `status: failed`; see poll response below.

### `GET …/completion-jobs/:jobId`

**Success (200):** while running:

```json
{ "id": "<job-uuid>", "status": "pending", "chat_id": "<chatId>" }
```

(or `"status": "running"` after the worker claims the job)

When **`complete`:**

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

When **`failed`:**

```json
{
  "id": "<job-uuid>",
  "status": "failed",
  "chat_id": "<chatId>",
  "code": "NOVA_BEDROCK_FAILED",
  "error": "…"
}
```

**404:** `NOVA_COMPLETION_JOB_NOT_FOUND` — wrong `jobId`, or job does not belong to this `:chatId`.

### `PATCH …/:chatId`

Body must include **at least one** of: `summary`, `token_estimate`, `messages`, `appendMessages`.

- **`messages`** — replace the full transcript (and the server resets `summary_covered_message_count` to `0`).
- **`appendMessages`** — append-only array of new `{ role, content }`; do **not** send both `messages` and `appendMessages` in the same request.

Caps (from schema): e.g. up to **500** messages on full replace, **50** on append; content length limits per field apply — see `src/fastify/schemas/novaChatRequests.js` for exact numbers.

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

All successful bodies are JSON. `<Session>` means the [session object](#session-object-api-shape) (`chat_id`, `messages`, `summary`, …).

| Route | Success HTTP | Response body |
|--------|----------------|----------------|
| `GET /api/nova/chat-sessions` | **200** | `{ "sessions": [ { "chatId", "organizationId", "token_estimate", "total_tokens", "created_at", "updated_at", "last_active_at" } ], "total": <number>, "limit": <number>, "offset": <number> }` — metadata only; no transcript. |
| `POST /api/nova/chat-sessions` | **201** | `{ "chatId": "<uuid>", "session": <Session> }` — **no request body** is required (empty body or `{}` is fine). |
| `GET /api/nova/chat-sessions/:chatId` | **200** | `{ "session": <Session> }` |
| `PATCH /api/nova/chat-sessions/:chatId` | **200** | `{ "session": <Session> }` |
| `POST /api/nova/chat-sessions/:chatId/completions` | **202** | `{ "id": "<job-uuid>", "status": "pending" \| "running", "chat_id": "<chatId>" }` — also **200** when replaying a finished turn with the same `client_message_id` (see POST section). |
| `GET /api/nova/chat-sessions/:chatId/completion-jobs/:jobId` | **200** | `{ "id", "status", "chat_id" }` — when `status` is `complete`, includes `assistant`, `usage` (\| null), `session`; when `failed`, includes `code`, `error`. |
| `POST /api/nova/chat-sessions/:chatId/token-usage` | **201** | `{ "ok": true, "total_tokens": <number> }` |

**Headers:** send **`Authorization: Bearer <access_token>`** on every call. For routes with a JSON body, use **`Content-Type: application/json`**.

**Validation (400):** many schema failures return `{ "error": { "name": "ZodError", "message": "<string — JSON-encoded Zod `issues` array>" } }`. Production UIs often show a generic invalid-request message; parse `error.message` when you need field-level detail in dev or support tooling.

### Suggested chat UI flow (minimal)

1. **New thread:** `POST /api/nova/chat-sessions` → persist `chatId` (URL query, client storage, or global state). Render `session.messages` (starts empty).
2. **Open existing:** `GET /api/nova/chat-sessions/:chatId`; on **404** (`NOVA_SESSION_NOT_FOUND`), treat as unknown/expired id and start a new session or show an error.
3. **Send a turn:** `POST …/completions` with `{ "model": "haiku" \| "sonnet" \| "opus", "message": "<non-empty string>", "client_message_id": "<uuid>" }` → **202** + `id` (job id). Poll **`GET …/completion-jobs/:id`** until `status` is `complete` or `failed`. The **user** message appears in `session.messages` as soon as **202** is returned (refresh `GET …/:chatId` if needed). Use **FE loading state** for the assistant reply (no placeholder row in the API). **Retry after `failed`:** same `client_message_id` and **same** `message` → **202** for a new job **without** duplicating the user row; if `message` does not match the pending user line, the API returns **400** (`NOVA_CLIENT_MESSAGE_MISMATCH` or `NOVA_COMPLETION_RETRY_INVALID_STATE`).
4. **After a successful job:** drive the transcript from **`response.session.messages`** on the terminal poll (or **200** idempotent replay). Optionally show **`response.usage`**; tolerate **`usage: null`**.
5. **Rolling summary in the UI:** if you surface `summary` or “memory,” refresh via **`GET …/:chatId`** while `summarize_pending` is true (poll lightly or on focus) — the worker updates Redis/DB in the background. The next completion’s `session` is also fine without polling.
6. **Session list / sidebar:** `GET /api/nova/chat-sessions` for **metadata** (ids, activity, token totals). For each row, call `GET …/:chatId` when the user opens a thread (or prefetch sparingly).
7. **`PATCH`:** most UIs only need create + GET + completions. Use **`PATCH`** when the product edits the transcript, summary, or token hints client-side (see the PATCH section above).

Reference tests for behavior (not a spec substitute): `tests/nova-chat-sessions-completions.test.js`.

### UX tips for the client

- After **201** create, keep `chatId` and use **`session.messages`** for the thread.
- On **409**, another turn is already queued or running for this chat; poll the active job or wait before sending a **different** `client_message_id`.
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
| Automated tests (completions) | **Done** — `tests/nova-chat-sessions-completions.test.js` (`npm run test:nova-chat-sessions-completions`); harness supports `timeoutMs` / `AbortSignal.timeout`; included in `tests/runAll.js` (suite 2.15). Unit: `tests/novaBedrockChat.unit.test.js`, `tests/novaSummarize.unit.test.js`. **Queue E2E** (opt-in, `.e2e.test.js`, not in runAll): `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` in `.env.local` (dev/staging only; server `NODE_ENV=production` ignores it), restart Fastify, then `npm run test:nova-summarize-queue-e2e` — spawns worker subprocess, two completion rounds after rolling summarize, asserts full persisted transcript length, `summary_covered_message_count`, and that the next Bedrock turn uses a single-message dialog (no duplicated pre-checkpoint pairs); writes `test-results/nova-summarize-queue-e2e.json`. |
| Deploy secrets (Redis on EC2) | **Done** — GitHub Actions deploy writes `REDIS_URL` (required) and optional `REDIS_AUTH_TOKEN` into EC2 `.env.local`. |
| Chat persistence path | **Done** — Nova create / PATCH persist synchronously; each completion **accept** appends the user message to Postgres + Redis; the async processor appends the assistant when Bedrock succeeds. **Deferred:** Postgres outbox / write-behind — only if synchronous writes become a bottleneck; there is **no** separate background worker process for chat completions today (in-process continuation only). |
| Background worker (rolling summarization) | **Done** — `npm run worker:nova-summarize` (`src/workers/novaSummarizeWorker.js`): drains Redis list `nova:summarize:queue`, **sweep** re-queues members of `nova:summarize:due` on an interval. API enqueues after a completion job **finishes** when Bedrock `usage.input_tokens` ≥ `NOVA_SUMMARIZE_CONTEXT_THRESHOLD` (default `0.7`) of the preset context limit (non-production tests may use `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` to enqueue without hitting threshold). Worker uses `SUPABASE_SERVICE_ROLE_KEY` and `getOrCreateUserMasterKey` to decrypt/load and encrypt/persist session summary + messages. |
| Per-chat active completion guard | **Done** — Postgres partial unique index on `nova_chat_completion_jobs(chat_id)` where `status` ∈ (`pending`,`running`); second **different** turn → **409** `NOVA_COMPLETION_IN_FLIGHT`. Same `client_message_id` while in-flight → same **202** job id. |
| Chat session display title | **Planned** — human-readable **title** per thread for session lists (default **"New Chat"** at create; optional later **AI-generated** title from early user/assistant text). Requires `chat_sessions` (or metadata) column + API list/create/PATCH exposure; not implemented in this repo yet. |
| Full transcript vs Bedrock message list | **Done** — After each completion, `session.messages` is the **full** ordered transcript (append user + assistant). The Bedrock request uses **`novaPriorDialogMessagesForBedrock`**: `messages.slice(summary_covered_message_count)` only, so turns already folded into the rolling summary are not duplicated in the model’s `messages` array. |
| Redis failure → regenerate summary | **Partial** — history reloads from Supabase; rolling summary is whatever was last persisted. **Rolling LLM summarize** runs via worker when enqueued; not automatically replayed on cold Redis rebuild unless a job remains in `nova:summarize:due`. |

#### What is still partial, deferred, or not implemented?

- **Deferred (by design):** **Postgres outbox / write-behind** — optional pattern if per-turn Supabase + Redis ever becomes too slow; not a “chat message worker”; normal turns stay on the API path above.
- **Partial:** **Redis cold / loss** — full message history reloads from Supabase; rolling `summary` is last-persisted only. The summarize worker does not auto-run unless a job remains queued (`nova:summarize:queue` / `nova:summarize:due`). **`summarize_pending` and `summary_covered_message_count` are not faithfully restored from Postgres on hydrate** — `loadNovaChatSessionFromSupabase` resets `summarize_pending` to `false` and derives checkpoint from summary vs messages only; durable flags + reconciliation described in [Total Redis loss](#total-redis-loss-flush-new-cluster-prolonged-outage) are recommendations, not fully implemented.
- **Planned (not shipped):** [Rolling summary — structured JSON](#rolling-summary--structured-json-planned) (`schema_version` 1: `facts`, `decisions`, `constraints`, `follow_ups`, `open_questions`). **Session list title** — per-chat **display name** (default **"New Chat"**; optional AI-generated from first messages for sidebar/history).
- **Doc vs code:** [Failure Handling](#failure-handling) “buffer in Redis / retry async persistence” on Supabase failure is an **architectural option**, not the current Nova completion path (today a failed persist surfaces as an error to the client after Bedrock may already have run).
- **Not implemented:** **Streaming tokens** (SSE/WebSocket) for assistant output; **vector / RAG**, multimodal, encounter-linked sessions — see [Future enhancements](#future-enhancements) and [Implementation open questions](#implementation-open-questions). (**Note:** `client_message_id` on `POST …/completions` is implemented for idempotent / retry semantics.)

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
  "summarize_pending": false
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

- **Async Nova completions** — **Shipped:** job table + **202** + poll under `/api/nova/chat-sessions/…`; optional later: dedicated queue workers, SSE push.
- **Chat session title** — Per-thread **display title** for lists: default **"New Chat"** at session creation; optional **AI-generated** label (e.g. after first successful completion) from a short model pass on a non-sensitive excerpt or structured summary. Needs DB column + list API field + optional PATCH.
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
