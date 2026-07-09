# Auth API: `action: sign-up`

This document describes **`POST /api/auth`** when the body includes **`"action": "sign-up"`**. One request performs **two logical steps**: (1) create the Supabase auth user, and (2) optionally create or update the row in **`public."userProfiles"`** using the service role.

General auth behaviors (cookies, refresh, other actions) are not fully covered here; this file focuses on sign-up and the extra outcomes when **`userProfile`** is present.

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
| `userProfile` | object | No | If present, same shape as **`POST /api/user-profile`**: `username` and `specialty`, both non-empty strings. Creates or updates the profile for the new user **server-side** (no JWT required). |

Example with optional profile:

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

Auth user creation is considered successful if the handler returns **`201`**. The body always includes **`user`** (at least `id`, `email`).

### A) Email confirmation required (no session)

Typical when Supabase has “confirm email” enabled. There is **no** access token yet.

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | e.g. `"Email confirmation required"`. |
| `user` | object | New auth user. |
| `session` | `null` | No session until the user confirms and signs in. |
| `userProfile` | object | Present only if the client sent **`userProfile`** and the **database write succeeded**. Same shape as a `userProfiles` row. |
| `profileError` | object | Present only if the client sent **`userProfile`** and the **profile write failed** (see below). Mutually exclusive with **`userProfile`** on success. |

#### Uniform 201 when confirmation is required (anti-enumeration)

With **“confirm email”** enabled, manual tests show the same high-level outcome for several different situations:

- **New address** — first sign-up; confirmation mail is sent.
- **Existing address, not yet verified** — another sign-up attempt for the same email.
- **Existing address, already verified** — another sign-up attempt (password is not applied to the existing account via this flow).

In these cases the API still returns **`201`**, **`session`: `null`**, and a generic message such as **`"Email confirmation required"`**. The response **does not** state which of the three cases occurred. That avoids leaking whether an email is registered and reduces signals useful for abuse (e.g. probing or triggering mail floods with clear “new vs existing” feedback).

**Client guidance:** After **`201`** with **`session`: `null`**, treat the outcome as “if this email can receive mail, follow the confirmation / sign-in flow.” Do **not** infer account state from HTTP status or from optional fields on **`user`** (see below).

#### Variance in the `user` object (Supabase)

The **`user`** payload is whatever Supabase returns for that call. It always includes at least **`id`** and **`email`**, but **other fields are not stable signals** for “brand new vs existing”:

- One successful sign-up may include rich **`identities`**, **`user_metadata`**, **`role`: `"authenticated"`**, **`confirmation_sent_at`**, etc.
- Another **`201`** for a different lifecycle may show **empty **`identities`****, **empty **`user_metadata`****, **`role`** as an empty string, etc.

Keys and nesting can also change with **Supabase version**. Portable clients should depend only on documented top-level fields (**`message`**, **`session`**, **`token`**, **`userProfile`**, **`profileError`**) and on **`user.id` / `user.email`** when needed—not on the full **`user`** graph for business logic.

### B) Signed in immediately (session returned)

When confirmation is disabled (or policy returns a session on sign-up). Response shape depends on **`Accept`**:

- **JSON client** (`Accept` includes `application/json`): `message`, `user`, `token` (Supabase session; includes `access_token`; may include `refresh_token` per product rules).
- **Web client**: `user`, `token` (refresh token may be omitted; refresh cookie may be set).

Optional fields when **`userProfile`** was sent:

| Field | Type | Description |
|-------|------|-------------|
| `userProfile` | object | Profile row after successful upsert. |
| `profileError` | object | If profile upsert failed; auth still succeeded. |

---

## Errors and partial success

Sign-up checks run in order: **validation** → **username availability** (when **`userProfile`** is sent) → **auth user creation** → **profile upsert**.

### 1) Request validation (`400`)

Zod validates **`action`**, **`email`**, **`password`**, and optional **`userProfile`** (if the object is present, **`username`** and **`specialty`** are both required and non-empty).

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

When **`userProfile`** is sent, the API checks **`userProfiles.username`** **before** creating an auth user (Cognito or Supabase). If another profile already uses that username, sign-up fails immediately — **no auth user is created** and no confirmation email is sent.

```json
{
  "error": "This username is already taken",
  "code": "USERNAME_TAKEN"
}
```

**Client guidance:** Show the error on the sign-up form and let the user pick a different username. Same shape as **`409`** on **`POST /api/user-profile`**.

### 3) Auth provider rejects sign-up (`400`)

Supabase or Cognito can still return **`400`** for some failures, for example weak password, disallowed email domain, or a provider-specific “user already exists” rule **if** that rule is enabled in your project. Body:

```json
{ "error": "<string message from provider>" }
```

No **`userProfile`** / **`profileError`** in this case when no usable auth user was created for the profile step.

**Note:** With **email confirmation** required, many deployments **do not** return **`400`** for “duplicate email” on sign-up; see **Uniform 201 when confirmation is required (anti-enumeration)** above—the same **`201`** + **`session`: `null`** pattern may apply instead.

### 4) Profile write failed after user was created (`201` + `profileError`)

Rare: auth user was created, but the profile upsert still failed (e.g. race between two sign-ups claiming the same username, FK violation, or generic DB error). The API returns **`201`** with **`user`** (and **`token` / `session`** as in A or B above), and adds:

```json
"profileError": {
  "error": "<human-readable message>",
  "code": "<optional code>"
}
```

Possible **`code`** values (aligned with **`POST /api/user-profile`** semantics):

| `code` | Typical cause |
|--------|----------------|
| `USERNAME_TAKEN` | Rare race: another request claimed the username after the pre-check. |
| `FOREIGN_KEY_VIOLATION` | Rare; `user_id` could not be linked (e.g. user missing in auth). |
| *(omitted)* | Generic DB failure; **`error`** string still set. |

**Client guidance:** Treat **`201`** as “account exists.” If **`profileError`** is present, prompt the user to fix username (or retry profile later via **`POST /api/user-profile`** after sign-in).

---

## Idempotency and duplicates

- **Same **`email`** again:** Behavior depends on Supabase and project settings. With **confirm email** enabled, repeated sign-up attempts often still return **`201`** with **`session`: `null`** and the same generic **`message`** as a first-time sign-up (see **Uniform `201`** above)—the API does not expose whether the row was newly created or already existed. That is intentional for privacy and abuse resistance, not a client bug.
- **`username`** is unique **globally** across profiles. When **`userProfile`** is sent, a taken username returns **`409`** with **`code === "USERNAME_TAKEN"`** before any auth user is created (see **§2** above).

---

## Related documentation

- **[USER_PROFILE_API.md](./USER_PROFILE_API.md)** — authenticated **`GET` / `POST` / `PATCH`** for `/api/user-profile`.
- Tests: **`tests/auth.test.js`** (`npm run test:auth`). Sign-up Zod cases are tests **1–6** (`testNumber`). **Test 7** (reserved username **`info`** → **`409 USERNAME_TAKEN`**, no auth user) requires a DB seed and is skippable via **`skipTest7`**. **Test 8** is the sign-in smoke test and requires **`TEST_ACCOUNT_EMAIL`** / **`TEST_ACCOUNT_PASSWORD`** in **`.env.local`** (otherwise recorded as skipped). Full responses are written to **`test-results/auth-tests.json`**.
