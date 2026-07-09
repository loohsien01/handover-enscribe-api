# Auth API: `action: sign-up`

This document describes **`POST /api/auth`** when the body includes **`"action": "sign-up"`**. One request atomically creates:

1. The auth user (Supabase or Cognito)
2. The **`auth.users`** registry row on RDS (when applicable)
3. The **`public."userProfiles"`** row

If any required step fails, the API returns an error and **compensates** (rolls back Postgres rows and deletes the IdP user when one was created). There is **no** partial success (`201` with a profile error).

General auth behaviors (cookies, refresh, other actions) are not fully covered here; this file focuses on sign-up.

All paths are under your API base (for example **`/api`** in development).

---

## Request

**`POST /api/auth`**

**Headers**

| Header | Notes |
|--------|--------|
| `Content-Type` | `application/json` |
| `Accept` | Include `application/json` if you want the **mobile/JSON** response shape for the session branch (`message`, `user`, `token`). If `Accept` does not include `application/json`, the server uses the **web** shape (e.g. `user` and `token` without `message` when a session exists). |

**Body (JSON)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action` | string | Yes | Must be `"sign-up"`. |
| `email` | string | Yes | Valid email format. |
| `password` | string | Yes | Minimum 8 characters. |
| `userProfile` | object | Yes | Same shape as **`POST /api/user-profile`**: `username` and `specialty`, both non-empty strings. |

Example:

```json
{
  "action": "sign-up",
  "email": "provider@example.com",
  "password": "minimum8chars",
  "userProfile": {
    "username": "dr_smith",
    "specialty": "Pediatrics"
  }
}
```

---

## Success responses (`201 Created`)

Sign-up succeeds only when auth identity, `auth.users` (RDS), and `userProfiles` are all written. The body always includes **`user`** (at least `id`, `email`) and **`userProfile`** (the saved profile row).

### A) Email confirmation required (no session)

Typical when Supabase has “confirm email” enabled or Cognito requires verification. There is **no** access token yet.

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | e.g. `"Email confirmation required"`. |
| `user` | object | New auth user. |
| `session` | `null` | No session until the user confirms and signs in. |
| `userProfile` | object | Saved `userProfiles` row. |

**Client guidance:** After **`201`** with **`session`: `null`**, treat the outcome as “check your email and follow the confirmation / sign-in flow.”

#### Variance in the `user` object (Supabase)

The **`user`** payload is whatever Supabase returns for that call. It always includes at least **`id`** and **`email`**, but **other nested fields are not stable** across Supabase versions. Portable clients should depend only on documented top-level fields (**`message`**, **`session`**, **`token`**, **`userProfile`**) and on **`user.id` / `user.email`** when needed—not on the full **`user`** graph for business logic.

### B) Signed in immediately (session returned)

When confirmation is disabled (or policy returns a session on sign-up). Response shape depends on **`Accept`**:

- **JSON client** (`Accept` includes `application/json`): `message`, `user`, `token`, `userProfile`.
- **Web client**: `user`, `token`, `userProfile` (refresh token may be omitted; refresh cookie may be set).

---

## Errors

Sign-up checks run in order: **validation** → **username availability** → **email availability** → **Postgres bundle + auth user creation** (order differs by provider; see **Atomicity** below).

Any failure returns an error status with **no** account or profile created from the client’s perspective.

### 1) Request validation (`400`)

Zod validates **`action`**, **`email`**, **`password`**, and **`userProfile`** (`username` and `specialty` both required and non-empty).

Response shape:

```json
{
  "error": {
    "name": "ZodError",
    "message": "[ ... issues JSON ... ]"
  }
}
```

### 2) Username already taken (`409`)

The API checks **`userProfiles.username`** before any writes. If another profile already uses that username, sign-up fails immediately — **no auth user**, **no** `auth.users` row, **no** confirmation email.

```json
{
  "error": "This username is already taken",
  "code": "USERNAME_TAKEN"
}
```

**Client guidance:** Show the error on the sign-up form and let the user pick a different username. Same shape as **`409`** on **`POST /api/user-profile`**.

### 3) Email already registered (`409`)

Before calling the auth provider, the API checks whether the email is already registered (Cognito **`AdminGetUser`**, **`auth.users`** via Postgres, or Supabase admin fallback). If the email exists, sign-up fails immediately — **no auth user**, **no** `auth.users` stub, **no** profile, **no** confirmation email.

```json
{
  "error": "An account with this email already exists",
  "code": "EMAIL_ALREADY_REGISTERED"
}
```

**Client guidance:** Show the error on the sign-up form. Offer **sign-in** and **forgot-password** links. Do **not** navigate to the confirm-email screen for this case.

**Note:** This is an explicit rejection (not the uniform-`201` anti-enumeration pattern some auth providers use on duplicate sign-up). Forgot-password still uses a generic success response regardless of whether the email exists.

### 4) Auth provider rejects sign-up (`400` / `409`)

Supabase or Cognito can return **`400`** for other failures, for example weak password or disallowed email domain:

```json
{ "error": "<string message from provider>" }
```

Duplicate email should normally be caught by **§3** first; Cognito **`UsernameExistsException`** is also mapped to **`409 EMAIL_ALREADY_REGISTERED`** if it surfaces at the provider step (e.g. race).

On **Cognito**, Postgres rows written in the DB-first step are rolled back when the provider rejects sign-up.

### 5) Database or account-link failure (`409` / `422` / `500`)

If the Postgres bundle (`auth.users` stub on RDS + `userProfiles` insert) fails, or linking **`cognito_sub`** fails after Cognito sign-up, the API returns an error and compensates (deletes IdP user and/or Postgres rows). Examples:

| `code` | Status | Typical cause |
|--------|--------|----------------|
| `USERNAME_TAKEN` | `409` | Race: another request claimed the username after the pre-check. |
| `FOREIGN_KEY_VIOLATION` | `422` | Profile could not link to `auth.users`. |
| `AUTH_USER_SETUP_FAILED` | `500` | `cognito_sub` update failed after Cognito sign-up (compensating delete attempted). |
| *(omitted)* | `500` | Generic DB failure. |

**Client guidance:** Show the error on the sign-up form; the user can retry with a different username or contact support for persistent **`500`** errors.

---

## Atomicity

Sign-up is **logically atomic** across the identity provider and Postgres (not a single DB transaction):

| Provider | Order | On failure |
|----------|-------|------------|
| **Cognito** | Postgres TX (`auth.users` + profile) → Cognito `SignUp` → set `cognito_sub` | Roll back Postgres; **`AdminDeleteUser`** if Cognito succeeded |
| **Supabase** | Supabase `signUp` → Postgres TX (`auth.users` stub on RDS + profile) | **`admin.deleteUser`** if Postgres fails |

**`ensurePersonalOrganization`** runs only after full success; failures there are logged and do not fail sign-up.

A verification email may still be sent if the IdP created the user before a later step failed (mainly on the Supabase path). That is rare (infra/DB errors) and acceptable.

---

## Idempotency and duplicates

- **Same `email` again:** **`409`** with **`code === "EMAIL_ALREADY_REGISTERED"`** (see **§3**). No database side effects.
- **`username`** is unique globally. A taken username returns **`409`** with **`code === "USERNAME_TAKEN"`** before any writes (see **§2**).

---

## Related documentation

- **[USER_PROFILE_API.md](./USER_PROFILE_API.md)** — authenticated **`GET` / `POST` / `PATCH`** for `/api/user-profile`.
- Tests: **`tests/auth.test.js`** (`npm run test:auth`). Sign-up Zod cases are tests **1–7** (`testNumber`). **Test 8** (reserved username **`info`** → **`409 USERNAME_TAKEN`**, no auth user) requires a DB seed and is skippable via **`skipTest8`**. **Test 9** (duplicate email → **`409 EMAIL_ALREADY_REGISTERED`**) requires **`TEST_ACCOUNT_EMAIL`** in **`.env.local`**. **Test 10** is the sign-in smoke test and requires **`TEST_ACCOUNT_EMAIL`** / **`TEST_ACCOUNT_PASSWORD`**. Full responses are written to **`test-results/auth-tests.json`**.
