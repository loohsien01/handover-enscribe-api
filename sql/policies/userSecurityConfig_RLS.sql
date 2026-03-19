-- Enable row level security
ALTER TABLE public."userSecurityConfigs" ENABLE ROW LEVEL SECURITY;

-- Users can view their own security config
create policy "Users can view their own security config"
on public."userSecurityConfigs"
as PERMISSIVE
for SELECT
to authenticated
using (user_id = (SELECT auth.uid()));

-- Users can insert their own security config (on signup or on-demand)
create policy "Users can insert their own security config"
on public."userSecurityConfigs"
as PERMISSIVE
for INSERT
to authenticated
with check (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
);

-- Users can update their own security config (for master key rotation)
create policy "Users can update their own security config"
on public."userSecurityConfigs"
as PERMISSIVE
for UPDATE
to authenticated
using (user_id = (SELECT auth.uid()))
with check (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
);

-- No DELETE policy - users cannot delete, only cascade on account deletion via FOREIGN KEY
-- The ON DELETE CASCADE on user_id REFERENCES auth.users(id) handles cleanup
