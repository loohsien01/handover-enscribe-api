# Billing & Entitlements — Architecture and Open Concerns

Companion to [`STRIPE_BILLING.md`](./STRIPE_BILLING.md) (which covers Stripe setup,
env vars, webhook config, and the integration playbook).

This doc captures the **architecture** of the billing/entitlements stack and the
**known gaps / decisions to make** before the FE integrates and the feature ships
to paying users. Items are ordered by risk impact.

---

## 1. System overview

### Tables

- `public.organizations` — org-scoped subscription state. Personal orgs (one per
  user) carry `stripe_customer_id`, `stripe_subscription_id`, `plan_key`,
  `subscription_status`, `current_period_end`, `cancel_at_period_end`. Owned by
  `personal_owner_user_id`.
- `public.organization_members` — membership + role (`owner` etc.).
- `public.stripe_webhook_events` — idempotency record; one row per processed
  Stripe `event.id`.
- `public.internal_access` — user-scoped grant for internal testers / beta UI.
  Fields exposed to FE: `ui_experience_version`, derived `active`
  (`expires_at IS NULL OR expires_at > now()`). Fields **kept server-only**:
  `reason`, `created_by`, `exclude_from_cleanup`. Active internal users **bypass
  usage limits** (see §11).
- `public.plan_limits` — config: per `plan_key`, per `metric`, limit for a
  `period_type` (v1: `calendar_month`). `limit_quantity` NULL = unlimited.
  Migration: `sql/migrations/20260528120000_usage_metering.sql`.
- `public.usage_counters` — fast aggregates:
  `(organization_id, metric, period_start) → quantity`.
- `public.usage_events` — append-only audit + idempotency
  (`idempotency_key` unique).

### Code surface

| File | Role |
|------|------|
| `src/utils/billingEntitlements.js` | `loadInternalAccess`, pure `computeEntitlements`, `organizationHasProPlan`. |
| `src/fastify/controllers/entitlementsController.js` | `GET /api/me/entitlements` — lightweight UX read. |
| `src/fastify/controllers/billingController.js` | `GET /api/billing/status`, checkout-session, portal-session, schedule-cancel, unschedule-cancel. |
| `src/fastify/controllers/stripeWebhookController.js` | Stripe event dispatcher. |
| `src/utils/billingStripeSync.js` | `derivePlanKeyFromSubscription`, `syncOrganizationFromSubscription`. |
| `src/services/personalOrganization.js` | `ensurePersonalOrganization` (idempotent service-role create). |
| `src/fastify/controllers/patientEncountersController.js` | `patientEncounterCompleteBundle` — gates `notes_saved`. |
| `src/fastify/controllers/novaChatSessionsController.js` | `POST …/completions` — resolves the Nova metric (`resolveNovaUsageMetric`) and asserts that quota before enqueue. |
| `src/fastify/processors/novaChatCompletionProcessor.js` | Re-checks quota at run; records the resolved Nova metric (`nova_response` \| `pre_visit_summary` \| `pre_visit_summary_chat_turn`) on success. |
| `src/utils/billingUsage.js` | Period helpers, `assertUsageAllowed`, `recordUsageSuccess`, `loadUsageForUserContext`. |
| `sql/policies/internalAccess_RLS.sql` | SELECT-only RLS policy for `internal_access`. |

### Read flow

```
FE app boot ─► GET /api/me/entitlements
                 │
                 ├─ supabaseAdmin.from('organizations').select('plan_key, subscription_status')
                 │                                     .eq('personal_owner_user_id', uid)
                 │
                 └─ pg.query SELECT ui_experience_version, expires_at, (expires_at IS NULL OR ...) AS active
                              FROM public.internal_access WHERE user_id = uid

      computeEntitlements(org, internalAccess) -> single payload
```

### Write flow

```
FE ─► POST /billing/checkout-session ──► Stripe Checkout (hosted page)
                                              │
                              redirect to /billing/success?session_id=...
                                              │
       Stripe webhooks ─► /api/stripe/webhook ─► billingStripeSync ─► organizations table
                                              │
                              FE refetches /billing/status
```

### FE contract (canonical)

```jsonc
GET /api/me/entitlements -> 200
{
  "entitlements": {
    "user_id": "...",
    "ui_experience_version": "stable",            // "stable" | "beta" (enum)
    "has_internal_access": false,
    "internal_access_expires_at": null,
    "has_pro_plan": false,
    "plan_key": "free",                           // org plan, raw
    "subscription_status": "none",                // org sub status, raw
    "entitled": false,                            // OR of has_internal_access | has_pro_plan
    "entitlement_source": "none"                  // "internal_access" | "subscription" | "none"
  },
  "usage": {
    "period_start": "2026-05-01T00:00:00.000Z",
    "period_end": "2026-06-01T00:00:00.000Z",
    "metrics": {
      "notes_saved": { "used": 3, "limit": 10 },
      "nova_response": { "used": 12, "limit": 50 },
      "pre_visit_summary": { "used": 2, "limit": 10 },
      "pre_visit_summary_chat_turn": { "used": 5, "limit": 50 }
    }
  }
}
```

`usage` is `null` when the DB read fails (e.g. migration not applied). Pro and
internal-access users get `"limit": null` (unlimited).

**402 `USAGE_LIMIT_EXCEEDED`** (save note or Nova completion):

```jsonc
{
  "error": "Usage limit exceeded for this billing period",
  "code": "USAGE_LIMIT_EXCEEDED",
  "metric": "notes_saved",
  "used": 10,
  "limit": 10,
  "period_end": "2026-06-01T00:00:00.000Z"
}
```

`GET /api/billing/status` returns the same `entitlements` block plus an
`organization` block with billing-page-only fields (`id`, `name`, `type`,
`stripe_customer_id`, `current_period_end`, `cancel_at_period_end`). Duplicated
fields (`plan_key`, `subscription_status`) live **only** under `entitlements`.

---

## 2. Concern: no server-side paywall enforcement yet  ⚠️ **highest risk**

`/api/me/entitlements` and `/api/billing/status` describe **who should be
entitled**, but no production handler currently *gates* its work on entitlement
or usage quotas. Costly endpoints (LLM jobs, Nova chat completions,
transcription, prompt LLM processor, etc.) accept any authenticated request.

Until enforcement lands, the entitlements payload is **advisory only**: a
non-paying user who calls those endpoints directly (or whose FE bug bypasses the
paywall) gets full usage at our cost.

### Decisions (usage metering — locked for v1)

Product and engineering direction is documented in **§11**. Summary:

| Topic | Decision |
|-------|----------|
| **Free-tier SOAP quota** | Limit **`notes_saved`** per calendar month, not job creates. |
| **Generate without save** | Allowed on free (unlimited `generate-note`); clinicians are expected to save; accept some LLM cost abuse. |
| **Where to count saves** | Central gate in `patientEncounterCompleteBundle` (success only), so `POST /api/patient-encounters/complete` and `generate-and-save-note` share one path. |
| **Nova quota** | Limit **`nova_response`** per calendar month (one per successful completion job); user-facing copy: “Nova responses”. |
| **Billing subject** | Counters keyed by **`organization_id`** (personal org ≈ per user today). |
| **Unlimited** | `organizationHasProPlan(org)` **or** active `internal_access` → skip limit checks. Use **`has_pro_plan`**, not raw `plan_key`. |
| **`past_due`** | Revokes Pro (`has_pro_plan` false); usage limits apply like free. Not the same as `cancel_at_period_end` (still `active` until period end). |
| **Period** | Calendar month (UTC) for v1. |
| **Historical rows** | Do **not** derive quotas from `jobs`, encounters, or archived data — 7-day retention deletes them ([`retention_archival (Supabase_to_S3).md`](./retention_archival%20(Supabase_to_S3).md)). Counters are write-on-use. |

### Still to implement

1. **Helpers** — e.g. `assertUsageAllowed({ organizationId, userId, metric })` and
   `recordUsageEvent(...)` in a billing/usage module; reuse `organizationHasProPlan`
   + `loadInternalAccess` for bypass. Avoid open-coding `plan_key === 'pro'` in routes.
2. **Error contract** — distinguish:
   - **`USAGE_LIMIT_EXCEEDED`** (402) — free user over monthly quota; FE → upgrade.
   - **`SUBSCRIPTION_REQUIRED`** (402) — optional if some features require Pro with no free tier.
3. **Expose usage in API** — extend `GET /api/me/entitlements` (or sibling) with
   `usage.metrics.{notes_saved, nova_response}` → `{ used, limit, period_start, period_end }`.

---

## 3. Concern: Stripe price ↔ `plan_key` drift

`derivePlanKeyFromSubscription` only returns `'pro'` when the subscription's
price id **strictly equals** `process.env.STRIPE_PRICE_PRO_MONTHLY`. Any other
active price (annual plan, grandfathered SKU, second product) maps to `'free'`;
the server **logs a warning** when the subscription status is still
active-like, but operators may miss it without log shipping.

Resulting visible bug: customer pays in Stripe, `subscription_status: 'active'`,
but `plan_key: 'free'` and `has_pro_plan: false` — UI shows "not entitled".

### Mitigations

- **Implemented:** `derivePlanKeyFromSubscription` logs **`console.warn`** when a
  subscription is in an active-like status (`active`, `trialing`, `past_due`,
  `unpaid`) but the first line item’s price id is not `STRIPE_PRICE_PRO_MONTHLY`
  (or env is unset / line item has no price). `plan_key` still stays **`free`**
  so Pro is never granted without the configured Pro price.
- Treat remaining gaps as **alertable in observability** (e.g. ship logs to your
  monitoring) rather than assuming silence is OK.
- If multiple Pro SKUs are coming (annual, team), introduce an env list or a
  small `stripe_price_to_plan` table, or read product metadata
  (`price.product.metadata.plan_key`) instead of comparing ids 1:1.
- Document in `STRIPE_BILLING.md` that **every prod price must be enumerated in
  env**, and add a startup sanity check that fails fast if the env price id
  doesn't exist in Stripe.

---

## 4. Concern: webhook idempotency under concurrent delivery

Today's flow in `stripeWebhookController.postStripeWebhook`:

1. `SELECT id FROM stripe_webhook_events WHERE id = $1`
2. If not found, run handler.
3. `INSERT INTO stripe_webhook_events (id, type)`.

Two simultaneous deliveries of the same `event.id` (Stripe retry overlapping a
delayed first delivery, multi-instance API behind a load balancer, etc.) can
both pass step 1 before either reaches step 3 — handler runs **twice**.

Stripe retries are usually sequential, but this is not safe by construction.

### Recommended fix

Use the row insert as the lock: insert first with
`ON CONFLICT (id) DO NOTHING RETURNING id`. If no row returned → another worker
owns this event; respond `200 received: true, duplicate: true` and skip the
handler. Only run the handler when the insert "wins". Wrap handler + final
status update in a single transaction so a failed handler can be safely retried
(currently the row is inserted unconditionally after handler success — a handler
that crashed mid-write would leave inconsistent org state on retry).

---

## 5. Concern: silent failure of `loadInternalAccess`

If the `pg` pool connection (`SUPABASE_DB_DIRECT_URL`) is misconfigured or DB
times out, `loadInternalAccess` throws and the entitlements controller logs but
**continues with `internalAccess: null`**. A tester with a valid `internal_access`
row appears **not entitled** with no obvious API-level signal.

### Pick one stance

- **Fail closed for the entitlement read.** Return `503` (or the request fails
  with structured error) so the FE shows "couldn't load entitlements, retry"
  instead of "you must upgrade".
- **Fail open with diagnostic.** Keep current behavior, but include a
  `degraded: true` flag (or a diagnostics field) in the entitlements payload so
  ops can detect it.

We're recommending **fail closed**: a non-deterministic "you appear unentitled"
state is the worst UX outcome and the hardest to debug from support tickets.

---

## 6. Org-scoped billing vs user-scoped internal access

Subscription state lives on **`organizations`**; internal access lives on
**`auth.users`** via `internal_access.user_id`. This works cleanly for the
current "personal org per user" model.

**Future risk:** if/when shared orgs (teams, clinics) are introduced, two
ambiguities surface:

1. **Who pays?** The org as a whole. Already fine.
2. **Who gets internal beta?** A specific user, regardless of which org they're
   acting in. Already fine — but the FE must recompute entitlements when the
   user switches active org, and the **org's** subscription status must be the
   one consulted (not "any org I belong to").

Action: leave a comment in `billingEntitlements.js` and this doc to flag that
`computeEntitlements` consumes the **active personal org** today. The signature
already accepts a generic `org` argument, so a future "active org" lookup is a
controller-level change, not a helper change.

---

## 7. Operational and FE-contract notes

These are minor but worth knowing before the FE wires up the flow:

- **`POST /api/billing/portal-session`** returns `400`/`STRIPE_CUSTOMER_MISSING`
  when there's no `stripe_customer_id` yet. FE should hide / disable "Manage
  billing" until `organization.stripe_customer_id` is populated (after first
  successful checkout + webhook).
- **Post-checkout race:** `checkout.session.completed` patches customer +
  subscription ids, but `plan_key` / `subscription_status` come from the
  follow-up `customer.subscription.created/updated` events. The FE may briefly
  see `entitled: false` after redirecting to `/billing/success` before the next
  webhook lands. Solution: poll `/me/entitlements` (or `/billing/status`) for a
  short window; do not gate UI on the redirect alone.
- **Checkout role check:** `createCheckoutSession` requires `member.role ===
  'owner'`. Personal orgs always have the user as owner so this is a no-op
  today, but the rule is in place for future shared orgs — keep it.
- **`current_period_end` is a presentation field.** Don't gate access on it
  on the BE; trust `subscription_status` + `plan_key` only. Stripe's grace logic
  is encoded in `subscription_status` (`past_due`, `unpaid`, `canceled` …).
- **`past_due` vs scheduled cancel.** `past_due` = payment failed; **`has_pro_plan`
  is false** even if `plan_key` is still `'pro'` in the row. Scheduled cancel keeps
  `subscription_status: 'active'` with `cancel_at_period_end: true` until
  `current_period_end` — Pro stays on until then. Usage limits follow **`has_pro_plan`**.

---

## 8. Security posture (checklist)

- [x] `internal_access` has RLS enabled with **only** a SELECT policy for
      `authenticated` (`user_id = auth.uid()`).
- [x] No `INSERT` / `UPDATE` / `DELETE` policy for `authenticated` on
      `internal_access` — writes go through service role + admin tooling.
- [x] FE never receives `reason`, `created_by`, or `exclude_from_cleanup`.
- [x] Stripe webhook signature verified (`stripe.webhooks.constructEvent`)
      with raw body buffer.
- [x] All Stripe org mutations done with `supabaseAdmin` (service role) —
      no RLS write policies for `authenticated` on `organizations` exposing
      Stripe fields.
- [x] Server-side usage metering (`notes_saved`, `nova_response`). **(see §11–§12)**
- [ ] Webhook idempotent under concurrent delivery. **(open — see §4)**
- [x] Usage tables RLS: authenticated read own org counters; writes service-role only.**

Verify RLS state on `internal_access` with:

```sql
select policyname, cmd, roles
  from pg_policies
 where schemaname = 'public'
   and tablename  = 'internal_access';
-- expect exactly one row: cmd = SELECT, roles = {authenticated}
```

---

## 9. Suggested rollout order

1. **Usage metering (v1)** — migrations + helpers + gate `patientEncounterCompleteBundle`
   + Nova completion success path. Seed `plan_limits`. Extend entitlements payload
   with usage snapshot. **(see §12 TODO)**
2. Fix webhook idempotency (insert-first-with-conflict).
3. Decide failure stance for `loadInternalAccess` and ship.
4. Validate price-id mapping (env list or product metadata).
5. FE integration: read `/me/entitlements` on app boot, on auth change, and
   on a short post-checkout interval; show monthly usage + upgrade on
   `USAGE_LIMIT_EXCEEDED`. Render `ui_experience_version` from the payload —
   never persist client-side.
6. Update `STRIPE_BILLING.md` to reference entitlements, usage metrics, and 402 codes.

---

## 10. Glossary

- **`entitled`** — does the caller currently have access to paid features?
  `has_internal_access || has_pro_plan`. Computed server-side; never trust a
  client claim.
- **`entitlement_source`** — debugging / analytics aid: `internal_access` >
  `subscription` > `none`. Internal access wins so testers don't need a Stripe
  sub.
- **`ui_experience_version`** — UX flag, currently `stable` | `beta`. Resolves
  to row value only when `internal_access` is **active**; otherwise defaults to
  `stable` regardless of what the row says.
- **`has_pro_plan`** — true iff `org.plan_key === 'pro'` AND
  `subscription_status ∈ {active, trialing}`. Excludes `past_due`, `unpaid`,
  `canceled`, etc. Usage limits and unlimited quotas must follow this flag, not
  `plan_key` alone. (See §3 about price-id drift.)
- **`notes_saved`** — usage metric: one increment per successful
  `patientEncounterCompleteBundle` (persisted encounter + note). Draft
  `generate-note` runs do not increment.
- **`nova_response`** — usage metric: one increment per Nova completion job that
  reaches `complete` (successful assistant turn) **for a chat with no pre-visit
  summary**. FE copy: “Nova responses this month”.
- **`pre_visit_summary`** — usage metric: one increment per pre-visit summary
  generation (turn 1 via `POST …/completions-and-save-pre-visit-summary`,
  `savePreVisitSummary: true`). Kept separate so pre-visit prep does not consume
  the general Nova chat quota.
- **`pre_visit_summary_chat_turn`** — usage metric: one increment per follow-up
  Nova turn (`POST …/completions`) in a chat that already has a
  `pre_visit_summaries` row. Detected via `chatHasPreVisitSummaryRow`.
  The metric a Nova completion counts against is resolved once by
  `resolveNovaUsageMetric` and used for both the pre-check (402) and the
  success increment.
- **`internal_access` (metering)** — active row bypasses `plan_limits`; intended for
  staff / beta testers without Stripe. Still entitled via `has_internal_access`.

---

## 11. Usage metering architecture (v1 — implemented)

### Why counters exist

Encounter bundle archive (~7 days inactivity) deletes live `jobs`, encounters,
recordings, and transcripts. **`chat_token_usage` is useful for analytics but must
not be the sole enforcement store** for Nova if retention is added later. Meter at
request time into `usage_counters` / `usage_events`.

### Tables (planned)

**`plan_limits`**

| Column | Purpose |
|--------|---------|
| `plan_key` | `free` \| `pro` |
| `metric` | `notes_saved` \| `nova_response` \| `pre_visit_summary` \| `pre_visit_summary_chat_turn` |
| `limit_quantity` | `bigint`; **NULL = unlimited** |
| `period_type` | v1: `calendar_month` |

Starter seed (adjust via SQL anytime):

| plan_key | metric | limit_quantity |
|----------|--------|----------------|
| free | notes_saved | 10 |
| free | nova_response | 50 |
| free | pre_visit_summary | 10 |
| free | pre_visit_summary_chat_turn | 50 |
| pro | notes_saved | NULL |
| pro | nova_response | NULL |
| pro | pre_visit_summary | NULL |
| pro | pre_visit_summary_chat_turn | NULL |

Pre-visit summary metrics were added in
`sql/migrations/20260707120000_pre_visit_summary_usage_metrics.sql` to decouple
pre-visit work from the shared `nova_response` quota.

**`usage_counters`** — `organization_id`, `metric`, `period_start`, `period_end`,
`quantity`, `updated_at`. Unique on `(organization_id, metric, period_start)`.

**`usage_events`** — `organization_id`, `user_id`, `metric`, `quantity`,
`idempotency_key` (unique), `metadata` (jsonb), `created_at`. Optional
`source_job_id` / `note_id` in metadata for support.

### Enforcement flow

```
                    ┌─────────────────────────────┐
                    │ organizationHasProPlan?     │
                    │ OR active internal_access?  │
                    └─────────────┬───────────────┘
                          yes     │     no
                           ▼      │      ▼
                      allow       │  read counter vs plan_limits
                                  │      │
                                  │      ▼ over limit → 402 USAGE_LIMIT_EXCEEDED
                                  │      │
                                  ▼      ▼
                           perform work (RPC / Bedrock)
                                  │
                                  ▼ success only
                           INSERT usage_events (idempotent)
                           UPSERT usage_counters.quantity += 1
```

### Gate points (code)

| Metric | When to check | When to increment |
|--------|---------------|-------------------|
| `notes_saved` | Start of `patientEncounterCompleteBundle` | After successful `create_patient_encounter_complete` RPC |
| `nova_response` / `pre_visit_summary` / `pre_visit_summary_chat_turn` | Before enqueue in `postNovaChatCompletion` (metric via `resolveNovaUsageMetric`) + re-check in processor | When `nova_chat_completion_jobs.status` → `complete` (same resolved metric) |

**Save paths sharing the bundle gate:**

- `POST /api/patient-encounters/complete`
- `promptLlmProcessor` when `generate-and-save-note` calls
  `patientEncounterCompleteBundle` — keep route; do not deprecate.

**Not metered in v1:** `POST /api/jobs/prompt-llm/generate-note` (no increment on job create).

### Period boundaries

v1: **calendar month, UTC** — `period_start` = first instant of month UTC;
`period_end` = first instant of next month. Stripe `current_period_end` alignment
deferred.

### Nova vs org / user

Nova rows store both `user_id` and `organization_id`. **Limits are org-scoped**
(personal org owner = same user). Keep `user_id` on `usage_events` for audit and
future team seats.

### Idempotency (follow-up)

- Prefer `idempotency_key` = `job_id` when save is job-driven; `note_id` after first success for direct `/complete`.
- Duplicate save retries (same job, encounter already created) are a **separate**
  product concern from metering; not blocking v1 counters.

---

## 12. Implementation TODO

Checklist for shipping usage limits. Order is a suggestion; adjust in PRs.

### Database

- [x] Migration: `plan_limits`, `usage_counters`, `usage_events` — `sql/migrations/20260528120000_usage_metering.sql`.
- [x] Seed starter `plan_limits` rows (§11 table).
- [x] RLS: authenticated users can **SELECT** counters/events for their personal org; **no** authenticated INSERT/UPDATE on metering tables (service role / API only).
- [x] Indexes: `(organization_id, metric, period_start)` on counters; unique `idempotency_key` on events.

### Server utilities

- [x] `src/utils/billingUsage.js`: `getCalendarMonthPeriod()`, `getPlanLimit`, `getUsageQuantity`, `assertUsageAllowed`, `recordUsageSuccess`, `loadUsageForUserContext`.
- [x] Wire bypass: `organizationHasProPlan` + `loadInternalAccess` (active → skip limits).
- [x] Unit tests: `tests/billingUsage.unit.test.js` (allowance + period + `past_due` plan key).

### Gate: saved notes

- [x] In `patientEncounterCompleteBundle`: assert before RPC; record after RPC success (`sourceJobId` for generate-and-save idempotency).
- [x] Map errors to **402** + `USAGE_LIMIT_EXCEEDED` on `POST /patient-encounters/complete`.
- [x] E2E: `tests/billing-usage-limits.e2e.test.js` (`npm run test:billing-usage-limits`).

### Gate: Nova

- [x] `POST …/completions` asserts quota; processor re-checks and records `nova_response` on `complete`.
- [x] E2E: same suite as above (Nova + notes 402).

### API / FE contract

- [x] Extend `GET /api/me/entitlements` and `GET /api/billing/status` with monthly `usage` block.
- [x] Document 402 bodies in this doc (FE contract above).
- [ ] FE: show “X / Y notes saved” and “Nova responses”; upgrade CTA on `USAGE_LIMIT_EXCEEDED`.

### Existing concerns (unchanged priority)

- [ ] Webhook insert-first idempotency (§4).
- [ ] `loadInternalAccess` fail-closed on entitlements read (§5).
- [ ] Optional: `assertUserEntitled` for features that are Pro-only with **no** free tier (distinct from quota).

### Ops / hygiene

- [ ] Audit `organizations` rows for test Stripe IDs on non-test accounts (shared DB).
- [ ] Log / alert on `plan_key: 'pro'` + active-like status but `has_pro_plan: false` (price drift, `past_due`).
