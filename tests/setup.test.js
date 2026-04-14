/**
 * Test Setup Script
 * Creates test data for recordings API tests:
 * - 3 test encounters (900, 901, 902)
 * - 5 test recording files (3 attached to encounters, 2 unattached)
 * - Saves metadata to testData.json for use by other tests
 *
 * Run once before executing test suites:
 * npm run test:setup
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

// Load .env.local
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env.local');
dotenv.config({ path: envPath });

import { getTestAccount, hasTestAccounts, getApiBaseUrl } from './testConfig.js';
import { createClient } from '@supabase/supabase-js';

const RECORDINGS_BUCKET = 'audio-files';
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');
const FIXTURES_README = path.resolve(__dirname, 'fixtures/README.txt');
const TEST_DATA_FILE = path.resolve(__dirname, 'testData.json');

/**
 * TEST DATA SCHEMA - Source of truth for what test data should look like
 * Defines expected files and their attachment status
 * Index 0-2: attached to encounters (900, 901, 902)
 * Index 3-4: unattached (no encounter)
 */
const TEST_DATA_SCHEMA = [
  { fileIndex: 0, shouldBeAttached: true, encounterId: 900 },   // Will be replaced with actual encounter ID
  { fileIndex: 1, shouldBeAttached: true, encounterId: 901 },
  { fileIndex: 2, shouldBeAttached: true, encounterId: 902 },
  { fileIndex: 3, shouldBeAttached: false, encounterId: null },
  { fileIndex: 4, shouldBeAttached: false, encounterId: null },
];

/**
 * Default dotPhrases if fixture file not readable
 */
const DEFAULT_DOTPHRASES = [
  { trigger: 'pt', expansion: 'patient' },
  { trigger: 'hx', expansion: 'history' },
];

/**
 * Create a recording entry in the database linked to an encounter
 * Uses API endpoint instead of direct database insert
 */
async function createRecordingEntry(accessToken, recordingPath, encounterId) {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/recordings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        patientEncounter_id: encounterId,
        recording_file_path: recordingPath,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error(`    Error creating recording: ${error.error || response.statusText}`);
      return null;
    }

    const recordingData = await response.json();
    // Return the created recording object with its ID
    return recordingData.data || recordingData;
  } catch (error) {
    console.error(`    Error creating recording: ${error.message}`);
    return null;
  }
}

/**
 * Get fixture files - uses actual files in fixtures folder
 */
function getFixtureFiles() {
  try {
    const files = fs.readdirSync(FIXTURES_DIR);
    const audioFiles = files.filter(f => 
      /\.(mp3|mp4|wav|m4a|aac)$/i.test(f)
    );
    return audioFiles;
  } catch (error) {
    console.error(`Error reading fixtures directory: ${error.message}`);
    return [];
  }
}

/**
 * Parse dotPhrase fixtures from README.txt
 * Returns array of { trigger, expansion } objects
 */
function readDotPhraseFixtures() {
  try {
    const content = fs.readFileSync(FIXTURES_README, 'utf-8');
    const dotPhrases = [];
    const lines = content.split('\n');
    let inDotPhrasesSection = false;
    let currentPhrase = {};
    
    for (const line of lines) {
      // Start of dotPhrases section
      if (line.includes('DOTPHRASES TO ADD')) {
        inDotPhrasesSection = true;
        continue;
      }
      
      // End of section (HOW IT WORKS or next section)
      if (inDotPhrasesSection && (line.includes('HOW IT WORKS') || line.includes('CREATED DOTPHRASES'))) {
        inDotPhrasesSection = false;
      }
      
      // Parse dotPhrase lines
      if (inDotPhrasesSection) {
        const triggerMatch = line.match(/TRIGGER\s*=\s*(\S+)/);
        const expansionMatch = line.match(/EXPANSION\s*=\s*(.+)/);
        
        if (triggerMatch) {
          currentPhrase.trigger = triggerMatch[1].trim();
        }
        if (expansionMatch) {
          currentPhrase.expansion = expansionMatch[1].trim();
        }
        
        // If we have both, add to array and reset
        if (currentPhrase.trigger && currentPhrase.expansion) {
          dotPhrases.push(currentPhrase);
          currentPhrase = {};
        }
      }
    }
    
    return dotPhrases.length > 0 ? dotPhrases : DEFAULT_DOTPHRASES;
  } catch (error) {
    console.warn(`Could not read dotPhrase fixtures (${error.message}), using defaults`);
    return DEFAULT_DOTPHRASES;
  }
}

/**
 * Upload file to Supabase storage
 */
async function uploadToStorage(supabase, userId, localPath, filename) {
  try {
    const fileData = fs.readFileSync(localPath);
    const remotePath = `${userId}/${filename}`;
    
    const { data, error } = await supabase.storage
      .from(RECORDINGS_BUCKET)
      .upload(remotePath, fileData, { upsert: true });

    if (error) {
      console.error(`  ✗ Error uploading ${filename}:`, error.message);
      return null;
    }

    console.log(`  ✓ Uploaded: ${remotePath}`);
    return remotePath;
  } catch (error) {
    console.error(`  ✗ Error uploading ${filename}:`, error.message);
    return null;
  }
}

/**
 * Setup Test Recordings - Upload fixture files and create/update recording entries
 * SELF-CONTAINED: Creates test encounters and records independently
 * Maps files to encounters: first 3 attached, remaining 2 unattached (storage only)
 */
async function setupTestRecordings(accessToken, supabase, userId) {
  console.log('Step 4: Setting up test recordings...\n');
  
  const fixtureFiles = getFixtureFiles();
  const recordings = [];
  
  if (fixtureFiles.length === 0) {
    console.log('  ⚠️ No fixture files found in tests/fixtures/\n');
    return { recordings: [], encounters: [] };
  }
  
  // STEP 4A: Create/fetch test encounters (only need first 3 for attached recordings)
  console.log('Creating test encounters for recordings...');
  const testEncounterNames = ['Alpha', 'Bravo', 'Charlie'];
  const createdEncounters = [];
  
  try {
    const fetchResponse = await fetch(`${getApiBaseUrl()}/api/patient-encounters?decryptName=true`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (fetchResponse.ok) {
      const existingEncounters = await fetchResponse.json();
      const existingMap = new Map(existingEncounters.map(e => [e.name, e]));
      
      for (const name of testEncounterNames) {
        const existing = existingMap.get(name);
        
        if (existing) {
          createdEncounters.push(existing);
          console.log(`  ⏭️  Encounter "${name}" exists (ID: ${existing.id})`);
        } else {
          try {
            const createResponse = await fetch(`${getApiBaseUrl()}/api/patient-encounters`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ name }),
            });
            
            if (createResponse.ok) {
              const created = await createResponse.json();
              const encounterId = created.id || created.data?.id;
              createdEncounters.push({ id: encounterId, name });
              console.log(`  ✓ Created encounter: "${name}" (ID: ${encounterId})`);
            } else {
              console.warn(`  ⚠️  Failed to create encounter "${name}": ${createResponse.status}`);
            }
          } catch (error) {
            console.warn(`  ⚠️  Error creating encounter "${name}": ${error.message}`);
          }
        }
      }
    } else {
      console.warn(`  ⚠️  Error fetching encounters: ${fetchResponse.status}`);
    }
  } catch (error) {
    console.warn(`  ⚠️  Error in encounter setup: ${error.message}`);
  }
  
  console.log();
  
  // STEP 4B: Check storage and upload only missing files
  console.log('Checking storage and uploading missing files...');
  
  // Get list of files already in storage
  let storageFiles = [];
  try {
    const { data, error } = await supabase.storage
      .from(RECORDINGS_BUCKET)
      .list(`${userId}`, { limit: 100 });
    
    if (error) {
      console.warn(`  ⚠️  Error listing storage: ${error.message}`);
    } else {
      storageFiles = (data || []).map(f => f.name);
    }
  } catch (error) {
    console.warn(`  ⚠️  Error checking storage: ${error.message}`);
  }
  
  // Upload only files that don't already exist in storage
  const uploadedFiles = [];
  for (const filename of fixtureFiles) {
    if (storageFiles.includes(filename)) {
      console.log(`  ⏭️  Skipping "${filename}" (already in storage)`);
      uploadedFiles.push({ filename, remotePath: `${userId}/${filename}` });
    } else {
      const localPath = path.join(FIXTURES_DIR, filename);
      const remotePath = await uploadToStorage(supabase, userId, localPath, filename);
      if (remotePath) {
        uploadedFiles.push({ filename, remotePath });
        console.log(`  ✓ Uploaded: "${filename}"`);
      }
    }
  }
  
  console.log();
  
  // STEP 4C: Create recording entries for attached files only (first 3)
  console.log('Creating/updating recording entries...');
  
  // Fetch existing recordings to avoid duplicates
  let existingRecordings = [];
  try {
    const recordingsResponse = await fetch(`${getApiBaseUrl()}/api/recordings`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (recordingsResponse.ok) {
      existingRecordings = await recordingsResponse.json();
    }
  } catch (error) {
    console.warn(`  ⚠️  Error fetching existing recordings: ${error.message}`);
  }
  
  // Only attach first 3 files to encounters; last 2 stay unattached (storage only)
  const attachmentCount = 3;
  
  for (let i = 0; i < uploadedFiles.length; i++) {
    const { filename, remotePath } = uploadedFiles[i];
    const shouldAttach = i < attachmentCount;
    
    if (!shouldAttach) {
      console.log(`  ⏭️  Skipping "${filename}" (unattached, storage only)`);
      // Track unattached files in recordings array
      recordings.push({
        id: null,
        filename,
        path: remotePath,
        attached: false,
        encounterId: null,
      });
      continue;
    }
    
    const encounterId = createdEncounters[i]?.id;
    
    if (!encounterId) {
      console.log(`  ✗ Skipping "${filename}": No encounter available`);
      continue;
    }
    
    // Check if recording already exists with this file_path and encounter_id
    const existingRecording = existingRecordings.find(r => 
      r.recording_file_path === remotePath && 
      r.patientEncounter_id === encounterId
    );
    
    if (existingRecording) {
      console.log(`  ⏭️  Recording "${filename}" already exists (ID: ${existingRecording.id})`);
      recordings.push({
        id: existingRecording.id,
        filename,
        path: remotePath,
        attached: true,
        encounterId,
      });
      continue;
    }
    
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/recordings`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          patientEncounter_id: encounterId,
          recording_file_path: remotePath,
        }),
      });
      
      if (response.ok) {
        const recordingData = await response.json();
        const recordingId = recordingData.id || recordingData.data?.id;
        
        console.log(`  ✓ Created recording: "${filename}" (attached to encounter ${encounterId})`);
        
        recordings.push({
          id: recordingId,
          filename,
          path: remotePath,
          attached: true,
          encounterId,
        });
      } else {
        const error = await response.json();
        console.log(`  ✗ Failed to create recording for "${filename}": ${error.error || response.statusText}`);
      }
    } catch (error) {
      console.log(`  ✗ Error creating recording for "${filename}": ${error.message}`);
    }
  }
  
  console.log();
  return { recordings, encounters: createdEncounters };
}

/**
 * Get all remote recordings from Supabase bucket using user's token
 */
async function getRemoteRecordingFiles(supabase, userId) {
  try {
    const { data, error } = await supabase.storage
      .from(RECORDINGS_BUCKET)
      .list(`${userId}`, { limit: 100 });

    if (error) throw error;
    return (data || []).map(file => ({
      name: file.name,
      path: `${userId}/${file.name}`,
    }));
  } catch (error) {
    console.error('  Error listing bucket files:', error.message);
    return [];
  }
}

/**
 * Get batch recordings for the user via API (JWT)
 */
async function getBatchRecordings(accessToken) {
  try {
    const response = await fetch('http://localhost:3001/api/recordings', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`  Error fetching recordings: ${response.status}`);
      return [];
    }

    return await response.json();
  } catch (error) {
    console.error('  Error querying recordings:', error.message);
    return [];
  }
}

/**
 * Setup Patient Encounters - Creates 3 test encounters if they don't exist
 * Names: "Test Patient", "Updated Integration Test Patient", "Unattached Encounter"
 * Display IDs: 900, 901, 902
 */
async function setupPatientEncounters(accessToken) {
  console.log('⚙️ Setting up test patient encounters...');
  
  const expectedEncounters = [
    { name: 'Alpha', displayId: 901 },
    { name: 'Bravo', displayId: 900 },
    { name: 'Charlie', displayId: 902 },
  ];
  
  const createdEncounters = [];
  
  try {
    // Fetch existing encounters
    const response = await fetch(`${getApiBaseUrl()}/api/patient-encounters?decryptName=true`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (!response.ok) {
      console.warn(`  ⚠️  Error fetching encounters: ${response.status}`);
      return [];
    }
    
    const existingEncounters = await response.json();
    
    // Build map of existing encounters by name
    const existingMap = new Map(existingEncounters.map(e => [e.name, e]));
    
    // Create missing encounters
    for (const expected of expectedEncounters) {
      const existing = existingMap.get(expected.name);
      
      if (existing) {
        console.log(`  ⏭️  Skipping encounter: "${expected.name}" (already exists, ID: ${existing.id})`);
        createdEncounters.push(existing);
      } else {
        try {
          const createResponse = await fetch('http://localhost:3001/api/patient-encounters', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: expected.name,
            }),
          });
          
          if (createResponse.ok) {
            const created = await createResponse.json();
            const encounterId = created.id || created.data?.id;
            createdEncounters.push({
              id: encounterId,
              name: expected.name,
              displayId: expected.displayId,
            });
            console.log(`  ✓ Created encounter: "${expected.name}" (ID: ${encounterId})`);
          } else {
            console.warn(`  ⚠️  Failed to create encounter "${expected.name}": ${createResponse.status}`);
          }
        } catch (error) {
          console.warn(`  ⚠️  Error creating encounter "${expected.name}": ${error.message}`);
        }
      }
    }
  } catch (error) {
    console.warn(`  ⚠️  Error in setupPatientEncounters: ${error.message}`);
  }
  
  console.log();
  return createdEncounters;
}

/**
 * Setup DotPhrases - Independent function
 * Reconciles existing dotPhrases: deletes mismatched, creates missing
 */
async function setupDotPhrases(accessToken) {
  console.log('⚙️ Reconciling test dotPhrases...');
  const expectedDotPhrases = readDotPhraseFixtures();
  const createdDotPhrases = [];
  
  // Fetch existing dotPhrases for the user
  let existingDotPhrases = [];
  try {
    const getResponse = await fetch(`${getApiBaseUrl()}/api/dot-phrases`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (getResponse.ok) {
      const data = await getResponse.json();
      existingDotPhrases = Array.isArray(data) ? data : (data.data || []);
    }
  } catch (error) {
    console.warn(`  ⚠️  Error fetching existing dotPhrases: ${error.message}`);
  }
  
  // Build map of expected dotPhrases by trigger
  const expectedMap = new Map(expectedDotPhrases.map(dp => [dp.trigger, dp.expansion]));
  
  // Delete dotPhrases that don't match or aren't expected
  for (const existing of existingDotPhrases) {
    const expectedExpansion = expectedMap.get(existing.trigger);
    
    // If not in expected list or expansion doesn't match, delete it
    if (!expectedExpansion || expectedExpansion !== existing.expansion) {
      try {
        const deleteResponse = await fetch(`${getApiBaseUrl()}/api/dot-phrases/${existing.id}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
          },
        });
        
        if (deleteResponse.ok) {
          console.log(`  🗑️  Deleted mismatched dotPhrase: "${existing.trigger}"`);
        }
      } catch (error) {
        console.warn(`  ⚠️  Error deleting dotPhrase "${existing.trigger}": ${error.message}`);
      }
    }
  }
  
  // Create or skip dotPhrases based on expected list
  for (const phrase of expectedDotPhrases) {
    const existing = existingDotPhrases.find(dp => dp.trigger === phrase.trigger);
    
    if (existing && existing.expansion === phrase.expansion) {
      // Already exists with correct expansion
      console.log(`  ⏭️  Skipping dotPhrase: "${phrase.trigger}" (already exists)`);
      createdDotPhrases.push({
        id: existing.id,
        trigger: phrase.trigger,
        expansion: phrase.expansion,
      });
    } else {
      // Create new
      try {
        const response = await fetch(`${getApiBaseUrl()}/api/dot-phrases`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            trigger: phrase.trigger,
            expansion: phrase.expansion,
          }),
        });
        
        if (response.ok) {
          const created = await response.json();
          const dotPhraseId = created.id || created.data?.id || created.data?.dotPhrase?.id;
          createdDotPhrases.push({
            id: dotPhraseId,
            trigger: phrase.trigger,
            expansion: phrase.expansion,
          });
          console.log(`  ✓ Created dotPhrase: "${phrase.trigger}" → "${phrase.expansion}"`);
        } else {
          console.warn(`  ⚠️  Failed to create dotPhrase "${phrase.trigger}": ${response.status}`);
        }
      } catch (error) {
        console.warn(`  ⚠️  Error creating dotPhrase "${phrase.trigger}": ${error.message}`);
      }
    }
  }
  console.log();
  
  return createdDotPhrases;
}

/**
 * Setup SOAP Notes - Depends on encounters from setupRecordings
 * Checks DB first, only creates missing notes
 */
async function setupSoapNotes(accessToken, encounters) {
  console.log('⚙️ Setting up test SOAP notes...');
  
  if (!encounters || encounters.length < 2) {
    console.warn(`  ⚠️  Insufficient encounters (${encounters?.length || 0}) to set up SOAP notes. Need at least 2.\n`);
    return [];
  }
  
  const createdSoapNotes = [];
  const expectedNotesPerEncounter = [2, 1]; // 2 for first (Alpha), 1 for second (Bravo)
  
  for (let encIdx = 0; encIdx < 2; encIdx++) {
    const encounter = encounters[encIdx];
    const expectedCount = expectedNotesPerEncounter[encIdx];
    
    // Check existing notes for this encounter via complete encounter endpoint
    try {
      const getResponse = await fetch(`${getApiBaseUrl()}/api/patient-encounters/complete/${encounter.id}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });
      
      let existingNotes = [];
      if (getResponse.ok) {
        const encounterData = await getResponse.json();
        // Extract soapNotes from the encounter response
        existingNotes = encounterData.soapNotes || [];
      }
      
      console.log(`  Found ${existingNotes.length} existing SOAP note(s) for encounter "${encounter.name}" (ID: ${encounter.id})`);
      // Check if we have more notes than expected
      if (existingNotes.length > expectedCount) {
        console.warn(`  ⚠️  SKIPPING: Encounter "${encounter.name}" has ${existingNotes.length} notes, expected ${expectedCount}`);
        continue;
      }
      
      // If we already have the expected count, skip
      if (existingNotes.length === expectedCount) {
        console.log(`  ⏭️  Skipped. ${existingNotes.length} existing note(s) for "${encounter.name}" (as expected)`);
        continue;
      }
      
      // Create only missing notes
      const notesToCreate = expectedCount - existingNotes.length;
      const startIndex = existingNotes.length + 1; // Next sequential note number
      
      for (let i = 0; i < notesToCreate; i++) {
        const noteNum = startIndex + i;
        try {
          const response = await fetch(`${getApiBaseUrl()}/api/soap-notes`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              patientEncounter_id: encounter.id,
              soapNote_text: {
                soapNote: {
                  subjective: `${encounter.name} Subjective - Note ${noteNum}`,
                  objective: `${encounter.name} Objective - Note ${noteNum}`,
                  assessment: `${encounter.name} Assessment - Note ${noteNum}`,
                  plan: `${encounter.name} Plan - Note ${noteNum}`,
                },
                billingSuggestion: `CPT-${noteNum === 1 ? '99213' : '99214'}`,
              },
            }),
          });

          if (response.ok) {
            const created = await response.json();
            createdSoapNotes.push({
              id: created.id,
              encounterName: encounter.name,
              encounterId: encounter.id,
              noteNumber: noteNum,
            });
            console.log(`  ✓ Created SOAP note ${noteNum} for "${encounter.name}"`);
          } else {
            console.warn(`  ⚠️  Failed to create SOAP note ${noteNum} for "${encounter.name}": ${response.status}`);
          }
        } catch (error) {
          console.warn(`  ⚠️  Error creating SOAP note ${noteNum}: ${error.message}`);
        }
      }
      
    } catch (error) {
      console.warn(`  ⚠️  Error checking existing SOAP notes for "${encounter.name}": ${error.message}`);
    }
  }
  
  // ===== TEST SOAP NOTES ORDERING AND PAGINATION =====
  console.log(`\n  Testing SOAP notes ordering and pagination...`);
  
  // Test 1: Get all with DESC order (should be newest first)
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/soap-notes?limit=100&offset=0&sortBy=created_at&order=desc`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      const notes = Array.isArray(data) ? data : (data.data || []);
      
      if (notes.length >= 3) {
        console.log(`    ✓ DESC order test - retrieved ${notes.length} notes (newest first)`);
      } else {
        console.warn(`    ⚠️  DESC order test - only found ${notes.length} notes, expected 3+`);
      }
    }
  } catch (error) {
    console.warn(`    ⚠️  Error testing DESC order: ${error.message}`);
  }

  // Test 2: Pagination with limit=2, offset=0
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/soap-notes?limit=2&offset=0&sortBy=created_at&order=desc`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      const notes = Array.isArray(data) ? data : (data.data || []);
      
      if (notes.length === 2) {
        console.log(`    ✓ Pagination (limit=2, offset=0) returned 2 notes`);
      } else {
        console.warn(`    ⚠️  Pagination test - got ${notes.length} notes, expected 2`);
      }
    }
  } catch (error) {
    console.warn(`    ⚠️  Error testing pagination: ${error.message}`);
  }

  // Test 3: Pagination with limit=2, offset=1
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/soap-notes?limit=2&offset=1&sortBy=created_at&order=desc`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      const data = await response.json();
      const notes = Array.isArray(data) ? data : (data.data || []);
      
      if (notes.length >= 1) {
        console.log(`    ✓ Pagination (limit=2, offset=1) returned ${notes.length} note(s)`);
      } else {
        console.warn(`    ⚠️  Pagination test - got ${notes.length} notes`);
      }
    }
  } catch (error) {
    console.warn(`    ⚠️  Error testing pagination (offset=1): ${error.message}`);
  }
  
  console.log();
  return createdSoapNotes;
}

/**
 * Setup Transcripts - Creates transcripts for recordings
 * Checks first if transcript exists, only creates if missing
 */
async function setupTranscripts(accessToken, recordings) {
  console.log('⚙️ Setting up test transcripts...');
  
  if (!recordings || recordings.length === 0) {
    console.warn(`  ⚠️  No recordings available to create transcripts.\n`);
    return [];
  }
  
  const createdTranscripts = [];
  
  // Only process attached recordings (not null IDs)
  const attachedRecordings = recordings
    .filter(r => r.attached && r.id !== null)
    .sort((a, b) => {
      // Sort by recording ID for consistent ordering
      if (!a.id || !b.id) return 0;
      return String(a.id).localeCompare(String(b.id));
    });
  
  if (attachedRecordings.length === 0) {
    console.warn(`  ⚠️  No attached recordings found.\n`);
    return [];
  }
  
  console.log(`  Processing ${attachedRecordings.length} attached recording(s)...`);
  
  // Fetch all transcripts once (API doesn't support filtering)
  let allTranscripts = [];
  try {
    const allTranscriptsResponse = await fetch(`${getApiBaseUrl()}/api/transcripts`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
    
    if (allTranscriptsResponse.ok) {
      const data = await allTranscriptsResponse.json();
      allTranscripts = Array.isArray(data) ? data : [];
    }
  } catch (error) {
    console.warn(`  ⚠️  Error fetching all transcripts: ${error.message}`);
  }
  
  for (let index = 0; index < attachedRecordings.length; index++) {
    const recording = attachedRecordings[index];
    
    try {
      // Filter transcripts for this specific recording (client-side filtering)
      const existingTranscripts = allTranscripts.filter(t => t.recording_id === recording.id);
      const existingTranscript = existingTranscripts.length > 0 ? existingTranscripts[0] : null;
      
      // FIRST 2 RECORDINGS: Create transcripts
      if (index < 2) {
        if (existingTranscript) {
          console.log(`  ⏭️  Transcript already exists for recording "${recording.filename}" (ID: ${existingTranscript.id})`);
          createdTranscripts.push({
            id: existingTranscript.id,
            recordingId: recording.id,
            filename: recording.filename,
            encounterId: recording.encounterId,
          });
          continue;
        }
        
        // Create new transcript with mock text
        const mockTranscriptText = `This is a mock transcript for recording "${recording.filename}". 
Doctor: Good morning, how are you feeling today?
Patient: I'm feeling much better, thank you for asking.
Doctor: That's great to hear. Let me examine you and we'll discuss the next steps.
Patient: Sounds good.
Doctor: Everything looks normal. Continue with your current medications and follow up in two weeks.
Patient: Thank you, doctor. I appreciate your time.`;

        const createResponse = await fetch(`${getApiBaseUrl()}/api/transcripts`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            recording_id: recording.id,
            transcript_text: mockTranscriptText,
          }),
        });
        
        if (createResponse.ok) {
          const created = await createResponse.json();
          const transcriptId = created.id || created.data?.id;
          
          createdTranscripts.push({
            id: transcriptId,
            recordingId: recording.id,
            filename: recording.filename,
            encounterId: recording.encounterId,
          });
          
          console.log(`  ✓ Created transcript for "${recording.filename}" (ID: ${transcriptId})`);
        } else {
          const error = await createResponse.json();
          console.warn(`  ⚠️  Failed to create transcript for "${recording.filename}": ${error.error || createResponse.status}`);
        }
      } else {
        // 3RD+ RECORDINGS: Delete transcripts if they exist
        if (existingTranscript) {
          try {
            const deleteResponse = await fetch(`${getApiBaseUrl()}/api/transcripts/${existingTranscript.id}`, {
              method: 'DELETE',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
              },
            });
            
            if (deleteResponse.ok) {
              console.log(`  🗑️  Deleted transcript for "${recording.filename}" (ID: ${existingTranscript.id})`);
            } else {
              console.warn(`  ⚠️  Failed to delete transcript for "${recording.filename}": ${deleteResponse.status}`);
            }
          } catch (deleteError) {
            console.warn(`  ⚠️  Error deleting transcript for "${recording.filename}": ${deleteError.message}`);
          }
        } else {
          console.log(`  ℹ️  No transcript to delete for recording "${recording.filename}" (expected)`);
        }
      }
    } catch (error) {
      console.warn(`  ⚠️  Error processing recording "${recording.filename}": ${error.message}`);
    }
  }
  
  console.log();
  return createdTranscripts;
}

/**
 * Main setup function with smart duplicate detection
 */
async function setupTestData() {
  console.log('\n' + '='.repeat(70));
  console.log('RECORDINGS API TEST SETUP');
  console.log('='.repeat(70) + '\n');

  // Check if server is running
  try {
    const response = await fetch(`${getApiBaseUrl()}/health`);
    if (!response.ok) throw new Error('Server not responding');
    console.log('✅ Server health check passed\n');
  } catch (error) {
    console.error('❌ Server is not running. Start the server with:');
    console.error('   npm run dev:fastify\n');
    process.exit(1);
  }

  // Get test account credentials
  if (!hasTestAccounts()) {
    console.error('❌ Test account not configured. Set TEST_ACCOUNT_EMAIL and TEST_ACCOUNT_PASSWORD in .env.local');
    process.exit(1);
  }

  const testAccount = getTestAccount('primary');
  if (!testAccount?.email || !testAccount?.password) {
    console.error('❌ Invalid test account credentials');
    process.exit(1);
  }

  console.log(`Using test account: ${testAccount.email}\n`);

  try {
    // Step 1: Sign in to get access token
    console.log('Step 1: Authenticating...');
    const signInResponse = await fetch(`${getApiBaseUrl()}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'sign-in',
        email: testAccount.email,
        password: testAccount.password,
      }),
    });

    if (!signInResponse.ok) {
      throw new Error('Failed to sign in. Check credentials in .env.local');
    }

    const authData = await signInResponse.json();
    const accessToken = authData.token.access_token;
    const userId = authData.user.id;
    console.log(`✓ Authenticated as: ${userId}\n`);

    // Step 2: Create Supabase client
    console.log('Step 2: Initializing Supabase client...');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      accessToken
    );
    console.log('✓ Supabase client ready\n');

    // Step 3: Check existing recordings
    console.log('Step 3: Checking for existing test data...');
    
    const localAudioFiles = getFixtureFiles();
    const remoteFiles = await getRemoteRecordingFiles(supabase, userId);
    const apiRecordings = await getBatchRecordings(accessToken);
    
    console.log(`  Local fixtures: ${localAudioFiles.length} files`);
    console.log(`  Remote storage: ${remoteFiles.length} files`);
    console.log(`  Database recordings: ${apiRecordings.length} recordings\n`);

    // Check for extra files in bucket (like .emptyFolderPlaceholder)
    const remoteFileNames = new Set(remoteFiles.map(f => f.name));
    const extraFiles = remoteFileNames.size > 0 ? 
      Array.from(remoteFileNames).filter(f => !localAudioFiles.includes(f)) : [];
    
    if (extraFiles.length > 0) {
      const redStart = '\x1b[31m';
      const redEnd = '\x1b[0m';
      console.log(redStart + '🚨 RED WARNING: Extra files found in storage (not in fixtures):');
      extraFiles.forEach(f => console.log(`   - ${f}`));
      console.log('   These may affect test ordering. Consider cleaning up.' + redEnd + '\n');
    }

    // Get all encounters for validation
    const allEncounters = await fetch(`${getApiBaseUrl()}/api/patient-encounters?decryptName=true`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }).then(r => r.json()).catch(() => []);
    
    const encounterMap = new Map(allEncounters.map(e => [e.id, e]));

    // Match bucket files to API recordings (DB entries)
    // Attached = Bucket files with DB entry AND patientEncounter_id set AND encounter exists
    // Unattached = Bucket files without DB entry
    
    const matchedAttached = [];
    const unmatchedUnattached = [];
    
    // Get bucket files excluding placeholder
    const bucketFilesExcludingPlaceholder = remoteFiles.filter(f => !extraFiles.includes(f.name));
    
    for (const bucketFile of bucketFilesExcludingPlaceholder) {
      // Match by recording_file_path (user-id/filename)
      const dbRecording = apiRecordings.find(r => r.recording_file_path === bucketFile.path);
      
      if (dbRecording && dbRecording.patientEncounter_id !== null) {
        // Check if encounter exists
        const encounterExists = encounterMap.has(dbRecording.patientEncounter_id);
        
        if (encounterExists) {
          // Bucket file with DB entry AND attached to valid encounter
          matchedAttached.push({
            id: dbRecording.id,
            filename: bucketFile.name,
            path: bucketFile.path,
            attached: true,
            encounterId: dbRecording.patientEncounter_id,
          });
        } else {
          // Encounter doesn't exist - red warning
          const redStart = '\x1b[31m';
          const redEnd = '\x1b[0m';
          console.log(redStart + `⚠️  WARNING: Recording "${bucketFile.name}" claims to be attached to encounter ${dbRecording.patientEncounter_id}, but encounter doesn't exist!` + redEnd);
          // Still treat as unattached
          unmatchedUnattached.push({
            id: dbRecording?.id || null,
            filename: bucketFile.name,
            path: bucketFile.path,
            attached: false,
            encounterId: null,
          });
        }
      } else {
        // Bucket file without DB entry OR DB entry but not attached
        unmatchedUnattached.push({
          id: dbRecording?.id || null,
          filename: bucketFile.name,
          path: bucketFile.path,
          attached: false,
          encounterId: dbRecording?.patientEncounter_id || null,
        });
      }
    }

    // Debug: show matching results
    console.log(`\n  Matched (attached): ${matchedAttached.length} recordings`);
    if (matchedAttached.length > 0) {
      matchedAttached.forEach(r => console.log(`    - ${r.filename}`));
    }
    console.log(`  Unmatched (unattached): ${unmatchedUnattached.length} files`);
    if (unmatchedUnattached.length > 0) {
      unmatchedUnattached.forEach(f => console.log(`    - ${f.filename}`));
    }
    console.log();

    // ===== STEP 4: Setup Recordings (self-contained: creates encounters, uploads files, creates recordings) =====
    const recordingsResult = await setupTestRecordings(accessToken, supabase, userId);
    let createdEncounters = recordingsResult.encounters || [];

    console.log('Test recording ids:', recordingsResult.recordings.map(r => r.id).join(', '), '\n');
    // ===== STEP 5: Setup Transcripts (creates transcripts for recordings) =====
    console.log('Step 5: Setting up transcripts...');
    const createdTranscripts = await setupTranscripts(accessToken, recordingsResult.recordings);

    // ===== STEP 6: Setup DotPhrases (always runs) =====
    console.log('Step 6: Setting up dotPhrases...');
    const createdDotPhrases = await setupDotPhrases(accessToken);
    
    // ===== STEP 7: Setup SOAP Notes (always runs if encounters exist) =====
    console.log('Step 7: Setting up SOAP notes...');
    const createdSoapNotes = await setupSoapNotes(accessToken, createdEncounters);

    // ===== STEP 8: Save test data =====
    console.log('Step 8: Saving test data...\n');
    
    // Use first 3 encounters for SOAP notes testing (as defined by SOAP notes setup)
    const firstThreeEncounters = createdEncounters.slice(0, 3);

    const testData = {
      createdAt: new Date().toISOString(),
      testAccount: {
        email: testAccount.email,
        userId: userId,
      },
      encounters: firstThreeEncounters.map((e, i) => ({
        id: e.id,
        name: e.name,
        displayId: 900 + i,
      })),
      recordings: recordingsResult.recordings,
      recordingEncounters: createdEncounters.map((e, i) => ({
        id: e.id,
        name: e.name,
        index: i,
      })),
      transcripts: createdTranscripts,
      dotPhrases: createdDotPhrases,
      soapNotes: {
        note: 'Created during setup - 3 SOAP notes: 2 attached to encounter 1, 1 attached to encounter 2',
        created: createdSoapNotes.length,
      },
    };

    fs.writeFileSync(TEST_DATA_FILE, JSON.stringify(testData, null, 2));
    console.log(`✓ Test data saved to testData.json\n`);

    // Print summary
    console.log('='.repeat(70));
    console.log('SETUP COMPLETE');
    console.log('='.repeat(70));
    console.log(`\nTest data created:`);
    console.log(`  Encounters: ${firstThreeEncounters.length} (IDs: ${firstThreeEncounters.map(e => e.id).join(', ')})`);
    const attachedCount = recordingsResult.recordings.filter(r => r.attached).length;
    const unattachedCount = recordingsResult.recordings.filter(r => !r.attached).length;
    console.log(`  Recordings: ${recordingsResult.recordings.length} (${attachedCount} attached, ${unattachedCount} unattached)`);
    console.log(`  Transcripts: ${createdTranscripts.length} created`);
    console.log(`  SOAP Notes: ${createdSoapNotes.length} created (3 expected)`);
    console.log(`  DotPhrases: ${createdDotPhrases.length} reconciled`);
    console.log(`  Storage: ${RECORDINGS_BUCKET} bucket`);
    console.log(`  Config: ${TEST_DATA_FILE}`);
    console.log('\nYou can now run:');
    console.log('  npm run test:soap-notes   - Test the SOAP notes API');
    console.log('  npm run test:recordings    - Test the recordings API');
    console.log('  npm run test:transcripts   - Test the transcripts API');
    console.log('  npm run test:patient-encounters-transcript - Test patient encounter transcript endpoints');
    console.log('  npm test                   - Run all tests');
    console.log('  npm run test:teardown      - Clean up when done\n');

  } catch (error) {
    console.error('\n❌ Setup failed:', error.message);
    process.exit(1);
  }
}

// Run setup
setupTestData().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
