-- Enable row level security
ALTER TABLE public."userProfiles" ENABLE ROW LEVEL SECURITY;

-- Users can view their own profile
create policy "Users can view their own user profile"
on public."userProfiles"
as PERMISSIVE
for SELECT
to authenticated
using (user_id = (SELECT auth.uid()));

-- Users can insert their own profile (e.g. signup)
create policy "Users can insert their own user profile"
on public."userProfiles"
as PERMISSIVE
for INSERT
to authenticated
with check (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
);

-- Users can update their own profile
create policy "Users can update their own user profile"
on public."userProfiles"
as PERMISSIVE
for UPDATE
to authenticated
using (user_id = (SELECT auth.uid()))
with check (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
);

-- No DELETE policy — cleanup via ON DELETE CASCADE on user_id → auth.users
