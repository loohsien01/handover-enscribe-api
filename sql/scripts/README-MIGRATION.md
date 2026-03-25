# SOAP Notes → Notes Migration

This directory contains scripts for migrating data from the legacy `soapNotes` table to the new `notes` table.

## Overview

The migration consolidates SOAP note encryption and storage:

| Aspect | soapNotes | notes |
|--------|-----------|-------|
| **Encrypted Field** | `encrypted_soapNote_text` | `encrypted_text` |
| **IV Field** | `iv` | `text_iv` |
| **Encryption Key** | Patient encounter's AES key | User's master key |
| **Key Source** | `patientEncoountereters.encrypted_aes_key` | `userSecurityConfigs.wrapped_master_key` |
| **Key Decryption** | Via `patientEncounter_id` | Via `user_id` |

## Migration Script: `migrate-soapnotes-to-notes.js`

### Features

✅ **Optimal Performance**
- Fetches all soapNotes with patientEncounter data in single query
- Batch decryption (default: 10 notes per batch)
- Master key caching (no re-fetching per user)
- Batch insertion (50 records per insert)

✅ **Test Mode**
- Easy toggle: change `LIMIT = null` to `LIMIT = 10` at the top of the script
- Process only N records to validate logic before production run
- Clearly labeled as test mode in output

✅ **Audit CSV**
- **Raw soapNotes CSV** - Audit trail with: soapNoteId, patientEncounterId, iv, encrypted_aes_key, encrypted_soapNote_text

✅ **Safety First**
- Saves CSV audit trail before processing
- **Duplicate check before insert** - Skips notes if a record already exists (user_id + patientEncounter_id)
- Decrypts/validates before re-encrypting
- Skips notes that fail decryption
- Reports count of inserted vs. skipped migrations

✅ **Automatic Setup**
- Creates user master keys if they don't exist (lazy initialization)
- Uses service role key for database access

### Process Flow

```
1. FETCH all soapNotes + patientEncounter.encrypted_aes_key (single JOIN)
                    ↓
1.5. SAVE raw soapNotes to CSV (audit trail)
                    ↓
2. GET/CREATE user master keys (cached by user_id)
                    ↓
3. BATCH DECRYPT using patientEncounter's encrypted_aes_key
                    ↓
4. RE-ENCRYPT using user's master key
                    ↓
5. CHECK FOR DUPLICATES (by user_id + patientEncounter_id)
                    ↓
6. BATCH INSERT only new notes (50 per batch)
```

### Usage

**For Testing (first time):**
1. Edit the script and change line ~48: `const LIMIT = 10;` (process only 10 records)
2. Run: `node sql/scripts/migrate-soapnotes-to-notes.js`
3. Verify the audit CSV file has the right data
4. Check a few sample records were inserted in the notes table
5. Result will show: Processed, Inserted, and Skipped counts
6. Open an issue if something looks wrong

**For Production (after testing):**
1. Reset line ~48: `const LIMIT = null;` (process all records)
2. Run: `node sql/scripts/migrate-soapnotes-to-notes.js`
3. Script will safely skip any duplicates from re-runs
4. Check final counts in the output

```bash
# Quick test with 10 records
# Edit line ~48: const LIMIT = 10;
node sql/scripts/migrate-soapnotes-to-notes.js

# Full migration (after testing)
# Edit line ~48: const LIMIT = null;
node sql/scripts/migrate-soapnotes-to-notes.js
```

### Output

```
🔄 Starting SOAP Notes → Notes migration...

⚠️  TEST MODE: Limiting to 10 records only

📥 Step 1: Fetching all SOAP notes...
  ✓ Fetched 10 SOAP notes

💾 Step 1.5: Saving raw soapNotes to CSV (reference)...
  ✓ Raw data saved to test-results/migration-raw-soapnotes-1711234567890.csv
    → Columns: soapNoteId, patientEncounterId, encrypted_soapNote_text, iv, encrypted_aes_key

🔑 Step 2: Getting/creating user master keys...
  ⚙️  Fetching/creating master key for user-123-uuid...
    Creating new master key...
  ✓ Master key ready for user-123-uuid
  ✓ Master keys ready for 2 users

🔐 Step 3: Decrypting SOAP notes (batch size: 10)...
  ✓ Decrypted batch 1/1
  ✓ All 10 SOAP notes decrypted

🔐 Step 4: Re-encrypting with user master keys...
  ✓ Re-encrypted 10 notes

💾 Step 5: Saving backup to CSV...
  ✓ Backup saved to test-results/migration-backup-notes-1711234567891.csv

📤 Step 6: Inserting notes into database...
  ✓ Inserted batch 1/1 (10 records)

✅ Migration complete! Inserted 10 notes

📄 CSV Backups:
   Raw data (with encrypted_aes_key): test-results/migration-raw-soapnotes-1711234567890.csv
   Final notes (re-encrypted):        test-results/migration-backup-notes-1711234567891.csv

⚠️  TEST MODE: Only processed 10 records. Remove .limit() on line to process all.
```

### CSV Backup Format

**Raw soapNotes CSV** (`migration-raw-soapnotes-{timestamp}.csv`)

Audit trail for all soapNotes processed, with 5 columns:
- `soapNoteId` - soapNote ID
- `patientEncounterId` - Related encounter ID
- `iv` - Initialization vector used with patientEncounter's AES key
- `encrypted_aes_key` - The RSA-wrapped AES key needed to decrypt soapNote_text
- `encrypted_soapNote_text` - Original encrypted text (encrypted with patientEncounter's AES key)

**This CSV is useful for:**
- Audit trail of exactly what was fetched and when
- Reference if you need to manually decrypt specific notes
- Verification that the right IV and AES key are paired with the right encrypted text
- Troubleshooting if a decryption fails

**Location:** `test-results/` directory

### Error Handling

The script continues if individual notes fail, but reports:
- ✗ Missing `encrypted_aes_key` for a note
- ✗ Decryption failures (reports soapNote ID)
- ✗ Re-encryption failures
- ✗ Master key creation failures

**Note:** If master key creation fails, the script stops to prevent data loss.

### Prerequisites

- `.env.local` with:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `RSA_PRIVATE_KEY` (for decrypting patientEncounter's AES key)
  - `RSA_PUBLIC_KEY` (for encrypting user's master key)

### Rollback

If needed, restore from CSV:

```bash
# 1. Delete inserted notes (example query)
DELETE FROM notes WHERE created_at >= 'migration-start-timestamp';

# 2. Restore from CSV backup or re-run script with data integrity checks
```

### Testing

**Recommended first test:**

1. Open the script and find line ~48:
   ```javascript
   const LIMIT = null; // Change to 10 for testing
   ```

2. Change to:
   ```javascript
   const LIMIT = 10; // ← Test with 10 only
   ```

3. Run the script:
   ```bash
   node sql/scripts/migrate-soapnotes-to-notes.js
   ```

4. **Verify:**
   - Two CSV files were created in `test-results/`
   - First CSV contains raw soapNotes with `patientEncounter_encrypted_aes_key` visible
   - Second CSV contains re-encrypted notes data
   - 10 records were inserted in notes table
   - Check database: `SELECT COUNT(*) FROM notes WHERE created_at >= NOW() - INTERVAL '1 hour'`

5. **If all looks good:**
   - Reset line ~48 to `const LIMIT = null;`
   - Delete test records: `DELETE FROM notes WHERE created_at >= NOW() - INTERVAL '1 hour'`
   - Run full migration

6. **If something looks wrong:**
   - Leave test data in place
   - Check the CSV files for details
   - Open an issue with the CSV backup

## Files

- `migrate-soapnotes-to-notes.js` - Main migration script
- `../../test-results/` - CSV backups created here
- `../../src/utils/encryptionUtils.js` - Encryption utilities
- `../../src/fastify/schemas/userSecurityConfig.js` - User config schema

## Security Notes

- Private RSA keys are used only on the server (during decryption)
- User master keys are RSA-wrapped and stored safely
- Original soapNotes remain unchanged (migration is additive)
- CSV backup contains encrypted data (safe to store)
