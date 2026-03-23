-- ============================================================================
-- RPC Functions for Note Templates Complete Endpoints
-- Handles atomic updates/inserts for templates + sections + section orders
-- ============================================================================

/**
 * update_note_template_complete
 * Atomically updates a template, optionally creates new sections, updates existing sections, and reorders all
 * 
 * Parameters:
 *   p_template_id: ID of template to update
 *   p_user_id: User ID for authorization (RLS enforced)
 *   p_name: New template name (optional)
 *   p_sections: JSONB array of sections to create/update
 *     - Sections with 'id': update existing sections (other fields are optional)
 *     - Sections without 'id': create new sections (name required, other fields optional)
 *     - Array order determines final section ordering (1, 2, 3, ...)
 *     - If omitted or empty: sections are not modified or reordered
 *
 * Returns:
 *   success: true if all operations succeeded
 *   error: error message if any operation failed (entire TX rolled back)
 *
 * Transaction Behavior:
 *   - All or nothing: if any step fails, entire operation is rolled back
 *   - Validates section ownership before updates
 */
CREATE OR REPLACE FUNCTION update_note_template_complete(
  p_template_id BIGINT,
  p_user_id UUID,
  p_name VARCHAR,
  p_sections JSONB
) RETURNS TABLE (
  success BOOLEAN,
  error TEXT
) AS $$
DECLARE
  v_section JSONB;
  v_section_id BIGINT;
  v_new_section_id BIGINT;
  v_order INT;
  v_section_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  -- Validation: Check template exists and belongs to user
  IF NOT EXISTS (
    SELECT 1 FROM "noteTemplates" WHERE id = p_template_id AND user_id IS NOT DISTINCT FROM p_user_id
  ) THEN
    RETURN QUERY SELECT FALSE, 'Template not found or unauthorized'::TEXT;
    RETURN;
  END IF;

  BEGIN
    -- Step 1: Update template name (if provided)
    IF p_name IS NOT NULL AND p_name != '' THEN
      UPDATE "noteTemplates"
      SET name = p_name, updated_at = NOW()
      WHERE id = p_template_id AND user_id IS NOT DISTINCT FROM p_user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Failed to update template';
      END IF;
    END IF;

    -- Step 2: Process sections (create new, update existing, collect IDs)
    IF p_sections IS NOT NULL AND jsonb_array_length(p_sections) > 0 THEN
      v_order := 0;
      FOR v_section IN SELECT jsonb_array_elements(p_sections) LOOP
        v_order := v_order + 1;

        -- Check if section has 'id' (existing section to potentially update)
        IF v_section->>'id' IS NOT NULL THEN
          v_section_id := (v_section->>'id')::BIGINT;

          -- Validate existing section belongs to user or system
          IF NOT EXISTS (
            SELECT 1 FROM "noteTemplateSections"
            WHERE id = v_section_id AND (user_id = p_user_id OR user_id IS NULL)
          ) THEN
            RAISE EXCEPTION 'Section % not found or unauthorized', v_section_id;
          END IF;

          -- Update section with provided fields (only non-null fields)
          UPDATE "noteTemplateSections"
          SET 
            name = COALESCE(v_section->>'name', name),
            layout = CASE WHEN v_section->>'layout' IS NOT NULL 
              THEN (v_section->>'layout')::section_layout 
              ELSE layout 
            END,
            encrypted_details = COALESCE(v_section->>'encrypted_details', encrypted_details),
            details_iv = COALESCE(v_section->>'details_iv', details_iv),
            updated_at = NOW()
          WHERE id = v_section_id AND (user_id = p_user_id OR user_id IS NULL);

          v_section_ids := array_append(v_section_ids, v_section_id);
        ELSE
          -- Create new section
          IF v_section->>'name' IS NULL OR v_section->>'name' = '' THEN
            RAISE EXCEPTION 'New sections must have a name';
          END IF;

          INSERT INTO "noteTemplateSections" (
            name,
            layout,
            encrypted_details,
            details_iv,
            user_id,
            created_at
          ) VALUES (
            v_section->>'name',
            CASE WHEN v_section->>'layout' IS NOT NULL 
              THEN (v_section->>'layout')::section_layout 
              ELSE 'bullet points'::section_layout 
            END,
            v_section->>'encrypted_details',
            v_section->>'details_iv',
            p_user_id,
            NOW()
          )
          RETURNING id INTO v_new_section_id;

          IF v_new_section_id IS NULL THEN
            RAISE EXCEPTION 'Failed to create section';
          END IF;

          v_section_ids := array_append(v_section_ids, v_new_section_id);
        END IF;
      END LOOP;

      -- Step 3: Reorder sections (delete old, insert new)
      DELETE FROM "noteTemplateSectionOrders"
      WHERE "noteTemplate_id" = p_template_id;

      FOR v_order IN 1 .. array_length(v_section_ids, 1) LOOP
        v_section_id := v_section_ids[v_order];
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
 * Atomically creates a template, optionally creates new sections, and links all sections with ordering
 *
 * Parameters:
 *   p_name: Template name (must be unique per user)
 *   p_user_id: User ID (template owner)
 *   p_sections: JSONB array of sections to create/link
 *     - Sections with 'id': link existing sections (other fields ignored)
 *     - Sections without 'id': create new sections with provided fields
 *     - Array order determines section ordering (1, 2, 3, ...)
 *     - New sections require 'name' field
 *     - Optional fields: layout, encrypted_details, details_iv
 *
 * Returns:
 *   template_id: ID of newly created template (BIGINT)
 *   success: true if creation succeeded
 *   error: error message if creation failed
 *
 * Transaction Behavior:
 *   - All or nothing: if any step fails, entire transaction is rolled back
 */
CREATE OR REPLACE FUNCTION create_note_template_complete(
  p_name VARCHAR,
  p_user_id UUID,
  p_sections JSONB
) RETURNS TABLE (
  template_id BIGINT,
  success BOOLEAN,
  error TEXT
) AS $$
DECLARE
  v_new_template_id BIGINT;
  v_section JSONB;
  v_order INT;
  v_section_id BIGINT;
  v_new_section_id BIGINT;
  v_section_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  -- Validation: sections array must not be empty
  IF p_sections IS NULL OR jsonb_array_length(p_sections) = 0 THEN
    RETURN QUERY SELECT NULL::BIGINT, FALSE, 'At least one section is required'::TEXT;
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

    -- Step 2: Process sections (create new, validate existing, collect IDs)
    v_order := 0;
    FOR v_section IN SELECT jsonb_array_elements(p_sections) LOOP
      v_order := v_order + 1;

      -- Check if section has 'id' (existing section to link)
      IF v_section->>'id' IS NOT NULL THEN
        v_section_id := (v_section->>'id')::BIGINT;

        -- Validate existing section belongs to user or system
        IF NOT EXISTS (
          SELECT 1 FROM "noteTemplateSections"
          WHERE id = v_section_id AND (user_id = p_user_id OR user_id IS NULL)
        ) THEN
          RAISE EXCEPTION 'Section % not found or unauthorized', v_section_id;
        END IF;

        v_section_ids := array_append(v_section_ids, v_section_id);
      ELSE
        -- Create new section
        IF v_section->>'name' IS NULL OR v_section->>'name' = '' THEN
          RAISE EXCEPTION 'New sections must have a name';
        END IF;

        INSERT INTO "noteTemplateSections" (
          name,
          layout,
          encrypted_details,
          details_iv,
          user_id,
          created_at
        ) VALUES (
          v_section->>'name',
          CASE WHEN v_section->>'layout' IS NOT NULL 
            THEN (v_section->>'layout')::section_layout 
            ELSE 'bullet points'::section_layout 
          END,
          v_section->>'encrypted_details',
          v_section->>'details_iv',
          p_user_id,
          NOW()
        )
        RETURNING id INTO v_new_section_id;

        IF v_new_section_id IS NULL THEN
          RAISE EXCEPTION 'Failed to create section';
        END IF;

        v_section_ids := array_append(v_section_ids, v_new_section_id);
      END IF;
    END LOOP;

    -- Step 3: Link sections with ordering
    FOR v_order IN 1 .. array_length(v_section_ids, 1) LOOP
      v_section_id := v_section_ids[v_order];
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
