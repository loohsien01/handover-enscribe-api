# Retention + Archival (Supabase → S3)

## Overview

Two **independent** pipelines share the same ideas (frozen cutoff, idempotent steps, Postgres as lifecycle source of truth, S3 as archive) but **different S3 layouts and tracking tables**:

| Track | What moves | Tracking table | Typical job names |
|-------|------------|------------------|-------------------|
| **Storage retention** | Orphan or cold **Supabase Storage** objects (`audio-files`, paths from Storage `list()`) | `archive.storage_objects` | `storage_manifest`, `storage_archive` |
| **Encounter bundle archive/purge** (planned) | One **patient encounter** subtree (Postgres rows + the **recording** file tied to that encounter) | New table in `archive` (mirror of `storage_objects` *shape*, not the same rows) | e.g. `encounter_manifest`, `encounter_archive` (names TBD in code) |

Goals:

* Nothing is removed from Supabase until a **durable** copy exists in S3 (or the run fails safely and retries).
* **No cross-system transaction** between Postgres, Storage, and S3; recover with **status fields + idempotent S3 keys**.

---

## Core principles

* **Supabase** = live system of record.
* **S3** = long-lived archive; retries may **overwrite** the same key safely.
* Jobs are **state-driven** (rows in `archive` schema + app tables), not in-memory.
* **`archive.job_runs`** holds a **frozen `cutoff`** per run; eligibility uses that cutoff, not “now” mid-run.

---

## Retention policy

### Storage track (`storage_manifest` / `storage_archive`)

Objects are candidates when Storage metadata says they are old enough relative to the run’s cutoff (see `src/utils/archiveStorageManifestSync.js`). Rows live in **`archive.storage_objects`** with `updated_at` from Storage; eligibility for purge is `updated_at < cutoff` and `archived_at` IS NULL.

`storage_manifest` **does not** participate in “last user touch” for encounters; it only reflects **object** timestamps from Storage listing.

### Encounter bundle track (design)

Eligibility is based on **inactivity across the encounter subtree**, not on `jobs` or on `archive.storage_objects`.

Define **`last_touched_at`** (computed when enqueueing a bundle) as the latest timestamp among:

* **`patientEncounters.updated_at`** (and `created_at` if you treat null `updated_at` as missing).
* **`MAX(notes.updated_at)`** for all `notes."patientEncounter_id"` = this encounter.
* **`MAX(recordings.created_at)`** for all `recordings."patientEncounter_id"` = this encounter (recordings use **`created_at`**, not `updated_at`, for this signal).
* **`MAX(transcripts.updated_at)`** for transcripts whose **`recording_id`** belongs to a **`recordings`** row for this encounter.

Implement with Postgres **`GREATEST(...)`** plus **`COALESCE(..., '-infinity'::timestamptz)`** (or filter nulls) so missing children do not collapse the whole expression to null.

**Explicitly excluded from `last_touched_at`:**

* **`jobs`** — correlate by `recording_file_path` only during **archive/purge**; do **not** use `jobs.updated_at` (or any job timestamp) in `GREATEST`. If no row matches the path, **skip** job cleanup for that bundle.
* **Storage listing / `archive.storage_objects.updated_at`** — not part of “user last touched this encounter.” The recording file may still be archived **as part of the bundle** using `recordings.recording_file_path`, even if a separate `storage_archive` job uses a different prefix.

**Recordings:** use **`created_at`** (not `updated_at`) for the recording row in the `GREATEST` list, per current inserts from `create_patient_encounter_complete`.

**Transcripts:** include only through **`recordings`** (`transcripts.recording_id` → `recordings.id` where `recordings."patientEncounter_id"` matches).

**Subtree to archive then delete (design):** `patientEncounters`, dependent **`notes`**, **`recordings`**, **`transcripts`** (via recordings), and matching **`jobs`** by `recording_file_path` when present. Legacy **`soapNotes`** are out of scope unless you add them later.

---

## Job runs (`archive.job_runs`)

Each internal task inserts a row with `job_name`, frozen **`cutoff`**, `status` (`running` → `success` / `failed`), and timestamps. Implementation today uses this for `storage_manifest` and `storage_archive`; encounter tasks should do the same.

---

## Storage archival (implemented)

Supabase Storage does not give you durable lifecycle metadata in your app DB unless you copy it there.

### Tracking: `archive.storage_objects`

Seeded/updated by **`storage_manifest`** from Storage `list()` (see code). Columns used in code include at least: `id` (UUID), `bucket_id`, `path`, `user_id`, `updated_at`, `archived_at`.

### Processing: `storage_archive`

1. Insert `archive.job_runs` with `job_name = 'storage_archive'` and frozen cutoff.
2. Select from **`archive.storage_objects`** where `updated_at < cutoff` and `archived_at` IS NULL (optional batch limit).
3. For each row: `download` → **`PutObject`** → `remove` from Storage → set **`archived_at`** (order chosen so failed Storage deletes are retrievable; see code comments in `archiveStoragePurge.js`).
4. Append a **JSONL audit line** per successful object.

**S3 payload key (storage track only):**

```text
archive/storage/{storage_objects.id}
```

**S3 audit manifest (storage track only):**

```text
archive/manifests/YYYY/MM/DD/{job_run_id}.jsonl
```

Example line (conceptual):

```json
{"job_run_id":"…","storage_object_id":"…","user_id":"…","bucket_id":"audio-files","path":"userId/file.mp3","s3_bucket":"…","s3_key":"archive/storage/…","archived_at":"…","bytes":12345}
```

**Immutability:** migration `20260417120000_archive_storage_objects_immutable_when_archived.sql` (referenced in repo history) blocks destructive changes to `archive.storage_objects` rows once **`archived_at`** is set, so S3 linkage stays auditable.

---

## Encounter bundle archive/purge (design)

This track answers: “archive and remove **one cold patient encounter** and everything tied to it, including the **audio file** referenced by the recording, with artifacts grouped in S3.”

### Tracking table (mirror `storage_objects` *role*)

Add a dedicated table in schema **`archive`** (exact name up to migration; e.g. **`archive.patient_encounter_archive_queue`**) that mirrors the **lifecycle pattern** of `storage_objects`:

* **`id`** — **UUID** primary key. This id is the **stable bundle id**: use it in **S3 key prefixes** for both the uploaded recording bytes and the JSONL that holds serialized DB rows. Retries reuse the same prefix → idempotent overwrites.
* **`patient_encounter_id`** — bigint (or bigint-as-text in JS), the live root row.
* **`user_id`** — owner (for ops, rebuild, and RLS/service-role filtering).
* **`recording_file_path`** — nullable; copy from `recordings` at enqueue time for **rebuild** and for matching **`jobs`**; if null, skip audio upload and skip job correlation for that path.
* **`last_touched_at`** — result of the subtree `GREATEST` rule above, **excluding** jobs and storage-object timestamps.
* **`job_run_id`** — required FK to **`archive.job_runs`**. Frozen retention cutoff comes from **`archive.job_runs.cutoff`** (no duplicate `cutoff` column on the queue row).
* **Status / attempts / errors** — enum: **`pending`** → **`processing`** → **`s3_audio_done`** → **`s3_db_done`** → **`audio_deleted`** (Supabase Storage recording removed) → **`db_deleted`** (live Postgres subtree removed); **`failed`** is terminal until retry via **`UPDATE`** on the same row. S3 object keys are **derived in code** (bucket from env); optional **`archived_at`** locks the row (**UPDATE**/**DELETE** blocked), same idea as `archive.storage_objects`.

**Dedupe:** at most one **open** queue row per encounter (partial unique index on `patient_encounter_id` where `status` is distinct from **`db_deleted`**).

**Migration:** `sql/migrations/20260419120000_archive_patient_encounter_archive_queue_enum_indexes_immutable.sql`

### S3 layout (encounter track — **not** `archive/storage/{id}`)

Keep **recording file** and **DB JSONL** under **one prefix** keyed by the **queue row UUID**, so they stay **together** and **separate** from the **`storage_archive`** layout (`archive/storage/{storage_object_id}`) and from the **storage** audit path (`archive/manifests/…/{job_run_id}.jsonl`).

Suggested convention (**`user_id`** segment only for easier browsing; no date segment in the key):

```text
archive/encounter-bundles/{user_id}/{bundle_id}/recording{ext}
archive/encounter-bundles/{user_id}/{bundle_id}/db-rows.jsonl
```

* **`bundle_id`** = the queue row’s UUID (`id`).
* **`recording{ext}`** — preserve original extension when possible (`.webm`, `.m4a`, …) for easier forensic replay.
* **`db-rows.jsonl`** — one JSON object per line for tables in the bundle (encounter, notes, recordings, transcripts; optional job rows), as written at archive time.

Optional: a small **`manifest.json`** beside them listing keys, etag, and `recording_file_path` for rebuild scripts.

### Processing order (high level)

1. **Enqueue** — compute `last_touched_at`; insert queue row with **`job_run_id`** when `last_touched_at < job_runs.cutoff` (or your chosen rule).
2. **Export audio to S3** — if `recording_file_path` present: download from Supabase Storage → **`PutObject`** under `encounter-bundles/{user_id}/{bundle_id}/`; advance to **`s3_audio_done`** (skip or short-circuit if no path).
3. **Export DB to S3** — read live rows, write **`db-rows.jsonl`** under the same prefix; **`s3_db_done`** (crash-safe before any destructive step).
4. **Remove audio from Supabase Storage** — after S3 copy is durable; **`audio_deleted`** (tolerate already-missing object if `storage_archive` ran first).
5. **Jobs** — `DELETE` for `jobs` matching **`recording_file_path`**; skip if none.
6. **Delete live Postgres** — FK order (e.g. transcripts → recordings → notes → patient encounter); **`db_deleted`**, set **`archived_at`** (and optional **`source_deleted_at`**) so the queue row becomes immutable.
7. **Finalize** `archive.job_runs` for this task if applicable.

---

## Implementation checklist (this repo)

### `archive.job_runs`

* [x] Insert at task start with frozen **`cutoff`** and `status = running`; finalize to `success` / `failed`.

### Storage: `storage_manifest` + `storage_archive`

* [x] **`archive.storage_objects`** seeded/updated from Storage (`src/utils/archiveStorageManifestSync.js`).
* [x] **`storage_archive`** download → S3 `archive/storage/{id}` → Storage remove → `archived_at` + JSONL audit under `archive/manifests/…` (`src/utils/archiveStoragePurge.js`).

**How to run**

* `POST /api/internal/archive-purge/run` with `{"tasks":["storage_manifest","storage_archive"]}` (manifest first).

### Encounter bundle archive/purge

* [x] Migration: **`archive.patient_encounter_archive_queue`** — enum, indexes, **`archived_at`** immutability trigger (`sql/migrations/20260419120000_archive_patient_encounter_archive_queue_enum_indexes_immutable.sql`).
* [x] Task(s): API `POST /api/internal/archive-purge/run` with `tasks: ["encounter_archive"]` (sync) or `async: true` + poll `GET /api/internal/archive-purge/jobs/:jobRunId` — enqueue RPC + worker in `src/utils/encounterArchivePurge.js` (apply RPC migration `20260419140000_…`).
* [x] S3 keys under **`archive/encounter-bundles/{user_id}/{bundle_id}/…`** (see `encounterArchivePurge.js`).
* [x] Jobs cleanup by **`recording_file_path`** (+ `user_id`); jobs excluded from **`last_touched_at`** in SQL enqueue function.

---

## Reliability and failure modes

* **Idempotency:** queue status + fixed S3 prefixes per **`bundle_id`** / **`storage_objects.id`**.
* **S3:** safe to retry `PutObject` to the same key.
* **Halfway failures:** follow the same pattern as storage: do not advance to “live row deleted” until prior stages are durable and recorded on the queue row.

---

## S3 storage class (optional)

For long-term cost: **S3 Glacier Instant Retrieval** (or org default). Lifecycle policies can transition older prefixes to colder tiers.

---

## Mental model

| Piece | Role |
|-------|------|
| `public.patientEncounters` (+ notes, recordings, transcripts, jobs) | Live encounter data |
| `archive.storage_objects` | Lifecycle for **Storage list–driven** objects (`storage_archive`) |
| New **`archive.*` queue table** | Lifecycle for **encounter bundle** archive/purge |
| `archive.job_runs` | Frozen **cutoff** and run outcome per task |
| `archived_at` (per tracking row) | “This tracking row’s work finished” for that track |
| S3 **`archive/storage/{storage_object_id}`** | Payload for **storage** job only |
| S3 **`archive/encounter-bundles/{user_id}/{bundle_id}/…`** | **Recording + DB JSONL** for encounter job |

---

## Summary

* **Storage retention** is implemented: manifest rows → `storage_archive` → keys under **`archive/storage/`** and audit JSONL under **`archive/manifests/`**.
* **Encounter retention** is specified here: subtree **`last_touched_at`** (no jobs, no storage-object timestamps in the max), **`jobs`** handled by **`recording_file_path`** when present, recording row uses **`created_at`**, transcripts via **recordings**, **`job_run_id`** for cutoff, status through **`audio_deleted`** then **`db_deleted`**, S3 prefix **`archive/encounter-bundles/{user_id}/{bundle_id}/…`** co-locating audio and DB export away from **`storage_archive`**.
