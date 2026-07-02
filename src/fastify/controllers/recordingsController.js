/**
 * Recordings Controller
 * Handles all recording-related operations including listing attached/unattached files
 */
import { randomUUID } from 'node:crypto';
import { getSupabaseClient } from '../../utils/supabase.js';
import { pgQueryOne, pgQueryRows, pgErrorMessage } from '../../utils/pgQueryHelpers.js';
import * as encryptionUtils from '../../utils/encryptionUtils.js';
import {
  normalizeRecordingStorageKey,
  createRecordingUploadUrl,
  createRecordingDownloadUrl,
  recordingObjectExists,
  deleteRecordingObject,
  listUserRecordingObjects,
  recordingContentTypeForExtension,
} from '../../utils/recordingsStorage.js';


/**
 * Get recordings with attachment status
 * GET /api/recordings/attachments
 * 
 * OPTIMIZED FLOW:
 * - attached=true: Paginate DB query (.range), batch fetch storage until all 100 recordings have metadata
 * - attached=false: Get all recording paths (sorted A-Z for binary search), batch fetch storage, use binary search to find unattached
 * 
 * Query Parameters:
 * - attached: 'true' or 'false' (required)
 * - limit: number (default: 100)
 * - offset: number (default: 0)
 * - sortBy: 'name' | 'created_at' | 'updated_at' (default: 'name')
 * - order: 'asc' | 'desc' (default: 'asc')
 */
export async function getRecordingsAttachments(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    // Parse and validate query parameters
    const { attached, limit = 100, offset = 0, sortBy = 'name', order = 'asc' } = request.query;
    
    // Convert limit and offset to numbers
    const limitNum = parseInt(limit) || 100;
    const offsetNum = parseInt(offset) || 0;

    const attachedBool = attached === 'true';
    const userId = user.id;

    // ===== PERFORMANCE LOGGING =====
    // console.time labels are process-global; concurrent requests need unique labels or timeEnd hits "No such label".
    const perfId = randomUUID().slice(0, 8);
    const perf = (phase) => `[getRecordingsAttachments] ${phase} [${perfId}]`;
    const labelTotal = perf('Total execution');
    const labelFetchRecordings = perf('Fetch all recordings');
    const labelFetchStorage = perf('Fetch all storage files (parallel)');

    console.time(labelTotal);
    try {
    console.time(labelFetchRecordings);
    let recordingsData;
    try {
      recordingsData = await pgQueryRows(
        `SELECT r.*,
                CASE WHEN pe.id IS NOT NULL THEN row_to_json(pe) END AS "patientEncounters"
           FROM recordings r
           LEFT JOIN "patientEncounters" pe ON pe.id = r."patientEncounter_id"
          WHERE r.user_id = $1
          ORDER BY r.recording_file_path ASC`,
        [userId]
      );
    } catch (recordingsError) {
      console.error('Error fetching recordings:', recordingsError);
      return reply.status(500).send({ error: pgErrorMessage(recordingsError) });
    } finally {
      console.timeEnd(labelFetchRecordings);
    }

    console.log(`[getRecordingsAttachments] Fetched ${recordingsData?.length || 0} recordings from DB`);

    const allStorageFiles = [];

    console.time(labelFetchStorage);
    try {
      const listed = await listUserRecordingObjects(supabase, userId);
      allStorageFiles.push(...listed);
    } catch (storageError) {
      console.error('Error fetching storage files:', storageError);
      return reply.status(500).send({
        error: storageError instanceof Error ? storageError.message : 'Storage list failed',
      });
    } finally {
      console.timeEnd(labelFetchStorage);
    }

    console.log(`[getRecordingsAttachments] Fetched ${allStorageFiles.length} files from storage`);

    // Create a map of storage files by filename for quick lookup
    console.time(perf('Build storage file map'));
    const storageFileMap = new Map();
    allStorageFiles.forEach(file => {
      const fullPath = `${userId}/${file.name}`;
      storageFileMap.set(fullPath, file);
    });
    console.timeEnd(perf('Build storage file map'));

    if (attachedBool) {
      // Build attached recordings array WITHOUT decryption (faster)
      console.time(perf('Build attached recordings (no decryption)'));
      const attachedRecordings = recordingsData.map(recording => {
        const storageFile = storageFileMap.get(recording.recording_file_path);
        const missing = !storageFile;
        
        return {
          id: recording.id,
          path: recording.recording_file_path,
          size: missing ? null : storageFile.metadata?.size || null,
          missing: missing,
          created_at: missing ? null : storageFile.created_at || null,
          updated_at: missing ? null : storageFile.updated_at || null,
          patientEncounterData: recording.patientEncounters || null,
          // Include database timestamps for sorting
          db_created_at: recording.created_at,
          db_updated_at: recording.updated_at
        };
      });
      console.timeEnd(perf('Build attached recordings (no decryption)'));

      // Apply sorting based on sortBy parameter
      console.time(perf('Sort attached recordings'));
      attachedRecordings.sort((a, b) => {
        let valueA, valueB;
        
        if (sortBy === 'name') {
          valueA = a.path || '';
          valueB = b.path || '';
          const comparison = valueA.localeCompare(valueB);
          return order === 'asc' ? comparison : -comparison;
        } else if (sortBy === 'created_at') {
          // Use database timestamps for attached recordings
          valueA = new Date(a.db_created_at || 0);
          valueB = new Date(b.db_created_at || 0);
        } else if (sortBy === 'updated_at') {
          // Use database timestamps for attached recordings
          valueA = new Date(a.db_updated_at || 0);
          valueB = new Date(b.db_updated_at || 0);
        }
        
        if (sortBy !== 'name') {
          const comparison = valueA - valueB;
          return order === 'asc' ? comparison : -comparison;
        }
        return 0;
      });
      console.timeEnd(perf('Sort attached recordings'));

      // Apply pagination BEFORE decryption (only decrypt what will be returned)
      console.time(perf('Slice pagination'));
      const paginatedRecordings = attachedRecordings.slice(offsetNum, offsetNum + limitNum);
      console.timeEnd(perf('Slice pagination'));
      console.log(`[getRecordingsAttachments] Paginated to ${paginatedRecordings.length} records (offset=${offsetNum}, limit=${limitNum})`);

      // Now decrypt only the paginated encounters
      console.time(perf('Decrypt paginated encounters'));
      const result = await Promise.all(paginatedRecordings.map(async recording => {
        let patientEncounterData = recording.patientEncounterData;
        
        // Decrypt patientEncounter name if present
        if (patientEncounterData && patientEncounterData.encrypted_name) {
          try {
            const decryptPatientEncounterResult = await encryptionUtils.decryptField(
              patientEncounterData,
              'name',
              patientEncounterData.encrypted_aes_key
            );
            if (!decryptPatientEncounterResult.success) {
              console.error('Failed to decrypt patient encounter name:', decryptPatientEncounterResult.error);
              patientEncounterData = { ...patientEncounterData, name: '[Decryption Failed]' };
            } else {
              // Remove encrypted fields before returning
              const { encrypted_name, encrypted_aes_key, iv, ...cleanPatientEncounterData } = patientEncounterData;
              patientEncounterData = cleanPatientEncounterData;
            }
          } catch (error) {
            console.error('Error decrypting patient encounter name:', error);
            const { encrypted_name, encrypted_aes_key, iv, ...cleanPatientEncounterData } = patientEncounterData;
            patientEncounterData = { ...cleanPatientEncounterData, name: '[Decryption Failed]' };
          }
        }

        // Return cleaned object with decrypted encounter
        const { db_created_at, db_updated_at, patientEncounterData: _, ...cleanRecording } = recording;
        return {
          ...cleanRecording,
          patientEncounter: patientEncounterData
        };
      }));
      console.timeEnd(perf('Decrypt paginated encounters'));

      return reply.status(200).send(result);
    } else {
      // Build unattached files array (files in storage but not in recordings table)
      console.time(perf('Build unattached Set'));
      const recordingPaths = new Set(recordingsData.map(r => r.recording_file_path));
      console.timeEnd(perf('Build unattached Set'));
      
      console.time(perf('Filter unattached files'));
      const unattachedFiles = [];
      for (const file of allStorageFiles) {
        const fullPath = `${userId}/${file.name}`;
        if (!recordingPaths.has(fullPath)) {
          unattachedFiles.push({
            path: fullPath,
            size: file.metadata?.size || null,
            created_at: file.created_at || null,
            updated_at: file.updated_at || null
          });
        }
      }
      console.timeEnd(perf('Filter unattached files'));
      console.log(`[getRecordingsAttachments] Found ${unattachedFiles.length} unattached files`);

      // Apply sorting based on sortBy parameter
      console.time(perf('Sort unattached files'));
      unattachedFiles.sort((a, b) => {
        let valueA, valueB;
        
        if (sortBy === 'name') {
          valueA = a.path || '';
          valueB = b.path || '';
          const comparison = valueA.localeCompare(valueB);
          return order === 'asc' ? comparison : -comparison;
        } else if (sortBy === 'created_at') {
          // Use storage timestamps for unattached files
          valueA = new Date(a.created_at || 0);
          valueB = new Date(b.created_at || 0);
        } else if (sortBy === 'updated_at') {
          // Use storage timestamps for unattached files
          valueA = new Date(a.updated_at || 0);
          valueB = new Date(b.updated_at || 0);
        }
        
        if (sortBy !== 'name') {
          const comparison = valueA - valueB;
          return order === 'asc' ? comparison : -comparison;
        }
        return 0;
      });
      console.timeEnd(perf('Sort unattached files'));

      // Apply pagination to unattached files
      console.time(perf('Slice unattached pagination'));
      const paginatedUnattached = unattachedFiles.slice(offsetNum, offsetNum + limitNum);
      console.timeEnd(perf('Slice unattached pagination'));
      console.log(`[getRecordingsAttachments] Paginated unattached to ${paginatedUnattached.length} records`);

      return reply.status(200).send(paginatedUnattached);
    }

    } finally {
      console.timeEnd(labelTotal);
    }

  } catch (error) {
    console.error('Error in getRecordingsAttachments:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Create a recording entry linked to a patient encounter
 * POST /api/recordings
 * Body: { patient_encounter_id, recording_file_path }
 */
export async function createRecording(request, reply) {
  try {
    // Check authentication
    const userId = request.user?.id;  // Supabase returns ID in 'id' property, not 'sub'
    if (!userId) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { patientEncounter_id, recording_file_path } = request.body;

    // Verify the encounter exists and belongs to this user
    const encounterData = await pgQueryOne(
      `SELECT id
         FROM "patientEncounters"
        WHERE id = $1 AND user_id = $2`,
      [patientEncounter_id, userId]
    );

    if (!encounterData) {
      console.error('[createRecording] No matching encounter found for id:', patientEncounter_id);
      return reply.status(404).send({ error: 'Patient encounter not found' });
    }

    // Create the recording entry
    const data = await pgQueryOne(
      `INSERT INTO recordings (
         user_id, "patientEncounter_id", recording_file_path, created_at
       ) VALUES ($1, $2, $3, NOW())
       RETURNING *`,
      [userId, patientEncounter_id, recording_file_path]
    );

    if (!data) {
      return reply.status(500).send({ error: 'Failed to create recording' });
    }

    console.log('[createRecording] Recording created successfully');
    return reply.status(201).send({
      status: 'success',
      data: data,
    });

  } catch (error) {
    console.error('Error in createRecording:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Get all recordings or single recording by ID
 * GET /api/recordings/:id (optional)
 */
export async function getRecordings(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const recordingId = request.params.id;

    // Single recording mode: Get by ID with signed URL generation
    if (recordingId) {
      const recording = await pgQueryOne(
        `SELECT *
           FROM recordings
          WHERE id = $1 AND user_id = $2`,
        [recordingId, userId]
      );

      if (!recording) {
        return reply.status(404).send({ error: 'Recording not found' });
      }

      // Check if we need to generate a new signed URL
      const needNewSignedUrl = !recording.recording_file_signed_url || 
                               new Date(recording.recording_file_signed_url_expiry) < new Date();

      if (recording.recording_file_path && needNewSignedUrl) {
        const normalizedPath = normalizeRecordingStorageKey(recording.recording_file_path);
        const expirySeconds = 60 * 60; // 1 hour expiry

        let signedUrl;
        try {
          signedUrl = await createRecordingDownloadUrl(supabase, normalizedPath, expirySeconds);
        } catch (signedError) {
          console.error('[getRecordings] Signed URL error:', signedError);
          return reply.status(500).send({ error: 'Failed to create signed URL' });
        }

        const now = new Date();
        const expiresAt = new Date(now.getTime() + expirySeconds * 1000).toISOString();

        const updateData = await pgQueryOne(
          `UPDATE recordings
              SET recording_file_signed_url = $1,
                  recording_file_signed_url_expiry = $2
            WHERE id = $3 AND user_id = $4
            RETURNING *`,
          [signedUrl, expiresAt, recording.id, userId]
        );

        if (!updateData) {
          console.error('[getRecordings] Error updating signed URL: no row updated');
          return reply.status(500).send({ error: 'Failed to update recording signed URL' });
        }

        return reply.status(200).send(updateData);
      }

      // Return existing data if signed URL is still valid
      return reply.status(200).send(recording);
    }

    // Batch mode: List all recordings for this user
    const data = await pgQueryRows(
      `SELECT *
         FROM recordings
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId]
    );

    return reply.status(200).send(data);
  } catch (error) {
    console.error('Error in getRecordings:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Delete a recording and its associated file (complete removal from DB + storage)
 * DELETE /api/recordings/complete/:id
 */
export async function deleteRecording(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const recordingId = request.params.id;

    if (!recordingId) {
      return reply.status(400).send({ error: 'Recording ID is required' });
    }

    // Fetch the recording to get the audio file path
    const recording = await pgQueryOne(
      `SELECT *
         FROM recordings
        WHERE id = $1 AND user_id = $2`,
      [recordingId, userId]
    );

    if (!recording) {
      return reply.status(404).send({ error: 'Recording not found' });
    }

    // Delete the file from storage if it exists
    if (recording.recording_file_path) {
      const storagePath = normalizeRecordingStorageKey(recording.recording_file_path);

      try {
        await deleteRecordingObject(supabase, storagePath);
      } catch (fileDeleteError) {
        console.error('[deleteRecording] Error deleting file:', fileDeleteError);
        // Don't fail if file deletion fails - the recording can still be deleted from DB
      }
    }

    // Delete the DB record
    const data = await pgQueryOne(
      `DELETE FROM recordings
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [recordingId, userId]
    );

    if (!data) {
      console.error('[deleteRecording] Error deleting recording: no row deleted');
      return reply.status(404).send({ error: 'Recording not found' });
    }

    return reply.status(200).send({ success: true, data });
  } catch (error) {
    console.error('Error in deleteRecording:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * ⚠️ UPDATE DISABLED - No updatable fields in recording schema
 * PATCH /api/recordings/:id
 * 
 * REASON: Recording schema has no user-editable fields:
 *   - 'recording_file_path': Immutable (set at upload time)
 *   - 'recording_file_signed_url': Generated server-side, not user-updatable
 *   - 'recording_file_signed_url_expiry': Generated server-side, not user-updatable
 *   - 'iv' / 'encrypted_aes_key': Immutable (encryption details)
 * 
 * TO ENABLE: First decide which fields should be user-editable and update database schema.
 * Currently recording updates are not supported.
 */
// export async function updateRecording(request, reply) {
//   try {
//     const supabase = getSupabaseClient(request.headers.authorization);
//     const user = request.user;
//
//     if (!user) {
//       return reply.status(401).send({ error: 'Unauthorized' });
//     }
//
//     const userId = user.id;
//     const recordingId = request.params.id;
//
//     if (!recordingId) {
//       return reply.status(400).send({ error: 'Recording ID is required' });
//     }
//
//     const { name, recording_file_path } = request.body || {};
//     const updateFields = {};
//
//     if (name) updateFields.name = name;
//     if (recording_file_path) updateFields.recording_file_path = recording_file_path;
//
//     if (Object.keys(updateFields).length === 0) {
//       return reply.status(400).send({ error: 'No valid fields to update' });
//     }
//
//     // Update the recording
//     // RLS policy ensures user can only update their own recordings
//     const { data: updatedData, error } = await supabase
//       .from(recordingTableName)
//       .update(updateFields)
//       .eq('id', recordingId)
//       .select()
//       .single();
//
//     if (error || !updatedData) {
//       console.error('[updateRecording] Error updating recording:', error);
//       return reply.status(404).send({ error: 'Recording not found' });
//     }
//
//     return reply.status(200).send({ success: true, data: updatedData });
//   } catch (error) {
//     console.error('Error in updateRecording:', error);
//     return reply.status(500).send({ error: 'Internal server error' });
//   }
// }

/**
 * Generate signed download URL for file access
 * POST /api/recordings/create-signed-url
 * 
 * Body:
 * - path: string (required, format: {userUUID}/{filename})
 * 
 * Returns:
 * - signedUrl: string (Supabase signed download URL, valid 1 hour)
 * - expiresIn: number (expiration time in seconds, 3600 = 1 hour)
 */
export async function createSignedUrl(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user || !user.id) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { path } = request.body;

    // Validate path format: should be userid/filename
    const pathParts = path.split('/');
    if (pathParts.length !== 2) {
      request.log.warn('[createSignedUrl] Invalid path format', {
        receivedPath: path,
        pathParts: pathParts.length,
        expected: 'userid/filename',
        userId: user.id,
      });
      return reply.status(400).send({ error: 'Invalid path format. Expected: userid/filename' });
    }

    const [pathUserId, filename] = pathParts;

    // Verify ownership: path folder must match user's UUID
    if (pathUserId !== user.id) {
      request.log.warn('[createSignedUrl] Ownership check failed', {
        userId: user.id,
        pathUserId: pathUserId,
        filename: filename,
        action: 'Access denied',
      });
      return reply.status(403).send({ error: 'Access denied: path does not belong to your account' });
    }

    // Validate filename is not empty
    if (!filename || filename.length === 0) {
      request.log.warn('[createSignedUrl] Empty filename', {
        path: path,
        userId: user.id,
      });
      return reply.status(400).send({ error: 'Invalid filename' });
    }

    const expirySeconds = 60 * 60; // 1 hour

    console.log(`[createSignedUrl] Generating signed URL for path: ${path}`);
    let signedUrl;
    try {
      signedUrl = await createRecordingDownloadUrl(supabase, path, expirySeconds);
    } catch (urlError) {
      console.error('[createSignedUrl] Error creating signed URL:', urlError);
      return reply.status(500).send({ error: 'Failed to generate signed URL' });
    }

    console.log('[createSignedUrl] Successfully generated signed URL:', {
      path: path,
      url: signedUrl?.substring(0, 100) + '...',
    });

    return reply.status(200).send({
      signedUrl,
      expiresIn: expirySeconds,
    });

  } catch (error) {
    console.error('Error in createSignedUrl:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Generate signed upload URL for file upload
 * POST /api/recordings/create-signed-upload-url
 * 
 * Body:
 * - filename: string (required, with extension)
 * 
 * Returns:
 * - success: boolean
 * - path: string (full storage path: userid/filename)
 * - filename: string (actual filename used, may differ if collision detected)
 * - signedUrl: string (Supabase signed upload URL, valid 2 hours)
 * - expiresAt: number (expiration time in seconds, 3600 = 1 hour)
 */
export async function uploadRecordingUrl(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user || !user.id || !user.email) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const { filename } = request.body;

    // Strip user.id prefix if filename already includes it (defensive fix for frontend sending full path)
    let cleanFilename = filename;
    if (filename.startsWith(user.id + '/')) {
      request.log.warn(`[uploadRecordingUrl] Filename includes user.id prefix, stripping it`, {
        originalFilename: filename,
        userId: user.id,
      });
      cleanFilename = filename.substring(user.id.length + 1); // +1 for the '/'
    }

    // Extract extension from filename
    const lastDot = cleanFilename.lastIndexOf('.');
    if (lastDot === -1) {
      return reply.status(400).send({ error: 'Filename must include extension' });
    }

    const extension = cleanFilename.substring(lastDot + 1).toLowerCase();
    const validExtensions = ['mp3', 'wav', 'webm', 'ogg', 'm4a', 'mp4'];

    if (!validExtensions.includes(extension)) {
      return reply.status(400).send({
        error: `Invalid file extension. Allowed: ${validExtensions.join(', ')}`
      });
    }

    // Collision detection: Try to find unused filename (10 attempts max)
    const userFolder = user.id;
    let finalFilename = cleanFilename;
    let collisionAttempt = 0;
    const maxAttempts = 10;

    for (collisionAttempt = 0; collisionAttempt < maxAttempts; collisionAttempt++) {
      const candidatePath = `${userFolder}/${finalFilename}`;
      try {
        const exists = await recordingObjectExists(supabase, candidatePath);
        if (!exists) {
          if (collisionAttempt > 0) {
            console.log(
              `[uploadRecordingUrl] Found available filename after ${collisionAttempt} collision(s):`,
              finalFilename
            );
          }
          break;
        }
      } catch (listError) {
        console.error(`[uploadRecordingUrl] Exists check error on attempt ${collisionAttempt + 1}:`, listError);
        return reply.status(500).send({ error: 'Storage check failed' });
      }

      // File exists, try with new random suffix
      console.log(`[uploadRecordingUrl] Collision attempt ${collisionAttempt + 1}: ${finalFilename} already exists`);

      if (collisionAttempt < maxAttempts - 1) {
        // Generate new random suffix and retry
        const nameParts = cleanFilename.split('.');
        const baseName = nameParts.slice(0, -1).join('.');
        const ext = nameParts[nameParts.length - 1];
        const randomSuffix = Math.floor(Math.random() * 100)
          .toString()
          .padStart(2, '0');
        finalFilename = `${baseName}-${randomSuffix}.${ext}`;
      }
    }

    if (collisionAttempt >= maxAttempts) {
      console.error(`[uploadRecordingUrl] Failed to find available filename after ${maxAttempts} attempts`);
      return reply.status(500).send({ error: 'Could not generate unique filename' });
    }

    const finalPath = `${userFolder}/${finalFilename}`;
    const contentType = recordingContentTypeForExtension(extension);

    console.log(`[uploadRecordingUrl] Creating signed upload URL for path: ${finalPath}`);
    let signedUrl;
    try {
      signedUrl = await createRecordingUploadUrl(supabase, finalPath, {
        contentType,
        expiresIn: 3600,
      });
    } catch (urlError) {
      console.error('[uploadRecordingUrl] Error creating signed upload URL:', urlError);
      return reply.status(500).send({ error: 'Failed to generate upload URL' });
    }

    console.log('[uploadRecordingUrl] Successfully generated signed upload URL:', {
      path: finalPath,
      signedUrl: signedUrl.substring(0, 100) + '...',
      collisionAttempts: collisionAttempt,
    });

    return reply.status(200).send({
      success: true,
      path: finalPath,
      filename: finalFilename,
      signedUrl: signedUrl,
      expiresAt: 3600, // Expected expiration time in seconds (1 hour)
    });

  } catch (error) {
    console.error('Error in uploadRecordingUrl:', error);
    request.log.error(`[uploadRecordingUrl] Exception caught:`, { message: error.message, stack: error.stack });
    return reply.status(500).send({ error: 'Internal server error' });
  }
}

/**
 * Delete storage files in bulk (storage only, no DB records deleted)
 * DELETE /api/recordings/storage
 * 
 * Body:
 * - prefixes: string[] (required, format: userid/filename)
 *
 * Returns (idempotent semantics):
 * - deleted: string[] (all successfully processed files - whether they existed or not)
 * - failed: string[] (files that failed deletion due to permission/auth errors)
 * - errors: Record<string, string> (error messages per failed prefix)
 * 
 * Note: Supabase .remove() is idempotent - non-existent files also return success.
 * Therefore, both existing files and non-existent files go to the "deleted" array.
 * Only permission errors go to "failed".
 */
export async function deleteRecordingsStorage(request, reply) {
  try {
    const supabase = getSupabaseClient(request.headers.authorization);
    const user = request.user;

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const userId = user.id;
    const { prefixes } = request.body;

    // Initialize result tracking
    const result = {
      deleted: [],
      failed: [],
      errors: {},
    };

    console.log(`[deleteRecordingsStorage] Processing ${prefixes.length} prefix(es) for user ${userId}`);

    // Process each prefix
    for (const prefix of prefixes) {
      try {
        // Validate prefix format (should be userid/filename)
        const pathParts = prefix.split('/');
        if (pathParts.length !== 2) {
          const errorMsg = 'Invalid path format. Expected: userid/filename';
          result.failed.push(prefix);
          result.errors[prefix] = errorMsg;
          console.warn(`[deleteRecordingsStorage] Invalid format: ${prefix}`);
          continue;
        }

        const [pathUserId, filename] = pathParts;

        // Verify ownership: path folder must match user's UUID
        if (pathUserId !== userId) {
          const errorMsg = 'Ownership check failed: path does not belong to your account';
          result.failed.push(prefix);
          result.errors[prefix] = errorMsg;
          console.warn(`[deleteRecordingsStorage] Ownership check failed for ${prefix}`, {
            userId,
            pathUserId,
          });
          continue;
        }

        // Validate filename is not empty
        if (!filename || filename.length === 0) {
          const errorMsg = 'Invalid filename';
          result.failed.push(prefix);
          result.errors[prefix] = errorMsg;
          console.warn(`[deleteRecordingsStorage] Empty filename in prefix: ${prefix}`);
          continue;
        }

        // Attempt to delete from storage
        console.log(`[deleteRecordingsStorage] Deleting: ${prefix}`);
        try {
          await deleteRecordingObject(supabase, prefix);
          result.deleted.push(prefix);
          console.log(`[deleteRecordingsStorage] Successfully processed: ${prefix}`);
        } catch (deleteError) {
          const errorMsg = deleteError instanceof Error ? deleteError.message : 'Storage error';
          result.failed.push(prefix);
          result.errors[prefix] = errorMsg;
          console.error(`[deleteRecordingsStorage] Storage error for ${prefix}:`, deleteError);
        }
      } catch (prefixError) {
        const errorMsg = prefixError.message || 'Unexpected error';
        result.failed.push(prefix);
        result.errors[prefix] = errorMsg;
        console.error(`[deleteRecordingsStorage] Exception for prefix ${prefix}:`, prefixError);
      }
    }

    console.log(`[deleteRecordingsStorage] Results:`, {
      deleted: result.deleted.length,
      failed: result.failed.length,
    });

    return reply.status(200).send(result);
  } catch (error) {
    console.error('Error in deleteRecordingsStorage:', error);
    return reply.status(500).send({ error: 'Internal server error' });
  }
}
