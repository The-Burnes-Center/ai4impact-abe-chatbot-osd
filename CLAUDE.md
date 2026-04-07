# ABE — Assistive Buyers Engine

AI-powered procurement chatbot for Massachusetts OSD. Combines Bedrock Knowledge Base (semantic RAG over PDFs/policies) with structured Excel indexes (vendor/contract data) through an agentic tool-use loop.

## Stack

| Layer | Tech |
|-------|------|
| IaC | AWS CDK v2 (TypeScript) |
| Chat Lambda | Node.js 20 ESM + Bedrock streaming |
| Other Lambdas | Python 3.12 (23 total) |
| LLM | Claude Opus 4.6 (primary), Claude Sonnet 4.6 (fast) |
| Vector DB | OpenSearch Serverless (Titan Embed v2, 1024-dim) |
| Data | DynamoDB (13 tables), S3 (7 buckets), SQS (1 queue + DLQ) |
| Auth | Cognito + WebSocket JWT authorizer |
| Frontend | React 18 + TypeScript + Vite + MUI v6 |
| CI/CD | GitHub Actions → CDK deploy on push to `main` |

## Commands

```bash
# Backend (CDK)
npm install
npm run build        # Compile TypeScript
npm run watch        # Watch mode
npm test             # Jest CDK snapshot tests
npm run test:lambda  # Vitest websocket-chat unit tests

# Frontend
cd lib/user-interface/app
npm install
npm run dev          # Local dev server (port 3000)
npm run build        # Production build

# Deploy
npx cdk synth ABEStackNonProd          # Preview CloudFormation
npx cdk diff ABEStackNonProd           # Diff against deployed
npx cdk deploy ABEStackNonProd         # Deploy stack
npx cdk deploy ABEStackNonProd -c alarmEmail=you@example.com  # With alerts
```

## Architecture

### Chat Request Flow
1. Client connects via WebSocket → JWT Lambda authorizer validates Cognito token (signature, expiry, audience)
2. Message → `getChatbotResponse` route → Chat Lambda ([index.mjs](lib/chatbot-api/functions/websocket-chat/index.mjs))
3. Agentic loop (max 20 rounds): Claude calls tools → Lambda processes → Claude refines → repeat until done
4. Available tools:
   - `query_db` — Bedrock KB semantic search (25 results, confidence > 0.6)
   - `retrieve_full_document` — Full-document retrieval from KB by filename (all chunks, paginated, no truncation)
   - `fetch_metadata` — S3 metadata.txt (cached 5-min TTL)
   - `query_excel_index` — Structured DynamoDB queries (filters, counts, aggregations, sorts, distinct values)
5. Context management: keeps last 12 exchanges; auto-compresses at 120K tokens (75% of 160K limit)
6. Response streamed back via WebSocket with `!<|STATUS|>!`, `!<|EOF_STREAM|>!` protocol markers; UI renders incrementally
7. Prompt loaded from DynamoDB registry (with fallback to embedded default); template renders `{{current_date}}` and `{{metadata_json}}`

### Two Separate Data Systems
| System | Bucket Path | Trigger | Storage | Tool |
|--------|-------------|---------|---------|------|
| Knowledge Base | `KnowledgeSourceBucket` | Manual "Sync" or scheduled (Sunday 6 AM UTC) | OpenSearch (semantic chunking, 512 tokens, 95th-percentile breakpoint) | `query_db` |
| Excel Index | `indexes/{id}/latest.xlsx` | S3 event (automatic) | DynamoDB (`ExcelIndexDataTable`) | `query_excel_index` |

**Critical:** Uploading an Excel file to the knowledge bucket does NOT populate the Excel index. They are independent pipelines.

### Data Sync Pipeline
1. Files uploaded to `DataStagingBucket` (staging area)
2. `SyncOrchestratorFunction` copies docs → KB bucket, indexes → Contract index bucket
3. Triggers Bedrock KB ingestion job
4. Records history in `SyncHistoryTable` (TTL auto-cleanup via `expiresAt`)
5. Scheduled via EventBridge Scheduler (default: Sunday 6 AM UTC); configurable from admin UI

### Key Files
| File | Role |
|------|------|
| [bin/gen-ai-mvp.ts](bin/gen-ai-mvp.ts) | CDK app entry point + cdk-nag AwsSolutionsChecks |
| [lib/constants.ts](lib/constants.ts) | Stack name, Cognito domain, OIDC name |
| [lib/gen-ai-mvp-stack.ts](lib/gen-ai-mvp-stack.ts) | Root stack — orchestrates all constructs, applies tags, CDK nag suppressions |
| [lib/chatbot-api/index.ts](lib/chatbot-api/index.ts) | ChatBotApi construct — wires tables, buckets, OpenSearch, KB, APIs, Lambdas, routes, monitoring |
| [lib/chatbot-api/functions/functions.ts](lib/chatbot-api/functions/functions.ts) | All 23 Lambda definitions with `LAMBDA_DEFAULTS` (ARM64, X-Ray, 1-month logs) |
| [lib/chatbot-api/functions/websocket-chat/index.mjs](lib/chatbot-api/functions/websocket-chat/index.mjs) | Chat handler + agentic tool-use loop (max 20 rounds, streaming, context compression) |
| [lib/chatbot-api/functions/websocket-chat/prompt.mjs](lib/chatbot-api/functions/websocket-chat/prompt.mjs) | System prompt (cached at Bedrock ~4K tokens) |
| [lib/chatbot-api/functions/websocket-chat/tools.mjs](lib/chatbot-api/functions/websocket-chat/tools.mjs) | Tool definitions (static + dynamic Excel tool from registry), token estimation, result capping |
| [lib/chatbot-api/functions/websocket-chat/models/chat-model.mjs](lib/chatbot-api/functions/websocket-chat/models/chat-model.mjs) | Bedrock runtime wrapper: streaming, prompt caching, guardrails |
| [lib/chatbot-api/functions/websocket-chat/kb.mjs](lib/chatbot-api/functions/websocket-chat/kb.mjs) | Knowledge Base retrieval: semantic search + full-document retrieval + fuzzy filename resolution |
| [lib/chatbot-api/functions/websocket-chat/citations.mjs](lib/chatbot-api/functions/websocket-chat/citations.mjs) | Citation management: Bedrock native → [N] markers, validation, renumbering, sentence-boundary snapping |
| [lib/chatbot-api/functions/websocket-chat/prompt-registry.mjs](lib/chatbot-api/functions/websocket-chat/prompt-registry.mjs) | DynamoDB prompt registry: LIVE pointer → versioned templates, SHA256 hash change detection |
| [lib/chatbot-api/functions/excel-index/parser/lambda_function.py](lib/chatbot-api/functions/excel-index/parser/lambda_function.py) | S3 trigger → parse .xlsx → DynamoDB rows + auto-generate AI description via Bedrock |
| [lib/chatbot-api/functions/excel-index/query/lambda_function.py](lib/chatbot-api/functions/excel-index/query/lambda_function.py) | DynamoDB queries (filters, free-text fuzzy match, date ranges, aggregations, sorting, pagination) |
| [lib/chatbot-api/tables/tables.ts](lib/chatbot-api/tables/tables.ts) | All 13 DynamoDB tables + SQS queue definitions |
| [lib/chatbot-api/buckets/buckets.ts](lib/chatbot-api/buckets/buckets.ts) | All 7 S3 bucket definitions |
| [lib/chatbot-api/monitoring/monitoring.ts](lib/chatbot-api/monitoring/monitoring.ts) | CloudWatch dashboard + 20 alarms + SNS topic |
| [lib/chatbot-api/knowledge-base/knowledge-base.ts](lib/chatbot-api/knowledge-base/knowledge-base.ts) | Bedrock KB with semantic chunking (Titan Embed v2) |
| [lib/chatbot-api/opensearch/opensearch.ts](lib/chatbot-api/opensearch/opensearch.ts) | OpenSearch Serverless collection + security policies + vector index custom resource |
| [lib/chatbot-api/functions/step-functions/step-functions.ts](lib/chatbot-api/functions/step-functions/step-functions.ts) | Evaluation pipeline: Step Functions state machine + 6 eval-related Lambdas |
| [lib/authorization/index.ts](lib/authorization/index.ts) | Cognito User Pool + domain + client + WebSocket Lambda authorizer |
| [lib/user-interface/index.ts](lib/user-interface/index.ts) | CloudFront + S3 static site + BucketDeployment (builds React app) |
| [lib/user-interface/app/src/app.tsx](lib/user-interface/app/src/app.tsx) | React router + lazy-loaded pages |
| [lib/user-interface/app/src/components/app-configured.tsx](lib/user-interface/app/src/components/app-configured.tsx) | Auth gate: fetches aws-exports.json, configures Amplify, federated sign-in |
| [lib/user-interface/app/src/hooks/useWebSocketChat.ts](lib/user-interface/app/src/hooks/useWebSocketChat.ts) | WebSocket hook: auto-reconnect (3 attempts, exponential backoff), 90s timeout, protocol parsing |
| [lib/user-interface/app/src/common/theme.ts](lib/user-interface/app/src/common/theme.ts) | MUI theme with light/dark modes, CSS variables, responsive overrides |

## Key Conventions

### CDK
- Use `scope` (not `this`) when creating sub-resources inside constructs — preserves CloudFormation logical IDs and prevents accidental resource recreation
- All Lambdas use `LAMBDA_DEFAULTS` in [functions.ts](lib/chatbot-api/functions/functions.ts): ARM64, X-Ray, 1-month log retention
- Resources are separated by concern: `functions.ts`, `tables.ts`, `buckets.ts`
- cdk-nag compliance checks run on every synth; add suppressions with explicit reasons
- All DynamoDB tables: PAY_PER_REQUEST billing, PITR enabled, RETAIN removal policy
- Tags applied stack-wide: `Project: ABE`, `Environment: {stackId}`, `ManagedBy: CDK`, `DataClass: Sensitive`

### Python Lambdas
- Use Pydantic models for request/response validation
- Shared utilities (auth, logging, responses) live in the Lambda layer: [layers/python-common](lib/chatbot-api/functions/layers/python-common/)
- Return structured JSON error responses; catch exceptions explicitly
- Structured JSON logging with correlation IDs (session-based) for CloudWatch Insights

### Node.js Lambdas (ESM)
- All handlers use `.mjs` extension and ESM imports
- AWS SDK v3 modular imports (`@aws-sdk/client-*`)
- Bedrock streaming: parse events chunk-by-chunk; citations need custom validation
- Prompt caching: system prompt wrapped in `cache_control: { type: "ephemeral" }` (5-min TTL, up to 90% input token savings)
- Tool result capping: binary search to fit within 60K chars; rows truncated with note

### Frontend
- Route-based code splitting via `React.lazy()` + `Suspense`
- AppConfigured wrapper handles auth gate (Amplify + Cognito federated sign-in)
- API clients in [src/common/api-client/](lib/user-interface/app/src/common/api-client/) — 7 sub-clients (sessions, knowledgeManagement, userFeedback, evaluations, metrics, excelIndex, sync)
- WebSocket chat logic in `useWebSocketChat` hook (auto-reconnect, exponential backoff, 90s timeout)
- MUI v6 theming via [src/common/theme.ts](lib/user-interface/app/src/common/theme.ts) — light/dark modes with CSS variables
- Notification system via React Context (`notif-manager.tsx`) with auto-dismiss (success: 4s, info: 5s, error: 8s)
- ErrorBoundary wraps routes at multiple levels
- Vite build with manual chunk splitting: vendor-react, vendor-mui, vendor-charts

## DynamoDB Tables

| Table | PK | SK | GSIs | Purpose |
|-------|----|----|------|---------|
| ChatHistoryTable | user_id | session_id | TimeIndex | Chat sessions and history |
| UserFeedbackTable | Topic | CreatedAt | CreatedAtIndex, AnyIndex | User feedback submissions |
| FeedbackRecordsTable | FeedbackId | — | 5 GSIs (RecordType, ReviewStatus, Disposition, ClusterId, MessageId) | Detailed feedback with disposition tracking |
| ResponseTraceTable | MessageId | — | SessionCreatedAtIndex | Audit trail for LLM responses |
| PromptRegistryTable | PromptFamily | VersionId | — | Versioned system prompt management |
| MonitoringCasesTable | SetName | CaseId | SourceFeedbackIndex | Monitoring test cases |
| EvaluationResultsTable | EvaluationId | QuestionId | QuestionIndex | Per-question eval scores |
| EvaluationSummariesTable | PartitionKey | Timestamp | — | Aggregated eval summaries |
| AnalyticsTable | topic | timestamp | DateIndex, AgencyIndex | FAQ classification analytics |
| ExcelIndexDataTable | pk | sk | — | Parsed Excel contract data |
| IndexRegistryTable | pk | sk | — | Index definitions with AI descriptions |
| TestLibraryTable | PartitionKey | QuestionId | NormalizedQuestionIndex (KEYS_ONLY) | Test cases for evaluation |
| SyncHistoryTable | pk | sk | — | Sync run history (TTL: expiresAt) |

## S3 Buckets

| Bucket | Versioning | Purpose |
|--------|------------|---------|
| KnowledgeSourceBucket | Yes | KB documents (PDFs, policies) |
| FeedbackDownloadBucket | Yes | Feedback CSV exports |
| EvalResultsBucket | Yes | LLM evaluation results |
| EvalTestCasesBucket | Yes | Test case files (CSV/JSON) |
| RagasDependenciesBucket | Yes | RAGAS Docker image dependencies |
| ContractIndexBucket | No | Excel index files (`indexes/{id}/latest.xlsx`) |
| DataStagingBucket | No | Staging area for sync pipeline |

## Lambda Functions

### Core Chat (Node.js 20)
| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| ChatHandlerFunction | 512 MB | 5 min | Main chat LLM handler + agentic loop |
| GetS3FilesHandlerFunction | default | 30s | List/retrieve KB files |
| UploadS3FilesHandlerFunction | default | 30s | Upload KB files |
| ExcelIndexApiFunction | default | 30s | Index management API |
| SourcePresignFunction | default | 10s | Generate presigned S3 URLs |

### Core Chat Support (Python 3.12)
| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| SessionHandlerFunction | default | 30s | Session CRUD operations |
| FeedbackHandlerFunction | 256 MB | 30s | Feedback management + disposition + audit |
| ContextSummarizerFunction | default | 60s | Compress conversation history |
| FAQClassifierFunction | default | 30s | Classify questions into 10 categories |
| MetadataHandlerFunction | default | 30s | S3 trigger: auto-extract doc metadata via LLM |
| MetadataRetrievalFunction | default | 30s | Retrieve cached metadata.txt |

### Excel Index (Python 3.12)
| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| ExcelIndexParserFunction | 512 MB | 2 min | S3 trigger → parse .xlsx → DynamoDB + AI description |
| ExcelIndexQueryFunction | 256 MB | 30s | Filters, aggregations, free-text fuzzy search |

### Knowledge Management (Python 3.12)
| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| DeleteS3FilesHandlerFunction | default | 30s | Delete KB files (path traversal protection) |
| SyncKBHandlerFunction | default | 30s | Trigger Bedrock KB ingestion |
| SyncOrchestratorFunction | 256 MB | 5 min | Copy staging → KB/index buckets |
| SyncScheduleFunction | default | 30s | Manage EventBridge sync schedule |

### Evaluation Pipeline
| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| SplitEvalTestCasesFunction (Python) | default | 30s | Split test cases into chunks of 15 |
| GenerateResponseFunction (Node.js) | 512 MB | 60s | Generate LLM response for eval |
| LlmEvalFunction (Docker) | 10 GB | 15 min | RAGAS evaluation (max concurrency: 2) |
| AggregateEvalResultsFunction (Python) | 256 MB | 120s | Compute average metrics across chunks |
| LlmEvalResultsHandlerFunction (Python) | default | 30s | Write results to DynamoDB |
| LlmEvalCleanupFunction (Python) | default | 30s | Delete S3 evaluation artifacts |

### Test Library & Analytics (Python 3.12)
| Function | Memory | Timeout | Purpose |
|----------|--------|---------|---------|
| TestLibraryHandlerFunction | default | 30s | Test library CRUD with versioning |
| FeedbackToTestLibraryEnqueueFunction | default | 15s | Queue positive feedback for rewriting |
| FeedbackToTestLibraryProcessFunction | 256 MB | 90s | LLM-rewrite questions → test library (SQS-triggered) |
| EvalResultsHandlerFunction | default | 60s | Read eval summaries/results for admin dashboard |
| MetricsHandlerFunction (Python) | default | 30s | Analytics: sessions, agencies, FAQ breakdown |

## Environment Variables

### Lambda (set by CDK, override in console for testing)
| Variable | Default | Purpose |
|----------|---------|---------|
| `PRIMARY_MODEL_ID` | `us.anthropic.claude-opus-4-6-v1` | Chat + eval model |
| `FAST_MODEL_ID` | `us.anthropic.claude-sonnet-4-6` | Titles, metadata, FAQ classification |
| `GUARDRAIL_ID` | *(unset = disabled)* | Bedrock Guardrail |
| `GUARDRAIL_VERSION` | *(unset = disabled)* | Bedrock Guardrail version |
| `KB_ID` | *(set by CDK)* | Knowledge Base ID |
| `TABLE_NAME` | *(set by CDK)* | Excel index DynamoDB table |
| `PROMPT_REGISTRY_TABLE` | *(set by CDK)* | Versioned prompt storage |
| `PROMPT_FAMILY` | `ABE_CHAT` | Prompt registry partition key |
| `RESPONSE_TRACE_TABLE` | *(set by CDK)* | Audit trail table |
| `INDEX_REGISTRY_TABLE` | *(set by CDK)* | Excel index metadata/schema registry |

### Frontend (`.env` in `lib/user-interface/app/`)
```
AWS_PROJECT_REGION=
AWS_COGNITO_REGION=
AWS_USER_POOLS_ID=
AWS_USER_POOLS_WEB_CLIENT_ID=
API_DISTRIBUTION_DOMAIN_NAME=
RAG_ENABLED=true
```

## Constraints & Gotchas

- **KB sync is manual:** No auto-sync when files are uploaded to the knowledge bucket. Admin must click "Sync data now" in the UI (or wait for Sunday 6 AM UTC scheduled sync).
- **Excel index path:** Must be exactly `indexes/{index_id}/latest.xlsx` — other S3 paths are ignored by the parser.
- **DynamoDB schema changes:** Changing partition/sort keys requires table recreation. Use the `scope` pattern to avoid unintended logical ID changes.
- **System prompt caching:** Prompt is ~4K tokens, cached at Bedrock (5-min TTL). Modifying [prompt.mjs](lib/chatbot-api/functions/websocket-chat/prompt.mjs) invalidates the cache temporarily.
- **Prompt registry:** System prompt is loaded from DynamoDB (`PromptRegistryTable`) with LIVE pointer indirection. Code default is auto-synced via SHA256 hash comparison. Custom versions (created_by != "system") are preserved.
- **Max output tokens:** Set to 16,384 (lowered from Bedrock default to prevent truncation on long vendor lists).
- **Context limits:** Max estimated tokens = 160K; compression triggers at 120K (75%); aggressive trim at 5K chars per document when overflow detected.
- **Agentic loop cap:** Max 20 tool rounds per request; max 3 retries on transient Bedrock errors.
- **Citation markers:** Self-managed `[N]` style; validation strips out-of-range indices. Native Bedrock citations are converted and snapped to sentence boundaries.
- **Model permissions:** IAM uses `foundation-model/anthropic.*` wildcard — allows model upgrades without redeploy but is intentionally broad.
- **Tool result size:** Capped at 60K chars via binary search truncation; rows removed with "results truncated" note.
- **Excel query scans:** Full partition scan with in-code filtering — works for current data volumes but not indexed for scale.
- **WebSocket timeout:** Client-side 90s timeout hardcoded in `useWebSocketChat` hook; no server-side configuration.
- **CORS origin:** Uses Lazy CDK token pattern — CloudFront domain resolved at synth time, not construct time.

## Monitoring

CloudWatch dashboard: `ABEStackNonProd-Operations`

20 active alarms (trigger SNS email):
- **Lambda** (per function): errors >= 3 in 5 min | throttles >= 1 in 5 min | chat avg duration > 60s
- **API Gateway**: HTTP 5xx >= 10 in 5 min | HTTP 4xx >= 50 in 5 min (3 periods)
- **WebSocket**: zero connections for 15 min (potential outage)
- **DynamoDB** (per table): read throttles >= 5 in 5 min | write throttles >= 5 in 5 min
- **Step Functions**: evaluation pipeline failures >= 1

Dashboard rows: Lambda invocations/errors → chat latency (avg + p99) → HTTP API metrics → WebSocket + DynamoDB → eval pipeline + active alarms

Deploy with `-c alarmEmail=you@example.com` to subscribe.

## Evaluation Pipeline

Admin-triggered Step Functions state machine:

```
Split Test Cases → [Map: parallel eval, max 2 concurrent] → Aggregate Results → Save to DynamoDB → Cleanup S3
                          ↓ (on error)
                     Pass Error → Save partial results
```

1. Upload test cases (CSV/JSON with `question` + `expectedResponse` columns) → state machine starts
2. Split into chunks of 15 → saved to S3
3. Each chunk: generate LLM response → evaluate with RAGAS 0.2.14 Docker Lambda (10 GB memory, 15 min timeout)
4. **7 metrics computed:**
   - Similarity (semantic similarity via sentence-transformers)
   - Relevance (answer relevance to question)
   - Correctness (answer correctness vs. expected)
   - Context Precision (fraction of relevant context chunks)
   - Context Recall (fraction of gold context retrieved)
   - Response Relevancy (RAGAS metric)
   - Faithfulness (factual consistency with context)
5. Aggregate averages across chunks; validate scores in [0, 1] range
6. Results stored in DynamoDB (`EvaluationSummariesTable` + `EvaluationResultsTable`) + S3
7. Cleanup: delete chunks/, partial_results/, aggregated_results/ from S3

### Feedback-to-Test-Library Pipeline
Positive user feedback (thumbs-up) → SQS queue → LLM rewrites question to be standalone → upsert to `TestLibraryTable` with normalized question deduplication and version history.

## CI/CD

### Deploy (push to `main`)
1. Checkout → setup Node.js 20 + Python 3.12
2. AWS OIDC role assumption (no secrets stored)
3. Install dependencies (backend + frontend)
4. Run tests: `npm run test:lambda` (Vitest) + `pytest` (5 Python Lambda tests)
5. CDK bootstrap → wait for stack stability (up to 30 min) → `cdk deploy`
6. Upload stack outputs as artifact

### PR Check (pull requests)
1. Same setup + install
2. Run tests with coverage: 6 Python Lambda tests + frontend tests
3. Coverage artifacts uploaded; summary posted as PR comment
4. CDK diff posted as PR comment (first 300 lines)

### Test Coverage
| Lambda | Tests | Status |
|--------|-------|--------|
| websocket-chat (Node.js) | Vitest unit tests | Covered |
| excel-index/query | pytest with moto mock | Covered |
| excel-index/parser | pytest | Covered |
| metadata-retrieval | pytest (cache + filter) | Covered |
| metadata-handler | pytest | Covered |
| session-handler | pytest (basic CRUD) | Covered |
| websocket-api-authorizer | pytest (JWT validation) | Covered |
| feedback-handler | — | Not tested |
| evaluation pipeline (5 Lambdas) | — | Not tested |
| sync orchestrator/schedule | — | Not tested |
| metrics-handler | — | Not tested |
| context-summarizer | — | Not tested |

## Frontend Routes

```
/ → Landing page (no sidebar)
/about → Landing info (no sidebar)
/get-started → Landing start (no sidebar)

/chatbot/* (with sidebar)
  /playground/:sessionId → Chat UI
  /sessions → Sessions list

/admin/* (with sidebar)
  /data → Data management (documents, indexes, automation/sync)
  /user-feedback → Feedback manager
  /user-feedback/:feedbackId → Feedback details
  /metrics → Analytics dashboard (charts via @mui/x-charts)
  /llm-evaluation → Evaluations list
  /llm-evaluation/:evaluationId → Detailed evaluation

/help → Help/FAQ page
* → 404
```

### Frontend Component Hierarchy
```
AppConfigured (auth, theme, Amplify config)
  └─ App (React Router)
     ├─ LandingPage / LandingPageInfo / LandingPageStart
     └─ BaseAppLayout (header + drawer + content)
        ├─ GlobalHeader (logo, hamburger, user menu, theme toggle)
        ├─ NavigationPanel (new chat, sessions list, admin links)
        └─ Outlet
           ├─ Playground → Chat → ChatMessage[] + ChatInputPanel + useWebSocketChat
           ├─ SessionsPage
           └─ Admin pages (Data, Feedback, Metrics, Evaluations)
```
