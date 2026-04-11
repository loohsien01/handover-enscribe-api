# Prompt LLM API — frontend migration guide

This document describes HTTP API changes for SOAP note generation (prompt LLM) and note template extraction. Use it to update client code, environment variables, and API route constants.

All paths below assume the Fastify server base URL (for example `https://api.example.com`). Authenticated routes require a valid JWT: `Authorization: Bearer <access_token>`.

---

## 1. Breaking change: job creation URL under `/api/jobs`

### Removed (no longer exists)

| Method | Path | Notes |
|--------|------|--------|
| `POST` | `/api/jobs/prompt-llm` | **Removed.** This endpoint is not registered anymore. |

### What to use instead

Create a SOAP generation job with:

| Method | Path |
|--------|------|
| `POST` | `/api/jobs/prompt-llm/generate-note` |

There is no separate `/api/prompt-llm/generate-note` route — create and poll both live under `/api/jobs/prompt-llm/...` so the flow stays in one namespace.

**Frontend action:** replace any `POST` to `/api/jobs/prompt-llm` with `POST /api/jobs/prompt-llm/generate-note`.

---

## 2. Polling for job status and results

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/jobs/prompt-llm/:jobId` | Poll job status |
| `GET` | `/api/jobs/prompt-llm/:jobId?includeResult=true` | Same, plus parsed SOAP when `status` is `complete` |

Path parameter `jobId` is the UUID returned when creating the job.

Jobs created with **`POST /api/jobs/prompt-llm/generate-and-save-note`** may include, when `status` is `complete` and persistence succeeded:

- `note_id` — id of the new note (resolve patient encounter via the note row, e.g. `notes.patientEncounter_id`, or your existing note/encounter APIs).

If generation succeeded but persist failed, the job is still `complete` with SOAP (`includeResult=true`); `note_id` is omitted. Ensure `jobs.note_id` exists (see `sql/migrations/add_jobs_note_id.sql` if upgrading an older database).

When `note_id` is present, **`GET /api/jobs/prompt-llm/:jobId/encounter-bundle`** returns the same JSON shape as **`POST /api/patient-encounters/complete`**: `{ patientEncounter, recording, note }` (decrypted fields). Returns **`404`** if the job has no `note_id` (generate-only job, or persist not run yet / failed).

---

## 3. Request and response contracts (generate note)

### Create job

- **Method:** `POST`
- **Path:** `/api/jobs/prompt-llm/generate-note`
- **Content-Type:** `application/json`
- **Headers:** `Authorization: Bearer <token>`

**Body (JSON):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `recording_file_path` | `string` | Yes | Storage path to the audio recording (same as before). |
| `noteTemplate_id` | `number` / `bigint` / string coerced to `bigint` | No | Optional template for structured SOAP output. |

**Success:** `202 Accepted`

```json
{
  "id": "<job-uuid>",
  "status": "pending"
}
```

**Common errors:** `400` (validation / Zod error in `error`), `401` (auth), `500` (server).

**Transcript dedup:** For the same authenticated user and `recording_file_path`, if another job already has `transcript_text` and status `generating` or `complete`, a new job **reuses that transcript** and skips audio transcription (Deepgram). PHI is still masked for the new run (AWS Comprehend), then the LLM runs as usual — useful for retries or parallel flows with different templates.

### Poll job

- **GET** `/api/jobs/prompt-llm/:jobId`
- Optional query: `includeResult=true` to include parsed `soap_note` when complete.

Response shape and job statuses (`pending`, `transcribing`, `generating`, `complete`, `error`) are unchanged from the previous job-based design, except for optional `note_id` on jobs created via **generate-and-save-note** (see section 2).

---

## 3b. Generate and save note (optional flow)

Use this when the product path is: transcribe → generate SOAP → **atomically** create patient encounter + recording + note (same persistence as `POST /api/patient-encounters/complete`).

- **Method:** `POST`
- **Path:** `/api/jobs/prompt-llm/generate-and-save-note`
- **Headers:** `Authorization: Bearer <token>`

**Body (JSON):** same fields as `generate-note`, plus:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `patient_encounter_name` | `string` | Yes | Display name for the new patient encounter (stored encrypted). |

**Success:** `202 Accepted` with `{ "id": "<job-uuid>", "status": "pending" }` — poll the same way as `generate-note`. After `note_id` appears on the job poll response, call **`GET /api/jobs/prompt-llm/:jobId/encounter-bundle`** for the full saved bundle.

**Note text stored:** the stringified JSON SOAP payload (same as `jobs.soap_note_text`), encrypted with the user master key inside `create_patient_encounter_complete`.

---

## 4. Note template LLM extraction (PDF preview)

### Canonical endpoint

| Method | Path |
|--------|------|
| `POST` | `/api/note-templates/llm-extract` |

Multipart upload of a PDF; returns proposed section structure for preview only (nothing persisted). Same behavior as the old prompt-LLM–scoped routes.

### Removed (no longer exists)

| Method | Path |
|--------|------|
| `POST` | `/api/prompt-llm/extract-note-template` |
| `POST` | `/api/extract-note-template` |

**Frontend action:** use only `POST /api/note-templates/llm-extract`.

**Request:**

- `Content-Type:` `multipart/form-data`
- Field name: `file` (PDF; supported media type is `application/pdf`)
- Header: `Authorization: Bearer <token>`

**Success:** `200` with JSON body `{ "sections": [ { "name", "layout", "details" }, ... ] }`.

---

## 5. Suggested frontend checklist

- [ ] Replace `POST /api/jobs/prompt-llm` with `POST /api/jobs/prompt-llm/generate-note`.
- [ ] Remove any use of `POST /api/prompt-llm/generate-note` if you adopted it during a short overlap — that route is not registered; use only the jobs path above.
- [ ] Search the codebase for hardcoded strings: `"/api/jobs/prompt-llm"` used with **POST** without `generate-note` (GET polling URLs stay the same).
- [ ] Replace template extraction calls with `POST /api/note-templates/llm-extract` (remove `/api/prompt-llm/extract-note-template` and `/api/extract-note-template`).
- [ ] Update OpenAPI / generated clients / `API_BASE` route maps if applicable.
- [ ] Re-test: create job → poll until `complete` → optional `includeResult=true` for SOAP payload; re-test PDF extract.

---

## 6. Quick reference (current surface)

| Action | Method | Path |
|--------|--------|------|
| Create SOAP job | `POST` | `/api/jobs/prompt-llm/generate-note` |
| Create SOAP job + save encounter when done | `POST` | `/api/jobs/prompt-llm/generate-and-save-note` |
| Poll job | `GET` | `/api/jobs/prompt-llm/:jobId` |
| Saved encounter bundle (after `note_id` set) | `GET` | `/api/jobs/prompt-llm/:jobId/encounter-bundle` |
| LLM extract template sections from PDF (preview) | `POST` | `/api/note-templates/llm-extract` |

---

*Generated for the enscribe-api Fastify service. If behavior diverges, prefer the route definitions in `src/fastify/server.js`, `src/fastify/routes/noteTemplates.js`, and `src/fastify/routes/promptLlmJobs.js`.*
