-- RLS for pre_visit_summary_templates (mirror noteTemplates ownership model)
ALTER TABLE public.pre_visit_summary_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own and system pre-visit summary templates"
  ON public.pre_visit_summary_templates
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid()) OR
    user_id IS NULL
  );

CREATE POLICY "Users can insert their own pre-visit summary templates"
  ON public.pre_visit_summary_templates
  AS PERMISSIVE
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can update their own pre-visit summary templates"
  ON public.pre_visit_summary_templates
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

CREATE POLICY "Users can delete their own pre-visit summary templates"
  ON public.pre_visit_summary_templates
  AS PERMISSIVE
  FOR DELETE
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Service role bypass for ops / seed scripts
CREATE POLICY "service_role_all_pre_visit_summary_templates"
  ON public.pre_visit_summary_templates
  FOR ALL
  USING (true);
