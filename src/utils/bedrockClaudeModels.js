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
