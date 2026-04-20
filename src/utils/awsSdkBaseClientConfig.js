/**
 * Shared AWS SDK client options for localhost vs EC2.
 *
 * Production: default credential provider chain (EC2 instance profile).
 * Development: explicit keys from env (same pattern as Bedrock in {@link ./bedrockClient.js}).
 */

/**
 * @param {string} [purposeLabel='AWS'] - Included in dev missing-credential errors
 * @returns {{ region: string, credentials?: { accessKeyId: string, secretAccessKey: string } }}
 */
export function getAwsSdkBaseClientConfig(purposeLabel = 'AWS') {
  const isDev = process.env.NODE_ENV !== 'production';
  const region = process.env.AWS_REGION || 'us-east-1';
  /** @type {{ region: string, credentials?: { accessKeyId: string, secretAccessKey: string } }} */
  const config = { region };

  if (isDev) {
    const accessKeyId = process.env.AWS_ACTIONS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_ACTIONS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        `[Development Mode] Missing AWS credentials for ${purposeLabel}. ` +
          'Configure AWS_ACTIONS_ACCESS_KEY_ID and AWS_ACTIONS_SECRET_ACCESS_KEY in .env.local ' +
          '(same variables used for Claude Bedrock on localhost).'
      );
    }
    config.credentials = { accessKeyId, secretAccessKey };
  }

  return config;
}
