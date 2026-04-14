import { z } from 'zod';
import { isoDatetimeRegex, uuidRegex } from './regex.js';

// Request schemas - what the API client sends
// These are separate from database schemas to decouple API contracts from DB schema

export const patientEncounterCreateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  recording_file_path: z.string().min(1, 'Recording file path is required').optional(),
  recording_file_signed_url: z.string().nullable().optional(),
  recording_file_signed_url_expiry: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime').nullable().optional(),
});

/**
 * POST request for creating a complete patient encounter bundle
 * Endpoint: POST /api/patient-encounters/complete
 * Requires patientEncounter, recording, and note_text objects
 */
export const patientEncounterCompleteCreateRequestSchema = z.object({
  patientEncounter: z.object({
    name: z.string().min(1, 'Patient encounter name is required'),
  }),
  recording: z.object({
    recording_file_path: z.string().min(1, 'Recording file path is required'),
  }),
  note_text: z.string().min(0, 'Note text can be empty'),
});

/**
 * PATCH request for patient encounter - only updates the encounter itself (e.g., name)
 */
export const patientEncounterUpdateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
});

/**
 * GET /api/patient-encounters
 * decryptName: default false — omit decrypted name; encrypted fields stripped from response.
 */
export const patientEncountersListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
  decryptName: z.enum(['true', 'false']).optional().default('false'),
}).transform((data) => ({
  limit: data.limit ?? 50,
  offset: data.offset ?? 0,
  decryptName: data.decryptName === 'true',
}));

/**
 * GET /api/patient-encounters/:id
 */
export const patientEncounterGetQuerySchema = z.object({
  decryptName: z.enum(['true', 'false']).optional().default('false'),
}).transform((data) => ({
  decryptName: data.decryptName === 'true',
}));

/**
 * Schema for the transformed data before database operations
 * This is what gets validated before saving to DB
 */
export const patientEncounterForDatabaseSchema = z.object({
  id: z.number().int().optional(),
  encrypted_name: z.string().nullable().optional(),
  recording_file_path: z.string().nullable().optional(),
  recording_file_signed_url: z.string().nullable().optional(),
  recording_file_signed_url_expiry: z.string().regex(isoDatetimeRegex, 'Invalid ISO datetime').nullable().optional(),
  encrypted_aes_key: z.string().nullable().optional(),
  iv: z.string().nullable().optional(),
  user_id: z.string().regex(uuidRegex, 'Invalid UUID').nullable().optional(),
});

/**
 * Query parameters for GET /api/recordings/attachments
 */
export const recordingsAttachmentsQuerySchema = z.object({
  attached: z.enum(['true', 'false'], 'attached parameter must be "true" or "false"'),
  limit: z.coerce.number().int().positive().default(100).optional(),
  offset: z.coerce.number().int().nonnegative().default(0).optional(),
  sortBy: z.enum(['name', 'created_at', 'updated_at'], 'sortBy must be one of: name, created_at, updated_at').default('name').optional(),
  order: z.enum(['asc', 'desc'], 'order must be one of: asc, desc').default('asc').optional(),
});

/** POST /api/internal/cleanup/run — extend enum when new cleanup tasks are added */
export const internalCleanupTaskSchema = z.enum(['unattached_storage']);

/**
 * POST /api/internal/cleanup/run
 * Internal cron / ops: Bearer INTERNAL_CLEANUP_SECRET
 */
export const internalCleanupRunBodySchema = z.object({
  tasks: z
    .array(internalCleanupTaskSchema)
    .min(1, 'tasks must include at least one item')
    .max(32, 'tasks list is too long'),
});

/**
 * POST request for creating a recording
 * Endpoint: POST /api/recordings
 */
export const recordingCreateRequestSchema = z.object({
  patientEncounter_id: z.number('Patient Encounter ID is required').int('Patient Encounter ID must be an integer'),
  recording_file_path: z.string('Recording file path is required').min(1, 'Recording file path is required'),
});

/**
 * POST request for generating a signed upload URL
 * Endpoint: POST /api/recordings/create-signed-upload-url
 */
export const recordingUploadRequestSchema = z.object({
  filename: z.string('Filename is required').min(1, 'Filename is required'),
});

/**
 * POST request for generating a signed download URL
 * Endpoint: POST /api/recordings/create-signed-url
 */
export const recordingCreateSignedUrlRequestSchema = z.object({
  path: z.string('Path is required').min(1, 'Path is required'),
});

/**
 * DELETE request for bulk deleting storage files
 * Endpoint: DELETE /api/recordings/storage
 * Deletes only storage files (not DB records)
 */
export const deleteRecordingsStorageRequestSchema = z.object({
  prefixes: z.array(
    z.string().min(1, 'Each prefix must be a non-empty string'),
    { invalid_type_error: 'prefixes must be an array' }
  )
    .min(1, 'prefixes array must contain at least one prefix')
    .max(100, 'prefixes array cannot exceed 100 items'),
});

/**
 * POST request for creating a transcript
 * Endpoint: POST /api/transcripts
 */
export const transcriptCreateRequestSchema = z.object({
  transcript_text: z.string().min(1, 'Transcript text is required'),
  recording_id: z.number().int('Recording ID must be an integer'),
});

/**
 * PATCH request for updating a transcript
 * Endpoint: PATCH /api/transcripts/:id
 */
export const transcriptUpdateRequestSchema = z.object({
  transcript_text: z.string().min(1, 'Transcript text is required'),
});

/**
 * POST request for creating a SOAP note
 * Endpoint: POST /api/soap-notes
 */
export const soapNoteCreateRequestSchema = z.object({
  patientEncounter_id: z.number('Patient Encounter ID is required').int('Patient Encounter ID must be an integer'),
  soapNote_text: z.object({
    soapNote: z.object({
      subjective: z.string().optional().default(''),
      objective: z.string().optional().default(''),
      assessment: z.string().optional().default(''),
      plan: z.string().optional().default(''),
    }).optional(),
    billingSuggestion: z.string().optional().default(''),
  }),
});

/**
 * PATCH request for updating a SOAP note
 * Endpoint: PATCH /api/soap-notes/:id
 * Note: ID is in URL path, not in request body
 */
export const soapNoteUpdateRequestSchema = z.object({
  soapNote_text: z.object({
    soapNote: z.object({
      subjective: z.string().optional().default(''),
      objective: z.string().optional().default(''),
      assessment: z.string().optional().default(''),
      plan: z.string().optional().default(''),
    }).optional(),
    billingSuggestion: z.string().optional().default(''),
  }),
});
/**
 * POST request for SOAP note generation via OpenAI
 * Endpoint: POST /api/prompt-llm
 */
export const promptLlmRequestSchema = z.object({
  recording_file_path: z.string('Recording file path is required').min(1, 'Recording file path is required'),
});

/**
 * POST request for SOAP note generation (job-based, polling).
 * Endpoint: POST /api/jobs/prompt-llm/generate-note
 * Optional: noteTemplate_id to use a specific note template for SOAP note generation
 */
export const promptLlmGenerateNoteRequestSchema = z.object({
  recording_file_path: z.string().min(1, 'Recording file path is required'),
  noteTemplate_id: z.number().int().or(z.bigint()).or(z.string().transform(BigInt)).optional().nullable(),
});

/**
 * POST /api/jobs/prompt-llm/generate-and-save-note
 * Same as generate-note plus patient encounter display name for atomic save after generation.
 */
export const promptLlmGenerateAndSaveNoteRequestSchema = promptLlmGenerateNoteRequestSchema.extend({
  patient_encounter_name: z.string().min(1, 'patient_encounter_name is required'),
});

/**
 * GET request query parameters for retrieving job status
 * Endpoint: GET /api/jobs/prompt-llm/:jobId
 * Query param: ?includeResult=true (optional, includes parsed SOAP note if complete)
 */
export const getPromptLlmJobStatusQuerySchema = z.object({
  includeResult: z.enum(['true', 'false']).optional().default('false'),
}).catchall(z.any());

/**
 * POST request for creating a dot phrase
 * Endpoint: POST /api/dot-phrases
 */
export const dotPhraseCreateRequestSchema = z.object({
  trigger: z.string('Trigger is required').min(1, 'Trigger is required'),
  expansion: z.string('Expansion is required').min(1, 'Expansion is required'),
});

/**
 * PATCH request for updating a dot phrase
 * Endpoint: PATCH /api/dot-phrases/:id
 */
export const dotPhraseUpdateRequestSchema = z.object({
  trigger: z.string('Trigger is required').min(1, 'Trigger is required').optional(),
  expansion: z.string('Expansion is required').min(1, 'Expansion is required').optional(),
}).refine(
  (data) => data.trigger !== undefined || data.expansion !== undefined,
  { message: 'At least one of trigger or expansion must be provided' }
);

/**
 * POST request for transcript expand endpoint (test dot phrase expansion without transcription)
 * Endpoint: POST /api/transcripts/expand
 */
export const transcriptExpandRequestSchema = z.object({
  transcript: z.string().min(1, 'Transcript is required'),
  dotPhrases: z.array(z.object({
    trigger: z.string(),
    expansion: z.string(),
  })).default([]),
  enableDotPhraseExpansion: z.boolean().default(true).optional(),
});

// Legacy alias for backward compatibility
export const gcpExpandRequestSchema = transcriptExpandRequestSchema;

/**
 * POST request for AWS mask-phi endpoint
 * Endpoint: POST /api/aws/mask-phi
 */
export const MaskPhiRequestBodySchema = z.object({
  text: z.string()
    .min(1, 'Text is required')
    .describe('Medical transcript to mask'),
  maskThreshold: z.number()
    .min(0)
    .max(1)
    .optional()
    .default(0.15)
    .describe('Confidence threshold for masking (0-1, default 0.15)'),
});

/**
 * POST request for AWS unmask-phi endpoint
 * Endpoint: POST /api/aws/unmask-phi
 */
export const UnmaskPhiRequestBodySchema = z.object({
  text: z.string()
    .min(1, 'Text is required')
    .describe('Transcript with {{TYPE_ID}} tokens'),
  tokens: z.object({}).passthrough()
    .describe('Token mapping from AWS Comprehend Medical (can be empty)'),
}).strict();

/**
 * POST request for Deepgram transcribe/complete endpoint
 * Endpoint: POST /api/deepgram/transcribe/complete
 */
export const TranscribeRequestBodySchema = z.object({
  recording_file_signed_url: z.string()
    .url('recording_file_signed_url must be a valid URL')
    .describe('Signed URL to the recording file in Supabase'),
  enableDotPhraseExpansion: z.boolean()
    .optional()
    .default(true)
    .describe('Whether to enable dot phrase expansion (default: true)'),
});

// ============================================================================
// Note Template Sections Schemas
// ============================================================================

/**
 * POST request for creating a note template section
 * Endpoint: POST /api/note-template-sections
 * Details field is encrypted server-side
 * Layout must be a valid section_layout enum: 'paragraph' or 'bullet points'
 */
export const noteTemplateSectionCreateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  layout: z.enum(['paragraph', 'bullet points'], {
    errorMap: () => ({ message: 'Layout must be either "paragraph" or "bullet points"' }),
  }),
  details: z.string().min(1, 'Details is required'),
});

/**
 * PATCH request for updating a note template section
 * Endpoint: PATCH /api/note-template-sections/:id
 * All fields are optional, at least one must be provided
 * Layout must be a valid section_layout enum: 'paragraph' or 'bullet points'
 */
export const noteTemplateSectionUpdateRequestSchema = z.object({
  name: z.string().optional(),
  layout: z.enum(['paragraph', 'bullet points'], {
    errorMap: () => ({ message: 'Layout must be either "paragraph" or "bullet points"' }),
  }).optional(),
  details: z.string().optional(),
}).refine(
  (data) => data.name !== undefined || data.layout !== undefined || data.details !== undefined,
  { message: 'At least one field (name, layout, or details) must be provided' }
);

// ============================================================================
// Note Templates Schemas
// ============================================================================

/**
 * POST request for creating a note template
 * Endpoint: POST /api/note-templates
 * Name is required and must be unique per user
 */
export const noteTemplateCreateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
});

/**
 * PATCH request for updating a note template
 * Endpoint: PATCH /api/note-templates/:id
 * Name is optional
 */
export const noteTemplateUpdateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field (name) must be provided' }
);

// ============================================================================
// Note Templates Complete Endpoints (with sections + ordering)
// ============================================================================

/**
 * POST request for creating a complete note template with pre-existing sections
 * Endpoint: POST /api/note-templates/complete
 * Creates template and links existing sections in specified order
 * All sections must already exist in DB
 */
export const noteTemplatesCompleteCreateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  sections: z.array(
    z.object({
      id: z.number().int().positive('Section ID must be positive').optional(),
      name: z.string().min(1, 'Name is required for new sections').optional(),
      layout: z.enum(['paragraph', 'bullet points'], {
        errorMap: () => ({ message: 'Layout must be either "paragraph" or "bullet points"' }),
      }).optional(),
      details: z.string().optional(),
      encrypted_details: z.string().optional(),
      details_iv: z.string().optional(),
    }).refine(
      (data) => data.id !== undefined || (data.name !== undefined && data.name.trim() !== ''),
      { message: 'Either provide an id (to link existing section) or a name (to create new section)' }
    )
  ).min(1, 'At least one section is required'),
});

/**
 * PATCH request for updating a complete note template (atomic)
 * Endpoint: PATCH /api/note-templates/complete/:id
 * Updates template name, section details, and section ordering
 * Sections array order determines final section ordering
 * Entire operation is atomic: succeeds completely or not at all
 */
export const noteTemplatesCompleteUpdateRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').optional(),
  sections: z.array(
    z.object({
      id: z.number().int().positive('Section ID must be positive').optional(),
      name: z.string().min(1, 'Name is required for new sections').optional(),
      layout: z.enum(['paragraph', 'bullet points'], {
        errorMap: () => ({ message: 'Layout must be either "paragraph" or "bullet points"' }),
      }).optional(),
      details: z.string().optional(),
      encrypted_details: z.string().optional(),
      details_iv: z.string().optional(),
    }).refine(
      (data) => data.id !== undefined || (data.name !== undefined && data.name.trim() !== ''),
      { message: 'Either provide an id (to update existing section) or a name (to create new section)' }
    )
  ).optional(),
}).refine(
  (data) => data.name !== undefined || data.sections !== undefined,
  { message: 'At least one field (name or sections) must be provided' }
);

// ============================================================================
// Note Template Section Orders Schemas
// ============================================================================

/**
 * POST request for creating a note template section order
 * Endpoint: POST /api/note-template-section-orders
 * Creates a single section-to-template association with a specific order
 * Order must be the next consecutive value (e.g., if max is 3, order must be 4)
 */
export const noteTemplateSectionOrdersCreateRequestSchema = z.object({
  noteTemplate_id: z.number().int().positive('Template ID is required'),
  section_id: z.number().int().positive('Section ID is required'),
  order: z.number().int().min(1, 'Order must be at least 1'),
});

/**
 * PATCH request for batch reordering note template sections (atomic)
 * Endpoint: PATCH /api/note-template-section-orders
 * Replaces all section orders for a template. Orders must be consecutive starting from 1.
 * Any sections not in this list are deleted.
 * Entire operation is atomic: succeeds completely or not at all.
 */
export const noteTemplateSectionOrdersPatchRequestSchema = z.object({
  noteTemplate_id: z.number().int().positive('Template ID is required'),
  sections: z.array(
    z.object({
      id: z.number().int().positive('Section ID is required'),
      order: z.number().int().min(1, 'Order must be at least 1'),
    })
  ).min(1, 'At least one section is required'),
}).refine(
  (data) => {
    // Validate orders are consecutive starting from 1
    const orders = data.sections.map(s => s.order).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i + 1) {
        return false;
      }
    }
    return true;
  },
  {
    message: 'Orders must be consecutive starting from 1 (no gaps or duplicates)',
    path: ['sections'],
  }
);

// ============================================================================
// Notes Schemas
// ============================================================================

/**
 * PATCH request for updating a note
 * Endpoint: PATCH /api/notes/:id
 * Status is optional
 */
export const notesUpdateRequestSchema = z.object({
  status: z.enum(['draft', 'in-progress', 'completed', 'archived'], {
    message: 'Status must be one of: draft, in-progress, completed, archived',
  }).optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field (status) must be provided' }
);

// ============================================================================
// Authentication Schemas
// ============================================================================

/** Same fields as POST /user-profile body; reused for optional sign-up profile. */
const userProfileCreateBodySchema = z.object({
  username: z.string().min(1, 'Username is required'),
  specialty: z.string().min(1, 'Specialty is required'),
});

/**
 * POST request for auth sign-up action
 * Endpoint: POST /api/auth
 * Action: sign-up
 */
export const authSignUpRequestSchema = z.object({
  action: z.literal('sign-up'),
  email: z.string()
    .email('Invalid email format')
    .min(1, 'Email is required'),
  password: z.string()
    .min(8, 'Password must be at least 8 characters'),
  userProfile: userProfileCreateBodySchema.optional(),
});

/**
 * POST request for auth sign-in action
 * Endpoint: POST /api/auth
 * Action: sign-in
 */
export const authSignInRequestSchema = z.object({
  action: z.literal('sign-in'),
  email: z.string()
    .email('Invalid email format')
    .min(1, 'Email is required'),
  password: z.string()
    .min(1, 'Password is required'),
});

/**
 * POST request for auth sign-out action
 * Endpoint: POST /api/auth
 * Action: sign-out
 */
export const authSignOutRequestSchema = z.object({
  action: z.literal('sign-out'),
});

/**
 * POST request for auth check-validity action
 * Endpoint: POST /api/auth
 * Action: check-validity
 */
export const authCheckValidityRequestSchema = z.object({
  action: z.literal('check-validity'),
});

/**
 * POST request for auth resend action
 * Endpoint: POST /api/auth
 * Action: resend
 */
export const authResendRequestSchema = z.object({
  action: z.literal('resend'),
  email: z.string()
    .email('Invalid email format')
    .min(1, 'Email is required'),
  emailRedirectTo: z.string()
    .url('emailRedirectTo must be a valid URL')
    .optional(),
});

// ============================================================================
// Notes Schemas
// ============================================================================

/**
 * POST request for creating a note
 * Endpoint: POST /api/notes
 * text and patientEncounter_id are optional
 */
export const noteCreateRequestSchema = z.object({
  text: z.string().min(0).default(''),
  patientEncounter_id: z.number('Patient Encounter ID must be an integer').int('Patient Encounter ID must be an integer').nullable().optional(),
});

/**
 * PATCH request for updating a note
 * Endpoint: PATCH /api/notes/:id
 * text is optional
 */
export const noteUpdateRequestSchema = z.object({
  text: z.string().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field (text) must be provided' }
);

function createNotesListQuerySchema(defaultLimit) {
  return z.object({
    limit: z.coerce.number().int().positive().max(500).default(defaultLimit),
    offset: z.coerce.number().int().nonnegative().default(0),
    sortBy: z.enum(['created_at', 'updated_at', 'id']).default('created_at'),
    order: z.enum(['asc', 'desc']).default('desc'),
  });
}

/** GET /api/notes — lightweight list */
export const notesListQuerySchema = createNotesListQuerySchema(100);

/**
 * GET /api/notes/complete — same shape as GET /api/notes; default limit 50 (matches GET /api/patient-encounters).
 */
export const notesCompleteListQuerySchema = createNotesListQuerySchema(50);

// ============================================================================
// User profile (public."userProfiles")
// ============================================================================

/**
 * POST /api/user-profile
 * Create or replace profile for the authenticated user
 */
export const userProfileCreateRequestSchema = userProfileCreateBodySchema;

/**
 * PATCH /api/user-profile
 * Partial update; at least one field required
 */
export const userProfilePatchRequestSchema = z.object({
  username: z.string().min(1, 'Username is required').optional(),
  specialty: z.string().min(1, 'Specialty is required').optional(),
}).refine(
  (data) => data.username !== undefined || data.specialty !== undefined,
  { message: 'At least one of username or specialty must be provided' }
);
