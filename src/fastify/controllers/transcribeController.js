/**
 * Deepgram Transcription Controller
 * 
 * Fastify handlers for the complete transcription pipeline:
 * - Audio transcription via Deepgram (Nova-3 model)
 * - Dot phrase expansion (Aho-Corasick algorithm)
 * - PHI masking (AWS integration)
 */

import { transcribe_recording } from '../../utils/transcribeHelper.js';
import { mask_phi } from '../../utils/maskPhiHelper.js';
import { authenticateRequest } from '../../utils/authenticateRequest.js';
import { getAllDotPhrasesForUser } from './dotPhrasesController.js';
import { expandDotPhrases } from './transcriptsController.js';
import { getSupabaseClient } from '../../utils/supabase.js';

/**
 * Enhanced transcription pipeline: transcribe, expand dot phrases, then mask PHI.
 * Runs transcription and dot phrase fetching in parallel for better performance.
 * 
 * @param {object} opts
 * @param {string} opts.recording_file_signed_url - signed url to recording
 * @param {Object} opts.req - Fastify request object for authentication
 * @param {boolean} [opts.enableDotPhraseExpansion=true] - whether to perform dot phrase expansion
 * @returns {Promise<{ cloudRunData: any, dotPhrasesData: any, expandedTranscript: string, maskResult: any }>}
 */
export async function transcribe_expand_mask({ 
  recording_file_signed_url, 
  req,
  enableDotPhraseExpansion = true 
} = {}) {
  if (!recording_file_signed_url || typeof recording_file_signed_url !== 'string') {
    const e = new Error('recording_file_signed_url is required');
    e.status = 400;
    throw e;
  }

  // Require req parameter
  if (!req) {
    const e = new Error('req is required');
    e.status = 400;
    throw e;
  }

  // Authenticate user
  const { user, error: authError } = await authenticateRequest(req);
  if (authError || !user) {
    const e = new Error('Authentication failed');
    e.status = 401;
    throw e;
  }

  console.log('Step 1: Starting parallel transcription and dot phrase fetching');
  
  // 1) Run transcription and dot phrase fetching in parallel
  const [transcriptionResult, dotPhrasesResult] = await Promise.allSettled([
    transcribe_recording({ recording_file_signed_url, user }),
    enableDotPhraseExpansion ? getAllDotPhrasesForUser(user.id, getSupabaseClient(req.headers.authorization)) : Promise.resolve({ success: true, data: [], error: null })
  ]);

  // 2) Handle transcription result
  let cloudRunData;
  if (transcriptionResult.status === 'rejected') {
    const err = transcriptionResult.reason;
    console.error('transcribe_recording error:', err?.message || err);
    console.error(err?.stack || err);

    const e = new Error(err?.message || 'Transcription failed');
    if (err?.status) e.status = err.status;
    e.cause = err;
    if (err?.stack) {
      e.stack = `${e.stack}\nCaused by: ${err.stack}`;
    }
    throw e;
  }
  cloudRunData = transcriptionResult.value;

  // 3) Extract transcript text
  const originalTranscript = cloudRunData?.transcript || null;
  if (!originalTranscript || typeof originalTranscript !== 'string') {
    const e = new Error('Transcription returned no transcript text');
    e.status = 500;
    e.cloudRunData = cloudRunData;
    throw e;
  }

  console.log('Step 2: Transcription completed, processing dot phrases');

  // 4) Handle dot phrases result
  let dotPhrasesData = [];
  let expandedTranscript = originalTranscript; // Clean version for user
  let llmNotatedText = originalTranscript; // Notated version for LLM/masking

  if (enableDotPhraseExpansion) {
    if (dotPhrasesResult.status === 'rejected') {
      console.warn('Warning: Failed to fetch dot phrases, skipping expansion:', dotPhrasesResult.reason?.message || dotPhrasesResult.reason);
      dotPhrasesData = [];
    } else {
      const dotPhrasesResponse = dotPhrasesResult.value;
      if (dotPhrasesResponse.success) {
        dotPhrasesData = dotPhrasesResponse.data;
        console.log(`Step 3: Expanding dot phrases (${dotPhrasesData.length} available)`);
        const expansionResult = expandDotPhrases(originalTranscript, dotPhrasesData);
        expandedTranscript = expansionResult.expanded;
        llmNotatedText = expansionResult.llm_notated;
      } else {
        console.warn('Warning: Dot phrases fetch returned error, skipping expansion:', dotPhrasesResponse.error);
        dotPhrasesData = [];
      }
    }
  } else {
    console.log('Step 3: Dot phrase expansion disabled, skipping');
  }

  console.log('Step 4: Masking PHI');

  // 5) Mask PHI on the LLM-notated text (with dot phrase emphasis)
  let maskResult;
  try {
    maskResult = await mask_phi(llmNotatedText);
  } catch (err) {
    // Log full error + stack before wrapping/propagating
    console.error('mask_phi error:', err?.message || err);
    console.error(err?.stack || err);

    // preserve original error as cause and include original stack
    const e = new Error(err?.message || 'Masking PHI failed');
    if (err?.status) e.status = err.status;
    e.cause = err;
    if (err?.stack) {
      e.stack = `${e.stack}\nCaused by: ${err.stack}`;
    }
    throw e;
  }

  // If maskResult is a fetch Response-like object, try to read .ok/.json
  if (maskResult && typeof maskResult === 'object' && 'ok' in maskResult && typeof maskResult.ok === 'boolean') {
    if (!maskResult.ok) {
      const e = new Error('Mask PHI endpoint returned failure');
      e.status = 500;
      e.details = maskResult;
      throw e;
    }
    // attempt to normalize to JSON body if available
    if (typeof maskResult.json === 'function') {
      const body = await maskResult.json();
      return { cloudRunData, dotPhrasesData, expandedTranscript, maskResult: body };
    }
  }

  // Return structured result for callers
  return { cloudRunData, dotPhrasesData, expandedTranscript, maskResult };
}

/**
 * Alternative version for internal use (without authentication requirement)
 * @param {string} recording_file_signed_url - Recording URL
 * @returns {Promise<Object>} - Same as transcribe_expand_mask
 */
export async function transcribe_and_mask(recording_file_signed_url) {
  if (!recording_file_signed_url || typeof recording_file_signed_url !== 'string') {
    throw new Error('recording_file_signed_url is required');
  }

  // This version does not require a request object
  const cloudRunData = await transcribe_recording({ recording_file_signed_url });
  const maskResult = await mask_phi(cloudRunData?.transcript || '');

  return { cloudRunData, maskResult };
}

/**
 * Fastify route handler for POST /api/deepgram/transcribe/complete
 * 
 * Handles complete transcription pipeline via Deepgram:
 * 1. Transcribes audio using Deepgram API (Nova-3 model)
 * 2. Expands dot phrases for user
 * 3. Masks PHI (Protected Health Information)
 * 
 * @param {Object} request - Fastify request object
 * @param {Object} reply - Fastify reply object
 */
export async function handler(request, reply) {
  const startTime = Date.now();
  try {
    const { recording_file_signed_url, enableDotPhraseExpansion = true } = request.body || {};
    
    console.log(`[transcribeController.handler] Starting transcription for: ${recording_file_signed_url?.substring(0, 200)}...`);
    console.log(`[transcribeController.handler] User: ${request.user?.id}`);
    
    // Use the transcribe_expand_mask function - it will handle authentication internally
    const result = await transcribe_expand_mask({ 
      recording_file_signed_url, 
      req: request,
      enableDotPhraseExpansion
    });
    
    const elapsed = Date.now() - startTime;
    console.log(`[transcribeController.handler] ✓ Completed in ${elapsed}ms`);
    
    return reply.status(200).send({ 
      ok: true, 
      ...result 
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[transcribeController.handler] ✗ Error after ${elapsed}ms:`, err.message);
    console.error(`[transcribeController.handler] Error stack:`, err.stack);
    
    const status = err?.status || 500;
    const payload = { error: err?.message || String(err) };
    if (err?.cloudRunData) payload.cloudRunData = err.cloudRunData;
    if (err?.details) payload.details = err.details;
    
    return reply.status(status).send(payload);
  }
}