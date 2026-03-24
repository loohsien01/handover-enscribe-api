/**
 * AWS Comprehend Medical PHI Masking Helper
 * 
 * Provides reusable functions for masking and unmasking Protected Health Information (PHI)
 * in medical transcripts using AWS Comprehend Medical API.
 */

import {
  ComprehendMedicalClient,
  DetectPHICommand,
} from "@aws-sdk/client-comprehendmedical";

/**
 * Masks PHI (Protected Health Information) in a transcript using AWS Comprehend Medical.
 * 
 * Handles large transcripts by chunking (AWS limit: 20,000 chars).
 * Replaces PHI with tokens in format {{TYPE_ID}} (e.g., {{NAME_1}}).
 * 
 * @param {string} transcript - The medical transcript to mask
 * @param {number} [mask_threshold=0.15] - Confidence threshold (0-1) for masking
 * @returns {Promise<Object>} - { masked_transcript, phi_entities, skipped_entities, mask_threshold, chunks_processed }
 * @throws {Error} - If transcript is not a string
 */
export async function mask_phi(transcript, mask_threshold = 0.15) {
  if (!transcript || typeof transcript !== "string") {
    throw new Error("Transcript is required and must be a string");
  }

  // AWS Comprehend Medical has a 20,000 character limit
  const MAX_CHARS = 19000; // Leave some buffer for safety
  
  // If transcript is within limit, process normally
  if (transcript.length <= MAX_CHARS) {
    return await processSingleChunk(transcript, mask_threshold);
  }

  // For longer transcripts, split into chunks and process each
  console.log(`Transcript length (${transcript.length}) exceeds AWS limit. Splitting into chunks.`);
  
  const chunks = splitIntoChunks(transcript, MAX_CHARS);
  let allEntities = [];
  let currentOffset = 0;
  let maskedTranscript = "";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`Processing chunk ${i + 1}/${chunks.length}, length: ${chunk.length}`);
    
    const chunkResult = await processSingleChunk(chunk, mask_threshold);
    
    // Adjust entity offsets to account for previous chunks
    const adjustedEntities = chunkResult.phi_entities.map(entity => ({
      ...entity,
      BeginOffset: entity.BeginOffset + currentOffset,
      EndOffset: entity.EndOffset + currentOffset,
      Id: entity.Id + (i * 1000) // Offset IDs to avoid conflicts between chunks
    }));
    
    allEntities = allEntities.concat(adjustedEntities);
    maskedTranscript += chunkResult.masked_transcript;
    currentOffset += chunk.length;
  }

  return {
    masked_transcript: maskedTranscript,
    phi_entities: allEntities,
    skipped_entities: [], // Could aggregate if needed
    mask_threshold: mask_threshold !== undefined ? Number(mask_threshold) : 0.15,
    chunks_processed: chunks.length,
    tokens: buildTokenMap(allEntities)
  };
}

/**
 * Unmasks PHI tokens in the form {{TYPE_ID}} using AWS Comprehend Medical tokens dictionary.
 * 
 * Performs direct O(1) dictionary lookup for each token, safely handling any order of appearance.
 * Works correctly even if entities appear in random order in the SOAP note.
 * 
 * @param {string} maskedText - Transcript with {{TYPE_ID}} tokens
 * @param {Object} tokens - Object mapping token keys ("TYPE_ID") to original text from AWS Comprehend
 * @returns {Object} - { unmasked_transcript }
 * @throws {Error} - If maskedText is not a string or tokens is not an object
 */
export function unmask_phi(maskedText, tokens) {
  if (!maskedText || typeof maskedText !== 'string') {
    throw new Error('maskedText is required and must be a string');
  }

  if (!tokens || typeof tokens !== 'object') {
    throw new Error('tokens object from AWS Comprehend Medical is required for unmasking');
  }

  // Log input details
  const tokenCount = Object.keys(tokens).length;
  const tokenKeys = Object.keys(tokens);
  console.log('[unmask_phi] Starting unmask operation');
  console.log('[unmask_phi] Token keys:', tokenKeys);
  
  // Count masked tokens in input
  const maskedTokenPattern = /\{\{([^}]+)\}\}/g;
  const maskedTokensInText = maskedText.match(maskedTokenPattern) || [];
  console.log('[unmask_phi] Masked tokens found in input:', maskedTokensInText);
  
  let unmaskedCount = 0;
  let missingTokenCount = 0;

  const unmasked = maskedText.replace(/\{\{([^}]+)\}\}/g, (match, inner) => {
    const replacement = tokens[inner];
    
    if (!tokens.hasOwnProperty(inner)) {
      console.error('[unmask_phi] PHI token undefined:', match);
      missingTokenCount++;
      return match;
    } else if (!replacement) {
      console.error('[unmask_phi] PHI token missing from tokens dict:', match);
      missingTokenCount++;
      return match;
    }

    unmaskedCount++;
    console.log(`[unmask_phi] Unmasked ${match} -> "${replacement}"`);
    return replacement;
  });

  console.log('[unmask_phi] Unmasking complete');
  return { unmasked_transcript: unmasked };
}

/**
 * Build a token map from phi_entities for unmasking
 * 
 * @private
 * @param {Array} phi_entities - Array of PHI entity objects
 * @returns {Object} - Object mapping "TYPE_ID" to text
 */
function buildTokenMap(phi_entities = []) {
  const tokens = {};
  for (const entity of phi_entities) {
    const key = `${entity.Type}_${entity.Id}`;
    tokens[key] = entity.Text;
  }
  return tokens;
}

/**
 * Split text into chunks that respect word boundaries when possible
 * 
 * @private
 * @param {string} text - The text to split
 * @param {number} maxChars - Maximum characters per chunk
 * @returns {Array<string>} - Array of text chunks
 */
function splitIntoChunks(text, maxChars) {
  const chunks = [];
  let start = 0;
  
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    
    // If not at the end of the text, try to break at a word boundary
    if (end < text.length) {
      // Look backwards for a space, period, or newline within the last 500 chars
      const searchStart = Math.max(start, end - 500);
      const breakPoint = text.lastIndexOf(' ', end);
      
      if (breakPoint > searchStart) {
        end = breakPoint + 1; // Include the space
      }
    }
    
    chunks.push(text.slice(start, end));
    start = end;
  }
  
  return chunks;
}

/**
 * Process a single chunk of text using AWS Comprehend Medical
 * 
 * @private
 * @param {string} transcript - The text to process
 * @param {number} [mask_threshold=0.15] - Confidence threshold for masking
 * @returns {Promise<Object>} - { masked_transcript, phi_entities, skipped_entities, mask_threshold }
 */
async function processSingleChunk(transcript, mask_threshold = 0.15) {
  const isDev = process.env.NODE_ENV !== 'production';
  const region = process.env.AWS_REGION || "us-east-1";
  const clientConfig = { region };

  if (isDev) {
    // Development: Require explicit AWS Comprehend credentials from env vars
    const accessKeyId = process.env.AWS_COMPREHEND_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_COMPREHEND_SECRET_ACCESS_KEY;
    
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        '[Development Mode] Missing AWS Comprehend credentials. Configure AWS_COMPREHEND_ACCESS_KEY_ID and AWS_COMPREHEND_SECRET_ACCESS_KEY in .env to mask PHI locally.'
      );
    }
    
    clientConfig.credentials = {
      accessKeyId,
      secretAccessKey,
    };
    
    console.log('[processSingleChunk] Development mode: Using explicit AWS Comprehend credentials from env vars');
  } else {
    // Production: SDK will auto-detect IAM role from EC2 instance
    console.log('[processSingleChunk] Production mode: Using IAM role attached to EC2 instance');
  }

  const client = new ComprehendMedicalClient(clientConfig);

  // Call detect PHI
  const command = new DetectPHICommand({ Text: transcript });
  const response = await client.send(command);
  const entities = response.Entities || [];

  // Sort entities (descending) so replacements don't shift indexes
  const sortedEntities = [...entities].sort((a, b) => b.BeginOffset - a.BeginOffset);

  // Determine threshold: param -> env -> default
  const threshold =
    mask_threshold !== undefined
      ? Number(mask_threshold)
      : 0.15;

  // Normalize and attach an Id for each entity. Use existing Id if provided by the SDK,
  // otherwise generate a sequential id (per entity) so replacement tokens are stable.
  // Then filter by score threshold so we only mask high-confidence entities.
  const normalized = sortedEntities.map((e, idx) => ({
    Type: e.Type,
    Text: e.Text,
    BeginOffset: e.BeginOffset,
    EndOffset: e.EndOffset,
    Score: e.Score,
    Id: e.Id ?? idx + 1,
  }));

  const phi_entities = normalized.filter(e => Number(e.Score) >= threshold);
  const skipped_entities = normalized.filter(e => Number(e.Score) < threshold);

  // Mask PHI spans using token format {{TYPE_ID}} (e.g. {{NAME_1}})
  // We iterate masked entities (already sorted desc) so offsets remain valid.
  let maskedTranscript = transcript;
  for (const entity of phi_entities) {
    const token = `{{${entity.Type}_${entity.Id}}}`;
    maskedTranscript =
      maskedTranscript.slice(0, entity.BeginOffset) +
      token +
      maskedTranscript.slice(entity.EndOffset);
  }

  console.log("Masked transcript:", maskedTranscript, "PHI entities:", phi_entities);

  return { 
    masked_transcript: maskedTranscript, 
    phi_entities, 
    skipped_entities, 
    mask_threshold: threshold,
    tokens: buildTokenMap(phi_entities)
  };
}
