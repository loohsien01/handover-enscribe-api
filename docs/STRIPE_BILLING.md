# Stripe billing and organizations

Backend routes live under the Fastify `/api` prefix (see [server.js](../src/fastify/server.js)).

## Database

1. Ensure `update_updated_at_column()` exists (already used by `userProfiles`).
2. Apply the migration:

```bash
cd /path/to/enscribe-api
npm run migrate:apply-psql -- sql/migrations/20260430_organizations_billing.sql
```

The script resolves the SQL path from the **repo root** (next to `package.json`), loads **`.env.local` from that same root**, and logs a redacted DB URL plus `psql` exit code. If tables never appear, install the PostgreSQL client (`psql`), confirm the log shows **exit code 0**, and prefer a **direct** connection URI (`db.<project>.supabase.co:5432`) over port **6543** pooler for DDL if Supabase errors.

This creates `organizations`, `organization_members`, and `stripe_webhook_events` with RLS.

## Personal organization

When a user **creates** their profile (`POST /api/user-profile` first insert, or sign-up with `userProfile`), the API creates a **personal** `organizations` row and an **owner** `organization_members` row (service role).

## Environment variables

| Variable | Purpose |
|----------|---------|
| `STRIPE_SECRET_KEY` | Server-side Stripe API key (use **test** mode locally). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `POST /api/stripe/webhook`. |
| `STRIPE_PRICE_PRO_MONTHLY` | Stripe Price ID for the Pro subscription (e.g. `price_...`). |
| `FRONTEND_URL` or `APP_BASE_URL` | Base URL for Checkout `success_url` / `cancel_url` and Billing Portal `return_url` (default `http://localhost:3000`). |

Existing Supabase vars (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) are required for org + webhook DB updates.

## Automated tests (`npm run test:billing-org`)

Set a **confirmed** user (email verification done) who has **`userProfile`** so a personal org exists after the migration:

```bash
TEST_BILLING_ACCOUNT_EMAIL=your-confirmed-user@example.com
TEST_BILLING_ACCOUNT_PASSWORD=yourpassword
```

These are separate from `TEST_ACCOUNT_EMAIL` / `TEST_ACCOUNT_PASSWORD` so you can use a dedicated free-tier account (no Stripe subscription) without changing the rest of the suite.

If `GET /api/billing/status` returns `404 PERSONAL_ORG_MISSING`, complete profile once with `POST /api/user-profile` for that user (or sign-in flow that creates the org on first profile insert).

## API

| Method | Path | Auth | Description |
|--------|------|------|---------------|
| GET | `/api/billing/status` | Bearer | Returns personal org billing snapshot from the database. |
| POST | `/api/billing/checkout-session` | Bearer | Body `{ "planKey": "pro" }`. Returns `{ url }` for Stripe Checkout. |
| POST | `/api/billing/portal-session` | Bearer | Returns `{ url }` for the Stripe Customer Portal. |
| POST | `/api/stripe/webhook` | Stripe signature | Raw JSON body; updates `organizations` from Stripe events. |

## Local webhooks

Use the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe listen --forward-to localhost:3001/api/stripe/webhook
```

Copy the webhook signing secret the CLI prints into `STRIPE_WEBHOOK_SECRET` for local runs.

## Production webhooks

Production uses **Stripe Dashboard** (or the API), not the CLI listener.

1. In [Stripe Dashboard](https://dashboard.stripe.com) → **Developers** → **Webhooks** → **Add endpoint**.
2. **Endpoint URL**: your public API base + path, e.g. `https://<your-api-host>/api/stripe/webhook` (same path Fastify exposes; must be HTTPS in live mode).
3. **Events to send** (minimum set that matches this codebase):  
   `checkout.session.completed`,  
   `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`,  
   `invoice.paid`, `invoice.payment_failed`  
   (you can start with these; add more later if you handle additional types.)
4. After saving, open the endpoint → **Signing secret** → **Reveal**. Put that value in **`STRIPE_WEBHOOK_SECRET`** on the server (GitHub Actions secret → EC2 `.env.local`, same as other prod secrets).  
   **Important:** Live and test mode each have their own endpoint and signing secret. Use **Test** keys + test webhook secret for staging; **Live** keys + live webhook secret for production.
5. Use **Live** products/prices and the live `STRIPE_SECRET_KEY` for real charges; webhook URL must be reachable from the public internet (no localhost).

Stripe retries failed deliveries; keep the handler reasonably fast and return **2xx** only after you accept the event (this app processes synchronously then responds).

## Frontend (out of scope here)

- After Checkout, Stripe redirects to `{FRONTEND_URL}/billing/success` or `/billing/cancel`.
- Poll or refetch `GET /api/billing/status` after return; do not treat the redirect alone as proof of payment.
