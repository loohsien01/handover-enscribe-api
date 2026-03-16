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
import { unmask_phi } from '../../utils/maskPhiHelper.js';
import { transcribe_expand_mask } from '../controllers/transcribeController.js';
import parseSoapNotes from '../../utils/parseSoapNotes.js';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

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
 * Helper: Claude via AWS Bedrock API request
 */
async function claudeAPIReq(reqBody) {
  const accessKeyId = process.env.AWS_ACTIONS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_ACTIONS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION || 'us-east-1';
  
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Missing AWS credentials. Configure AWS_ACTIONS_ACCESS_KEY_ID and AWS_ACTIONS_SECRET_ACCESS_KEY to use Claude Bedrock.');
  }

  const client = new BedrockRuntimeClient({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

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
 */
export async function promptLlmProcessor(jobId, userId, authorizationHeader) {
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

    // Transcribe, expand, and mask
    let transcriptResult;
    const transcribeStartTime = Date.now();
    try {
      // Use the authorization header from job creation for authenticated access
      const internalRequest = {
        headers: {
          authorization: authorizationHeader,
        },
      };
      transcriptResult = await transcribe_expand_mask({
        recording_file_signed_url: signedUrlData.signedUrl,
        req: internalRequest,
      });
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

    try {
      soapNoteAndBillingReqBody = claudeRequestBody.getSoapNoteAndBillingRequestBody(maskedTranscript);
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

    // Clean and unmask
    rawString = cleanRawText(rawString);
    let unmaskRes;
    try {
      unmaskRes = unmask_phi(rawString, tokens);
    } catch (error) {
      throw new Error(`PHI unmasking failed: ${error.message}`);
    }

    const unmaskedString = (unmaskRes && typeof unmaskRes === 'object' && unmaskRes.unmasked_transcript)
      ? unmaskRes.unmasked_transcript
      : String(unmaskRes || rawString);

    // Parse JSON
    let soapNoteAndBillingResult;
    try {
      soapNoteAndBillingResult = JSON.parse(unmaskedString);
    } catch (error) {
      throw new Error(`Failed to parse SOAP note JSON: ${error.message}`);
    }

    // Normalize field names to lowercase (soap_note, subjective, objective, assessment, plan)
    if (soapNoteAndBillingResult && typeof soapNoteAndBillingResult === 'object') {
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
