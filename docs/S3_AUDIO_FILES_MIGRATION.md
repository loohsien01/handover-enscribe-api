# S3 migration: `audio-files` (Supabase Storage → AWS S3)

Walkthrough for moving **live** recording blobs off Supabase Storage bucket `audio-files` onto S3. Auth stays on Supabase during this step; only the blob layer changes.

**Related:** [SUPABASE_TO_AWS_MIGRATION.md](./SUPABASE_TO_AWS_MIGRATION.md) (recommended **first** migration step), [retention_archival (Supabase_to_S3).md](./retention_archival%20(Supabase_to_S3).md) (cold archive track).

---

## Migration roadmap (all parts)

| Part | Name | Type | Ship when | User impact |
|------|------|------|-----------|-------------|
| **1** | Create recordings bucket | AWS infra | Before code | None |
| **2** | CORS | AWS infra | Before browser upload to S3 | None until cutover |
| **3** | IAM (EC2 instance role + dev user) | AWS infra | Before code / smoke | None |
| **4** | Lifecycle rules (optional) | AWS infra | Anytime | None |
| **5** | Object key layout | Design | N/A (doc only) | None |
| **6** | Code changes (API + jobs) | **Code PR(s)** | **Before cutover** — default `RECORDINGS_STORAGE_BACKEND=supabase` | **None** until flag flipped |
| **6.6** | Testing (within Part 6) | Verify locally/staging | With Part 6 PRs | None |
| **7** | Data migration (Supabase → S3) | Script + ops | **At cutover** | None if dual-read on |
| **8** | Cutover (flip env flag) | **Ops / env only** | When ready | **Yes** — traffic moves to S3 |
| **9** | Smoke test | Verify infra | After Parts 1–3 (before or with Part 6) | None |
| **10** | HIPAA / BAA notes | Compliance | Anytime | None |
| **11** | Deprecate Supabase storage | **Code cleanup PR** | After confidence window on `s3` only | None |

### Push strategy (summary)

1. **Ship through cutover − 1** — Parts 1–3 (infra), Part 6 code + tests, default flag `supabase`. Prod behavior unchanged.
2. **Cutover (Part 7 + 8)** — bulk/lazy copy, then flip `RECORDINGS_STORAGE_BACKEND` (`dual-read` → `s3`). Mostly env + migration script; no large code deploy required if Part 6 is already merged.
3. **Part 11 later** — remove flag and all Supabase `audio-files` code paths once S3-only is stable.

### Auth + per-user layout (unchanged by S3)

- **JWT** gates API routes (`fastify.authenticate`); `request.user.id` scopes all paths.
- **Upload:** client sends `{ filename }` only; API builds `{userId}/{filename}` from JWT.
- **Download / delete:** client sends `{ path: "userId/filename" }`; API rejects if `pathUserId !== user.id`.
- **Presigned URL** (Supabase or S3) is time-limited HTTPS for one object — no JWT embedded in the URL. Authorization happens at the API before minting the URL.
- **S3 layout:** one bucket, keys `{userId}/{filename}` (not separate buckets per user).

---

## What changes vs what stays the same

| Layer | During S3 migration |
|-------|---------------------|
| **Auth** | Unchanged (Supabase JWT) |
| **Postgres** | Unchanged (`recordings.recording_file_path` still `{userId}/{filename}`) |
| **API contract** | Unchanged (`signedUrl`, `path`, `expiresIn` — FE keeps same flow) |
| **Blob storage** | Supabase Storage → **S3 presigned URLs** |

### Current flow (Supabase)

1. `POST /api/recordings/create-signed-upload-url` → Supabase `createSignedUploadUrl`
2. Browser **PUT**s audio directly to Supabase URL
3. Path stored in DB: `{userUUID}/{filename}` (e.g. `a1b2…/visit-01.mp3`)
4. Download: `createSignedUrl` / encounter flows → Supabase `createSignedUrl`

### Target flow (S3)

1. Same API routes
2. API generates **S3 presigned PUT** (upload) or **presigned GET** (download)
3. Same path string in DB → S3 **object key** = `{userId}/{filename}`
4. Cleanup / archive jobs updated to use S3 SDK instead of `supabase.storage`

---

## Bucket strategy: separate from archive

You already have **`AWS_ARCHIVE_S3_BUCKET`** for retention (`archive/storage/…`, `archive/encounter-bundles/…`).

**Recommendation:** create a **second bucket** for hot recordings.

| Bucket | Purpose | Example name |
|--------|---------|--------------|
| Archive (existing) | Cold retention, JSONL bundles | `enscribe-archive-prod` |
| **Recordings (new)** | Live upload/download | `enscribe-recordings-prod` |

Why separate:

- Different lifecycle (hot vs Glacier-eligible archive)
- Clearer IAM and cost attribution
- Archive jobs keep writing under `archive/` without mixing user paths

Env var to add:

```bash
AWS_RECORDINGS_S3_BUCKET=enscribe-recordings-prod
```

(Keep `AWS_ARCHIVE_S3_BUCKET` as-is.)

---

## Part 1 — AWS Console: create the recordings bucket

**Region:** same as EC2 (`us-east-1` / `AWS_REGION`).

### Step 1 — Open S3

1. AWS Console → **S3** → **Create bucket**

### Step 2 — General configuration

| Field | Value |
|-------|-------|
| **Bucket name** | Globally unique, e.g. `enscribe-recordings-prod` |
| **AWS Region** | `us-east-1` (match EC2) |
| **Bucket type** | General purpose |
| **Object Ownership** | **Bucket owner enforced** (recommended) |

### Step 3 — Block Public Access

Leave **all four** “Block public access” options **ON**.

Access is only via **presigned URLs** generated by your API — no public bucket policy.

### Step 4 — Bucket Versioning

| Environment | Suggestion |
|-------------|------------|
| Prod | **Enable** versioning (accidental overwrite recovery) |
| Dev | Optional off to save cost |

### Step 5 — Default encryption

| Field | Value |
|-------|-------|
| Encryption type | **SSE-S3** (or **SSE-KMS** if your HIPAA policy requires CMK) |
| Bucket Key | On if using KMS (reduces KMS cost) |

### Step 6 — Advanced (optional)

- **Object Lock**: off unless compliance requires WORM
- **Tags**: e.g. `Environment=prod`, `Application=enscribe`, `DataClass=phi`

### Step 7 — Create bucket

---

## Part 2 — CORS (required for browser upload)

The SPA uploads with **PUT** to the presigned URL (same as Supabase today). S3 must allow your **frontend origins**.

**S3** → your bucket → **Permissions** → **Cross-origin resource sharing (CORS)** → **Edit**

Example configuration (adjust origins to match [cors.js](../src/fastify/middleware/cors.js)):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedOrigins": [
      "https://app.enscribe.online",
      "https://www.app.enscribe.online",
      "https://enscribe.online",
      "https://enscribe-web.vercel.app",
      "http://localhost:3000"
    ],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

| Method | Why |
|--------|-----|
| **PUT** | Presigned upload from browser |
| **GET** | Presigned download (if browser fetches audio directly) |
| **HEAD** | Some clients check object before upload |

Mobile apps often have **no Origin** header — they use presigned URLs too; CORS does not apply to native HTTP clients.

---

## Part 3 — IAM (EC2 + local dev)

Your API already uses `getAwsSdkBaseClientConfig()` — EC2 **instance profile** in prod, `AWS_ACTIONS_ACCESS_KEY_*` locally.

### EC2 instance role (production)

**IAM** → **Roles** → (your EC2 role) → **Add permissions** → **Create inline policy**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnscribeRecordingsBucket",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": "arn:aws:s3:::enscribe-recordings-prod/*"
    },
    {
      "Sid": "EnscribeRecordingsList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::enscribe-recordings-prod",
      "Condition": {
        "StringLike": {
          "s3:prefix": ["*"]
        }
      }
    }
  ]
}
```

Replace bucket name with yours. Keep existing archive bucket permissions on the same role.

**Note:** IAM has no `s3:HeadObject` action — the S3 `HeadObject` API is authorized by **`s3:GetObject`** on the object ARN.

### Local dev IAM user

Same policy on the user behind `AWS_ACTIONS_ACCESS_KEY_ID` (already used for Bedrock / archive S3).

**Important:** attach the policy to **both** principals:

| Principal | Used by | Smoke test |
|-----------|---------|------------|
| IAM user (e.g. `enscribe-api-prod-ec2-role`) | Local dev — `AWS_ACTIONS_ACCESS_KEY_*` in `.env.local` | `npm run smoke:recordings-s3` on laptop |
| EC2 instance role (e.g. `enscribe-api-ec2-instance-role`) | Production — instance profile, no dev keys | `node sql/scripts/smoke-recordings-s3.mjs` on EC2 |

Local smoke passing does **not** prove EC2 IAM; CORS errors do **not** affect server-side SDK smoke tests (CORS is browser-only).

### What you do **not** need

- Public bucket policy
- CloudFront (optional later for download CDN — not required for v1)
- S3 Object Lambda

---

## Part 4 — Lifecycle rules (optional, prod)

**S3** → bucket → **Management** → **Lifecycle rules**

For the **recordings** bucket (hot):

| Rule | Action |
|------|--------|
| Transition to IA | Optional after 90 days if you want cheaper storage for old but not archived files |
| Expiration | **Do not** auto-delete — your app/archive jobs own deletion |

Keep aggressive lifecycle on **`AWS_ARCHIVE_S3_BUCKET`** only.

---

## Part 5 — Object key layout

Match Supabase today — **no DB path migration** required:

```text
s3://enscribe-recordings-prod/{userId}/{filename}
```

Examples:

```text
a1b2c3d4-….-….mp3   →   key = a1b2c3d4-…/visit-2026-06-30.mp3
```

`recordings.recording_file_path` stays `userId/filename`. Code already strips optional `audio-files/` prefix in several places.

Optional future prefix (requires DB migration): `recordings/{userId}/{filename}` — skip for v1.

---

## Part 6 — Code changes (API)

**Goal:** Replace Supabase Storage calls with S3 behind a feature flag, without changing routes, response shapes, DB paths, or JWT auth.

**Default until cutover:** `RECORDINGS_STORAGE_BACKEND=supabase` — prod behavior unchanged after merge.

Part 6 sub-steps **6.1–6.5** are code work (ship before cutover). **6.6** is testing. **Cutover is Part 7 + 8**, not Part 6.

---

### 6.1 — Foundation (new shared layer)

**`src/utils/recordingsStorageBackend.js`** — read flag:

```bash
RECORDINGS_STORAGE_BACKEND=supabase   # default until cutover
RECORDINGS_STORAGE_BACKEND=s3         # S3 only (reads + writes)
RECORDINGS_STORAGE_BACKEND=dual-read  # reads: try S3, fallback Supabase; writes: follow s3 rules
```

Helpers: `getRecordingsStorageBackend()`, `useS3ForWrites()`, `useS3ForReads()`.

**`src/utils/recordingsS3Client.js`** — mirror [archiveS3Client.js](../src/utils/archiveS3Client.js):

| Function | S3 API | Replaces |
|----------|--------|----------|
| `getRecordingsS3Client()` | `S3Client` | — |
| `getRecordingsBucket()` | env `AWS_RECORDINGS_S3_BUCKET` | — |
| `normalizeRecordingStorageKey(path)` | strip `audio-files/`, leading `/` | duplicated in 4+ files today |
| `createPresignedUploadUrl(key, opts)` | `PutObjectCommand` + presigner | `createSignedUploadUrl` |
| `createPresignedDownloadUrl(key, expiresIn)` | `GetObjectCommand` + presigner | `createSignedUrl` |
| `objectExists(key)` | `HeadObjectCommand` | collision check via `storage.list` |
| `listUserObjects(userId, opts)` | `ListObjectsV2` prefix `{userId}/` | `storage.list(userId, …)` |
| `listRootUserPrefixes()` | `ListObjectsV2` delimiter `/` | root list in cleanup |
| `deleteObject(key)` | `DeleteObjectCommand` | `storage.remove` |
| `downloadObject(key)` | `GetObjectCommand` → `Buffer` | `storage.download` |

Add npm dependency: `@aws-sdk/s3-request-presigner` ( `@aws-sdk/client-s3` already present).

**`src/utils/recordingsStorage.js`** — facade used by controllers/jobs:

```text
createUploadUrl / createDownloadUrl / objectExists / listUserObjects / deleteObject / downloadObject
```

Branches on `RECORDINGS_STORAGE_BACKEND`. Controllers keep JWT + ownership checks; they call the facade instead of `supabase.storage.from('audio-files')`.

---

### 6.2 — Hot path (user-facing API)

| File | Function | Change |
|------|----------|--------|
| [recordingsController.js](../src/fastify/controllers/recordingsController.js) | `uploadRecordingUrl` | `objectExists` loop + presigned PUT; path still `{user.id}/{filename}` |
| | `createSignedUrl` | presigned GET; ownership check unchanged |
| | `getRecordings` (single) | refresh cached signed URL via facade |
| | `getRecordingsAttachments` | `listUserObjects(userId)` with S3 pagination |
| | `deleteRecording` | `deleteObject` |
| | `deleteRecordingsStorage` | bulk `deleteObject`; 404 → `deleted` (idempotent) |
| [patientEncountersController.js](../src/fastify/controllers/patientEncountersController.js) | encounter bundle flows | presigned GET for `recording_file_signed_url` refresh |
| [promptLlmProcessor.js](../src/fastify/processors/promptLlmProcessor.js) | transcription input URL | facade download URL; **dual-read** for not-yet-migrated files |

---

### 6.3 — Background / cleanup jobs

Can ship in the same PR as 6.2 or a follow-up PR (still default `supabase`).

| File | Operations | Notes |
|------|------------|-------|
| [unattachedStorageCleanup.js](../src/utils/unattachedStorageCleanup.js) | list root prefixes, list per user, bulk delete | Largest refactor — S3 `ListObjectsV2`; use `LastModified` for age gate |
| [encounterArchivePurge.js](../src/utils/encounterArchivePurge.js) | download live recording → archive bucket | Download from recordings S3 (dual-read); archive bucket unchanged |
| [archiveStorageManifestSync.js](../src/utils/archiveStorageManifestSync.js) | lists old Supabase objects | **Defer** or keep Supabase-only until Part 11 |

---

### 6.4 — Env + deploy

| Variable | Default | Where |
|----------|---------|-------|
| `AWS_RECORDINGS_S3_BUCKET` | `enscribe-recordings-prod` | `.env.local`, GitHub secret, EC2 `.env.local` ([deploy.yml](../.github/workflows/deploy.yml)) |
| `RECORDINGS_STORAGE_BACKEND` | `supabase` | `.env.local`, EC2 `.env.local` (add to deploy template when Part 6 ships) |

No GitHub secret required for the backend flag if deploy template hardcodes `supabase` until cutover.

---

### 6.5 — Implementation order (Phases A–D)

```text
Phase A — Foundation (no behavior change)
  1. recordingsS3Client.js + normalizeRecordingStorageKey
  2. recordingsStorageBackend.js + recordingsStorage.js facade
  3. Add @aws-sdk/s3-request-presigner

Phase B — Hot path (flag still supabase)
  4. uploadRecordingUrl + createSignedUrl
  5. getRecordings signed URL refresh
  6. patientEncountersController signed URLs
  7. promptLlmProcessor download URL

Phase C — Deletes + listings
  8. deleteRecording + deleteRecordingsStorage
  9. getRecordingsAttachments list

Phase D — Jobs
  10. unattachedStorageCleanup
  11. encounterArchivePurge download source
```

**Suggested PR split:**

| PR | Scope |
|----|-------|
| **PR 1** | Phase A + B (facade + upload/download/hot path) |
| **PR 2** (optional) | Phase C + D (attachments, deletes, cleanup/archive jobs) |

---

### 6.6 — Testing (before cutover)

| Test | Command / action |
|------|------------------|
| Existing suite | `npm run test:recordings` — must pass with default `supabase` |
| S3 upload E2E | `RECORDINGS_STORAGE_BACKEND=s3` → signed upload URL → PUT → create recording row |
| Dual-read | object only in Supabase → download URL still works |
| Encounter playback | GET encounter with recording → signed URL plays |
| Transcription | prompt-llm job gets valid audio URL |
| Manual | upload → create encounter → play/download → delete |

---

## Part 7 — Data migration (Supabase → S3)

Run at **cutover** (after Part 6 code is deployed). Not required to merge Part 6 code.

### Recommended: repo script

```bash
# Dry run first
npm run migrate:audio-files-to-recordings-s3 -- --dry-run

# Full copy (or --prefix=<userId> / --cap=N for partial runs)
npm run migrate:audio-files-to-recordings-s3
```

Script: [migrate-audio-files-to-recordings-s3.mjs](../sql/scripts/migrate-audio-files-to-recordings-s3.mjs) — lists Supabase `audio-files`, skips keys already on S3 with matching size, copies the rest, writes a summary under `sql/scripts/reports/audio-files-migration/`.

Requires: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AWS_RECORDINGS_S3_BUCKET`, AWS credentials (same as smoke test).

### Option A — One-time sync script

For each object in Supabase `audio-files`:

1. `download` from Supabase Storage
2. `PutObject` to S3 with same key `{userId}/{filename}`
3. Verify `HeadObject` size matches
4. Log failures for retry

You can extend `sql/scripts/inventory-audio-files-storage.mjs` or archive tooling.

### Option B — Lazy migration

- New uploads → S3 only (`RECORDINGS_STORAGE_BACKEND=s3`)
- Reads → dual-read (S3 then Supabase)
- Background job copies missing keys
- After inventory clean, set dual-read off

### Option C — Archive pipeline already copied some objects

`archive/storage/{id}` keys are **not** the same as live `{userId}/{filename}` paths. Do not point playback at archive keys without a mapping job.

---

## Part 8 — Cutover (ops + env)

**This is not a code deploy.** Flip flags and run migration after Part 6 is merged and Part 6.6 tests pass.

### Pre-cutover checklist (Parts 1–6)

**AWS infra (Parts 1–3, 9)**

- [x] Bucket created (`enscribe-recordings-prod`)
- [x] Block public access: all on
- [ ] Encryption enabled (SSE-S3 or KMS) — verify in console
- [x] CORS configured for FE origins
- [x] IAM on EC2 instance role (`enscribe-api-ec2-instance-role`) + dev IAM user
- [x] `AWS_RECORDINGS_S3_BUCKET` in GitHub secrets + EC2 env (via [deploy.yml](../.github/workflows/deploy.yml))
- [x] EC2 smoke test passing (`sql/scripts/smoke-recordings-s3.mjs`)

**Code + test (Part 6)**

- [x] Presigned PUT/GET implemented (facade + controllers)
- [x] `RECORDINGS_STORAGE_BACKEND` flag (default `supabase`)
- [ ] `npm run test:recordings`
- [ ] Manual: upload → create encounter → play/download → delete (with `s3` in staging)

**Part 7 (ready, run at cutover)**

- [x] Migration script: `npm run migrate:audio-files-to-recordings-s3`
- [ ] Execute bulk copy before flipping flag

### Cutover steps (staging → prod)

1. **Part 7** — Run bulk copy Supabase → S3 (Option A) or enable lazy migration (Option B).
2. Staging: set `RECORDINGS_STORAGE_BACKEND=dual-read` → smoke all flows.
3. Prod: new uploads to S3 first (`s3` for writes or full `s3`), reads on `dual-read`.
4. Confirm cleanup/archive jobs target S3 (Part 6 Phase D).
5. Prod: switch reads to `s3` only when inventory is fully copied.
6. Disable Supabase `audio-files` writes; keep bucket read-only for a confidence window (see Part 11).

**Env-only changes** — update EC2 `.env.local` / GitHub deploy secret or manual EC2 env; restart PM2. No Part 6 code changes required if already merged.

---

## Part 9 — Smoke test (script or AWS CLI)

### Recommended: repo script

Uses the same SDK + credentials as the API (`awsSdkBaseClientConfig.js`).

```bash
# .env.local
AWS_RECORDINGS_S3_BUCKET=enscribe-recordings-prod
AWS_REGION=us-east-1
AWS_ACTIONS_ACCESS_KEY_ID=...
AWS_ACTIONS_SECRET_ACCESS_KEY=...

npm run smoke:recordings-s3
```

Runs PutObject → HeadObject → GetObject → ListObjectsV2 → DeleteObject on `smoke-test/{uuid}/smoke.txt`, then confirms delete.

On EC2 (instance role, no dev keys):

```bash
NODE_ENV=production AWS_RECORDINGS_S3_BUCKET=enscribe-recordings-prod node sql/scripts/smoke-recordings-s3.mjs
```

### Optional: AWS CLI (CloudShell, laptop, or EC2)

```bash
aws s3 cp ./test.mp3 s3://enscribe-recordings-prod/TEST_USER_ID/test.mp3
aws s3api head-object --bucket enscribe-recordings-prod --key TEST_USER_ID/test.mp3
aws s3 rm s3://enscribe-recordings-prod/TEST_USER_ID/test.mp3
```

---

## Part 10 — HIPAA / BAA notes

- Bucket in **same AWS account** covered by your BAA
- **Encryption at rest** (SSE-S3 minimum)
- **TLS in transit** (default for S3 presigned HTTPS URLs)
- **No public access**
- **CloudTrail** data events on bucket (optional audit): S3 → Properties → Event notifications / CloudTrail data event selector for `arn:aws:s3:::enscribe-recordings-prod`
- Access logs: optional S3 server access logging to a logging bucket

---

## Part 11 — Deprecate Supabase storage (post-cutover cleanup)

After a confidence window on `RECORDINGS_STORAGE_BACKEND=s3` only (e.g. 2–4 weeks, no dual-read issues):

| Task | Outcome |
|------|---------|
| Remove `RECORDINGS_STORAGE_BACKEND` env var and all branching | S3-only code paths |
| Delete Supabase `audio-files` branches in facade, controllers, jobs | No `supabase.storage.from('audio-files')` for live recordings |
| Remove dual-read fallback | No Supabase download/list/delete for live blobs |
| Retire or repoint `archiveStorageManifestSync.js` | If it only listed Supabase live paths |
| Optional infra | Disable Supabase `audio-files` writes / bucket policies |

Ship as a **small cleanup PR** once S3-only is proven stable. The flag from Part 6 is migration scaffolding, not the long-term design.

---

## FAQ

### Does S3 migration require Cognito?

**No.** Supabase auth unchanged.

### Same bucket as `AWS_ARCHIVE_S3_BUCKET`?

Possible (`recordings/` vs `archive/` prefix) but **not recommended** — use two buckets.

### Will FE need changes?

**Minimal** if API response shape stays `{ signedUrl, path, expiresIn }`. Upload still PUTs to returned URL. Verify CORS if upload fails with browser network error.

### What breaks if we only move S3 and forget dual-read?

Recordings not yet copied return 404 on download until bulk migration completes.

### When do I push code vs flip env?

- **Push code (Part 6)** through cutover − 1 with default `supabase` — safe anytime.
- **Cutover (Part 7 + 8)** — data copy + flip `RECORDINGS_STORAGE_BACKEND`; mostly ops, later.
- **Part 11** — remove Supabase code after confidence window; separate cleanup PR.

### Local smoke passed but EC2 failed with AccessDenied?

Dev IAM user and EC2 instance role are **different principals**. Attach the recordings bucket policy to both (see Part 3).

---

## Related env summary

```bash
# Existing
AWS_REGION=us-east-1
AWS_ARCHIVE_S3_BUCKET=enscribe-archive-prod
AWS_ACTIONS_ACCESS_KEY_ID=...      # dev only
AWS_ACTIONS_SECRET_ACCESS_KEY=...  # dev only

# New
AWS_RECORDINGS_S3_BUCKET=enscribe-recordings-prod
RECORDINGS_STORAGE_BACKEND=supabase   # → s3 when ready
```
