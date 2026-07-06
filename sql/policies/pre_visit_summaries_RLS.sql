-- Enable RLS for pre_visit_summaries (user-owned PHI; patientEncounter_id nullable)
ALTER TABLE public.pre_visit_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own pre-visit summaries"
  ON public.pre_visit_summaries
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can insert their own pre-visit summaries"
  ON public.pre_visit_summaries
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
  );

CREATE POLICY "Users can update their own pre-visit summaries"
  ON public.pre_visit_summaries
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL
  );

CREATE POLICY "Users can delete their own pre-visit summaries"
  ON public.pre_visit_summaries
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Service role bypass for ops scripts
CREATE POLICY "service_role_all_pre_visit_summaries"
  ON public.pre_visit_summaries
  FOR ALL
  USING (true);
