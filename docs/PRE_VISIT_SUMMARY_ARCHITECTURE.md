# Pre-Visit Summary — Architecture

AI-assisted pre-visit summary preparation from past clinical notes. The **Pre-Visit Summary page (FE)** assembles instructions and chart text into a Nova user message. Turn 1 uses **`POST …/completions-and-save-pre-visit-summary`** (mirrors [`generate-and-save-note`](./PROMPT_LLM_FRONTEND_MIGRATION.md)): same Bedrock path as normal Nova chat, then **`createPreVisitSummary`** before the completion job is marked `complete`. Follow-up turns use ordinary **`POST …/completions`**.

**Related:** Nova chat in [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md); notes CRUD in [`NOTES_API.md`](./NOTES_API.md); prompt-llm save pattern in [`PROMPT_LLM_FRONTEND_MIGRATION.md`](./PROMPT_LLM_FRONTEND_MIGRATION.md).

---

## FE migration (breaking rename from “Visit Prep”)

Product branding is **Pre-Visit Summary** / **Pre-Visit Summaries**. The API, database, and error codes were renamed in one breaking release — **no backward-compatible aliases** for the old `visit_prep*` names.

| Area | Old | New |
|------|-----|-----|
| CRUD base path | `/api/visit-preps` | `/api/pre-visit-summaries` |
| Nova save route | `POST …/completions-and-save-visit-prep` | `POST …/completions-and-save-pre-visit-summary` |
| Job poll sub-resource | `GET …/completion-jobs/:jobId/visit-prep` | `GET …/completion-jobs/:jobId/pre-visit-summary` |
| Poll fields | `visit_prep_id`, `visit_prep`, `visit_prep_title_details` | `pre_visit_summary_id`, `pre_visit_summary`, `pre_visit_summary_title_details` |
| Persist failure code | `VISIT_PREP_PERSIST_FAILED` | `PRE_VISIT_SUMMARY_PERSIST_FAILED` |
| Other error codes | `VISIT_PREP_*` | `PRE_VISIT_SUMMARY_*` |
| DB table | `visit_preps` | `pre_visit_summaries` |
| Job column | `visit_prep_id` | `pre_visit_summary_id` |
| Env (title Haiku override) | `NOVA_VISIT_PREP_TITLE_BEDROCK_MODEL_ID` | `NOVA_PRE_VISIT_SUMMARY_TITLE_BEDROCK_MODEL_ID` |

### Endpoint cheat sheet (v1)

All paths require `Authorization: Bearer <access_token>` unless noted.

| Method | Path |
|--------|------|
| `GET` | `/api/pre-visit-summaries` |
| `POST` | `/api/pre-visit-summaries` |
| `GET` | `/api/pre-visit-summaries/:id` |
| `PATCH` | `/api/pre-visit-summaries/:id` |
| `DELETE` | `/api/pre-visit-summaries/:id` |
| `GET` | `/api/pre-visit-summary-templates` |
| `POST` | `/api/pre-visit-summary-templates` |
| `GET` | `/api/pre-visit-summary-templates/:id` |
| `PATCH` | `/api/pre-visit-summary-templates/:id` |
| `DELETE` | `/api/pre-visit-summary-templates/:id` |
| `POST` | `/api/nova/chat-sessions/:chatId/completions-and-save-pre-visit-summary` |
| `GET` | `/api/nova/chat-sessions/:chatId/completion-jobs/:jobId` |
| `GET` | `/api/nova/chat-sessions/:chatId/completion-jobs/:jobId/pre-visit-summary` |
| `POST` | `/api/nova/chat-sessions/:chatId/completions` (follow-up turns) |

### Error codes (FE-relevant)

| Code | HTTP | When |
|------|------|------|
| `PRE_VISIT_SUMMARY_PERSIST_FAILED` | 200 poll (`status: "failed"`) | Save route: Nova turn + transcript OK; encrypted row insert failed. Poll still includes `assistant`, `session`, `usage`. |
| `PRE_VISIT_SUMMARY_NOT_FOUND` | 404 | `GET …/completion-jobs/:jobId/pre-visit-summary` when job has no `pre_visit_summary_id`, or row missing. |
| `PRE_VISIT_SUMMARY_CHAT_NOT_FOUND` | 404 | `POST /api/pre-visit-summaries` — `chat_id` does not match an owned session. |
| `PRE_VISIT_SUMMARY_CHAT_ID_REQUIRED` | 400 | `POST /api/pre-visit-summaries` — missing or invalid `chat_id`. |
| `PRE_VISIT_SUMMARY_ENCRYPT_FAILED` | 500 | Encrypt failed on create/update (internal). |
| `PRE_VISIT_SUMMARY_INSERT_FAILED` | 500 | DB insert failed (internal). |

CRUD **404** responses for unknown `:id` use `{ "error": "Pre-Visit Summary not found" }` without a `code` field.

**DB upgrade *(BE ops only; FE not affected)*:** apply `sql/migrations/20260627_rename_visit_preps_to_pre_visit_summaries.sql` on databases that already ran the old `visit_preps` migrations. Apply `sql/migrations/20260706_pre_visit_summaries_title.sql` for the **`title`** column. Apply `sql/migrations/20260706_pre_visit_summaries_patient_encounter_and_jobs_pre_visit_summary_id.sql` for encounter linkage + prompt-llm job audit column. Fresh installs use the renamed migration files directly.

**Phase 2:** default instruction templates live in `pre_visit_summary_templates` (CRUD shipped; system seed script optional / later).

---

## Status (v1)

| Deliverable | Scope | Status |
|-------------|--------|--------|
| **Database** | `pre_visit_summaries` table (`chat_id`) + `nova_chat_completion_jobs.pre_visit_summary_id`, RLS | ✅ Shipped *(requires migrations on each environment)* |
| **API — CRUD** | `GET` / `POST` / `PATCH` / `DELETE` `/api/pre-visit-summaries` | ✅ Shipped |
| **API — Nova save** | `POST …/completions-and-save-pre-visit-summary` + completion poll | ✅ Shipped |
| **API — Nova title** | `extract_title_details` + `pre_visit_summary_title_details` poll field (ephemeral) | ✅ Shipped |
| **API — summary title** | `title` on `pre_visit_summaries` CRUD + poll embed; default **New Pre-Visit Summary** | ✅ Shipped |
| **Tests** | CRUD + save-pre-visit-summary validation + unit tests; Bedrock E2E opt-in | ✅ Shipped |
| **Templates** | `pre_visit_summary_templates` table + CRUD | ✅ Shipped *(requires migration on each environment)* |
| **List `chat_title` join** | Join `chat_sessions.title` on list rows | 🔲 Superseded by `pre_visit_summaries.title` |
| **Nova list filter** | `GET /api/nova/chat-sessions` excludes linked pre-visit chats by default | ✅ Shipped |

---

## Goals

1. Let clinicians select **two or more** past visit charts (enscribe notes), add free-form instructions (output format, sections, tone), and generate a pre-visit summary document via Nova.
2. Persist each generated summary as an encrypted **`text`** string (same opaque-string model as [`notes.text`](./NOTES_API.md)), retained **indefinitely**.
3. Reuse Nova chat for **follow-up** refinement in the same session after turn 1 — no separate chat product or extra API phase.
4. Keep **`createPreVisitSummary`** as the single write path for new rows; the Nova processor calls it when the save route was used; the public **`POST /api/pre-visit-summaries`** handler calls the same function (manual recovery / rare direct create — still requires an existing Nova chat).
5. Every pre-visit summary row is created from a Nova chat session via **`pre_visit_summaries.chat_id`** — generation and recovery require an existing **`chat_sessions`** thread; the Pre-Visit Summary page lists **`pre_visit_summaries`**, not all Nova chats. If the chat is later deleted, **`chat_id`** becomes **`null`** (summary text retained).

**Non-goals (v1):**

- No server-side assembly of the Nova user message (FE builds the message from fetched notes + instructions).
- No JSON schema on the **pre-visit summary document** (main Sonnet assistant output) — clinicians control format via natural-language instructions in the user message. (Separate Haiku JSON extraction for **session title fields** is documented under [Session title](#session-title).)
- No server-side “apply template” endpoint — FE loads template `text` via CRUD and prepends into Nova `message`.
- No `source_note_ids` on `pre_visit_summaries` — input charts live only in the Nova user `message`.
- No second job table or poll URL — reuse `nova_chat_completion_jobs` and **`GET …/completion-jobs/:jobId`**.

---

## Pattern: mirror prompt-llm `generate-and-save-note`

| Prompt LLM | Pre-Visit Summary (Nova) |
|------------|-------------------|
| `POST /api/jobs/prompt-llm/generate-note` | `POST …/completions` |
| `POST /api/jobs/prompt-llm/generate-and-save-note` | `POST …/completions-and-save-pre-visit-summary` |
| `GET /api/jobs/prompt-llm/:jobId` (poll) | `GET …/completion-jobs/:jobId` (same poll) |
| `jobs.note_id` set after save | `nova_chat_completion_jobs.pre_visit_summary_id` set after save |
| Save intent: `persistEncounterName` in processor **closure** (not a jobs column) | Save intent: `{ savePreVisitSummary: true }` in processor **closure** |
| Save failure: **fail-open** (job `complete` with SOAP on job row) | Save failure: **fail-closed** (job `failed`, `PRE_VISIT_SUMMARY_PERSIST_FAILED`) |

Job → artifact link lives on the **high-volume job row** as a nullable UUID (`pre_visit_summary_id`), same as `note_id` on `jobs`. Most completion rows keep `pre_visit_summary_id` null; that is expected and cheap in Postgres.

**No** `persist_pre_visit_summary` boolean on `nova_chat_completion_jobs`. **No** `nova_completion_job_id` on `pre_visit_summaries` — redundant once the job stores `pre_visit_summary_id`.

**Dual link (both kept):**

| Column | Table | Direction | Purpose |
|--------|-------|-----------|---------|
| `chat_id` | `pre_visit_summaries` | summary → chat | Pre-Visit Summary page list; open transcript on click (`GET …/chat-sessions/:chatId`). **`null`** after chat delete (`ON DELETE SET NULL`). |
| `pre_visit_summary_id` | `nova_chat_completion_jobs` | job → summary | Completion poll, idempotency replay, “this save job created this row” |

Resolve summary → chat via **`pre_visit_summaries.chat_id`** when non-null (primary for UI). Job row is still the source of truth for which completion created which summary on the save route.

---

## Terminology

| Term | Meaning |
|------|---------|
| **Normal Nova completion** | `POST …/completions` — async Bedrock turn; job `complete` when assistant message is persisted. |
| **Completion and save pre-visit summary** | `POST …/completions-and-save-pre-visit-summary` — thin alias; same handler/processor with save enabled. **`createPreVisitSummary`** must succeed before job → `complete`. |
| **`createPreVisitSummary`** | Shared controller function for **`POST /api/pre-visit-summaries`** insert + encrypt; called from the Nova processor when save is enabled — not a Nova-specific wrapper name. |
| **`maybeRunPreVisitSummaryTitleDetailsExtraction`** | Save-route-only fire-and-forget Haiku pass; returns structured **`pre_visit_summary_title_details`** for poll (not generic sidebar title). |

---

## High-level flow

```
Pre-Visit Summary page (FE)
  │
  ├─ GET /api/notes/:id (×2+)     decrypt past charts
  ├─ Build user message           instructions + pasted note text (no BE assembly)
  │
  ├─ POST /api/nova/chat-sessions
  │     default "New Chat" (pre-visit summary uses a different title path — see Session title)
  │
  ├─ POST …/completions-and-save-pre-visit-summary
  │     { model, message, client_message_id, extract_title_details? }
  │     → 202 + job id
  │
  ├─ Poll GET …/completion-jobs/:jobId
  │     until terminal (complete or failed); re-poll for pre_visit_summary_title_details when async
  │
  └─ Later: POST …/completions (normal) in same chatId for follow-up questions

Pre-Visit Summary page (returning user)
  │
  ├─ GET /api/pre-visit-summaries              recent rows (each includes chat_id)
  ├─ User selects a summary
  ├─ GET /api/pre-visit-summaries/:id            summary text (+ chat_id)
  └─ GET /api/nova/chat-sessions/:chatId transcript for follow-up / context
```

**Turn 1:** `completions-and-save-pre-visit-summary` only.  
**Turn 2+:** normal `completions` (no automatic new `pre_visit_summaries` row).

---

## Nova chat list vs Pre-Visit Summary list

Pre-visit threads are normal `chat_sessions` rows (transcript + follow-up `completions`). The **Pre-Visit Summary page** lists **`GET /api/pre-visit-summaries`**; the **Nova sidebar** lists **`GET /api/nova/chat-sessions`**.

To keep the two UIs separate without a schema migration, the Nova list applies a server-side filter on `pre_visit_summaries.chat_id`:

| Query | Default | Semantics |
|-------|---------|-----------|
| *(none)* | — | **Exclude** chats with any linked `pre_visit_summaries` row (`NOT EXISTS` subquery) |
| `includePreVisitSummary=true` | `false` | Return all owned chats (debug / admin) |
| `onlyPreVisitSummary=true` | `false` | Return only chats with a linked summary |

`includePreVisitSummary` and `onlyPreVisitSummary` cannot both be `true` (**400**). `total` and pagination use the same filter. See [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md) (`GET /api/nova/chat-sessions`).

**Edge cases:**

- **Save failed** (`PRE_VISIT_SUMMARY_PERSIST_FAILED`) — no summary row → chat may still appear in the default Nova list.
- **Abandoned flow** — chat created, turn 1 not saved → no summary row → appears in Nova list.
- **Chat deleted** — `chat_id` SET NULL on summaries; chat drops from both lists; summary text remains on the Pre-Visit Summary page.

**Tests:** `tests/novaChatSessionsList.unit.test.js` (schema + SQL helpers); filter integration in `tests/nova-chat-sessions.test.js` (Tests 13–16).

---

## Normal completion vs completions-and-save-pre-visit-summary

Both paths share the same **`nova_chat_completion_jobs`** row shape, Redis session, Bedrock invoke/stream, encrypted `chat_messages`, partial streaming, and poll URL. **Billing differs by metric** (see below): the save route counts **`pre_visit_summary`**; follow-up **`…/completions`** turns in a chat that already has a summary count **`pre_visit_summary_chat_turn`**; all other Nova chat counts **`nova_response`**.

| Step | `…/completions` | `…/completions-and-save-pre-visit-summary` |
|------|-------------------|-------------------------------------|
| Persist user message | Yes | Yes |
| Bedrock | Yes | Yes |
| Persist assistant message | Yes | Yes |
| **`createPreVisitSummary`** | No | **Yes — must succeed before `complete`** |
| Job `complete` | After session persist | After session persist **and** pre-visit summary persist |
| Job row | `pre_visit_summary_id` null | `pre_visit_summary_id` set |
| Terminal poll | `assistant`, `session`, `usage` | Above **+** `pre_visit_summary_id`, optional embedded `pre_visit_summary`; optional **`pre_visit_summary_title_details`** |
| Session title | Generic Haiku → `session.title` (fire-and-forget after `complete`) | **`maybeRunPreVisitSummaryTitleDetailsExtraction`** (fire-and-forget); **no** generic Haiku; FE **`PATCH`** final title |

If **`createPreVisitSummary`** fails after Bedrock and chat persist succeed, mark job **`failed`** (`PRE_VISIT_SUMMARY_PERSIST_FAILED`). User and assistant lines **remain in the transcript** (session persist already succeeded). The Nova turn itself succeeded; only the pre-visit summary row was not created.

Implementation: extend **`novaChatCompletionProcessor(jobId, userId, chatId, authorizationHeader, options?)`** where `options.savePreVisitSummary` is set only when the save route enqueued the job (same pattern as `promptLlmProcessor(…, { persistEncounterName })`). Processor order on the save path:

1. Bedrock → append assistant to session → **persist session** (same as normal completion).
2. **`createPreVisitSummary({ text, chatId })`** — on failure → **`failed`** / `PRE_VISIT_SUMMARY_PERSIST_FAILED` (do **not** set `pre_visit_summary_id`).
3. On success → set **`pre_visit_summary_id`** on job → **`recordUsageSuccess`** (`pre_visit_summary`) → **`status: 'complete'`**.

The processor always passes **`chatId`** from its closure (session persist already succeeded). **`chat_id`** on the new `pre_visit_summaries` row matches the URL `:chatId`.

**Usage metric** is resolved once per completion by **`resolveNovaUsageMetric`** (in `billingUsage.js`) and used for both the pre-check (402) and the success increment:

| Route / condition | Metric |
|-------------------|--------|
| `…/completions-and-save-pre-visit-summary` (`savePreVisitSummary`) | `pre_visit_summary` |
| `…/completions` in a chat that has a `pre_visit_summaries` row (`chatHasPreVisitSummaryRow`) | `pre_visit_summary_chat_turn` |
| `…/completions` otherwise | `nova_response` |

Bill the resolved metric when Bedrock + session persist succeed, **even if** step 2 fails (the model turn completed; save is a separate step). Persist **`usage`** on the job row before marking **`failed`** for `PRE_VISIT_SUMMARY_PERSIST_FAILED` so the failure poll can return it.

**Title extraction (save route only):** after step 1 (session persist), when **`extract_title_details`** was true on the enqueueing POST, fire-and-forget **`maybeRunPreVisitSummaryTitleDetailsExtraction`** — **once per chat, first successful Nova turn**, same guard as generic title. Runs whether step 2 succeeds (**`complete`**) or fails (**`PRE_VISIT_SUMMARY_PERSIST_FAILED`**) because Bedrock + session persist already succeeded. Does **not** block the job row transition. Does **not** call **`maybeRunNovaChatTitleAfterFirstCompletion`**.

---

## Prompting (FE-owned message; server formatting nudge)

The server does **not** inject a JSON schema or fixed document structure for the main Sonnet output. **Content and layout** come from the FE **`message`** (clinician instructions + pasted charts).

The server **does** inject small **plain-text formatting** system blocks when:

1. **Turn 1** — `POST …/completions-and-save-pre-visit-summary` (processor flag `savePreVisitSummary: true`).
2. **Follow-up turns** — `POST …/completions` in a chat that already has at least one **`pre_visit_summaries`** row for that `chat_id`.

That formatting block nudges human-readable plain text (avoid markdown styling by default; honor explicit markdown requests in the user message). It does **not** replace FE instructions in **`message`**.

### Turn 1 output length (generation only)

Length limits apply **only** to **Turn 1** — `POST …/completions-and-save-pre-visit-summary`. They do **not** apply to:

- Follow-up **`POST …/completions`** (refinement may need more room).
- **`POST /api/pre-visit-summaries`** (manual create / recovery — no Bedrock; user-supplied **`text`** only).

| Layer | Turn 1 | Follow-up `completions` | Manual `POST /api/pre-visit-summaries` |
|-------|--------|-------------------------|----------------------------------------|
| FE template / user **`message`** | Clinician may repeat brevity guidance | Same | N/A (no generation) |
| Server length system block | Yes (~350 words, ≤1500 chars) | No | No |
| Server formatting system block | Yes | Yes (when chat has a summary row) | No |
| Bedrock **`max_tokens`** cap | **400** default (`NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS` env, 64–8192) | **8192** (Nova default) | N/A |

**Constants** (`src/utils/novaPreVisitSummaryLimits.js`):

| Constant | Value | Role |
|----------|-------|------|
| `PRE_VISIT_SUMMARY_TARGET_WORDS` | 350 | Soft prompt target (~words); not counted server-side |
| `PRE_VISIT_SUMMARY_MAX_CHARS` | 1500 | Prompt hard ceiling; char count is enforceable if validation is added later |
| `NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS_DEFAULT` | 400 | Bedrock hard backstop (~1500 chars; conservative for dense clinical text) |

**Rationale:** models are poor at exact word counts. The prompt uses qualitative brevity plus an approximate word target and a **character** ceiling; **`max_tokens`** is the hard API backstop. Word count is guidance only — **`assistant.content.length`** is the measurable line if server validation is added later.

**Processor wiring:** `forPreVisitSummaryTurn1` and the lowered **`max_tokens`** are set only when **`savePreVisitSummary`** is true (Turn 1 enqueue). This is unrelated to **`createPreVisitSummary`** (shared DB insert used by Turn 1 and manual create).

The FE user message typically includes:

1. Clinician instructions (tone, sections, bullet vs table, etc.) — editable per run; may load defaults from **`pre_visit_summary_templates`** (`GET …/pre-visit-summary-templates/:id`). Templates may echo the same brevity guidance (~350 words, ≤1500 characters).
2. Delimiters and metadata for each past chart (date, optional labels) plus decrypted note body text — all plain text in **`message`**; the API does not store note ids on `pre_visit_summaries`.

The model returns **free-form text** per those instructions. That string is stored as **`pre_visit_summaries.text`** (API field **`text`** on responses) without server-side structural parsing.

**Model:** FE sends `"model": "sonnet"` on completions-and-save-pre-visit-summary (follow-ups: FE choice on normal `completions`).

**Message size:** Nova completion body allows up to **100,000** characters (`novaChatCompletionRequestSchema`). Sufficient for multiple full charts (~20k+ words).

---

## Data model

### Table: `public.pre_visit_summaries`

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | Owner; `NOT NULL`, references `auth.users` |
| `chat_id` | `uuid` | Nova thread (`chat_sessions.id`). **Required on all API creates**; **nullable in Postgres** (service-role / ops inserts may omit; **`ON DELETE SET NULL`** when chat row is removed). **FK** → `chat_sessions(id)`. |
| `encrypted_text` | `text` | Ciphertext of summary body; user master key. Nullable if empty. |
| `text_iv` | `text` | IV for text encryption. Nullable when empty. |
| `title` | `text` | Plaintext display label for the Pre-Visit Summary list. **`NOT NULL`**, default **`New Pre-Visit Summary`**. Max **40** chars (same normalization as Nova chat titles). |
| `patientEncounter_id` | `bigint` | Nullable. Set when **`generate-and-save-note`** persists an encounter successfully (first consumption). **FK** → `"patientEncounters"(id)` **`ON DELETE SET NULL`**. Unique when non-null (1 prep ↔ 1 encounter). |
| `created_at` | `timestamptz` | `DEFAULT now()` |
| `updated_at` | `timestamptz` | `DEFAULT now()`; bump on PATCH |

**Not on `pre_visit_summaries`:** `source_note_ids` (prior charts are plain text in the Nova user message only).

**`chat_id` rules:**

- **At create:** every API-created pre-visit summary must reference an existing owned Nova chat (`chat_id` required).
- **After chat delete:** FK **`ON DELETE SET NULL`** — summary row and encrypted **`text`** remain; **`chat_id`** is **`null`**; FE hides “open transcript” or shows unavailable state.
- **API (`POST /api/pre-visit-summaries` and Nova save processor):** **`chat_id` is required** — Zod rejects missing/invalid UUID; handler verifies the session exists and is owned by the caller before insert.
- **Postgres:** column **nullable** — no `NOT NULL` constraint so service-role scripts and chat deletion are not blocked; all authenticated API create paths still mandate **`chat_id`**.

**Indexes (suggested):**

- `pre_visit_summaries_user_id_created_at_idx` on `(user_id, created_at DESC)`
- `pre_visit_summaries_chat_id_idx` on `(chat_id)` where `chat_id IS NOT NULL` (optional; useful if joining summaries to sessions)

**DDL sketch:**

```sql
CREATE TABLE public.pre_visit_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  chat_id uuid REFERENCES public.chat_sessions (id) ON DELETE SET NULL,
  encrypted_text text,
  text_iv text,
  title text NOT NULL DEFAULT 'New Pre-Visit Summary',
  "patientEncounter_id" bigint REFERENCES public."patientEncounters" (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pre_visit_summaries_user_id_created_at_idx
  ON public.pre_visit_summaries (user_id, created_at DESC);

CREATE INDEX pre_visit_summaries_chat_id_idx
  ON public.pre_visit_summaries (chat_id)
  WHERE chat_id IS NOT NULL;
```

**Retention:** indefinite — no purge job tied to encounter archive.

**Regeneration:** each successful save completion → **new row** via **`createPreVisitSummary`** (same **`chat_id`** if the user re-saves in the same thread). User edits → **`PATCH`** on existing row (does not change **`chat_id`**).

### Extend: `public.nova_chat_completion_jobs`

Add one column (mirror `jobs.note_id`):

| Column | Type | Notes |
|--------|------|--------|
| `pre_visit_summary_id` | `uuid` | Nullable. Set when **`createPreVisitSummary`** succeeds on the save route. **No FK** (logical ref to `pre_visit_summaries.id`). Null for normal chat completions. |

```sql
ALTER TABLE public.nova_chat_completion_jobs
  ADD COLUMN pre_visit_summary_id uuid;

-- Optional partial index if querying jobs by pre_visit_summary_id
CREATE INDEX nova_chat_completion_jobs_pre_visit_summary_id_idx
  ON public.nova_chat_completion_jobs (pre_visit_summary_id)
  WHERE pre_visit_summary_id IS NOT NULL;
```

Resolve job → summary via **`job.pre_visit_summary_id`**. Do not store **`nova_completion_job_id`** on `pre_visit_summaries`.

---

## Encryption

| Data | Key | Rationale |
|------|-----|-----------|
| `pre_visit_summaries.text` | **User master key** | User-owned PHI; same as `notes` |
| `pre_visit_summaries.title` | **Plaintext** | Display label only; same model as `chat_sessions.title` |
| Live `notes` (input charts) | User master key | Existing model |

Helpers: reuse `encryptNoteText` / `decryptNoteText` from `src/utils/encryptionUtils.js` (AES-256-GCM). API responses strip `encrypted_text` / `text_iv` and return decrypted **`text`** only — mirror notes controller.

---

## API — `pre_visit_summaries` CRUD

**Base path:** `/api/pre-visit-summaries`

**Auth:** `Authorization: Bearer <access_token>`

### Shared write path: `createPreVisitSummary`

```javascript
// preVisitSummariesController.js — used by POST handler AND novaChatCompletionProcessor (save path)
/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {Buffer} masterKey
 * @param {{ text?: string, chatId: string, title?: string }} input — `chatId` required (processor + POST handler)
 * @returns {Promise<{ success: boolean, preVisitSummary?: { id: string, … }, error?: string, code?: string }>}
 */
export async function createPreVisitSummary(supabase, userId, masterKey, input) { … }
```

Before insert, verify **`chat_sessions`** row exists for **`input.chatId`** and **`user_id`** (404 / validation error if not). Processor flow after **`createPreVisitSummary`** returns `preVisitSummary.id`:

1. `UPDATE nova_chat_completion_jobs SET pre_visit_summary_id = $id WHERE id = $jobId`
2. `UPDATE … SET status = 'complete', …`

Public route handler validates body, unwraps master key, calls **`createPreVisitSummary`**, returns **201**.

### `POST /api/pre-visit-summaries`

Create a row without running Bedrock again (manual recovery or rare direct create). **Primary production path** is completions-and-save-pre-visit-summary → processor → **`createPreVisitSummary`**. Even manual creates **must** reference an existing Nova chat — pre-visit summary is never a standalone artifact.

**Request:**

```json
{
  "chat_id": "660e8400-e29b-41d4-a716-446655440001",
  "text": "Pre-Visit Summary content…",
  "title": "Jane Doe F/U 7/6/26"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `chat_id` | UUID | **Yes** | Must match an existing owned **`chat_sessions`** row |
| `text` | `string` | No | Defaults to `""`; encrypted when non-empty |
| `title` | `string` | No | Defaults to **`New Pre-Visit Summary`** (DB default). Max **40** chars; trimmed via **`normalizeNovaChatTitle`**. |

**Response 201:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "user_id": "…",
  "chat_id": "660e8400-e29b-41d4-a716-446655440001",
  "title": "New Pre-Visit Summary",
  "text": "Pre-Visit Summary content…",
  "created_at": "2026-06-23T14:30:00.000Z",
  "updated_at": "2026-06-23T14:30:00.000Z"
}
```

### `GET /api/pre-visit-summaries`

List own rows (paginated). Each item includes **`chat_id`** (UUID or **`null`** if the chat was deleted) and **`title`**.

**Query params** (all optional; defaults in parentheses):

| Param | Default | Allowed |
|-------|---------|---------|
| `limit` | `50` | 1–100 |
| `offset` | `0` | ≥ 0 |
| `sortBy` | `created_at` | `created_at`, `updated_at`, `id` |
| `order` | `desc` | `asc`, `desc` |

### `GET /api/pre-visit-summaries/:id`

Single row with decrypted **`text`**, **`title`**, and **`chat_id`** (may be **`null`** after chat delete).

### `PATCH /api/pre-visit-summaries/:id`

User manual edit (FE pre-visit summary editor) or title rename after Haiku extraction.

**Request:** at least one of:

```json
{ "text": "Updated Pre-Visit Summary content…" }
```

```json
{ "title": "Jane Doe F/U 7/6/26" }
```

```json
{ "text": "…", "title": "Jane Doe F/U 7/6/26" }
```

**Response 200:** updated object with new **`updated_at`**.

### `DELETE /api/pre-visit-summaries/:id`

Hard delete own row. **200** with `{ "success": true, "id": "<uuid>" }`.

**Errors (CRUD):** **401**, **404**, **400**, **500**.

---

## API — Nova completions-and-save-pre-visit-summary

**Base path:** `/api/nova/chat-sessions/:chatId`

Same async job + poll model as normal completions (`client_message_id` idempotency, one in-flight job per chat). **One poll URL:** **`GET …/completion-jobs/:jobId`**.

### `POST …/completions-and-save-pre-visit-summary`

Thin alias: validates the **completions body plus optional title flag**, then enqueues the shared completion handler with **`savePreVisitSummary: true`**.

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
| `model` | `haiku` \| `sonnet` \| `opus` | Yes | FE uses **`sonnet`** for pre-visit summary |
| `message` | `string` | Yes | FE-assembled plain text (instructions + pasted charts); max 100_000 chars |
| `client_message_id` | UUID | Yes | Idempotency per turn |
| `extract_title_details` | `boolean` | No | Default **`true`**. When **`true`**, run structured title-field extraction (Haiku) after first successful session persist; skip generic Nova sidebar title. When **`false`**, skip extraction; **`session.title`** stays **`"New Chat"`** unless the client **`PATCH`**es. |

**Success (202):** `{ "id": "<job-uuid>", "status": "pending", "chat_id": "<chatId>" }`

**Idempotent replay (200):** same as terminal poll when job already **`complete`** for this `client_message_id`.

### `GET …/completion-jobs/:jobId`

Unchanged route. When job **`status`** is **`complete`** and **`pre_visit_summary_id`** is non-null (save route succeeded):

```json
{
  "id": "<job-uuid>",
  "status": "complete",
  "chat_id": "<chatId>",
  "assistant": { "role": "assistant", "content": "…" },
  "usage": { "input_tokens": 1234, "output_tokens": 567, "total_tokens": 1801, "model": "…" },
  "session": { },
  "pre_visit_summary_id": "550e8400-e29b-41d4-a716-446655440000",
  "pre_visit_summary": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "chat_id": "<chatId>",
    "title": "New Pre-Visit Summary",
    "text": "…",
    "created_at": "…",
    "updated_at": "…"
  },
  "pre_visit_summary_title_details": {
    "patient_display_name": "Jane Doe",
    "visit_kind": "F/U"
  }
}
```

**`pre_visit_summary_title_details`:** present when title extraction finished successfully for this job; **absent** on the first terminal poll if extraction is still in flight (client re-polls the same job URL). **Not** persisted to Postgres — ephemeral cache only (e.g. Redis keyed by `jobId`, TTL aligned with completion partial / poll window). The server does **not** compose or write the final sidebar title; the client **`PATCH`**es **`session.title`** after merging local date (see [Session title](#session-title)).

Normal completions omit **`pre_visit_summary_id`** / **`pre_visit_summary`** / **`pre_visit_summary_title_details`**.

Optional: **`GET …/completion-jobs/:jobId/pre-visit-summary`** returns the saved summary when **`pre_visit_summary_id`** is set; **404** with `PRE_VISIT_SUMMARY_NOT_FOUND` otherwise.

**When `failed`** with **`PRE_VISIT_SUMMARY_PERSIST_FAILED`** (Bedrock + session persist succeeded; **`createPreVisitSummary`** failed):

Unlike generic Nova **`failed`** polls (which return only `code` / `error`), this code **must** also return the successful Nova payload so clients can render the chat turn and recover manually:

```json
{
  "id": "<job-uuid>",
  "status": "failed",
  "chat_id": "<chatId>",
  "code": "PRE_VISIT_SUMMARY_PERSIST_FAILED",
  "error": "…",
  "assistant": { "role": "assistant", "content": "…" },
  "usage": { "input_tokens": 1234, "output_tokens": 567, "total_tokens": 1801, "model": "…" },
  "session": { },
  "pre_visit_summary_id": null,
  "pre_visit_summary_title_details": {
    "patient_display_name": "Jane Doe",
    "visit_kind": "NP"
  }
}
```

Implement in **`buildNovaCompletionPollPayload`**: when `job.status === 'failed'` and `error_code === 'PRE_VISIT_SUMMARY_PERSIST_FAILED'`, load session (same path as **`complete`**) and attach **`assistant`**, **`session`**, and **`usage`** from the job row. **`pre_visit_summary_id`** absent or null. **`pre_visit_summary_title_details`** may still appear when extraction completed (same ephemeral cache as **`complete`** polls).

**Fallback (always available):** `GET …/:chatId` after failure — last message in **`session.messages`** is the assistant reply. Manual save: **`POST /api/pre-visit-summaries`** with `{ "chat_id": "<chatId>", "text": "<assistant.content>" }` ( **`chat_id`** from failure poll or URL).

Other failure codes (`NOVA_BEDROCK_FAILED`, `NOVA_SESSION_PERSIST_FAILED`, etc.) keep the existing Nova **`failed`** shape (no **`session`** unless partial streaming applied).

---

## `PRE_VISIT_SUMMARY_PERSIST_FAILED` — recovery (client integration)

This repo is API-only; document expected client behavior for the FE repo:

| UI area | Behavior |
|---------|----------|
| **Main chat** | Treat as a **successful Nova turn** — render **`assistant.content`** from the failure poll (or **`GET …/:chatId`**). Follow-up **`POST …/completions`** works in the same thread. |
| **Pre-Visit Summary sidebar / panel** | Show **save failed** (`code`, `error`). No **`pre_visit_summary_id`**. |
| **Recovery** | User copies or confirms assistant text → **`POST /api/pre-visit-summaries`** with **`chat_id`** from the failure poll / URL + assistant **`text`**. No requirement to retry **`completions-and-save-pre-visit-summary`** unless the product prefers automatic retry. |

Contrast with prompt-llm **generate-and-save-note**: job stays **`complete`** with SOAP on the job row when encounter save fails (**fail-open**). Pre-Visit Summary save is **fail-closed** on job status, but the API still exposes the Nova output for manual **`POST /api/pre-visit-summaries`**.

---

## Session title

Pre-Visit Summary turn 1 uses a **different title path** from generic Nova chat. Detail lives here only (not in [`NOVA_AI_ARCHITECTURE.md`](./NOVA_AI_ARCHITECTURE.md)).

### Generic Nova (`POST …/completions`)

After the first job reaches **`complete`**, **`maybeRunNovaChatTitleAfterFirstCompletion`** (Haiku, plain text) may replace **`"New Chat"`** on **`chat_sessions.title`** — fire-and-forget, non-blocking. See Nova architecture doc for client refresh behavior.

### Pre-Visit Summary save route (`POST …/completions-and-save-pre-visit-summary`)

| Rule | Decision |
|------|----------|
| **Generic Haiku title** | **Disabled** — do **not** call **`maybeRunNovaChatTitleAfterFirstCompletion`** on this route. |
| **New step** | **`maybeRunPreVisitSummaryTitleDetailsExtraction`** — fire-and-forget Haiku pass with **JSON schema** (separate from main Sonnet pre-visit summary output). |
| **Request flag** | **`extract_title_details`** on POST body; default **`true`**. When **`false`**, skip extraction entirely. |
| **Trigger** | Once per chat, after the **first successful Nova turn** (user + assistant persisted) — same “first completion” guard as generic title. |
| **When it runs** | After session persist on the save route, whether the job ends **`complete`** or **`failed`** / **`PRE_VISIT_SUMMARY_PERSIST_FAILED`** (Bedrock + transcript already succeeded). |
| **Billing** | Title extraction does **not** record **`nova_response`** usage (mirror generic title Haiku). |
| **Failure** | **Fail open** — log errors; poll omits **`pre_visit_summary_title_details`**; **`session.title`** stays **`"New Chat"`** until client **`PATCH`** or manual rename. |
| **Postgres** | **No** new column on **`nova_chat_completion_jobs`** for title fields. Ephemeral cache (e.g. Redis) holds extraction result for poll delivery only. **`pre_visit_summaries.title`** stores the display label (FE **`PATCH`** after compose). |
| **Final title** | **Not** written by the server from extraction. Client composes list title from **`pre_visit_summary_title_details`** + local date, then **`PATCH /api/pre-visit-summaries/:id`**. Max **40** chars via **`normalizeNovaChatTitle`**. Optional: FE may still **`PATCH /api/nova/chat-sessions/:chatId`** (not shown in Pre-Visit Summary UI). |

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

**Poll field:** **`pre_visit_summary_title_details`** on terminal **`GET …/completion-jobs/:jobId`** responses (`complete` or **`PRE_VISIT_SUMMARY_PERSIST_FAILED`**). May be absent on the first terminal poll; client re-polls until present or timeout (~30s, same spirit as generic Nova title refresh). Idempotent **200** replay includes the field when still in ephemeral cache.

### Client integration (separate FE repo — out of scope here)

This API repo documents the poll contract only. Expected FE behavior (not implemented here):

1. After terminal job poll, re-poll until **`pre_visit_summary_title_details`** appears (or timeout).
2. Compose final list title from **`patient_display_name`**, **`visit_kind`**, and **today’s date in the user’s local timezone** (formatting — e.g. spaces between segments — is FE-owned).
3. Truncate to **40** characters if needed, then **`PATCH /api/pre-visit-summaries/:id`** `{ "title": "…" }` (primary).
4. Optionally **`PATCH /api/nova/chat-sessions/:chatId`** `{ "title": "…" }` afterward (Nova sidebar; not shown on Pre-Visit Summary page).

Until step 3, **`pre_visit_summaries.title`** remains **`New Pre-Visit Summary`** (DB default on create). **`session.title`** in poll payloads remains **`New Chat`** unless the client patches the chat session.

---

## Follow-up chat

After turn 1, the FE uses **`POST …/completions`** in the **same `chatId`**. Rolling summary, partial streaming, and transcript rules unchanged. **Billing:** because the chat now has a `pre_visit_summaries` row, these follow-up turns count against **`pre_visit_summary_chat_turn`** (not `nova_response`).

The FE may copy assistant text via **`POST /api/pre-visit-summaries`** (with the same **`chat_id`**), or run another **`completions-and-save-pre-visit-summary`** with a new `client_message_id` — product choice; v1 does not auto-create rows on follow-up turns.

---

## RLS

Enable RLS on `pre_visit_summaries`. Mirror [`sql/policies/notes_RLS.sql`](../sql/policies/notes_RLS.sql) ownership model **without** `patientEncounter_id` checks:

| Role | SELECT | INSERT | UPDATE | DELETE |
|------|--------|--------|--------|--------|
| `authenticated` | Own rows | Own rows | Own rows | Own rows |
| Service role | Full (ops scripts) | — | — | — |

Controller verifies ownership on `:id` routes (defense in depth).

---

## Phase 3 — prompt-llm note generation integration

Optional pre-visit summary context on SOAP generation (`POST /api/jobs/prompt-llm/generate-note` and `generate-and-save-note`).

### Request

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `pre_visit_summary_id` | `uuid` | No | When set, server loads decrypted **`text`** + **`title`** and injects into the Claude prompt. |

### Validation (enqueue)

| Code | HTTP | When |
|------|------|------|
| `PRE_VISIT_SUMMARY_NOT_FOUND` | 404 | Unknown id or not owned |
| `PRE_VISIT_SUMMARY_ALREADY_LINKED` | 409 | `patientEncounter_id` already set (1 prep ↔ 1 encounter) |
| `PRE_VISIT_SUMMARY_INVALID_ID` | 400 | Malformed UUID |

### Claude prompt hierarchy

1. **Transcript** — sole authority for clinical content discussed today.
2. **Pre-visit summary** — secondary context; may be outdated.
3. **Title + body** — emphasized for spelling/vocabulary when ASR garbles names, meds, ages (e.g. forty vs fourteen).

Summary text is included **unmasked** as vocabulary reference; transcript stays PHI-tokenized.

### Persistence

| Column | Table | When set |
|--------|-------|----------|
| `pre_visit_summary_id` | `jobs` | Job create (both routes) — input audit |
| `patientEncounter_id` | `pre_visit_summaries` | **`generate-and-save-note`** only, after `patientEncounterCompleteBundle` succeeds |

If encounter save fails (fail-open), **`patientEncounter_id`** is not set (same as no `note_id`).

Prep ↔ note relationship is **indirect** via the shared encounter (`notes.patientEncounter_id`).

### Job poll

`GET /api/jobs/prompt-llm/:jobId` includes **`pre_visit_summary_id`** when the job was created with one.

**Migration:** `sql/migrations/20260706_pre_visit_summaries_patient_encounter_and_jobs_pre_visit_summary_id.sql`

---

## Phase 2 — `pre_visit_summary_templates`

Default **instruction blocks** for the Pre-Visit Summary page. FE loads template **`text`**, lets the clinician edit it, then prepends it into the Nova user **`message`** (along with pasted charts). **No** dedicated “apply template” API — CRUD only. Nova save contract unchanged.

### Table: `public.pre_visit_summary_templates`

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `user_id` | `uuid` | **`NULL` = system template** (read-only for users). User-owned rows reference `auth.users(id)` **`ON DELETE CASCADE`**. |
| `name` | `text` | Display name. **`NOT NULL`**. Unique per owner scope (case-insensitive, trimmed). |
| `encrypted_text` | `text` | Ciphertext of template body. Nullable when empty. |
| `text_iv` | `text` | IV for text encryption. Nullable when empty. |
| `is_default` | `boolean` | **`NOT NULL DEFAULT false`**. At most **one `true` per owner scope** (`user_id`, including `NULL` for system). |
| `created_at` | `timestamptz` | `DEFAULT now()` |
| `updated_at` | `timestamptz` | `DEFAULT now()`; trigger on UPDATE |

**Encryption:**

| Row type | Key |
|----------|-----|
| `user_id IS NULL` (system) | System master key |
| `user_id = <uuid>` (user) | User master key |

**Indexes:** `(user_id, created_at DESC)`; partial unique on `(user_id) WHERE is_default`; unique on `(COALESCE(user_id, zero-uuid), lower(trim(name)))`.

**Migration:** `sql/migrations/20260628_pre_visit_summary_templates.sql` + `sql/policies/pre_visit_summary_templates_RLS.sql`.

**System seeds:** optional ops script (not required for CRUD); insert via service role with system master key encryption.

### API — `/api/pre-visit-summary-templates`

**Auth:** `Authorization: Bearer <access_token>`

**List visibility:** authenticated users see **own templates + system templates** (`user_id IS NULL`), same ownership model as `noteTemplates`.

#### `GET /api/pre-visit-summary-templates`

Paginated list. Query params (defaults in parentheses):

| Param | Default | Allowed |
|-------|---------|---------|
| `limit` | `50` | 1–100 |
| `offset` | `0` | ≥ 0 |
| `sortBy` | `created_at` | `created_at`, `updated_at`, `name`, `id` |
| `order` | `desc` | `asc`, `desc` |
| `decrypt_text` | `false` | `true` / `false` (also accepts `1` / `0`) |

When **`decrypt_text=false`** (default), items omit **`text`** (metadata only: `id`, `name`, `user_id`, `is_default`, timestamps). When **`decrypt_text=true`**, each item includes decrypted **`text`** (system rows use system key; user rows use user key).

#### `GET /api/pre-visit-summary-templates/:id`

Single row with decrypted **`text`**. **404** `{ "error": "Pre-Visit Summary Template not found" }` for unknown id or row not visible via RLS.

#### `POST /api/pre-visit-summary-templates`

Create a user-owned template from scratch.

**Request:**

```json
{
  "name": "Concise F/U",
  "text": "Use concise clinical language…\n\nSections: …",
  "is_default": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `name` | `string` | Yes | Trimmed; max 200 chars; unique per user (case-insensitive) |
| `text` | `string` | No | Defaults to `""`; max 50_000 chars |
| `is_default` | `boolean` | No | Default `false`. When `true`, clears other defaults for this user before insert |

**Response 201:** created object with decrypted **`text`**.

#### `PATCH /api/pre-visit-summary-templates/:id`

Update **own** row only (not system). At least one of `name`, `text`, `is_default` required.

When **`is_default: true`**, clears other defaults for the same user before update.

**Response 200:** updated object with decrypted **`text`**.

#### `DELETE /api/pre-visit-summary-templates/:id`

Hard delete own row. **200** `{ "success": true, "id": "<uuid>" }`.

**Errors:** **401**, **404** (plain `{ "error": "…" }`), **400** (validation), **409** duplicate name (same shape as note templates), **500** encrypt/DB failures.

### RLS

Mirror `noteTemplates`: SELECT own + system; INSERT/UPDATE/DELETE own only; service role full access for ops/seeds.

### FE integration *(separate repo — docs only)*

1. `GET /api/pre-visit-summary-templates` → template picker (paginated; pass `decrypt_text=true` only when inline preview needs body text).
2. User selects template → `GET …/:id` → populate editable instructions field with **`text`**.
3. User edits, selects charts, builds Nova **`message`**, then existing turn-1 save flow unchanged.

**`is_default`:** API stores one default per user (and one among system templates when seeded). FE may pre-select the default on page load.

---

## Security considerations

1. **User key PHI:** Summary text is clinical content encrypted under the user master key.
2. **No schema validation on model output:** Treat assistant `content` as opaque string for persistence.
3. **Plain-text input only:** Prior charts are pasted into the Nova user `message`; summary **`text`** is the durable artifact.
4. **Logical `pre_visit_summary_id` on job:** No FK to `pre_visit_summaries`; summary row may be deleted while job row retains id (ops should treat as dangling ref).
5. **`chat_id` FK on summary:** `REFERENCES chat_sessions(id) ON DELETE SET NULL` — verify ownership on create; deleting a chat clears **`chat_id`** but keeps the summary row (FE should not offer transcript when **`chat_id`** is **`null`**).
6. **HTTPS + Bearer JWT:** Same as all `/api` routes.

---

## Appendix — BE implementation checklist *(internal)*

For backend tracking; FE can ignore this section.

### Migrations

- [x] `pre_visit_summaries` table + RLS (`20260624_pre_visit_summaries.sql`, `pre_visit_summaries_RLS.sql`)
- [x] `nova_chat_completion_jobs.pre_visit_summary_id` (`20260624_nova_chat_completion_jobs_pre_visit_summary_id.sql`)
- [x] `chat_id` on `pre_visit_summaries` (`20260625_pre_visit_summaries_chat_id.sql`)
- [x] `chat_id` FK `ON DELETE SET NULL` (`20260626_pre_visit_summaries_chat_id_fkey.sql`)
- [x] Upgrade rename from `visit_preps` (`20260627_rename_visit_preps_to_pre_visit_summaries.sql`)
- [x] `pre_visit_summary_templates` table + RLS (`20260628_pre_visit_summary_templates.sql`, `pre_visit_summary_templates_RLS.sql`) *(apply on each environment)*
- [x] `pre_visit_summaries.patientEncounter_id` + `jobs.pre_visit_summary_id` (`20260706_pre_visit_summaries_patient_encounter_and_jobs_pre_visit_summary_id.sql`)

### Controller & processor

- [x] **`createPreVisitSummary`** + CRUD handlers
- [x] `savePreVisitSummary` processor path + `pre_visit_summary_id` on job
- [x] `PRE_VISIT_SUMMARY_PERSIST_FAILED` poll enrichment
- [x] **`maybeRunPreVisitSummaryTitleDetailsExtraction`** + Redis poll cache
- [x] **`preVisitSummaryTemplatesController`** + CRUD routes
- [x] Turn 1 output length (`novaPreVisitSummaryLimits`, `forPreVisitSummaryTurn1`, `max_tokens` cap)
- [x] Phase 3: `pre_visit_summary_id` on prompt-llm generate routes + `jobs.pre_visit_summary_id` + `pre_visit_summaries.patientEncounter_id`

### Routes & tests

- [x] `POST …/completions-and-save-pre-visit-summary`
- [x] Poll payload + `GET …/pre-visit-summary`
- [x] Unit tests: `novaPreVisitSummaryTitleDetails`, `novaBedrockChat`, `novaPreVisitSummaryLimits`
- [x] Integration: `tests/pre-visit-summaries.test.js`, save-route validation in `nova-chat-sessions-completions.test.js`
- [x] Nova list filter: `tests/novaChatSessionsList.unit.test.js`, `tests/nova-chat-sessions.test.js` (Tests 13–16)
- [x] E2E (opt-in): `tests/nova-chat-sessions-save-pre-visit-summary.e2e.test.js`
- [x] Templates CRUD: `tests/pre-visit-summary-templates.test.js`
- [x] Turn 1 output length: `tests/novaPreVisitSummaryLimits.unit.test.js`

---

## Related code

| Area | Location |
|------|----------|
| Prompt-llm save pattern | `src/fastify/routes/promptLlmJobs.js`, `src/fastify/processors/promptLlmProcessor.js`, `src/fastify/controllers/jobController.js` |
| Nova completion processor | `src/fastify/processors/novaChatCompletionProcessor.js` |
| Nova routes / poll | `src/fastify/routes/novaChatSessions.js`, `src/fastify/controllers/novaChatSessionsController.js` |
| Nova list filter (pre-visit) | `src/utils/novaChatPersistence.js` (`listChatSessionsForUser`, `resolvePreVisitSummaryListFilter`) |
| Generic session title (non-blocking) | `src/utils/novaChatTitleService.js` |
| Pre-Visit Summary title details | `src/utils/novaPreVisitSummaryTitleDetailsService.js`, `src/utils/novaPreVisitSummaryTitleDetails.js`, `src/utils/novaPreVisitSummaryTitleDetailsCache.js` |
| Pre-Visit Summary templates CRUD | `src/fastify/controllers/preVisitSummaryTemplatesController.js`, `src/fastify/routes/preVisitSummaryTemplates.js`, `src/fastify/schemas/preVisitSummaryTemplateRequests.js` |
| Turn 1 output length constants | `src/utils/novaPreVisitSummaryLimits.js` |
| Notes encrypt/decrypt | `src/fastify/controllers/notesController.js`, `src/utils/encryptionUtils.js` |
| Completion request limits | `src/fastify/schemas/novaChatRequests.js` |
| User master key | `src/fastify/controllers/userSecurityConfigController.js` → `getOrCreateUserMasterKey()` |
