-- Enable RLS for notes table
ALTER TABLE public."notes" ENABLE ROW LEVEL SECURITY;

-- Users can view their own notes
CREATE POLICY "Users can view their own notes"
ON public."notes"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

-- Users can insert their own notes
CREATE POLICY "Users can insert their own notes"
ON public."notes"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid()) AND
  user_id IS NOT NULL AND
  "patientEncounter_id" IN (
    SELECT id FROM public."patientEncounters" WHERE user_id = (SELECT auth.uid())
  )
);

-- Users can update their own notes
CREATE POLICY "Users can update their own notes"
ON public."notes"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid()) AND
  user_id IS NOT NULL AND
  "patientEncounter_id" IN (
    SELECT id FROM public."patientEncounters" WHERE user_id = (SELECT auth.uid())
  )
);

-- Users can delete their own notes
CREATE POLICY "Users can delete their own notes"
ON public."notes"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (user_id = (SELECT auth.uid()));
