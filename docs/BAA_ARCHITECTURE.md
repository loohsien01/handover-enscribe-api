# Business Associate Addendum (BAA) — Architecture

Versioned BAA text stored in Supabase, org-level electronic acceptance via the Fastify API.

**Canonical legal copy (source for v1 seed):**  
`enscribe-web/src/content/legal/business-associate-addendum.md`

**FE constants (to migrate off bundled markdown):**  
`enscribe-web/src/constants/baaAgreement.js`

---

## Status

| Phase | Scope | Status |
|-------|--------|--------|
| **1 — Database** | `baa_versions`, `baa_acceptances`, RLS, migration, v1 seed | ✅ Done |
| **2 — API** | `GET /api/baa/active`, `GET /api/me/baa/status`, `POST /api/me/baa/accept` | ✅ Done |
| **3 — FE** | Fetch BAA from API; acceptance modal / settings | 🔲 Not started |
| **4 — Enforcement** | Block HIPAA features until accepted; re-prompt on new version | 🔲 Not started |
| **5 — Plan gate** | Require HIPAA-eligible subscription in addition to BAA | 🔲 Not started |

**Backend deliverables (complete):**

- Migration: `sql/migrations/20260620_baa_versions_and_acceptances.sql`
- Seed script: `npm run seed:baa-v1`
- API routes registered in `src/fastify/routes/baa.js`
- Tests: `npm run test:baa`

---

## Frontend integration guide

This section is the **FE contract**. All three routes live under the API base URL (e.g. `http://localhost:3001` locally, `https://api.enscribe.online` in production), same as billing and entitlements.

### Authentication

Every endpoint requires a Supabase **Bearer JWT**:

```http
Authorization: Bearer <access_token>
Accept: application/json
```

**401** if the token is missing or invalid.

BAA acceptance is scoped to the user's **personal organization** (same model as billing). The API creates the personal org on first use if it does not exist yet.

### Recommended UX flow

```
App boot or before HIPAA feature
        │
        ▼
GET /api/me/baa/status
        │
        ├─ needs_acceptance === false  → proceed
        │
        └─ needs_acceptance === true
                │
                ├─ can_accept === false  → show "contact org owner" (future clinic orgs)
                │
                └─ can_accept === true
                        │
                        ▼
                GET /api/baa/active  → render content_markdown (NovaMarkdown, excerpts={false})
                        │
                        ▼
                User checks box + clicks Accept
                        │
                        ▼
                POST /api/me/baa/accept  { "version_number": "<from active>" }
                        │
                        ├─ 200 / 201  → re-fetch status, proceed
                        │
                        └─ 409 BAA_VERSION_MISMATCH  → re-fetch active + status, show updated doc
```

**Strict re-sign:** when Enscribe publishes a new active version (e.g. `1.1.0`), users who signed `1.0.0` get `needs_acceptance: true` until they accept the new version. There is no grandfathering.

**Separate from entitlements:** do not fold BAA into `/api/me/entitlements` for now. Call `/api/me/baa/status` when entering HIPAA flows or on settings load.

---

### 1. `GET /api/baa/active`

Fetch the **currently active** BAA document for display.

**When to call:** acceptance modal, account settings “view BAA”, after a `409 BAA_VERSION_MISMATCH`.

**Response 200:**

```json
{
  "version_number": "1.0.0",
  "title": "Business Associate Addendum",
  "content_markdown": "# Business Associate Addendum\n\n...",
  "effective_date": "2026-06-21T00:43:30.989+00:00"
}
```

| Field | Type | FE usage |
|-------|------|----------|
| `version_number` | `string` | Pass to `POST /accept`; show in UI (“Version 1.0.0”) |
| `title` | `string` | Modal / page heading |
| `content_markdown` | `string` | Render with `NovaMarkdown` (`excerpts={false}`) — replaces bundled import from `baaAgreement.js` |
| `effective_date` | ISO 8601 string | Optional display |

**Errors:**

| Status | `code` | Meaning |
|--------|--------|---------|
| 401 | — | Not authenticated |
| 404 | `BAA_ACTIVE_VERSION_MISSING` | No active version in DB (ops: run migration + seed) |
| 500 | — | Server error |

---

### 2. `GET /api/me/baa/status`

Lightweight gate check for the signed-in user's personal org.

**When to call:** app boot (if HIPAA UI), before HIPAA features, after accept to confirm state.

**Response 200:**

```json
{
  "organization_id": "38e8282c-5a75-414c-a64d-5c066529ce3b",
  "active_version": "1.0.0",
  "acceptance": {
    "id": "44e50767-df5c-4993-852d-6356a6104518",
    "version_number": "1.0.0",
    "accepted_at": "2026-06-22T01:01:53.205614+00:00",
    "accepted_by_user_id": "38bd7bad-8dcb-4e8d-a86c-a33406725236"
  },
  "needs_acceptance": false,
  "can_accept": true
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `organization_id` | `string \| uuid` | Personal org the BAA binds to |
| `active_version` | `string \| null` | Current published version; `null` if none active |
| `acceptance` | `object \| null` | Org's acceptance of the **active** version only; `null` if not yet signed |
| `needs_acceptance` | `boolean` | **`true` → show acceptance UI.** Strict: active version exists and org has not accepted it |
| `can_accept` | `boolean` | **`true` → enable Accept button.** `false` for non-owners (clinic orgs later) |

**Example states:**

| Scenario | `acceptance` | `needs_acceptance` | `can_accept` |
|----------|--------------|--------------------|--------------|
| Never signed, owner | `null` | `true` | `true` |
| Signed active version | `{ version_number: "1.0.0", ... }` | `false` | `true` |
| New version published, signed old only | `null` | `true` | `true` |
| Non-owner, unsigned | `null` | `true` | `false` |

**Errors:**

| Status | `code` | Meaning |
|--------|--------|---------|
| 401 | — | Not authenticated |
| 404 | `PERSONAL_ORG_MISSING` | No personal org (user should complete profile / sign-up flow) |
| 403 | — | Not an org member |
| 500 | — | Server error |

---

### 3. `POST /api/me/baa/accept`

Record electronic acceptance for the **active** BAA version.

**When to call:** user clicks Accept on the checkbox modal.

**Who can call:** org **owner** only (personal org owner = the clinician today).

**Request body (optional but recommended):**

```json
{
  "version_number": "1.0.0"
}
```

Send the `version_number` from `GET /api/baa/active` so the server can detect if the active version changed while the user was reading (stale modal).

Empty body `{}` is also valid.

**Response 201** (first accept):

```json
{
  "acceptance": {
    "id": "44e50767-df5c-4993-852d-6356a6104518",
    "version_number": "1.0.0",
    "accepted_at": "2026-06-22T01:01:53.205614+00:00",
    "organization_id": "38e8282c-5a75-414c-a64d-5c066529ce3b",
    "accepted_by_user_id": "38bd7bad-8dcb-4e8d-a86c-a33406725236"
  }
}
```

**Response 200** (idempotent — org already accepted this active version):

Same `acceptance` shape. Safe to retry on double-click or network retry.

**Errors:**

| Status | `code` | Meaning | FE action |
|--------|--------|---------|-----------|
| 401 | — | Not authenticated | Redirect to login |
| 403 | — | Not org owner | Disable accept; show owner-only message |
| 404 | `BAA_ACTIVE_VERSION_MISSING` | No active BAA | Show error / contact support |
| 409 | `BAA_VERSION_MISMATCH` | Body `version_number` ≠ current active | Re-fetch `GET /baa/active` + `GET /me/baa/status`; re-show modal with new text. Response includes `active_version`. |
| 400 | — | Invalid body (bad `version_number` shape) | Fix client payload |
| 500 | — | Server error | Retry / error toast |

**409 example:**

```json
{
  "error": "Active BAA version changed",
  "code": "BAA_VERSION_MISMATCH",
  "active_version": "1.1.0"
}
```

---

### FE migration from `baaAgreement.js`

| Today (bundled) | After API integration |
|-----------------|----------------------|
| `BAA_AGREEMENT.contentMarkdown` | `GET /api/baa/active` → `content_markdown` |
| `BAA_AGREEMENT.version` / `acceptanceVersion` | `GET /api/baa/active` → `version_number` |
| `BAA_AGREEMENT.title` | `GET /api/baa/active` → `title` |
| `BAA_AGREEMENT.acceptanceCheckboxLabel` | Keep in FE constants until moved server-side |
| No persistence | `GET /api/me/baa/status` + `POST /api/me/baa/accept` |

**Suggested helper (enscribe-web):**

```js
// Example — adapt to your existing api client
export async function fetchBaaStatus(accessToken) {
  const res = await fetch(`${API_BASE}/api/me/baa/status`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  if (!res.ok) throw await res.json();
  return res.json();
}

export async function acceptBaa(accessToken, versionNumber) {
  const res = await fetch(`${API_BASE}/api/me/baa/accept`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ version_number: versionNumber }),
  });
  if (!res.ok) throw await res.json();
  return res.json();
}
```

---

## Database

### `baa_versions`

Immutable published versions of the document.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `version_number` | `text` UNIQUE | Semver, e.g. `'1.0.0'` |
| `title` | `text` | e.g. `'Business Associate Addendum'` |
| `content_markdown` | `text` NOT NULL | Source of truth; FE renders as markdown |
| `effective_date` | `timestamptz` NOT NULL | When this version may be offered / signed |
| `is_active` | `boolean` NOT NULL DEFAULT false | Only one active at a time |
| `created_at` | `timestamptz` NOT NULL DEFAULT `now()` | Publish time |

- **Do not UPDATE** `content_markdown` after publish — insert a new version row instead.
- Old versions remain readable for orgs that signed them.

### `baa_acceptances`

Append-only acceptance log.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `organization_id` | `uuid` FK → `organizations` | BAA “Customer” (personal org for solo users) |
| `baa_version_id` | `uuid` FK → `baa_versions` | Exact version accepted |
| `accepted_by_user_id` | `uuid` FK → `auth.users` | User who clicked accept |
| `accepted_at` | `timestamptz` NOT NULL DEFAULT `now()` | Effective Date per BAA text |

Unique: `(organization_id, baa_version_id)`.

### RLS

- **`baa_versions`:** authenticated `SELECT` all rows.
- **`baa_acceptances`:** authenticated `SELECT` for orgs the user belongs to.
- **Writes:** service role via API only (no authenticated insert/update/delete policies).

---

## Ops — migration and seed

**Migration** (requires `organizations` from billing migration):

```bash
cd enscribe-api
npm run migrate:apply-psql -- sql/migrations/20260620_baa_versions_and_acceptances.sql
```

**Seed v1.0.0** from enscribe-web markdown:

```bash
npm run seed:baa-v1
```

Reads `../enscribe-web/src/content/legal/business-associate-addendum.md` by default. Idempotent if `1.0.0` already exists.

Custom path: `node sql/scripts/seed-baa-v1.js /path/to/business-associate-addendum.md`

---

## Backend code reference

| File | Role |
|------|------|
| `src/utils/baaStatus.js` | Load active version / acceptance; `computeBaaStatus` |
| `src/fastify/controllers/baaController.js` | Handlers |
| `src/fastify/routes/baa.js` | Route registration |
| `src/services/personalOrganization.js` | Ensures personal org exists |
| `sql/scripts/seed-baa-v1.js` | Seeds v1 from markdown file |

**Tests:**

```bash
npm run test:baa
```

Uses `TEST_BILLING_ACCOUNT_EMAIL` / `TEST_BILLING_ACCOUNT_PASSWORD` (same as `test:billing-org`).

---

## Future work

| Phase | Work |
|-------|------|
| **3 — FE** | Wire the three endpoints; replace bundled markdown in `baaAgreement.js` |
| **4 — Enforcement** | Server-side guard on HIPAA routes when `needs_acceptance === true` |
| **5 — Plan gate** | Also require HIPAA-eligible `plan_key` before treating BAA as effective |

**Publishing v1.1.0 (ops, no admin API yet):** insert new `baa_versions` row, set `is_active = true` on the new row and `false` on the old one. All orgs get `needs_acceptance: true` until they call `POST /accept` again.

### Deferred schema (not implemented)

| Column | Purpose |
|--------|---------|
| `ip_address` / `user_agent` on acceptances | Forensic audit; add if compliance requires |
| `signer_name` / `signer_title` | Typed legal name on accept form |
| `content_sha256` | Tamper evidence at sign time |

---

## Related docs

| Doc | Relevance |
|-----|-----------|
| `docs/BILLING_ARCHITECTURE.md` | Org-scoped billing; BAA attaches to same personal org |
| `docs/STRIPE_BILLING.md` | Personal org creation on profile sign-up |
