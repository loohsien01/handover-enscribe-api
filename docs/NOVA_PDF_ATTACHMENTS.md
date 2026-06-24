# Nova PDF Attachments — Design (extract-first, no blob storage)

**Status:** 🔲 Planned — not implemented in `enscribe-api` yet.

**Parent doc:** [NOVA_AI_ARCHITECTURE.md](./NOVA_AI_ARCHITECTURE.md) (text-only chat today).

**Related prior art:** Note template PDF extract (`POST /api/note-templates/llm-extract`) uses Bedrock `document` content blocks with base64 PDF — see `getExtractNoteTemplateSectionsRequestBody` in `src/utils/claudeRequestBody.js`.

---

## Summary

Nova v1 attachments are **PDF-only**. The server does **not** persist PDF bytes. Instead:

1. User sends one turn with optional PDF + text question.
2. **Turn 0.5 (invisible):** Bedrock extracts a high-fidelity **document summary** from the PDF.
3. **Turn 1 (visible):** Normal Nova completion uses the persisted summary + user question; user sees one assistant reply.
4. **Re-open in UI:** filename chip opens the stored **document summary** (not the original PDF).

Memory for follow-ups is **text** (summary + assistant replies + rolling session summary). No Supabase Storage bucket for attachments in v1.

---

## Locked product decisions

| Topic | Decision |
|-------|----------|
| **File types** | PDF only (`application/pdf`); max size TBD (recommend **10 MB**, aligned with note-template extract). |
| **Durable storage** | **No PDF blob.** Persist encrypted **`document_summary`** + **`filename`** on the user message only. |
| **Ephemeral bytes** | PDF held in **Redis** keyed by completion `job_id` until extract succeeds or job fails (TTL ~30 min; same order of magnitude as completion partials). |
| **Jobs** | **One** completion job per user turn; processor runs **two Bedrock calls** when a new PDF is present (extract, then answer). |
| **User-visible transcript** | One user line + one assistant line per turn. Turn 0.5 is not a separate chat bubble (optional expandable “Document summary” on the user message). |
| **Re-open / download** | **No download API.** Tapping the filename shows **`document_summary`** read-only. Label clearly: not the original PDF. |
| **Follow-up turns** | Text-only Bedrock; inject relevant **`document_summary`** from prior user messages in the dialog tail (or merged session summary). **Do not** re-send PDF. |
| **Retry — extract failed** | Job `failed`; user **re-attaches PDF** manually (new send or explicit retry with file). |
| **Retry — main completion failed** | Same `client_message_id` + same message text → text-only retry using persisted **`document_summary`** (no PDF required). |
| **Multiple files** | v1: **one PDF per turn**. |
| **Billing** | TBD: one `NOVA_RESPONSE` per user-visible turn vs meter extract separately (recommend **one billable unit** per attachment turn for UX simplicity). |

---

## Open decisions (resolve before build)

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | **Extract model** | **Sonnet** for extract (fidelity); user-selected preset (haiku/sonnet/opus) for the visible reply. Override via env e.g. `NOVA_PDF_EXTRACT_BEDROCK_MODEL_ID`. |
| 2 | **Summary max length** | Cap extract output (e.g. **8k–12k chars**) with prompt instruction to prioritize completeness within cap; tune from real PDFs. |
| 3 | **Merge digest into `session.summary`?** | v1: keep on **user message**; inject into Bedrock on attachment turn + follow-ups. Optional v2: fold into rolling summary after first successful reply. |
| 4 | **Poll UX during extract** | Optional `phase: "extracting_document" \| "generating_reply"` on job poll while `running`. |
| 5 | **Persisted message encoding** | JSON string in encrypted `content` vs dedicated columns — prefer **encrypted JSON** in `content` for v1 (no migration) if schema allows structured parse on load. |

---

## Why extract-first (vs storing PDF)

| Approach | Pros | Cons |
|----------|------|------|
| **Store PDF blob** | Can re-inject exact bytes; best for narrow “page 7 footnote” Q&A | Bucket, lifecycle, ACLs, download policy, storage PHI |
| **Extract-first (this doc)** | No blob infra; clean retry after summary exists; fits text-only Nova stack | **Fidelity bounded by extract**; no pixel-perfect audit of source file |

Extract fidelity is the main product risk — mitigated by prompt design (below) and Sonnet for extract.

---

## Architecture

```
User: PDF + message
        │
        ▼
POST …/completions (multipart)
        │
        ├─ Validate PDF, write bytes → Redis nova:completion:attachment:{jobId}
        ├─ Persist user message (text + filename; document_summary null)
        └─ 202 + job id
        │
        ▼
novaChatCompletionProcessor (single job)
        │
        ├─ [0.5] If document_summary missing:
        │       Read PDF from Redis → Bedrock EXTRACT → persist document_summary on user row
        │       Delete Redis PDF blob
        │
        └─ [1] Bedrock COMPLETION (text + injected document_summary + user question)
                → persist assistant → complete job
        │
        ▼
Follow-up turns: text only; inject stored document_summary(ies) from session — no Redis, no PDF
```

### Context injection (completion turn)

```
FINAL_USER_PAYLOAD =
  Document summary (from attached {filename}):
  {document_summary}

  User question:
  {message}
```

Prior dialog tail remains plain text messages. Rolling **`session.summary`** unchanged unless we explicitly merge digest later.

### Follow-up turns

For each completion, if the dialog tail includes user messages with **`document_summary`**, prepend a compact block once (dedupe by attachment id or filename):

```
Reference — summaries of documents attached earlier in this thread:
- {filename}: {document_summary truncated if needed}
```

Truncation policy: prefer full summary for **one** recent attachment; cap total injected chars (env `NOVA_PDF_CONTEXT_MAX_CHARS`).

---

## API contract (planned)

### `POST /api/nova/chat-sessions/:chatId/completions`

**Content-Type:** `multipart/form-data` when PDF present; existing JSON body remains valid for text-only turns.

| Field | Required | Notes |
|-------|----------|--------|
| `model` | yes | `haiku` \| `sonnet` \| `opus` (reply turn) |
| `message` | yes | Non-empty user question |
| `client_message_id` | yes | UUID (existing idempotency) |
| `file` | no | PDF; required on **first** attempt for attachment turns |

**Text-only:** unchanged JSON body and behavior.

**Success:** still **202** + `{ id, status, chat_id }`; poll unchanged except optional `phase` (see open decisions).

### Session / message shape (API)

Extend user messages returned on `GET …/:chatId` and terminal completion poll:

```json
{
  "role": "user",
  "content": "What are the reimbursement terms?",
  "attachment": {
    "filename": "payer-contract.pdf",
    "document_summary": "… plaintext, PHI …"
  }
}
```

- **`document_summary`:** populated after extract succeeds; `null` or omitted while job in flight or if extract failed before persist.
- **Assistant messages:** unchanged (`content` string only).

**List endpoint** (`GET /api/nova/chat-sessions`): no change (metadata only).

### Error codes (planned)

| HTTP | `code` | When |
|------|--------|------|
| 400 | `NOVA_ATTACHMENT_REQUIRED` | Retry after extract failure without new PDF |
| 400 | `NOVA_ATTACHMENT_MISMATCH` | Same `client_message_id` but different file/hash vs first attempt |
| 400 | `NOVA_ATTACHMENT_INVALID` | Not PDF, empty, or over size limit |
| 500 | `NOVA_PDF_EXTRACT_FAILED` | Extract Bedrock or persist summary failed |
| 503 | `REDIS_UNAVAILABLE` | Attachment turn requires Redis for ephemeral PDF |

Existing completion codes (`NOVA_BEDROCK_FAILED`, `NOVA_CLIENT_MESSAGE_MISMATCH`, etc.) apply to the main reply step.

---

## Retry semantics

| Scenario | PDF in request? | Behavior |
|----------|-----------------|----------|
| First send with PDF | yes | Redis blob → extract → complete |
| Job `running` / `pending`, same `client_message_id` | no | **202** replay; poll (PDF still in Redis until extract finishes) |
| Extract failed | yes (manual) | New attempt or retry with file; no `document_summary` on message |
| Main completion failed, summary saved | **no** | Same `client_message_id` + same `message` → skip user append; processor skips extract; retries completion only |
| Job `complete`, same `client_message_id` | no | **200** idempotent replay (existing) |

**Idempotency:** store a content hash or size+filename on first upload; reject mismatched re-upload for same `client_message_id`.

---

## Summarization (rolling worker)

The summarize worker (`novaSummarizeService`) consumes **text only**. For attachment turns:

| Persisted in user `content` / attachment | Visible to summarizer |
|------------------------------------------|------------------------|
| User question text | yes |
| `[Attached: filename]` or filename in attachment metadata | yes (lightweight) |
| **`document_summary`** | **yes — primary source of document facts** |
| Assistant reply | yes |

**Risk:** double compression (extract summary → later rolling summary truncates detail). Mitigations:

1. Extract prompt asks for **dense, fact-complete** prose within cap.
2. Rolling summarize prompt: preserve **numbers, dates, drug names, clause refs, negations**.
3. Optional v2: after successful attachment reply, merge `document_summary` into `session.summary` under a labeled header and stop injecting full digest on every follow-up.

**Checkpointing:** unchanged — after summarize, older message pairs fold into `session.summary`; follow-ups rely on summary + tail, not PDF.

---

## Extract fidelity — prompt design (critical)

Turn 0.5 is the **only** time the model sees the PDF. The extract prompt must bias toward **recall over brevity** within the output cap.

### Design principles

1. **Completeness over polish** — prefer exhaustive bullets to narrative summary.
2. **Preserve literals** — copy exact **dollar amounts, percentages, dates, codes (CPT/ICD/NDC), drug names/doses, lab values, party names, section numbers**.
3. **Structure mirrors source** — headings / numbered sections when the PDF has them.
4. **Explicit uncertainty** — `[illegible]`, `[not stated]` instead of guessing.
5. **No advice** — extract only; no clinical or legal interpretation in turn 0.5.
6. **Tables** — row/column faithful markdown or labeled lists; do not drop rows.
7. **Negations and qualifiers** — “except”, “unless”, “prior authorization required” must appear.

### Suggested system prompt (extract pass)

```text
You extract text and facts from clinical and administrative PDF documents for a licensed healthcare professional's assistant.

Rules:
- Output PLAIN TEXT only (no JSON unless explicitly requested).
- Maximize factual recall: include every material term, number, date, name, dosage, code, and condition.
- Use section headings that match the document when possible.
- Use bullet lists for enumerations; preserve table content row-by-row.
- Quote short critical phrases verbatim in "quotes" when exact wording matters (e.g. legal clauses).
- Do NOT summarize away detail to be concise — prefer longer complete extraction up to the length limit.
- Do NOT add interpretation, recommendations, or information not present in the document.
- Mark missing or unreadable content as [not stated] or [illegible].
```

### Suggested user payload (extract pass)

Bedrock message: `document` block (PDF base64) + text:

```text
Extract a comprehensive factual digest of this PDF for later Q&A.

Include at minimum:
- Document type and purpose (if apparent)
- All parties, dates, and identifiers
- Financial terms (amounts, rates, caps, penalties)
- Clinical content (diagnoses, meds, allergies, labs, plans) if present
- Requirements, exclusions, prior auth, and deadlines
- Section/clause references for important statements

Target length: up to {MAX_CHARS} characters. If the document is longer, prioritize material terms and structured data over boilerplate.
```

### Model and parameters

| Knob | Suggestion |
|------|------------|
| Model | Sonnet (or env override); avoid Haiku for extract |
| `max_tokens` | High enough for cap (e.g. 4096–8192) |
| Output cap | Enforce in prompt + post-truncate with warning log if exceeded |

### Quality checks (implementation / ops)

- Golden tests on 2–3 representative PDFs (payer contract, lab report, prior auth).
- Compare extract against known anchor facts (manual checklist).
- Log extract char count and job duration; alert on very short extracts for large uploads.

---

## Completion pass prompt (turn 1)

After extract, the **visible** Nova reply should use existing Nova system preamble plus injected digest (see Context injection). Additional instruction for attachment turns:

```text
The user attached a PDF; you are given an extracted digest (not the raw file). Answer using the digest and conversation context. If the digest lacks information needed to answer precisely, say so and suggest what section of the document might contain it — do not invent facts.
```

User-selected `haiku` / `sonnet` / `opus` applies to this pass only unless product decides otherwise.

---

## Security & HIPAA

| Data | Treatment |
|------|-----------|
| PDF bytes in Redis | Plaintext, short TTL, user-scoped job key; same trust model as completion partials |
| **`document_summary`** | PHI; encrypt in `chat_messages` with user master key (same as message bodies) |
| **`filename`** | May contain PHI; store inside encrypted payload or as metadata with same encryption |
| Audit | Retain text digest + transcript; not original PDF bytes |

BAA coverage for Bedrock and Supabase applies; no attachment bucket in v1.

---

## Frontend integration (brief)

1. **Send:** multipart `POST …/completions` with `file` when user attaches PDF.
2. **While polling:** show user message + filename chip; optional “Analyzing document…” before `assistant_partial`.
3. **Re-open:** modal/panel with **`document_summary`**; copy: “Summary of attached document (original PDF is not stored).”
4. **Extract failure:** show error; prompt user to re-attach and send again.
5. **Follow-up:** normal text send; no file required.

See [NOVA_AI_ARCHITECTURE.md](./NOVA_AI_ARCHITECTURE.md) for poll intervals and `client_message_id` / sessionStorage recovery.

---

## Implementation checklist

### API / processor

- [ ] Multipart on `POST …/completions` (PDF optional); Zod + size/MIME validation
- [ ] Redis helper `nova:completion:attachment:{jobId}` (set/get/delete, TTL)
- [ ] `getNovaPdfExtractRequestBody` + `getNovaChatCompletionWithDocumentSummaryRequestBody` in `claudeRequestBody.js`
- [ ] Extend user message persist/load for `attachment` (encrypted JSON in content)
- [ ] Processor: extract branch → persist summary → delete Redis PDF → completion branch
- [ ] Retry: skip extract when `document_summary` present; require PDF when missing after extract failure
- [ ] Optional poll field `phase`
- [ ] Error codes above

### Tests

- [ ] Unit: extract request body shape; message parse with attachment
- [ ] Unit: processor skips extract on retry when summary exists
- [ ] Integration: multipart completion with mocked Bedrock (extract + reply)
- [ ] Golden: extract fidelity fixtures (manual or snapshot on anchor strings)

### Docs

- [ ] Update `NOVA_AI_ARCHITECTURE.md` implementation status + link here when shipped
- [ ] FE handoff section if API shape changes

---

## Explicitly out of scope (v1)

- Non-PDF formats (images, DOCX)
- Multiple PDFs per turn
- PDF download or preview
- Supabase Storage / S3 blob persistence
- Re-sending PDF on follow-up turns
- SSE/WebSocket for extract phase
- Structured JSON extract schema (plain text digest only for v1; align with future rolling-summary JSON if needed)

---

## References (code)

| Area | Path |
|------|------|
| Nova completion processor | `src/fastify/processors/novaChatCompletionProcessor.js` |
| Completion POST + retry | `src/fastify/controllers/novaChatSessionsController.js` |
| Bedrock request builders | `src/utils/claudeRequestBody.js` |
| PDF document block (templates) | `getExtractNoteTemplateSectionsRequestBody` |
| Multipart (server) | `src/fastify/server.js` (`@fastify/multipart`, 20 MB) |
| Rolling summarize | `src/utils/novaSummarizeService.js` |
| Completion partial Redis pattern | `src/utils/novaCompletionPartial.js` |
