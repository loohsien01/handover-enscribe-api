/**
 * Transcript body encryption with the user's master key (same AES path as notes).
 * Shared by transcriptsController and patientEncountersController.
 */
import * as encryptionUtils from './encryptionUtils.js';

export function stripTranscriptEncryptionFields(transcript) {
  if (!transcript) return;
  delete transcript.encrypted_transcript_text;
  delete transcript.iv;
}

/**
 * @param {string|null|undefined} plainText
 * @param {string} masterKey
 * @returns {{ success: true, encrypted_transcript_text: string|null, iv: string|null } | { success: false, error: string }}
 */
export function encryptTranscriptPlaintextWithMasterKey(plainText, masterKey) {
  const notePayload = { text: plainText ?? '' };
  const enc = encryptionUtils.encryptNoteText(notePayload, masterKey);

  if (!enc.success) {
    console.error('Failed to encrypt transcript_text:', enc.error);
    return {
      success: false,
      error: 'Failed to encrypt transcript_text',
    };
  }

  return {
    success: true,
    encrypted_transcript_text: enc.value != null ? enc.value : null,
    iv: enc.iv != null ? enc.iv : null,
  };
}

/**
 * Decrypts encrypted_transcript_text / iv into transcript_text (decryptNoteText shim).
 * Mutates transcript: sets transcript_text; strips ciphertext fields; removes optional joined `recording`.
 *
 * @returns {{ success: true, transcript } | { success: false, error: string }}
 */
export function decryptTranscriptRowWithMasterKey(transcript, masterKey) {
  const shim = {
    encrypted_text: transcript.encrypted_transcript_text,
    text_iv: transcript.iv,
  };
  const decryptResult = encryptionUtils.decryptNoteText(shim, masterKey);

  if (!decryptResult.success) {
    console.error('Failed to decrypt transcript:', transcript.id, '. Error:', decryptResult.error);
    return { success: false, error: decryptResult.error };
  }

  transcript.transcript_text = decryptResult.text ?? null;
  stripTranscriptEncryptionFields(transcript);
  delete transcript.recording;
  return { success: true, transcript };
}
