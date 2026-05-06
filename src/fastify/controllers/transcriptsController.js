/**
 * Transcripts Controller
 * Handles all transcript CRUD operations with encryption/decryption
 */
import { getSupabaseClient } from '../../utils/supabase.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import {
  encryptTranscriptPlaintextWithMasterKey,
  decryptTranscriptRowWithMasterKey,
} from '../../utils/transcriptTextCrypto.js';
import * as userSecurityConfigController from './userSecurityConfigController.js';
import { transcriptUpdateRequestSchema } from '../schemas/requests.js';

const transcriptTable = 'transcripts';
const BATCH_SIZE = 10; // Decrypt transcripts in batches of 10

/**
 * Encrypts transcript_text using the user's master key (userSecurityConfigs), same AES path as notes.
 * Mutates transcript: sets encrypted_transcript_text, iv; removes transcript_text.
 * Returns { success, error }
 */
function encryptTranscriptText(transcript, masterKey) {
  const enc = encryptTranscriptPlaintextWithMasterKey(transcript.transcript_text, masterKey);
  if (!enc.success) {
    return enc;
  }
  if (enc.encrypted_transcript_text != null && enc.iv != null) {
    transcript.encrypted_transcript_text = enc.encrypted_transcript_text;
    transcript.iv = enc.iv;
  } else {
    transcript.encrypted_transcript_text = null;
    transcript.iv = null;
  }
  delete transcript.transcript_text;
  return { success: true, error: null };
}

/**
 * Decrypts transcript body with the user's master key (decryptNoteText + encrypted_transcript_text / iv).
 * Mutates transcript: sets transcript_text; strips ciphertext fields.
 * Returns { success, error, transcript }
 */
function decryptTranscriptText(transcript, masterKey) {
  const result = decryptTranscriptRowWithMasterKey(transcript, masterKey);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  return { success: true, transcript: result.transcript };
}

/**
 * Get all transcripts for authenticated user (with batched decryption)
 * GET /api/transcripts
 */
export async function getAllTranscripts(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    const { data, error } = await supabase
      .from(transcriptTable)
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) {
      return reply.status(500).send({ error: error.message });
    }

    for (let i = 0; i < data.length; i += BATCH_SIZE) {
      const batch = data.slice(i, i + BATCH_SIZE);
      for (let j = 0; j < batch.length; j++) {
        const result = decryptTranscriptText(batch[j], masterKey);
        if (!result.success) {
          return reply.status(400).send({ error: result.error });
        }
        batch[j] = result.transcript;
      }
    }

    return reply.status(200).send(data);
  } catch (error) {
    console.error('Error fetching transcripts:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Get a single transcript by ID
 * GET /api/transcripts/:id
 */
export async function getTranscript(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    if (!id || isNaN(id)) {
      return reply.status(400).send({ error: 'Valid transcript ID is required' });
    }

    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }
    const masterKey = keyResult.masterKey;

    const { data, error } = await supabase
      .from(transcriptTable)
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Transcript not found' });
      }
      return reply.status(500).send({ error: error.message });
    }

    const decryptionResult = decryptTranscriptText(data, masterKey);
    if (!decryptionResult.success) {
      return reply.status(400).send({ error: decryptionResult.error });
    }

    return reply.status(200).send(decryptionResult.transcript);
  } catch (error) {
    console.error('Error fetching transcript:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Create a new transcript
 * POST /api/transcripts
 */
export async function createTranscript(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const transcript = request.body;
    transcript.user_id = user.id;

    if (!transcript.transcript_text || !transcript.recording_id) {
      return reply.status(400).send({ error: 'transcript_text and recording_id are required' });
    }

    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }

    const encryptionResult = encryptTranscriptText(transcript, keyResult.masterKey);
    if (!encryptionResult.success) {
      return reply.status(400).send({ error: encryptionResult.error });
    }

    // Insert encrypted transcript
    const { data: insertData, error: insertError } = await supabase
      .from(transcriptTable)
      .insert([transcript])
      .select()
      .single();

    if (insertError) {
      return reply.status(500).send({ error: insertError.message });
    }

    return reply.status(201).send(insertData);
  } catch (error) {
    console.error('Error creating transcript:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Update a transcript - DISABLED
 * PATCH /api/transcripts/:id
 */
export async function updateTranscript(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    if (!id || isNaN(id)) {
      return reply.status(400).send({ error: 'Valid transcript ID is required' });
    }

    // Validate request body
    const parseResult = transcriptUpdateRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({ error: parseResult.error });
    }

    const { transcript_text } = parseResult.data;

    if (!transcript_text) {
      return reply.status(400).send({ error: 'transcript_text is required for update' });
    }

    const keyResult = await userSecurityConfigController.getOrCreateUserMasterKey(supabase, user.id);
    if (!keyResult.success) {
      return reply.status(500).send({ error: keyResult.error });
    }

    const { data: existingTranscript, error: fetchError } = await supabase
      .from(transcriptTable)
      .select('recording_id')
      .eq('id', id)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Transcript not found' });
      }
      return reply.status(500).send({ error: fetchError.message });
    }

    // Prepare transcript object for encryption
    const transcriptToEncrypt = {
      transcript_text,
      recording_id: existingTranscript.recording_id,
    };

    const encryptionResult = encryptTranscriptText(transcriptToEncrypt, keyResult.masterKey);
    if (!encryptionResult.success) {
      return reply.status(400).send({ error: encryptionResult.error });
    }

    // Prepare update object
    const updateData = {
      encrypted_transcript_text: transcriptToEncrypt.encrypted_transcript_text,
      iv: transcriptToEncrypt.iv,
      updated_at: new Date().toISOString(),
    };

    // Update transcript
    const { data: updatedData, error: updateError } = await supabase
      .from(transcriptTable)
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      if (updateError.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Transcript not found' });
      }
      return reply.status(500).send({ error: updateError.message });
    }

    return reply.status(200).send(updatedData);
  } catch (error) {
    console.error('Error updating transcript:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Delete a transcript
 * DELETE /api/transcripts/:id
 */
export async function deleteTranscript(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { id } = request.params;

    if (!id || isNaN(id)) {
      return reply.status(400).send({ error: 'Valid transcript ID is required' });
    }

    const { data, error } = await supabase
      .from(transcriptTable)
      .delete()
      .eq('id', id)
      .select()
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return reply.status(404).send({ error: 'Transcript not found' });
      }
      return reply.status(500).send({ error: error.message });
    }

    return reply.status(200).send({ success: true, data });
  } catch (error) {
    console.error('Error deleting transcript:', error);
    return reply.status(500).send({ error: error.message });
  }
}

// ============================================================================
// Dot Phrase Expansion Functions
// ============================================================================

/**
 * Strips ASR/prosody punctuation (comma, period, semicolon) for matching only.
 * @param {string} text - Original transcript (casing preserved in source offsets)
 * @returns {{ searchText: string, stripMap: Array<[number, number]> }} searchText is lowercased;
 *   stripMap[i] is [origStart, origEnd) for the character at searchText[i]
 */
function stripProsodyPunctuationForSearch(text) {
  const stripMap = [];
  let searchText = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === ',' || c === '.' || c === ';') continue;
    searchText += c.toLowerCase();
    stripMap.push([i, i + 1]);
  }
  return { searchText, stripMap };
}

/**
 * Expands dot phrases in text using Aho-Corasick algorithm for efficient multi-pattern matching.
 * Matching runs on text with comma, period, and semicolon removed (ASR prosody), then spans are mapped back to the original string.
 * Creates multiple versions of each trigger: original, no punctuation (except apostrophes), and expanded contractions.
 * Prioritizes longer matches over shorter ones.
 * 
 * @param {string} text - The text to expand dot phrases in
 * @param {Array} dotPhrases - Array of dot phrase objects with trigger and expansion properties
 * @returns {Object} - Object with expanded (clean) and llm_notated (with prefixes) versions
 */
export function expandDotPhrases(text, dotPhrases) {
  if (!text || !dotPhrases || dotPhrases.length === 0) {
    return { expanded: text, llm_notated: text };
  }

  console.log(`[expandDotPhrases] Processing ${dotPhrases.length} dot phrases`);

  // Build all trigger versions
  const triggerMap = buildTriggerVersions(dotPhrases);
  const allTriggers = Array.from(triggerMap.keys());

  if (allTriggers.length === 0) {
    console.log('[expandDotPhrases] No valid trigger versions to process');
    return text;
  }

  console.log(`[expandDotPhrases] Built ${allTriggers.length} trigger versions from ${dotPhrases.length} dot phrases`);

  // Build Aho-Corasick automaton
  const automaton = buildAhoCorasick(allTriggers);

  const { searchText, stripMap } = stripProsodyPunctuationForSearch(text);
  const rawMatches = findAllMatches(searchText, automaton, triggerMap);
  const matches = rawMatches.map((m) => ({
    ...m,
    start: stripMap[m.start][0],
    end: stripMap[m.end - 1][1],
  }));

  if (matches.length === 0) {
    console.log('[expandDotPhrases] No dot phrase triggers found in text');
    return { expanded: text, llm_notated: text };
  }

  // Sort matches by position (descending) to avoid offset issues during replacement
  matches.sort((a, b) => b.start - a.start);

  console.log(`[expandDotPhrases] Found ${matches.length} matches`);

  // Apply replacements - create both versions
  let expandedText = text; // Clean version for user
  let llmNotatedText = text; // Version with notation for LLM
  const appliedExpansions = [];

  for (const match of matches) {
    const originalText = text.substring(match.start, match.end);
    
    // Clean expansion for user
    const cleanExpansion = match.expansion;
    expandedText = expandedText.substring(0, match.start) + cleanExpansion + expandedText.substring(match.end);
    
    // Notated expansion for LLM - only tag explicit dot phrase triggers, not auto-expansions
    let notatedExpansion;
    if (match.isAutoExpanded) {
      // Auto-expansions (from contractions/abbreviations) don't get the prefix
      notatedExpansion = cleanExpansion;
    } else {
      // Explicit dot phrase triggers get a symmetric, easy-to-parse tag wrapper
      notatedExpansion = `<dotphrase source="doctor" instruction="emphasize">${match.expansion}</dotphrase>`;
    }
    llmNotatedText = llmNotatedText.substring(0, match.start) + notatedExpansion + llmNotatedText.substring(match.end);
    
    appliedExpansions.push({
      trigger: match.trigger,
      originalText: originalText,
      expansion: match.expansion,
      isAutoExpanded: match.isAutoExpanded,
      startIndex: match.start
    });

    console.log(`[expandDotPhrases] Replaced "${originalText}" at index ${match.start} with expansion${match.isAutoExpanded ? ' (auto-expanded)' : ''}`);
  }

  console.log(`[expandDotPhrases] Successfully applied ${appliedExpansions.length} expansions`);
  appliedExpansions.forEach(exp => {
    console.log(`  - "${exp.originalText}" → "${exp.expansion}"`);
  });

  return { expanded: expandedText, llm_notated: llmNotatedText };
}

/**
 * Builds multiple versions of each trigger and maps them to their expansions
 * Tracks whether each version is an original trigger or an auto-expanded version
 * @private
 * @param {Array} dotPhrases - Array of dot phrase objects
 * @returns {Map} - Map of trigger versions to their expansion data (with isAutoExpanded flag)
 */
function buildTriggerVersions(dotPhrases) {
  const triggerMap = new Map();
  
  for (const dotPhrase of dotPhrases) {
    const trigger = dotPhrase.trigger?.trim();
    const expansion = dotPhrase.expansion?.trim();
    
    if (!trigger || !expansion) continue;

    const versions = [];
    
    // Version 1: Original trigger (lowercase) - NOT auto-expanded
    versions.push({ version: trigger.toLowerCase(), isAutoExpanded: false });
    
    // Version 2: No punctuation except apostrophes - NOT auto-expanded
    const noPunct = trigger.replace(/[^\w'\s-]/g, '').toLowerCase().trim();
    if (noPunct && noPunct !== trigger.toLowerCase()) {
      versions.push({ version: noPunct, isAutoExpanded: false });
    }
    
    // Version 3: Contractions expanded (e.g., "don't" becomes "do not")
    // This is for matching contracted forms in the transcript - marked as auto-expanded
    const contractionsExpanded = expandContractions(noPunct);
    if (contractionsExpanded && contractionsExpanded !== trigger.toLowerCase() && contractionsExpanded !== noPunct) {
      versions.push({ version: contractionsExpanded, isAutoExpanded: true });
    }
    
    // Version 4: Abbreviations expanded for matching purposes ONLY
    // (e.g., match "pt" and also "patient" if user typed it out)
    // Marked as auto-expanded since it's from abbreviation expansion
    const abbrevExpanded = expandAbbreviations(trigger.toLowerCase());
    if (abbrevExpanded && abbrevExpanded !== trigger.toLowerCase() && !versions.some(v => v.version === abbrevExpanded)) {
      versions.push({ version: abbrevExpanded, isAutoExpanded: true });
    }

    // Add all unique versions to map
    const uniqueVersions = [];
    const seenVersions = new Set();
    for (const item of versions) {
      if (!seenVersions.has(item.version)) {
        seenVersions.add(item.version);
        uniqueVersions.push(item);
      }
    }
    
    for (const item of uniqueVersions) {
      if (item.version.length > 0) {
        triggerMap.set(item.version, {
          originalTrigger: trigger,
          expansion: expansion,
          isAutoExpanded: item.isAutoExpanded
        });
      }
    }
  }

  return triggerMap;
}

/**
 * Expands common contractions
 * @private
 * @param {string} text - Text to expand
 * @returns {string} - Expanded text
 */
function expandContractions(text) {
  const contractions = {
    "don't": "do not",
    "doesn't": "does not",
    "didn't": "did not",
    "won't": "will not",
    "wouldn't": "would not",
    "can't": "cannot",
    "couldn't": "could not",
    "shouldn't": "should not",
    "isn't": "is not",
    "aren't": "are not",
    "wasn't": "was not",
    "weren't": "were not",
    "haven't": "have not",
    "hasn't": "has not",
    "hadn't": "had not",
    "i'm": "i am",
    "you're": "you are",
    "he's": "he is",
    "she's": "she is",
    "it's": "it is",
    "we're": "we are",
    "they're": "they are",
    "i've": "i have",
    "you've": "you have",
    "we've": "we have",
    "they've": "they have",
    "i'll": "i will",
    "you'll": "you will",
    "he'll": "he will",
    "she'll": "she will",
    "it'll": "it will",
    "we'll": "we will",
    "they'll": "they will"
  };

  let result = text.toLowerCase();
  for (const [contraction, expansion] of Object.entries(contractions)) {
    result = result.replace(new RegExp(contraction, 'gi'), expansion);
  }
  return result;
}

/**
 * Expands common medical abbreviations
 * @private
 * @param {string} text - Text to expand
 * @returns {string} - Expanded text
 */
function expandAbbreviations(text) {
  const abbreviations = {
    'pt': 'patient',
    'pts': 'patients',
    'hx': 'history',
    'sx': 'symptoms',
    'dx': 'diagnosis',
    'tx': 'treatment',
    'rx': 'prescription',
    'px': 'prognosis',
    'h&p': 'history and physical',
    'a&p': 'assessment and plan',
    'hvd': 'hypertensive disease',
    'cad': 'coronary artery disease',
    'chf': 'congestive heart failure',
    'copd': 'chronic obstructive pulmonary disease',
    'dm': 'diabetes mellitus',
    'htn': 'hypertension',
    'gerd': 'gastroesophageal reflux disease',
    'nka': 'no known allergies',
    'asap': 'as soon as possible',
    'bid': 'twice a day',
    'tid': 'three times a day',
    'qid': 'four times a day'
  };

  let result = text.toLowerCase();
  for (const [abbrev, expansion] of Object.entries(abbreviations)) {
    result = result.replace(new RegExp(`\\b${abbrev}\\b`, 'gi'), expansion);
  }
  return result;
}

/**
 * Builds an Aho-Corasick automaton for multi-pattern string matching
 * @private
 * @param {Array<string>} patterns - Array of trigger patterns
 * @returns {Object} - Root node of the automaton
 */
function buildAhoCorasick(patterns) {
  const root = { children: {}, failure: null, patterns: [] };

  // Step 1: Build trie
  for (const pattern of patterns) {
    let node = root;
    for (const char of pattern) {
      if (!node.children[char]) {
        node.children[char] = { children: {}, failure: null, patterns: [] };
      }
      node = node.children[char];
    }
    node.patterns.push(pattern);
  }

  // Step 2: Build failure links using BFS
  const queue = [];
  
  // Initialize failure links for depth 1
  for (const char in root.children) {
    root.children[char].failure = root;
    queue.push(root.children[char]);
  }

  // BFS to assign failure links
  while (queue.length > 0) {
    const node = queue.shift();

    for (const char in node.children) {
      const child = node.children[char];
      let failNode = node.failure;

      while (failNode && !failNode.children[char]) {
        failNode = failNode.failure;
      }

      child.failure = failNode?.children[char] || root;

      // Inherit patterns from failure link
      if (child.failure.patterns.length > 0) {
        child.patterns = [...new Set([...child.patterns, ...child.failure.patterns])];
      }

      queue.push(child);
    }
  }

  return root;
}

/**
 * Finds all pattern matches in text using Aho-Corasick automaton
 * @private
 * @param {string} text - Text to search in (should be lowercase)
 * @param {Object} automaton - Aho-Corasick automaton
 * @param {Map} triggerMap - Map of triggers to their expansion data
 * @returns {Array} - Array of match objects with start, end, trigger, and expansion
 */
function findAllMatches(text, automaton, triggerMap) {
  const matches = [];
  let current = automaton;
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    // Follow failure links until we find a valid transition or reach root
    while (current && !current.children[char]) {
      current = current.failure;
    }
    
    if (current && current.children[char]) {
      current = current.children[char];
    } else {
      current = automaton;
      continue;
    }
    
    // Check for matches at current position
    if (current.patterns.length > 0) {
      for (const pattern of current.patterns) {
        const start = i - pattern.length + 1;
        const end = i + 1;
        
        // Verify word boundaries for whole-word matching
        const beforeChar = start > 0 ? text[start - 1] : ' ';
        const afterChar = end < text.length ? text[end] : ' ';
        
        if (isWordBoundary(beforeChar) && isWordBoundary(afterChar)) {
          const triggerData = triggerMap.get(pattern);
          if (triggerData) {
            matches.push({
              start: start,
              end: end,
              trigger: pattern,
              originalTrigger: triggerData.originalTrigger,
              expansion: triggerData.expansion,
              isAutoExpanded: triggerData.isAutoExpanded
            });
          }
        }
      }
    }
  }
  
  // Remove overlapping matches, keeping the longest ones
  return removeOverlappingMatches(matches);
}

/**
 * Checks if a character represents a word boundary
 * @private
 * @param {string} char - Character to check
 * @returns {boolean} - True if character is a word boundary
 */
function isWordBoundary(char) {
  return /\W/.test(char);
}

/**
 * Removes overlapping matches, prioritizing longer matches
 * @private
 * @param {Array} matches - Array of match objects
 * @returns {Array} - Array of non-overlapping matches
 */
function removeOverlappingMatches(matches) {
  if (matches.length <= 1) return matches;
  
  // Sort by length (descending), then by position
  matches.sort((a, b) => {
    const lengthDiff = (b.end - b.start) - (a.end - a.start);
    return lengthDiff !== 0 ? lengthDiff : a.start - b.start;
  });
  
  const result = [];
  const used = new Set();
  
  for (const match of matches) {
    let overlap = false;
    for (let i = match.start; i < match.end; i++) {
      if (used.has(i)) {
        overlap = true;
        break;
      }
    }
    
    if (!overlap) {
      result.push(match);
      for (let i = match.start; i < match.end; i++) {
        used.add(i);
      }
    }
  }
  
  return result;
}

/**
 * Fastify route handler for POST /api/transcripts/expand
 * Tests dot phrase expansion logic with provided transcript and dot phrases
 * Useful for unit testing expansion without requiring real transcriptions
 * 
 * @param {Object} request - Fastify request object
 * @param {Object} reply - Fastify reply object
 */
export async function expandHandler(request, reply) {
  const startTime = Date.now();
  try {
    const { transcript, dotPhrases = [], enableDotPhraseExpansion = true } = request.body || {};
    
    console.log(`[expandHandler] Expanding transcript with ${dotPhrases.length} dot phrases`);
    
    let expanded = transcript;
    let llm_notated = transcript;
    
    // Perform expansion if enabled
    if (enableDotPhraseExpansion && dotPhrases.length > 0) {
      const result = expandDotPhrases(transcript, dotPhrases);
      expanded = result.expanded;
      llm_notated = result.llm_notated;
    }
    
    const elapsed = Date.now() - startTime;
    console.log(`[expandHandler] ✓ Expansion completed in ${elapsed}ms`);
    
    return reply.status(200).send({ 
      ok: true, 
      expanded,
      llm_notated,
      dotPhrasesApplied: enableDotPhraseExpansion ? dotPhrases.length : 0
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[expandHandler] ✗ Error after ${elapsed}ms:`, err.message);
    
    const status = err?.status || 500;
    const payload = { error: err?.message || String(err) };
    
    return reply.status(status).send(payload);
  }
}
