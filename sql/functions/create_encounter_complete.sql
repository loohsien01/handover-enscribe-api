-- ============================================================================
-- RPC Function for Complete Patient Encounter Creation
-- Atomically creates patient encounter, recording, and note in a single transaction
-- Replaces the multi-step POST /api/patient-encounters/complete logic
-- ============================================================================

/**
 * create_patient_encounter_complete
 * Atomically creates a patient encounter bundle with recording and note
 * 
 * Parameters:
 *   p_user_id: User ID for authorization and ownership
 *   p_encrypted_name: Patient encounter name (encrypted with encounter AES key)
 *   p_encounter_iv: IV for encounter name encryption
 *   p_encrypted_aes_key: Wrapped AES key for encounter-specific encryption
 *   p_recording_file_path: Path to recording file in storage
 *   p_recording_iv: IV for recording table
 *   p_note_encrypted_text: Note text (encrypted with user master key)
 *   p_note_text_iv: IV for note text encryption
 *   p_transcript_encrypted_text: Transcript text (encrypted with user master key), or NULL to skip
 *   p_transcript_iv: IV for transcript encryption, or NULL to skip
 *
 * Returns:
 *   JSON object containing:
 *   - patientEncounter: Complete encounter object
 *   - recording: Complete recording object  
 *   - note: Complete note object
 *   - transcript: Transcript row JSON, or JSON null if skipped
 *
 * Transaction Behavior:
 *   - All or nothing: if any step fails, entire transaction is rolled back
 *   - Uses Postgres automatic rollback on exceptions
 *   - Returns created objects as JSON for API response
 *
 * Security:
 *   - Uses SECURITY DEFINER for proper RLS context
 *   - All encryption handled in JavaScript before SQL call
 *   - Note uses user master key encryption (different from encounter encryption)
 */
CREATE OR REPLACE FUNCTION create_patient_encounter_complete(
  -- Patient Encounter params
  p_user_id UUID,
  p_encrypted_name TEXT,
  p_encounter_iv TEXT,
  p_encrypted_aes_key TEXT,

  -- Recording params
  p_recording_file_path TEXT,
  p_recording_iv TEXT,

  -- Note params
  p_note_encrypted_text TEXT,
  p_note_text_iv TEXT,

  -- Transcript params (optional — both NULL skips insert)
  p_transcript_encrypted_text TEXT,
  p_transcript_iv TEXT
) RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_encounter_id BIGINT;
  v_recording_id BIGINT;
  v_note_id BIGINT;
  v_transcript_id BIGINT;
  v_encounter JSON;
  v_recording JSON;
  v_note JSON;
  v_transcript JSON;
BEGIN

  -- 1. Insert patient encounter with encrypted data
  INSERT INTO "patientEncounters" (
    user_id,
    encrypted_name,
    iv,
    encrypted_aes_key,
    created_at,
    updated_at
  )
  VALUES (
    p_user_id,
    p_encrypted_name,
    p_encounter_iv,
    p_encrypted_aes_key,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_encounter_id;

  -- 2. Insert recording linked to encounter
  INSERT INTO recordings (
    "patientEncounter_id",
    recording_file_path,
    user_id,
    iv,
    created_at
  )
  VALUES (
    v_encounter_id,
    p_recording_file_path,
    p_user_id,
    p_recording_iv,
    NOW()
  )
  RETURNING id INTO v_recording_id;

  -- 2b. Optional transcript (user master key ciphertext), linked to recording
  v_transcript := NULL;
  IF p_transcript_encrypted_text IS NOT NULL AND p_transcript_iv IS NOT NULL THEN
    INSERT INTO transcripts (
      user_id,
      recording_id,
      encrypted_transcript_text,
      iv,
      created_at,
      updated_at
    )
    VALUES (
      p_user_id,
      v_recording_id,
      p_transcript_encrypted_text,
      p_transcript_iv,
      NOW(),
      NOW()
    )
    RETURNING id INTO v_transcript_id;

    SELECT row_to_json(t) INTO v_transcript
    FROM transcripts t WHERE id = v_transcript_id;
  END IF;

  -- 3. Insert note linked to encounter with user master key encryption
  INSERT INTO notes (
    "patientEncounter_id",
    user_id,
    encrypted_text,
    text_iv,
    created_at,
    updated_at
  )
  VALUES (
    v_encounter_id,
    p_user_id,
    p_note_encrypted_text,
    p_note_text_iv,
    NOW(),
    NOW()
  )
  RETURNING id INTO v_note_id;

  -- Fetch inserted rows as JSON for response
  SELECT row_to_json(e) INTO v_encounter
  FROM "patientEncounters" e WHERE id = v_encounter_id;

  SELECT row_to_json(r) INTO v_recording
  FROM recordings r WHERE id = v_recording_id;

  SELECT row_to_json(n) INTO v_note
  FROM notes n WHERE id = v_note_id;

  -- Return complete bundle as JSON
  RETURN json_build_object(
    'patientEncounter', v_encounter,
    'recording',        v_recording,
    'note',             v_note,
    'transcript',       v_transcript
  );

-- Any error throws and Postgres automatically rolls back the whole transaction
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'create_patient_encounter_complete failed: %', SQLERRM;
END;
$$;
