# User Profile API

This document describes the Fastify endpoints that read and write provider profile data stored in Supabase (`public."userProfiles"`). Use it for client integration, testing, and operations.

All paths are prefixed by the API base URL (for example `http://localhost:3001` in development). Unless noted, routes live under **`/api`**.

---

## Authentication

Every route requires a valid Supabase JWT:

```http
Authorization: Bearer <access_token>
```

The server resolves the current user from the token; **`user_id` is never taken from the request body.** If the token is missing or invalid, the response is **`401`** with `{ "error": "..." }`.

**Sign-up flows:** If email confirmation is required and sign-up returns no session, the client must complete verification and sign-in (or otherwise obtain an `access_token`) before calling these endpoints.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/user-profile` | Returns the authenticated user’s profile row. |
| `POST` | `/api/user-profile` | Creates a profile, or updates it if one already exists for this user (upsert by `user_id`). |
| `PATCH` | `/api/user-profile` | Partially updates `username` and/or `specialty`. Requires an existing row. |

---

## GET `/api/user-profile`

**Success:** `200 OK`

Returns a single object matching the database row:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` (UUID) | Primary key. |
| `user_id` | `string` (UUID) | Foreign key to `auth.users`. |
| `created_at` | `string` (ISO 8601) | Creation time. |
| `updated_at` | `string` (ISO 8601) | Last update time. |
| `username` | `string` | Display handle; **globally unique** in the database. |
| `specialty` | `string` | Medical specialty label. |

**Errors:**

| Status | When |
|--------|------|
| `401` | Missing or invalid JWT. |
| `404` | No profile row for this user. |
| `500` | Database or server error. |

---

## POST `/api/user-profile`

Creates the first profile for the user, or replaces field values on an existing row (one logical profile per `user_id`).

**Content-Type:** `application/json`

**Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `username` | `string` | Yes | Non-empty. Must be unique across all profiles. |
| `specialty` | `string` | Yes | Non-empty. |

**Success:**

| Status | When |
|--------|------|
| `201 Created` | New row inserted. |
| `200 OK` | Row already existed; `username` and `specialty` were updated. |

Response body is the saved row (same shape as GET).

**Errors:**

| Status | Body | When |
|--------|------|------|
| `400` | `{ "error": { "name": "ZodError", "message": "..." } }` | Validation failed. |
| `401` | `{ "error": "..." }` | Not authenticated. |
| `409` | `{ "error": "...", "code": "USERNAME_TAKEN" }` | Unique constraint on `username` (Postgres `23505`). |
| `422` | `{ "error": "...", "code": "AUTH_USER_NOT_FOUND" }` or `"AUTH_USER_CHECK_FAILED"` | Auth user could not be verified via admin API (rare). |
| `422` | `{ "error": "...", "code": "FOREIGN_KEY_VIOLATION" }` | FK violation (`23503`). |
| `500` | `{ "error": "..." }` | Save failed or unhandled DB error. |

---

## PATCH `/api/user-profile`

Updates only the fields sent in the body. At least one of `username` or `specialty` must be present.

**Content-Type:** `application/json`

**Body (all optional, but not both omitted):**

| Field | Type | Description |
|-------|------|-------------|
| `username` | `string` | Non-empty if provided. |
| `specialty` | `string` | Non-empty if provided. |

**Success:** `200 OK` with the updated row.

**Errors:**

| Status | When |
|--------|------|
| `400` | Validation failed (e.g. empty body `{}`, or empty strings where not allowed). |
| `401` | Not authenticated. |
| `404` | No profile exists yet for this user (use POST to create). |
| `409` | `USERNAME_TAKEN` (username conflict). |
| `422` | Same auth/FK codes as POST when applicable. |
| `500` | Server or database error. |

---

## Database and RLS

- **Table:** `public."userProfiles"` (camelCase, quoted in PostgreSQL).
- **Uniqueness:** `username` has a unique constraint across the table.
- **Ownership:** Rows are scoped by `user_id` referencing `auth.users` with `ON DELETE CASCADE`.
- **SQL in this repo:** table DDL in [`sql/tables/userProfiles.sql`](../sql/tables/userProfiles.sql), Row Level Security in [`sql/policies/userProfiles_RLS.sql`](../sql/policies/userProfiles_RLS.sql). Apply these in your Supabase project if the table or policies are not already present.

RLS allows authenticated users to `SELECT`, `INSERT`, and `UPDATE` only rows where `user_id` matches `auth.uid()`.

---

## Implementation reference (codebase)

| Area | Location |
|------|----------|
| Routes | [`src/fastify/routes/userProfile.js`](../src/fastify/routes/userProfile.js) |
| Controller | [`src/fastify/controllers/userProfileController.js`](../src/fastify/controllers/userProfileController.js) |
| Request validation (Zod) | [`src/fastify/schemas/requests.js`](../src/fastify/schemas/requests.js) (`userProfileCreateRequestSchema`, `userProfilePatchRequestSchema`) |
| API response shape (Zod) | [`src/fastify/schemas/responses.js`](../src/fastify/schemas/responses.js) (`userProfileResponseSchema`) |
| DB row shape (Zod) | [`src/fastify/schemas/userProfile.js`](../src/fastify/schemas/userProfile.js) (`userProfileDatabaseSchema`) |
| Integration tests | [`tests/user-profile.test.js`](../tests/user-profile.test.js) (`npm run test:user-profile`) |

---

## Changelog hints for frontends

- Use **`/api/user-profile`** (kebab-case), not legacy `/api/signup/provider-profile`.
- The Supabase table name used by the server is **`userProfiles`** (plural).
