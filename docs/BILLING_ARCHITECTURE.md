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
  `reason`, `created_by`, `exclude_from_cleanup`.

### Code surface

| File | Role |
|------|------|
| `src/utils/billingEntitlements.js` | `loadInternalAccess`, pure `computeEntitlements`, `organizationHasProPlan`. |
| `src/fastify/controllers/entitlementsController.js` | `GET /api/me/entitlements` — lightweight UX read. |
| `src/fastify/controllers/billingController.js` | `GET /api/billing/status`, checkout-session, portal-session. |
| `src/fastify/controllers/stripeWebhookController.js` | Stripe event dispatcher. |
| `src/utils/billingStripeSync.js` | `derivePlanKeyFromSubscription`, `syncOrganizationFromSubscription`. |
| `src/services/personalOrganization.js` | `ensurePersonalOrganization` (idempotent service-role create). |
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
  }
}
```

`GET /api/billing/status` returns the same `entitlements` block plus an
`organization` block with billing-page-only fields (`id`, `name`, `type`,
`stripe_customer_id`, `current_period_end`, `cancel_at_period_end`). Duplicated
fields (`plan_key`, `subscription_status`) live **only** under `entitlements`.

---

## 2. Concern: no server-side paywall enforcement yet  ⚠️ **highest risk**

`/api/me/entitlements` and `/api/billing/status` describe **who should be
entitled**, but no production handler currently *gates* its work on entitlement.
Costly endpoints (LLM jobs, Nova chat completions, transcription, prompt LLM
processor, etc.) accept any authenticated request.

Until enforcement lands, the entitlements payload is **advisory only**: a
non-paying user who calls those endpoints directly (or whose FE bug bypasses the
paywall) gets full usage at our cost.

### Decisions to make before launch

1. **Where to gate.** Candidate first targets: prompt-LLM job creation, Nova
   completions, transcription kickoff. Free-tier limits (count / day) vs hard
   block for non-Pro?
2. **One helper, one source of truth.** Add e.g.
   `assertUserEntitled(userId, { feature })` in `billingEntitlements.js` that
   returns `{ entitled, source, reason }`, used by every gated handler. Avoid
   open-coding `plan_key === 'pro'` in route handlers.
3. **Internal access scope.** Does `internal_access` grant Pro features only,
   or also bypass any future metering/quotas? Document explicitly — easier now
   than after the metering table exists.
4. **Error contract.** Define the FE-visible 4xx (likely **402 Payment
   Required** with `code: 'SUBSCRIPTION_REQUIRED'` and `entitlement_source`
   echoed back) so the client can route to the upgrade flow consistently.

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
- [ ] Server-side paywall enforcement on costly endpoints. **(open — see §2)**
- [ ] Webhook idempotent under concurrent delivery. **(open — see §4)**

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

1. Land server-side `assertUserEntitled` helper + apply to one gated endpoint
   end-to-end (likely prompt-LLM job creation). Get the 402 contract right
   before duplicating it across handlers.
2. Fix webhook idempotency (insert-first-with-conflict).
3. Decide failure stance for `loadInternalAccess` and ship.
4. Validate price-id mapping (env list or product metadata).
5. FE integration: read `/me/entitlements` on app boot, on auth change, and
   on a short post-checkout interval. Render `ui_experience_version` from the
   payload — never persist client-side.
6. Update `STRIPE_BILLING.md` to reference the new entitlements endpoint and
   the 402 contract.

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
  `subscription_status ∈ {active, trialing}`. (See §3 about price-id drift.)
