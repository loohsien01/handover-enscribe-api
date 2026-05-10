-- Enable RLS for internal_access table
ALTER TABLE public.internal_access ENABLE ROW LEVEL SECURITY;

-- Users can view ONLY their own internal-access row.
--
-- The FE consumes a curated payload via the BE entitlements endpoint
-- (GET /api/me/entitlements). This SELECT policy is a defense-in-depth
-- safety net for the rare case the table is queried directly with the
-- user's anon JWT — it must never broaden to other users' rows.
create policy "Users can view their own internal access"
on public.internal_access
as PERMISSIVE
for SELECT
to authenticated
using (user_id = (SELECT auth.uid()));

-- Intentionally NO INSERT / UPDATE / DELETE policies for `authenticated`.
-- All writes must go through the service role (supabaseAdmin) on the BE
-- so that grants of free/internal access are gated on admin tooling and audited.
-- Row removal on account deletion is handled by ON DELETE CASCADE
-- (user_id -> auth.users).
