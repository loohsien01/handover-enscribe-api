import { z } from 'zod';

/**
 * User Security Config Schema
 * Stores RSA-wrapped AES master key per user for encrypting/decrypting sensitive data
 * System has a single entry with user_id = NULL for system templates
 * Each authenticated user has their own entry for user-created templates and notes
 * 
 * Database table structure:
 * - id: bigint (auto-generated)
 * - user_id: uuid (null for system-wide master key)
 * - wrapped_master_key: text (RSA-encrypted AES key in base64)
 * - created_at: timestamp
 * - updated_at: timestamp
 * 
 * Encryption flow:
 * 1. Generate random AES-256 key
 * 2. Encrypt it with RSA public key (wrapped_master_key)
 * 3. Store wrapped version in database
 * 4. When needed: Decrypt wrapped_master_key with RSA private key to get actual AES key
 * 5. Use AES key to encrypt/decrypt data (encrypted_details, details_iv, etc.)
 */

export const userSecurityConfigDatabaseSchema = z.object({
  wrapped_master_key: z
    .string()
    .min(1, { message: 'Wrapped master key is required' }),
}).strict();

/**
 * Note: There are typically TWO user security configs in the system:
 * 
 * 1. SYSTEM master key (user_id = NULL)
 *    - Encrypts/decrypts system-provided note template sections
 *    - Accessible via service role key
 *    - Example: system templates like "Chief Complaint", "Assessment", etc.
 * 
 * 2. USER master key (user_id = authenticated user's UUID)
 *    - One per user
 *    - Encrypts/decrypts user-created note template sections
 *    - Created on first use (lazy initialization)
 */
