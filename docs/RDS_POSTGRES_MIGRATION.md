# RDS migration: Supabase Postgres → AWS RDS

Walkthrough for moving the **application database** off Supabase Postgres onto **Amazon RDS PostgreSQL** (or Aurora PostgreSQL). Auth and PostgREST stay on Supabase during early parts; storage is already on S3.

**Status (2026-06-30):** **Phase A + B complete.** **Phase C PR 0 complete** (RDS TLS + gated signup stub; prod unchanged). **Next:** PR 1–5, then Phase D cutover. Active Step 2 of [SUPABASE_TO_AWS_MIGRATION.md](./SUPABASE_TO_AWS_MIGRATION.md).

**Prerequisites:** [S3_AUDIO_FILES_MIGRATION.md](./S3_AUDIO_FILES_MIGRATION.md) cutover complete (`RECORDINGS_STORAGE_BACKEND=s3` on prod).

**Related:** [COGNITO_SETUP.md](./COGNITO_SETUP.md) (Step 3 — auth; plan `user_id` / `auth.users` mapping before RDS cutover if possible).

---

## Migration roadmap (all parts)

| Part | Name | Type | Status |
|------|------|------|--------|
| **1** | RDS / Aurora instance | AWS infra | **Done** (`enscribe-prod`, PG 18.3, Multi-AZ) |
| **2** | VPC + security groups | AWS infra | **Done** (`rds-ec2-1` + `ec2-rds-1` on EC2) |
| **3** | SSL + secrets (`DATABASE_URL`) | AWS infra | **Done** — password auth verified; `DATABASE_URL` format ready (prod env not flipped until cutover) |
| **4** | RDS Proxy (optional) | AWS infra | Skipped |
| **5** | Extensions + parameter group | AWS infra | **Done** (`uuid-ossp`, `pgcrypto`, `pg_stat_statements`) |
| **6** | Schema export / assessment | Ops | **Done** — `supabase-schema.sql` exported; migrate `public` + `archive`; skip `storage`, `realtime`, `graphql*`, `vault` |
| **7** | `auth.users` + FK strategy | Design + SQL | **Done** — **Option A through Cognito**; map `cognito_sub`; B-heavy only if canonical id changes |
| **8** | RLS strategy on RDS | Design + SQL | **Done** — **disable RLS** on app tables post-restore; API enforces `user_id` |
| **9** | Code: expand `pg`, replace `supabase-js` | **Code PR(s)** | **In progress** — **PR 0 done**; PR 1–5 pending (see Part 9) |
| **10** | Data migration + cutover | Ops | Not started |
| **11** | Decommission Supabase Postgres | Ops + cleanup PR | After confidence window |

### Recommended order

```text
Phase A — Infra (Parts 1–5)     ✅ Done — RDS reachable from EC2, empty `enscribe` DB ready
Phase B — Schema (Parts 6–8)    ✅ Done — dump reviewed, Option A + disable RLS locked
Phase C — Code (Part 9)         🔄 PR 0 ✅ — PR 1→5 pending; prod stays on Supabase until Phase D
Phase D — Data + cutover (10)   logical dump/restore or DMS; flip DATABASE_URL
Phase E — Cleanup (11)          drop Supabase DB dependency after stable period
```

**Auth timing:** You can migrate **data** to RDS while Supabase Auth still issues JWTs, as long as `user_id` UUIDs stay stable and `auth.users` (or a replacement `public.users`) exists on RDS for FK integrity. **Step 3 (Cognito)** should be planned before Part 10 if you will not replicate Supabase’s `auth` schema long-term.

### Phase A completion log (2026-06-30)

| Item | Detail |
|------|--------|
| RDS instance | `enscribe-prod` — PostgreSQL **18.3**, `us-east-1`, encrypted, Multi-AZ |
| Endpoint | `enscribe-prod.c8fay082y82d.us-east-1.rds.amazonaws.com:5432` |
| Database | `enscribe` (created manually after instance provision) |
| VPC | `vpc-0bfb4ffe543ec4e9b` (same as EC2) |
| Security groups | RDS: `rds-ec2-1` (`sg-0beec9b78a5d28ca8`); EC2: `ec2-rds-1` (`sg-0357ef13932ae6694`) attached alongside `launch-wizard-1` |
| Connectivity | `psql` smoke from EC2 — `SELECT version();` on `enscribe` ✅ |
| Extensions | `uuid-ossp`, `pgcrypto`, `pg_stat_statements` (+ built-in `plpgsql`) |
| `DATABASE_URL` | Canonical RDS connection string defined (see Part 3); prod EC2 still uses `SUPABASE_DB_DIRECT_URL` until Phase D |
| Part 4 | RDS Proxy skipped for v1 |

### Phase B completion log (2026-06-30)

**Schema inventory (Supabase prod):**

| Item | Value |
|------|--------|
| Schemas to migrate | `public`, `archive` |
| Schemas to skip | `storage`, `realtime`, `graphql`, `graphql_public`, `vault`, `extensions`, `pgbouncer` |
| `auth` on RDS | Minimal — `auth.users` table + **26 rows** (FK stub only) |
| FK refs to `auth.users` | **27** constraints across `public` (26) + `archive` (1) |
| Schema dump | `supabase-schema.sql` (repo root, gitignored) |

**Decisions locked:**

| Part | Decision |
|------|----------|
| **7 — auth.users** | **Option A (long-term):** copy `auth.users` stub to RDS; same UUIDs; 27 FKs unchanged through Cognito. Map Cognito `sub` → `auth.users.id` at Step 3 (do not force `sub` = Supabase UUID). Optional B-light rename to `public.users`. |
| **8 — RLS** | **Disable RLS** on app tables after restore (simpler). API is the auth boundary via `request.user.id` + parameterized SQL. Do not re-apply `sql/policies/*.sql` to RDS. |

**Cutover restore scope (Phase D):** `pg_dump` / `pg_restore` for `public` + `archive` + `auth.users` data; skip Supabase-only schemas.

### Phase C plan (locked 2026-06-30)

See **Part 9** for full PR breakdown. Summary:

| PR | Scope |
|----|--------|
| **0** | RDS SSL pool + gated signup `auth.users` stub |
| **1** | 3 RPCs + encounters + recordings |
| **2–5** | Remaining controllers / workers |
| **Deploy** | `DATABASE_URL` GitHub secret exists; **deploy.yml + prod flip deferred to Phase D** |
| **Tests** | Supabase until Phase D; RDS smoke from EC2 after restore |

---

## What changes vs what stays the same

| Layer | During RDS migration |
|-------|----------------------|
| **Auth** | Unchanged (Supabase JWT) until Step 3 |
| **Storage** | Unchanged (S3 — already cut over) |
| **Postgres host** | Supabase → **RDS endpoint** |
| **Data access** | `supabase-js` (PostgREST) → **`pg` pool** (expand existing) |
| **RLS + `auth.uid()`** | **Breaks** without Supabase JWT bridge — must replan (Part 8) |
| **API contract** | Unchanged (clients still use Bearer JWT from `/api/auth`) |

### Already on `pg` (Part 9 head start)

These modules already use `querySupabasePostgres` / `supabasePostgresPool.js` (connection env: `SUPABASE_DB_DIRECT_URL`):

| Area | File(s) |
|------|---------|
| Billing entitlements / usage | `billingEntitlements.js`, `billingUsage.js` |
| Archive + retention jobs | `encounterArchivePurge.js`, `archiveStoragePurge.js`, `archiveStorageManifestSync.js` |
| Cleanup jobs | `unattachedStorageCleanup.js`, `unattachedNoteTemplateSectionsCleanup.js`, `cleanupExcludedUserIds.js` |
| Migrations tooling | `sql/scripts/apply-psql-migration.mjs` |

**Still on `supabase-js`** (~35 controller/service files): CRUD via `.from()`, plus **3 RPC** call sites:

| RPC | File |
|-----|------|
| `create_patient_encounter_complete` | `patientEncountersController.js` |
| `create_note_template_complete` | `noteTemplatesCompleteController.js` |
| `update_note_template_complete` | `noteTemplatesCompleteController.js` |

SQL definitions: `sql/functions/create_encounter_complete.sql`, `sql/functions/note_templates_complete.sql`.

---

## Part 1 — Create RDS PostgreSQL

**Region:** same as EC2 (`us-east-1` / `AWS_REGION`).

### Suggested sizing (prod)

| Field | Starting point |
|-------|----------------|
| Engine | PostgreSQL 15 or 16 (match Supabase major version) |
| Instance | `db.t4g.small` or `db.t4g.medium` — tune from CloudWatch |
| Storage | gp3, autoscaling on |
| Multi-AZ | Yes for prod |
| DB identifier | e.g. `enscribe-prod` |

### Standard settings

| Setting | Value |
|---------|--------|
| **Public access** | **No** — private subnets only |
| **Encryption** | Enable (KMS or default RDS key) |
| **Backup retention** | ≥ 7 days (adjust for compliance) |
| **Deletion protection** | On for prod |
| **Performance Insights** | Optional but useful |

Create an initial database (e.g. `enscribe`) and master user; store credentials in **Secrets Manager** (recommended) or GitHub secrets.

---

## Part 2 — Networking (EC2 → RDS)

EC2 API must reach RDS on **5432** (or 5432 via RDS Proxy).

1. Place RDS in the **same VPC** as EC2 (or peered VPC).
2. **Security group (RDS):** inbound TCP 5432 from EC2 instance security group only.
3. **Security group (EC2):** outbound to RDS SG allowed (usually default).
4. No public RDS endpoint required if EC2 is in-VPC.

**Smoke from EC2:**

```bash
psql "$DATABASE_URL" -c 'SELECT version();'
```

---

## Part 3 — Connection string + SSL

### Env vars (target state)

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Canonical `postgresql://user:pass@host:5432/enscribe?sslmode=require` |
| `SUPABASE_DB_DIRECT_URL` | Legacy name — keep as alias during migration, then remove |

Update [deploy.yml](../.github/workflows/deploy.yml) and EC2 `.env.local` template when cutting over.

### Code touchpoints

| File | Change |
|------|--------|
| [supabasePostgresUrl.js](../src/utils/supabasePostgresUrl.js) | Already accepts `DATABASE_URL` |
| [supabasePostgresPool.js](../src/utils/supabasePostgresPool.js) | Tune SSL for RDS: `rejectUnauthorized: true` + RDS CA bundle (stricter than Supabase pooler defaults) |

Today, Supabase hosts get relaxed TLS via `SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=false`. **RDS should use proper verification** in prod.

Optional follow-up PR: rename `supabasePostgresPool.js` → `postgresPool.js` (behavior-neutral refactor).

---

## Part 4 — RDS Proxy (optional)

Use when connection count from EC2 + `nova-summarize-worker` + ad-hoc scripts grows.

| Benefit | Notes |
|---------|--------|
| Connection pooling | Reduces `too many connections` on small RDS |
| IAM auth | Optional — not required for v1 |
| Failover | Helps with Multi-AZ failover |

Skip for initial cutover if `max: 10` pool per process is sufficient.

---

## Part 5 — Extensions + parameters

Before restore, compare Supabase vs RDS:

```bash
# On Supabase (source)
psql "$SUPABASE_DB_DIRECT_URL" -c "SELECT extname FROM pg_extension ORDER BY 1;"
```

Common Supabase extensions to verify on RDS: `pgcrypto`, `uuid-ossp`, `pg_stat_statements`. Enable via parameter group + `CREATE EXTENSION` as superuser.

Match **timezone** (`UTC`), **locale**, and **max_connections** to expected load.

---

## Part 6 — Schema export and assessment

### Export from Supabase

```bash
# Schema only (review before full dump) — writes to repo root by default
pg_dump "$SUPABASE_DB_DIRECT_URL" --schema-only --no-owner --no-privileges -f supabase-schema.sql
# → enscribe-api/supabase-schema.sql (local only; do not commit)

# Full logical dump (cutover window)
pg_dump "$SUPABASE_DB_DIRECT_URL" --no-owner --no-privileges -Fc -f enscribe.dump
```

### Schemas in scope

| Schema | Action |
|--------|--------|
| `public` | **Migrate** — app tables, functions, triggers |
| `archive` | **Migrate** — retention metadata |
| Billing tables | **Migrate** — in `public` |
| `auth` | **See Part 7** — Supabase-specific; do not assume portable |
| `storage` | **Skip** — blobs on S3 |
| `realtime`, `supabase_*` | **Skip** |

### Repo SQL assets

Apply or reconcile after restore:

- `sql/policies/*.sql` — 15 RLS policy files (Supabase `authenticated` role + `auth.uid()`)
- `sql/functions/*.sql` — RPC functions used by API
- `sql/triggers/*.sql`

Use `npm run migrate:apply-psql` ([apply-psql-migration.mjs](../sql/scripts/apply-psql-migration.mjs)) against RDS once `DATABASE_URL` points there.

---

## Part 7 — `auth.users` and foreign keys

App tables use `user_id uuid` with FKs to **`auth.users(id)`** (see policy comments in `sql/policies/userProfiles_RLS.sql`, `internalAccess_RLS.sql`). Prod today: **26 users**, **27 FK constraints** across ~25 tables (`public` + `archive`).

### Option summary

| Option | What changes | Cutover effort | Cognito (Step 3) |
|--------|----------------|----------------|------------------|
| **A. `auth.users` stub on RDS** | Copy user registry to RDS; **same UUIDs**; FKs unchanged | **Low** — ~26-row copy + minimal `auth.users` DDL | **Recommended path** — extend A (see below); no FK migration |
| **B-heavy. New `public.users` + repoint FKs** | New table; **drop/recreate all 27 FKs** to point at `public.users` | **High** — 27 `ALTER TABLE` ops + testing on ~25 tables | Only if canonical id **must** change (usually not) |
| **B-light. Rename in place** | `ALTER TABLE auth.users SET SCHEMA public` + rename | **Low** — FKs follow table OID; no drop/recreate | Optional cosmetic cleanup at Cognito time |
| **C. Defer FK to `auth.users`** | Remove FK constraints | Risky | Not recommended for prod |

**Do not confuse “27 FKs” with “27 rows”:**

- **Option A:** 27 FKs **stay as-is** (they already reference `auth.users`). You copy **26 user rows**.
- **Option B-heavy:** 27 FKs each need **drop + add** on a different referenced table — real migration work across many tables, plus data/code fallout.

### Recommendation: Option A through RDS cutover **and** Cognito

Option A is **not** a throwaway bridge. It is the long-term plan unless you explicitly choose B-heavy:

1. **RDS cutover (Phase D):** Create minimal `auth.users` on RDS; copy 26 rows; restore `public` + `archive`. All 27 FKs work unchanged.
2. **New signups (Phase C):** After `supabase.auth.signUp()`, insert stub row into RDS `auth.users` with the same `id` (until Cognito).
3. **Cognito cutover (Step 3):** Keep **`auth.users.id` as the app canonical `user_id`** everywhere. Add `cognito_sub` (or `legacy_supabase_id` custom attribute mirrored in DB). Login: verify Cognito JWT → lookup by `cognito_sub` → `request.user.id = auth.users.id`. **Still no FK changes.**
4. **Optional rename (B-light):** If you dislike the `auth` schema name:

```sql
ALTER TABLE auth.users SET SCHEMA public;
ALTER TABLE public.users RENAME TO users;
-- FKs remain valid (same table OID)
ALTER TABLE public.users ADD COLUMN cognito_sub text UNIQUE;
```

### Cognito `sub` vs Supabase `auth.users.id`

**Can Cognito `sub` be forced to equal the Supabase UUID?**

**No — not in normal Cognito User Pools.** Amazon Cognito assigns `sub` at user creation; it is **immutable** and **cannot be set** via `AdminCreateUser`, SignUp, or the bulk import CSV. New Cognito users always get a **new** Cognito-generated UUID in `sub`.

| Approach | Canonical app `user_id` | FK work | Notes |
|----------|-------------------------|---------|--------|
| **Mapping (recommended)** | **`auth.users.id`** (Supabase UUID, unchanged) | **None** | Store Cognito `sub` in `auth.users.cognito_sub`; API resolves JWT → app UUID |
| **Replace all IDs with Cognito `sub`** | Cognito `sub` | **Heavy** — update every `user_id` column in every row **or** B-heavy FK repoint | Possible but same cost as B-heavy; avoid |
| **Force password reset + import** | Either, depending on choice above | Depends | Password hashes are not portable from Supabase anyway ([COGNITO_SETUP.md](./COGNITO_SETUP.md) §9) |

**Practical Cognito migration (26 users):**

1. Export `auth.users(id, email)` from RDS (already your registry after RDS cutover).
2. Bulk `AdminCreateUser` (or import) in Cognito — each user gets a **new** `sub`.
3. Record `auth.users.id → cognito_sub` (DB column or admin script).
4. Update auth middleware: Cognito JWT `sub` → lookup → `request.user.id = auth.users.id`.
5. Force password reset (Supabase hashes cannot be imported).

App code and all 27 FKs keep using the **original Supabase UUIDs** forever unless you deliberately run a full ID migration.

### What Option A `auth.users` on RDS contains

Stub registry only — **not** used for login on RDS:

| Column (minimal) | Purpose |
|------------------|---------|
| `id` uuid PK | Same as Supabase; matches JWT → `request.user.id` and all FKs |
| `email` | Admin scripts, support lookups |
| `cognito_sub` | Added at Cognito cutover (nullable until then) |

Do **not** copy Supabase auth machinery (`auth.sessions`, MFA tables, etc.) — Supabase Auth (then Cognito) handles credentials.

**Code still calling Supabase Auth admin (until Cognito):**

- `userProfileController.js` — `auth.admin.getUserById`
- `sql/scripts/export-and-decrypt-by-user/` — `SELECT id FROM auth.users`

These become RDS queries or Cognito API in Step 3.

**See also:** [COGNITO_SETUP.md](./COGNITO_SETUP.md) §9 (user migration, `legacy_supabase_id` custom attribute).

---

## Part 8 — RLS on RDS

Supabase RLS policies use `auth.uid()` and the `authenticated` role (example: `sql/policies/recordings_RLS.sql`). **Plain RDS does not populate `auth.uid()`** from your Fastify JWT unless you build a bridge.

**Pragmatic approach (recommended):**

1. **Enforce ownership in the API** — already done: `request.user.id` + `WHERE user_id = $1` on `pg` queries.
2. On RDS, **disable RLS** on app tables *or* replace policies with service-role-only access:
   - API connects as a single DB user with broad DML (secrets on EC2).
   - No direct PostgREST / anon access from clients.
3. Keep RLS SQL in repo as documentation until policies are rewritten for a future `SET LOCAL app.user_id` pattern (optional hardening).

**Do not** rely on RLS as the primary auth boundary after PostgREST is removed.

---

## Part 9 — Code changes (replace `supabase-js` with `pg`)

**Goal:** All data paths use `querySupabasePostgres` (or renamed pool). Supabase client remains only for **auth** until Step 3 (Cognito) / Part 11. Storage is already S3-only.

**Phase C status:** **PR 0 merged locally (2026-06-30).** Ship PR 1–5 incrementally; **prod stays on Supabase Postgres URI until Phase D.**

### Phase C PR 0 completion log (2026-06-30)

| Item | Detail |
|------|--------|
| [postgresConnection.js](../src/utils/postgresConnection.js) | RDS host detection (`*.rds.amazonaws.com`), strict TLS + bundled CA (`certs/rds-global-bundle.crt`) |
| [supabasePostgresPool.js](../src/utils/supabasePostgresPool.js) | Uses shared SSL helpers; Supabase pooler unchanged (relaxed TLS) |
| [authUsersStub.js](../src/utils/authUsersStub.js) | Gated `INSERT INTO auth.users (id, email)` after sign-up — **no-op on Supabase** |
| [authController.js](../src/fastify/controllers/authController.js) | Calls stub after successful `signUp`; signup continues if stub fails |
| Unit tests | `node tests/postgresConnection.unit.test.js` (7), `node tests/authUsersStub.unit.test.js` (4) — included in `npm run test:unit` |
| Prod | No [deploy.yml](../.github/workflows/deploy.yml) change; `SUPABASE_DB_DIRECT_URL` still Supabase |

### Phase C decisions (locked)

| Decision | Choice |
|----------|--------|
| **PR strategy** | **PR 0 (foundation)** then **incremental PR 1–5** — no single mega-branch |
| **Signup → RDS `auth.users` stub** | **PR 0** — insert after `supabase.auth.signUp()`; **no-op** until connection URL targets RDS (see gating below) |
| **`DATABASE_URL` GitHub secret** | **Already added** — do **not** wire into [deploy.yml](../.github/workflows/deploy.yml) or prod EC2 until **Phase D** flip |
| **Testing during Phase C** | Run suites against **Supabase** (default `.env.local`). RDS is **private** — post-restore / post-flip smoke from **EC2 only** (SSM), not laptop-direct |
| **RLS disable SQL** | **Phase D** (after restore), not Phase C — see Part 8 |
| **Dedicated `enscribe_app` DB user** | Optional later; Phase C may use `enscribe_admin` / existing pool user |

### Env / connection behavior during Phase C

| Environment | Postgres target | Notes |
|-------------|-----------------|-------|
| **Prod EC2 (now → Phase D)** | `SUPABASE_DB_DIRECT_URL` → Supabase | Unchanged; `getSupabasePostgresUrl()` prefers this over `DATABASE_URL` |
| **Local dev (Phase C)** | `SUPABASE_DB_DIRECT_URL` → Supabase | All migrated `pg` code tested against live Supabase until cutover |
| **After Phase D flip** | Set `SUPABASE_DB_DIRECT_URL` **or** `DATABASE_URL` → RDS on EC2 | Also add `DATABASE_URL` to deploy template when flipping |

**Signup stub gating (PR 0):** Only call `INSERT INTO auth.users …` when the resolved Postgres host is RDS (e.g. `*.rds.amazonaws.com`), not Supabase. Avoids writes to Supabase `auth.users` during Phase C.

### PR 0 — Foundation (first PR) — Done

| Task | File(s) | Status |
|------|---------|--------|
| RDS host detection + strict TLS | [postgresConnection.js](../src/utils/postgresConnection.js), [supabasePostgresPool.js](../src/utils/supabasePostgresPool.js) | Done — `*.rds.amazonaws.com` → strict verify + [global CA bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) at `certs/rds-global-bundle.crt` |
| Supabase hosts unchanged | same | Done — pooler / `*.supabase.co` keep relaxed TLS |
| Signup stub insert | [authUsersStub.js](../src/utils/authUsersStub.js), [authController.js](../src/fastify/controllers/authController.js) | Done — gated; no RDS writes while `SUPABASE_DB_DIRECT_URL` → Supabase |
| Unit tests | [postgresConnection.unit.test.js](../tests/postgresConnection.unit.test.js), [authUsersStub.unit.test.js](../tests/authUsersStub.unit.test.js) | Done — 11 tests; in `npm run test:unit` |

**Out of scope for PR 0 (unchanged):** `deploy.yml` changes, controller `.from()` migration, flipping prod env.

### PR 1 — RPCs + encounters / recordings

| Task | File(s) |
|------|---------|
| RPC → `pg` (3 sites) | [patientEncountersController.js](../src/fastify/controllers/patientEncountersController.js), [noteTemplatesCompleteController.js](../src/fastify/controllers/noteTemplatesCompleteController.js) |
| Controller `.from()` → `pg` | `patientEncountersController`, `recordingsController` |
| Tests | `npm run test:patient-encounters`, `npm run test:recordings` |

### PR 2 — Notes pipeline

| Task | File(s) |
|------|---------|
| Controller migration | `notesController`, `soapNotesController`, `transcriptsController` |
| Tests | relevant note/transcript suites |

### PR 3 — Templates + pre-visit + dot phrases

| Task | File(s) |
|------|---------|
| Controller migration | `noteTemplates*`, `preVisitSummaries*`, `dotPhrasesController`, related utils |
| Tests | template / pre-visit suites if present |

### PR 4 — Nova + jobs + workers

| Task | File(s) |
|------|---------|
| Controller + worker migration | `novaChatSessionsController`, `jobController`, `novaChatPersistence.js`, processors |
| Tests | nova / job suites if present |

### PR 5 — Remainder

| Task | File(s) |
|------|---------|
| Controller migration | `userProfileController`, `billingController`, `baaController`, `authController` (refresh token table), `entitlementsController`, `userSecurityConfigController`, `stripeWebhookController`, remaining utils |
| Audit | No remaining `.from()` for Postgres data (except auth-only Supabase paths) |
| Tests | `npm run test:billing-org`, `npm run test:billing-usage-limits`, `npm run test:auth`, full `npm test` against Supabase |

### Phase C completion checklist (gate for Phase D)

- [x] **PR 0** — RDS SSL + signup stub (gated); unit tests pass
- [ ] **PR 1–5** merged — all data paths on `pg`; 3 RPCs on `pg`
- [x] No prod env flip — EC2 still on Supabase URI
- [ ] Test suites pass against **Supabase** with migrated code (after PR 1–5)
- [ ] `supabase-js` retained only for **auth** (`getUser`, `signUp`, `signIn`, admin auth helpers) — after PR 1–5

### 9.1 — Foundation (detail)

| Task | Notes |
|------|-------|
| RDS-ready SSL in pool | Strict verify with RDS CA; see PR 0 |
| Shared query helpers | Optional thin repo layer for repeated `.from()` patterns |
| `DATABASE_URL` in deploy | GitHub secret **exists**; add to deploy.yml + EC2 `.env.local` at **Phase D** only |

### 9.2 — RPC migration (3 call sites)

Replace:

```js
await supabase.rpc('create_patient_encounter_complete', { ... })
```

With:

```js
await querySupabasePostgres(
  'SELECT create_patient_encounter_complete($1, $2, ...)',
  [param1, param2, ...]
);
```

Functions already exist in Postgres — no Supabase-specific magic. **Included in PR 1.**

### 9.3 — Controller migration (incremental PRs)

| PR | Controllers / areas |
|----|---------------------|
| **PR 0** | Pool SSL, signup `auth.users` stub (gated) |
| **PR 1** | RPCs + `patientEncountersController`, `recordingsController` |
| **PR 2** | `notesController`, `soapNotesController`, `transcriptsController` |
| **PR 3** | `noteTemplates*`, `preVisitSummaries*`, `dotPhrases` routes |
| **PR 4** | `novaChatSessionsController`, `jobController`, workers |
| **PR 5** | `userProfileController`, `billingController`, `baaController`, remainder |

Each PR: swap `.from()` for parameterized SQL; preserve `user_id` checks; run existing test suites.

### 9.4 — Remove service-role data paths

`supabaseAdmin()` bypasses RLS today. On RDS, the API DB user is effectively service-role — **must** keep explicit `user_id` / org checks in code (already pattern for billing).

### 9.5 — Testing

| When | Target | Command / location |
|------|--------|-------------------|
| **Phase C (each PR)** | Supabase | `npm run test:*` suites listed below |
| **Phase D (post-restore)** | RDS from EC2 | `psql`, API smoke, `npm test` if tunnel or CI against restored DB |

| Area | Command |
|------|---------|
| Billing | `npm run test:billing-org`, `npm run test:billing-usage-limits` |
| Encounters / recordings | `npm run test:patient-encounters`, `npm run test:recordings` |
| Auth (unchanged) | `npm run test:auth` |

**Not during Phase C:** pointing local `.env.local` `DATABASE_URL` at prod RDS (VPC-private). Optional: SSM port-forward for ad-hoc debugging only.

---

## Part 10 — Data migration and cutover

### Pre-cutover checklist

**AWS infra (Parts 1–5)**

- [x] RDS created, encrypted, Multi-AZ (prod)
- [x] EC2 → RDS connectivity verified (`psql`)
- [x] Extensions enabled
- [x] `DATABASE_URL` format ready (GitHub secret / prod flip deferred to Phase D cutover)

**Schema (Parts 6–8)**

- [x] Schema dump reviewed (`auth`, `public`, `archive`) — export at `supabase-schema.sql` (2026-06-30)
- [x] `auth.users` bridge strategy — **Option A** (26 users, 27 FKs)
- [x] RLS plan — **disable on app tables**; API-enforced ownership

**Code (Part 9 — Phase C gate)**

- [x] PR 0 — RDS SSL + gated signup stub (`postgresConnection.js`, `authUsersStub.js`, unit tests)
- [ ] PR 1–5 merged — critical controllers on `pg`; RPCs on `pg`
- [ ] Test suites pass against **Supabase** with migrated code (after PR 1–5)
- [ ] Post-restore: smoke from **EC2** against RDS (Phase D)

### Cutover steps

1. **Maintenance window** (or read-only mode on API if you implement it).
2. **Final incremental sync** — `pg_dump` / `pg_restore` or AWS DMS for minimal downtime.
3. **Restore** to RDS: `pg_restore -d "$DATABASE_URL" enscribe.dump`
4. **Disable RLS** on app tables (Part 8) — batch `ALTER TABLE … DISABLE ROW LEVEL SECURITY` on `public` + `archive` tables (do not re-apply `sql/policies/*.sql`).
5. **Apply** any pending `sql/` migrations via `npm run migrate:apply-psql`.
6. **Flip env** on EC2: set `SUPABASE_DB_DIRECT_URL` and/or `DATABASE_URL` → RDS; update [deploy.yml](../.github/workflows/deploy.yml) to pass `DATABASE_URL` from GitHub secret.
7. **Restart PM2** (`fastify-server`, `nova-summarize-worker`).
8. **Smoke:** sign-in (Supabase auth still), create encounter, note, recording upload (S3), billing entitlements, cleanup cron paths.
9. **Rollback plan:** revert DB URL to Supabase URI; restore from pre-cutover snapshot.

### Dual-database period (optional)

Run new writes to both DBs only if you have a clear dual-write layer — **not implemented today**. Default plan: **single cutover** with short read-only window.

---

## Part 11 — Decommission Supabase Postgres

After **2–4 weeks** stable on RDS:

| Task | Outcome |
|------|---------|
| Remove `SUPABASE_DB_*` secrets from deploy | `DATABASE_URL` only |
| Rename pool module / env helpers | No “supabase” in Postgres path names |
| Cancel Supabase database or downgrade plan | Cost savings |
| Update docs / runbooks | RDS backup restore procedure |

Supabase **Auth** may still run until Step 3 (Cognito).

---

## FAQ

### Does RDS migration require Cognito first?

**No**, but plan `user_id` stability. Easiest bridge: copy `auth.users` rows to RDS, migrate app data, cut over connection string, then Cognito in Step 3.

### Can we keep `supabase-js` for some tables?

Technically yes during transition; **not recommended** long-term. PostgREST targets Supabase’s DB — once data lives on RDS, `supabase-js` `.from()` must point at Supabase (stale) unless you only use it for auth.

### What about Realtime / Supabase Studio?

Not used by `enscribe-api` today. Studio replacement: pgAdmin, DBeaver, or RDS Query Editor.

### Connection pooler

Supabase transaction pooler (port 6543) ↔ **RDS Proxy** or app-side `pg` pool. EC2 already pools with `max: 10`.

---

## Related env summary

```bash
# Current (Supabase Postgres)
SUPABASE_DB_DIRECT_URL=postgresql://postgres.[ref]:[pass]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
SUPABASE_DB_SSL_REJECT_UNAUTHORIZED=false   # Supabase pooler quirk

# Target (RDS)
DATABASE_URL=postgresql://enscribe_app:[pass]@enscribe-prod.xxxx.us-east-1.rds.amazonaws.com:5432/enscribe?sslmode=require

# Already migrated (Step 1)
AWS_RECORDINGS_S3_BUCKET=enscribe-recordings-prod
RECORDINGS_STORAGE_BACKEND=s3

# Still Supabase until Step 3
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```
