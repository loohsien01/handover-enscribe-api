# Visit Prep — Architecture

AI-assisted visit preparation from past clinical notes. The **Visit prep page (FE)** assembles instructions and chart text into a Nova user message. Turn 1 uses **`POST …/completions-and-save-visit-prep`** (mirrors [`generate-and-save-note`](./PROMPT_LLM_FRONTEND_MIGRATION.md)): same Bedrock path as normal Nova chat, then **`createVisitPrep`** before the completion job is marked `complete`. Follow-up turns use ordinary **`POST …/completions`**.

**Related:** Nova chat in [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md); notes CRUD in [`NOTES_API.md`](./NOTES_API.md); prompt-llm save pattern in [`PROMPT_LLM_FRONTEND_MIGRATION.md`](./PROMPT_LLM_FRONTEND_MIGRATION.md).

---

## Status

| Deliverable | Scope | Status |
|-------------|--------|--------|
| **Database** | `visit_preps` table (`chat_id`) + `nova_chat_completion_jobs.visit_prep_id`, RLS | 🔲 Not started |
| **API — CRUD** | `GET` / `POST` / `PATCH` / `DELETE` `/api/visit-preps` | 🔲 Not started |
| **API — Nova** | `POST …/completions-and-save-visit-prep` + existing completion poll | 🔲 Not started |
| **API — Nova title** | `extract_title_details` + `visit_prep_title_details` poll field (ephemeral) | ✅ Shipped |
| **Tests** | CRUD + save-visit-prep completion + encryption round-trip | 🔲 Not started |
| **Templates** | `visit_prep_templates` table + CRUD | 🔲 Phase 2 |

**Backend deliverables (planned, v1):**

- Migration: `sql/migrations/YYYYMMDD_visit_preps.sql` (includes **`chat_id uuid`** nullable)
- Migration: `sql/migrations/YYYYMMDD_nova_chat_completion_jobs_visit_prep_id.sql`
- RLS: `sql/policies/visit_preps_RLS.sql`
- Controller: `src/fastify/controllers/visitPrepsController.js` — exports **`createVisitPrep`** (and update/get/list/delete)
- Routes: `src/fastify/routes/visitPreps.js`
- Extend: `novaChatCompletionProcessor` + `novaChatSessionsController` (save option via processor closure, like `persistEncounterName` in `promptLlmProcessor`)
- Title: `maybeRunVisitPrepTitleDetailsExtraction` + ephemeral Redis cache for poll (`visit_prep_title_details`)
- Routes: `POST …/completions-and-save-visit-prep` alias in `src/fastify/routes/novaChatSessions.js`
- Tests: `tests/visit-preps.test.js`, extend `tests/nova-chat-sessions-completions.test.js`

---

## Goals

1. Let clinicians select **two or more** past visit charts (enscribe notes), add free-form instructions (output format, sections, tone), and generate a visit prep document via Nova.
2. Persist each generated prep as an encrypted **`text`** string (same opaque-string model as [`notes.text`](./NOTES_API.md)), retained **indefinitely**.
3. Reuse Nova chat for **follow-up** refinement in the same session after turn 1 — no separate chat product or extra API phase.
4. Keep **`createVisitPrep`** as the single write path for new rows; the Nova processor calls it when the save route was used; the public **`POST /api/visit-preps`** handler calls the same function (manual recovery / rare direct create — still requires an existing Nova chat).
5. Every visit prep row is tied to a Nova chat session via **`visit_preps.chat_id`** — visit prep is always generated from (or recovered into) a **`chat_sessions`** thread; the visit-prep page lists **`visit_preps`**, not all Nova chats.

**Non-goals (v1):**

- No server-side assembly of the Nova user message (FE builds the message from fetched notes + instructions).
- No JSON schema on the **visit prep document** (main Sonnet assistant output) — clinicians control format via natural-language instructions in the user message. (Separate Haiku JSON extraction for **session title fields** is documented under [Session title](#session-title).)
- No `patient_encounter_id` or encounter linkage on `visit_preps`.
- No `visit_prep_templates` table (phase 2).
- No `source_note_ids` on `visit_preps` — input charts live only in the Nova user `message`.
- No second job table or poll URL — reuse `nova_chat_completion_jobs` and **`GET …/completion-jobs/:jobId`**.

---

## Pattern: mirror prompt-llm `generate-and-save-note`

| Prompt LLM | Visit prep (Nova) |
|------------|-------------------|
| `POST /api/jobs/prompt-llm/generate-note` | `POST …/completions` |
| `POST /api/jobs/prompt-llm/generate-and-save-note` | `POST …/completions-and-save-visit-prep` |
| `GET /api/jobs/prompt-llm/:jobId` (poll) | `GET …/completion-jobs/:jobId` (same poll) |
| `jobs.note_id` set after save | `nova_chat_completion_jobs.visit_prep_id` set after save |
| Save intent: `persistEncounterName` in processor **closure** (not a jobs column) | Save intent: `{ saveVisitPrep: true }` in processor **closure** |
| Save failure: **fail-open** (job `complete` with SOAP on job row) | Save failure: **fail-closed** (job `failed`, `VISIT_PREP_PERSIST_FAILED`) |

Job → artifact link lives on the **high-volume job row** as a nullable UUID (`visit_prep_id`), same as `note_id` on `jobs`. Most completion rows keep `visit_prep_id` null; that is expected and cheap in Postgres.

**No** `persist_visit_prep` boolean on `nova_chat_completion_jobs`. **No** `nova_completion_job_id` on `visit_preps` — redundant once the job stores `visit_prep_id`.

**Dual link (both kept):**

| Column | Table | Direction | Purpose |
|--------|-------|-----------|---------|
| `chat_id` | `visit_preps` | prep → chat | Visit-prep page list; open transcript on click (`GET …/chat-sessions/:chatId`) |
| `visit_prep_id` | `nova_chat_completion_jobs` | job → prep | Completion poll, idempotency replay, “this save job created this row” |

Resolve prep → chat via **`visit_preps.chat_id`** (primary for UI). Job row is still the source of truth for which completion created which prep on the save route.

---

## Terminology

| Term | Meaning |
|------|---------|
| **Normal Nova completion** | `POST …/completions` — async Bedrock turn; job `complete` when assistant message is persisted. |
| **Completion and save visit prep** | `POST …/completions-and-save-visit-prep` — thin alias; same handler/processor with save enabled. **`createVisitPrep`** must succeed before job → `complete`. |
| **`createVisitPrep`** | Shared controller function for **`POST /api/visit-preps`** insert + encrypt; called from the Nova processor when save is enabled — not a Nova-specific wrapper name. |
| **`maybeRunVisitPrepTitleDetailsExtraction`** | Save-route-only fire-and-forget Haiku pass; returns structured **`visit_prep_title_details`** for poll (not generic sidebar title). |

---

## High-level flow

```
Visit prep page (FE)
  │
  ├─ GET /api/notes/:id (×2+)     decrypt past charts
  ├─ Build user message           instructions + pasted note text (no BE assembly)
  │
  ├─ POST /api/nova/chat-sessions
  │     default "New Chat" (visit prep uses a different title path — see Session title)
  │
  ├─ POST …/completions-and-save-visit-prep
  │     { model, message, client_message_id, extract_title_details? }
  │     → 202 + job id
  │
  ├─ Poll GET …/completion-jobs/:jobId
  │     until terminal (complete or failed); re-poll for visit_prep_title_details when async
  │
  └─ Later: POST …/completions (normal) in same chatId for follow-up questions

Visit prep page (returning user)
  │
  ├─ GET /api/visit-preps              recent rows (each includes chat_id)
  ├─ User selects a prep
  ├─ GET /api/visit-preps/:id            prep text (+ chat_id)
  └─ GET /api/nova/chat-sessions/:chatId transcript for follow-up / context
```

**Turn 1:** `completions-and-save-visit-prep` only.  
**Turn 2+:** normal `completions` (no automatic new `visit_preps` row).

---

## Normal completion vs completions-and-save-visit-prep

Both paths share the same **`nova_chat_completion_jobs`** row shape, Redis session, Bedrock invoke/stream, encrypted `chat_messages`, billing (`nova_response`), partial streaming, and poll URL.

| Step | `…/completions` | `…/completions-and-save-visit-prep` |
|------|-------------------|-------------------------------------|
| Persist user message | Yes | Yes |
| Bedrock | Yes | Yes |
| Persist assistant message | Yes | Yes |
| **`createVisitPrep`** | No | **Yes — must succeed before `complete`** |
| Job `complete` | After session persist | After session persist **and** visit prep persist |
| Job row | `visit_prep_id` null | `visit_prep_id` set |
| Terminal poll | `assistant`, `session`, `usage` | Above **+** `visit_prep_id`, optional embedded `visit_prep`; optional **`visit_prep_title_details`** |
| Session title | Generic Haiku → `session.title` (fire-and-forget after `complete`) | **`maybeRunVisitPrepTitleDetailsExtraction`** (fire-and-forget); **no** generic Haiku; FE **`PATCH`** final title |

If **`createVisitPrep`** fails after Bedrock and chat persist succeed, mark job **`failed`** (`VISIT_PREP_PERSIST_FAILED`). User and assistant lines **remain in the transcript** (session persist already succeeded). The Nova turn itself succeeded; only the visit prep row was not created.

Implementation: extend **`novaChatCompletionProcessor(jobId, userId, chatId, authorizationHeader, options?)`** where `options.saveVisitPrep` is set only when the save route enqueued the job (same pattern as `promptLlmProcessor(…, { persistEncounterName })`). Processor order on the save path:

1. Bedrock → append assistant to session → **persist session** (same as normal completion).
2. **`createVisitPrep({ text, chatId })`** — on failure → **`failed`** / `VISIT_PREP_PERSIST_FAILED` (do **not** set `visit_prep_id`).
3. On success → set **`visit_prep_id`** on job → **`recordUsageSuccess`** (`nova_response`) → **`status: 'complete'`**.

The processor always passes **`chatId`** from its closure (session persist already succeeded). **`chat_id`** on the new `visit_preps` row matches the URL `:chatId`.

Bill **`nova_response`** when Bedrock + session persist succeed, **even if** step 2 fails (the model turn completed; save is a separate step). Persist **`usage`** on the job row before marking **`failed`** for `VISIT_PREP_PERSIST_FAILED` so the failure poll can return it.

**Title extraction (save route only):** after step 1 (session persist), when **`extract_title_details`** was true on the enqueueing POST, fire-and-forget **`maybeRunVisitPrepTitleDetailsExtraction`** — **once per chat, first successful Nova turn**, same guard as generic title. Runs whether step 2 succeeds (**`complete`**) or fails (**`VISIT_PREP_PERSIST_FAILED`**) because Bedrock + session persist already succeeded. Does **not** block the job row transition. Does **not** call **`maybeRunNovaChatTitleAfterFirstCompletion`**.

---

## Prompting (FE-owned)

The server does **not** inject a fixed JSON schema or system prompt for visit prep output.

The FE user message typically includes:

1. Clinician instructions (tone, sections, bullet vs table, etc.) — editable per run; phase 2 may load defaults from **`visit_prep_templates`**.
2. Delimiters and metadata for each past chart (date, optional labels) plus decrypted note body text — all plain text in **`message`**; the API does not store note ids on `visit_preps`.

The model returns **free-form text** (markdown, bullets, tables, etc.) per those instructions. That string is stored as **`visit_preps.text`** without server-side structural parsing.

**Model:** FE sends `"model": "sonnet"` on completions-and-save-visit-prep (follow-ups: FE choice on normal `completions`).

**Message size:** Nova completion body allows up to **100,000** characters (`novaChatCompletionRequestSchema`). Sufficient for multiple full charts (~20k+ words).

---

## Data model

### Table: `public.visit_preps`

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | Owner; `NOT NULL`, references `auth.users` |
| `chat_id` | `uuid` | Nova thread (`chat_sessions.id`). **Required on all API creates**; column is **nullable in Postgres** (service-role / ops inserts may omit). **No FK** (logical ref). |
| `encrypted_text` | `text` | Ciphertext of prep body; user master key. Nullable if empty. |
| `text_iv` | `text` | IV for text encryption. Nullable when empty. |
| `created_at` | `timestamptz` | `DEFAULT now()` |
| `updated_at` | `timestamptz` | `DEFAULT now()`; bump on PATCH |

**Not on `visit_preps`:** `source_note_ids` (prior charts are plain text in the Nova user message only).

**`chat_id` rules:**

- **Product invariant:** a visit prep row always belongs to an existing Nova chat — there is no visit prep without a chat thread.
- **API (`POST /api/visit-preps` and Nova save processor):** **`chat_id` is required** — Zod rejects missing/invalid UUID; handler should verify the session exists and is owned by the caller before insert.
- **Postgres:** column **nullable** — no `NOT NULL` constraint so service-role scripts are not blocked; all authenticated API paths still mandate it.

**Indexes (suggested):**

- `visit_preps_user_id_created_at_idx` on `(user_id, created_at DESC)`
- `visit_preps_chat_id_idx` on `(chat_id)` where `chat_id IS NOT NULL` (optional; useful if joining preps to sessions)

**DDL sketch:**

```sql
CREATE TABLE public.visit_preps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  chat_id uuid,
  encrypted_text text,
  text_iv text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX visit_preps_user_id_created_at_idx
  ON public.visit_preps (user_id, created_at DESC);

CREATE INDEX visit_preps_chat_id_idx
  ON public.visit_preps (chat_id)
  WHERE chat_id IS NOT NULL;
```

**Retention:** indefinite — no purge job tied to encounter archive.

**Regeneration:** each successful save completion → **new row** via **`createVisitPrep`** (same **`chat_id`** if the user re-saves in the same thread). User edits → **`PATCH`** on existing row (does not change **`chat_id`**).

### Extend: `public.nova_chat_completion_jobs`

Add one column (mirror `jobs.note_id`):

| Column | Type | Notes |
|--------|------|--------|
| `visit_prep_id` | `uuid` | Nullable. Set when **`createVisitPrep`** succeeds on the save route. **No FK** (logical ref to `visit_preps.id`). Null for normal chat completions. |

```sql
ALTER TABLE public.nova_chat_completion_jobs
  ADD COLUMN visit_prep_id uuid;

-- Optional partial index if querying jobs by visit_prep_id
CREATE INDEX nova_chat_completion_jobs_visit_prep_id_idx
  ON public.nova_chat_completion_jobs (visit_prep_id)
  WHERE visit_prep_id IS NOT NULL;
```

Resolve job → prep via **`job.visit_prep_id`**. Do not store **`nova_completion_job_id`** on `visit_preps`.

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
// visitPrepsController.js — used by POST handler AND novaChatCompletionProcessor (save path)
/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {Buffer} masterKey
 * @param {{ text?: string, chatId: string }} input — `chatId` required (processor + POST handler)
 * @returns {Promise<{ success: boolean, visitPrep?: { id: string, … }, error?: string, code?: string }>}
 */
export async function createVisitPrep(supabase, userId, masterKey, input) { … }
```

Before insert, verify **`chat_sessions`** row exists for **`input.chatId`** and **`user_id`** (404 / validation error if not). Processor flow after **`createVisitPrep`** returns `visitPrep.id`:

1. `UPDATE nova_chat_completion_jobs SET visit_prep_id = $id WHERE id = $jobId`
2. `UPDATE … SET status = 'complete', …`

Public route handler validates body, unwraps master key, calls **`createVisitPrep`**, returns **201**.

### `POST /api/visit-preps`

Create a row without running Bedrock again (manual recovery or rare direct create). **Primary production path** is completions-and-save-visit-prep → processor → **`createVisitPrep`**. Even manual creates **must** reference an existing Nova chat — visit prep is never a standalone artifact.

**Request:**

```json
{
  "chat_id": "660e8400-e29b-41d4-a716-446655440001",
  "text": "Visit prep content…"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `chat_id` | UUID | **Yes** | Must match an existing owned **`chat_sessions`** row |
| `text` | `string` | No | Defaults to `""`; encrypted when non-empty |

**Response 201:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "…",
  "chat_id": "660e8400-e29b-41d4-a716-446655440001",
  "text": "Visit prep content…",
  "created_at": "2026-06-23T14:30:00.000Z",
  "updated_at": "2026-06-23T14:30:00.000Z"
}
```

### `GET /api/visit-preps`

List own rows (paginated: `limit`, `offset`, `sortBy`, `order` — mirror notes list patterns). Each item includes **`chat_id`**. Optional enhancement: join **`chat_sessions.title`** as **`chat_title`** for sidebar labels (plaintext; no message decrypt).

### `GET /api/visit-preps/:id`

Single row with decrypted **`text`** and **`chat_id`**.

### `PATCH /api/visit-preps/:id`

User manual edit (FE visit prep editor).

**Request:** `{ "text": "Updated prep…" }`

**Response 200:** updated object with new **`updated_at`**.

### `DELETE /api/visit-preps/:id`

Hard delete own row. **204** or **200** with `{ id }` — match notes convention when implemented.

**Errors (CRUD):** **401**, **404**, **400**, **500**.

---

## API — Nova completions-and-save-visit-prep

**Base path:** `/api/nova/chat-sessions/:chatId`

Same async job + poll model as normal completions (`client_message_id` idempotency, one in-flight job per chat). **One poll URL:** **`GET …/completion-jobs/:jobId`**.

### `POST …/completions-and-save-visit-prep`

Thin alias: validates the **completions body plus optional title flag**, then enqueues the shared completion handler with **`saveVisitPrep: true`**.

**Body:**

```json
{
  "model": "sonnet",
  "message": "Use concise clinical language…\n\n--- Prior visit 1 ---\n…",
  "client_message_id": "550e8400-e29b-41d4-a716-446655440000",
  "extract_title_details": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `model` | `haiku` \| `sonnet` \| `opus` | Yes | FE uses **`sonnet`** for visit prep |
| `message` | `string` | Yes | FE-assembled plain text (instructions + pasted charts); max 100_000 chars |
| `client_message_id` | UUID | Yes | Idempotency per turn |
| `extract_title_details` | `boolean` | No | Default **`true`**. When **`true`**, run structured title-field extraction (Haiku) after first successful session persist; skip generic Nova sidebar title. When **`false`**, skip extraction; **`session.title`** stays **`"New Chat"`** unless the client **`PATCH`**es. |

**Success (202):** `{ "id": "<job-uuid>", "status": "pending", "chat_id": "<chatId>" }`

**Idempotent replay (200):** same as terminal poll when job already **`complete`** for this `client_message_id`.

### `GET …/completion-jobs/:jobId`

Unchanged route. When job **`status`** is **`complete`** and **`visit_prep_id`** is non-null (save route succeeded):

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
    "chat_id": "<chatId>",
    "text": "…",
    "created_at": "…",
    "updated_at": "…"
  },
  "visit_prep_title_details": {
    "patient_display_name": "Jane Doe",
    "visit_kind": "F/U"
  }
}
```

**`visit_prep_title_details`:** present when title extraction finished successfully for this job; **absent** on the first terminal poll if extraction is still in flight (client re-polls the same job URL). **Not** persisted to Postgres — ephemeral cache only (e.g. Redis keyed by `jobId`, TTL aligned with completion partial / poll window). The server does **not** compose or write the final sidebar title; the client **`PATCH`**es **`session.title`** after merging local date (see [Session title](#session-title)).

Normal completions omit **`visit_prep_id`** / **`visit_prep`** / **`visit_prep_title_details`**.

Optional (mirror `GET …/encounter-bundle`): **`GET …/completion-jobs/:jobId/visit-prep`** returns the saved prep when **`visit_prep_id`** is set; **404** otherwise.

**When `failed`** with **`VISIT_PREP_PERSIST_FAILED`** (Bedrock + session persist succeeded; **`createVisitPrep`** failed):

Unlike generic Nova **`failed`** polls (which return only `code` / `error`), this code **must** also return the successful Nova payload so clients can render the chat turn and recover manually:

```json
{
  "id": "<job-uuid>",
  "status": "failed",
  "chat_id": "<chatId>",
  "code": "VISIT_PREP_PERSIST_FAILED",
  "error": "…",
  "assistant": { "role": "assistant", "content": "…" },
  "usage": { "input_tokens": 1234, "output_tokens": 567, "total_tokens": 1801, "model": "…" },
  "session": { },
  "visit_prep_id": null,
  "visit_prep_title_details": {
    "patient_display_name": "Jane Doe",
    "visit_kind": "NP"
  }
}
```

Implement in **`buildNovaCompletionPollPayload`**: when `job.status === 'failed'` and `error_code === 'VISIT_PREP_PERSIST_FAILED'`, load session (same path as **`complete`**) and attach **`assistant`**, **`session`**, and **`usage`** from the job row. **`visit_prep_id`** absent or null. **`visit_prep_title_details`** may still appear when extraction completed (same ephemeral cache as **`complete`** polls).

**Fallback (always available):** `GET …/:chatId` after failure — last message in **`session.messages`** is the assistant reply. Manual save: **`POST /api/visit-preps`** with `{ "chat_id": "<chatId>", "text": "<assistant.content>" }` ( **`chat_id`** from failure poll or URL).

Other failure codes (`NOVA_BEDROCK_FAILED`, `NOVA_SESSION_PERSIST_FAILED`, etc.) keep the existing Nova **`failed`** shape (no **`session`** unless partial streaming applied).

---

## `VISIT_PREP_PERSIST_FAILED` — recovery (client integration)

This repo is API-only; document expected client behavior for the FE repo:

| UI area | Behavior |
|---------|----------|
| **Main chat** | Treat as a **successful Nova turn** — render **`assistant.content`** from the failure poll (or **`GET …/:chatId`**). Follow-up **`POST …/completions`** works in the same thread. |
| **Visit prep sidebar / panel** | Show **save failed** (`code`, `error`). No **`visit_prep_id`**. |
| **Recovery** | User copies or confirms assistant text → **`POST /api/visit-preps`** with **`chat_id`** from the failure poll / URL + assistant **`text`**. No requirement to retry **`completions-and-save-visit-prep`** unless the product prefers automatic retry. |

Contrast with prompt-llm **generate-and-save-note**: job stays **`complete`** with SOAP on the job row when encounter save fails (**fail-open**). Visit prep save is **fail-closed** on job status, but the API still exposes the Nova output for manual **`POST /api/visit-preps`**.

---

## Session title

Visit prep turn 1 uses a **different title path** from generic Nova chat. Detail lives here only (not in [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md)).

### Generic Nova (`POST …/completions`)

After the first job reaches **`complete`**, **`maybeRunNovaChatTitleAfterFirstCompletion`** (Haiku, plain text) may replace **`"New Chat"`** on **`chat_sessions.title`** — fire-and-forget, non-blocking. See Nova architecture doc for client refresh behavior.

### Visit prep save route (`POST …/completions-and-save-visit-prep`)

| Rule | Decision |
|------|----------|
| **Generic Haiku title** | **Disabled** — do **not** call **`maybeRunNovaChatTitleAfterFirstCompletion`** on this route. |
| **New step** | **`maybeRunVisitPrepTitleDetailsExtraction`** — fire-and-forget Haiku pass with **JSON schema** (separate from main Sonnet visit-prep output). |
| **Request flag** | **`extract_title_details`** on POST body; default **`true`**. When **`false`**, skip extraction entirely. |
| **Trigger** | Once per chat, after the **first successful Nova turn** (user + assistant persisted) — same “first completion” guard as generic title. |
| **When it runs** | After session persist on the save route, whether the job ends **`complete`** or **`failed`** / **`VISIT_PREP_PERSIST_FAILED`** (Bedrock + transcript already succeeded). |
| **Billing** | Title extraction does **not** record **`nova_response`** usage (mirror generic title Haiku). |
| **Failure** | **Fail open** — log errors; poll omits **`visit_prep_title_details`**; **`session.title`** stays **`"New Chat"`** until client **`PATCH`** or manual rename. |
| **Postgres** | **No** new column on **`nova_chat_completion_jobs`** for title fields. Ephemeral cache (e.g. Redis) holds extraction result for poll delivery only. |
| **Final title** | **Not** written by the server. Client composes sidebar string and **`PATCH /api/nova/chat-sessions/:chatId`**. Max **40** chars enforced by **`normalizeNovaChatTitle`** on PATCH. |

### Extraction output schema (API contract)

Haiku structured output (Bedrock **`output_config.format`** / JSON schema) — **not** stored as assistant message content:

```json
{
  "patient_display_name": "Jane Doe",
  "visit_kind": "F/U"
}
```

| Field | Type | Values / notes |
|-------|------|----------------|
| `patient_display_name` | `string` | Patient name when clearly identifiable in the user message (pasted charts + instructions); otherwise **`"Unknown Patient"`**. |
| `visit_kind` | `string` | **`"F/U"`** (follow-up) or **`"NP"`** (new patient). |

**Prompt input:** first user message (required); first assistant reply optional context. Truncate for prompt bounds (mirror **`truncateNovaChatTitlePromptText`**).

**Poll field:** **`visit_prep_title_details`** on terminal **`GET …/completion-jobs/:jobId`** responses (`complete` or **`VISIT_PREP_PERSIST_FAILED`**). May be absent on the first terminal poll; client re-polls until present or timeout (~30s, same spirit as generic Nova title refresh). Idempotent **200** replay includes the field when still in ephemeral cache.

### Client integration (separate FE repo — out of scope here)

This API repo documents the poll contract only. Expected FE behavior (not implemented here):

1. After terminal job poll, re-poll until **`visit_prep_title_details`** appears (or timeout).
2. Compose final sidebar title from **`patient_display_name`**, **`visit_kind`**, and **today’s date in the user’s local timezone** (formatting — e.g. spaces between segments — is FE-owned).
3. Truncate to **40** characters if needed, then **`PATCH { "title": "…" }`**.

**`session.title`** in poll payloads remains **`"New Chat"`** until that PATCH; it is **never** JSON.

---

## Follow-up chat

After turn 1, the FE uses **`POST …/completions`** in the **same `chatId`**. Rolling summary, partial streaming, billing, and transcript rules unchanged.

The FE may copy assistant text via **`POST /api/visit-preps`** (with the same **`chat_id`**), or run another **`completions-and-save-visit-prep`** with a new `client_message_id` — product choice; v1 does not auto-create rows on follow-up turns.

---

## RLS

Enable RLS on `visit_preps`. Mirror [`sql/policies/notes_RLS.sql`](../sql/policies/notes_RLS.sql) ownership model **without** `patientEncounter_id` checks:

| Role | SELECT | INSERT | UPDATE | DELETE |
|------|--------|--------|--------|--------|
| `authenticated` | Own rows | Own rows | Own rows | Own rows |
| Service role | Full (ops scripts) | — | — | — |

Controller verifies ownership on `:id` routes (defense in depth).

---

## Phase 2 — `visit_prep_templates`

| Column | Notes |
|--------|--------|
| `id` | bigint or uuid |
| `name` | Display name |
| `user_id` | null = system template |
| `encrypted_instructions` + `instructions_iv` | Default instruction block for FE to prepend |

CRUD + “use template” on visit prep page. Does not change Nova save contract — FE still sends one **`message`** string.

---

## Security considerations

1. **User key PHI:** Prep text is clinical content encrypted under the user master key.
2. **No schema validation on model output:** Treat assistant `content` as opaque string for persistence.
3. **Plain-text input only:** Prior charts are pasted into the Nova user `message`; prep **`text`** is the durable artifact.
4. **Logical `visit_prep_id` on job:** No FK to `visit_preps`; prep row may be deleted while job row retains id (ops should treat as dangling ref).
5. **Logical `chat_id` on prep:** No FK to `chat_sessions`; verify ownership on create; chat may be deleted while prep row retains id (UI should handle missing session **404**).
6. **HTTPS + Bearer JWT:** Same as all `/api` routes.

---

## Implementation checklist

### Migrations

- [ ] `visit_preps` table (`chat_id uuid` nullable) + RLS
- [x] Migration: `sql/migrations/20260625_visit_preps_chat_id.sql`
- [ ] `nova_chat_completion_jobs.visit_prep_id uuid null`

### `visitPrepsController.js`

- [x] **`createVisitPrep`** — single insert + encrypt path; require **`chatId`**; verify owned **`chat_sessions`** row
- [x] `createVisitPrepHandler` → **POST** (Zod: **`chat_id`** required)
- [x] `getVisitPrep`, `listVisitPreps`, `updateVisitPrep`, `deleteVisitPrep` — responses include **`chat_id`**
- [ ] Decrypt on read — mirror `notesController.js`

### `novaChatCompletionProcessor.js`

- [ ] Optional 5th arg `options?: { saveVisitPrep?: boolean, extractTitleDetails?: boolean }`
- [x] When `saveVisitPrep`: after session persist → **`createVisitPrep({ text, chatId })`**
- [ ] On success: set **`visit_prep_id`** on job → **`recordUsageSuccess`** → **`complete`**
- [ ] On **`createVisitPrep`** failure: write **`usage`** to job row → **`failed`** / `VISIT_PREP_PERSIST_FAILED` (no **`visit_prep_id`**); still **`recordUsageSuccess`** if Bedrock + session persist succeeded
- [ ] **`buildNovaCompletionPollPayload`**: enrich **`VISIT_PREP_PERSIST_FAILED`** with **`assistant`**, **`session`**, **`usage`**
- [x] After session persist on save route: **`maybeRunVisitPrepTitleDetailsExtraction`** when **`extractTitleDetails`** (skip **`maybeRunNovaChatTitleAfterFirstCompletion`**)
- [x] Run title extraction on both **`complete`** and **`VISIT_PREP_PERSIST_FAILED`** when first turn succeeded
- [x] Ephemeral Redis cache for **`visit_prep_title_details`**; attach on poll when ready (no Postgres column)
- [x] Bedrock JSON schema support for extraction Haiku pass

### Routes & schemas

- [ ] `POST …/completions-and-save-visit-prep` → shared handler with save flag
- [ ] Extend poll payload when `job.visit_prep_id` set
- [x] Zod: **`visitPrepCreateRequestSchema`** — **`chat_id`** required UUID
- [x] Zod: save route extends `novaChatCompletionRequestSchema` with **`extract_title_details`**
- [x] Unit tests: extraction schema post-process, poll attaches **`visit_prep_title_details`**

### Tests

- [ ] **`createVisitPrep`** handler + encryption round-trip; **400** without **`chat_id`** (covered in **`tests/visit-preps.test.js`**)
- [ ] Save route: poll **`complete`** includes **`visit_prep_id`**; created prep has **`chat_id`** === session id; job row matches
- [ ] Save route: persist failure → **`VISIT_PREP_PERSIST_FAILED`**, no **`visit_prep_id`**
- [ ] Normal **`completions`**: **`visit_prep_id`** stays null
- [ ] PATCH / DELETE / RLS ownership

---

## Related code

| Area | Location |
|------|----------|
| Prompt-llm save pattern | `src/fastify/routes/promptLlmJobs.js`, `src/fastify/processors/promptLlmProcessor.js`, `src/fastify/controllers/jobController.js` |
| Nova completion processor | `src/fastify/processors/novaChatCompletionProcessor.js` |
| Nova routes / poll | `src/fastify/routes/novaChatSessions.js`, `src/fastify/controllers/novaChatSessionsController.js` |
| Generic session title (non-blocking) | `src/utils/novaChatTitleService.js` |
| Visit prep title details | `src/utils/novaVisitPrepTitleDetailsService.js`, `src/utils/novaVisitPrepTitleDetails.js`, `src/utils/novaVisitPrepTitleDetailsCache.js` |
| Notes encrypt/decrypt | `src/fastify/controllers/notesController.js`, `src/utils/encryptionUtils.js` |
| Completion request limits | `src/fastify/schemas/novaChatRequests.js` |
| User master key | `src/fastify/controllers/userSecurityConfigController.js` → `getOrCreateUserMasterKey()` |
