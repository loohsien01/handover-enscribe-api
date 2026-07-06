/**
 * Nova chat session display titles (sidebar / history).
 * @see docs/NOVA_AI_ARCHITECTURE.md — TODO: Chat session title
 */

import { resolveNovaBedrockModelId } from './bedrockClaudeModels.js';

export const NOVA_CHAT_DEFAULT_TITLE = 'New Chat';
export const PRE_VISIT_SUMMARY_DEFAULT_TITLE = 'New Pre-Visit Summary';
export const NOVA_CHAT_TITLE_MAX_LENGTH = 40;

/**
 * Normalize a user-supplied title (trim + cap).
 * @param {string} raw
 * @returns {string}
 */
export function normalizeNovaChatTitle(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';
  return truncateNovaChatTitle(t, NOVA_CHAT_TITLE_MAX_LENGTH);
}

/**
 * Word-aware truncation for AI or user titles.
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string}
 */
export function truncateNovaChatTitle(text, maxLen = NOVA_CHAT_TITLE_MAX_LENGTH) {
  const t = String(text ?? '').trim();
  if (t.length <= maxLen) return t;
  const slice = t.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > Math.floor(maxLen * 0.5)) {
    return slice.slice(0, lastSpace).trim();
  }
  return slice.trim();
}

/**
 * Post-process Haiku title output: strip quotes/preamble noise, cap length.
 * @param {string} raw
 * @returns {string}
 */
export function postProcessAiNovaChatTitle(raw) {
  let t = String(raw ?? '').trim();
  if (!t) return NOVA_CHAT_DEFAULT_TITLE;
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1).trim();
  }
  t = t.replace(/^title:\s*/i, '').trim();
  if (!t) return NOVA_CHAT_DEFAULT_TITLE;
  return truncateNovaChatTitle(t, NOVA_CHAT_TITLE_MAX_LENGTH);
}

/**
 * Bedrock model for one-shot title generation (Haiku by default).
 * @returns {string}
 */
export function novaChatTitleModelId() {
  const fromEnv = process.env.NOVA_TITLE_BEDROCK_MODEL_ID;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return resolveNovaBedrockModelId('haiku');
}

/**
 * First user and first assistant messages from a transcript.
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {{ userMessage: string | null, assistantMessage: string | null }}
 */
export function pickFirstTurnForNovaChatTitle(messages) {
  /** @type {string | null} */
  let userMessage = null;
  /** @type {string | null} */
  let assistantMessage = null;
  for (const m of messages || []) {
    if (!userMessage && m.role === 'user' && m.content) {
      userMessage = m.content;
    }
    if (!assistantMessage && m.role === 'assistant' && m.content) {
      assistantMessage = m.content;
    }
    if (userMessage && assistantMessage) break;
  }
  return { userMessage, assistantMessage };
}

/**
 * Truncate message bodies for the title prompt budget.
 * @param {string} text
 * @param {number} [maxChars]
 * @returns {string}
 */
export function truncateNovaChatTitlePromptText(text, maxChars = 2000) {
  const t = String(text ?? '');
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars) + '\n…';
}
