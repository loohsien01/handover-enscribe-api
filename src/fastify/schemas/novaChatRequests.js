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

export const novaChatTokenUsageRequestSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    model: z.string().max(200).optional(),
    cost_usd: z.number().nonnegative().optional(),
  })
  .strict();
