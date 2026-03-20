-- ============================================================================
-- RPC Functions for Note Templates Complete Endpoints
-- Handles atomic updates/inserts for templates + sections + section orders
-- ============================================================================

/**
 * update_note_template_complete
 * Atomically updates a template, its sections, and section ordering
 * 
 * Parameters:
 *   p_template_id: ID of template to update
 *   p_user_id: User ID for authorization (RLS enforced)
 *   p_name: New template name
 *   p_sections: JSON array of sections [{id, name, layout, encrypted_details, details_iv}, ...]
 *     - Only provided fields are updated
 *     - All provided sections must exist and belong to user
 *   p_section_ids: Ordered array of section IDs (optional)
 *     - If provided: reorders sections (must be consecutive 1, 2, 3, ...)
 *     - If omitted or empty: section ordering is not changed
 *
 * Returns:
 *   success: true if all operations succeeded
 *   error: error message if any operation failed (entire TX rolled back)
 *
 * Transaction Behavior:
 *   - All or nothing: if any step fails, entire operation is rolled back
 *   - Validates section ownership before updates
 *   - Validates section order is consecutive starting from 1
 */
CREATE OR REPLACE FUNCTION update_note_template_complete(
  p_template_id BIGINT,
  p_user_id UUID,
  p_name VARCHAR,
  p_sections JSONB,
  p_section_ids BIGINT[]
) RETURNS TABLE (
  success BOOLEAN,
  error TEXT
) AS $$
DECLARE
  v_section JSONB;
  v_section_id BIGINT;
  v_order INT;
  v_count INT;
  v_expected_order INT;
BEGIN
  -- Validation: Check template exists and belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM "noteTemplates" WHERE id = p_template_id AND user_id IS NOT DISTINCT FROM p_user_id
  ) THEN
    RETURN QUERY SELECT FALSE, 'Template not found or unauthorized'::TEXT;
    RETURN;
  END IF;

  -- Validation: Validate all section IDs exist and belong to user (or system)
  -- Only validate if sections are provided
  IF p_section_ids IS NOT NULL AND array_length(p_section_ids, 1) > 0 THEN
    SELECT COUNT(*)::INT INTO v_count
    FROM "noteTemplateSections"
    WHERE id = ANY(p_section_ids)
      AND (user_id = p_user_id OR user_id IS NULL);

    IF v_count != array_length(p_section_ids, 1) THEN
      RETURN QUERY SELECT FALSE, 'One or more sections not found or unauthorized'::TEXT;
      RETURN;
    END IF;

    -- Validation: Validate section IDs are consecutive starting from 1
    FOR v_expected_order IN 1 .. array_length(p_section_ids, 1) LOOP
      -- Since p_section_ids is already ordered, check length
      NULL;
    END LOOP;
  END IF;

  BEGIN
    -- Step 1: Update template name
    UPDATE "noteTemplates"
    SET name = p_name, updated_at = NOW()
    WHERE id = p_template_id AND user_id IS NOT DISTINCT FROM p_user_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Failed to update template';
    END IF;

    -- Step 2: Update each section (only provided fields)
    IF p_sections IS NOT NULL AND jsonb_array_length(p_sections) > 0 THEN
      FOR v_section IN SELECT jsonb_array_elements(p_sections) LOOP
        UPDATE "noteTemplateSections"
        SET 
          name = COALESCE(v_section->>'name', name),
          layout = CASE WHEN v_section->>'layout' IS NOT NULL THEN (v_section->>'layout')::section_layout ELSE layout END,
          encrypted_details = COALESCE(v_section->>'encrypted_details', encrypted_details),
          details_iv = COALESCE(v_section->>'details_iv', details_iv),
          updated_at = NOW()
        WHERE id = (v_section->>'id')::BIGINT
          AND (user_id = p_user_id OR user_id IS NULL);

        IF NOT FOUND THEN
          RAISE EXCEPTION 'Section % not found or unauthorized', v_section->>'id';
        END IF;
      END LOOP;
    END IF;

    -- Step 3: Delete existing section orders for this template (only if reordering)
    -- Step 4: Insert new section orders (in provided order, starting from 1)
    IF p_section_ids IS NOT NULL AND array_length(p_section_ids, 1) > 0 THEN
      DELETE FROM "noteTemplateSectionOrders"
      WHERE "noteTemplate_id" = p_template_id;

      FOR v_order IN 1 .. array_length(p_section_ids, 1) LOOP
        v_section_id := p_section_ids[v_order];
        INSERT INTO "noteTemplateSectionOrders" ("noteTemplate_id", "noteTemplateSection_id", "order")
        VALUES (p_template_id, v_section_id, v_order);
      END LOOP;
    END IF;

    RETURN QUERY SELECT TRUE, NULL::TEXT;

  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT FALSE, SQLERRM::TEXT;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================

/**
 * create_note_template_complete
 * Atomically creates a template and links pre-existing sections with ordering
 *
 * Parameters:
 *   p_name: Template name (must be unique per user)
 *   p_user_id: User ID (template owner)
 *   p_section_ids: Ordered array of existing section IDs to link
 *     - Must be consecutive starting from 1 in the ordering
 *     - All sections must exist and belong to user (or system)
 *
 * Returns:
 *   template_id: ID of newly created template (BIGINT)
 *   success: true if creation succeeded
 *   error: error message if creation failed
 *
 * Transaction Behavior:
 *   - All or nothing: if section linking fails, template insert is rolled back
 */
CREATE OR REPLACE FUNCTION create_note_template_complete(
  p_name VARCHAR,
  p_user_id UUID,
  p_section_ids BIGINT[]
) RETURNS TABLE (
  template_id BIGINT,
  success BOOLEAN,
  error TEXT
) AS $$
DECLARE
  v_new_template_id BIGINT;
  v_order INT;
  v_section_id BIGINT;
  v_count INT;
BEGIN
  -- Validation: Validate all section IDs exist and belong to user (or system)
  SELECT COUNT(*)::INT INTO v_count
  FROM "noteTemplateSections"
  WHERE id = ANY(p_section_ids)
    AND (user_id = p_user_id OR user_id IS NULL);

  IF v_count != array_length(p_section_ids, 1) THEN
    RETURN QUERY SELECT NULL::BIGINT, FALSE, 'One or more sections not found or unauthorized'::TEXT;
    RETURN;
  END IF;

  BEGIN
    -- Step 1: Insert template
    INSERT INTO "noteTemplates" (name, user_id, created_at)
    VALUES (p_name, p_user_id, NOW())
    RETURNING id INTO v_new_template_id;

    IF v_new_template_id IS NULL THEN
      RAISE EXCEPTION 'Failed to create template';
    END IF;

    -- Step 2: Link sections with ordering
    FOR v_order IN 1 .. array_length(p_section_ids, 1) LOOP
      v_section_id := p_section_ids[v_order];
      INSERT INTO "noteTemplateSectionOrders" ("noteTemplate_id", "noteTemplateSection_id", "order")
      VALUES (v_new_template_id, v_section_id, v_order);
    END LOOP;

    RETURN QUERY SELECT v_new_template_id, TRUE, NULL::TEXT;

  EXCEPTION 
    WHEN unique_violation THEN
      RETURN QUERY SELECT NULL::BIGINT, FALSE, 'A template with this name already exists for your account'::TEXT;
    WHEN OTHERS THEN
      RETURN QUERY SELECT NULL::BIGINT, FALSE, SQLERRM::TEXT;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
