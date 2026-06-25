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

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { getAwsSdkBaseClientConfig } from './awsSdkBaseClientConfig.js';

/**
 * Parse one Bedrock Claude stream chunk (for InvokeModelWithResponseStream).
 *
 * @param {Uint8Array | Buffer} bytes
 * @returns {{ type?: string, delta?: { type?: string, text?: string }, message?: { usage?: { input_tokens?: number } }, usage?: { output_tokens?: number }, deltaStopReason?: string }}
 */
export function parseClaudeBedrockStreamChunk(bytes) {
  return JSON.parse(Buffer.from(bytes).toString('utf-8'));
}

/**
 * Apply one parsed stream event to accumulated assistant text and usage.
 *
 * @param {ReturnType<typeof parseClaudeBedrockStreamChunk>} chunk
 * @param {{ text: string, inputTokens: number | null, outputTokens: number | null, stopReason?: string }} state
 * @returns {{ textDelta?: string }}
 */
export function applyClaudeBedrockStreamChunk(chunk, state) {
  const out = {};
  if (chunk.type === 'content_block_delta') {
    const text =
      chunk.delta?.type === 'text_delta' ? chunk.delta.text : chunk.delta?.text;
    if (text) {
      state.text += text;
      out.textDelta = text;
    }
  } else if (chunk.type === 'message_start' && chunk.message?.usage?.input_tokens != null) {
    state.inputTokens = Number(chunk.message.usage.input_tokens) || 0;
  } else if (chunk.type === 'message_delta') {
    if (chunk.usage?.output_tokens != null) {
      state.outputTokens = Number(chunk.usage.output_tokens) || 0;
    }
    if (chunk.delta?.stop_reason) {
      state.stopReason = chunk.delta.stop_reason;
    }
  }
  return out;
}

/**
 * @param {object} reqBody
 * @returns {Promise<{ text: string, usage: { input_tokens: number, output_tokens: number } | null, modelId: string, stopReason?: string }>}
 */
export async function claudeInvokeModel(reqBody) {
  const isDev = process.env.NODE_ENV !== 'production';
  const clientConfig = getAwsSdkBaseClientConfig('Claude Bedrock');

  if (isDev) {
    console.log('[claudeInvokeModel] Development mode: Using explicit AWS Bedrock credentials from env vars');
  } else {
    console.log('[claudeInvokeModel] Production mode: Using IAM role attached to EC2 instance');
  }

  const client = new BedrockRuntimeClient(clientConfig);

  console.log(`[claudeInvokeModel] Using Claude model: ${reqBody.modelId}`);

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    system: reqBody.system,
    messages: reqBody.messages,
    max_tokens: reqBody.max_tokens,
  };

  if (reqBody.output_config != null) {
    requestBody.output_config = reqBody.output_config;
  }

  const command = new InvokeModelCommand({
    modelId: reqBody.modelId,
    body: JSON.stringify(requestBody),
    contentType: 'application/json',
  });

  const response = await client.send(command);

  const responseBody = JSON.parse(Buffer.from(response.body).toString('utf-8'));

  if (!responseBody.content || !Array.isArray(responseBody.content) || responseBody.content.length === 0) {
    throw new Error('Invalid response from Claude Bedrock API');
  }

  const firstContent = responseBody.content[0];
  if (firstContent.type !== 'text' || !firstContent.text) {
    throw new Error('Invalid response format from Claude Bedrock API');
  }

  let usage = null;
  if (responseBody.usage) {
    usage = {
      input_tokens: Number(responseBody.usage.input_tokens) || 0,
      output_tokens: Number(responseBody.usage.output_tokens) || 0,
    };
    console.log(`[claudeInvokeModel] Input tokens: ${usage.input_tokens}`);
    console.log(`[claudeInvokeModel] Output tokens: ${usage.output_tokens}`);
  }

  return {
    text: firstContent.text,
    usage,
    modelId: reqBody.modelId,
    stopReason: responseBody.stop_reason,
  };
}

/**
 * Invoke Claude via Bedrock response streaming; accumulates text server-side.
 *
 * @param {object} reqBody
 * @param {{ onText?: (accumulatedText: string) => void }} [options]
 * @returns {Promise<{ text: string, usage: { input_tokens: number, output_tokens: number } | null, modelId: string, stopReason?: string }>}
 */
export async function claudeStreamModel(reqBody, options = {}) {
  const isDev = process.env.NODE_ENV !== 'production';
  const clientConfig = getAwsSdkBaseClientConfig('Claude Bedrock stream');

  if (isDev) {
    console.log('[claudeStreamModel] Development mode: Using explicit AWS Bedrock credentials from env vars');
  } else {
    console.log('[claudeStreamModel] Production mode: Using IAM role attached to EC2 instance');
  }

  const client = new BedrockRuntimeClient(clientConfig);
  console.log(`[claudeStreamModel] Using Claude model: ${reqBody.modelId}`);

  const requestBody = {
    anthropic_version: 'bedrock-2023-05-31',
    system: reqBody.system,
    messages: reqBody.messages,
    max_tokens: reqBody.max_tokens,
  };

  const command = new InvokeModelWithResponseStreamCommand({
    modelId: reqBody.modelId,
    body: JSON.stringify(requestBody),
    contentType: 'application/json',
  });

  const response = await client.send(command);
  const state = { text: '', inputTokens: null, outputTokens: null, stopReason: undefined };

  for await (const event of response.body ?? []) {
    if (!event.chunk?.bytes) continue;
    const chunk = parseClaudeBedrockStreamChunk(event.chunk.bytes);
    const { textDelta } = applyClaudeBedrockStreamChunk(chunk, state);
    if (textDelta && options.onText) {
      options.onText(state.text);
    }
  }

  if (!state.text) {
    throw new Error('Invalid response from Claude Bedrock stream API');
  }

  let usage = null;
  if (state.inputTokens != null || state.outputTokens != null) {
    usage = {
      input_tokens: state.inputTokens ?? 0,
      output_tokens: state.outputTokens ?? 0,
    };
    console.log(`[claudeStreamModel] Input tokens: ${usage.input_tokens}`);
    console.log(`[claudeStreamModel] Output tokens: ${usage.output_tokens}`);
  }

  return {
    text: state.text,
    usage,
    modelId: reqBody.modelId,
    stopReason: state.stopReason,
  };
}

/**
 * @param {object} reqBody
 * @returns {Promise<string>}
 */
export async function claudeAPIReq(reqBody) {
  const { text } = await claudeInvokeModel(reqBody);
  return text;
}
