# Visit Prep — Architecture

AI-assisted visit preparation from past clinical notes. The **Visit prep page (FE)** assembles instructions and chart text into a Nova user message. A **visit prep completion** route runs the same Bedrock turn as normal Nova chat, then **must** persist a new row via shared **`createVisitPrep`** logic before the completion job is marked `complete`. Follow-up turns use ordinary **`POST …/completions`**.

**Related:** Nova chat in [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md); notes CRUD in [`NOTES_API.md`](./NOTES_API.md).

---

## Status

| Deliverable | Scope | Status |
|-------------|--------|--------|
| **Database** | `visit_preps` table, RLS, migration | 🔲 Not started |
| **API — CRUD** | `GET` / `POST` / `PATCH` / `DELETE` `/api/visit-preps` | 🔲 Not started |
| **API — Nova** | `POST …/visit-prep-completions` + poll (persist before `complete`) | 🔲 Not started |
| **Tests** | CRUD + visit prep completion + encryption round-trip | 🔲 Not started |
| **Templates** | `visit_prep_templates` table + CRUD | 🔲 Phase 2 |

**Backend deliverables (planned, v1):**

- Migration: `sql/migrations/YYYYMMDD_visit_preps.sql`
- RLS: `sql/policies/visit_preps_RLS.sql`
- Controller: `src/fastify/controllers/visitPrepsController.js` — exports **`createVisitPrep`** (and update/get/list/delete)
- Routes: `src/fastify/routes/visitPreps.js`
- Processor: `src/fastify/processors/novaVisitPrepCompletionProcessor.js` (imports **`createVisitPrep`**)
- Routes: extend `src/fastify/routes/novaChatSessions.js` with visit prep completion + poll envelope
- Tests: `tests/visit-preps.test.js`, `tests/nova-visit-prep-completions.test.js`

---

## Goals

1. Let clinicians select **two or more** past visit charts (enscribe notes), add free-form instructions (output format, sections, tone), and generate a visit prep document via Nova.
2. Persist each generated prep as an encrypted **`text`** string (same opaque-string model as [`notes.text`](./NOTES_API.md)), retained **indefinitely**.
3. Reuse Nova chat for **follow-up** refinement in the same session after turn 1 — no separate chat product or extra API phase.
4. Keep **`createVisitPrep`** as the single write path for new rows; the visit prep completion processor calls it; the public **`POST /api/visit-preps`** handler calls the same function (manual create / ops / future callers).

**Non-goals (v1):**

- No server-side assembly of the Nova user message (FE builds the message from fetched notes + instructions).
- No JSON schema enforced on model output — clinicians control format via natural-language instructions in the user message.
- No `patient_encounter_id` or encounter linkage on `visit_preps`.
- No `visit_prep_templates` table (phase 2).
- No FK from `source_note_ids` to `notes` (logical refs only; survives encounter purge).

---

## Terminology

| Term | Meaning |
|------|---------|
| **Normal Nova completion** | `POST /api/nova/chat-sessions/:chatId/completions` — existing async Bedrock turn; job `complete` when assistant message is persisted. |
| **Visit prep completion** | `POST /api/nova/chat-sessions/:chatId/visit-prep-completions` — same Bedrock + session persist as turn 1, **plus** blocking **`createVisitPrep`** before job → `complete`. Poll `complete` includes `visit_prep_id` and decrypted `text`. |
| **`createVisitPrep`** | Shared controller function implementing **`POST /api/visit-preps`** insert + encrypt; imported by the visit prep completion processor — not a Nova-specific wrapper name. |

Avoid **“one-shot”** in code/docs: the distinction is **visit prep completion** (turn 1 + mandatory persist), not a separate generation microservice.

---

## High-level flow

```
Visit prep page (FE)
  │
  ├─ GET /api/notes/:id (×2+)     decrypt past charts
  ├─ Build user message           instructions + pasted note text (no BE assembly)
  │
  ├─ POST /api/nova/chat-sessions
  │     optional { "title": "…" } — or default "New Chat"; AI title still runs after turn 1 if default
  │
  ├─ POST …/visit-prep-completions
  │     { model: "sonnet", message, client_message_id, source_note_ids?: bigint[] }
  │     → 202 + job id
  │
  ├─ Poll GET …/visit-prep-completion-jobs/:jobId
  │     until status complete (visit_prep row exists) or failed
  │
  └─ Later: POST …/completions (normal) in same chatId for follow-up questions
```

**Turn 1:** visit prep completion route only.  
**Turn 2+:** normal completions route (assistant reply stays in transcript; no automatic new `visit_preps` row unless FE calls **`POST /api/visit-preps`** or another visit prep completion).

---

## Visit prep completion vs normal completion

Both paths share Redis session, Bedrock invoke/stream, encrypted `chat_messages`, billing (`nova_response`), and optional partial streaming.

| Step | Normal `…/completions` | `…/visit-prep-completions` |
|------|------------------------|------------------------------|
| Persist user message | Yes | Yes |
| Bedrock | Yes | Yes |
| Persist assistant message | Yes | Yes |
| **`createVisitPrep`** | No | **Yes — must succeed before `complete`** |
| Job `complete` | After session persist | After session persist **and** visit prep persist |
| Terminal poll payload | `assistant`, `session`, `usage` | Above **+** `visit_prep_id`, `visit_prep: { id, text, … }` |
| Session title (Haiku) | Fire-and-forget after `complete` | Same — **does not block** job; runs in parallel after `complete` |

If **`createVisitPrep`** fails after Bedrock and chat persist succeed, mark job **`failed`** (`VISIT_PREP_PERSIST_FAILED`). User and assistant lines remain in the transcript (same rollback posture as `NOVA_SESSION_PERSIST_FAILED`).

Implementation: **`novaVisitPrepCompletionProcessor`** should share helpers with **`novaChatCompletionProcessor`** (load session, Bedrock, persist messages) and call **`createVisitPrep`** immediately before **`updateJobRow(…, 'complete')`**. Title hook stays **`setImmediate(maybeRunNovaChatTitleAfterFirstCompletion)`** after `complete` — unchanged from [`novaChatCompletionProcessor.js`](../src/fastify/processors/novaChatCompletionProcessor.js).

---

## Prompting (FE-owned)

The server does **not** inject a fixed JSON schema or system prompt for visit prep output.

The FE user message typically includes:

1. Clinician instructions (tone, sections, bullet vs table, etc.) — editable per run; phase 2 may load defaults from **`visit_prep_templates`**.
2. Delimiters and metadata for each past chart (date, note id) plus decrypted note body text.

The model returns **free-form text** (markdown, bullets, tables, etc.) per those instructions. That string is stored as **`visit_preps.text`** without server-side structural parsing.

**Model:** FE sends `"model": "sonnet"` on visit prep completion (normal completions default remains FE choice for follow-ups).

**Message size:** Nova completion body allows up to **100,000** characters (`novaChatCompletionRequestSchema`). Sufficient for multiple full charts (~20k+ words); no special server-side truncation in v1.

---

## Data model

### Table: `public.visit_preps`

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | Owner; `NOT NULL`, references `auth.users` |
| `encrypted_text` | `text` | Ciphertext of prep body; user master key. Nullable if empty. |
| `text_iv` | `text` | IV for text encryption. Nullable when empty. |
| `source_note_ids` | `bigint[]` | Optional provenance — note ids used for generation. **No FK.** |
| `nova_chat_id` | `uuid` | Optional — chat session that produced this row (visit prep completion). |
| `nova_completion_job_id` | `uuid` | Optional — job that produced this row. |
| `created_at` | `timestamptz` | `DEFAULT now()` |
| `updated_at` | `timestamptz` | `DEFAULT now()`; bump on PATCH |

**Indexes (suggested):**

- `visit_preps_user_id_created_at_idx` on `(user_id, created_at DESC)`
- `visit_preps_user_id_updated_at_idx` on `(user_id, updated_at DESC)` — optional, for “recently edited” lists

**DDL sketch:**

```sql
CREATE TABLE public.visit_preps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  encrypted_text text,
  text_iv text,
  source_note_ids bigint[],
  nova_chat_id uuid,
  nova_completion_job_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX visit_preps_user_id_created_at_idx
  ON public.visit_preps (user_id, created_at DESC);
```

**Retention:** indefinite — no purge job tied to encounter archive.

**Regeneration:** each successful visit prep completion → **new row** via **`createVisitPrep`**. User edits → **`PATCH`** on existing row.

---

## Encryption

| Data | Key | Rationale |
|------|-----|-----------|
| `visit_preps.text` | **User master key** | User-owned PHI; same as `notes` |
| Live `notes` (input charts) | User master key | Existing model |

Helpers: reuse `encryptNoteText` / `decryptNoteText` from `src/utils/encryptionUtils.js` (AES-256-GCM). API responses strip `encrypted_text` / `text_iv` and return decrypted **`text`** only — mirror notes controller.

---

## API — `visit_preps` CRUD

**Base path:** `/api/visit-preps`

**Auth:** `Authorization: Bearer <access_token>`

### Shared write path: `createVisitPrep`

```javascript
// visitPrepsController.js — used by POST handler AND novaVisitPrepCompletionProcessor
/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {Buffer} masterKey
 * @param {{ text: string, source_note_ids?: bigint[], nova_chat_id?: string, nova_completion_job_id?: string }} input
 * @returns {Promise<{ success: boolean, visitPrep?: object, error?: string, code?: string }>}
 */
export async function createVisitPrep(supabase, userId, masterKey, input) { … }
```

Public route handler validates body, unwraps master key, calls **`createVisitPrep`**, returns **201**.

### `POST /api/visit-preps`

Create a row directly (without Nova). Primary production path is visit prep completion → processor → **`createVisitPrep`**; this endpoint supports manual entry, imports, and tests.

**Request:**

```json
{
  "text": "Visit prep content…",
  "source_note_ids": ["9223372036854775807", "9223372036854775808"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `text` | `string` | No | Defaults to `""`; encrypted when non-empty |
| `source_note_ids` | `bigint[]` | No | Provenance only |

**Response 201:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "…",
  "text": "Visit prep content…",
  "source_note_ids": ["9223372036854775807", "9223372036854775808"],
  "nova_chat_id": null,
  "nova_completion_job_id": null,
  "created_at": "2026-06-23T14:30:00.000Z",
  "updated_at": "2026-06-23T14:30:00.000Z"
}
```

### `GET /api/visit-preps`

List own rows (paginated: `limit`, `offset`, `sortBy`, `order` — mirror notes list patterns).

### `GET /api/visit-preps/:id`

Single row with decrypted **`text`**.

### `PATCH /api/visit-preps/:id`

User manual edit (FE visit prep editor).

**Request:**

```json
{
  "text": "Updated prep…"
}
```

**Response 200:** updated object with new **`updated_at`**.

### `DELETE /api/visit-preps/:id`

Hard delete own row. **204** or **200** with `{ id }` — match notes convention when implemented.

**Errors (CRUD):** **401**, **404** (not found / wrong user), **400** (validation), **500** (encrypt/DB).

---

## API — Nova visit prep completion

**Base path:** `/api/nova/chat-sessions/:chatId`

Mirrors normal completions (202 + poll, `client_message_id` idempotency, one in-flight job per chat) unless noted.

### `POST …/visit-prep-completions`

**Body:**

```json
{
  "model": "sonnet",
  "message": "Use concise clinical language…\n\n--- Prior visit 1 ---\n…",
  "client_message_id": "550e8400-e29b-41d4-a716-446655440000",
  "source_note_ids": ["9223372036854775807", "9223372036854775808"]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `model` | `haiku` \| `sonnet` \| `opus` | Yes | FE uses **`sonnet`** for visit prep |
| `message` | `string` | Yes | FE-assembled; max 100_000 chars |
| `client_message_id` | UUID | Yes | Idempotency per turn |
| `source_note_ids` | `bigint[]` | No | Stored on new `visit_preps` row |

**Success (202):** `{ "id": "<job-uuid>", "status": "pending", "chat_id": "<chatId>" }`

**Idempotent replay (200):** same as terminal poll when job already **`complete`** for this `client_message_id`.

### `GET …/visit-prep-completion-jobs/:jobId`

Same status lifecycle as normal completion jobs: `pending` → `running` → `complete` \| `failed`.

**When `complete`:**

```json
{
  "id": "<job-uuid>",
  "status": "complete",
  "chat_id": "<chatId>",
  "assistant": { "role": "assistant", "content": "…" },
  "usage": { "input_tokens": 1234, "output_tokens": 567, "total_tokens": 1801, "model": "…" },
  "session": { },
  "visit_prep_id": "550e8400-e29b-41d4-a716-446655440000",
  "visit_prep": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "text": "…",
    "source_note_ids": ["9223372036854775807"],
    "created_at": "…",
    "updated_at": "…"
  }
}
```

**When `failed`:**

```json
{
  "id": "<job-uuid>",
  "status": "failed",
  "chat_id": "<chatId>",
  "code": "VISIT_PREP_PERSIST_FAILED",
  "error": "…"
}
```

Other failure codes align with normal Nova jobs (`NOVA_BEDROCK_FAILED`, `NOVA_SESSION_PERSIST_FAILED`, etc.).

**Jobs table:** extend `nova_chat_completion_jobs` with nullable `kind text default 'chat'` (`'chat'` \| `'visit_prep'`) **or** separate `nova_visit_prep_completion_jobs` — implementer choice; document the chosen table in migration comment.

---

## Session title

Use default Nova title behavior: after the **first successful** visit prep completion, **`maybeRunNovaChatTitleAfterFirstCompletion`** may replace **`"New Chat"`** with a short Haiku label (fire-and-forget, does not block poll **`complete`**).

Visit prep completion **does** block on **`createVisitPrep`** before marking the job **`complete`**. Title generation runs **after** that, in parallel with the client receiving **`complete`** — same as [`NOVA_AI_ARCHITECTURE.md` — Session title](./NOVA_AI_ARCHITECTURE.md#session-title-frontend).

---

## Follow-up chat

After turn 1, the FE uses **`POST …/completions`** (normal) in the **same `chatId`**. Rolling summary, partial streaming, billing, and transcript rules unchanged.

The FE may offer “Save as new visit prep” later via **`POST /api/visit-preps`** with copied text, or a second visit prep completion with a new `client_message_id` — product choice; v1 does not auto-create rows on follow-up turns.

---

## RLS

Enable RLS on `visit_preps`. Mirror [`sql/policies/notes_RLS.sql`](../sql/policies/notes_RLS.sql) ownership model **without** `patientEncounter_id` checks:

| Role | SELECT | INSERT | UPDATE | DELETE |
|------|--------|--------|--------|--------|
| `authenticated` | Own rows (`user_id = auth.uid()`) | Own rows (`WITH CHECK user_id = auth.uid()`) | Own rows | Own rows |
| Service role | Full (if needed for ops scripts) | — | — | — |

Controller verifies ownership on `:id` routes (defense in depth).

---

## Phase 2 — `visit_prep_templates`

| Column | Notes |
|--------|--------|
| `id` | bigint or uuid |
| `name` | Display name |
| `user_id` | null = system template |
| `encrypted_instructions` + `instructions_iv` | Default instruction block for FE to prepend |

CRUD + “use template” on visit prep page. Does not change visit prep completion contract — FE still sends one **`message`** string.

---

## Security considerations

1. **User key PHI:** Prep text is clinical content encrypted under the user master key.
2. **No schema validation on model output:** Treat assistant `content` as opaque string; do not `JSON.parse` for persistence (unless FE chooses to parse client-side for display only).
3. **Logical `source_note_ids`:** May dangle after encounter purge; prep **`text`** is the durable artifact.
4. **Provenance fields:** `nova_chat_id` / `nova_completion_job_id` are optional metadata, not FKs.
5. **HTTPS + Bearer JWT:** Same as all `/api` routes.

---

## Implementation checklist

### `visitPrepsController.js`

- [ ] `createVisitPrep(supabase, userId, masterKey, input)` — single insert + encrypt path
- [ ] `createVisitPrepHandler` → **POST** (calls `createVisitPrep`)
- [ ] `getVisitPrep`, `listVisitPreps`, `updateVisitPrep`, `deleteVisitPrep`
- [ ] `stripEncryptionFields` / decrypt on read — mirror `notesController.js`

### `novaVisitPrepCompletionProcessor.js`

- [ ] Share Bedrock + session persist path with chat processor
- [ ] On success: `assistantText` → `createVisitPrep({ text: assistantText, source_note_ids, nova_chat_id, nova_completion_job_id })`
- [ ] Fail job if `createVisitPrep` fails; do not mark `complete`
- [ ] After `complete`: fire-and-forget title (unchanged)
- [ ] `recordUsageSuccess` / `assertUsageAllowed` — same as chat completion

### Routes & schemas

- [ ] Zod: `visitPrepCreateRequestSchema`, `visitPrepPatchRequestSchema`, `novaVisitPrepCompletionRequestSchema`
- [ ] Register `/api/visit-preps` and Nova visit prep completion routes

### Tests

- [ ] `createVisitPrep` unit/handler: empty text, with `source_note_ids`
- [ ] Visit prep completion happy path: poll `complete` includes `visit_prep_id`
- [ ] Visit prep completion failure when encrypt/insert fails → `VISIT_PREP_PERSIST_FAILED`
- [ ] PATCH updates `text` and `updated_at`
- [ ] RLS: user cannot read another user's row

---

## Related code

| Area | Location |
|------|----------|
| Normal Nova completion processor | `src/fastify/processors/novaChatCompletionProcessor.js` |
| Nova routes / poll | `src/fastify/routes/novaChatSessions.js`, `src/fastify/controllers/novaChatSessionsController.js` |
| Session title (non-blocking) | `src/utils/novaChatTitleService.js` |
| Notes encrypt/decrypt pattern | `src/fastify/controllers/notesController.js`, `src/utils/encryptionUtils.js` |
| Completion request limits | `src/fastify/schemas/novaChatRequests.js` |
| User master key | `src/fastify/controllers/userSecurityConfigController.js` → `getOrCreateUserMasterKey()` |
