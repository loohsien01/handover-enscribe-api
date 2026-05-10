# Nova AI — Medical AI Assistant (HIPAA-Safe Chat + Scribe Platform)

## Overview

This document defines the architecture for a HIPAA-compliant AI assistant built on AWS Bedrock (Claude) designed for clinicians. The system functions as a secure, general-purpose “ChatGPT for healthcare professionals,” supporting both clinical and non-clinical workflows (for example documentation, insurance contracts, billing, and general medical reasoning).

The system is built around a **stateless LLM with stateful application memory layers**.

### Implementation status (this repository)

| Area | Status |
|------|--------|
| Redis hot session cache | **Done** — keys `nova:chat:{userId}:{chatId}`, TTL `NOVA_REDIS_SESSION_TTL_SEC`; optional `REDIS_URL` (Nova returns 503 if cache unavailable). |
| Redis AUTH (ElastiCache vs local dev) | **Done** — optional `REDIS_AUTH_TOKEN` merged into the connection URL when `REDIS_URL` has no embedded password (typical ElastiCache). For passwordless local Redis (`127.0.0.1`, `localhost`, `::1`), AUTH is not sent so a prod token in `.env.local` does not break local runs. |
| Supabase session + message persistence | **Done** — tables `chat_sessions`, `chat_messages`; summary and message bodies encrypted with the user’s wrapped master key (same pattern as notes); RLS + `organization_id` (personal org via `ensurePersonalOrganization`). |
| Reload Redis from Supabase | **Done** — GET misses cache: decrypt from Postgres, repopulate Redis. |
| Token usage rows + session aggregate | **Done** — `chat_token_usage` + `POST .../token-usage`; `total_tokens` on `chat_sessions` incremented per event (per-seat `user_id` for metering). |
| AWS Bedrock orchestration (chat turn) | **Done** — `POST /api/nova/chat-sessions/:chatId/completions` with presets `haiku` \| `sonnet` \| `opus` (`getNovaChatCompletionRequestBody` + `claudeInvokeModel`); appends user + assistant messages, records `chat_token_usage` when Bedrock returns `usage`, refreshes Redis. |
| Automated tests (completions) | **Done** — `tests/nova-chat-sessions-completions.test.js` (`npm run test:nova-chat-sessions-completions`); harness supports `timeoutMs` / `AbortSignal.timeout`; included in `tests/runAll.js` (suite 2.15). Unit: `tests/novaBedrockChat.unit.test.js`, `tests/novaSummarize.unit.test.js`. **Queue E2E** (opt-in, `.e2e.test.js`, not in runAll): `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` in `.env.local` (dev/staging only; server `NODE_ENV=production` ignores it), restart Fastify, then `npm run test:nova-summarize-queue-e2e` — spawns worker subprocess, two completion rounds after rolling summarize, asserts full persisted transcript length, `summary_covered_message_count`, and that the next Bedrock turn uses a single-message dialog (no duplicated pre-checkpoint pairs); writes `test-results/nova-summarize-queue-e2e.json`. |
| Deploy secrets (Redis on EC2) | **Done** — GitHub Actions deploy writes `REDIS_URL` (required) and optional `REDIS_AUTH_TOKEN` into EC2 `.env.local`. |
| Chat persistence path | **Done (sync)** — Nova create / PATCH and `POST .../completions` write through to Supabase; Redis refreshed after durable writes. **Deferred:** Postgres outbox / write-behind (not needed until latency or scale justify it). |
| Background worker (rolling summarization) | **Done** — `npm run worker:nova-summarize` (`src/workers/novaSummarizeWorker.js`): drains Redis list `nova:summarize:queue`, **sweep** re-queues members of `nova:summarize:due` on an interval. API enqueues after `POST .../completions` when Bedrock `usage.input_tokens` ≥ `NOVA_SUMMARIZE_CONTEXT_THRESHOLD` (default `0.7`) of the preset context limit (non-production tests may use `NOVA_SUMMARIZE_TEST_FORCE_ENQUEUE=1` to enqueue without hitting threshold). Worker uses `SUPABASE_SERVICE_ROLE_KEY` and `getOrCreateUserMasterKey` to decrypt/load and encrypt/persist session summary + messages. |
| Per-session completion lock | **Done** — Redis `nova:completion-lock:{userId}:{chatId}` (NX + TTL); concurrent `POST .../completions` → **409** `NOVA_COMPLETION_IN_FLIGHT`. Env: `NOVA_COMPLETION_LOCK_TTL_SEC` (default 300). |
| Full transcript vs Bedrock message list | **Done** — After each completion, `session.messages` is the **full** ordered transcript (append user + assistant). The Bedrock request uses **`novaPriorDialogMessagesForBedrock`**: `messages.slice(summary_covered_message_count)` only, so turns already folded into the rolling summary are not duplicated in the model’s `messages` array. |
| Redis failure → regenerate summary | **Partial** — history reloads from Supabase; rolling summary is whatever was last persisted. **Rolling LLM summarize** runs via worker when enqueued; not automatically replayed on cold Redis rebuild unless a job remains in `nova:summarize:due`. |

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

Each `POST .../completions` request includes:

1. System instructions  
2. Rolling **summary** (plaintext from Redis / `encrypted_summary` when hydrated)  
3. **Verbatim dialog tail** — for the model only: `messages` from index `summary_covered_message_count` onward (older turns are not duplicated in the message list; they are assumed folded into the summary), then capped by `NOVA_BEDROCK_MAX_PRIOR_MESSAGES`. **Persistence:** Redis / Supabase still store the **complete** `messages` array; each turn appends to it. Only the Bedrock payload uses the tail slice.  
4. New user input for this turn

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

Chat messages stay **synchronously** persisted to Supabase on create / PATCH / completions. The **summarization worker** performs **LLM-based rolling summaries** only (not write-behind for messages).

### Triggers

1. **Primary — threshold after completion** — After a successful `POST .../completions`, if estimated prompt/context use is **~≥70%** of the active model’s context window, enqueue or schedule a summarization run for that session.
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

- **One in-flight completion per `chat_id`:** if a `POST .../completions` is already running for that session, additional requests return **409 Conflict** (`NOVA_COMPLETION_IN_FLIGHT`) so message order does not interleave across tabs or devices. Implemented with Redis NX + TTL.

### Output format (structured) — target

```json
{
  "chief_complaint": "",
  "timeline": "",
  "symptoms": [],
  "medications": [],
  "clinical_assessment": [],
  "open_questions": []
}
```

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

If another completion is already in flight for this `chat_id`, respond with **409 Conflict** before starting Bedrock.

### 2. Backend loads context

- Redis summary
- last N messages

### 3. Build prompt

### 4. Call AWS Bedrock (Claude)

### 5. Save response

- Redis (refreshed after successful Postgres writes on Nova create / PATCH and after `POST .../completions`)
- Supabase (synchronous persist on create / PATCH and on completions: new messages + token usage when available)

### 6. Token logging

- Supabase row in `chat_token_usage` (+ bump `chat_sessions.total_tokens`) via `POST .../completions` when Bedrock returns usage, or via `POST .../token-usage` for client-reported usage

### 7. Summarization

- After step 6, if usage crosses the **~70% context** rule (and `usage` is present), API enqueues a Redis job and sets `summarize_pending` on the session. The **worker** (`worker:nova-summarize`) drains the queue; **sweep** re-queues `nova:summarize:due` periodically. Main chat path stays **fail open** if summarization fails.

---

## Failure Handling

### Redis failure

- Rebuild session from Supabase (decrypt and repopulate cache on GET)
- Regenerate summary (optional product behavior; not automatic in API today)

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
4. **Idempotency and ordering** — **Partially directed:** enforce **single in-flight completion per `chat_id`** with **409** to prevent interleaved multi-device sends. Remaining: client message IDs vs server-assigned for duplicate POST retries.
5. **Integration with scribe/encounters** — Whether Nova sessions can attach to `patient_encounter` (or similar) for audit context, or remain strictly standalone general chat.
6. **Summary regeneration** — After Redis loss, whether to re-summarize from full history in one shot, cap history length, or replay through a dedicated “rebuild” job with rate limits. **Rolling summarization** for active chats is covered in [Summarization strategy](#summarization-strategy).
