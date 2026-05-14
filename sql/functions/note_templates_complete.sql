-- ============================================================================
-- RPC Functions for Note Templates Complete Endpoints
-- Handles atomic updates/inserts for templates + sections + section orders
-- ============================================================================

/**
 * update_note_template_complete
 * Atomically updates a template, optionally creates new sections, updates existing sections, and reorders all
 *
 * System sections (is_system = true): may appear in ordering but content fields cannot change.
 */
DROP FUNCTION IF EXISTS update_note_template_complete(bigint, uuid, character varying, jsonb);
CREATE OR REPLACE FUNCTION update_note_template_complete(
  p_template_id BIGINT,
  p_user_id UUID,
  p_name VARCHAR,
  p_sections JSONB
) RETURNS TABLE (
  success BOOLEAN,
  error TEXT,
  error_code VARCHAR
) AS $$
DECLARE
  v_section JSONB;
  v_section_id BIGINT;
  v_new_section_id BIGINT;
  v_order INT;
  v_section_ids BIGINT[] := ARRAY[]::BIGINT[];
  v_sec_is_system BOOLEAN;
  v_sec_name TEXT;
  v_sec_layout TEXT;
  v_sec_enc TEXT;
  v_sec_iv TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "noteTemplates" WHERE id = p_template_id AND user_id IS NOT DISTINCT FROM p_user_id
  ) THEN
    RETURN QUERY SELECT FALSE, 'Template not found or unauthorized'::TEXT, 'TEMPLATE_NOT_FOUND'::VARCHAR;
    RETURN;
  END IF;

  BEGIN
    IF p_name IS NOT NULL AND p_name != '' THEN
      UPDATE "noteTemplates"
      SET name = p_name, updated_at = NOW()
      WHERE id = p_template_id AND user_id IS NOT DISTINCT FROM p_user_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'Failed to update template';
      END IF;
    END IF;

    IF p_sections IS NOT NULL AND jsonb_array_length(p_sections) > 0 THEN
      v_order := 0;
      FOR v_section IN SELECT jsonb_array_elements(p_sections) LOOP
        v_order := v_order + 1;

        IF v_section->>'id' IS NOT NULL THEN
          v_section_id := (v_section->>'id')::BIGINT;

          SELECT s.is_system, s.name::text, s.layout::text, s.encrypted_details::text, s.details_iv::text
          INTO v_sec_is_system, v_sec_name, v_sec_layout, v_sec_enc, v_sec_iv
          FROM "noteTemplateSections" s
          WHERE s.id = v_section_id AND (s.user_id = p_user_id OR s.user_id IS NULL);

          IF NOT FOUND THEN
            RAISE EXCEPTION 'SECTION_NOT_FOUND:%', v_section_id;
          END IF;

          IF v_sec_is_system THEN
            IF (v_section ? 'name' AND (v_section->>'name') IS DISTINCT FROM v_sec_name)
               OR (v_section ? 'layout' AND (v_section->>'layout') IS DISTINCT FROM v_sec_layout)
               OR (v_section ? 'encrypted_details' AND (v_section->>'encrypted_details') IS DISTINCT FROM v_sec_enc)
               OR (v_section ? 'details_iv' AND (v_section->>'details_iv') IS DISTINCT FROM v_sec_iv)
            THEN
              RAISE EXCEPTION 'SYSTEM_SECTION_IMMUTABLE';
            END IF;
          ELSE
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
            WHERE id = v_section_id AND user_id = p_user_id;
          END IF;

          v_section_ids := array_append(v_section_ids, v_section_id);
        ELSE
          IF v_section->>'name' IS NULL OR v_section->>'name' = '' THEN
            RAISE EXCEPTION 'New sections must have a name';
          END IF;

          INSERT INTO "noteTemplateSections" (
            name,
            layout,
            encrypted_details,
            details_iv,
            user_id,
            is_system,
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
            false,
            NOW()
          )
          RETURNING id INTO v_new_section_id;

          IF v_new_section_id IS NULL THEN
            RAISE EXCEPTION 'Failed to create section';
          END IF;

          v_section_ids := array_append(v_section_ids, v_new_section_id);
        END IF;
      END LOOP;

      DELETE FROM "noteTemplateSectionOrders"
      WHERE "noteTemplate_id" = p_template_id;

      FOR v_order IN 1 .. array_length(v_section_ids, 1) LOOP
        v_section_id := v_section_ids[v_order];
        INSERT INTO "noteTemplateSectionOrders" ("noteTemplate_id", "noteTemplateSection_id", "order", "user_id")
        VALUES (p_template_id, v_section_id, v_order, p_user_id);
      END LOOP;
    END IF;

    RETURN QUERY SELECT TRUE, NULL::TEXT, NULL::VARCHAR;

  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT FALSE, 'A template with this name already exists for your account'::TEXT, 'DUPLICATE_TEMPLATE_NAME'::VARCHAR;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SECTION_NOT_FOUND:%' THEN
        RETURN QUERY SELECT FALSE, SQLERRM::TEXT, 'SECTION_NOT_FOUND'::VARCHAR;
      ELSIF SQLERRM = 'SYSTEM_SECTION_IMMUTABLE' THEN
        RETURN QUERY SELECT FALSE, 'System template sections cannot be modified'::TEXT, 'SYSTEM_SECTION_IMMUTABLE'::VARCHAR;
      ELSE
        RETURN QUERY SELECT FALSE, SQLERRM::TEXT, 'INTERNAL_ERROR'::VARCHAR;
      END IF;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================

/**
 * create_note_template_complete
 * Atomically creates a template, optionally creates new sections, and links all sections with ordering
 */
DROP FUNCTION IF EXISTS create_note_template_complete(character varying, uuid, jsonb);
CREATE OR REPLACE FUNCTION create_note_template_complete(
  p_name VARCHAR,
  p_user_id UUID,
  p_sections JSONB
) RETURNS TABLE (
  template_id BIGINT,
  success BOOLEAN,
  error TEXT,
  error_code VARCHAR
) AS $$
DECLARE
  v_new_template_id BIGINT;
  v_section JSONB;
  v_order INT;
  v_section_id BIGINT;
  v_new_section_id BIGINT;
  v_section_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  IF p_sections IS NULL OR jsonb_array_length(p_sections) = 0 THEN
    RETURN QUERY SELECT NULL::BIGINT, FALSE, 'At least one section is required'::TEXT, 'INVALID_REQUEST'::VARCHAR;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO "noteTemplates" (name, user_id, created_at)
    VALUES (p_name, p_user_id, NOW())
    RETURNING id INTO v_new_template_id;

    IF v_new_template_id IS NULL THEN
      RAISE EXCEPTION 'Failed to create template';
    END IF;

    v_order := 0;
    FOR v_section IN SELECT jsonb_array_elements(p_sections) LOOP
      v_order := v_order + 1;

      IF v_section->>'id' IS NOT NULL THEN
        v_section_id := (v_section->>'id')::BIGINT;

        IF NOT EXISTS (
          SELECT 1 FROM "noteTemplateSections"
          WHERE id = v_section_id AND (user_id = p_user_id OR user_id IS NULL)
        ) THEN
          RAISE EXCEPTION 'SECTION_NOT_FOUND:%', v_section_id;
        END IF;

        v_section_ids := array_append(v_section_ids, v_section_id);
      ELSE
        IF v_section->>'name' IS NULL OR v_section->>'name' = '' THEN
          RAISE EXCEPTION 'New sections must have a name';
        END IF;

        INSERT INTO "noteTemplateSections" (
          name,
          layout,
          encrypted_details,
          details_iv,
          user_id,
          is_system,
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
          false,
          NOW()
        )
        RETURNING id INTO v_new_section_id;

        IF v_new_section_id IS NULL THEN
          RAISE EXCEPTION 'Failed to create section';
        END IF;

        v_section_ids := array_append(v_section_ids, v_new_section_id);
      END IF;
    END LOOP;

    FOR v_order IN 1 .. array_length(v_section_ids, 1) LOOP
      v_section_id := v_section_ids[v_order];
      INSERT INTO "noteTemplateSectionOrders" ("noteTemplate_id", "noteTemplateSection_id", "order", "user_id")
      VALUES (v_new_template_id, v_section_id, v_order, p_user_id);
    END LOOP;

    RETURN QUERY SELECT v_new_template_id, TRUE, NULL::TEXT, NULL::VARCHAR;

  EXCEPTION
    WHEN unique_violation THEN
      RETURN QUERY SELECT NULL::BIGINT, FALSE, 'A template with this name already exists for your account'::TEXT, 'DUPLICATE_TEMPLATE_NAME'::VARCHAR;
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'SECTION_NOT_FOUND:%' THEN
        RETURN QUERY SELECT NULL::BIGINT, FALSE, SQLERRM::TEXT, 'SECTION_NOT_FOUND'::VARCHAR;
      ELSE
        RETURN QUERY SELECT NULL::BIGINT, FALSE, SQLERRM::TEXT, 'INTERNAL_ERROR'::VARCHAR;
      END IF;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
