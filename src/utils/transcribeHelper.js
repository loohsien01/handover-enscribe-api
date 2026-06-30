/**
 * Transcription Helper
 * 
 * Handles audio transcription via Deepgram (primary) or GCP Cloud Run (legacy)
 * Deepgram uses URL-based transcription with Nova-3 model
 * GCP Cloud Run is kept for legacy support only
 */

import { google } from 'googleapis';
import { authenticateRequest } from './authenticateRequest.js';

// Deepgram API Configuration
const DEEPGRAM_API_URL = 'https://api.deepgram.com/v1/listen';
const DEEPGRAM_MODEL = 'nova-3';
const DEEPGRAM_SMART_FORMAT = true;

// Audio format MIME type mapping
const AUDIO_MIME_TYPES = {
  'mp4': 'audio/mp4',
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'webm': 'audio/webm',
  'm4a': 'audio/aac',
  'ogg': 'audio/ogg',
  'flac': 'audio/flac',
  'aac': 'audio/aac',
  'wma': 'audio/x-ms-wma',
  'aiff': 'audio/aiff'
};

// Formats that Deepgram's remote URL fetch has issues with (415 errors)
// These formats should skip url_based and go straight to binary_upload
const PROBLEMATIC_FORMATS = ['mp4', 'm4a'];

// Legacy GCP Cloud Run Configuration
const CLOUD_RUN_URL =
  process.env.CLOUD_RUN_TRANSCRIBE_URL ||
  'https://emscribe-transcriber-641824253036.us-central1.run.app/transcribe';

/**
 * S3 presigned GetObject URLs are signed for GET only — HEAD returns 403.
 * Supabase object/sign URLs accept HEAD.
 *
 * @private
 * @param {string} url
 * @returns {boolean}
 */
function isS3PresignedGetObjectUrl(url) {
  return (
    /\.s3(\.[a-z0-9-]+)?\.amazonaws\.com\//i.test(url) &&
    /[?&]X-Amz-Signature=/i.test(url)
  );
}

/**
 * Validate a signed URL without downloading the full object.
 *
 * @private
 * @param {string} url - Signed URL to validate
 * @param {number} [timeoutMs=10000] - Timeout in milliseconds
 * @returns {Promise<boolean>} - True if URL is valid and accessible
 */
async function checkSignedUrlValid(url, timeoutMs = 10000) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    // S3 GetObject presign rejects HEAD; probe with a 1-byte ranged GET instead.
    const useRangedGet = isS3PresignedGetObjectUrl(url);
    const resp = await fetch(url, {
      method: useRangedGet ? 'GET' : 'HEAD',
      ...(useRangedGet ? { headers: { Range: 'bytes=0-0' } } : {}),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok || resp.status === 206;
  } catch (err) {
    return false;
  }
}

/**
 * Extract file extension from a signed URL
 * Handles URLs with query parameters (e.g., ?token=...)
 * 
 * @private
 * @param {string} url - Signed URL to extract extension from
 * @returns {string} - File extension in lowercase (e.g., 'mp4', 'wav')
 */
function extractFileExtension(url) {
  try {
    // Remove query parameters: https://...filename.ext?token=... → filename.ext
    const pathPart = url.split('?')[0];
    // Get last path segment: /path/to/filename.ext → filename.ext
    const filename = pathPart.split('/').pop();
    // Extract extension: filename.ext → ext
    const extension = filename.split('.').pop().toLowerCase();
    return extension;
  } catch (err) {
    console.warn('[extractFileExtension] Failed to extract extension:', err.message);
    return 'wav'; // Default fallback
  }
}

/**
 * Raw binary upload to Deepgram
 * 
 * Downloads audio file and sends it as raw binary data.
 * Used as fallback when URL-based method fails with 415 (Unsupported Media Type).
 * Sends audio with proper Content-Type header matching the audio format.
 * 
 * @private
 * @param {Object} options - Options object
 * @param {string} options.recording_file_signed_url - Signed URL to the recording file (required)
 * @param {number} [options.downloadTimeoutMs=300000] - Timeout for audio download
 * @returns {Promise<Object>} - Deepgram response with transcription data and method indicator
 * @throws {Error} - If download fails or Deepgram returns error
 */
async function transcribe_recording_binary_upload({ recording_file_signed_url, downloadTimeoutMs = 300000 } = {}) {
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  
  try {
    console.log('[transcribe_recording_binary_upload] 🔵 METHOD: binary_upload (raw binary with Content-Type header)');
    console.log('[transcribe_recording_binary_upload] Starting binary upload fallback for 415 error...');
    
    // 1) Download audio file from signed URL
    console.log('[transcribe_recording_binary_upload] Downloading audio file from signed URL...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), downloadTimeoutMs);
    
    const audioResp = await fetch(recording_file_signed_url, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    
    if (!audioResp.ok) {
      throw new Error(`Failed to download audio: HTTP ${audioResp.status} ${audioResp.statusText}`);
    }
    
    // Download audio into buffer
    const audioBuffer = await audioResp.arrayBuffer();
    console.log(`[transcribe_recording_binary_upload] Downloaded audio: ${audioBuffer.byteLength} bytes`);
    
    // 2) Detect audio format and get correct MIME type
    const fileExtension = extractFileExtension(recording_file_signed_url);
    const mimeType = AUDIO_MIME_TYPES[fileExtension] || 'audio/wav';
    console.log(`[transcribe_recording_binary_upload] Detected format: ${fileExtension}, MIME type: ${mimeType}`);
    
    // 3) Send audio as raw binary with correct Content-Type to Deepgram
    const deepgramUrl = new URL(DEEPGRAM_API_URL);
    deepgramUrl.searchParams.append('model', DEEPGRAM_MODEL);
    deepgramUrl.searchParams.append('smart_format', DEEPGRAM_SMART_FORMAT.toString());
    
    console.log('[transcribe_recording_binary_upload] Sending audio as raw binary to Deepgram...');
    const deepgramResp = await fetch(deepgramUrl.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType
      },
      body: audioBuffer,
      timeout: 300000, // 5 minutes
    });
    
    if (!deepgramResp.ok) {
      const errorBody = await deepgramResp.text();
      console.error('[transcribe_recording_binary_upload] Deepgram API error:', deepgramResp.status, errorBody);
      throw new Error(`Deepgram binary_upload failed: ${deepgramResp.status} ${deepgramResp.statusText}`);
    }
    
    const deepgramData = await deepgramResp.json();

    const alt0 = deepgramData?.results?.channels?.[0]?.alternatives?.[0];
    // Empty string is a valid Deepgram transcript (silence / no speech); do not use !transcript
    if (!alt0 || typeof alt0.transcript !== 'string') {
      throw new Error('Deepgram returned invalid response structure from binary_upload');
    }

    console.log('[transcribe_recording_binary_upload] ✓ Binary upload successful!');

    const transcript = alt0.transcript;
    return {
      transcript,
      deepgram_metadata: {
        model: DEEPGRAM_MODEL,
        duration: deepgramData.metadata?.duration,
        confidence: alt0.confidence,
        method: 'binary_upload', // Mark that binary_upload method was used
      },
    };
  } catch (error) {
    console.error('[transcribe_recording_binary_upload] Binary upload failed:', error.message);
    
    if (error.message?.includes('aborted') || error.code === 'ECONNABORTED') {
      throw new Error('Audio download timed out during binary_upload. Please try with a shorter audio file or check your network connection.');
    }
    
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Unable to connect to transcription service during binary_upload. Please try again later.');
    }
    
    throw error;
  }
}

/**
 * Transcribe a recording using Deepgram API with URL-based access
 * 
 * Sends the signed URL directly to Deepgram's /listen endpoint
 * which fetches and transcribes the audio file.
 * 
 * Falls back to streaming method if URL-based request returns 415 (Unsupported Media Type) error.
 * 
 * @param {Object} options - Options object
 * @param {string} options.recording_file_signed_url - Signed URL to the recording file (required)
 * @param {Object} [options.req] - Fastify request object for authentication
 * @param {number} [options.timeoutMs=10000] - Timeout for URL validation
 * @returns {Promise<Object>} - Deepgram response with transcription data
 * @throws {Error} - If URL is invalid, authentication fails, or Deepgram returns error
 */
async function transcribe_recording_deepgram({ recording_file_signed_url, req = null, timeoutMs = 10000 } = {}) {
  // Read Deepgram API key from environment (lazily, not at module load time)
  const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
  
  // Validate Deepgram API key
  if (!DEEPGRAM_API_KEY) {
    const err = new Error('DEEPGRAM_API_KEY environment variable is not configured');
    err.code = 'missing_api_key';
    err.status = 500;
    throw err;
  }

  if (!recording_file_signed_url || typeof recording_file_signed_url !== 'string') {
    throw new Error('recording_file_signed_url is required');
  }

  // If caller provided a request, verify the user is authenticated
  if (req) {
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user) {
      throw new Error('Authentication failed');
    }
  }

  // 0) Validate URL format (must start with http:// or https://)
  if (!recording_file_signed_url.startsWith('http://') && !recording_file_signed_url.startsWith('https://')) {
    const err = new Error(`Invalid or expired recording_file_signed_url: ${recording_file_signed_url}`);
    err.code = 'invalid_url_format';
    err.status = 400; // Client error - malformed URL
    throw err;
  }

  // 1) Verify signed URL is still valid (HEAD request, no download)
  const isValid = await checkSignedUrlValid(recording_file_signed_url, timeoutMs);
  if (!isValid) {
    const err = new Error(`Invalid or expired recording_file_signed_url: ${recording_file_signed_url}`);
    err.code = 'expired_signed_url';
    err.status = 400; // Client error - invalid/expired URL
    throw err;
  }
  console.log('[transcribe_recording_deepgram] Signed URL is valid');

  // 2) Check if format is known to have issues with URL-based method
  const fileExtension = extractFileExtension(recording_file_signed_url);
  console.log(`[transcribe_recording_deepgram] Detected file extension: ${fileExtension}`);
  
  if (PROBLEMATIC_FORMATS.includes(fileExtension)) {
    console.log(`[transcribe_recording_deepgram] 🟠 SWITCHING METHOD: Format '${fileExtension}' known to cause 415 errors with url_based. Using binary_upload directly...`);
    try {
      return await transcribe_recording_binary_upload({ recording_file_signed_url });
    } catch (formError) {
      console.error('[transcribe_recording_deepgram] Binary upload failed:', formError.message);
      const err = new Error(`Binary upload for ${fileExtension} format failed: ${formError.message}`);
      err.code = 'transcription_binary_upload_failed';
      err.status = 503;
      throw err;
    }
  }

  // 3) Build Deepgram API request with URL
  const deepgramUrl = new URL(DEEPGRAM_API_URL);
  deepgramUrl.searchParams.append('model', DEEPGRAM_MODEL);
  deepgramUrl.searchParams.append('smart_format', DEEPGRAM_SMART_FORMAT.toString());

  const requestBody = {
    url: recording_file_signed_url
  };

  try {
    console.log('[transcribe_recording_deepgram] 🟢 METHOD: url_based (sending signed URL to Deepgram)');
    const deepgramResp = await fetch(deepgramUrl.toString(), {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      timeout: 300000, // 5 minutes
    });

    if (!deepgramResp.ok) {
      const errorBody = await deepgramResp.text();
      console.error('[transcribe_recording_deepgram] Deepgram API error:', deepgramResp.status, errorBody);
      
      // On 415 (Unsupported Media Type), fallback to explicit binary_upload
      if (deepgramResp.status === 415) {
        console.log('[transcribe_recording_deepgram] 🟠 FALLBACK: Got 415 error on url_based method - attempting binary_upload fallback...');
        try {
          return await transcribe_recording_binary_upload({ recording_file_signed_url });
        } catch (formError) {
          console.error('[transcribe_recording_deepgram] Binary upload fallback also failed:', formError.message);
          const err = new Error(`Both transcription methods failed:\n1. url_based: 415 Unsupported Media Type\n2. binary_upload: ${formError.message}`);
          err.code = 'transcription_all_methods_failed';
          err.status = 503;
          throw err;
        }
      }
      
      const err = new Error(`Deepgram API error: ${deepgramResp.status} ${deepgramResp.statusText}`);
      err.code = 'deepgram_api_error';
      err.status = deepgramResp.status >= 500 ? 503 : 400;
      throw err;
    }

    const deepgramData = await deepgramResp.json();

    const alt0 = deepgramData?.results?.channels?.[0]?.alternatives?.[0];
    // Empty string is a valid Deepgram transcript (silence / no speech); do not use !transcript
    if (!alt0 || typeof alt0.transcript !== 'string') {
      throw new Error('Deepgram returned invalid response structure');
    }

    console.log('[transcribe_recording_deepgram] ✓ Deepgram response received successfully with url_based method');

    // Extract transcript and normalize response format to match legacy Cloud Run format
    const transcript = alt0.transcript;

    return {
      transcript,
      // Include additional metadata for potential future use
      deepgram_metadata: {
        model: DEEPGRAM_MODEL,
        duration: deepgramData.metadata?.duration,
        confidence: alt0.confidence,
        method: 'url_based', // Mark that primary url_based method was used
      },
    };
  } catch (error) {
    console.error('[transcribe_recording_deepgram] URL method failed:', error.message);

    // Only throw if error code is already set (from earlier throw statements)
    if (error.code) {
      throw error;
    }

    if (error.message?.includes('aborted') || error.code === 'ECONNABORTED') {
      throw new Error('Transcription request timed out. Please try with a shorter audio file or check your network connection.');
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Unable to connect to transcription service. Please try again later.');
    }

    throw new Error(`Transcription service error: ${error.message}`);
  }
}

/**
 * Main transcription function - routes to Deepgram by default
 * 
 * @param {Object} options - Options object
 * @param {string} options.recording_file_signed_url - Signed URL to the recording file (required)
 * @param {Object} [options.req] - Fastify request object for authentication
 * @param {number} [options.timeoutMs=10000] - Timeout for URL validation
 * @returns {Promise<Object>} - Transcription response with transcript text
 * @throws {Error} - If transcription fails
 */
export async function transcribe_recording({ recording_file_signed_url, req = null, timeoutMs = 10000 } = {}) {
  return transcribe_recording_deepgram({ recording_file_signed_url, req, timeoutMs });
}

/**
 * DEPRECATED: Legacy GCP Cloud Run transcription
 * 
 * Kept for backwards compatibility only. New implementations should use transcribe_recording()
 * which routes to Deepgram.
 * 
 * Validates the signed URL, authenticates with GCP service account,
 * and sends the recording URL to Cloud Run for transcription.
 * 
 * @param {Object} options - Options object
 * @param {string} options.recording_file_signed_url - Signed URL to the recording file (required)
 * @param {Object} [options.req] - Fastify request object for authentication
 * @param {number} [options.timeoutMs=10000] - Timeout for signed URL validation
 * @returns {Promise<Object>} - Cloud Run response containing transcription data
 * @throws {Error} - If URL is invalid, authentication fails, or Cloud Run returns error
 */
export async function transcribe_recording_gcp({ recording_file_signed_url, req = null, timeoutMs = 10000 } = {}) {
  if (!recording_file_signed_url || typeof recording_file_signed_url !== 'string') {
    throw new Error('recording_file_signed_url is required');
  }

  // If caller provided a request, verify the user is authenticated
  if (req) {
    const { user, error: authError } = await authenticateRequest(req);
    if (authError || !user) {
      throw new Error('Authentication failed');
    }
  }

  // 0) Validate URL format (must start with http:// or https://)
  if (!recording_file_signed_url.startsWith('http://') && !recording_file_signed_url.startsWith('https://')) {
    const err = new Error(`Invalid or expired recording_file_signed_url: ${recording_file_signed_url}`);
    err.code = 'invalid_url_format';
    err.status = 400; // Client error - malformed URL
    throw err;
  }

  // 1) Verify signed URL is still valid (HEAD request, no download)
  const isValid = await checkSignedUrlValid(recording_file_signed_url, timeoutMs);
  if (!isValid) {
    const err = new Error(`Invalid or expired recording_file_signed_url: ${recording_file_signed_url}`);
    err.code = 'expired_signed_url';
    err.status = 400; // Client error - invalid/expired URL
    throw err;
  }
  console.log('[transcribe_recording_gcp] Signed URL is valid');

  // 2) Obtain ID token using service account credentials and call Cloud Run
  const auth = new google.auth.GoogleAuth({
    credentials: process.env.GCP_SERVICE_ACCOUNT_KEY
      ? JSON.parse(process.env.GCP_SERVICE_ACCOUNT_KEY)
      : undefined,
    // DO NOT set scopes when you will call getIdTokenClient(audience)
  });
  const idClient = await auth.getIdTokenClient(CLOUD_RUN_URL);

  try {
    console.log('[transcribe_recording_gcp] Making request to Cloud Run...');
    const cloudRunResp = await idClient.request({
      url: CLOUD_RUN_URL,
      method: 'POST',
      data: { recording_file_signed_url },
      headers: { 'Content-Type': 'application/json' },
      timeout: 300000, // 5 minutes
    });

    if (!cloudRunResp?.data) {
      throw new Error('Cloud Run returned empty response body');
    }

    console.log('[transcribe_recording_gcp] Cloud Run response received successfully');
    return cloudRunResp.data;
  } catch (error) {
    console.error('[transcribe_recording_gcp] Cloud Run request failed:', error.message);

    if (error.message?.includes('aborted') || error.code === 'ECONNABORTED') {
      throw new Error('Transcription request timed out. Please try with a shorter audio file or check your network connection.');
    }

    if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Unable to connect to transcription service. Please try again later.');
    }

    throw new Error(`Cloud Run service error: ${error.message}`);
  }
}
