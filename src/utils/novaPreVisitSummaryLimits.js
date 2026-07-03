/**
 * Turn 1 pre-visit summary output length (Bedrock completion only).
 * @see docs/PRE_VISIT_SUMMARY_ARCHITECTURE.md — Prompting
 */

/** Soft target communicated in prompts (~words); enforce with char / token caps. */
export const PRE_VISIT_SUMMARY_TARGET_WORDS = 350;

/** Hard char ceiling for Turn 1 assistant output (prompt + optional future validation). */
export const PRE_VISIT_SUMMARY_MAX_CHARS = 1500;

/** Default Bedrock max_tokens for Turn 1 (~1500 chars; conservative vs dense clinical text). */
export const NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS_DEFAULT = 400;

/**
 * Bedrock max_tokens for Turn 1 (`completions-and-save-pre-visit-summary` only).
 * Override via `NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS` (64–8192).
 * @returns {number}
 */
export function novaPreVisitSummaryTurn1MaxTokens() {
  const raw = process.env.NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 64 && n <= 8192) return n;
  return NOVA_PRE_VISIT_SUMMARY_TURN1_MAX_TOKENS_DEFAULT;
}

export const NOVA_PRE_VISIT_SUMMARY_TURN1_LENGTH_SYSTEM =
  `Keep the entire pre-visit summary scannable for a quick read before the visit — about ${PRE_VISIT_SUMMARY_TARGET_WORDS} words, and never more than ${PRE_VISIT_SUMMARY_MAX_CHARS} characters total. ` +
  'Use terse clinical phrasing; omit boilerplate and normal findings unless relevant to this visit. ' +
  'Honor the user\'s requested sections and format, but stay within the length budget.';
