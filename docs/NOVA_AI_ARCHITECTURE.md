# Nova AI — Medical AI Assistant (HIPAA-Safe Chat + Scribe Platform)

## Overview

This document defines the architecture for a HIPAA-compliant AI assistant built on AWS Bedrock (Claude) designed for clinicians. The system functions as a secure, general-purpose “ChatGPT for healthcare professionals,” supporting both clinical and non-clinical workflows (for example documentation, insurance contracts, billing, and general medical reasoning).

The system is built around a **stateless LLM with stateful application memory layers**.

### Implementation status (this repository)

| Area | Status |
|------|--------|
| Redis hot session cache | **Done** — keys `nova:chat:{userId}:{chatId}`, TTL `NOVA_REDIS_SESSION_TTL_SEC`; optional `REDIS_URL` (Nova returns 503 if cache unavailable). |
| Supabase session + message persistence | **Done** — tables `chat_sessions`, `chat_messages`; summary and message bodies encrypted with the user’s wrapped master key (same pattern as notes); RLS + `organization_id` (personal org via `ensurePersonalOrganization`). |
| Reload Redis from Supabase | **Done** — GET misses cache: decrypt from Postgres, repopulate Redis. |
| Token usage rows + session aggregate | **Done** — `chat_token_usage` + `POST .../token-usage`; `total_tokens` on `chat_sessions` incremented per event (per-seat `user_id` for metering). |
| AWS Bedrock orchestration (chat turn) | **Not yet** — wiring TBD; `claudeRequestBody` and related helpers exist for other flows. |
| Background worker (async summarization, batch token sync) | **Not yet** — persistence is synchronous on Nova PATCH today; no outbox. |
| Redis failure → regenerate summary | **Partial** — history reloads from Supabase; rolling summary is whatever was last persisted (no automatic LLM re-summarize on rebuild). |

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
Background Worker (planned)
- async summarization
- optional batch / retry paths
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

### Stored structure

```json
{
  "messages": [
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": "..."}
  ],
  "summary": "Compressed clinical + context summary",
  "last_active": 1710000000,
  "token_estimate": 3200
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

Each request includes:

1. System instructions
2. Redis summary (compressed memory)
3. Last N messages (verbatim)
4. New user input

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

## Summarization Strategy

### Trigger conditions

- Every 10–20 conversation turns **or**
- When token usage exceeds ~60–70% model context window

### Output format (structured)

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

### Stored per session and per message

Captured from AWS Bedrock response:

- input_tokens
- output_tokens
- total_tokens
- cost estimate

### Storage

- Primary: Supabase (audit + billing)
- Optional: Redis (live UI display)

---

## Data Flow (Per Message)

### 1. User sends message

### 2. Backend loads context

- Redis summary
- last N messages

### 3. Build prompt

### 4. Call AWS Bedrock (Claude)

### 5. Save response

- Redis (immediate update after successful Postgres write for Nova routes today)
- Supabase (synchronous persist on create / PATCH for `chat_sessions` + `chat_messages`)

### 6. Token logging

- Supabase row in `chat_token_usage` (+ bump `chat_sessions.total_tokens`) via dedicated API; Bedrock response wiring when the chat LLM route lands

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
4. **Idempotency and ordering** — Client-generated message IDs vs server-assigned; how duplicate POSTs and out-of-order async writes to Supabase are detected and reconciled.
5. **Integration with scribe/encounters** — Whether Nova sessions can attach to `patient_encounter` (or similar) for audit context, or remain strictly standalone general chat.
6. **Summary regeneration** — After Redis loss, whether to re-summarize from full history in one shot, cap history length, or replay through a dedicated “rebuild” job with rate limits.
