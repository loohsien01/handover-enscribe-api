ALTER TABLE public.nova_chat_completion_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "nova_chat_completion_jobs_select_own"
  ON public.nova_chat_completion_jobs
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "nova_chat_completion_jobs_insert_own"
  ON public.nova_chat_completion_jobs
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "nova_chat_completion_jobs_update_own"
  ON public.nova_chat_completion_jobs
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
