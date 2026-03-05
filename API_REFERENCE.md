# Enscribe API Reference

Complete API documentation for the Enscribe Fastify backend. All endpoints require authentication via Bearer token in the `Authorization` header, except where noted.

## All Available Endpoints

### Authentication (1 endpoint)
- `POST` `/api/auth` - Sign up, sign in, sign out, check validity, resend email

### Patient Encounters (9 endpoints)
- `GET` `/api/patient-encounters` - Get all patient encounters
- `POST` `/api/patient-encounters` - Create new patient encounter
- `GET` `/api/patient-encounters/:id` - Get single patient encounter
- `PATCH` `/api/patient-encounters/:id` - Update patient encounter
- `DELETE` `/api/patient-encounters/:id` - Delete patient encounter
- `GET` `/api/patient-encounters/complete/:id` - Get complete encounter bundle
- `POST` `/api/patient-encounters/complete` - Create complete encounter bundle
- `PATCH` `/api/patient-encounters/:id/transcript` - Update encounter transcript
- `PATCH` `/api/patient-encounters/:id/update-with-transcript` - Update encounter with transcript

### Recordings (5 endpoints)
- `GET` `/api/recordings/attachments` - Get recordings with attachment status
- `POST` `/api/recordings` - Create recording entry
- `GET` `/api/recordings` - Get all recordings
- `GET` `/api/recordings/:id` - Get single recording with signed URL
- `DELETE` `/api/recordings/:id` - Delete recording and file

### Transcripts (5 endpoints)
- `GET` `/api/transcripts` - Get all transcripts
- `GET` `/api/transcripts/:id` - Get single transcript
- `POST` `/api/transcripts` - Create transcript
- `PATCH` `/api/transcripts/:id` - Update transcript
- `DELETE` `/api/transcripts/:id` - Delete transcript

### Dot Phrases (5 endpoints)
- `GET` `/api/dot-phrases` - Get all dot phrases
- `GET` `/api/dot-phrases/:id` - Get single dot phrase
- `POST` `/api/dot-phrases` - Create dot phrase
- `PATCH` `/api/dot-phrases/:id` - Update dot phrase
- `DELETE` `/api/dot-phrases/:id` - Delete dot phrase

### SOAP Notes (5 endpoints)
- `GET` `/api/soap-notes` - Get all SOAP notes
- `GET` `/api/soap-notes/:id` - Get single SOAP note
- `POST` `/api/soap-notes` - Create SOAP note
- `PATCH` `/api/soap-notes/:id` - Update SOAP note
- `DELETE` `/api/soap-notes/:id` - Delete SOAP note

### AWS PHI Masking (2 endpoints)
- `POST` `/api/aws/mask-phi` - Mask PHI in text using AWS Comprehend Medical
- `POST` `/api/aws/unmask-phi` - Unmask PHI tokens using entity data

### Deepgram Transcription (2 endpoints)
- `POST` `/api/deepgram/transcribe/complete` - Complete transcription pipeline (transcribe, expand, mask)
- `POST` `/api/transcripts/expand` - Test dot phrase expansion without transcription

### Health (1 endpoint)
- `GET` `/health` - Health check endpoint

**Total: 41 endpoints**

---