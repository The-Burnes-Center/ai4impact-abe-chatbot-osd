# Data ingestion: S3, knowledge base sync, and Excel indexes

Reference for how document and Excel data flow through the ABE chatbot stack—upload via admin UI vs direct S3, what updates automatically, and options for auto KB sync.

---

## Two separate systems

| Concern | Bucket | How chat uses it | Updates when |
|--------|--------|------------------|--------------|
| **KB documents** (PDFs, etc.) | **Knowledge bucket** (`KnowledgeSourceBucket`) | Bedrock Knowledge Base → OpenSearch retrieval | After **ingestion job** (“Sync data now”) |
| **Excel indexes** (structured vendor/contract data) | **Contract/index bucket** (`contractIndexBucket`) | `query_excel_index` tool → rows in **DynamoDB** | **S3 event** → parser Lambda (no KB sync) |

They are **not** interchangeable: putting a `.xlsx` only in the knowledge bucket does **not** populate the Excel index system.

---

## KB documents (knowledge bucket)

### Listing vs retrieval

- **Admin “Documents” tab** lists objects via **live S3** (`ListObjectsV2`). Add/delete in S3 (console or API) shows up on refresh—same as uploads through the presigned URL flow.
- **RAG / chat retrieval** uses the **vector index** built by Bedrock KB. The index **does not** update on every S3 change.

### Manual S3 changes

| Action | File list in UI | Chat / KB answers |
|--------|-----------------|-------------------|
| Upload (console or app) | Reflects S3 | New docs **not** searchable until sync |
| Delete | Reflects S3 | Stale chunks may appear **until next successful sync** |

The Data Dashboard warns when object `LastModified` is newer than the last completed KB sync (“Sync data now”).

### Upload Lambda behavior

Presigned upload only performs `PutObject` to the knowledge bucket; there is no separate document registry outside S3.

### Supported formats

Unsupported or failing types may be skipped or fail during ingestion; behavior depends on current Bedrock S3 data source support.

---

## Excel indexes (contract/index bucket)

### Key layout and trigger

- **Path pattern:** `indexes/{index_id}/latest.xlsx`
- **Parser trigger:** S3 notifications on the **index bucket**:
  - Events: `OBJECT_CREATED`, `OBJECT_REMOVED`
  - Filter: prefix `indexes/`, suffix `.xlsx`

The parser derives `index_id` from the path. Keys that do not match `indexes/{index_id}/...` are ignored (logged).

### Manual S3 upload/delete

| Action | Effect |
|--------|--------|
| Put/overwrite `indexes/{id}/latest.xlsx` | Parser runs → DynamoDB rows + registry update (same as in-app upload if path matches) |
| Delete that object | `ObjectRemoved` → parser clears DynamoDB for that index, sets NO_DATA, removes registry entry |

### Metadata (registry / tool description)

After a **successful** parse, `write_to_registry` runs:

- **AI-generated description** (Bedrock): generated when there is no existing `description` **and** there are **sample rows**. Empty sheets → no AI description. Bedrock failures → description may be empty.
- **Display name** from parser: derived from `index_id` (e.g. snake_case → Title Case), unless updated later via admin API (`PUT /admin/indexes/{id}`).

Creating an index first via **POST `/admin/indexes`** sets human-friendly `display_name` before upload; pure S3-only drops never run that step unless you edit via API later.

### Code pointers

- Parser + S3 delete handling: `lib/chatbot-api/functions/excel-index/parser/lambda_function.py`
- Registry + AI description: `lib/chatbot-api/functions/excel-index/parser/tool_registry.py`
- S3 event wiring: `lib/chatbot-api/functions/functions.ts` (`S3EventSource` on `contractIndexBucket`, `indexes/`, `.xlsx`)
- KB sync API: `lib/chatbot-api/functions/knowledge-management/kb-sync/lambda_function.py`

---

## Auto sync for KB documents (future / design)

**Today:** KB ingestion starts only from the manual **sync** endpoint (same as `StartIngestionJob`).

**Possible approach:** S3 events on the **knowledge** bucket → Lambda that calls `StartIngestionJob`.

**Caveats:**

- Only **one** ingestion job should run at a time per data source; the existing sync Lambda already checks for `IN_PROGRESS` / `STARTING`.
- Many rapid puts/deletes → many events → **debounce or coalesce** (e.g. SQS + batching, “pending sync” flag + scheduled runner, Step Functions wait window) to avoid redundant jobs and throttling.

**Excel:** Index bucket is already event-driven for `.xlsx` under `indexes/`; no Bedrock KB sync is required for that path.

---

## Quick checklist

1. **PDF in knowledge bucket** → run **KB sync** after changes if chat must see them.
2. **Excel index** → use **index bucket**, path `indexes/{index_id}/latest.xlsx`; parser runs automatically on create/update/delete.
3. **Don’t rely on KB** for Excel index data; **don’t rely on Excel parser** for PDFs in the index bucket layout.

---

*Last updated for repo context: March 2026.*
