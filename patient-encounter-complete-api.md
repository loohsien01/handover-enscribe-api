# Patient Encounter Complete API Documentation

## Overview

The `POST /api/patient-encounters/complete` and `GET /api/patient-encounters/complete/:id` endpoints have been updated to work with **notes** instead of the legacy **SOAP notes** and **transcripts**. This change simplifies the API and provides a more flexible note-taking system.

## Changes Summary

### Before (Legacy)
- Created **SOAP notes** (structured with subjective, objective, assessment, plan fields)
- Created **transcripts** (separate from notes)
- Complex encryption using encounter-specific AES keys

### After (New)
- Creates simple **notes** (text-based)
- No separate transcripts or SOAP notes
- Uses user master key encryption for notes
- Atomic SQL function for data consistency

---

## API Endpoints

### POST /api/patient-encounters/complete

Creates a complete patient encounter bundle with recording and note in a single atomic operation.

#### Request Body

```json
{
  "patientEncounter": {
    "name": "string (required) - Patient encounter name"
  },
  "recording": {
    "recording_file_path": "string (required) - Path to recording file in storage"
  },
  "note_text": "string (required) - Note text content"
}
```

#### Response (201 Created)

```json
{
  "patientEncounter": {
    "id": 123,
    "name": "Patient Name",
    "user_id": "uuid",
    "created_at": "2026-03-25T23:17:32.333282+00:00",
    "updated_at": "2026-03-25T23:17:32.333282+00:00"
  },
  "recording": {
    "id": 456,
    "recording_file_path": "path/to/recording.wav",
    "patientEncounter_id": 123,
    "user_id": "uuid",
    "created_at": "2026-03-25T23:17:32.333282+00:00"
  },
  "note": {
    "id": 789,
    "text": "This is the note text content.",
    "patientEncounter_id": 123,
    "user_id": "uuid",
    "created_at": "2026-03-25T23:17:32.333282+00:00",
    "updated_at": "2026-03-25T23:17:32.333282+00:00"
  }
}
```

#### Error Responses

- **400 Bad Request**: Missing required fields or validation error
- **401 Unauthorized**: Missing or invalid JWT token
- **500 Internal Server Error**: Database or encryption error

---

### GET /api/patient-encounters/complete/:id

Retrieves a complete patient encounter bundle including recording and notes.

#### URL Parameters

- `id` (number, required): Patient encounter ID

#### Response (200 OK)

```json
{
  "patientEncounter": {
    "id": 123,
    "name": "Patient Name",
    "user_id": "uuid",
    "created_at": "2026-03-25T23:17:32.333282+00:00",
    "updated_at": "2026-03-25T23:17:32.333282+00:00"
  },
  "recording": {
    "id": 456,
    "recording_file_path": "path/to/recording.wav",
    "patientEncounter_id": 123,
    "user_id": "uuid",
    "created_at": "2026-03-25T23:17:32.333282+00:00",
    "recording_file_signed_url": "https://...",
    "recording_file_signed_url_expiry": "2026-03-26T00:17:32.687Z"
  },
  "notes": [
    {
      "id": 789,
      "text": "This is the note text content.",
      "patientEncounter_id": 123,
      "user_id": "uuid",
      "created_at": "2026-03-25T23:17:32.333282+00:00",
      "updated_at": "2026-03-25T23:17:32.333282+00:00"
    }
  ]
}
```

#### Error Responses

- **400 Bad Request**: Invalid ID format
- **401 Unauthorized**: Missing or invalid JWT token
- **404 Not Found**: Patient encounter not found
- **500 Internal Server Error**: Database or decryption error

---

## Architecture

### Atomic SQL Function

The POST endpoint uses an atomic SQL function `create_patient_encounter_complete` that:
1. Inserts patient encounter with encrypted name
2. Inserts recording linked to encounter
3. Inserts note linked to encounter
4. Returns all created objects as JSON
5. Automatically rolls back on any error

### Encryption

- **Patient Encounter**: Encrypted using encounter-specific AES key
- **Recording**: IV stored for reference
- **Notes**: Encrypted using user's master key (different from encounter encryption)

### Data Flow

```
POST /complete                    GET /complete/:id
     |                                   |
     v                                   v
Pre-encrypt data              Fetch encounter + recording
     |                                   |
     v                                   v
Call SQL function             Fetch notes + decrypt
     |                                   |
     v                                   v
Atomic insert                 Generate signed URL
     |                                   |
     v                                   v
Decrypt response              Return bundle
```

---

## Migration Notes

### For Existing Integrations

1. **SOAP Notes**: The API no longer creates or returns SOAP notes. Legacy SOAP notes can still be accessed via `/api/soap-notes` endpoints.

2. **Transcripts**: Transcripts are no longer part of the complete bundle. Use the dedicated `/api/patient-encounters/:id/transcript` endpoints for transcript operations.

3. **Note Format**: Notes are now simple text instead of structured SOAP format. If you need structured notes, implement that logic client-side.

### Database Schema

The implementation uses three tables:
- `patientEncounters`: Stores encounter metadata with encrypted name
- `recordings`: Stores recording file paths linked to encounters
- `notes`: Stores note text linked to encounters (encrypted with user master key)

---

## Example Usage

### Create Complete Bundle

```javascript
const response = await fetch('/api/patient-encounters/complete', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`
  },
  body: JSON.stringify({
    patientEncounter: {
      name: 'John Doe - Initial Consultation'
    },
    recording: {
      recording_file_path: 'user-id/recording-123.wav'
    },
    note_text: 'Patient reports feeling well. Vital signs stable. Plan to continue current treatment.'
  })
});

const data = await response.json();
console.log('Created encounter:', data.patientEncounter.id);
console.log('Created note:', data.note.id);
```

### Retrieve Complete Bundle

```javascript
const response = await fetch(`/api/patient-encounters/complete/${encounterId}`, {
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

const data = await response.json();
console.log('Patient:', data.patientEncounter.name);
console.log('Recording:', data.recording.recording_file_signed_url);
console.log('Notes:', data.notes.map(n => n.text));
```

---

## Testing

Run the patient encounters test suite:

```bash
npm run test:patient-encounters
```

The test suite validates:
- Complete bundle creation with notes
- Note decryption in GET response
- Missing field validation
- Authentication requirements
- Proper encryption field cleanup

---

## Files Modified

- `src/fastify/controllers/patientEncountersController.js` - Updated GET and POST logic
- `src/fastify/schemas/requests.js` - Updated request schema
- `sql/functions/create_encounter_complete.sql` - Atomic SQL function
- `tests/patient-encounters.test.js` - Updated test suite

---

## Backward Compatibility

The legacy SOAP notes system remains functional via:
- `GET /api/soap-notes`
- `POST /api/soap-notes`
- `PATCH /api/soap-notes/:id`
- `DELETE /api/soap-notes/:id`

Transcript operations remain available via:
- `GET /api/patient-encounters/:id/transcript`
- `PATCH /api/patient-encounters/:id/transcript`
- `PATCH /api/patient-encounters/:id/update-with-transcript`
