Test Recording Files Placeholder
=================================

This folder contains test audio files used by the recordings API test suite.

FILES TO ADD:
- test-recording-attached-1.mp4 (will be attached to encounter 900)
- test-recording-attached-2.mp4 (will be attached to encounter 901)
- test-recording-attached-3.mp4 (will be attached to encounter 902)
- test-recording-unattached-1.mp4 (will be unattached)
- test-recording-unattached-2.mp3 (will be unattached)

HOW IT WORKS:
1. Add your test audio files to this folder (any format, dummy files are fine)
2. Run: npm run test:setup
3. The setup script will:
   - Read these files
   - Upload them to Supabase storage
   - Create test encounters and recordings
   - Save metadata to tests/testData.json (which will show actual online paths)
4. Run tests normally: npm run test:recordings
5. When done: npm run test:teardown (to clean up)

NOTES:
- Dummy audio files (even 1KB text files with .mp3 extension) work fine for testing
- The actual uploaded file paths will be different from local filenames
- All metadata is stored in testData.json after setup completes

UPLOADED FILE PATHS (Auto-populated after setup):
- test-recording-attached-1.mp4 → [Check testData.json after setup]
- test-recording-attached-2.mp4 → [Check testData.json after setup]
- test-recording-attached-3.mp4 → [Check testData.json after setup]
- test-recording-unattached-1.mp4 → [Check testData.json after setup]
- test-recording-unattached-2.mp3 → [Check testData.json after setup]

For actual paths, see: ../testData.json (created after npm run test:setup)


Test DotPhrases Placeholder
============================

These trigger-expansion pairs are used by the GCP transcription tests to verify
dot phrase expansion works correctly.

DOTPHRASES TO ADD:

dotPhrase 1:
  TRIGGER=pt
  EXPANSION=patient

dotPhrase 2:
  TRIGGER=pts
  EXPANSION=parts

HOW IT WORKS:
1. Add trigger/expansion pairs to this section above
2. Run: npm run test:setup
3. The setup script will:
   - Read these dotPhrases from this file
   - Create them via the API endpoint
   - Save metadata to tests/testData.json
4. Run GCP tests: npm run test:gcp
5. Tests will read from testData.json and verify expansion works

CREATED DOTPHRASES (Auto-populated after setup):
- pt → patient [Check testData.json after setup]
- pts → parts [Check testData.json after setup]

For actual paths, see: ../testData.json (created after npm run test:setup)
