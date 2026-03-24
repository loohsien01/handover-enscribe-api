/**
 * Prompt LLM Processor
 * 
 * Async worker for SOAP note generation pipeline
 * - Transcription (GCP Cloud Run)
 * - PHI masking (AWS Comprehend Medical)
 * - SOAP note generation (OpenAI/Azure OpenAI)
 * - PHI unmasking
 * 
 * Called by jobController, runs in background
 * Updates job status in database at each step
 */

import { supabaseAdmin } from '../../utils/supabaseAdmin.js';
import { getSupabaseClient } from '../../utils/supabase.js';
import * as claudeRequestBody from '../../utils/claudeRequestBody.js';
import { transcribe_expand_mask } from '../controllers/transcribeController.js';
import parseSoapNotes from '../../utils/parseSoapNotes.js';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { getSystemMasterKey, getOrCreateUserMasterKey } from '../controllers/userSecurityConfigController.js';
import { decryptNoteTemplateSectionDetails } from '../../utils/encryptionUtils.js';
import { getCompleteTemplate } from '../controllers/noteTemplatesCompleteController.js';

/**
 * Helper: Clean raw text from LLMs to normalize problematic characters for EHR systems
 */
function cleanRawText(s) {
  if (!s || typeof s !== 'string') return s;
  s = s.replace(/\u2022|\u2023|\u25E6|\u2043/g, '-');
  s = s.replace(/[\u2026\u22EF\u22EE]/g, '...');
  s = s.replace(/\u00A0/g, ' ');
  s = s.replace(/–/g, '-');
  s = s.replace(/—/g, '-');
  s = s.replace(/≤/g, '<=');
  s = s.replace(/≥/g, '>=');
  s = s.replace(/×/g, 'x');
  s = s.replace(/±/g, '+/-');
  s = s.replace(/½/g, '1/2');
  s = s.replace(/⅓/g, '1/3');
  s = s.replace(/⅔/g, '2/3');
  s = s.replace(/¼/g, '1/4');
  s = s.replace(/¾/g, '3/4');
  s = s.replace(/⅕/g, '1/5');
  s = s.replace(/⅖/g, '2/5');
  s = s.replace(/⅗/g, '3/5');
  s = s.replace(/⅘/g, '4/5');
  s = s.replace(/⅙/g, '1/6');
  s = s.replace(/⅚/g, '5/6');
  s = s.replace(/⁰/g, '^0');
  s = s.replace(/¹/g, '^1');
  s = s.replace(/²/g, '^2');
  s = s.replace(/³/g, '^3');
  s = s.replace(/⁴/g, '^4');
  s = s.replace(/⁵/g, '^5');
  s = s.replace(/⁶/g, '^6');
  s = s.replace(/⁷/g, '^7');
  s = s.replace(/⁸/g, '^8');
  s = s.replace(/⁹/g, '^9');
  s = s.replace(/→/g, '->');
  s = s.replace(/←/g, '<-');
  s = s.replace(/↑/g, 'increase');
  s = s.replace(/↓/g, 'decrease');
  s = s.replace(/~/g, 'approximately');
  s = s.replace(/≈/g, '~');
  s = s.replace(/∞/g, 'infinity');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/-{2,}/g, '-');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

/**
 * Helper: Update job status in database
 */
async function updateJobStatus(jobId, status, updates = {}) {
  const supabase = supabaseAdmin();
  const { error } = await supabase
    .from('jobs')
    .update({
      status,
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) {
    console.error(`[updateJobStatus] Failed to update job ${jobId}:`, error);
  }
}

/**
 * Helper: Recursively unmask PHI tokens in a JSON object
 * Searches all string values for {{TYPE_ID}} tokens and replaces them with original text
 * 
 * @param {*} obj - Any value (object, array, string, etc.)
 * @param {Object} tokens - Token dictionary mapping "TYPE_ID" to original text
 * @returns {*} - Same structure with PHI tokens replaced
 */
function unmaskedPhiInObject(obj, tokens) {
  if (typeof obj === 'string') {
    // Replace all {{TYPE_ID}} tokens in string
    return obj.replace(/\{\{([^}]+)\}\}/g, (match, tokenKey) => {
      const replacement = tokens[tokenKey];
      if (!replacement) {
        console.warn(`[unmaskedPhiInObject] Token not found: ${tokenKey}`);
        return match; // Keep token if not found
      }
      return replacement;
    });
  } else if (Array.isArray(obj)) {
    // Recursively unmask each element in array
    return obj.map(item => unmaskedPhiInObject(item, tokens));
  } else if (obj !== null && typeof obj === 'object') {
    // Recursively unmask each value in object
    const unmasked = {};
    for (const [key, value] of Object.entries(obj)) {
      unmasked[key] = unmaskedPhiInObject(value, tokens);
    }
    return unmasked;
  }
  // Return primitives (numbers, booleans, null) as-is
  return obj;
}

/**
 * Helper: Convert template sections to schema format
 * Converts from { name, layout, details, ... } to { name, layout, details }
 * Filters out encrypted fields and keeps only what's needed for prompt
 */
function convertTemplateSectionsToSchema(sections) {
  if (!sections || !Array.isArray(sections)) return null;
  return sections.map(s => ({
    name: s.name,
    layout: s.layout,
    details: s.details || '',
  }));
}



/**
 * Helper: Claude via AWS Bedrock API request
 * 
 * Supports two authentication modes:
 * 1. Production (EC2): Uses IAM role attached to instance (no env vars needed)
 * 2. Development (local): Requires AWS_ACTIONS_ACCESS_KEY_ID and AWS_ACTIONS_SECRET_ACCESS_KEY from .env
 */
async function claudeAPIReq(reqBody) {
  const isDev = process.env.NODE_ENV !== 'production';
  const region = process.env.AWS_REGION || 'us-east-1';
  const clientConfig = { region };
  
  if (isDev) {
    // Development: Require explicit AWS Bedrock credentials from env vars
    const accessKeyId = process.env.AWS_ACTIONS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_ACTIONS_SECRET_ACCESS_KEY;
    
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        '[Development Mode] Missing AWS Bedrock credentials. Configure AWS_ACTIONS_ACCESS_KEY_ID and AWS_ACTIONS_SECRET_ACCESS_KEY in .env to use Claude Bedrock locally.'
      );
    }
    
    clientConfig.credentials = {
      accessKeyId,
      secretAccessKey,
    };
    
    console.log('[claudeAPIReq] Development mode: Using explicit AWS Bedrock credentials from env vars');
  } else {
    // Production: SDK will auto-detect IAM role from EC2 instance
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

/**
 * Main async processor for SOAP note generation
 * 
 * @param {string} jobId - Job UUID
 * @param {string} userId - User UUID
 * @param {string} authorizationHeader - User's JWT token from initial request (e.g., 'Bearer ...')
 * @param {BigInt|string|null} noteTemplate_id - Optional note template ID to customize SOAP note schema
 */
export async function promptLlmProcessor(jobId, userId, authorizationHeader, noteTemplate_id = null) {
  const startTime = Date.now();
  console.log(`[promptLlmProcessor] Starting job ${jobId} for user ${userId}`);

  try {
    // Get job record to retrieve recording path
    const supabase = supabaseAdmin();
    const { data: job, error: getError } = await supabase
      .from('jobs')
      .select('recording_file_path')
      .eq('id', jobId)
      .single();

    if (getError || !job) {
      throw new Error(`Failed to retrieve job: ${getError?.message}`);
    }

    const { recording_file_path } = job;

    // Step 1: Update status to transcribing
    await updateJobStatus(jobId, 'transcribing');
    console.log(`[promptLlmProcessor] ${jobId}: Started transcription`);

    // Get signed URL for recording (use service key client for internal operations)
    const { data: signedUrlData, error: signedError } = await supabase.storage
      .from('audio-files')
      .createSignedUrl(recording_file_path, 60 * 60);

    if (signedError) {
      throw new Error(`Failed to create signed URL: ${signedError.message}`);
    }

    // Parallel execution: Transcribe AND fetch note template simultaneously
    let transcriptResult;
    let templateResult = null;
    const transcribeStartTime = Date.now();

    try {
      const internalRequest = {
        headers: {
          authorization: authorizationHeader,
        },
      };

      // Run both in parallel
      const [transcriptRes, templateRes] = await Promise.all([
        // Transcription
        transcribe_expand_mask({
          recording_file_signed_url: signedUrlData.signedUrl,
          req: internalRequest,
        }),
        // Template fetch (if needed)
        noteTemplate_id
          ? getCompleteTemplate(supabase, BigInt(noteTemplate_id), userId).catch(err => {
              console.warn(`[promptLlmProcessor] ${jobId}: Template fetch error: ${err.message}`);
              return null;
            })
          : Promise.resolve(null),
      ]);

      transcriptResult = transcriptRes;
      templateResult = templateRes;
    } catch (error) {
      throw new Error(`Transcription failed: ${error?.message || 'Unknown error'}`);
    }

    // Validate transcription result
    if (
      !transcriptResult ||
      !transcriptResult.cloudRunData?.transcript ||
      !transcriptResult.maskResult?.masked_transcript ||
      !transcriptResult.maskResult?.phi_entities
    ) {
      throw new Error('Transcription result missing expected properties');
    }

    const transcript = transcriptResult.expandedTranscript;
    const maskedTranscript = transcriptResult.maskResult.masked_transcript;
    const tokens = transcriptResult.maskResult.tokens;
    const transcribeEndTime = Date.now();

    console.log(`[promptLlmProcessor] ${jobId}: Transcription complete (${(transcribeEndTime - transcribeStartTime) / 1000}s)`);

    // Step 2: Update status to generating with transcript
    await updateJobStatus(jobId, 'generating', {
      transcript_text: transcript,
    });

    // Step 3: Generate SOAP note and billing suggestion
    const soapStartTime = Date.now();
    let soapNoteAndBillingReqBody;
    let soapNoteAndBillingResultRaw;
    let noteTemplateSections = null;

    // Convert note template sections if fetch was successful
    if (templateResult && templateResult.success && templateResult.sections && templateResult.sections.length > 0) {
      noteTemplateSections = convertTemplateSectionsToSchema(templateResult.sections);
      
      // Log the converted template for debugging
      console.log(`[promptLlmProcessor] ${jobId}: Using note template ${noteTemplate_id} with ${noteTemplateSections.length} sections:`);
      noteTemplateSections.forEach((section, index) => {
        const content = `${section.layout} - ${section.details}`;
        console.log(`  [${index + 1}] ${section.name}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`);
      });
    } else if (noteTemplate_id && templateResult) {
      console.warn(`[promptLlmProcessor] ${jobId}: Failed to fetch note template ${noteTemplate_id}: ${templateResult.error}. Using fallback schema`);
    }

    try {
      soapNoteAndBillingReqBody = claudeRequestBody.getSoapNoteAndBillingRequestBody(maskedTranscript, noteTemplateSections);
      
      // Log the final schema being sent to Claude (crucial for debugging LLM prompt)
      console.log(`[promptLlmProcessor] ${jobId}: Final JSON schema for Claude:`);
      soapNoteAndBillingReqBody.system.forEach(sys => {
        if (sys.text && sys.text.includes('MUST return')) {
          const schemaText = sys.text.substring(0, 500);
          console.log(schemaText + (sys.text.length > 500 ? '\n... [truncated for logs]' : ''));
        }
      });
      
      soapNoteAndBillingResultRaw = await claudeAPIReq(soapNoteAndBillingReqBody);
    } catch (error) {
      throw new Error(`Claude API request failed: ${error.message}`);
    }

    if (!soapNoteAndBillingResultRaw) {
      throw new Error('Empty response from Claude API');
    }

    console.log(`[promptLlmProcessor] ${jobId}: Claude response received`);

    // Parse LLM response
    let rawString;
    if (typeof soapNoteAndBillingResultRaw === 'string') {
      rawString = soapNoteAndBillingResultRaw;
    } else {
      rawString = JSON.stringify(soapNoteAndBillingResultRaw);
    }

    // Strip markdown code block if present (Claude wraps in ```json ... ```)
    if (rawString.includes('```json')) {
      rawString = rawString.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      console.log(`[promptLlmProcessor] ${jobId}: Stripped markdown wrapper`);
    }

    // console.log(`[promptLlmProcessor] ${jobId}: Parsed response length: ${rawString.length}`);

    // Validate format - just check it's valid JSON
    const trimmed = rawString.trim();
    const looksLikeJson = trimmed.startsWith('{') && trimmed.endsWith('}');
    if (!looksLikeJson) {
      console.error(`[promptLlmProcessor] ${jobId}: Invalid response, first 500 chars:`, rawString.substring(0, 500));
      throw new Error('LLM response does not appear to be valid JSON structure');
    }

    // Clean: normalize special characters from LLM output
    rawString = cleanRawText(rawString);

    // Parse JSON first (validates syntax, handles special chars naturally)
    let soapNoteAndBillingResult;
    try {
      soapNoteAndBillingResult = JSON.parse(rawString);
    } catch (error) {
      // Extract position from error message (e.g., "position 6484")
      const positionMatch = error.message.match(/position (\d+)/);
      const errorPos = positionMatch ? parseInt(positionMatch[1], 10) : null;
      
      // Build detailed error message for logs
      let debugInfo = `Failed to parse SOAP note JSON: ${error.message}\n`;
      debugInfo += `Total length: ${rawString.length} characters\n`;
      debugInfo += `First 100 chars:\n${rawString.substring(0, 100)}...\n\n`;
      
      if (errorPos) {
        const startContext = Math.max(0, errorPos - 150);
        const endContext = Math.min(rawString.length, errorPos + 150);
        debugInfo += `Context around position ${errorPos} (300 chars):\n`;
        debugInfo += `[${startContext}] ${rawString.substring(startContext, endContext)} [${endContext}]\n`;
        debugInfo += `${'='.repeat(Math.min(150, errorPos - startContext))}↑ ERROR HERE\n`;
      }
      
      // Log full debugging info with stack trace
      console.error(`[promptLlmProcessor] ${jobId}: JSON Parse Error:\n${debugInfo}`);
      console.error(`[promptLlmProcessor] ${jobId}: Stack trace:`, error.stack);
      
      // Throw clean error message (without debug context) so it can be stored safely in DB
      throw new Error(`Failed to parse SOAP note JSON: ${error.message}`);
    }

    // Unmask PHI tokens in the parsed object (no escaping needed)
    soapNoteAndBillingResult = unmaskedPhiInObject(soapNoteAndBillingResult, tokens);

    // Normalize field names to lowercase (soap_note, subjective, objective, assessment, plan)
    if (soapNoteAndBillingResult && typeof soapNoteAndBillingResult === 'object' && !Array.isArray(soapNoteAndBillingResult)) {
      // Find and normalize soap_note key (case-insensitive)
      const soapNoteKey = Object.keys(soapNoteAndBillingResult).find(
        key => key.toLowerCase() === 'soap_note'
      );
      
      if (soapNoteKey && soapNoteKey !== 'soap_note') {
        soapNoteAndBillingResult.soap_note = soapNoteAndBillingResult[soapNoteKey];
        delete soapNoteAndBillingResult[soapNoteKey];
      }
      
      // Normalize inner keys in soap_note (subjective, objective, assessment, plan)
      if (soapNoteAndBillingResult.soap_note && typeof soapNoteAndBillingResult.soap_note === 'object') {
        const innerObj = soapNoteAndBillingResult.soap_note;
        const keysToNormalize = ['subjective', 'objective', 'assessment', 'plan'];
        
        keysToNormalize.forEach(normalKey => {
          const foundKey = Object.keys(innerObj).find(
            key => key.toLowerCase() === normalKey
          );
          if (foundKey && foundKey !== normalKey) {
            innerObj[normalKey] = innerObj[foundKey];
            delete innerObj[foundKey];
          }
        });
      }
    }

    // Store raw SOAP note string (parsing will be done on demand via parseSoapNotes utility)
    const soapNoteText = JSON.stringify(soapNoteAndBillingResult);

    const soapEndTime = Date.now();
    console.log(`[promptLlmProcessor] ${jobId}: SOAP note complete (${(soapEndTime - soapStartTime) / 1000}s)`);

    // Step 4: Update to complete status
    await updateJobStatus(jobId, 'complete', {
      soap_note_text: soapNoteText,
    });

    console.log(`[promptLlmProcessor] ${jobId}: Complete (${(soapEndTime - startTime) / 1000}s total)`);
  } catch (error) {
    console.error(`[promptLlmProcessor] ${jobId}: Error:`, error);
    await updateJobStatus(jobId, 'error', {
      error_message: error.message,
    });
  }
}
