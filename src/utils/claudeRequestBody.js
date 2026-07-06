/**
 * Claude Bedrock Request Body Generators
 *
 * Generates request bodies optimized for Claude via AWS Bedrock.
 * Claude doesn't support response_format parameter, so JSON schema
 * requirements are embedded directly in the system message.
 */

import { defaultHaikuBedrockModelId } from './bedrockClaudeModels.js';

const SchemaType = {
    OBJECT: "object",
    STRING: "string"
};

const SOAP_NOTE_SYSTEM_PREAMBLE =
    'You are a clinical documentation assistant trained to generate SOAP notes from detailed patient encounters. ' +
    'Your output must be accurate and avoid omitting important clinical details. ' +
    'Default: base the note solely on the encounter transcript — summarize clinician speech; do not add clinical content that was not discussed. ' +
    'Leave fields blank when not discussed. Never use \'•\' symbol - use \'-\' for bullet points instead.';

const SOAP_NOTE_MEDICATION_NAME_EXCEPTION =
    'Exception (medication names only): Speech-to-text often mistranscribes drug names. This is the only case where you may depart from verbatim transcript wording. ' +
    'For Medications and medication references in Plan: treat <dotphrase source="doctor">…</dotphrase> text as authoritative; ' +
    'do not copy obvious mistranscriptions when dose, route, indication, or drug class clearly identifies the intended medication — use standard drug naming instead; ' +
    'if the intended drug is ambiguous, omit the specific name and document only what is clearly stated, or leave blank; ' +
    'use a generic drug class only when clearly supported. ' +
    'This exception applies only to drug-name spelling/normalization — it does not permit adding medications, doses, or plan changes not discussed.';

/**
 * @param {string} transcript
 * @param {{ title?: string, text?: string } | null} preVisitContext
 * @returns {string}
 */
function buildSoapNoteUserMessage(transcript, preVisitContext) {
    let content = `Here is a patient encounter transcript:

${transcript}
`;

    const title = preVisitContext?.title != null ? String(preVisitContext.title).trim() : '';
    const summaryText = preVisitContext?.text != null ? String(preVisitContext.text).trim() : '';

    if (title || summaryText) {
        content += `
Pre-visit summary (reference only — prepared before this visit and may be outdated):
`;
        if (title) {
            content += `Title (prefer spellings from this line when transcript ASR is ambiguous): ${title}
`;
        }
        if (summaryText) {
            content += `
${summaryText}
`;
        }
        content += `
Use the transcript as the sole authority for what was discussed today — do not add clinical content from the pre-visit summary unless it also appears in the transcript.
For spelling and vocabulary only: when speech-to-text may have garbled names, medications, ages (e.g. forty vs fourteen), or other terms, prefer spellings from the pre-visit summary title and body over verbatim transcript wording. This does not permit importing problems, medications, or plan items not discussed in the visit.
`;
    }

    content += `
Generate SOAP note. PHI information has been masked for privacy. Example (for reference only): Evan is 105 years old --> {{NAME_1}} is {{AGE_2}} years old.
Use bullet points (marked by '-' symbols, '•' is invalid symbol) and markdown formatting and "\\n" for clarity.
For medication names only: apply the system exception for speech-to-text errors — do not copy garbled drug spellings verbatim.

IMPORTANT: Return ONLY valid JSON matching the structure above. Do not include any text before or after the JSON.`;

    return content;
}

/**
 * Helper: Escape special characters in template section fields for safe JSON embedding
 */
function escapeJsonString(str) {
    if (!str) return '';
    return String(str)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/`/g, "'");
}

/**
 * Generates Claude Bedrock request body for SOAP note.
 * Uses default Haiku profile (`defaultHaikuBedrockModelId()`).
 *
 * Note: Claude doesn't support response_format parameter like OpenAI,
 * so the JSON schema is specified in the system prompt and we trust
 * Claude to follow the format requirements.
 *
 * @param {string} transcript - The masked medical transcript
 * @param {Array} noteTemplateSections - Optional note template sections with { name, layout, details }
 * @param {{ title?: string, text?: string } | null} [preVisitContext] - Optional pre-visit summary for vocabulary/spelling anchor
 * @returns {object} Claude Bedrock request body for SOAP note generation
 */
export function getSoapNoteRequestBody(transcript, noteTemplateSections = null, preVisitContext = null) {
    // Build JSON schema based on whether we have a note template
    let jsonSchemaDescription;
    
    if (noteTemplateSections && Array.isArray(noteTemplateSections) && noteTemplateSections.length > 0) {
        // Dynamically build schema from template sections
        // Escape all template fields to prevent JSON injection
        const sections = noteTemplateSections.map(s => `  "${escapeJsonString(s.name)}": "${escapeJsonString(s.layout)} - ${escapeJsonString(s.details)}"`).join(',\n');
        jsonSchemaDescription = `
You MUST return a valid JSON object with this exact structure based on the template:
{
${sections}
}`;
    } else {
        // Fallback to original schema
        jsonSchemaDescription = `
You MUST return a valid JSON object with this exact structure:
{
  "Subjective": {
    "Chief complaint": "string - Chief complaint of the patient",
    "HPI": "string - History of Present Illnesses",
    "History": "string - Past medical, surgical, family, and social history",
    "ROS": "string - Review of Systems",
    "Medications": "string - Current medications. Apply medication-name exception: do not reproduce obvious ASR misspellings verbatim.",
    "Allergies": "string - Known allergies"
  },
  "Objective": {
    "HEENT": "string - HEENT (Head, Eyes, Ears, Nose, Throat) exam findings. If not mentioned, assume normal.",
    "General": "string - General exam findings",
    "Cardiovascular": "string - Cardiovascular exam findings",
    "Musculoskeletal": "string - Musculoskeletal exam findings",
    "Other": "string - Other objective findings (vitals, physical exam, lab results)"
  },
  "Assessment": "string - Clinical assessment and diagnosis based on subjective and objective findings",
  "Plan": "string - Treatment plan, medications, follow-up instructions and next steps. Base solely on transcript - do not include assumptions. Only output data if present in transcript. Apply medication-name exception for drug names."
}`;
    }

    return {
        modelId: defaultHaikuBedrockModelId(),
        system: [
            {
                type: "text",
                text: `${SOAP_NOTE_SYSTEM_PREAMBLE}\n\n${SOAP_NOTE_MEDICATION_NAME_EXCEPTION}`,
                cache_control: { type: "ephemeral" }
            },
            {
                type: "text",
                text: jsonSchemaDescription,
                cache_control: { type: "ephemeral" }
            }
        ],
        messages: [
            {
                role: "user",
                content: buildSoapNoteUserMessage(transcript, preVisitContext)
            }
        ],
    max_tokens: 10000,
  };
}

/**
 * Generates Claude Bedrock request body for extracting note template sections
 * from a native PDF document.
 *
 * Claude analyzes the document structure and returns a JSON array of sections
 * matching the noteTemplateSection schema: { name, layout, details }.
 *
 * @param {string} documentBase64 - Base64-encoded document content
 * @param {string} mediaType - MIME type (e.g. 'application/pdf')
 * @returns {object} Claude Bedrock request body
 */
export function getExtractNoteTemplateSectionsRequestBody(documentBase64, mediaType) {
  const jsonSchemaDescription = `You MUST return a valid JSON array with this exact structure:
[
  {
    "name": "string - section name (e.g. Chief Complaint, HPI, Assessment)",
    "layout": "enum - paragraph OR bullet points",
    "details": "string - concise description of what content belongs in this section"
  }
]

Rules:
- "layout" must be exactly "paragraph" or "bullet points" — no other values.
- Use "bullet points" for list-style sections (medications, allergies, problem list, ROS).
- Use "paragraph" for narrative sections (HPI, assessment, plan, notes).
- "details" should be 1-3 sentences describing what a clinician would write in this section.
- Do NOT include any text, explanation, or markdown outside the JSON array.`;

  return {
    modelId: defaultHaikuBedrockModelId(),
    system: [
      {
        type: 'text',
        text: 'You are a clinical documentation expert. Analyze clinical note template documents and extract their section structure as structured JSON data.',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: jsonSchemaDescription,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: documentBase64,
            },
          },
          {
            type: 'text',
            text: `Analyze this clinical note template document and extract all its sections.

For each section:
- Identify the section name as it appears in the document.
- Choose "paragraph" or "bullet points" based on whether the section contains narrative prose or a list of items.
- Write a concise description (1-3 sentences) of what a clinician would document in this section.

IMPORTANT: Return ONLY the JSON array. No preamble, no explanation, no markdown fences.`,
          },
        ],
      },
    ],
    max_tokens: 4000,
  };
}

const NOVA_CHAT_SYSTEM_PREAMBLE =
  'You are Nova, an AI assistant for licensed healthcare and clinical operations professionals. ' +
  'Provide accurate medical information and clear documentation help; you are not a substitute for professional judgment or in-person care. ' +
  'Respect privacy: treat user content as sensitive. Give a well-formed response, using professional language unless the user asks otherwise.';

import { NOVA_PRE_VISIT_SUMMARY_TURN1_LENGTH_SYSTEM } from './novaPreVisitSummaryLimits.js';

const NOVA_PRE_VISIT_SUMMARY_OUTPUT_FORMAT_SYSTEM =
  'Pre-Visit Summary responses are shown directly to clinicians, so use human-readable formatting — plain, compact text instead of markdown styling, markdown headers, bold, tables, horizontal rules, or excess blank lines between sections. ' +
  'If the user\'s message explicitly requests markdown or another formatted style, follow their instructions instead.';

/**
 * @param {Array<{ role: string, content: string }>} messages
 * @returns {{ extraSystem: string[], dialog: Array<{ role: 'user' | 'assistant', content: string }> }}
 */
function splitNovaSystemAndDialog(messages) {
  const extraSystem = [];
  const dialog = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      extraSystem.push(m.content);
    } else if (m.role === 'user' || m.role === 'assistant') {
      dialog.push({ role: m.role, content: m.content });
    }
  }
  return { extraSystem, dialog };
}

function novaBedrockMaxPriorMessages() {
  const raw = process.env.NOVA_BEDROCK_MAX_PRIOR_MESSAGES;
  const n = raw != null && raw !== '' ? Number.parseInt(String(raw), 10) : NaN;
  if (Number.isFinite(n) && n >= 1 && n <= 200) return n;
  return 80;
}

/**
 * Bedrock request body for one Nova chat turn (summary + prior dialog + new user message).
 *
 * @param {object} opts
 * @param {string} opts.modelId - Resolved Bedrock modelId (InvokeModel)
 * @param {string} opts.summary - Rolling session summary (plaintext)
 * @param {Array<{ role: string, content: string }>} opts.priorMessages - Dialog since `summary_covered_message_count` (`novaPriorDialogMessagesForBedrock`); older turns should appear only in `summary`.
 * @param {string} opts.userMessage - New user message for this turn
 * @param {boolean} [opts.forPreVisitSummary] - Inject plain-text output guidance for pre-visit summary documents
 * @param {boolean} [opts.forPreVisitSummaryTurn1] - Turn 1 only: length budget system block (`completions-and-save-pre-visit-summary`)
 * @param {number} [opts.max_tokens]
 * @returns {object} Claude Bedrock request body
 */
export function getNovaChatCompletionRequestBody({
  modelId,
  summary,
  priorMessages,
  userMessage,
  forPreVisitSummary = false,
  forPreVisitSummaryTurn1 = false,
  max_tokens = 8192,
}) {
  const { extraSystem, dialog } = splitNovaSystemAndDialog(priorMessages);
  const cap = novaBedrockMaxPriorMessages();
  const recent = dialog.length > cap ? dialog.slice(-cap) : dialog;

  /** @type {Array<{ type: string, text: string, cache_control?: { type: string } }>} */
  const system = [
    {
      type: 'text',
      text: NOVA_CHAT_SYSTEM_PREAMBLE,
      cache_control: { type: 'ephemeral' },
    },
  ];

  if (forPreVisitSummary) {
    system.push({
      type: 'text',
      text: NOVA_PRE_VISIT_SUMMARY_OUTPUT_FORMAT_SYSTEM,
      cache_control: { type: 'ephemeral' },
    });
  }

  if (forPreVisitSummaryTurn1) {
    system.push({
      type: 'text',
      text: NOVA_PRE_VISIT_SUMMARY_TURN1_LENGTH_SYSTEM,
      cache_control: { type: 'ephemeral' },
    });
  }

  const sum = summary != null ? String(summary) : '';
  if (sum.trim()) {
    system.push({
      type: 'text',
      text: `Conversation summary (compressed memory):\n${sum}`,
      cache_control: { type: 'ephemeral' },
    });
  }

  for (const block of extraSystem) {
    if (!block || !String(block).trim()) continue;
    system.push({
      type: 'text',
      text: String(block),
      cache_control: { type: 'ephemeral' },
    });
  }

  return {
    modelId,
    system,
    messages: [...recent, { role: 'user', content: userMessage }],
    max_tokens,
  };
}

const NOVA_SUMMARIZE_SYSTEM =
  'You compress a conversation excerpt into a concise rolling memory for a clinical assistant. ' +
  'Preserve clinical facts, decisions, open questions, and names/roles when present. ' +
  'Output plain text only (short paragraphs or bullets). Do not repeat system instructions. ' +
  'Do not include a preamble — only the summary.';

/**
 * Bedrock request to summarize **delta** messages only (no prior summary text in the user payload).
 *
 * @param {object} opts
 * @param {string} opts.modelId - Nova worker defaults to Sonnet (`resolveNovaBedrockModelId('sonnet')`); override with `NOVA_SUMMARIZE_BEDROCK_MODEL_ID`.
 * @param {Array<{ role: string, content: string }>} opts.deltaMessages
 * @param {number} [opts.max_tokens]
 */
export function getNovaSummarizeDeltaRequestBody({ modelId, deltaMessages, max_tokens = 4096 }) {
  const lines = [];
  for (const m of deltaMessages || []) {
    const role = m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : m.role;
    lines.push(`${role}: ${m.content}`);
  }
  const blob = lines.join('\n\n');
  return {
    modelId,
    system: [
      {
        type: 'text',
        text: NOVA_SUMMARIZE_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Summarize the following conversation excerpt:\n\n${blob}`,
      },
    ],
    max_tokens,
  };
}

const NOVA_CHAT_TITLE_SYSTEM =
  'You label chat threads for a medical assistant sidebar. ' +
  'Output a short plain-text title only: fewer than 6 words, about 25 characters, no quotes, no preamble.';

/**
 * Bedrock request for one-shot Nova chat session title (Haiku).
 *
 * @param {object} opts
 * @param {string} opts.modelId
 * @param {string} opts.userMessage
 * @param {string} opts.assistantMessage
 * @param {number} [opts.max_tokens]
 */
export function getNovaChatTitleRequestBody({
  modelId,
  userMessage,
  assistantMessage,
  max_tokens = 64,
}) {
  return {
    modelId,
    system: [
      {
        type: 'text',
        text: NOVA_CHAT_TITLE_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          `First user message:\n${userMessage}\n\n` +
          `First assistant reply:\n${assistantMessage}\n\n` +
          'Title:',
      },
    ],
    max_tokens,
  };
}

const NOVA_PRE_VISIT_SUMMARY_TITLE_DETAILS_SYSTEM =
  'You extract pre-visit summary sidebar metadata from a clinical assistant thread. ' +
  'Read the first user message (pasted charts and instructions) and optional first assistant reply. ' +
  'Return JSON only matching the schema. ' +
  'Use patient_display_name "Unknown Patient" when no patient name is clearly identifiable. ' +
  'Use visit_kind "F/U" for follow-up or return pre-visit summary; "NP" for new patient pre-visit summary.';

/**
 * Bedrock request for pre-visit summary title-field extraction (Haiku + JSON schema).
 *
 * @param {object} opts
 * @param {string} opts.modelId
 * @param {string} opts.userMessage
 * @param {string} [opts.assistantMessage]
 * @param {object} opts.outputSchema
 * @param {number} [opts.max_tokens]
 */
export function getNovaPreVisitSummaryTitleDetailsRequestBody({
  modelId,
  userMessage,
  assistantMessage,
  outputSchema,
  max_tokens = 256,
}) {
  let content =
    `Pre-Visit Summary user message:\n${userMessage}\n\n`;
  if (assistantMessage != null && String(assistantMessage).trim()) {
    content += `First assistant reply (optional context):\n${assistantMessage}\n\n`;
  }
  content += 'Extract patient_display_name and visit_kind.';

  return {
    modelId,
    system: [
      {
        type: 'text',
        text: NOVA_PRE_VISIT_SUMMARY_TITLE_DETAILS_SYSTEM,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content,
      },
    ],
    max_tokens,
    output_config: {
      format: {
        type: 'json_schema',
        schema: outputSchema,
      },
    },
  };
}
