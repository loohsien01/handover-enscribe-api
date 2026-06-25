/**
 * Visit prep session title field extraction (structured Haiku output).
 * @see docs/VISIT_PREP_ARCHITECTURE.md — Session title
 */

import { resolveNovaBedrockModelId } from './bedrockClaudeModels.js';

export const VISIT_PREP_UNKNOWN_PATIENT = 'Unknown Patient';

/** @typedef {{ patient_display_name: string, visit_kind: 'F/U' | 'NP' }} VisitPrepTitleDetails */

export const VISIT_PREP_TITLE_DETAILS_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    patient_display_name: {
      type: 'string',
      description:
        'Patient name when clearly identifiable in the visit prep request (pasted charts and instructions); otherwise Unknown Patient.',
    },
    visit_kind: {
      type: 'string',
      enum: ['F/U', 'NP'],
      description: 'F/U for follow-up visit prep; NP for new patient visit prep.',
    },
  },
  required: ['patient_display_name', 'visit_kind'],
  additionalProperties: false,
});

/**
 * Bedrock model for visit prep title-field extraction (Haiku by default).
 * @returns {string}
 */
export function novaVisitPrepTitleDetailsModelId() {
  const fromEnv = process.env.NOVA_VISIT_PREP_TITLE_BEDROCK_MODEL_ID;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return resolveNovaBedrockModelId('haiku');
}

/**
 * Normalize structured model output to the API contract.
 * @param {unknown} raw
 * @returns {VisitPrepTitleDetails | null}
 */
export function postProcessVisitPrepTitleDetails(raw) {
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
    name = VISIT_PREP_UNKNOWN_PATIENT;
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
