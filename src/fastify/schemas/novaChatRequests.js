import { z } from 'zod';
import { uuidRegex } from './regex.js';

const novaMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(500_000),
});

export const novaChatSessionPatchRequestSchema = z
  .object({
    summary: z.string().max(100_000).optional(),
    token_estimate: z.number().int().nonnegative().optional(),
    messages: z.array(novaMessageSchema).max(500).optional(),
    appendMessages: z.array(novaMessageSchema).max(50).optional(),
  })
  .refine(
    (b) =>
      b.summary !== undefined ||
      b.token_estimate !== undefined ||
      b.messages !== undefined ||
      b.appendMessages !== undefined,
    { message: 'At least one of summary, token_estimate, messages, appendMessages is required' }
  )
  .refine((b) => !(b.messages != null && b.appendMessages != null), {
    message: 'Use either messages or appendMessages, not both',
  });

export const novaChatSessionIdParamsSchema = z.object({
  chatId: z.string().regex(uuidRegex, 'Invalid chat id'),
});

export const novaChatCompletionJobParamsSchema = z.object({
  chatId: z.string().regex(uuidRegex, 'Invalid chat id'),
  jobId: z.string().regex(uuidRegex, 'Invalid job id'),
});

/** GET /api/nova/chat-sessions — paginated metadata list (no transcript; use GET …/:chatId). */
export const novaChatSessionsListQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
    sortBy: z.enum(['last_active_at', 'created_at', 'updated_at']).optional(),
    order: z.enum(['asc', 'desc']).optional(),
  })
  .transform((d) => ({
    limit: d.limit ?? 50,
    offset: d.offset ?? 0,
    sortBy: d.sortBy ?? 'last_active_at',
    order: d.order ?? 'desc',
  }));

export const novaChatTokenUsageRequestSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    model: z.string().max(200).optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();

/** Preset keys; must match `resolveNovaBedrockModelId` in `src/utils/bedrockClaudeModels.js`. */
export const novaChatCompletionRequestSchema = z
  .object({
    model: z.enum(['haiku', 'sonnet', 'opus']),
    message: z.string().min(1).max(100_000),
    /** Idempotency key per turn; duplicate while in-flight or after success replays the same outcome. */
    client_message_id: z.string().regex(uuidRegex, 'client_message_id must be a UUID'),
  })
  .strict();
