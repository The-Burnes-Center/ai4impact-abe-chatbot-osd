# ABE — Assistive Buyers Engine

AI-powered procurement chatbot for Massachusetts OSD. Combines Bedrock Knowledge Base (semantic RAG over PDFs/policies) with structured Excel indexes (vendor/contract data) through an agentic tool-use loop.

## Stack

| Layer | Tech |
|-------|------|
| IaC | AWS CDK v2 (TypeScript) |
| Chat Lambda | Node.js 20 ESM + Bedrock streaming |
| Other Lambdas | Python 3.12 |
| LLM | Claude Sonnet 4 (primary), Claude 3.5 Haiku (fast) |
| Vector DB | OpenSearch Serverless (Titan Embed v2) |
| Data | DynamoDB (8 tables), S3 (6 buckets) |
| Auth | Cognito + WebSocket JWT authorizer |
| Frontend | React 18 + TypeScript + Vite + MUI v6 |
| CI/CD | GitHub Actions → CDK deploy on push to `main` |

## Commands

```bash
# Backend (CDK)
npm install
npm run build       # Compile TypeScript
npm run watch       # Watch mode
npm test            # Jest CDK snapshot tests

# Frontend
cd lib/user-interface/app
npm install
npm run dev         # Local dev server
npm run build       # Production build

# Deploy
npx cdk synth ABEStackNonProd          # Preview CloudFormation
npx cdk diff ABEStackNonProd           # Diff against deployed
npx cdk deploy ABEStackNonProd         # Deploy stack
npx cdk deploy ABEStackNonProd -c alarmEmail=you@example.com  # With alerts
```

## Architecture

### Chat Request Flow
1. Client connects via WebSocket → JWT Lambda authorizer validates Cognito token
2. Message → `getChatbotResponse` route → Chat Lambda ([index.mjs](lib/chatbot-api/functions/websocket-chat/index.mjs))
3. Agentic loop: Claude calls tools → Lambda processes → Claude refines → repeat until done
4. Available tools:
   - `query_db` — Bedrock KB semantic search (PDFs, policies)
   - `fetch_metadata` — S3 metadata.txt
   - `query_excel_index` — Structured DynamoDB queries (vendor/contract data)
5. Response streamed back via WebSocket; UI renders incrementally

### Two Separate Data Systems
| System | Bucket Path | Trigger | Storage | Tool |
|--------|-------------|---------|---------|------|
| Knowledge Base | `KnowledgeSourceBucket` | Manual "Sync" | OpenSearch | `query_db` |
| Excel Index | `indexes/{id}/latest.xlsx` | S3 event (automatic) | DynamoDB | `query_excel_index` |

**Critical:** Uploading an Excel file to the knowledge bucket does NOT populate the Excel index. They are independent pipelines.

### Key Files
| File | Role |
|------|------|
| [bin/gen-ai-mvp.ts](bin/gen-ai-mvp.ts) | CDK app entry point |
| [lib/constants.ts](lib/constants.ts) | Stack name, Cognito domain, OIDC name |
| [lib/gen-ai-mvp-stack.ts](lib/gen-ai-mvp-stack.ts) | Root stack — orchestrates all constructs |
| [lib/chatbot-api/functions/websocket-chat/index.mjs](lib/chatbot-api/functions/websocket-chat/index.mjs) | Chat handler + agentic tool-use loop |
| [lib/chatbot-api/functions/websocket-chat/prompt.mjs](lib/chatbot-api/functions/websocket-chat/prompt.mjs) | System prompt (cached at Bedrock ~4K tokens) |
| [lib/chatbot-api/functions/excel-index/parser/lambda_function.py](lib/chatbot-api/functions/excel-index/parser/lambda_function.py) | S3 trigger → parse .xlsx → DynamoDB |
| [lib/chatbot-api/functions/excel-index/query/lambda_function.py](lib/chatbot-api/functions/excel-index/query/lambda_function.py) | DynamoDB queries (filters, counts, sorts, distinct) |
| [lib/chatbot-api/tables/tables.ts](lib/chatbot-api/tables/tables.ts) | All 8 DynamoDB table definitions |
| [lib/chatbot-api/monitoring/monitoring.ts](lib/chatbot-api/monitoring/monitoring.ts) | CloudWatch dashboard + 8 alarms + SNS |
| [lib/user-interface/app/src/app.tsx](lib/user-interface/app/src/app.tsx) | React router + lazy-loaded pages |

## Key Conventions

### CDK
- Use `scope` (not `this`) when creating sub-resources inside constructs — preserves CloudFormation logical IDs and prevents accidental resource recreation
- All Lambdas use `LAMBDA_DEFAULTS` in [functions.ts](lib/chatbot-api/functions/functions.ts): ARM64, X-Ray, 1-month log retention
- Resources are separated by concern: `functions.ts`, `tables.ts`, `buckets.ts`
- cdk-nag compliance checks run on every synth; add suppressions with explicit reasons

### Python Lambdas
- Use Pydantic models for request/response validation
- Shared utilities (auth, logging, responses) live in the Lambda layer: [layers/python-common](lib/chatbot-api/functions/layers/python-common/)
- Return structured JSON error responses; catch exceptions explicitly

### Node.js Lambdas (ESM)
- All handlers use `.mjs` extension and ESM imports
- AWS SDK v3 modular imports (`@aws-sdk/client-*`)
- Bedrock streaming: parse events chunk-by-chunk; citations need custom validation

### Frontend
- Route-based code splitting via `React.lazy()` + `Suspense`
- API clients in [src/common/api-client/](lib/user-interface/app/src/common/api-client/)
- WebSocket chat logic in `useWebSocketChat` hook
- MUI v6 theming via [src/common/theme.ts](lib/user-interface/app/src/common/theme.ts)

## Environment Variables

### Lambda (set by CDK, override in console for testing)
| Variable | Default | Purpose |
|----------|---------|---------|
| `PRIMARY_MODEL_ID` | `us.anthropic.claude-sonnet-4-20250514-v1:0` | Chat + eval model |
| `FAST_MODEL_ID` | `us.anthropic.claude-3-5-haiku-20241022-v1:0` | Titles, metadata, FAQ |
| `GUARDRAIL_ID` | *(unset = disabled)* | Bedrock Guardrail |
| `KB_ID` | *(set by CDK)* | Knowledge Base ID |
| `TABLE_NAME` | *(set by CDK)* | Excel index DynamoDB table |

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

- **KB sync is manual:** No auto-sync when files are uploaded to the knowledge bucket. Admin must click "Sync data now" in the UI.
- **Excel index path:** Must be exactly `indexes/{index_id}/latest.xlsx` — other S3 paths are ignored by the parser.
- **DynamoDB schema changes:** Changing partition/sort keys requires table recreation. Use the `scope` pattern to avoid unintended logical ID changes.
- **System prompt caching:** Prompt is ~4K tokens, cached at Bedrock (5-min TTL). Modifying [prompt.mjs](lib/chatbot-api/functions/websocket-chat/prompt.mjs) invalidates the cache temporarily.
- **Max output tokens:** Set to 16,384 (lowered from Bedrock default to prevent truncation on long vendor lists).
- **Citation markers:** Self-managed `[N]` style; validation strips out-of-range indices. Native Bedrock citations are converted when available.
- **Model permissions:** IAM uses `foundation-model/anthropic.*` wildcard — allows model upgrades without redeploy but is intentionally broad.

## Monitoring

CloudWatch dashboard: `ABEStackNonProd-Operations`

8 active alarms (trigger SNS email):
- Lambda errors ≥ 3 | throttles ≥ 1 | chat duration > 60s
- API Gateway 5xx errors
- WebSocket zero connections
- DynamoDB throttles
- Step Functions evaluation failures

Deploy with `-c alarmEmail=you@example.com` to subscribe.

## Evaluation Pipeline

Admin-triggered Step Functions state machine:
1. Upload test cases → state machine starts
2. Batch test cases → parallel Docker Lambda (RAGAS 0.2.14)
3. Metrics: faithfulness, relevancy, precision, recall
4. Results stored in DynamoDB + S3

Positive user feedback (thumbs-up) auto-generates test cases via LLM rewriting — feedback flows into the test library.
