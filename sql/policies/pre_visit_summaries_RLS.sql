-- Enable RLS for visit_preps (user-owned PHI; no encounter linkage)
ALTER TABLE public.visit_preps ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own visit preps"
  ON public.visit_preps
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert their own visit preps"
  ON public.visit_preps
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
  );

CREATE POLICY "Users can update their own visit preps"
  ON public.visit_preps
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
  );

CREATE POLICY "Users can delete their own visit preps"
  ON public.visit_preps
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Service role bypass for ops scripts
CREATE POLICY "service_role_all_visit_preps"
  ON public.visit_preps
  FOR ALL
  USING (true);
