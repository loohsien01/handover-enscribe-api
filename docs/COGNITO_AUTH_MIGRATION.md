# Auth migration: Supabase Auth → Amazon Cognito

Walkthrough for moving **authentication** off Supabase onto **Amazon Cognito User Pools**. Postgres is on RDS; live recordings are on S3. After this step, Supabase can be fully decommissioned (Step 4).

Assumes **API-mediated auth** — clients call `POST /api/auth` and `POST /api/auth/refresh` on Fastify (EC2), not Cognito Hosted UI. **Email + password only.** Session layer (encrypted `refreshTokens`, wrapper cookie, inactivity caps) stays on the API. **HIPAA:** Cognito, SES, EC2, and RDS in AWS BAA-covered account/region (`us-east-1`).

**Status (2026-07-02):** **In progress.** **Phase A + B done** (dev IAM verified via `npm run smoke:cognito-dev`). **Phase C (code) is next.** RDS cutover **tentative**. Prod auth cutover only after Phase C tests green + SES production access.

**Prerequisites:**

| Prerequisite | Status |
|--------------|--------|
| S3 recordings (`RECORDINGS_STORAGE_BACKEND=s3`) | **Done** — [S3_AUDIO_FILES_MIGRATION.md](./S3_AUDIO_FILES_MIGRATION.md) |
| RDS Postgres + `pg` data path | **Tentative** — [RDS_POSTGRES_MIGRATION.md](./RDS_POSTGRES_MIGRATION.md) |
| `auth.users` stub on RDS (Option A) | **Done** at RDS cutover — same UUIDs, 27 FKs unchanged |
| Stable `user_id` in app data | **Required** — canonical id stays `auth.users.id`, not Cognito `sub` |

**Parent plan:** [SUPABASE_TO_AWS_MIGRATION.md](./SUPABASE_TO_AWS_MIGRATION.md)

---

## Migration roadmap (all parts)

| Part | Name | Type | Status |
|------|------|------|--------|
| **1** | Cognito User Pool + app client | AWS infra | **Done** — `enscribe-dev` + `enscribe-prod`; app clients with `ALLOW_ADMIN_USER_PASSWORD_AUTH` + `ALLOW_REFRESH_TOKEN_AUTH`; dev sign-in smoke-tested (`ADMIN_USER_PASSWORD_AUTH`) |
| **2** | SES (verify domain, exit sandbox) | AWS infra | **Done (prod access pending)** — `enscribe.online` verified; custom MAIL FROM `mail.enscribe.online` (MX/TXT on Namecheap); DMARC `_dmarc`; prod pool email: SES `us-east-1`, FROM `Enscribe Health LLC <noreply@enscribe.online>`, REPLY-TO `info@enscribe.online`. Confirm SES **production access** before cutover. |
| **3** | IAM on EC2 role (+ dev IAM user) | AWS infra | **Done (dev verified)** — Cognito policy on IAM user `enscribe-api-prod-ec2-role` (dev + prod pool ARNs); laptop verified `npm run smoke:cognito-dev`. Confirm same prod-pool policy on EC2 instance role before cutover. |
| **4** | `auth.users.cognito_sub` column + index | SQL migration | **Done** — column + partial unique index on RDS |
| **5** | JWT verify (`aws-jwt-verify`) | Code PR | Planned |
| **6** | `authController` → Cognito SDK | Code PR | Planned |
| **7** | Admin helpers (`AdminGetUser`, signup stub) | Code PR | Planned |
| **8** | User bulk import + password reset comms | Ops | Planned |
| **9** | Frontend: Cognito forgot-password **code** flow | `enscribe-web` | Planned |
| **10** | Cutover (flip env, invalidate Supabase sessions) | Ops | Planned |
| **11** | Decommission Supabase Auth | Ops + cleanup PR | After confidence window |

### Recommended order

```text
Phase A — Cognito infra (Parts 1–3)     Pool + SES + IAM (dev pool first)
Phase B — Schema (Part 4)               cognito_sub on RDS auth.users
Phase C — Code (Parts 5–7)              Dev pool; tests/auth.test.js green
Phase D — User import (Part 8)            Bulk AdminCreateUser; map cognito_sub
Phase E — Frontend (Part 9)               /reset-password code entry (if not done)
Phase F — Cutover (Part 10)             Maintenance window; flip prod env
Phase G — Cleanup (Part 11)             Remove SUPABASE_* auth secrets + supabase-js auth paths
```

**Parallel work:** Phase A (infra) and Phase B (SQL) can start while RDS is in the confidence window. Phase C can target a **dev** Cognito pool before prod RDS is declared stable.

### Phase progress checklist

| Phase | Status | Notes |
|-------|--------|-------|
| **A — Infra (Parts 1–3)** | **Done** | Dev IAM: `npm run smoke:cognito-dev` green. Before cutover: SES prod access + EC2 role prod pool policy. |
| **B — Schema (Part 4)** | **Done** | `auth.users.cognito_sub` on RDS |
| **C — Code (Parts 5–7)** | **Next** | JWT verify, `authController`, admin helpers |
| **D–G** | Planned | User import, FE reset, cutover, decommission |

### Phase A completion log (2026-07-02)

| Item | Detail |
|------|--------|
| Dev pool | `us-east-1_8zgtpuUJg`; app client `4gn9nb07hlmuch1f3rt47hoj6k`; access token 5 min |
| Prod pool | `us-east-1_UxICChcfK`; SES email configured |
| Auth flows | `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_USER_PASSWORD_AUTH` (optional), `ALLOW_REFRESH_TOKEN_AUTH` — **not** choice-based / SRP / custom |
| Sign-in API | `AdminInitiateAuth` + **`ADMIN_USER_PASSWORD_AUTH`** |
| SES | Domain `enscribe.online` verified; MAIL FROM `mail.enscribe.online`; DMARC `p=none` |
| Cognito email | `Enscribe Health LLC <noreply@enscribe.online>`; REPLY-TO `info@enscribe.online` |
| IAM dev user | `enscribe-api-prod-ec2-role` (IAM **user** behind `AWS_ACTIONS_*`) |
| Smoke | `npm run smoke:cognito-dev` — script: `sql/scripts/smoke-cognito-dev.mjs` |

**Pitfalls (learned):**

- **Required attributes are immutable** — only `email` at pool creation; do **not** require `nickname` (username lives in `userProfiles`).
- **`noreply@` with verified domain** — Cognito FROM dropdown shows domain; set address in **FROM sender name** (`Enscribe Health LLC <noreply@enscribe.online>`) or CLI `update-user-pool`.
- **MAIL FROM subdomain** — exactly **one** MX on `mail.enscribe.online`, region **`us-east-1`** only (`feedback-smtp.us-east-1.amazonses.com`).
- **IAM user ≠ EC2 role** — attach Cognito policy to IAM **user** for laptop (`AWS_ACTIONS_*`) and EC2 **instance role** for prod.
- **`auth.users.cognito_sub`** — only for API JWT resolution; not needed for `smoke:cognito-dev`.

---

## What changes vs what stays the same

| Layer | After Cognito cutover |
|-------|------------------------|
| **Client contract** | Unchanged — `POST /api/auth`, `POST /api/auth/refresh`, Bearer JWT on API routes |
| **Session layer** | Unchanged — encrypted `refreshTokens` vault, wrapper cookie (web), raw refresh (mobile), inactivity caps |
| **Canonical `user_id`** | Unchanged — **`auth.users.id`** (Supabase-era UUID) in all FKs and `request.user.id` |
| **Identity provider** | Supabase Auth → **Cognito User Pool** |
| **Per-request JWT verify** | `supabase.auth.getUser` (network) → **local JWKS verify** (`aws-jwt-verify`) |
| **Refresh exchange** | Supabase `/auth/v1/token` → Cognito `REFRESH_TOKEN_AUTH` |
| **Password reset UX** | Supabase magic link → Cognito **email code** + SPA confirm (FE change) |
| **Postgres** | RDS only — no Supabase DB |
| **Storage** | S3 only |

### Architecture

```text
┌──────────────┐   POST /api/auth    ┌─────────────┐   Cognito API   ┌──────────────┐
│ Web / Mobile │ ──────────────────► │  Fastify    │ ───────────────►│  User Pool   │
│              │◄─ Bearer access JWT │  (EC2)      │◄── tokens ─────│              │
└──────────────┘   Set-Cookie wrapper └──────┬──────┘                 └──────────────┘
                                             │
                    JWT verify: cognito_sub ─┼──► SELECT id FROM auth.users
                    request.user.id = auth.users.id (canonical UUID)
                                             │
                                             ▼
                                      ┌─────────────┐
                                      │  RDS        │
                                      │ refreshTokens│
                                      │ auth.users   │
                                      └─────────────┘
```

| Concern | Cognito | Enscribe API (keep) |
|---------|---------|---------------------|
| Password hash | ✓ | |
| Email verify / resend | ✓ | Thin wrapper in `authController` |
| Forgot password email | ✓ (SES) | `forgot-password` action |
| Access JWT issue | ✓ | Return to client as today |
| Refresh JWT issue | ✓ | Store encrypted in `refreshTokens` |
| Wrapper cookie (`tid`) | | ✓ |
| Token rotation / inactivity | | ✓ |
| Per-request auth | | Verify Cognito JWT locally; resolve `cognito_sub` → `auth.users.id` |

**Critical design (from RDS Part 7):** Cognito assigns its own `sub` per user. Do **not** rewrite every `user_id` column. Store `cognito_sub` on `auth.users` and resolve at login:

1. Verify Cognito access JWT locally.
2. `SELECT id, email FROM auth.users WHERE cognito_sub = $1` (or email fallback during migration).
3. Set `request.user = { id: auth.users.id, email }`.

All 27 FK constraints keep referencing `auth.users.id`.

You do **not** need Cognito Hosted UI for sign-in.

---

## Remaining Supabase surface (auth-only)

After RDS + `pg` migration (PR 0–5), **only auth and legacy storage helpers** still import `@supabase/supabase-js` for live behavior:

| Area | File(s) | Cognito migration |
|------|---------|-------------------|
| Sign-up / sign-in / sign-out | `authController.js` | Replace with Cognito SDK |
| Email resend / forgot password | `authController.js` | `ResendConfirmationCode`, `ForgotPassword` |
| Refresh token exchange | `authController.js` | `InitiateAuth` `REFRESH_TOKEN_AUTH` |
| JWT verify (Fastify plugin) | `authentication.js` | `aws-jwt-verify` |
| JWT verify (utilities) | `authenticateRequest.js`, `extractUserIdFromAccessToken` in `authController.js` | Same verifier |
| Admin user lookup | `userProfileController.js` (`ensureAuthUserExists`) | `AdminGetUser` or RDS query |
| Signup registry row | `authUsersStub.js` | Insert `cognito_sub` after Cognito sign-up |
| Supabase client factories | `supabase.js`, `supabaseAdmin.js` | Remove auth usage; delete or narrow to storage-only until Part 11 S3 cleanup |
| Ops script | `sql/scripts/export-and-decrypt-by-user/` | `SELECT` from RDS `auth.users` |

**Not auth (separate cleanup — Step 4 / S3 Part 11):** `recordingsStorage.js` Supabase branches, `cleanupController.js` passing `supabaseAdmin()` for job symmetry, `getSupabaseClient()` passed as unused `_supabase` in many `pg`-backed controllers.

---

## Part 1 — User pools + app clients

**Console:** Amazon Cognito → **User pools** → **Create user pool**

Use **separate pools**:

| Pool | Purpose |
|------|---------|
| `enscribe-dev` | Local + staging; Cognito default email OK; short access token (5–15 min) |
| `enscribe-prod` | Production; SES required |

### Pool settings

| Step | Enscribe recommendation |
|------|-------------------------|
| Application type | **Traditional web application** or **Other** (not using Cognito as login UI) |
| Sign-in | **Email** only; case **insensitive**; no separate username |
| **Required attributes** | **`email` only** — profile `username`/`specialty` live in `userProfiles`, not Cognito |
| Password policy | Min **8** chars (match API Zod) |
| MFA | Dev: off/optional; Prod: optional (plan required later if needed) |
| Account recovery | **Email** |
| Self-registration | **Enabled** (or disable + `AdminCreateUser` only) |
| Email (dev) | **Send email with Cognito** (50/day) |
| Email (prod) | **Send email with Amazon SES** — see Part 2 |
| Hosted UI | **Skip** for v1 |

Optional custom attribute: `legacy_supabase_id` (String, mutable) for support lookups — DB `cognito_sub` is source of truth.

**Do not require `nickname` or other standard attributes** — required attributes **cannot be removed** after pool creation.

### App client

**App integration** → **App clients** → **Create app client**

| Setting | Value |
|---------|-------|
| Name | `enscribe-api` (dev: `enscribe-api-dev`) |
| Client secret | **No** — server uses IAM + Admin APIs |
| Auth flows | ✅ **Server-side administrative credentials** (`ALLOW_ADMIN_USER_PASSWORD_AUTH`) |
| | ✅ **Get user tokens from existing authenticated sessions** (`ALLOW_REFRESH_TOKEN_AUTH`) |
| | ✅ **Username and password** (`ALLOW_USER_PASSWORD_AUTH`) — optional; CLI/debug |
| | ❌ Choice-based sign-in, SRP, custom auth |

### Token expiration

| Token | Dev | Prod |
|-------|-----|------|
| Access | 5–15 min | 1 hour |
| Refresh | 30 days (app vault still caps at 3 days) | Same |

Enscribe enforces `REFRESH_MAX_AGE_SECONDS` and `REFRESH_INACTIVITY_LIMIT_SECONDS` in `refreshTokens` **before** calling Cognito refresh.

### Dev test user

Create in **dev pool only** (not prod until Phase D):

- Email = `TEST_ACCOUNT_EMAIL` from `.env.local`
- Mark email **verified**; **permanent** password (`admin-set-user-password --permanent`)
- Status must be **Confirmed**, not Force change password

**Password reset flow (API-only — no Hosted UI redirect):**

1. API: `ForgotPassword` → Cognito emails a **code**
2. SPA: `/reset-password` — email + code + new password
3. API: `ConfirmForgotPassword`

---

## Part 2 — SES + Cognito email

### 2.1 Verify domain

**SES** (`us-east-1`) → **Verified identities** → create **Domain** `enscribe.online`

Add DKIM DNS records (Namecheap **Advanced DNS**). No separate SES identity needed for `noreply@` when domain is verified.

### 2.2 Production access

**SES → Account dashboard** → request **production access** (transactional). Until approved, only verified recipient emails receive mail.

### 2.3 Custom MAIL FROM domain

**SES → Identities → `enscribe.online` → Authentication tab → Custom MAIL FROM domain**

| Setting | Value |
|---------|-------|
| MAIL FROM domain | `mail.enscribe.online` |
| Behavior on MX failure | **Use default MAIL FROM domain** (while DNS propagates) |

**DNS (Namecheap)** — host `mail`:

| Type | Priority | Value |
|------|----------|-------|
| MX | 10 | `feedback-smtp.us-east-1.amazonses.com` |
| TXT | — | `v=spf1 include:amazonses.com ~all` |

**Exactly one MX** on `mail` — wrong region or duplicate MX breaks verification.

**DMARC** (optional, on root): TXT `_dmarc` → `v=DMARC1; p=none;`

### 2.4 Link SES to prod Cognito pool

**Cognito → `enscribe-prod` → Messaging → Email**

| Setting | Value |
|---------|-------|
| Email provider | **Amazon SES** |
| SES Region | **US East (N. Virginia)** |
| FROM email address | **`enscribe.online`** (domain in dropdown) |
| FROM sender name | **`Enscribe Health LLC <noreply@enscribe.online>`** |
| REPLY-TO | **`info@enscribe.online`** |

Domain-verified FROM addresses can only be set via sender name or CLI:

```bash
aws cognito-idp update-user-pool \
  --user-pool-id us-east-1_PROD_POOL_ID \
  --email-configuration EmailSendingAccount=DEVELOPER,SourceArn=arn:aws:ses:us-east-1:ACCOUNT_ID:identity/enscribe.online,From="Enscribe Health LLC <noreply@enscribe.online>",ReplyToEmailAddress=info@enscribe.online
```

**Message templates:** forgot-password must include **`{####}`** code placeholder.

---

## Part 3 — IAM

API calls Cognito via **IAM**, not a client secret. Uses `getAwsSdkBaseClientConfig()` — EC2 instance profile in prod, `AWS_ACTIONS_*` locally.

### 3.1 Policy document

Attach to **IAM user** (local dev) and **EC2 instance role** (prod):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CognitoAuthDev",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:SignUp",
        "cognito-idp:ConfirmSignUp",
        "cognito-idp:ResendConfirmationCode",
        "cognito-idp:InitiateAuth",
        "cognito-idp:AdminInitiateAuth",
        "cognito-idp:ForgotPassword",
        "cognito-idp:ConfirmForgotPassword",
        "cognito-idp:GlobalSignOut",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:ListUsers"
      ],
      "Resource": "arn:aws:cognito-idp:us-east-1:ACCOUNT_ID:userpool/DEV_POOL_ID"
    },
    {
      "Sid": "CognitoAuthProd",
      "Effect": "Allow",
      "Action": [
        "cognito-idp:SignUp",
        "cognito-idp:ConfirmSignUp",
        "cognito-idp:ResendConfirmationCode",
        "cognito-idp:InitiateAuth",
        "cognito-idp:AdminInitiateAuth",
        "cognito-idp:ForgotPassword",
        "cognito-idp:ConfirmForgotPassword",
        "cognito-idp:GlobalSignOut",
        "cognito-idp:AdminGetUser",
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:ListUsers"
      ],
      "Resource": "arn:aws:cognito-idp:us-east-1:ACCOUNT_ID:userpool/PROD_POOL_ID"
    }
  ]
}
```

| Principal | Attach | Pools |
|-----------|--------|-------|
| IAM **user** `enscribe-api-prod-ec2-role` (keys in `.env.local`) | Managed or inline | Dev + prod |
| EC2 **role** `enscribe-api-ec2-instance-role` | Inline `EnscribeCognitoAuthProd` | Prod only |

### 3.2 Smoke test (local)

```bash
npm run smoke:cognito-dev
```

Requires in `.env.local`: `AWS_ACTIONS_*`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, `TEST_ACCOUNT_EMAIL`, `TEST_ACCOUNT_PASSWORD` (dev pool only).

| API | Cognito operation |
|-----|-------------------|
| sign-up | `SignUp` or `AdminCreateUser` |
| sign-in | `AdminInitiateAuth` (**`ADMIN_USER_PASSWORD_AUTH`**) |
| refresh | `InitiateAuth` (`REFRESH_TOKEN_AUTH`) |
| forgot-password | `ForgotPassword` |
| reset confirm | `ConfirmForgotPassword` |
| resend verify | `ResendConfirmationCode` |
| sign-out | `GlobalSignOut` (optional) + vault revoke |

---

## Part 4 — Schema: `cognito_sub`

Applied on RDS:

```sql
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS cognito_sub text;

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_cognito_sub_key
  ON auth.users (cognito_sub)
  WHERE cognito_sub IS NOT NULL;

COMMENT ON COLUMN auth.users.cognito_sub IS
  'Cognito User Pool sub; maps JWT to canonical auth.users.id';
```

**Signup path (post-Cognito):** After `SignUp` / `AdminCreateUser`, insert or update:

```sql
INSERT INTO auth.users (id, email, cognito_sub)
VALUES ($1::uuid, $2, $3)
ON CONFLICT (id) DO UPDATE SET cognito_sub = EXCLUDED.cognito_sub, email = EXCLUDED.email;
```

| Strategy | `auth.users.id` | `cognito_sub` |
|----------|-----------------|---------------|
| **A (recommended)** | New UUID generated by API **before** Cognito call | Cognito `sub` from response |
| **B (avoid)** | Let Cognito assign `sub` | Breaks Option A FK model |

**Dev API testing only:** link existing RDS row to dev pool sub:

```sql
UPDATE auth.users SET cognito_sub = 'DEV_POOL_SUB' WHERE lower(email) = lower('test@example.com');
```

Not needed for `smoke:cognito-dev`. Dev and prod pools have **different subs** for the same email.

Update `authUsersStub.js` → `ensureAuthUserAfterSignup(userId, email, cognitoSub)` when `AUTH_PROVIDER=cognito`.

---

## Part 5 — JWT verification

Replace `supabase.auth.getUser(token)` with local verification.

**Dependency:** `aws-jwt-verify`

**New module:** `src/utils/cognitoJwt.js`

```javascript
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: 'access',
  clientId: process.env.COGNITO_CLIENT_ID,
});

export async function verifyAccessToken(token) {
  const payload = await verifier.verify(token);
  return payload; // payload.sub = cognito_sub (NOT auth.users.id)
}
```

**Resolver:** `src/utils/resolveAppUserFromCognito.js` — `cognito_sub` → `{ id: auth.users.id, email }`

JWKS URL (cached by library): `https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json`

**Files to update:**

| File | Change |
|------|--------|
| `src/fastify/plugins/authentication.js` | Verify JWT → resolve app user → `request.user` |
| `src/utils/authenticateRequest.js` | Same |
| `authController.js` `extractUserIdFromAccessToken` | Same |

**Env flag (optional):** `AUTH_PROVIDER=supabase|cognito` during staging; remove after cutover.

---

## Part 6 — `authController.js` mapping

| Action | Supabase today | Cognito |
|--------|----------------|---------|
| `signUp` | `auth.signUp` | `SignUpCommand` + stub row with `cognito_sub` |
| `signIn` | `signInWithPassword` | `AdminInitiateAuth` **`ADMIN_USER_PASSWORD_AUTH`** |
| `signOut` | `auth.signOut` + vault revoke | Vault revoke + optional `GlobalSignOut` |
| `resend` | `auth.resend` | `ResendConfirmationCodeCommand` |
| `forgot-password` | `resetPasswordForEmail` | `ForgotPasswordCommand` |
| `confirm-forgot-password` | *(Supabase link)* | **New action** — `ConfirmForgotPasswordCommand` |
| `refresh` | Supabase token endpoint | `InitiateAuth` `REFRESH_TOKEN_AUTH` |

### SDK examples

**Sign-in:**

```javascript
import { AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const res = await client.send(new AdminInitiateAuthCommand({
  UserPoolId: process.env.COGNITO_USER_POOL_ID,
  ClientId: process.env.COGNITO_CLIENT_ID,
  AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
  AuthParameters: { USERNAME: email, PASSWORD: password },
}));
```

**Sign-up:**

```javascript
await client.send(new SignUpCommand({
  ClientId: process.env.COGNITO_CLIENT_ID,
  Username: email,
  Password: password,
  UserAttributes: [{ Name: 'email', Value: email }],
}));
```

**Refresh:**

```javascript
await client.send(new InitiateAuthCommand({
  ClientId: process.env.COGNITO_CLIENT_ID,
  AuthFlow: 'REFRESH_TOKEN_AUTH',
  AuthParameters: { REFRESH_TOKEN: rawStoredRefresh },
}));
```

**Preserve unchanged:** refresh vault TTLs, wrapper cookie (`tid` + `sub` = **app user id**), anti-enumeration ([AUTH_SIGN_UP_API.md](./AUTH_SIGN_UP_API.md)), optional `userProfile` on sign-up.

---

## Part 7 — Admin helpers

| Today | After |
|-------|-------|
| `admin.auth.admin.getUserById(userId)` in `userProfileController.js` | `SELECT 1 FROM auth.users WHERE id = $1` **or** `AdminGetUser` by email |
| `authUsersStub` after Supabase sign-up | After Cognito sign-up with `cognito_sub` |
| `auth.admin.listUsers` in export script | `SELECT id, email, cognito_sub FROM auth.users` |

---

## Part 8 — User migration (~26 prod users)

Supabase password hashes **cannot** be imported into Cognito.

| Step | Action |
|------|--------|
| 1 | Export `SELECT id, email FROM auth.users` from RDS |
| 2 | Dev/staging: import into **dev** pool first; validate auth tests |
| 3 | Prod: `AdminCreateUser` per row (`MessageAction: SUPPRESS`); force password reset |
| 4 | `UPDATE auth.users SET cognito_sub = $1 WHERE id = $2` |
| 5 | Email all users: one-time password reset |
| 6 | Invalidate all `refreshTokens` at cutover |

**Do not** import dev-pool test users into prod. Same email in two pools = two different Cognito `sub`s.

Optional: Cognito custom attribute `legacy_supabase_id` = `auth.users.id` for support.

---

## Part 9 — Frontend (`enscribe-web`)

| Question | Impact |
|----------|--------|
| SPA imports `@supabase/supabase-js`? | Remove; API-only Bearer tokens |
| Password reset page | **Verification code** + new password (not Supabase URL hash) |
| Token storage | Unchanged if API shape unchanged |

**API addition:** `POST /api/auth` action `confirm-forgot-password` with `{ email, code, newPassword }`.

---

## Part 10 — Cutover cheat sheet

### Pre-cutover checklist

- [ ] RDS stable ≥ 1–2 weeks (or agreed risk acceptance)
- [ ] Dev Cognito pool: full `npm run test:auth` green (requires Phase C)
- [x] Prod Cognito pool + SES domain/Mail FROM/Cognito email config
- [ ] SES **production access** (out of sandbox)
- [ ] IAM policy on EC2 instance role (dev user verified — `npm run smoke:cognito-dev`)
- [x] `cognito_sub` migration applied on RDS
- [ ] All prod users imported; `cognito_sub` populated
- [ ] FE deployed with code-based reset
- [ ] GitHub secrets: `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`
- [ ] Rollback plan documented

### Cutover window (~30–60 min)

1. Announce maintenance — users must re-login.
2. Deploy API with `AUTH_PROVIDER=cognito`.
3. Truncate or expire `refreshTokens`.
4. `pm2 restart` API + workers.
5. Smoke: sign-in, protected route, refresh, sign-up, forgot password.
6. Monitor CloudTrail Cognito failures, API 401 rate.

### Rollback

Revert to Supabase env vars. Avoid rollback after mass Cognito password reset.

---

## Part 11 — Decommission Supabase Auth

After **2–4 weeks** stable on Cognito:

| Task | Outcome |
|------|---------|
| Remove `SUPABASE_*` auth secrets from deploy | Cognito env only |
| Remove `@supabase/supabase-js` (if no storage fallback) | Smaller bundle |
| Delete `src/utils/supabase.js` auth paths | Or entire module after S3 Part 11 |
| Cancel Supabase project or downgrade | Cost savings |

**Full Supabase exit (Step 4):** [RDS Part 11](./RDS_POSTGRES_MIGRATION.md), [S3 Part 11](./S3_AUDIO_FILES_MIGRATION.md).

---

## Code PR strategy

| PR | Scope | Tests |
|----|-------|-------|
| **Auth 0** | `cognitoJwt.js`, resolver, `AUTH_PROVIDER`, `authentication.js` | Unit tests |
| **Auth 1** | `authController` sign-in/sign-up/sign-out | `npm run test:auth` |
| **Auth 2** | Refresh + forgot/confirm password | Integration tests |
| **Auth 3** | `userProfileController`, `authUsersStub` | Profile + signup tests |
| **Auth 4** | Remove Supabase auth paths; deploy secrets | Full CI |

---

## Environment variables

### Add (Cognito)

```bash
AUTH_PROVIDER=cognito
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
COGNITO_REGION=us-east-1

# Local dev — same IAM user as Bedrock/S3
AWS_ACTIONS_ACCESS_KEY_ID=...
AWS_ACTIONS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1

TEST_ACCOUNT_EMAIL=...
TEST_ACCOUNT_PASSWORD=...

# Unchanged session layer
REFRESH_TOKEN_SIGNING_KEY_HEX=...
REFRESH_TOKEN_AES_KEY_HEX=...
REFRESH_MAX_AGE_SECONDS=259200
REFRESH_INACTIVITY_LIMIT_SECONDS=259200
REFRESH_COOKIE_SAMESITE=lax
REFRESH_COOKIE_SECURE=true

FRONTEND_URL=https://app.enscribe.online
APP_BASE_URL=https://app.enscribe.online
```

Use **dev pool IDs** in `.env.local`; prod IDs in EC2 env / GitHub secrets at cutover.

### Remove (after Part 11)

```bash
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

---

## Testing

**Phase A infra:**

```bash
npm run smoke:cognito-dev
```

**After Phase C:**

```bash
npm run test:auth
npm run test:setup
npm run test:recordings
```

**Manual smoke:** forgot password code flow; refresh via cookie/body; `request.user.id` matches pre-migration `user_id`.

---

## Security and compliance

| Item | Action |
|------|--------|
| TLS | HTTPS on API and app |
| Token storage | HTTP-only wrapper cookie (web); secure storage (mobile) |
| CloudTrail | Monitor `cognito-idp` SignIn/SignUp failures |
| WAF | Rate-limit `POST /api/auth` if exposed |
| Secrets | Pool ID and client ID are not secret; no client secret with Admin API pattern |

---

## What not to configure (v1)

| Feature | Skip |
|---------|------|
| Hosted UI login | API handles login |
| Social / SAML IdP | Not in use |
| Cognito Identity Pools | EC2 role covers AWS SDK |
| User Pool groups | Unless needed later |
| Required `nickname` in Cognito | Use `userProfiles.username` |

---

## Infrastructure as code (optional)

Define in CDK/Terraform/CloudFormation before prod cutover: `AWS::Cognito::UserPool`, `AWS::Cognito::UserPoolClient`, SES identity.

---

## Effort estimate

| Slice | Rough effort |
|-------|--------------|
| Cognito infra + SES | 2–4 days |
| Schema + resolver | 1 day |
| API auth rewrite | 1–2 weeks |
| User import + comms | 2–3 days |
| Frontend reset flow | 2–5 days |
| Cutover + monitoring | 1 day |
| **Total** | **~2–4 weeks** |

---

## FAQ

### Is Cognito the right next step after RDS?

**Yes**, once RDS is stable. Auth is the last Supabase service the API depends on for production behavior.

### Can we start Cognito before RDS is fully stable?

**Infra and dev-pool code: yes.** **Prod cutover: no** — finish RDS confidence window first.

### Do we need to change all `user_id` values?

**No.** Keep `auth.users.id` as canonical. Map Cognito `sub` in `cognito_sub` only.

### Dev user in prod pool?

**No** for routine work. Dev pool for Phase C; prod pool for Phase D import + cutover.

### Is auth the last migration step?

**Last functional Supabase dependency, yes.** Step 4 decommissions remaining `supabase-js` paths.

---

## Related docs

- [SUPABASE_TO_AWS_MIGRATION.md](./SUPABASE_TO_AWS_MIGRATION.md) — overall order and decision matrix
- [RDS_POSTGRES_MIGRATION.md](./RDS_POSTGRES_MIGRATION.md) — `auth.users` Option A, Part 7
- [AUTH_SIGN_UP_API.md](./AUTH_SIGN_UP_API.md) — sign-up contract and anti-enumeration
- [BAA_ARCHITECTURE.md](./BAA_ARCHITECTURE.md) — Bearer JWT on HIPAA routes
