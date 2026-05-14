-- Enable RLS
ALTER TABLE public."noteTemplateSections" ENABLE ROW LEVEL SECURITY;

-- Users can view their own AND system-provided sections
CREATE POLICY "Users can view their own and system sections"
ON public."noteTemplateSections"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid()) OR 
    user_id IS NULL
);

-- Users can only INSERT their own (never as catalog/system rows)
CREATE POLICY "Users can insert their own sections"
ON public."noteTemplateSections"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL AND
    is_system = false
);

-- Users can only UPDATE their own, non-system rows (is_system catalog sections are immutable)
CREATE POLICY "Users can update their own sections"
ON public."noteTemplateSections"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (
    user_id = (SELECT auth.uid())
    AND is_system = false
)
WITH CHECK (
    user_id = (SELECT auth.uid()) AND
    user_id IS NOT NULL AND
    is_system = false
);

-- Users can only DELETE their own (not system)
CREATE POLICY "Users can delete their own sections"
ON public."noteTemplateSections"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (user_id = (SELECT auth.uid()));
