# Enscribe API

A comprehensive healthcare management platform built with [Next.js](https://nextjs.org) for managing patient encounters, SOAP notes, recordings, and transcripts with advanced AI-powered features.

## Overview

Enscribe API is a full-stack telemedicine application designed for healthcare providers to efficiently manage patient interactions, generate clinical documentation, and transcribe medical recordings. The platform integrates with Google Cloud Platform (GCP) and AWS services for transcription, AI processing, and data masking.

## Features

- **Patient Encounter Management** - Create, view, and edit patient encounters
- **SOAP Notes** - Generate and manage SOAP (Subjective, Objective, Assessment, Plan) notes
- **Audio Recording & Transcription** - Record, upload, and transcribe patient interactions
- **AI-Powered Processing** - Integration with Google Gemini and OpenAI for note generation
- **Dot Phrases** - Custom medical phrase templates for quick documentation
- **PHI Masking** - AWS-powered Protected Health Information masking
- **Authentication** - Secure user authentication with email verification
- **Data Privacy** - Row-level security policies in the database
- **Mobile Support** - React Native mobile application

## Project Structure

```
enscribe-api/
├── src/
│   ├── app/              # Next.js App Router pages and layouts
│   ├── components/       # React components
│   ├── hooks/           # Custom React hooks
│   ├── pages/api/       # API routes and endpoints
│   └── utils/           # Utility functions and helpers
├── mobile/              # React Native mobile app
├── public/              # Static assets and client-side scripts
├── sql/                 # Database schemas and triggers
└── keys/                # SSH keys (for deployment)
```

## Getting Started

### Prerequisites

- Node.js 16+ and npm/yarn
- Supabase account for database
- Google Cloud Platform credentials (for transcription)
- AWS credentials (for PHI masking)
- OpenAI API key (optional)

### Installation

```bash
# Install dependencies
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm start
```

#### Optional: extra terminals (Stripe, Redis, worker)

Start these **only when** the feature you are testing depends on them. Port **3001** matches the Fastify default in `npm run dev:fastify`.

| What | Example | When you need it |
|------|---------|------------------|
| **Redis** | Run Redis locally in its own terminal: `redis-server` (listens on 6379 by default), or `docker run --rm -p 6379:6379 redis:7-alpine`. Set `REDIS_URL=redis://127.0.0.1:6379` in `.env.local`. | **Nova AI chat** hot-cache and session flows that expect Redis (see the Nova paragraph under [Environment Variables](#environment-variables)). Most other routes run with Redis omitted. |
| **Stripe CLI** | `stripe listen --forward-to localhost:3001/api/stripe/webhook` — copy the printed signing secret into `STRIPE_WEBHOOK_SECRET` for that dev machine. | **Billing / subscriptions** in test mode: Checkout and subscription lifecycle update the database via webhooks, not only the browser redirect. You do **not** need this just to call `GET /api/me/entitlements` for free-tier data. Details: [docs/STRIPE_BILLING.md](docs/STRIPE_BILLING.md). The secret stays the same across repeated `stripe listen` restarts on the same account and machine. |
| **Nova summarize worker** | `npm run worker:nova-summarize` (uses the same `.env.local` as the API: `REDIS_URL`, Supabase service role, Bedrock, user-key encryption env). | **Background rolling summarization** for long Nova chats: the API enqueues work on Redis; this process drains `nova:summarize:queue` and updates summaries in Postgres. Skip it if you are not testing that path (short threads, or you do not need queued summarization to complete while you develop). Requires Redis. |

## API Endpoints

Stripe subscriptions and organization billing (Fastify): see [docs/STRIPE_BILLING.md](docs/STRIPE_BILLING.md).

Key API routes available in `/src/pages/api/`:

- `auth.js` - Authentication endpoints
- `patient-encounters.js` - Patient encounter CRUD operations
- `soap-notes.js` - SOAP note management
- `recordings.js` - Recording upload/download
- `transcripts.js` - Transcript management
- `dot-phrases.js` - Dot phrase operations
- `gcp/transcribe.js` - Deepgram transcription service
- `aws/mask-phi.js` - AWS PHI masking service

## Database

The application uses Supabase (PostgreSQL) with:
- Row-Level Security (RLS) policies
- Automated triggers for timestamp updates
- Foreign key constraints and referential integrity

See `/sql/` for database schema and policies.

Production app data lives on **Amazon RDS** (VPC-private). See [docs/RDS_POSTGRES_MIGRATION.md](docs/RDS_POSTGRES_MIGRATION.md) for the cutover walkthrough.

### Browsing production RDS (TablePlus on your Mac)

RDS is not reachable from your laptop directly. Use an **SSH tunnel** through the prod EC2 instance, then point TablePlus at `127.0.0.1`.

#### Prerequisites (`.env.local` on your Mac — never commit)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | RDS URI (`*.rds.amazonaws.com`) — password must be **URL-encoded** here (`!` → `%21`, etc.) |
| `DATABASE_URL_LOCAL` | **Mac dev only** — same user/password/db as `DATABASE_URL` but host `127.0.0.1:15432` (SSH tunnel). API + `npm run test:auth` use this while tunnel is running. **Not used on EC2 prod.** Comment out or remove legacy `SUPABASE_DB_DIRECT_URL` so it does not override `DATABASE_URL`. |
| `EC2_DEPLOY_HOST` | `ec2-user@<EC2_PUBLIC_IP>` — check AWS console; updates when instance gets a new public IP |
| `EC2_DEPLOY_SSH_PRIVATE_KEY` | Multiline PEM (same as deploy) — script reads full block from `.env.local` |
| `DB_TUNNEL_MODE=ssh` | Optional; recommended (SSM needs extra IAM) |

#### First-time setup (once per machine)

1. **AWS security group (EC2 instance, not RDS):** inbound **SSH (22)** from your public IP (`/32`). Console → EC2 → instance → Security → edit inbound rules → **My IP**.
2. **TablePlus** — save a connection:
   - Host `127.0.0.1`, port `15432`, user/database from `DATABASE_URL`
   - Password = **raw** password (decode `%21` → `!`, etc. — not the encoded URI form)
   - SSL **Require**, root cert `certs/rds-global-bundle.crt` only — **no** client cert/key
3. Verify EC2 IP: `nc -zv <EC2_PUBLIC_IP> 22` should succeed before tunneling.

#### Every session (same network)

```bash
npm run db:tunnel          # or: DB_TUNNEL_MODE=ssh npm run db:tunnel
```

Wait for **`✓ Tunnel ready on 127.0.0.1:15432`**, then connect in TablePlus (or DBeaver). Keep the tunnel terminal open.

**Fastify / auth tests on your Mac:** set `DATABASE_URL_LOCAL` in `.env.local` (copy `DATABASE_URL`, change host to `127.0.0.1` and port to `15432`). Restart `npm run dev:fastify` after changing env. Example:

```bash
# Canonical (tunnel script, EC2, GitHub secrets)
DATABASE_URL=postgresql://USER:ENCODED_PASS@enscribe-prod….rds.amazonaws.com:5432/enscribe?sslmode=require

# Laptop only — same USER/PASS/db; tunnel must be running (`localhost` or `127.0.0.1` both OK)
DATABASE_URL_LOCAL=postgresql://USER:ENCODED_PASS@127.0.0.1:15432/enscribe?sslmode=require
```

Node `pg` sets TLS **servername** to the RDS hostname from `DATABASE_URL` automatically (required when the URI host is `localhost` / `127.0.0.1`).

Your saved TablePlus/DBeaver profile does not need to change.

#### New WiFi or network (most common issue)

**Symptom:** `Operation timed out` on SSH, or tunnel never shows “Tunnel ready”, or TablePlus `connection refused` on `127.0.0.1:15432`.

**Cause:** Your **public IP changed**. The EC2 security group still allows your old IP. TablePlus config is fine — the tunnel never starts.

**Fix (2 minutes):**

1. `curl -s ifconfig.me` — note your new IP.
2. AWS Console → EC2 → instance → **Security** → security group (e.g. `launch-wizard-1`, **not** `rds-ec2-1`) → edit inbound SSH rule → update to new IP or click **My IP** → save.
3. `nc -zv <EC2_PUBLIC_IP> 22` — must succeed.
4. `npm run db:tunnel` again → connect TablePlus.

You do **not** need to redo TablePlus setup, change `DATABASE_URL`, or delete the saved connection — only the security group rule (and `EC2_DEPLOY_HOST` if the **EC2** public IP changed, which is separate from your WiFi IP).

| IP type | What breaks | What to update |
|---------|-------------|----------------|
| **Your IP** (WiFi, hotspot, office) | SSH timeout | EC2 security group SSH rule |
| **EC2 public IP** (after stop/start without Elastic IP) | SSH timeout | `EC2_DEPLOY_HOST` in `.env.local` + security group unchanged if rule is still your IP |

#### Terminal-only (no TablePlus, no SSH from Mac)

On **EC2 Instance Connect** (browser):

```bash
cd /opt/enscribe-api
npm run db:inspect              # summary
npm run db:inspect -- counts    # row estimates
```

Uses `DATABASE_URL` on the server; no tunnel or security group change on your laptop.

#### Troubleshooting

| Error | Likely fix |
|-------|------------|
| `Operation timed out` (SSH) | Wrong/stale EC2 IP, or security group SSH rule not your current IP |
| `403 Forbidden` (SSM) | Use `DB_TUNNEL_MODE=ssh` instead, or get IAM `ssm:StartSession` |
| `connection refused` on `127.0.0.1:15432` | Tunnel not running — wait for “Tunnel ready” or fix SSH first |
| `password authentication failed` | Use **raw** password in TablePlus, not URL-encoded `%21`/`%23`/`%24` |
| `postgresql.key` / client cert error | SSL: root CA only; leave client cert/key empty in TablePlus |

Scripts: `sql/scripts/rds-local-tunnel.mjs` (`npm run db:tunnel`), `sql/scripts/rds-inspect.mjs` (`npm run db:inspect`).

## Environment Variables

Create a `.env.local` file with:

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# Postgres URI for `pg` (archive / encounter jobs) and `npm run migrate:apply-psql` — same DB as Supabase REST.
# On IPv4-only networks use Dashboard → Database → "Use IPv4 connection (Shared Pooler)" → Transaction pooler URI:
#   postgresql://postgres.<project_ref>:PASSWORD@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require
# (Paste that into SUPABASE_DB_DIRECT_URL; the name is legacy — pooler URIs are valid here.)
# Alternatively: SUPABASE_DB_HOST + SUPABASE_DB_PASSWORD + SUPABASE_DB_USER=postgres.<project_ref> + SUPABASE_DB_PORT=6543 for pooler.
# Optional TLS for Node `pg` (encounter archive / archive schema): Supabase hosts (*.supabase.co, pooler.supabase.com)
# default to relaxed cert verify; set SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=true for strict verify.
# After changing DB URL or SSL env, restart Fastify (or call closeSupabasePostgresPool if you wire hot reload).
# SUPABASE_DB_DIRECT_URL=
# SUPABASE_DB_HOST=
# SUPABASE_DB_PASSWORD=
# Optional: Bearer secret for POST /api/internal/cleanup/run and GET .../cleanup/jobs/:jobRunId (cron / polling)
INTERNAL_CLEANUP_SECRET=
# Required for cleanup task storage_archive (S3 bucket name for PutObject)
AWS_ARCHIVE_S3_BUCKET=
# Encounter archive (JSONL + recording under archive/encounter-bundles/{user_id}/{queue_id}/) uses the same bucket.
GOOGLE_CLOUD_PROJECT_ID=
GOOGLE_CLOUD_PRIVATE_KEY=
GOOGLE_CLOUD_CLIENT_EMAIL=
# Deepgram API Configuration
# Required for audio transcription via Deepgram Nova-3 model
DEEPGRAM_API_KEY=
# AWS Comprehend Medical Configuration
# Required for LOCAL development only to test maskPhiHelper
# Not needed on EC2 - the EC2 instance IAM role provides access automatically
AWS_COMPREHEND_ACCESS_KEY_ID=
AWS_COMPREHEND_SECRET_ACCESS_KEY=
OPENAI_API_KEY=
# Optional: Redis (local: redis://127.0.0.1:6379; prod: rediss://… when TLS). Omit to run without Redis.
REDIS_URL=
# Optional: AUTH token merged into REDIS_URL when the URL has no password (ElastiCache, etc.).
# Not applied for passwordless local `redis://127.0.0.1` / `localhost` — use `redis://:password@127.0.0.1:6379` if local Redis has a password.
# REDIS_AUTH_TOKEN=
# Optional: Nova AI Redis session TTL in seconds (default 3600; min 60 max 86400).
# NOVA_REDIS_SESSION_TTL_SEC=3600
```

Nova (Redis hot cache + Supabase persistence + async Bedrock chat turns, Bearer JWT): `GET /api/nova/chat-sessions` (paginated session metadata from Supabase; **no Redis**), `POST /api/nova/chat-sessions`, `GET /api/nova/chat-sessions/:chatId`, `PATCH /api/nova/chat-sessions/:chatId`, `POST /api/nova/chat-sessions/:chatId/completions` (body `model`: `haiku` \| `sonnet` \| `opus`, `message`, UUID `client_message_id`; returns **202** + job id, persists user message; poll `GET /api/nova/chat-sessions/:chatId/completion-jobs/:jobId` until `complete` or `failed` — while `running`, poll returns growing `assistant_partial`), `POST /api/nova/chat-sessions/:chatId/token-usage` (create/get/patch/completions/token-usage require `REDIS_URL`). Optional env: `NOVA_BEDROCK_MODEL_HAIKU`, `NOVA_BEDROCK_MODEL_SONNET`, `NOVA_BEDROCK_MODEL_OPUS` (Bedrock `modelId` overrides), `BEDROCK_DEFAULT_HAIKU_MODEL_ID` (SOAP / template extract), `NOVA_COMPLETION_PARTIAL=0` (disable poll partials; uses non-streaming Bedrock). Message bodies and summaries are encrypted in Postgres with the same user master key pattern as notes; Redis holds plaintext for the active session. Apply `sql/migrations/20260507_nova_chat_sessions.sql`, then `sql/migrations/20260514_nova_chat_completion_jobs.sql` (creates enum `nova_chat_completion_job_status` + table) and `sql/policies/nova_chat_completion_jobs_RLS.sql`. If you already ran an older `20260514` with `text` status, run `sql/migrations/20260515_nova_chat_completion_jobs_status_enum.sql` once to convert to the enum. Integration tests: `npm run test:nova-chat-sessions` (server + Redis + `REDIS_URL` + `TEST_ACCOUNT_*` + migrated DB). Completions: `npm run test:nova-chat-sessions-completions` — API tests (no Bedrock); set `skipE2ETest = false` in that file to append Test 8 (Bedrock, token cost). `npm test` includes the same suite. Optional: `NOVA_E2E_MODEL`, `NOVA_E2E_COMPLETION_TIMEOUT_MS`.

### Internal cleanup (cron / ops)

Header: `Authorization: Bearer INTERNAL_CLEANUP_SECRET`. Scheduled via [.github/workflows/cleanup.yml](.github/workflows/cleanup.yml) (daily).

**Prod prerequisites:** Postgres on RDS (`DATABASE_URL`), `RECORDINGS_STORAGE_BACKEND=s3`, `AWS_RECORDINGS_S3_BUCKET`, `AWS_ARCHIVE_S3_BUCKET`, archive SQL migrations applied, EC2 IAM on **both** buckets ([S3_AUDIO_FILES_MIGRATION.md](docs/S3_AUDIO_FILES_MIGRATION.md) Part 3 — `ListBucket` on recordings is required for `unattached_storage`).

- **POST** `/api/internal/cleanup/run` — Body `tasks`: `storage_manifest`, `storage_archive` (legacy Supabase Storage track), `encounter_archive`, `unattached_storage` (orphan blobs in **S3** recordings bucket), and/or `unattached_note_template_sections`. Optional caps: `maxObjectsPerRun`, `maxEnqueue`, `maxProcessPerJob`, `maxDeletesPerRunUnattachedStorage`, `maxDeletesPerRunUnattachedNoteTemplateSections`. Encounter sync: `{ "tasks": ["encounter_archive"] }`. Async: `{ "tasks": ["encounter_archive"], "async": true }` → **202** + `jobRunId` / `pollPath`.
- **GET** `/api/internal/cleanup/jobs/:jobRunId` — Poll `job.status` until `success` or `failed`.

Apply `sql/migrations` for `archive` (including `enqueue_patient_encounter_archive_candidates`) before using `encounter_archive`. Zero deletes is often normal (7-day retention, no orphans); verify `archive.job_runs` on RDS.

## Architecture Migration: Next.js → Fastify Backend

### Current State (Hybrid)
- **Frontend**: Next.js (`npm run dev` on port 3000)
- **Backend**: Fastify (`npm run dev:fastify` on port 3001)
- Both run simultaneously; Next.js proxies `/api/*` to Fastify

```bash
# Terminal 1: Backend
npm run dev:fastify

# Terminal 2: Frontend
npm run dev
```

### Final State (Fastify-Only Backend)
When migration completes, this repo becomes **pure backend API only**:

```
src/
├── controllers/              # (was src/fastify/controllers/)
│   ├── authController.js
│   ├── patientEncountersController.js
│   ├── dotPhrasesController.js
│   ├── recordingsController.js
│   ├── soapNotesController.js
│   └── transcriptsController.js
├── routes/                   # (was src/fastify/routes/)
│   ├── auth.js
│   ├── patientEncounters.js
│   ├── dotPhrases.js
│   ├── recordings.js
│   ├── soapNotes.js
│   └── transcripts.js
├── schemas/                  # (was src/fastify/schemas/)
│   ├── patientEncounter.js
│   ├── soapNote.js
│   ├── recording.js
│   ├── transcript.js
│   ├── dotPhrase.js
│   └── regex.js
├── plugins/
│   └── authentication.js     # Fastify auth decorator
├── server.js                 # Main entry point
└── utils/                    # Shared utilities (supabase, encryption, etc)
```

**Run command after flattening:**
```bash
npm run dev  # Runs src/server.js on port 3001
```

**Frontend moves to separate repo:**
- All `src/app/`, `src/components/`, `public/` → `enscribe-frontend/`
- Next.js remains lightweight frontend, proxies to this backend

## Learn More

- [Fastify Documentation](https://www.fastify.io/docs/latest/)
- [Supabase Documentation](https://supabase.com/docs)
- [Google Cloud Speech-to-Text](https://cloud.google.com/speech-to-text/docs)
- [AWS Comprehend Medical](https://aws.amazon.com/comprehend/medical/)
