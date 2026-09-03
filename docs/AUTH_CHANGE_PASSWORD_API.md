# Auth API: `POST /api/auth/change-password`

Signed-in password change for **Settings → Security**. Uses Cognito `ChangePassword` (current password + new password + access token). **Forgot-password** remains the recovery path for people who cannot sign in.

This is **not** a sign-out. Cognito does not invalidate the current access or refresh tokens after a successful in-session change. The API does not `GlobalSignOut`, revoke refresh rows, or clear the refresh cookie.

All paths are under your API base (for example **`/api`** in development).

---

## Request

**`POST /api/auth/change-password`**

**Headers**

| Header | Notes |
|--------|--------|
| `Content-Type` | `application/json` |
| `Authorization` | **`Bearer <access_token>`** from sign-in. Required. |

No Turnstile token. This route is authenticated; bot protection is the JWT, not a public form.

**Body (JSON)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `currentPassword` | string | Yes | The user’s existing password. |
| `newPassword` | string | Yes | At least 8 characters. Must differ from `currentPassword`. Cognito pool policy may still reject it (upper / lower / digit / symbol). |

Example:

```json
{
  "currentPassword": "current-password",
  "newPassword": "a-new-stronger-password"
}
```

---

## Success (`200`)

```json
{ "message": "Password changed successfully" }
```

**Client guidance**

- Keep the existing session. Do **not** redirect to sign-in, clear tokens, or drop the refresh cookie.
- Continue using the same `access_token` (and refresh flow) until it expires normally.
- Do **not** send the user to `/forgot-password` after success.

---

## Errors

| Status | When | Body |
|--------|--------|------|
| `400` | Zod validation (missing fields, `newPassword` &lt; 8 chars, same as current) | Serialized `ZodError` |
| `400` | New password fails Cognito policy or password history | `{ "error": "<string>" }` |
| `401` | Missing/invalid/expired access token | `{ "error": "Not authenticated" }` |
| `401` | Current password is wrong | `{ "error": "Current password is incorrect" }` |
| `429` | Cognito rate limit | `{ "error": "Too many attempts. Please try again later." }` |
| `500` | Unexpected IdP / IAM failure | `{ "error": "Unable to change password" }` |

**Client guidance**

- `401` + `"Not authenticated"` → existing session handling (refresh or sign-in).
- `401` + `"Current password is incorrect"` → show on the current-password field; stay signed in.
- `400` Zod → field errors on the form.
- Recovery for users who **cannot** sign in is still **`POST /api/auth`** with **`action: "forgot-password"`**, not this endpoint.

---

## Related documentation

- **[AUTH_SIGN_UP_API.md](./AUTH_SIGN_UP_API.md)** — sign-up / confirm-sign-up.
- **[AUTH_BOT_PROTECTION.md](./AUTH_BOT_PROTECTION.md)** — Turnstile on public auth forms only (not this route).
- Tests: **`tests/auth.test.js`** (`npm run test:auth`) tests **40–46**; unit mapping in **`tests/cognitoChangePassword.unit.test.js`**.
