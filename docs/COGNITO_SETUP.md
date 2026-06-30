# Amazon Cognito User Pools — setup walkthrough (Enscribe)

Step-by-step guide for configuring Cognito to replace **Supabase Auth** in the Enscribe stack. Assumes:

- **API-mediated auth** — clients call `POST /api/auth` and `POST /api/auth/refresh` on Fastify (EC2), not Cognito Hosted UI for login.
- **Email + password only** (no Google/Apple SSO in scope today).
- **Session layer stays on the API** — encrypted `refreshTokens` table, HTTP-only wrapper cookie (web), raw refresh in body (mobile).
- **HIPAA** — use an AWS account/region covered by your **AWS BAA**; keep Cognito, SES, EC2, and RDS in that boundary.

**Related:** [SUPABASE_TO_AWS_MIGRATION.md](./SUPABASE_TO_AWS_MIGRATION.md) for migration order (S3 → `pg` → RDS + Cognito cutover).

---

## Architecture (what Cognito does vs what the API keeps)

```
┌──────────────┐     POST /api/auth      ┌─────────────┐     Cognito API    ┌──────────────┐
│ Web / Mobile │ ───────────────────────►│  Fastify    │ ──────────────────►│  User Pool   │
│              │◄── Bearer access JWT ───│  (EC2)      │◄── tokens ───────│  (identity)  │
└──────────────┘     Set-Cookie wrapper  └──────┬──────┘                    └──────────────┘
                                                 │
                                                 │ refresh vault, rotation,
                                                 │ inactivity (unchanged)
                                                 ▼
                                          ┌─────────────┐
                                          │  Postgres   │
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
| Per-request auth | | Verify Cognito JWT locally (JWKS) |

You do **not** need Cognito Hosted UI for sign-in if all login goes through your API.

---

## 0. Prerequisites

| Item | Notes |
|------|--------|
| **AWS region** | Same as EC2/RDS (e.g. `us-east-1` from `AWS_REGION` in deploy). Cognito is regional. |
| **AWS BAA** | Enable for the account; Cognito User Pools are HIPAA-eligible when configured per AWS guidance. |
| **SES** | Cognito email (verify, reset) requires SES in **production** (sandbox only allows verified addresses). |
| **Domain** | Know production FE URLs from CORS: `https://app.enscribe.online`, `https://enscribe.online`, etc. |
| **API host** | e.g. `https://api.enscribe.online` — not a Cognito callback unless you add Hosted UI later. |

---

## 1. Create the User Pool

**Console:** Amazon Cognito → **User pools** → **Create user pool**

### Step 1 — Application type

- Choose **Traditional web application** or **Other** (you are not using Cognito as the login UI).
- Pool name: e.g. `enscribe-prod` / `enscribe-dev`.

### Step 2 — Sign-in identifiers

| Setting | Enscribe recommendation |
|---------|-------------------------|
| Sign-in options | **Email** only (matches current Supabase email login). |
| User name | Do **not** require username; email is the identifier. |
| Case sensitivity | **Case insensitive** for email (fewer support issues). |

### Step 3 — Required attributes

| Attribute | Required? |
|-----------|-----------|
| `email` | Yes (default when email sign-in) |
| `name`, `phone`, etc. | No — profile lives in `userProfiles` |

Optional: add a **custom attribute** `legacy_supabase_id` (String) if you need to map old `auth.users.id` during migration. Mutable, not required.

### Step 4 — Password policy

Align with API validation (min 8 chars in Zod today):

| Setting | Suggested |
|---------|-----------|
| Minimum length | **8** |
| Require lowercase / uppercase / numbers | Match product rules (consider requiring all three + symbol for healthcare). |
| Temporary password validity | 7 days (only for admin-created users during import). |

### Step 5 — Multi-factor authentication (MFA)

| Environment | Suggestion |
|-------------|------------|
| Dev | **Optional** or off |
| Prod | Start **Optional**; plan **Required** for HIPAA-heavy customers later |

TOTP (authenticator app) is the usual choice. SMS costs extra and has deliverability issues.

### Step 6 — User account recovery

- Enable **Email** for self-service reset (maps to `ForgotPassword` / `ConfirmForgotPassword` from your API).

### Step 7 — Self-registration

- **Enable self-registration** (equivalent to Supabase `signUp`).
- If you need invite-only later, disable and use `AdminCreateUser` only.

### Step 8 — Email delivery

| Mode | When |
|------|------|
| **Send email with Cognito** (default) | Quick dev only; low volume limits. |
| **Send email with Amazon SES** | **Production** — required for scale and domain reputation. |

See [§4 SES setup](#4-ses-for-verification-and-password-reset) before going live.

### Step 9 — Hosted UI (optional)

- You can **skip** or create a domain for later.
- Enscribe login is via **`POST /api/auth`** — no Hosted UI required for v1.

If you create a domain anyway (`auth.enscribe.online`), it helps with OAuth later, not email/password via API.

---

## 2. App client configuration

After the pool exists: **App integration** → **App clients** → **Create app client**

| Setting | Value | Why |
|---------|-------|-----|
| App client name | `enscribe-api` | Server-side BFF |
| **Generate client secret** | **No** | Public client; server uses **IAM + Admin APIs** from EC2 (no secret in env). |
| Authentication flows | Enable **`ALLOW_USER_PASSWORD_AUTH`** | `InitiateAuth` / `AdminInitiateAuth` with `USER_PASSWORD_AUTH`. |
| | Enable **`ALLOW_REFRESH_TOKEN_AUTH`** | Refresh exchange in `refreshRefreshToken`. |
| | Enable **`ALLOW_USER_SRP_AUTH`** | Optional; not needed if you only use `USER_PASSWORD_AUTH` from server. |
| | Disable custom auth / OAuth flows | Not used v1. |

### Token expiration

**App client** → **Edit** → **Authentication flows** / **Token expiration** (location varies slightly in console):

| Token | Supabase-ish behavior | Cognito suggestion |
|-------|----------------------|-------------------|
| **Access token** | Short (tests use ~30s–1h) | **1 hour** prod; shorter in dev test pool |
| **ID token** | N/A for API | 1 hour (default) |
| **Refresh token** | Supabase issues long; **your vault caps at 3 days** (`REFRESH_MAX_AGE_SECONDS`) | **30 days** Cognito max is fine — **your DB policy still wins** |

Important: Enscribe enforces `REFRESH_MAX_AGE_SECONDS` and `REFRESH_INACTIVITY_LIMIT_SECONDS` in `refreshTokens` **before** calling Cognito refresh. Cognito refresh TTL can be ≥ your app TTL.

### Refresh token rotation (Cognito setting)

Cognito can rotate refresh tokens on each use. **Compatible** with your vault pattern — on each refresh you already insert a new row and revoke the old one. Enable Cognito refresh rotation if offered; store the **new** Cognito refresh token in `token_enc` each time.

---

## 3. Callback and redirect URLs (password reset / future OAuth)

Even without Hosted UI login, configure **Allowed callback URLs** and **Sign-out URLs** if you use:

- Cognito Hosted UI for reset (optional), or
- OAuth later.

For **API-only forgot-password** (recommended):

1. API: `ForgotPassword` → Cognito emails a **code** (not a Supabase-style magic link).
2. SPA: `/reset-password` collects **email + code + new password**.
3. API: `ConfirmForgotPassword`.

No Cognito redirect URL required for that flow. **Frontend change** from Supabase recovery link → code entry.

If you later use Hosted UI or magic links, add:

```text
https://app.enscribe.online/reset-password
http://localhost:3000/reset-password
```

Under **App client** → **Hosted UI** / **Allowed callback URLs**.

---

## 4. SES for verification and password reset

### 4.1 Verify domain or email

**SES** → **Verified identities**:

- Verify **`enscribe.online`** (or sending subdomain `mail.enscribe.online`) — recommended.
- Or verify individual from-address e.g. `noreply@enscribe.online`.

### 4.2 Move out of SES sandbox

- AWS support request: production access.
- Until then, only verified recipient emails receive Cognito mail.

### 4.3 Connect SES to Cognito

**Cognito** → your pool → **Messaging** → **Email**:

| Setting | Value |
|---------|-------|
| Email provider | **Amazon SES** |
| FROM address | `noreply@enscribe.online` (must be verified in SES) |
| REPLY-TO | `support@enscribe.online` (optional) |
| Configuration set | Optional (for bounce/complaint metrics) |

### 4.4 Customize templates (optional)

**Message templates** → Verification / Forgot password:

- Keep copy aligned with Enscribe branding.
- Forgot-password template must include **`{####}`** placeholder for the code (Cognito requirement).

---

## 5. IAM — EC2 API permissions

Your Fastify server on EC2 calls Cognito with the **instance IAM role** (same pattern as Bedrock/S3). Attach an inline or managed policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CognitoAuthBFF",
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
      "Resource": "arn:aws:cognito-idp:REGION:ACCOUNT_ID:userpool/POOL_ID"
    }
  ]
}
```

| API | Cognito operation | Maps from Supabase |
|-----|-------------------|-------------------|
| sign-up | `SignUp` or `AdminCreateUser` | `auth.signUp` |
| sign-in | `AdminInitiateAuth` (`USER_PASSWORD_AUTH`) | `signInWithPassword` |
| refresh | `InitiateAuth` (`REFRESH_TOKEN_AUTH`) | `/auth/v1/token?grant_type=refresh_token` |
| forgot-password | `ForgotPassword` | `resetPasswordForEmail` |
| reset confirm | `ConfirmForgotPassword` | SPA recovery handler |
| resend verify | `ResendConfirmationCode` | `auth.resend` |
| sign-out | `GlobalSignOut` (optional) + vault revoke | `auth.signOut` |
| profile guard | `AdminGetUser` | `auth.admin.getUserById` |

**Local dev:** use `AWS_ACTIONS_ACCESS_KEY_ID` / `AWS_ACTIONS_SECRET_ACCESS_KEY` (same as other AWS SDK calls) with the same policy attached to an IAM user, or SSO profile.

**Do not** put a Cognito app client secret on EC2 if you use Admin APIs with IAM.

---

## 6. JWT verification on the API

Replace `supabase.auth.getUser(token)` in `authentication.js` with **local** verification — no network call per request.

### 6.1 What’s in the access token

Cognito access JWT claims (typical):

| Claim | Use in Enscribe |
|-------|-----------------|
| `sub` | **`request.user.id`** — must match `user_id` in Postgres |
| `username` | Often same as email when email sign-in |
| `email` | `request.user.email` (may be in id token instead; access token v2 includes `username`) |
| `token_use` | Must be **`access`** |
| `iss` | `https://cognito-idp.{region}.amazonaws.com/{userPoolId}` |
| `client_id` | Your app client id |

Use **`aws-jwt-verify`** (add dependency) or `jose` + JWKS fetch cached.

```javascript
import { CognitoJwtVerifier } from 'aws-jwt-verify';

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: 'access',
  clientId: process.env.COGNITO_CLIENT_ID,
});

// in authenticate hook:
const payload = await verifier.verify(token);
request.user = { id: payload.sub, email: payload.email ?? payload.username };
```

### 6.2 JWKS URL (for reference)

```text
https://cognito-idp.{region}.amazonaws.com/{userPoolId}/.well-known/jwks.json
```

`aws-jwt-verify` fetches and caches this automatically.

---

## 7. Environment variables (enscribe-api)

Add to `.env.local`, GitHub Actions secrets, and EC2 env file:

```bash
# Cognito
COGNITO_USER_POOL_ID=us-east-1_XXXXXXXXX
COGNITO_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
COGNITO_REGION=us-east-1   # optional if same as AWS_REGION

# Existing session layer (unchanged)
REFRESH_TOKEN_SIGNING_KEY_HEX=
REFRESH_TOKEN_AES_KEY_HEX=
REFRESH_MAX_AGE_SECONDS=259200
REFRESH_INACTIVITY_LIMIT_SECONDS=259200
REFRESH_COOKIE_SAMESITE=lax
REFRESH_COOKIE_SECURE=true
REFRESH_COOKIE_DOMAIN=   # optional, e.g. .enscribe.online

# Frontend (password reset copy / redirects)
FRONTEND_URL=https://app.enscribe.online
APP_BASE_URL=https://app.enscribe.online
```

Remove when cut over: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (keep DB URL until RDS migration).

---

## 8. API mapping — Supabase call → Cognito SDK

Pseudocode for `authController.js` rewrite:

### Sign-up

```javascript
import {
  CognitoIdentityProviderClient,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';

await client.send(new SignUpCommand({
  ClientId: process.env.COGNITO_CLIENT_ID,
  Username: email,
  Password: password,
  UserAttributes: [{ Name: 'email', Value: email }],
}));
// If pool requires confirmation: no session yet (same as Supabase confirm-email path)
// Then optional upsertUserProfileForUser(sub from AdminGetUser after confirm, or from SignUp response)
```

If email auto-confirm in dev: set pool **Automatic verification** or use `AdminCreateUser` + `MessageAction: SUPPRESS` + `AdminSetUserPassword`.

### Sign-in

```javascript
import { AdminInitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const res = await client.send(new AdminInitiateAuthCommand({
  UserPoolId: process.env.COGNITO_USER_POOL_ID,
  ClientId: process.env.COGNITO_CLIENT_ID,
  AuthFlow: 'USER_PASSWORD_AUTH',
  AuthParameters: { USERNAME: email, PASSWORD: password },
}));
const accessToken = res.AuthenticationResult.AccessToken;
const refreshToken = res.AuthenticationResult.RefreshToken;
// → store refresh in refreshTokens table, return access to client (unchanged)
```

### Refresh

```javascript
import { InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';

const res = await client.send(new InitiateAuthCommand({
  ClientId: process.env.COGNITO_CLIENT_ID,
  AuthFlow: 'REFRESH_TOKEN_AUTH',
  AuthParameters: { REFRESH_TOKEN: rawStoredRefresh },
}));
```

### Forgot password

```javascript
import { ForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';

await client.send(new ForgotPasswordCommand({
  ClientId: process.env.COGNITO_CLIENT_ID,
  Username: email,
}));
```

New API action or extend SPA: **`confirm-forgot-password`** with `{ email, code, newPassword }` → `ConfirmForgotPasswordCommand`.

---

## 9. User migration from Supabase

Cognito **cannot** import Supabase password hashes directly.

| Strategy | Pros | Cons |
|----------|------|------|
| **Force password reset** | Simple, secure | All users reset once |
| **AdminCreateUser + temp password + FORCE_CHANGE_PASSWORD** | Controlled rollout | Support load |
| **Migration Lambda** on first login | Seamless if you verify old hash once | Custom code; only if you read Supabase hash (hard) |

**Preserve `user_id`:** When importing, set Cognito **`sub`** to match existing UUID only if you use a **import job** with fixed sub (Cognito import CSV) or store mapping `legacy_supabase_id` custom attribute and update FKs. Default `SignUp` assigns a **new** `sub` — would break all `user_id` FKs unless you migrate IDs.

**Recommended:** bulk import tool that creates users with **predetermined `sub`** equal to `auth.users.id` (Cognito `AdminCreateUser` with `Username` = email, map `sub` via import file or post-create — note: `sub` is assigned by Cognito at create; for fixed IDs use [CSV import with `cognito:username` and sub mapping](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-using-import-tool.html) or accept new subs and run SQL `UPDATE` across tables).

Practical approach for Enscribe:

1. Export `auth.users(id, email)` from Supabase.
2. `AdminCreateUser` each user; record `old_id → new_sub` if subs change.
3. If subs change: one-time SQL migration `UPDATE ... SET user_id = new_sub`.
4. Force password reset email via Cognito.

---

## 10. Security and compliance checklist

| Item | Action |
|------|--------|
| TLS | Already HTTPS on API and app |
| Token storage | Web: HTTP-only cookie for wrapper only; mobile: refresh in secure storage |
| Advanced security | Cognito **Advanced security features** (risk-based adaptive auth) — optional add-on |
| CloudWatch | Log Cognito `SignIn` / `SignUp` failures via CloudTrail (`cognito-idp.amazonaws.com`) |
| WAF | Rate-limit `POST /api/auth` on ALB/CloudFront if exposed |
| Deletion | `AdminDeleteUser` or user self-delete flow; CASCADE in Postgres on `user_id` |
| Secrets | Pool ID and client ID are not secret; no client secret with Admin API pattern |

---

## 11. Dev vs prod pools

Use **separate user pools**:

| Pool | Purpose |
|------|---------|
| `enscribe-dev` | Local + staging; SES sandbox; short access token for refresh tests |
| `enscribe-prod` | Production |

`tests/auth.test.js` uses `TEST_ACCOUNT_EMAIL` / `TEST_ACCOUNT_PASSWORD` — create that user in the **dev** pool.

---

## 12. Testing after setup

Run against a staging API pointed at the dev pool:

```bash
npm run test:auth
npm run test:setup
npm run test:recordings
```

Manual smoke:

1. Sign-up → verification email (if enabled) → sign-in.
2. `Authorization: Bearer` on `GET /api/me/entitlements`.
3. `POST /api/auth/refresh` with cookie — new `accessToken`, `tid` rotates.
4. Forgot password → code email → confirm on `/reset-password` (once FE supports code flow).
5. Sign-out → cookie cleared; refresh fails.

---

## 13. Console checklist (quick reference)

- [ ] User pool created (email sign-in, password policy)
- [ ] MFA policy set
- [ ] SES verified + linked to pool
- [ ] Email templates reviewed (verification + forgot password)
- [ ] App client `enscribe-api` — no secret, `USER_PASSWORD_AUTH` + `REFRESH_TOKEN_AUTH`
- [ ] Token TTLs configured
- [ ] IAM policy on EC2 role (and dev IAM user)
- [ ] Env vars on EC2 / GitHub secrets
- [ ] `authentication.js` uses `aws-jwt-verify`
- [ ] `authController.js` uses Cognito SDK
- [ ] FE `/reset-password` handles Cognito **code** flow
- [ ] User migration plan + `user_id` / `sub` alignment
- [ ] CloudTrail / alarms for auth failures

---

## 14. Infrastructure as code (optional)

For repeatability, define the pool in **CDK**, **Terraform**, or **CloudFormation**:

- `AWS::Cognito::UserPool`
- `AWS::Cognito::UserPoolClient`
- `AWS::Cognito::UserPoolDomain` (optional)
- SES identity (separate stack)

Console walkthrough above maps 1:1 to those resources; IaC is recommended before prod cutover.

---

## 15. What not to configure (yet)

| Feature | Skip for v1 |
|---------|-------------|
| Hosted UI login page | API handles login |
| Social / SAML IdP | Not in use |
| Cognito Identity Pools (federated AWS creds) | EC2 role already covers AWS SDK |
| User Pool groups | Unless billing/roles need IAM-style groups later |

---

## Related docs

- [SUPABASE_TO_AWS_MIGRATION.md](./SUPABASE_TO_AWS_MIGRATION.md) — order of migration; why Cognito is not step 1 in prod
- [AUTH_SIGN_UP_API.md](./AUTH_SIGN_UP_API.md) — current API contract
- [BAA_ARCHITECTURE.md](./BAA_ARCHITECTURE.md) — Bearer JWT on HIPAA routes
