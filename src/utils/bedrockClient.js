/**
 * AWS Bedrock Claude Client
 *
 * Shared helper for invoking Claude models via AWS Bedrock.
 * Supports two authentication modes:
 *   1. Production (EC2): Uses IAM role attached to instance (no env vars needed)
 *   2. Development (local): Requires AWS_ACTIONS_ACCESS_KEY_ID and
 *      AWS_ACTIONS_SECRET_ACCESS_KEY from .env (shared with other AWS SDK usage via
 *      {@link ./awsSdkBaseClientConfig.js})
 *
 * @param {object} reqBody - Request body matching claudeRequestBody shape
 * @returns {string} Raw text content from Claude's first response block
 */

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getAwsSdkBaseClientConfig } from './awsSdkBaseClientConfig.js';

export async function claudeAPIReq(reqBody) {
  const isDev = process.env.NODE_ENV !== 'production';
  const clientConfig = getAwsSdkBaseClientConfig('Claude Bedrock');

  if (isDev) {
    console.log('[claudeAPIReq] Development mode: Using explicit AWS Bedrock credentials from env vars');
  } else {
    console.log('[claudeAPIReq] Production mode: Using IAM role attached to EC2 instance');
  }

  const client = new BedrockRuntimeClient(clientConfig);

  console.log(`[claudeAPIReq] Using Claude model: ${reqBody.modelId}`);

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    system: reqBody.system,
    messages: reqBody.messages,
    max_tokens: reqBody.max_tokens,
  };

  const command = new InvokeModelCommand({
    modelId: reqBody.modelId,
    body: JSON.stringify(requestBody),
    contentType: 'application/json',
  });

  const response = await client.send(command);

  const responseBody = JSON.parse(
    Buffer.from(response.body).toString('utf-8')
  );

  if (!responseBody.content || !Array.isArray(responseBody.content) || responseBody.content.length === 0) {
    throw new Error('Invalid response from Claude Bedrock API');
  }

  const firstContent = responseBody.content[0];
  if (firstContent.type !== 'text' || !firstContent.text) {
    throw new Error('Invalid response format from Claude Bedrock API');
  }

  if (responseBody.usage) {
    console.log(`[claudeAPIReq] Input tokens: ${responseBody.usage.input_tokens}`);
    console.log(`[claudeAPIReq] Output tokens: ${responseBody.usage.output_tokens}`);
  }

  return firstContent.text;
}
