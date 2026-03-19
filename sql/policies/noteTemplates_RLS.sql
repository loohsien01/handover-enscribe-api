-- Enable RLS
ALTER TABLE public."noteTemplates" ENABLE ROW LEVEL SECURITY;

-- Users can view their own templates AND system-provided templates
CREATE POLICY "Users can view their own and system templates"
ON public."noteTemplates"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid()) OR 
    user_id IS NULL
);

-- Users can only INSERT their own
CREATE POLICY "Users can insert their own templates"
ON public."noteTemplates"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can only UPDATE their own (not system)
CREATE POLICY "Users can update their own templates"
ON public."noteTemplates"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

-- Users can only DELETE their own (not system)
CREATE POLICY "Users can delete their own templates"
ON public."noteTemplates"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (user_id = (SELECT auth.uid()));