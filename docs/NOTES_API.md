# Notes API Documentation

## Overview

The Notes API provides CRUD operations for managing encrypted notes in the Enscribe system. All notes are encrypted at rest using the authenticated user's master key and automatically decrypted on retrieval.

**Base URL:** `/api/notes`

**Authentication:** All endpoints require a valid JWT token in the `Authorization` header.

---

## Authentication

All requests must include an `Authorization` header with a valid JWT token:

```
Authorization: Bearer <jwt_token>
```

---

## Data Structure

### Note Object

```json
{
  "id": "9223372036854775807",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "patientEncounter_id": "9223372036854775806",
  "text": "Actual note content (automatically decrypted)",
  "created_at": "2026-03-24T10:30:00Z",
  "updated_at": "2026-03-24T10:30:00Z"
}
```

**Fields:**
- `id` (string/bigint): Unique identifier for the note
- `user_id` (UUID): ID of the user who created the note
- `patientEncounter_id` (string/bigint, optional): Associated patient encounter ID
- `text` (string): Plaintext note content (automatically decrypted server-side before response)
- `created_at` (ISO 8601): Timestamp when note was created
- `updated_at` (ISO 8601): Timestamp when note was last updated

**Note:** Encryption fields (`encrypted_text`, `text_iv`) are stored in the database but are **never returned** in API responses. The server automatically decrypts the content and returns only the plaintext `text` field.

---

## Endpoints

### 1. Get All Notes

Retrieve all notes for the authenticated user with pagination support.

**Endpoint:** `GET /api/notes`

**Query Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | number | 100 | Maximum number of notes to return (must be positive) |
| `offset` | number | 0 | Number of notes to skip for pagination (must be ≥ 0) |
| `sortBy` | string | `created_at` | Field to sort by (e.g., `created_at`, `updated_at`, `id`) |
| `order` | string | `desc` | Sort order: `asc` or `desc` |

**Request Example:**

```bash
curl -X GET "https://api.example.com/api/notes?limit=50&offset=0&sortBy=created_at&order=desc" \
  -H "Authorization: Bearer <token>"
```

**Response:**

**Status:** `200 OK`

```json
[
  {
    "id": "9223372036854775807",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "patientEncounter_id": "9223372036854775806",
    "text": "Patient encounter summary",
    "created_at": "2026-03-24T10:30:00Z",
    "updated_at": "2026-03-24T10:30:00Z"
  },
  ...
]
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | Invalid limit parameter | limit is not a positive number |
| `400` | Invalid offset parameter | offset is negative or not a number |
| `401` | Unauthorized | Missing or invalid JWT token |
| `500` | Internal Server Error | Server-side encryption/decryption failure |

---

### 2. Get Single Note

Retrieve a specific note by ID.

**Endpoint:** `GET /api/notes/:id`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string/bigint | The note ID |

**Request Example:**

```bash
curl -X GET "https://api.example.com/api/notes/9223372036854775807" \
  -H "Authorization: Bearer <token>"
```

**Response:**

**Status:** `200 OK`

```json
{
  "id": "9223372036854775807",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "patientEncounter_id": "9223372036854775806",
  "text": "Patient encounter summary",
  "created_at": "2026-03-24T10:30:00Z",
  "updated_at": "2026-03-24T10:30:00Z"
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | Invalid note ID format | ID is not a valid bigint |
| `401` | Unauthorized | Missing or invalid JWT token |
| `404` | Note not found | Note doesn't exist or user doesn't have access |
| `500` | Internal Server Error | Server-side encryption/decryption failure |

---

### 3. Create Note

Create a new note for the authenticated user.

**Endpoint:** `POST /api/notes`

**Request Body:**

```json
{
  "text": "Note content here",
  "patientEncounter_id": "9223372036854775806"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | No | The plain text content of the note (will be encrypted) |
| `patientEncounter_id` | string/bigint | No | ID of associated patient encounter. Must belong to authenticated user |

**Request Example:**

```bash
curl -X POST "https://api.example.com/api/notes" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Patient reports mild headache. Prescribed ibuprofen.",
    "patientEncounter_id": "9223372036854775806"
  }'
```

**Response:**

**Status:** `201 Created`

```json
{
  "id": "9223372036854775808",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "patientEncounter_id": "9223372036854775806",
  "text": "Patient reports mild headache. Prescribed ibuprofen.",
  "created_at": "2026-03-24T10:30:00Z",
  "updated_at": "2026-03-24T10:30:00Z"
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | Encryption error | Failed to encrypt note text |
| `401` | Unauthorized | Missing or invalid JWT token |
| `404` | Patient encounter not found | Invalid patientEncounter_id or user doesn't own it |
| `500` | Internal Server Error | Database or encryption failure |

---

### 4. Update Note

Update an existing note's text content.

**Endpoint:** `PATCH /api/notes/:id`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string/bigint | The note ID to update |

**Request Body:**

```json
{
  "text": "Updated note content"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | No | Updated plain text content (will be re-encrypted) |

**Request Example:**

```bash
curl -X PATCH "https://api.example.com/api/notes/9223372036854775808" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Updated: Patient reports mild headache. Prescribed ibuprofen 400mg."
  }'
```

**Response:**

**Status:** `200 OK`

```json
{
  "id": "9223372036854775808",
  "user_id": "550e8400-e29b-41d4-a716-446655440000",
  "patientEncounter_id": "9223372036854775806",
  "text": "Updated: Patient reports mild headache. Prescribed ibuprofen 400mg.",
  "created_at": "2026-03-24T10:30:00Z",
  "updated_at": "2026-03-24T10:35:00Z"
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | Invalid note ID format | ID is not a valid bigint |
| `400` | Encryption error | Failed to encrypt updated text |
| `401` | Unauthorized | Missing or invalid JWT token |
| `404` | Note not found | Note doesn't exist or user doesn't have access |
| `500` | Internal Server Error | Database or encryption failure |

---

### 5. Delete Note

Delete a specific note permanently.

**Endpoint:** `DELETE /api/notes/:id`

**Path Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string/bigint | The note ID to delete |

**Request Example:**

```bash
curl -X DELETE "https://api.example.com/api/notes/9223372036854775808" \
  -H "Authorization: Bearer <token>"
```

**Response:**

**Status:** `200 OK`

```json
{
  "success": true,
  "data": {
    "id": "9223372036854775808",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "patientEncounter_id": "9223372036854775806",
    "text": "Updated: Patient reports mild headache. Prescribed ibuprofen 400mg.",
    "created_at": "2026-03-24T10:30:00Z",
    "updated_at": "2026-03-24T10:35:00Z"
  }
}
```

**Error Responses:**

| Status | Error | Cause |
|--------|-------|-------|
| `400` | Invalid note ID format | ID is not a valid bigint |
| `401` | Unauthorized | Missing or invalid JWT token |
| `404` | Note not found | Note doesn't exist or user doesn't have access |
| `500` | Internal Server Error | Database failure |

---

## Error Handling

All errors follow a consistent format:

```json
{
  "error": "Error message describing what went wrong"
}
```

### Common Error Status Codes

| Status | Meaning |
|--------|---------|
| `400` | Bad Request — Invalid parameters or decryption failure |
| `401` | Unauthorized — Missing or invalid authentication token |
| `404` | Not Found — Resource doesn't exist or user has no access |
| `500` | Internal Server Error — Server-side failure |

---

## Key Features

### Encryption

- All note text is encrypted using AES encryption with the user's master key
- Encryption/decryption happens automatically on the server
- Frontend receives **only** the decrypted `text` field in all responses
- Encryption fields (`encrypted_text`, `text_iv`) are **never returned** in API responses
- They are stored only in the database for persistence and security

### Pagination

- Use `limit` and `offset` parameters for pagination
- Default limit is 100 notes per request
- Sorting is performed server-side for better performance

### Row-Level Security (RLS)

- Users can only access their own notes
- RLS policies enforced at the database level
- Attempting to access another user's notes returns 404

### Batch Decryption

- Notes are decrypted in batches of 10 for optimal performance
- Large note collections are retrieved without timeout issues

---

## Usage Examples

### JavaScript (Fetch API)

```javascript
// Get all notes
const response = await fetch('/api/notes?limit=50&offset=0', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const notes = await response.json();

// Create a note
const createResponse = await fetch('/api/notes', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    text: 'New note content',
    patientEncounter_id: '9223372036854775806'
  })
});
const newNote = await createResponse.json();

// Update a note
const updateResponse = await fetch(`/api/notes/${noteId}`, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    text: 'Updated content'
  })
});
const updatedNote = await updateResponse.json();

// Delete a note
const deleteResponse = await fetch(`/api/notes/${noteId}`, {
  method: 'DELETE',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
const result = await deleteResponse.json();
```

### React Hooks Example

```javascript
import { useState, useEffect } from 'react';

function useNotes(token) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);

  const fetchNotes = async (limit = 100, offset = 0) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/notes?limit=${limit}&offset=${offset}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      setNotes(data);
    } catch (error) {
      console.error('Failed to fetch notes:', error);
    } finally {
      setLoading(false);
    }
  };

  const createNote = async (text, patientEncounterId) => {
    const response = await fetch('/api/notes', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, patientEncounter_id: patientEncounterId })
    });
    const newNote = await response.json();
    setNotes([newNote, ...notes]);
    return newNote;
  };

  const updateNote = async (id, text) => {
    const response = await fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text })
    });
    const updatedNote = await response.json();
    setNotes(notes.map(n => n.id === id ? updatedNote : n));
    return updatedNote;
  };

  const deleteNote = async (id) => {
    await fetch(`/api/notes/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    setNotes(notes.filter(n => n.id !== id));
  };

  return { notes, loading, fetchNotes, createNote, updateNote, deleteNote };
}
```

---

## Rate Limiting & Performance

- No explicit rate limiting currently enforced
- Recommended: Keep `limit` ≤ 500 for optimal response times
- Use pagination (`offset`) for large datasets
- Batch decryption handles up to 100+ notes efficiently

---

## Security Considerations

1. **Always use HTTPS** in production
2. **Token Storage**: Store JWT tokens securely (HTTPOnly cookies recommended)
3. **Token Expiration**: Tokens should have reasonable expiration times
4. **CORS**: Frontend must be on allowed origin
5. **XSS Prevention**: Properly escape note content when displaying in UI
6. **Sensitive Data**: Never log or display encrypted values

---

## Support

For issues, questions, or feature requests related to the Notes API, contact the backend team or refer to the main README.md.
