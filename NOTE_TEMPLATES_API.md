# Note Templates API Documentation

## Authentication

All endpoints require Bearer token authentication via the `Authorization` header:

```
Authorization: Bearer <user_jwt_token>
```

---

## 1. Note Templates (Basic)

**Controller**: `src/fastify/controllers/noteTemplatesController.js`

### GET /api/note-templates

Fetch all templates for authenticated user (self-owned + system templates, where `user_id` is null)

- **Auth**: Required
- **Return**: Array of templates sorted by creation date (newest first)
- **Fields**: `id`, `name`, `user_id`, `created_at`, `updated_at`

**Response**:
```json
[
  {
    "id": "123456",
    "name": "Initial Appointment",
    "user_id": "uuid",
    "created_at": "2026-03-20T10:00:00Z",
    "updated_at": "2026-03-20T10:00:00Z"
  }
]
```

---

### GET /api/note-templates/:id

Fetch a single template

- **Auth**: Required
- **Params**: `id` (bigint)
- **Return**: Single template object
- **Error**: 404 if not found or unauthorized

**Response**:
```json
{
  "id": "123456",
  "name": "Initial Appointment",
  "user_id": "uuid",
  "created_at": "2026-03-20T10:00:00Z",
  "updated_at": "2026-03-20T10:00:00Z"
}
```

---

### POST /api/note-templates

Create a new template

- **Auth**: Required
- **Body**: `{ name: string }`
- **Return**: 201 with created template
- **Error**: 409 if name already exists for user

**Request**:
```json
{
  "name": "New Template"
}
```

**Response** (201):
```json
{
  "id": "123457",
  "name": "New Template",
  "user_id": "uuid",
  "created_at": "2026-03-20T11:00:00Z",
  "updated_at": "2026-03-20T11:00:00Z"
}
```

---

### PATCH /api/note-templates/:id

Update template (typically just the name)

- **Auth**: Required
- **Params**: `id` (bigint)
- **Body**: `{ name: string }` (partial updates)
- **Return**: 200 with updated template
- **Error**: 404 if not found, 409 if duplicate name

**Request**:
```json
{
  "name": "Updated Template Name"
}
```

**Response**:
```json
{
  "id": "123456",
  "name": "Updated Template Name",
  "user_id": "uuid",
  "created_at": "2026-03-20T10:00:00Z",
  "updated_at": "2026-03-20T11:30:00Z"
}
```

---

### DELETE /api/note-templates/:id

Delete a template

- **Auth**: Required
- **Params**: `id` (bigint)
- **Return**: 204 No Content
- **Error**: 404 if not found, 409 if template still has section links

---

## 2. Note Template Sections

**Controller**: `src/fastify/controllers/noteTemplateSectionsController.js`

**⚠️ Important**: Section details are **AES-256 encrypted** at rest. The API handles encryption/decryption automatically.

### GET /api/note-template-sections

Fetch all sections for authenticated user

- **Auth**: Required
- **Return**: Array of decrypted sections
- **Note**: System sections (system templates) are decrypted with system key; user sections with user's key
- **Fields**: `id`, `name`, `layout`, `details` (decrypted), `user_id`, `created_at`, `updated_at`

**Response**:
```json
[
  {
    "id": "456789",
    "name": "Chief Complaint",
    "layout": "full_width",
    "details": "Patient reports...",
    "user_id": "uuid (null if system template)",
    "created_at": "2026-03-20T10:00:00Z",
    "updated_at": "2026-03-20T10:00:00Z"
  }
]
```

---

### GET /api/note-template-sections/:id

Fetch a single section with decrypted details

- **Auth**: Required
- **Params**: `id` (bigint)
- **Return**: Single decrypted section
- **Error**: 404 if not found or unauthorized

**Response**:
```json
{
  "id": "456789",
  "name": "Chief Complaint",
  "layout": "full_width",
  "details": "Patient reports...",
  "user_id": "uuid (null if system template)",
  "created_at": "2026-03-20T10:00:00Z",
  "updated_at": "2026-03-20T10:00:00Z"
}
```

---

### POST /api/note-template-sections

Create a new section

- **Auth**: Required
- **Body**: 
  ```json
  {
    "name": "string (required)",
    "layout": "string (required, e.g., 'full_width', 'two_column')",
    "details": "string (optional, will be encrypted)"
  }
  ```
- **Return**: 201 with created section (details encrypted in response)
- **Error**: 409 if name already exists for user
- **Note**: User's master encryption key is auto-created if needed

**Request**:
```json
{
  "name": "Assessment",
  "layout": "full_width",
  "details": "Diagnosis and clinical findings go here"
}
```

**Response** (201):
```json
{
  "id": "456790",
  "name": "Assessment",
  "layout": "full_width",
  "details": "Diagnosis and clinical findings go here",
  "user_id": "uuid",
  "created_at": "2026-03-20T11:00:00Z",
  "updated_at": "2026-03-20T11:00:00Z"
}
```

---

### PATCH /api/note-template-sections/:id

Update a section

- **Auth**: Required
- **Params**: `id` (bigint)
- **Body**: Partial updates (example: `{ name: "new name" }` or `{ details: "new details" }`)
- **Return**: 200 with updated section
- **Error**: 404 if not found, 409 if duplicate name
- **Note**: If you update `details`, it will be re-encrypted with a new IV

**Request**:
```json
{
  "details": "Updated diagnosis information"
}
```

**Response**:
```json
{
  "id": "456790",
  "name": "Assessment",
  "layout": "full_width",
  "details": "Updated diagnosis information",
  "user_id": "uuid",
  "created_at": "2026-03-20T11:00:00Z",
  "updated_at": "2026-03-20T12:00:00Z"
}
```

---

### DELETE /api/note-template-sections/:id

Delete a section

- **Auth**: Required
- **Params**: `id` (bigint)
- **Return**: 204 No Content
- **Error**: 404 if not found, 409 if section is still linked to templates

---

## 3. Note Template Section Orders

**Controller**: `src/fastify/controllers/noteTemplateSectionOrdersController.js`

Manages the ordering of sections within templates. **Sections must have consecutive orders starting from 1.**

### GET /api/note-template-section-orders

Fetch all section orders for user's templates

- **Auth**: Required
- **Return**: Array of order records
- **Fields**: `id`, `noteTemplate_id`, `noteTemplateSection_id`, `order`

**Response**:
```json
[
  {
    "id": "1",
    "noteTemplate_id": "123456",
    "noteTemplateSection_id": "456789",
    "order": 1
  },
  {
    "id": "2",
    "noteTemplate_id": "123456",
    "noteTemplateSection_id": "456790",
    "order": 2
  }
]
```

---

### GET /api/note-template-section-orders/:id

Fetch a single order record

- **Auth**: Required
- **Params**: `id` (bigint)
- **Return**: Single order record
- **Error**: 404 if not found

**Response**:
```json
{
  "id": "1",
  "noteTemplate_id": "123456",
  "noteTemplateSection_id": "456789",
  "order": 1
}
```

---

### POST /api/note-template-section-orders

Add a section to a template (single record)

- **Auth**: Required
- **Body**:
  ```json
  {
    "noteTemplate_id": "bigint",
    "section_id": "bigint",
    "order": "int (must be next consecutive value)"
  }
  ```
- **Return**: 201 with created order
- **Error**: 400 if order is not consecutive, 404 if template/section not found
- **Note**: Useful for slowly adding sections. For batch reordering, use the PATCH endpoint instead.

**Request**:
```json
{
  "noteTemplate_id": "123456",
  "section_id": "456791",
  "order": 3
}
```

**Response** (201):
```json
{
  "id": "3",
  "noteTemplate_id": "123456",
  "noteTemplateSection_id": "456791",
  "order": 3
}
```

---

### PATCH /api/note-template-section-orders

Atomic batch reorder of all sections in a template

- **Auth**: Required
- **Body**:
  ```json
  {
    "noteTemplate_id": "bigint",
    "sections": [
      { "id": "bigint", "order": 1 },
      { "id": "bigint", "order": 2 },
      { "id": "bigint", "order": 3 }
    ]
  }
  ```
- **Return**: 200 with all new orders
- **Error**: 400 if any section not found or IDs are duplicates (entire operation rolls back - atomic)
- **Note**: This **deletes all existing orders** and replaces them. Perfect for drag-and-drop reordering.

**Request**:
```json
{
  "noteTemplate_id": "123456",
  "sections": [
    { "id": "456790", "order": 1 },
    { "id": "456789", "order": 2 },
    { "id": "456791", "order": 3 }
  ]
}
```

**Response**:
```json
{
  "noteTemplate_id": "123456",
  "sections": [
    {
      "id": "1",
      "noteTemplate_id": "123456",
      "noteTemplateSection_id": "456790",
      "order": 1
    },
    {
      "id": "2",
      "noteTemplate_id": "123456",
      "noteTemplateSection_id": "456789",
      "order": 2
    },
    {
      "id": "3",
      "noteTemplate_id": "123456",
      "noteTemplateSection_id": "456791",
      "order": 3
    }
  ]
}
```

---

## 4. Note Templates Complete ⭐ **[Most Important for Full Workflow]**

**Controller**: `src/fastify/controllers/noteTemplatesCompleteController.js`

These endpoints handle **atomic operations** on templates + sections + ordering together (via PostgreSQL RPCs).

### GET /api/note-templates/complete

Batch fetch templates with sections and pagination

- **Auth**: Required
- **Query Params**: 
  - `limit`: int (default: 20)
  - `offset`: int (default: 0)
  - `include_details`: boolean (default: false) - if true, includes decrypted section details
- **Return**: 
  ```json
  {
    "templates": [
      {
        "id": "bigint",
        "name": "string",
        "user_id": "uuid or null",
        "sections": [
          { id, name, layout, user_id, created_at, updated_at, details (optional) }
        ],
        "created_at": "timestamp",
        "updated_at": "timestamp"
      }
    ],
    "total": int
  }
  ```
- **Note**: By default (`include_details=false`), sections are returned **without** `details` field (fast, lightweight for lists). Add `?include_details=true` to include decrypted details.

**Response** (default, without details):
```json
{
  "templates": [
    {
      "id": "123456",
      "name": "Initial Appointment",
      "user_id": "uuid",
      "sections": [
        {
          "id": "456789",
          "name": "Chief Complaint",
          "layout": "full_width",
          "user_id": "uuid",
          "created_at": "2026-03-20T10:00:00Z",
          "updated_at": "2026-03-20T10:00:00Z"
        },
        {
          "id": "456790",
          "name": "Assessment",
          "layout": "full_width",
          "user_id": "uuid",
          "created_at": "2026-03-20T11:00:00Z",
          "updated_at": "2026-03-20T11:00:00Z"
        }
      ],
      "created_at": "2026-03-20T10:00:00Z",
      "updated_at": "2026-03-20T10:00:00Z"
    }
  ],
  "total": 1
}
```

**Response** (with `include_details=true`):
```json
{
  "templates": [
    {
      "id": "123456",
      "name": "Initial Appointment",
      "user_id": "uuid",
      "sections": [
        {
          "id": "456789",
          "name": "Chief Complaint",
          "layout": "full_width",
          "details": "Patient reports...",
          "user_id": "uuid",
          "created_at": "2026-03-20T10:00:00Z",
          "updated_at": "2026-03-20T10:00:00Z"
        },
        {
          "id": "456790",
          "name": "Assessment",
          "layout": "full_width",
          "details": "Diagnosis and findings...",
          "user_id": "uuid",
          "created_at": "2026-03-20T11:00:00Z",
          "updated_at": "2026-03-20T11:00:00Z"
        }
      ],
      "created_at": "2026-03-20T10:00:00Z",
      "updated_at": "2026-03-20T10:00:00Z"
    }
  ],
  "total": 1
}
```

---

### GET /api/note-templates/complete/:id ⭐ **[Most Common]**

Fetch a complete template with all sections and their ordering

- **Auth**: Required
- **Params**: `id` (bigint)
- **Return**:
  ```json
  {
    "template": { id, name, user_id, created_at, updated_at },
    "sections": [
      {
        "id": "bigint",
        "name": "string",
        "layout": "string",
        "details": "string (decrypted)",
        "user_id": "uuid or null",
        "created_at": "timestamp",
        "updated_at": "timestamp"
      }
    ]
  }
  ```
- **Error**: 403 if unauthorized, 404 if not found
- **Note**: Sections are returned **in order** as they appear in the template. Details are automatically decrypted.

**Response**:
```json
{
  "template": {
    "id": "123456",
    "name": "Initial Appointment",
    "user_id": "uuid",
    "created_at": "2026-03-20T10:00:00Z",
    "updated_at": "2026-03-20T10:00:00Z"
  },
  "sections": [
    {
      "id": "456789",
      "name": "Chief Complaint",
      "layout": "full_width",
      "details": "Patient reports...",
      "user_id": "uuid",
      "created_at": "2026-03-20T10:00:00Z",
      "updated_at": "2026-03-20T10:00:00Z"
    },
    {
      "id": "456790",
      "name": "Assessment",
      "layout": "full_width",
      "details": "Diagnosis and findings...",
      "user_id": "uuid",
      "created_at": "2026-03-20T11:00:00Z",
      "updated_at": "2026-03-20T11:00:00Z"
    }
  ]
}
```

---

### POST /api/note-templates/complete ⭐ **[Use This for Creating Templates]**

Atomically create a template with new and/or existing sections with ordering

- **Auth**: Required
- **Body**:
  ```json
  {
    "name": "string (required, must be unique per user)",
    "sections": [
      {
        "id": "bigint (optional - if present, links existing section)",
        "name": "string (required for new sections, optional for existing)",
        "layout": "string (required for new sections, optional for existing)",
        "details": "string (optional - will be encrypted for new sections)"
      }
    ]
  }
  ```
- **Return**: 201 with complete template object + sections
- **Error**: 400 if validation fails, 409 if name exists
- **Important**: 
  - **Mixed mode**: Sections with `id` link existing; sections without `id` create new
  - Sections are ordered in the array order (first = order 1, second = order 2, etc.)
  - If ANY section is invalid, the entire operation fails (atomic)
  - New sections are encrypted automatically

**Request** (Link existing sections):
```json
{
  "name": "Initial Appointment",
  "sections": [
    { "id": "456789" },
    { "id": "456790" },
    { "id": "456791" }
  ]
}
```

**Request** (Create new sections inline):
```json
{
  "name": "Follow-up Appointment",
  "sections": [
    {
      "name": "Chief Complaint",
      "layout": "full_width",
      "details": "Patient reports..."
    },
    {
      "name": "Assessment",
      "layout": "full_width",
      "details": "Diagnosis and findings..."
    },
    {
      "name": "Plan",
      "layout": "bullet points",
      "details": "Treatment plan..."
    }
  ]
}
```

**Request** (Mixed: link existing + create new):
```json
{
  "name": "Complete Visit",
  "sections": [
    { "id": "456789" },
    {
      "name": "New Assessment",
      "layout": "full_width",
      "details": "New section content..."
    },
    { "id": "456790" }
  ]
}
```

**Response** (201):
```json
{
  "template": {
    "id": "123456",
    "name": "Initial Appointment",
    "user_id": "uuid",
    "created_at": "2026-03-20T10:00:00Z",
    "updated_at": "2026-03-20T10:00:00Z"
  },
  "sections": [
    {
      "id": "456789",
      "name": "Chief Complaint",
      "layout": "full_width",
      "details": "Patient reports...",
      "user_id": "uuid",
      "created_at": "2026-03-20T10:00:00Z",
      "updated_at": "2026-03-20T10:00:00Z"
    },
    {
      "id": "456790",
      "name": "Assessment",
      "layout": "full_width",
      "details": "Diagnosis and findings...",
      "user_id": "uuid",
      "created_at": "2026-03-20T11:00:00Z",
      "updated_at": "2026-03-20T11:00:00Z"
    },
    {
      "id": "456791",
      "name": "Plan",
      "layout": "full_width",
      "details": "Treatment plan...",
      "user_id": "uuid",
      "created_at": "2026-03-20T11:30:00Z",
      "updated_at": "2026-03-20T11:30:00Z"
    }
  ]
}
```

---

### PATCH /api/note-templates/complete/:id ⭐ **[Use This for Updating Templates]**

Atomically update template name, section details, add new sections, and reorder sections

- **Auth**: Required
- **Params**: `id` (bigint)
- **Body** (all optional):
  ```json
  {
    "name": "string (new template name)",
    "sections": [
      {
        "id": "bigint (required - section ID to update or link)",
        "name": "string (optional - new section name)",
        "layout": "string (optional)",
        "details": "string (optional - new decrypted details)",
        "encrypted_details": "string (optional - if you have pre-encrypted data)"
      },
      {
        "name": "string (required for new sections - no id field)",
        "layout": "string (required for new sections)",
        "details": "string (optional - will be encrypted)"
      }
    ]
  }
  ```
- **Return**: 200 with updated complete template
- **Error**: 400 if validation fails, 403 if unauthorized, 404 if not found, 409 if duplicate name
- **Important**:
  - This is **atomic** — if any part fails, nothing is updated
  - **Mixed mode in sections array**: Objects with `id` update existing; objects without `id` create new
  - Array order determines final section ordering (1, 2, 3, ...)
  - If you provide `sections`, the **entire ordering is replaced** with the new section list
  - New sections are encrypted automatically

**Request** (Update name and reorder existing sections):
```json
{
  "name": "Follow-up Appointment",
  "sections": [
    { "id": "456790" },
    { "id": "456789" },
    { "id": "456791" }
  ]
}
```

**Request** (Update section details only):
```json
{
  "sections": [
    {
      "id": "456789",
      "details": "Updated chief complaint information"
    }
  ]
}
```

**Request** (Update name, add new sections, and reorder):
```json
{
  "name": "Comprehensive Visit",
  "sections": [
    { "id": "456790" },
    {
      "name": "Additional Notes",
      "layout": "full_width",
      "details": "New section created during update"
    },
    { "id": "456789" },
    { "id": "456791" }
  ]
}
```

**Response**:
```json
{
  "template": {
    "id": "123456",
    "name": "Follow-up Appointment",
    "user_id": "uuid",
    "created_at": "2026-03-20T10:00:00Z",
    "updated_at": "2026-03-20T12:00:00Z"
  },
  "sections": [
    {
      "id": "456790",
      "name": "Assessment",
      "layout": "full_width",
      "details": "Updated assessment",
      "user_id": "uuid",
      "created_at": "2026-03-20T11:00:00Z",
      "updated_at": "2026-03-20T12:00:00Z"
    },
    {
      "id": "456789",
      "name": "Chief Complaint",
      "layout": "full_width",
      "details": "Updated chief complaint",
      "user_id": "uuid",
      "created_at": "2026-03-20T10:00:00Z",
      "updated_at": "2026-03-20T12:00:00Z"
    },
    {
      "id": "456791",
      "name": "Plan",
      "layout": "full_width",
      "details": "Treatment plan...",
      "user_id": "uuid",
      "created_at": "2026-03-20T11:30:00Z",
      "updated_at": "2026-03-20T11:30:00Z"
    }
  ]
}
```

---

## Frontend Usage Patterns

### Typical Workflow: Create a Template with Sections

**Option A: Create sections first, then link them (traditional approach)**

1. Create sections individually:
   ```javascript
   POST /api/note-template-sections
   { name: "Chief Complaint", layout: "full_width", details: "..." }
   
   POST /api/note-template-sections
   { name: "Assessment", layout: "full_width", details: "..." }
   
   POST /api/note-template-sections
   { name: "Plan", layout: "full_width", details: "..." }
   ```

2. Link them to a new template:
   ```javascript
   POST /api/note-templates/complete
   { 
     name: "Initial Appointment",
     sections: [
       { id: section1_id },
       { id: section2_id },
       { id: section3_id }
     ]
   }
   ```

**Option B: Create template with inline new sections (faster)**

```javascript
POST /api/note-templates/complete
{
  name: "Initial Appointment",
  sections: [
    { name: "Chief Complaint", layout: "full_width", details: "..." },
    { name: "Assessment", layout: "full_width", details: "..." },
    { name: "Plan", layout: "full_width", details: "..." }
  ]
}
```

---

### Typical Workflow: Load a Template for Editing

```javascript
GET /api/note-templates/complete/:templateId
```

This gives you everything: template metadata + all sections with details (decrypted) in the correct order.

---

### Typical Workflow: Batch Load Templates (for List View)

```javascript
GET /api/note-templates/complete?limit=20&offset=0
```

By default returns templates with sections but **without** `details` field (fast, lightweight). Perfect for displaying a list of template names and section counts. No decryption overhead.

---

### Typical Workflow: Batch Load Templates (with Full Details)

```javascript
GET /api/note-templates/complete?limit=20&offset=0&include_details=true
```

Adds `include_details=true` to include decrypted section `details` in the response. Use this if you need to display section content previews or summaries alongside the template names.

---

### Typical Workflow: Reorder Sections (Drag & Drop)

```javascript
PATCH /api/note-templates/complete/:templateId
{
  "sections": [
    { "id": section3_id },
    { "id": section1_id },
    { "id": section2_id }
  ]
}
```

---

### Typical Workflow: Update Section Details

```javascript
PATCH /api/note-templates/complete/:templateId
{
  "sections": [
    { "id": section1_id, "details": "new content here" }
  ]
}
```

---

### Typical Workflow: Add New Sections to Existing Template

```javascript
PATCH /api/note-templates/complete/:templateId
{
  "sections": [
    { "id": existing_section_id },
    {
      "name": "New Section",
      "layout": "full_width",
      "details": "New content..."
    }
  ]
}
```

---

### Typical Workflow: Delete Template with Cleanup

1. Get the template to see all sections:
   ```javascript
   GET /api/note-templates/complete/:templateId
   ```

2. Delete the template:
   ```javascript
   DELETE /api/note-templates/:templateId
   ```

3. Optionally delete sections (if they're not used elsewhere):
   ```javascript
   DELETE /api/note-template-sections/:sectionId
   ```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Human-readable error message",
  "code": "ERROR_CODE (optional)",
  "field": "field_name (optional, if validation failed)",
  "expected": "value (optional, for ordering errors)"
}
```

### Common Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `DUPLICATE_NAME` | 409 | Template or section name already exists for this user |
| `RESOURCE_IN_USE` | 409 | Can't delete because it's referenced elsewhere |
| `Unauthorized` | 403 | User doesn't own this resource |
| `Not found` | 404 | Resource doesn't exist |
| Invalid ID format | 400 | ID is not a valid bigint |

---

## Key Notes for Frontend

1. **BigInt IDs**: Template and section IDs are bigints. In responses, they're converted to strings for JSON compatibility. Parse them as needed.

2. **Encryption**: Section `details` are encrypted at rest. The API handles all encryption/decryption automatically. You don't need to do anything — just send/receive plaintext `details` in your requests.

3. **Atomicity**: The "complete" endpoints use PostgreSQL RPC functions for atomic operations. If anything fails, nothing is applied.

4. **Section Ordering**: Orders must always be consecutive starting from 1. The backend validates this.

5. **System Templates**: Some sections/templates have `user_id: null` — these are system-provided. You can use them in your templates but can't modify them.

6. **Authorization**: RLS (Row Level Security) policies handle user data isolation at the database level. Even if you somehow get a reference to another user's data, the API will reject it.

7. **Response Consistency**: When you GET a complete template, sections are returned in the exact order they appear in the template. Use this order when displaying to users.

8. **Partial Updates**: Most endpoints support partial updates. Only include the fields you want to change.

9. **Batch Decryption Optimization**: The `GET /api/note-templates/complete` endpoint excludes section `details` by default (skips decryption for better performance on list views). Add `?include_details=true` to include decrypted details when you need them.

---

## Status Codes Reference

| Code | Meaning |
|------|---------|
| `200` | OK - Successful GET or PATCH |
| `201` | Created - Successful POST |
| `204` | No Content - Successful DELETE |
| `400` | Bad Request - Invalid parameters or validation failed |
| `401` | Unauthorized - Missing or invalid authentication token |
| `403` | Forbidden - User doesn't own this resource |
| `404` | Not Found - Resource doesn't exist |
| `409` | Conflict - Duplicate name or resource in use |
| `500` | Internal Server Error - Server-side issue |

---

## Quick Reference

| Operation | Endpoint | Method | Use When |
|-----------|----------|--------|----------|
| List templates | `/api/note-templates` | GET | Loading all templates |
| Get template details | `/api/note-templates/:id` | GET | Viewing basic template info |
| Create template | `/api/note-templates` | POST | Creating empty template |
| Update template | `/api/note-templates/:id` | PATCH | Changing template name only |
| Delete template | `/api/note-templates/:id` | DELETE | Removing a template |
| List sections | `/api/note-template-sections` | GET | Loading all sections |
| Get section | `/api/note-template-sections/:id` | GET | Viewing section details |
| Create section | `/api/note-template-sections` | POST | Creating a reusable section |
| Update section | `/api/note-template-sections/:id` | PATCH | Modifying section content |
| Delete section | `/api/note-template-sections/:id` | DELETE | Removing a section |
| **Batch templates** | `/api/note-templates/complete` | GET | Loading templates with pagination (default: no details; add `?include_details=true` for full content) |
| **Full template** | `/api/note-templates/complete/:id` | GET | **→ Use for editing** |
| **Create full** | `/api/note-templates/complete` | POST | **→ Use for new templates** |
| **Update full** | `/api/note-templates/complete/:id` | PATCH | **→ Use for all updates** |
| List orders | `/api/note-template-section-orders` | GET | Debugging ordering issues |
| Reorder sections | `/api/note-template-section-orders` | PATCH | **→ Use for drag-and-drop** |

---

## Recent Changes (March 24, 2026)

### Schema Changes
- **Removed `noteTemplates_id` from notes schema**: Notes are no longer directly linked to templates. Templates are used contextually through jobs/prompt-llm processing.

### RPC Error Code Handling
The `create_note_template_complete` and `update_note_template_complete` RPC functions now return structured error codes for consistent error handling:

| Error Code | HTTP Status | Meaning |
|---|---|---|
| `DUPLICATE_NAME` | 409 | Template or section name already exists for user |
| `SECTION_NOT_FOUND` | 404 | Referenced section not found or unauthorized |
| `TEMPLATE_NOT_FOUND` | 404 | Template not found or unauthorized |
| `INVALID_REQUEST` | 400 | Invalid request parameters (e.g., missing required fields) |
| `INTERNAL_ERROR` | 500 | Unexpected server error (transaction rolled back) |

**Example Error Response**:
```json
{
  "code": "DUPLICATE_NAME",
  "message": "A template with this name already exists for your account",
  "field": "name"
}
```

### Encryption Foundation
- Master key functions (`getSystemMasterKey()`, `getOrCreateUserMasterKey()`) are backend-only
- Handles both system templates (system key) and user templates (user-created key)
- Automatic AES-256 encryption/decryption of section details
- Encryption helpers in `src/utils/encryptionUtils.js` for consistent operations
