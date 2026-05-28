# Data ingestion: S3, knowledge base sync, and Excel indexes

Reference for how document and Excel data flow through the ABE chatbot stack—upload via admin UI vs direct S3, what updates automatically, and how the staging/sync pipeline routes files.

---

## Two separate systems

| Concern | Bucket | How chat uses it | Updates when |
|--------|--------|------------------|--------------|
| **KB documents** (PDFs, etc.) | **Knowledge bucket** (`KnowledgeSourceBucket`) | Bedrock Knowledge Base → OpenSearch retrieval | After a **KB ingestion job** — started manually (“Sync data now”) or on the weekly schedule |
| **Excel indexes** (structured vendor/contract data) | **Contract index bucket** (`ContractIndexBucket`) | `query_excel_index` tool → rows in **DynamoDB** | **S3 event** → parser Lambda (no KB sync) |

They are **not** interchangeable: putting a `.xlsx` only in the knowledge bucket does **not** populate the Excel index system, and the two pipelines run independently.

> **Staging layer:** External data can also land in the **staging bucket** (`DataStagingBucket`) under `documents/` and `indexes/`. The sync orchestrator then routes those files to the knowledge bucket and contract index bucket respectively. See [Sync orchestrator](#sync-orchestrator-staging--kb--index) below.

---

## KB documents (knowledge bucket)

### Listing vs retrieval

- **Admin “Documents” tab** lists objects via **live S3** (`ListObjectsV2`). Add/delete in S3 (console or API) shows up on refresh—same as uploads through the presigned URL flow.
- **RAG / chat retrieval** uses the **vector index** built by Bedrock KB. The index **does not** update on every S3 change.

### Manual S3 changes

| Action | File list in UI | Chat / KB answers |
|--------|-----------------|-------------------|
| Upload (console or app) | Reflects S3 | New docs **not** searchable until sync |
| Delete **via admin UI** | Reflects S3 | KB chunks removed proactively before the S3 object is deleted, so the chatbot stops citing the file right away |
| Delete **directly in S3** (console/API) | Reflects S3 | Stale chunks may appear **until next successful sync**, since the KB-chunk cleanup step is skipped |

The admin Documents tab also shows a per-document **sync status** chip (synced / syncing / failed / not-yet-synced) sourced from Bedrock's `ListKnowledgeBaseDocuments`, so admins can see which uploads still need a sync.

### Upload / delete Lambda behavior

- **Upload:** the presigned-URL Lambda only performs `PutObject` to the knowledge bucket; there is no separate document registry outside S3. Writes to `metadata.txt` and any `indexes/...` key are rejected so an admin token can't clobber system-managed files.
- **Delete (admin UI):** the delete Lambda first calls Bedrock `DeleteKnowledgeBaseDocuments` to drop the file's chunks, then deletes the S3 object. If the chunk removal fails it aborts before deleting, so the file can be retried instead of leaving orphaned chunks in OpenSearch.

### Supported formats

Unsupported or failing types may be skipped or fail during ingestion; behavior depends on current Bedrock S3 data source support.

---

## Excel indexes (contract index bucket)

### Key layout and trigger

- **Path pattern:** `indexes/{index_id}/latest.xlsx`
- **Parser trigger:** S3 notifications on the **contract index bucket** (`ContractIndexBucket`):
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
- S3 event wiring: `lib/chatbot-api/functions/functions.ts` (`S3EventSource` on `props.contractIndexBucket`, events `OBJECT_CREATED` + `OBJECT_REMOVED`, filter prefix `indexes/` / suffix `.xlsx`)
- KB sync API: `lib/chatbot-api/functions/knowledge-management/kb-sync/lambda_function.py`
- Sync orchestrator (staging → KB/index + KB ingestion): `lib/chatbot-api/functions/sync-orchestrator/lambda_function.py`
- Sync schedule API + EventBridge management: `lib/chatbot-api/functions/sync-schedule/lambda_function.py`

---

## Sync orchestrator (staging → KB + index)

KB ingestion is **not** triggered by uploads to the knowledge bucket. It runs in two ways:

1. **Manual** — the admin "Sync data now" action (`POST /admin/sync-now`), which async-invokes the orchestrator. The older `sync-kb` endpoint also exists and just calls `StartIngestionJob` directly.
2. **Scheduled** — an EventBridge **Scheduler** rule invokes the orchestrator on a recurring cron. The default is **`cron(0 1 ? * SUN *)` in `America/New_York`** (every Sunday at 01:00 Eastern Time). The schedule is editable from the admin UI (`GET`/`PUT /admin/sync-schedule`), which can change the day/time or enable/disable it. Schedules created before the timezone switch are stored in UTC and shown as "legacy."

### What the orchestrator does

On each run, `SyncOrchestratorFunction` performs three steps and writes a history record:

1. **Documents** — moves every file from `staging/documents/` in the **staging bucket** to the **knowledge bucket** (copy then delete from staging).
2. **Index files** — moves every file from `staging/indexes/` to the **contract index bucket**, preserving the `indexes/{id}/latest.xlsx` key. The contract index bucket's own S3 event then fires the Excel parser automatically.
3. **KB ingestion** — starts a Bedrock KB ingestion job so the moved documents become searchable — **unless** a job is already `IN_PROGRESS` or `STARTING` (only one ingestion job should run at a time per data source).

It also backfills `metadata.txt` summaries for any KB-bucket file still missing one, and records the run (status, doc/index counts, duration, 90-day TTL via `expiresAt`) in `SyncHistoryTable`, viewable through `GET /admin/sync-history`.

### Notes

- **Direct admin uploads** through the Documents tab still go straight to the knowledge bucket via a presigned URL — they are **not** staged, so they only become searchable after the next manual or scheduled sync.
- **Excel:** the contract index bucket is already event-driven for `.xlsx` under `indexes/`; no Bedrock KB sync is required for that path. The orchestrator only *moves* staged index files into place — the parser runs off the resulting S3 event.

---

## Quick checklist

1. **PDF in knowledge bucket** → run **KB sync** (manual or wait for the weekly schedule) after changes if chat must see them.
2. **Excel index** → use the **contract index bucket**, path `indexes/{index_id}/latest.xlsx`; parser runs automatically on create/update/delete.
3. **Staging** → drop files under `staging/documents/` or `staging/indexes/` and let the sync orchestrator route them.
4. **Don't rely on KB** for Excel index data; **don't rely on the Excel parser** for PDFs.

---

*Last updated for repo context: May 2026.*
