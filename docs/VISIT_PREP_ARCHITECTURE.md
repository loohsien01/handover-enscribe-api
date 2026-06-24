# Visit Prep — Architecture

AI-assisted visit preparation from past clinical notes. The **Visit prep page (FE)** assembles instructions and chart text into a Nova user message. Turn 1 uses **`POST …/completions-and-save-visit-prep`** (mirrors [`generate-and-save-note`](./PROMPT_LLM_FRONTEND_MIGRATION.md)): same Bedrock path as normal Nova chat, then **`createVisitPrep`** before the completion job is marked `complete`. Follow-up turns use ordinary **`POST …/completions`**.

**Related:** Nova chat in [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md); notes CRUD in [`NOTES_API.md`](./NOTES_API.md); prompt-llm save pattern in [`PROMPT_LLM_FRONTEND_MIGRATION.md`](./PROMPT_LLM_FRONTEND_MIGRATION.md).

---

## Status

| Deliverable | Scope | Status |
|-------------|--------|--------|
| **Database** | `visit_preps` table + `nova_chat_completion_jobs.visit_prep_id`, RLS | 🔲 Not started |
| **API — CRUD** | `GET` / `POST` / `PATCH` / `DELETE` `/api/visit-preps` | 🔲 Not started |
| **API — Nova** | `POST …/completions-and-save-visit-prep` + existing completion poll | 🔲 Not started |
| **Tests** | CRUD + save-visit-prep completion + encryption round-trip | 🔲 Not started |
| **Templates** | `visit_prep_templates` table + CRUD | 🔲 Phase 2 |

**Backend deliverables (planned, v1):**

- Migration: `sql/migrations/YYYYMMDD_visit_preps.sql`
- Migration: `sql/migrations/YYYYMMDD_nova_chat_completion_jobs_visit_prep_id.sql`
- RLS: `sql/policies/visit_preps_RLS.sql`
- Controller: `src/fastify/controllers/visitPrepsController.js` — exports **`createVisitPrep`** (and update/get/list/delete)
- Routes: `src/fastify/routes/visitPreps.js`
- Extend: `novaChatCompletionProcessor` + `novaChatSessionsController` (save option via processor closure, like `persistEncounterName` in `promptLlmProcessor`)
- Routes: `POST …/completions-and-save-visit-prep` alias in `src/fastify/routes/novaChatSessions.js`
- Tests: `tests/visit-preps.test.js`, extend `tests/nova-chat-sessions-completions.test.js`

---

## Goals

1. Let clinicians select **two or more** past visit charts (enscribe notes), add free-form instructions (output format, sections, tone), and generate a visit prep document via Nova.
2. Persist each generated prep as an encrypted **`text`** string (same opaque-string model as [`notes.text`](./NOTES_API.md)), retained **indefinitely**.
3. Reuse Nova chat for **follow-up** refinement in the same session after turn 1 — no separate chat product or extra API phase.
4. Keep **`createVisitPrep`** as the single write path for new rows; the Nova processor calls it when the save route was used; the public **`POST /api/visit-preps`** handler calls the same function (manual create / ops / future callers).

**Non-goals (v1):**

- No server-side assembly of the Nova user message (FE builds the message from fetched notes + instructions).
- No JSON schema enforced on model output — clinicians control format via natural-language instructions in the user message.
- No `patient_encounter_id` or encounter linkage on `visit_preps`.
- No `visit_prep_templates` table (phase 2).
- No `source_note_ids` or `nova_chat_id` on `visit_preps` — input charts live only in the Nova user `message`; chat linkage is on **`nova_chat_completion_jobs`** (`visit_prep_id` + `chat_id`).
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

---

## Terminology

| Term | Meaning |
|------|---------|
| **Normal Nova completion** | `POST …/completions` — async Bedrock turn; job `complete` when assistant message is persisted. |
| **Completion and save visit prep** | `POST …/completions-and-save-visit-prep` — thin alias; same handler/processor with save enabled. **`createVisitPrep`** must succeed before job → `complete`. |
| **`createVisitPrep`** | Shared controller function for **`POST /api/visit-preps`** insert + encrypt; called from the Nova processor when save is enabled — not a Nova-specific wrapper name. |

---

## High-level flow

```
Visit prep page (FE)
  │
  ├─ GET /api/notes/:id (×2+)     decrypt past charts
  ├─ Build user message           instructions + pasted note text (no BE assembly)
  │
  ├─ POST /api/nova/chat-sessions
  │     default "New Chat"; AI title runs after turn 1 (fire-and-forget, non-blocking)
  │
  ├─ POST …/completions-and-save-visit-prep
  │     { model: "sonnet", message, client_message_id }
  │     → 202 + job id
  │
  ├─ Poll GET …/completion-jobs/:jobId
  │     until status complete (visit_prep_id set) or failed
  │
  └─ Later: POST …/completions (normal) in same chatId for follow-up questions
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
| Terminal poll | `assistant`, `session`, `usage` | Above **+** `visit_prep_id`, optional embedded `visit_prep` |
| Session title (Haiku) | Fire-and-forget after `complete` | Same — does not block job or save |

If **`createVisitPrep`** fails after Bedrock and chat persist succeed, mark job **`failed`** (`VISIT_PREP_PERSIST_FAILED`). User and assistant lines **remain in the transcript** (session persist already succeeded). The Nova turn itself succeeded; only the visit prep row was not created.

Implementation: extend **`novaChatCompletionProcessor(jobId, userId, chatId, authorizationHeader, options?)`** where `options.saveVisitPrep` is set only when the save route enqueued the job (same pattern as `promptLlmProcessor(…, { persistEncounterName })`). Processor order on the save path:

1. Bedrock → append assistant to session → **persist session** (same as normal completion).
2. **`createVisitPrep`** — on failure → **`failed`** / `VISIT_PREP_PERSIST_FAILED` (do **not** set `visit_prep_id`).
3. On success → set **`visit_prep_id`** on job → **`recordUsageSuccess`** (`nova_response`) → **`status: 'complete'`**.

Bill **`nova_response`** when Bedrock + session persist succeed, **even if** step 2 fails (the model turn completed; save is a separate step). Persist **`usage`** on the job row before marking **`failed`** for `VISIT_PREP_PERSIST_FAILED` so the failure poll can return it.

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
| `encrypted_text` | `text` | Ciphertext of prep body; user master key. Nullable if empty. |
| `text_iv` | `text` | IV for text encryption. Nullable when empty. |
| `created_at` | `timestamptz` | `DEFAULT now()` |
| `updated_at` | `timestamptz` | `DEFAULT now()`; bump on PATCH |

**Not on `visit_preps`:** `source_note_ids` (prior charts are plain text in the Nova user message only). **`nova_chat_id`** (use `nova_chat_completion_jobs.chat_id` where `visit_prep_id` matches).

**Indexes (suggested):**

- `visit_preps_user_id_created_at_idx` on `(user_id, created_at DESC)`

**DDL sketch:**

```sql
CREATE TABLE public.visit_preps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  encrypted_text text,
  text_iv text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX visit_preps_user_id_created_at_idx
  ON public.visit_preps (user_id, created_at DESC);
```

**Retention:** indefinite — no purge job tied to encounter archive.

**Regeneration:** each successful save completion → **new row** via **`createVisitPrep`**. User edits → **`PATCH`** on existing row.

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
 * @param {{ text: string }} input
 * @returns {Promise<{ success: boolean, visitPrep?: { id: string, … }, error?: string, code?: string }>}
 */
export async function createVisitPrep(supabase, userId, masterKey, input) { … }
```

Processor flow after **`createVisitPrep`** returns `visitPrep.id`:

1. `UPDATE nova_chat_completion_jobs SET visit_prep_id = $id WHERE id = $jobId`
2. `UPDATE … SET status = 'complete', …`

Public route handler validates body, unwraps master key, calls **`createVisitPrep`**, returns **201**.

### `POST /api/visit-preps`

Create a row directly (without Nova). Primary production path is completions-and-save-visit-prep → processor → **`createVisitPrep`**.

**Request:**

```json
{
  "text": "Visit prep content…"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `text` | `string` | No | Defaults to `""`; encrypted when non-empty |

**Response 201:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "…",
  "text": "Visit prep content…",
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

Thin alias: validates the **same body as completions**, then enqueues the shared completion handler with **`saveVisitPrep: true**.

**Body:**

```json
{
  "model": "sonnet",
  "message": "Use concise clinical language…\n\n--- Prior visit 1 ---\n…",
  "client_message_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `model` | `haiku` \| `sonnet` \| `opus` | Yes | FE uses **`sonnet`** for visit prep |
| `message` | `string` | Yes | FE-assembled plain text (instructions + pasted charts); max 100_000 chars |
| `client_message_id` | UUID | Yes | Idempotency per turn |

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
    "text": "…",
    "created_at": "…",
    "updated_at": "…"
  }
}
```

Normal completions omit **`visit_prep_id`** / **`visit_prep`** (both absent or null).

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
  "visit_prep_id": null
}
```

Implement in **`buildNovaCompletionPollPayload`**: when `job.status === 'failed'` and `error_code === 'VISIT_PREP_PERSIST_FAILED'`, load session (same path as **`complete`**) and attach **`assistant`**, **`session`**, and **`usage`** from the job row. **`visit_prep_id`** absent or null.

**Fallback (always available):** `GET …/:chatId` after failure — last message in **`session.messages`** is the assistant reply. Manual save: **`POST /api/visit-preps`** with `{ "text": "<assistant.content>" }`.

Other failure codes (`NOVA_BEDROCK_FAILED`, `NOVA_SESSION_PERSIST_FAILED`, etc.) keep the existing Nova **`failed`** shape (no **`session`** unless partial streaming applied).

---

## `VISIT_PREP_PERSIST_FAILED` — recovery (client integration)

This repo is API-only; document expected client behavior for the FE repo:

| UI area | Behavior |
|---------|----------|
| **Main chat** | Treat as a **successful Nova turn** — render **`assistant.content`** from the failure poll (or **`GET …/:chatId`**). Follow-up **`POST …/completions`** works in the same thread. |
| **Visit prep sidebar / panel** | Show **save failed** (`code`, `error`). No **`visit_prep_id`**. |
| **Recovery** | User copies or confirms assistant text → **`POST /api/visit-preps`** (manual create). No requirement to retry **`completions-and-save-visit-prep`** unless the product prefers automatic retry. |

Contrast with prompt-llm **generate-and-save-note**: job stays **`complete`** with SOAP on the job row when encounter save fails (**fail-open**). Visit prep save is **fail-closed** on job status, but the API still exposes the Nova output for manual **`POST /api/visit-preps`**.

---

## Session title

Default Nova behavior: **`maybeRunNovaChatTitleAfterFirstCompletion`** runs only when the job reaches **`complete`** (fire-and-forget).

On **`VISIT_PREP_PERSIST_FAILED`**, the job is **`failed`**, so the automatic Haiku title **does not** run (same as any non-`complete` job). The transcript still has user + assistant lines; the client may **`PATCH { "title": "…" }`** or leave **`"New Chat"`**.

When the save path succeeds, title runs after **`complete`** as today — see [`NOVA_AI_ARCHITECTURE.md` — Session title](./NOVA_AI_ARCHITECTURE.md#session-title-frontend).

---

## Follow-up chat

After turn 1, the FE uses **`POST …/completions`** in the **same `chatId`**. Rolling summary, partial streaming, billing, and transcript rules unchanged.

The FE may copy assistant text via **`POST /api/visit-preps`**, or run another **`completions-and-save-visit-prep`** with a new `client_message_id` — product choice; v1 does not auto-create rows on follow-up turns.

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
5. **HTTPS + Bearer JWT:** Same as all `/api` routes.

---

## Implementation checklist

### Migrations

- [ ] `visit_preps` table + RLS
- [ ] `nova_chat_completion_jobs.visit_prep_id uuid null`

### `visitPrepsController.js`

- [ ] **`createVisitPrep`** — single insert + encrypt path
- [ ] `createVisitPrepHandler` → **POST**
- [ ] `getVisitPrep`, `listVisitPreps`, `updateVisitPrep`, `deleteVisitPrep`
- [ ] Decrypt on read — mirror `notesController.js`

### `novaChatCompletionProcessor.js`

- [ ] Optional 5th arg `options?: { saveVisitPrep?: boolean }`
- [ ] When `saveVisitPrep`: after session persist → **`createVisitPrep({ text })`**
- [ ] On success: set **`visit_prep_id`** on job → **`recordUsageSuccess`** → **`complete`**
- [ ] On **`createVisitPrep`** failure: write **`usage`** to job row → **`failed`** / `VISIT_PREP_PERSIST_FAILED` (no **`visit_prep_id`**); still **`recordUsageSuccess`** if Bedrock + session persist succeeded
- [ ] **`buildNovaCompletionPollPayload`**: enrich **`VISIT_PREP_PERSIST_FAILED`** with **`assistant`**, **`session`**, **`usage`**
- [ ] Title: fire-and-forget only after job **`complete`** (not after visit-prep save failure)

### Routes & schemas

- [ ] `POST …/completions-and-save-visit-prep` → shared handler with save flag
- [ ] Extend poll payload when `job.visit_prep_id` set
- [ ] Zod: `visitPrepCreateRequestSchema`, `visitPrepPatchRequestSchema`; save route uses same body as `novaChatCompletionRequestSchema`

### Tests

- [ ] **`createVisitPrep`** handler + encryption round-trip
- [ ] Save route: poll **`complete`** includes **`visit_prep_id`**; job row matches
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
| Session title (non-blocking) | `src/utils/novaChatTitleService.js` |
| Notes encrypt/decrypt | `src/fastify/controllers/notesController.js`, `src/utils/encryptionUtils.js` |
| Completion request limits | `src/fastify/schemas/novaChatRequests.js` |
| User master key | `src/fastify/controllers/userSecurityConfigController.js` → `getOrCreateUserMasterKey()` |
