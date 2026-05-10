/**
 * Canonical Claude on Bedrock model identifiers for this API.
 * Defaults use US cross-region inference profile IDs where available; override per
 * environment if your account uses different profiles or in-region ARNs.
 *
 * @see https://docs.aws.amazon.com/bedrock/latest/userguide/model-ids.html
 */

const DEFAULT_MODEL_IDS = {
  haiku: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  sonnet: 'us.anthropic.claude-sonnet-4-6',
  opus: 'us.anthropic.claude-opus-4-7',
};

const ENV_SUFFIX = {
  haiku: 'HAIKU',
  sonnet: 'SONNET',
  opus: 'OPUS',
};

/**
 * Resolve a Nova UI model key to a Bedrock `modelId` for InvokeModel.
 * @param {string} key
 * @returns {string | null} null if `key` is not a supported Nova preset
 */
export function resolveNovaBedrockModelId(key) {
  const k = String(key || '').toLowerCase();
  if (k !== 'haiku' && k !== 'sonnet' && k !== 'opus') {
    return null;
  }
  const envName = `NOVA_BEDROCK_MODEL_${ENV_SUFFIX[k]}`;
  const fromEnv = process.env[envName];
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return DEFAULT_MODEL_IDS[k];
}

/**
 * Default Haiku profile for non-Nova flows (SOAP notes, template PDF extract).
 * Override with `BEDROCK_DEFAULT_HAIKU_MODEL_ID` without coupling to Nova env vars.
 * @returns {string}
 */
export function defaultHaikuBedrockModelId() {
  const fromEnv = process.env.BEDROCK_DEFAULT_HAIKU_MODEL_ID;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    return String(fromEnv).trim();
  }
  return DEFAULT_MODEL_IDS.haiku;
}

/** Approximate max input context (tokens) for thresholding; override per preset via env. */
const DEFAULT_CONTEXT_LIMITS = {
  haiku: 200_000,
  sonnet: 200_000,
  opus: 200_000,
};

/**
 * @param {'haiku' | 'sonnet' | 'opus'} preset
 * @returns {number} positive token limit, or 0 if unknown
 */
export function novaPresetContextLimitTokens(preset) {
  const k = String(preset || '').toLowerCase();
  if (k !== 'haiku' && k !== 'sonnet' && k !== 'opus') return 0;
  const envName = `NOVA_BEDROCK_CONTEXT_LIMIT_${ENV_SUFFIX[k]}`;
  const fromEnv = process.env[envName];
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    const n = Number.parseInt(String(fromEnv).trim(), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_CONTEXT_LIMITS[k];
}

/**
 * Ratio of prompt size to model context (0–1+) for Nova completion thresholding.
 * @param {{ input_tokens?: number } | null | undefined} usage
 * @param {'haiku' | 'sonnet' | 'opus'} preset
 * @returns {number}
 */
export function novaCompletionContextUsageRatio(usage, preset) {
  if (!usage || typeof usage.input_tokens !== 'number' || usage.input_tokens < 0) return 0;
  const limit = novaPresetContextLimitTokens(preset);
  if (!limit) return 0;
  return usage.input_tokens / limit;
}

/**
 * @returns {number} default 0.7
 */
export function novaSummarizeContextThreshold() {
  const raw = process.env.NOVA_SUMMARIZE_CONTEXT_THRESHOLD;
  const n = raw != null && raw !== '' ? Number.parseFloat(String(raw)) : NaN;
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  return 0.7;
}
