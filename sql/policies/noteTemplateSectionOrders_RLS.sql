-- Enable RLS
ALTER TABLE public."noteTemplateSectionOrders" ENABLE ROW LEVEL SECURITY;

-- Users can view their own and system-provided section orders
CREATE POLICY "Users can view their own and system section orders"
ON public."noteTemplateSectionOrders"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  user_id = (SELECT auth.uid()) OR
  user_id IS NULL
);

-- Users can insert their own section orders
CREATE POLICY "Users can insert their own section orders"
ON public."noteTemplateSectionOrders"
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid()) AND
  user_id IS NOT NULL
);

-- Users can update their own section orders
CREATE POLICY "Users can update their own section orders"
ON public."noteTemplateSectionOrders"
AS PERMISSIVE
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (
  user_id = (SELECT auth.uid()) AND
  user_id IS NOT NULL
);

-- Users can delete their own section orders
CREATE POLICY "Users can delete their own section orders"
ON public."noteTemplateSectionOrders"
AS PERMISSIVE
FOR DELETE
TO authenticated
USING (user_id = (SELECT auth.uid()));
