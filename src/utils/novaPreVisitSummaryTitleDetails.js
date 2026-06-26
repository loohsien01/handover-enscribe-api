/**
 * Pre-Visit Summary session title field extraction (structured Haiku output).
 * @see docs/PRE_VISIT_SUMMARY_ARCHITECTURE.md — Session title
 */

import { resolveNovaBedrockModelId } from './bedrockClaudeModels.js';

export const PRE_VISIT_SUMMARY_UNKNOWN_PATIENT = 'Unknown Patient';

/** @typedef {{ patient_display_name: string, visit_kind: 'F/U' | 'NP' }} PreVisitSummaryTitleDetails */

export const PRE_VISIT_SUMMARY_TITLE_DETAILS_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    patient_display_name: {
      type: 'string',
      description:
        'Patient name when clearly identifiable in the pre-visit summary request (pasted charts and instructions); otherwise Unknown Patient.',
    },
    visit_kind: {
      type: 'string',
      enum: ['F/U', 'NP'],
      description: 'F/U for follow-up pre-visit summary; NP for new patient pre-visit summary.',
    },
  },
  required: ['patient_display_name', 'visit_kind'],
  additionalProperties: false,
});

/**
 * Bedrock model for pre-visit summary title-field extraction (Haiku by default).
 * @returns {string}
 */
export function novaPreVisitSummaryTitleDetailsModelId() {
  const fromEnv = process.env.NOVA_PRE_VISIT_SUMMARY_TITLE_BEDROCK_MODEL_ID;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return resolveNovaBedrockModelId('haiku');
}

/**
 * Normalize structured model output to the API contract.
 * @param {unknown} raw
 * @returns {PreVisitSummaryTitleDetails | null}
 */
export function postProcessPreVisitSummaryTitleDetails(raw) {
  /** @type {Record<string, unknown> | null} */
  let obj = null;
  if (raw != null && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = /** @type {Record<string, unknown>} */ (raw);
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = /** @type {Record<string, unknown>} */ (parsed);
      }
    } catch {
      return null;
    }
  }
  if (!obj) return null;

  let name = String(obj.patient_display_name ?? '').trim();
  if (!name) {
    name = PRE_VISIT_SUMMARY_UNKNOWN_PATIENT;
  }

  const kindRaw = String(obj.visit_kind ?? '').trim().toUpperCase();
  /** @type {'F/U' | 'NP' | null} */
  let visitKind = null;
  if (kindRaw === 'F/U' || kindRaw === 'FU' || kindRaw === 'FOLLOW-UP' || kindRaw === 'FOLLOW UP') {
    visitKind = 'F/U';
  } else if (kindRaw === 'NP' || kindRaw === 'NEW PATIENT' || kindRaw === 'NEW') {
    visitKind = 'NP';
  }
  if (!visitKind) return null;

  return {
    patient_display_name: name,
    visit_kind: visitKind,
  };
}
