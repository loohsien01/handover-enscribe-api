# Note Feedback — Architecture

Thumbs up/down and optional free-text feedback on the note edit page. Each submission captures an **immutable snapshot** of the note text so internal reviewers can inspect what was rated after live notes are purged by encounter archive.

**Related:** live notes CRUD in [`NOTES_API.md`](./NOTES_API.md); encounter purge in [`retention_archival (Supabase_to_S3).md`](./retention_archival%20(Supabase_to_S3).md).

---

## Status

| Deliverable | Scope | Status |
|-------------|--------|--------|
| **Database** | `note_feedback` table, RLS, migration | 🔲 Not started |
| **API** | `POST /api/notes/:id/feedback` | 🔲 Not started |
| **Tests** | Route + encryption round-trip | 🔲 Not started |

**Backend deliverables (planned):**

- Migration: `sql/migrations/YYYYMMDD_note_feedback.sql`
- RLS: `sql/policies/note_feedback_RLS.sql`
- Controller: `src/fastify/controllers/noteFeedbackController.js`
- Routes: registered from `src/fastify/routes/notes.js` (or dedicated route file)
- Tests: `tests/note-feedback.test.js`

---

## Goals

1. Let clinicians rate a note (positive / negative) from the edit page, with optional written feedback.
2. Persist a **point-in-time copy** of the note body so reviewers can read the rated content even after the live `notes` row is deleted (~7-day encounter archive purge).
3. Keep feedback **append-only** — each submission is a new row with its own snapshot and `created_at`.
4. Encrypt stored PHI (snapshot + feedback text) with the **system master key** so internal review tooling can decrypt without per-user key unwrap.

**Non-goals (v1):**

- No GET endpoints (no “already rated” check, no snapshot returned to the client).
- No denormalized refs (`job_id`, `patientEncounter_id`, `source`).
- No FK from `note_id` to `notes` (logical reference only; survives note purge).
- No purge job for feedback rows — retained indefinitely for quality review.

---

## Context: why snapshot?

Live notes are encrypted with the **user master key** and tied to patient encounters. The encounter archive pipeline hard-deletes notes when an encounter subtree is purged:

```
patientEncounters → notes → (deleted)
```

Feedback rows **outlive** live notes. The snapshot columns are the durable record of what the user rated. Future edits to a live note do not affect prior feedback rows; a new rating requires a new submission.

---

## Data model

### Table: `public.note_feedback`

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `note_id` | `bigint` | Logical reference to `notes.id` at submit time. **No FK constraint.** Becomes a dangling reference after note purge — expected. |
| `user_id` | `uuid` | Submitter; `NOT NULL`, references `auth.users` |
| `rating` | `text` | `'positive'` \| `'negative'` (check constraint) |
| `encrypted_note_snapshot` | `text` | Ciphertext of note body at submit; system key. Nullable if note text was empty. |
| `note_snapshot_iv` | `text` | IV for snapshot encryption. Nullable when snapshot empty. |
| `encrypted_feedback_text` | `text` | Ciphertext of optional user comment; system key. Nullable. |
| `feedback_text_iv` | `text` | IV for feedback text. Nullable when comment empty. |
| `created_at` | `timestamptz` | `DEFAULT now()` — when snapshot + feedback were captured |

**Indexes (suggested):**

- `note_feedback_user_id_created_at_idx` on `(user_id, created_at DESC)`
- `note_feedback_note_id_idx` on `(note_id)` — optional, for correlating feedback to notes while they still exist

**DDL sketch:**

```sql
CREATE TABLE public.note_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id bigint NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  rating text NOT NULL,
  encrypted_note_snapshot text,
  note_snapshot_iv text,
  encrypted_feedback_text text,
  feedback_text_iv text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT note_feedback_rating_check CHECK (rating IN ('positive', 'negative'))
);

CREATE INDEX note_feedback_user_id_created_at_idx
  ON public.note_feedback (user_id, created_at DESC);

CREATE INDEX note_feedback_note_id_idx
  ON public.note_feedback (note_id);
```

**Append-only:** no `UPDATE` or upsert. Multiple rows per `(user_id, note_id)` are allowed.

**`note_id` without FK:** intentional. Encounter purge must not block on or cascade-delete feedback. After purge, `note_id` is a historical / dangling reference; reviewers use the encrypted snapshot, not the live note.

---

## Encryption

### Keys

| Data | Key | Rationale |
|------|-----|-----------|
| Live `notes.text` | User master key | Existing model; user-scoped PHI |
| `note_feedback` snapshot + feedback text | **System master key** | Internal reviewers decrypt via service role + `getSystemMasterKey()` without per-user unwrap |

System key material: `userSecurityConfigs` row where `user_id IS NULL`. Same path as system note-template sections (`getSystemMasterKey()` in `userSecurityConfigController.js`).

Helpers: reuse `encryptNoteText` / `decryptNoteText` from `src/utils/encryptionUtils.js` (AES-256-GCM, same as notes). For feedback text, treat as `{ text: feedbackText }` through the same helpers or a thin wrapper.

### Submit flow (server)

```
POST /api/notes/:id/feedback
        │
        ▼
Load note by id + user_id (ownership check, same as PATCH /api/notes/:id)
        │
        ▼
Decrypt live note with USER master key (getOrCreateUserMasterKey)
        │
        ▼
Encrypt snapshot plaintext with SYSTEM master key → encrypted_note_snapshot, note_snapshot_iv
        │
        ▼
If feedback_text present: encrypt with SYSTEM key → encrypted_feedback_text, feedback_text_iv
        │
        ▼
INSERT note_feedback row (append-only)
        │
        ▼
Return 201 with id, rating, created_at only — no ciphertext, no snapshot plaintext
```

**Empty snapshot:** allowed. If note `text` is empty/null, store `encrypted_note_snapshot` and `note_snapshot_iv` as null.

**Empty feedback text:** allowed for both ratings. Thumbs-down may encourage text in the FE; API does not require it.

### Review / decrypt (internal, not a public API v1)

Ops or internal scripts with `SUPABASE_SERVICE_ROLE_KEY` and `RSA_PRIVATE_KEY`:

1. `SELECT` rows from `note_feedback`.
2. `getSystemMasterKey()` → unwrap system AES key.
3. `decryptNoteText({ encrypted_text, text_iv }, systemKey)` for snapshot and feedback columns.

Pattern aligns with `sql/scripts/encrypt-note-template-section-details.js` and `export-and-decrypt-by-user.js` (service role + unwrap).

---

## API

**Base path:** `/api/notes/:id/feedback`

### Authentication

```http
Authorization: Bearer <access_token>
Content-Type: application/json
```

**401** if token missing or invalid.

### `POST /api/notes/:id/feedback`

Submit feedback for a note the authenticated user owns.

**When to call:** user taps thumbs up/down on the note edit page (FE repo). Optional text field shown after rating (especially thumbs down).

**Request body:**

```json
{
  "rating": "negative",
  "feedback_text": "Assessment section missed follow-up plan"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|--------|
| `rating` | `"positive"` \| `"negative"` | Yes | |
| `feedback_text` | `string` | No | Encrypted at rest with system key when non-empty |

**Response 201:**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "note_id": "9223372036854775807",
  "rating": "negative",
  "created_at": "2026-06-23T14:30:00.000Z"
}
```

Ciphertext columns and snapshot plaintext are **never** returned.

**Errors:**

| Status | Meaning |
|--------|---------|
| 400 | Invalid body (bad `rating`, malformed `note_id`) |
| 401 | Unauthorized |
| 404 | Note not found or not owned by user |
| 500 | Encryption failure, system key unavailable, DB error |

**Not in v1:**

- `GET /api/notes/:id/feedback` — no “already rated” lookup
- Any endpoint returning decrypted snapshot or feedback text to the client

---

## RLS

Enable RLS on `note_feedback`.

| Role | INSERT | SELECT | UPDATE | DELETE |
|------|--------|--------|--------|--------|
| `authenticated` | Own rows only (`user_id = auth.uid()`) | **None** | **None** | **None** |
| Service role (API / internal) | Via controller | Full read | — | — |

**INSERT policy (authenticated):**

- `WITH CHECK (user_id = auth.uid())`
- Controller must set `user_id` from JWT and verify note ownership before insert (defense in depth).

**No SELECT for authenticated:** users cannot read feedback rows (including their own) through the anon/authenticated Supabase client. All review access goes through service role on the backend or trusted ops scripts.

Same posture as `baa_acceptances` and `internal_access` — writes gated by API; no broad authenticated read policies.

---

## Retention

| Asset | Lifecycle |
|-------|-----------|
| Live `notes` | Purged with encounter archive (~7-day inactivity); see encounter archive docs |
| `note_feedback` | **Indefinite** — no purge job planned. Design assumes rows accumulate for quality review |

Feedback is intentionally retained longer than live notes. Any future retention policy for feedback should be a separate explicit decision (not implied by encounter archive).

---

## Security considerations

1. **System key on user PHI:** Feedback snapshots are clinical note content (PHI) encrypted under the **system** key, not the user's key. This is intentional: internal review must work after live notes are deleted and without fetching each user's wrapped master key. Tradeoff: anyone with service role + RSA unwrap can decrypt all feedback snapshots.

2. **Access controls:** Restrict service role credentials and `RSA_PRIVATE_KEY` to backend runtime and audited ops tooling. Do not expose decrypt paths to authenticated user JWTs or the FE.

3. **No snapshot in API responses:** Prevents accidental PHI leakage to the client beyond what the edit page already shows from the live note.

4. **Append-only audit trail:** Rows are immutable events; `created_at` is the rating timestamp. No `note_updated_at` or content hash — the snapshot is the source of truth for “what was rated.”

5. **Logical `note_id`:** After purge, IDs may not resolve to a live row. Do not rely on joins to `notes` for review workflows.

6. **HTTPS + Bearer JWT:** Same as all `/api/notes` routes.

---

## Implementation notes

### Controller checklist

- [ ] Validate `note_id` bigint (reuse `isValidBigInt` from `notesController.js`)
- [ ] Verify note exists and `note.user_id === request.user.id`
- [ ] `getOrCreateUserMasterKey` → decrypt note text
- [ ] `getSystemMasterKey` → encrypt snapshot (+ feedback text if present)
- [ ] Insert via user-scoped Supabase client (RLS INSERT policy)
- [ ] Return stripped response (no encryption fields)

### Validation (Zod)

```javascript
// Suggested shape
{
  rating: z.enum(['positive', 'negative']),
  feedback_text: z.string().optional(),
}
```

### Tests

- POST happy path (positive / negative, with and without `feedback_text`)
- 404 for wrong user / missing note
- 400 for invalid rating
- Round-trip: insert via API, read row with service role, decrypt snapshot with system key matches submitted note text

---

## Related code

| Area | Location |
|------|----------|
| Notes CRUD + user-key encrypt | `src/fastify/controllers/notesController.js` |
| System master key | `src/fastify/controllers/userSecurityConfigController.js` → `getSystemMasterKey()` |
| AES helpers | `src/utils/encryptionUtils.js` → `encryptNoteText`, `decryptNoteText` |
| Encounter purge (deletes notes) | `src/utils/encounterArchivePurge.js` |
| RLS reference (insert-only authenticated) | `sql/policies/internalAccess_RLS.sql`, `sql/migrations/20260620_baa_versions_and_acceptances.sql` |
