/**
 * Lambda functions, event sources, and IAM policies for the ABE chatbot.
 *
 * Functions are grouped by domain:
 *
 *   Chat (core conversation)
 *     - ChatHandlerFunction             — WebSocket chat handler (Node.js, agentic tool loop)
 *     - SessionHandlerFunction          — CRUD for chat sessions/history
 *     - MetadataRetrievalFunction       — Fetches metadata.txt from KB bucket (invoked by chat)
 *     - SourcePresignFunction           — Generates pre-signed S3 URLs for source citations
 *     - FAQClassifierFunction           — Classifies questions by topic/agency for analytics
 *     - ContextSummarizerFunction       — Summarizes conversation context for long sessions
 *
 *   Knowledge Management
 *     - GetS3FilesHandlerFunction       — Lists/reads KB bucket contents for admin UI
 *     - UploadS3FilesHandlerFunction    — Handles admin file uploads to KB bucket
 *     - DeleteS3FilesHandlerFunction    — Handles admin file deletions from KB bucket
 *     - SyncKBHandlerFunction           — Triggers Bedrock KB ingestion job
 *     - MetadataHandlerFunction         — S3 event-driven: auto-generates metadata on upload/delete
 *
 *   Feedback
 *     - FeedbackHandlerFunction         — CRUD for feedback records + LLM analysis
 *
 *   Evaluation Pipeline
 *     - GetS3TestCasesFilesHandlerFunction  — Lists/reads test case files
 *     - UploadS3TestCasesFilesHandlerFunction — Uploads test case files
 *     - EvalResultsHandlerFunction      — Reads/manages evaluation results + can stop runs
 *     - TestLibraryHandlerFunction      — CRUD for reusable test cases
 *     - FeedbackToTestLibraryEnqueue    — Enqueues positive feedback for test case generation
 *     - FeedbackToTestLibraryProcess    — SQS consumer: LLM-rewrites feedback into test cases
 *     - StepFunctionsStack              — Orchestrates batch RAGAS evaluation
 *
 *   Excel Index (structured contract/vendor data)
 *     - ExcelIndexParserFunction        — S3 event-driven: parses .xlsx into DynamoDB
 *     - ExcelIndexQueryFunction         — DynamoDB query engine (filters, counts, sorts)
 *     - ExcelIndexApiFunction           — REST API gateway for index management
 *
 *   Sync (automated data pipeline)
 *     - SyncOrchestratorFunction        — Moves staged files to KB/index buckets + triggers ingestion
 *     - SyncScheduleFunction            — API for managing the EventBridge weekly schedule
 *     - WeeklySyncSchedule              — EventBridge cron (Sundays 6 AM UTC)
 *
 *   Metrics
 *     - MetricsHandlerFunction          — Reads session/analytics tables for admin dashboards
 */
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from "aws-cdk-lib/aws-s3";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { S3EventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { StepFunctionsStack } from './step-functions/step-functions';

interface LambdaFunctionStackProps {
  readonly wsApiEndpoint: string;
  readonly sessionTable: Table;
  readonly feedbackTable: Table;
  readonly feedbackRecordsTable: Table;
  readonly responseTraceTable: Table;
  readonly promptRegistryTable: Table;
  readonly monitoringCasesTable: Table;
  readonly feedbackBucket: s3.Bucket;
  readonly knowledgeBucket: s3.Bucket;
  readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  readonly knowledgeBaseSource: bedrock.CfnDataSource;
  readonly evalSummariesTable: Table;
  readonly evalResutlsTable: Table;
  readonly evalTestCasesBucket: s3.Bucket;
  readonly evalResultsBucket: s3.Bucket;
  readonly analyticsTable: Table;
  readonly contractIndexBucket: s3.Bucket;
  readonly excelIndexDataTable: Table;
  readonly indexRegistryTable: Table;
  readonly testLibraryTable: Table;
  readonly feedbackToTestLibraryQueue: sqs.Queue;
  readonly dataStagingBucket: s3.Bucket;
  readonly syncHistoryTable: Table;
}

/**
 * Shared defaults applied to every Lambda via spread: `...LAMBDA_DEFAULTS`.
 *   - ARM_64: Graviton — ~20% cheaper and faster for most workloads.
 *   - ACTIVE tracing: X-Ray enabled for end-to-end request tracing.
 *   - ONE_MONTH log retention: balances debuggability with cost; older logs
 *     are auto-deleted by CloudWatch.
 *
 * Individual functions override timeout and memorySize as needed.
 */
const LAMBDA_DEFAULTS: Partial<lambda.FunctionProps> = {
  architecture: lambda.Architecture.ARM_64,
  tracing: lambda.Tracing.ACTIVE,
  logRetention: logs.RetentionDays.ONE_MONTH,
};

export class LambdaFunctionStack extends Construct {
  public readonly chatFunction: lambda.Function;
  public readonly sessionFunction: lambda.Function;
  public readonly feedbackFunction: lambda.Function;
  public readonly deleteS3Function: lambda.Function;
  public readonly getS3Function: lambda.Function;
  public readonly uploadS3Function: lambda.Function;
  public readonly syncKBFunction: lambda.Function;
  public readonly metadataHandlerFunction: lambda.Function;
  public readonly getS3TestCasesFunction: lambda.Function;
  public readonly stepFunctionsStack: StepFunctionsStack;
  public readonly uploadS3TestCasesFunction: lambda.Function;
  public readonly handleEvalResultsFunction: lambda.Function;
  public readonly metricsHandlerFunction: lambda.Function;
  public readonly faqClassifierFunction: lambda.Function;
  public readonly contextSummarizerFunction: lambda.Function;
  public readonly excelIndexParserFunction: lambda.Function;
  public readonly excelIndexQueryFunction: lambda.Function;
  public readonly excelIndexApiFunction: lambda.Function;
  public readonly testLibraryFunction: lambda.Function;
  public readonly feedbackToTestLibraryEnqueueFunction: lambda.Function;
  public readonly feedbackToTestLibraryProcessFunction: lambda.Function;
  public readonly sourcePresignFunction: lambda.Function;
  public readonly syncOrchestratorFunction: lambda.Function;
  public readonly syncScheduleFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaFunctionStackProps) {
    super(scope, id);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate functions.

    // Shared Python layer: auth helpers, structured logging, JSON response builders.
    const pythonCommonLayer = new lambda.LayerVersion(scope, 'PythonCommonLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'layers/python-common')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Shared Python utilities for ABE Lambda handlers',
    });

    // ─── Chat Domain ────────────────────────────────────────────────────

    // Session CRUD: list, get, delete chat sessions for the sidebar.
    const sessionAPIHandlerFunction = new lambda.Function(scope, 'SessionHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'session-handler')),
      handler: 'lambda_function.lambda_handler',
      layers: [pythonCommonLayer],
      environment: {
        "DDB_TABLE_NAME": props.sessionTable.tableName,
        "METADATA_BUCKET": props.knowledgeBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
    });
    
    sessionAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan'
      ],
      resources: [props.sessionTable.tableArn, props.sessionTable.tableArn + "/index/*", `${props.knowledgeBucket.bucketArn}/metadata.txt`]
    }));

    this.sessionFunction = sessionAPIHandlerFunction;

        // Core chat handler: receives WebSocket messages, runs the agentic
        // tool-use loop (query_db, query_excel_index, fetch_metadata, etc.),
        // and streams responses back. 512 MB memory for large KB retrieval
        // payloads. 5-min timeout accommodates multi-turn tool loops.
        const websocketAPIFunction = new lambda.Function(scope, 'ChatHandlerFunction', {
          ...LAMBDA_DEFAULTS,
          runtime: lambda.Runtime.NODEJS_20_X,
          code: lambda.Code.fromAsset(path.join(__dirname, 'websocket-chat')),
          handler: 'index.handler',
          memorySize: 512,
          environment: {
            "WEBSOCKET_API_ENDPOINT": props.wsApiEndpoint.replace("wss", "https"),
            'KB_ID': props.knowledgeBase.attrKnowledgeBaseId,
            'GUARDRAIL_ID': process.env.GUARDRAIL_ID || '',
            'GUARDRAIL_VERSION': process.env.GUARDRAIL_VERSION || '1',
            'PRIMARY_MODEL_ID': process.env.PRIMARY_MODEL_ID || 'us.anthropic.claude-opus-4-6-v1',
            'FAST_MODEL_ID': process.env.FAST_MODEL_ID || 'us.anthropic.claude-sonnet-4-6',
            'PROMPT_REGISTRY_TABLE': props.promptRegistryTable.tableName,
            'RESPONSE_TRACE_TABLE': props.responseTraceTable.tableName,
            'PROMPT_FAMILY': 'ABE_CHAT',
          },
          timeout: cdk.Duration.seconds(300),
        });
        websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeModelWithResponseStream',
            'bedrock:InvokeModel',
          ],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.*`,
            `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
          ]
        }));
        websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:Retrieve'
          ],
          resources: [props.knowledgeBase.attrKnowledgeBaseArn]
        }));

        websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'lambda:InvokeFunction'
          ],
          resources: [this.sessionFunction.functionArn]
        }));

        websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:Query',
          ],
          resources: [
            props.promptRegistryTable.tableArn,
            props.promptRegistryTable.tableArn + "/index/*",
            props.responseTraceTable.tableArn,
            props.responseTraceTable.tableArn + "/index/*",
          ]
        }));

        // The chat Lambda generates pre-signed S3 URLs for source links.
        // Pre-signed URLs require the signing IAM role to have s3:GetObject.
        websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            's3:GetObject',
          ],
          resources: [props.knowledgeBucket.bucketArn + "/*"]
        }));

        this.chatFunction = websocketAPIFunction;

    // ─── Feedback Domain ─────────────────────────────────────────────────

    // Feedback CRUD, LLM-powered analysis, CSV export, and SQS enqueue
    // for the feedback-to-test-library pipeline. 256 MB for LLM payloads.
    const feedbackAPIHandlerFunction = new lambda.Function(scope, 'FeedbackHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'feedback-handler')),
      handler: 'lambda_function.lambda_handler',
      layers: [pythonCommonLayer],
      memorySize: 256,
      environment: {
        "FEEDBACK_TABLE": props.feedbackTable.tableName,
        "FEEDBACK_S3_DOWNLOAD": props.feedbackBucket.bucketName,
        "FEEDBACK_RECORDS_TABLE": props.feedbackRecordsTable.tableName,
        "RESPONSE_TRACE_TABLE": props.responseTraceTable.tableName,
        "PROMPT_REGISTRY_TABLE": props.promptRegistryTable.tableName,
        "MONITORING_CASES_TABLE": props.monitoringCasesTable.tableName,
        "PROMPT_FAMILY": "ABE_CHAT",
        "FEEDBACK_ANALYSIS_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
        "PROMPT_REWRITE_MODEL_ID": process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-opus-4-6-v1",
        "FEEDBACK_TO_TEST_LIBRARY_QUEUE_URL": props.feedbackToTestLibraryQueue.queueUrl,
      },
      timeout: cdk.Duration.seconds(30),
    });
    
    feedbackAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:UpdateItem',
        'dynamodb:DeleteItem',
        'dynamodb:Query',
        'dynamodb:Scan'
      ],
      resources: [
        props.feedbackTable.tableArn,
        props.feedbackTable.tableArn + "/index/*",
        props.feedbackRecordsTable.tableArn,
        props.feedbackRecordsTable.tableArn + "/index/*",
        props.responseTraceTable.tableArn,
        props.responseTraceTable.tableArn + "/index/*",
        props.promptRegistryTable.tableArn,
        props.promptRegistryTable.tableArn + "/index/*",
        props.monitoringCasesTable.tableArn,
        props.monitoringCasesTable.tableArn + "/index/*",
      ]
    }));

    feedbackAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:ListBucket',
      ],
      resources: [props.feedbackBucket.bucketArn,props.feedbackBucket.bucketArn+"/*"]
    }));

    feedbackAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
      ]
    }));

    feedbackAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sqs:SendMessage'],
      resources: [props.feedbackToTestLibraryQueue.queueArn],
    }));

    this.feedbackFunction = feedbackAPIHandlerFunction;
    
    // ─── Knowledge Management Domain ──────────────────────────────────

    // Admin UI file operations on the Knowledge Base source bucket.
    const deleteS3APIHandlerFunction = new lambda.Function(scope, 'DeleteS3FilesHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/delete-s3')),
      handler: 'lambda_function.lambda_handler',
      layers: [pythonCommonLayer],
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    deleteS3APIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:DeleteObject',
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [props.knowledgeBucket.bucketArn,props.knowledgeBucket.bucketArn+"/*"]
    }));
    this.deleteS3Function = deleteS3APIHandlerFunction;

    const getS3APIHandlerFunction = new lambda.Function(scope, 'GetS3FilesHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/get-s3')),
      handler: 'index.handler',
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    getS3APIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [props.knowledgeBucket.bucketArn,props.knowledgeBucket.bucketArn+"/*"]
    }));
    this.getS3Function = getS3APIHandlerFunction;


    const kbSyncAPIHandlerFunction = new lambda.Function(scope, 'SyncKBHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/kb-sync')),
      handler: 'lambda_function.lambda_handler',
      layers: [pythonCommonLayer],
      environment: {
        "KB_ID": props.knowledgeBase.attrKnowledgeBaseId,
        "SOURCE": props.knowledgeBaseSource.attrDataSourceId,
      },
      timeout: cdk.Duration.seconds(30),
    });

    kbSyncAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:StartIngestionJob',
        'bedrock:GetIngestionJob',
        'bedrock:ListIngestionJobs',
      ],
      resources: [props.knowledgeBase.attrKnowledgeBaseArn]
    }));
    this.syncKBFunction = kbSyncAPIHandlerFunction;

    const uploadS3APIHandlerFunction = new lambda.Function(scope, 'UploadS3FilesHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/upload-s3')),
      handler: 'index.handler',
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
    });

    uploadS3APIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:PutObject',
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [props.knowledgeBucket.bucketArn,props.knowledgeBucket.bucketArn+"/*"]
    }));
    this.uploadS3Function = uploadS3APIHandlerFunction;





    // S3 event-driven: fires on every upload/delete in the KB bucket.
    // Regenerates metadata.txt (LLM-summarized file inventory) used by
    // the chat handler's fetch_metadata tool.
    const metadataHandlerFunction = new lambda.Function(scope, 'MetadataHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'metadata-handler')),
      handler: 'lambda_function.lambda_handler',
      layers: [pythonCommonLayer],
      timeout: cdk.Duration.seconds(30),
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
        "KB_ID": props.knowledgeBase.attrKnowledgeBaseId,
        "FAST_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
      },
    });



    // S3 permissions for metadata handler
    metadataHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:PutObject',
        's3:DeleteObject',
        's3:ListBucket',
      ],
      resources: [
        props.knowledgeBucket.bucketArn,
        props.knowledgeBucket.bucketArn + "/*",
      ]
    }));
    // Bedrock InvokeModel permission for metadata summarization
    metadataHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
      ],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.*`,
        `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
      ]
    }));
    // Bedrock Retrieve permission for knowledge base
    metadataHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:Retrieve',
      ],
      resources: [
        props.knowledgeBase.attrKnowledgeBaseArn,
      ]
    }));


// Trigger the lambda function when a document is uploaded

    this.metadataHandlerFunction = metadataHandlerFunction;

      metadataHandlerFunction.addEventSource(new S3EventSource(props.knowledgeBucket, {
        events: [s3.EventType.OBJECT_CREATED, s3.EventType.OBJECT_REMOVED],
      }));

// Lightweight function that returns metadata.txt content; invoked by the
// chat Lambda as a tool call rather than reading S3 directly.
const metadataRetrievalFunction = new lambda.Function(scope, 'MetadataRetrievalFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'metadata-retrieval')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  timeout: cdk.Duration.seconds(30),
  environment: {
    "BUCKET": props.knowledgeBucket.bucketName,
  },
});

metadataRetrievalFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject'],
  resources: [`${props.knowledgeBucket.bucketArn}/metadata.txt`]
}));

websocketAPIFunction.addEnvironment("METADATA_RETRIEVAL_FUNCTION", metadataRetrievalFunction.functionArn);
websocketAPIFunction.addEnvironment("KNOWLEDGE_BUCKET", props.knowledgeBucket.bucketName);
websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'lambda:InvokeFunction',
  ],
  resources: [
    metadataRetrievalFunction.functionArn,
  ],
}));

// ─── Evaluation Pipeline Domain ──────────────────────────────────────

const getS3TestCasesFunction = new lambda.Function(scope, 'GetS3TestCasesFilesHandlerFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/S3-get-test-cases')),
  handler: 'index.handler',
  environment: {
    "BUCKET": props.evalTestCasesBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(30),
});

getS3TestCasesFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    's3:ListBucket',
    's3:GetObject'
  ],
  resources: [props.evalTestCasesBucket.bucketArn, props.evalTestCasesBucket.bucketArn + "/*"]
}));
this.getS3TestCasesFunction = getS3TestCasesFunction;

const uploadS3TestCasesFunction = new lambda.Function(scope, 'UploadS3TestCasesFilesHandlerFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/S3-upload')),
  handler: 'index.handler',
  environment: {
    "BUCKET": props.evalTestCasesBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(30),
});

uploadS3TestCasesFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    's3:PutObject',
    's3:GetObject',
    's3:ListBucket',
  ],
  resources: [props.evalTestCasesBucket.bucketArn,props.evalTestCasesBucket.bucketArn+"/*"]
}));
this.uploadS3TestCasesFunction = uploadS3TestCasesFunction;


// Eval results CRUD + ability to stop running evaluations.
// 60s timeout: aggregation queries can scan large result sets.
const evalResultsAPIHandlerFunction = new lambda.Function(scope, 'EvalResultsHandlerFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/eval-results-handler')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "EVALUATION_RESULTS_TABLE": props.evalResutlsTable.tableName,
    "EVALUATION_SUMMARIES_TABLE": props.evalSummariesTable.tableName,
    "TEST_CASES_BUCKET": props.evalTestCasesBucket.bucketName,
    "EVAL_RESULTS_BUCKET": props.evalResultsBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(60),
});
evalResultsAPIHandlerFunction.addToRolePolicy(new iam.PolicyStatement({ 
  effect: iam.Effect.ALLOW,
  actions: [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DeleteItem',
    'dynamodb:Query',
    'dynamodb:Scan'
  ],
  resources: [props.evalResutlsTable.tableArn, props.evalResutlsTable.tableArn + "/index/*", props.evalSummariesTable.tableArn, props.evalSummariesTable.tableArn + "/index/*"]
}));

this.handleEvalResultsFunction = evalResultsAPIHandlerFunction;
props.evalResutlsTable.grantReadWriteData(evalResultsAPIHandlerFunction);
props.evalSummariesTable.grantReadWriteData(evalResultsAPIHandlerFunction);

// ─── Metrics / Analytics Domain ──────────────────────────────────────

// Reads session and analytics tables for admin dashboard aggregations.
// 60s timeout: full-table scans can be slow on large datasets.
const metricsHandlerFunction = new lambda.Function(scope, 'MetricsHandlerFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'metrics-handler')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "DDB_TABLE_NAME": props.sessionTable.tableName,
    "ANALYTICS_TABLE_NAME": props.analyticsTable.tableName,
  },
  timeout: cdk.Duration.seconds(60),
});

metricsHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'dynamodb:Scan',
    'dynamodb:Query',
  ],
  resources: [
    props.sessionTable.tableArn,
    props.sessionTable.tableArn + "/index/*",
    props.analyticsTable.tableArn,
    props.analyticsTable.tableArn + "/index/*",
  ]
}));

this.metricsHandlerFunction = metricsHandlerFunction;

// Classifies each user question by topic and agency using the fast model.
// Results are written to the analytics table for dashboard reporting.
const faqClassifierFunction = new lambda.Function(scope, 'FAQClassifierFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'faq-classifier')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "ANALYTICS_TABLE_NAME": props.analyticsTable.tableName,
    "FAST_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
  },
  timeout: cdk.Duration.seconds(30),
});

faqClassifierFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:*::foundation-model/anthropic.*`,
    `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
  ],
}));

faqClassifierFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:PutItem'],
  resources: [props.analyticsTable.tableArn],
}));

this.faqClassifierFunction = faqClassifierFunction;

// Summarizes long conversation context to fit within the model's context
// window. Bundles its own Python dependencies (not in the common layer).
// 60s timeout: LLM summarization of large contexts can be slow.
const contextSummarizerFunction = new lambda.Function(scope, 'ContextSummarizerFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'context-summarizer'), {
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      platform: 'linux/amd64',
      command: [
        'bash', '-c',
        'pip install --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 --only-binary=:all: -r requirements.txt -t /asset-output && cp -au . /asset-output',
      ],
    },
  }),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "FAST_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-sonnet-4-6",
  },
  timeout: cdk.Duration.seconds(60),
});

contextSummarizerFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:*::foundation-model/anthropic.*`,
    `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
  ],
}));

this.contextSummarizerFunction = contextSummarizerFunction;

// ─── Excel Index Domain ──────────────────────────────────────────────

// S3 event-driven parser: triggered on .xlsx upload/delete under indexes/.
// Reads the spreadsheet, uses LLM to generate column descriptions, and
// writes rows to DynamoDB. 2-min timeout + 512 MB for large spreadsheets.
const excelIndexParserFunction = new lambda.Function(scope, 'ExcelIndexParserFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'excel-index/parser'), {
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      platform: 'linux/amd64',
      command: [
        'bash', '-c',
        'pip install --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 --only-binary=:all: -r requirements.txt -t /asset-output && cp -au . /asset-output',
      ],
    },
  }),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    BUCKET: props.contractIndexBucket.bucketName,
    TABLE_NAME: props.excelIndexDataTable.tableName,
    INDEX_REGISTRY_TABLE: props.indexRegistryTable.tableName,
    PRIMARY_MODEL_ID: process.env.PRIMARY_MODEL_ID || 'us.anthropic.claude-opus-4-6-v1',
  },
  timeout: cdk.Duration.minutes(2),
  memorySize: 512,
});
excelIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject'],
  resources: [props.contractIndexBucket.bucketArn + '/*'],
}));
excelIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
  resources: [props.excelIndexDataTable.tableArn],
}));
excelIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem'],
  resources: [props.indexRegistryTable.tableArn],
}));
excelIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:us-east-1:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.claude-opus-4-6-v1`,
    'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-6-v1',
  ],
}));
excelIndexParserFunction.addEventSource(new S3EventSource(props.contractIndexBucket, {
  events: [s3.EventType.OBJECT_CREATED, s3.EventType.OBJECT_REMOVED],
  filters: [{ prefix: 'indexes/', suffix: '.xlsx' }],
}));
this.excelIndexParserFunction = excelIndexParserFunction;

// DynamoDB query engine invoked by the chat Lambda's query_excel_index tool.
// Supports filters, counts, sorts, distinct values. 256 MB for large result sets.
const excelIndexQueryFunction = new lambda.Function(scope, 'ExcelIndexQueryFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'excel-index/query'), {
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      platform: 'linux/amd64',
      command: [
        'bash', '-c',
        'pip install --platform manylinux2014_aarch64 --implementation cp --python-version 3.12 --only-binary=:all: -r requirements.txt -t /asset-output && cp -au . /asset-output',
      ],
    },
  }),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    TABLE_NAME: props.excelIndexDataTable.tableName,
  },
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
});
excelIndexQueryFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: [props.excelIndexDataTable.tableArn],
}));
this.excelIndexQueryFunction = excelIndexQueryFunction;

// REST API for admin index management: create, list, delete indexes.
// Delegates actual queries to the query function via Lambda invoke.
const excelIndexApiFunction = new lambda.Function(scope, 'ExcelIndexApiFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'excel-index/api')),
  handler: 'index.handler',
  environment: {
    QUERY_FUNCTION: excelIndexQueryFunction.functionName,
    BUCKET: props.contractIndexBucket.bucketName,
    INDEX_REGISTRY_TABLE: props.indexRegistryTable.tableName,
    TABLE_NAME: props.excelIndexDataTable.tableName,
  },
  timeout: cdk.Duration.seconds(30),
});
excelIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [excelIndexQueryFunction.functionArn],
}));
excelIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:PutObject', 's3:DeleteObject'],
  resources: [props.contractIndexBucket.bucketArn + '/*'],
}));
excelIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
  resources: [props.indexRegistryTable.tableArn],
}));
excelIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Scan', 'dynamodb:BatchWriteItem'],
  resources: [props.excelIndexDataTable.tableArn],
}));
this.excelIndexApiFunction = excelIndexApiFunction;

websocketAPIFunction.addEnvironment('EXCEL_INDEX_QUERY_FUNCTION', excelIndexQueryFunction.functionName);
websocketAPIFunction.addEnvironment('INDEX_REGISTRY_TABLE', props.indexRegistryTable.tableName);
websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [excelIndexQueryFunction.functionArn],
}));
websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Query'],
  resources: [props.indexRegistryTable.tableArn],
}));

// CRUD for the reusable test case library (eval pipeline).
const testLibraryFunction = new lambda.Function(scope, 'TestLibraryHandlerFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/test-library-handler')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "TEST_LIBRARY_TABLE": props.testLibraryTable.tableName,
  },
  timeout: cdk.Duration.seconds(30),
});
testLibraryFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DeleteItem',
    'dynamodb:Query',
  ],
  resources: [props.testLibraryTable.tableArn, props.testLibraryTable.tableArn + "/index/*"],
}));
this.testLibraryFunction = testLibraryFunction;

// Feedback-to-test-library pipeline: two Lambdas connected by SQS.
// Enqueue: sends positive feedback messages to the SQS queue.
const feedbackToTestLibraryEnqueueFunction = new lambda.Function(scope, 'FeedbackToTestLibraryEnqueueFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/feedback-to-test-library')),
  handler: 'enqueue.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "QUEUE_URL": props.feedbackToTestLibraryQueue.queueUrl,
  },
  timeout: cdk.Duration.seconds(15),
});
feedbackToTestLibraryEnqueueFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['sqs:SendMessage'],
  resources: [props.feedbackToTestLibraryQueue.queueArn],
}));
this.feedbackToTestLibraryEnqueueFunction = feedbackToTestLibraryEnqueueFunction;

// Process: SQS consumer that rewrites the Q&A pair via LLM and inserts
// into TestLibraryTable. 90s timeout for LLM calls; 256 MB for payloads.
// Batch size 1 ensures each feedback item gets individual LLM attention.
const feedbackToTestLibraryProcessFunction = new lambda.Function(scope, 'FeedbackToTestLibraryProcessFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/feedback-to-test-library')),
  handler: 'process.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "TEST_LIBRARY_TABLE": props.testLibraryTable.tableName,
    "MODEL_ID": process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-opus-4-6-v1",
  },
  timeout: cdk.Duration.seconds(90),
  memorySize: 256,
});
feedbackToTestLibraryProcessFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:Query',
  ],
  resources: [props.testLibraryTable.tableArn, props.testLibraryTable.tableArn + "/index/*"],
}));
feedbackToTestLibraryProcessFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:InvokeModel'],
  resources: [
    `arn:aws:bedrock:*::foundation-model/anthropic.*`,
    `arn:aws:bedrock:*:${cdk.Stack.of(this).account}:inference-profile/*`,
  ],
}));
feedbackToTestLibraryProcessFunction.addEventSource(new SqsEventSource(props.feedbackToTestLibraryQueue, {
  batchSize: 1,
}));
this.feedbackToTestLibraryProcessFunction = feedbackToTestLibraryProcessFunction;

// Generates pre-signed S3 URLs so the frontend can link directly to
// source documents. Short 10s timeout — just signs a URL, no I/O.
const sourcePresignFunction = new lambda.Function(scope, 'SourcePresignFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'source-presign')),
  handler: 'index.handler',
  environment: {
    "BUCKET": props.knowledgeBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(10),
});
sourcePresignFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject'],
  resources: [props.knowledgeBucket.bucketArn + '/*'],
}));
this.sourcePresignFunction = sourcePresignFunction;

this.stepFunctionsStack = new StepFunctionsStack(scope, 'StepFunctionsStack', {
  knowledgeBase: props.knowledgeBase,
  evalSummariesTable: props.evalSummariesTable,
  evalResutlsTable: props.evalResutlsTable,
  evalTestCasesBucket: props.evalTestCasesBucket,
  evalResultsBucket: props.evalResultsBucket,
  wsEndpoint: props.wsApiEndpoint,
  promptRegistryTable: props.promptRegistryTable,
});

const evalStateMachineArn = this.stepFunctionsStack.llmEvalStateMachine.stateMachineArn;
const evalStateMachineName = cdk.Fn.select(6, cdk.Fn.split(':', evalStateMachineArn));
const evalExecutionArnPattern = cdk.Fn.join('', [
  'arn:aws:states:',
  cdk.Stack.of(scope).region,
  ':',
  cdk.Stack.of(scope).account,
  ':execution:',
  evalStateMachineName,
  ':*',
]);
evalResultsAPIHandlerFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['states:StopExecution'],
    resources: [evalExecutionArnPattern],
  }),
);

const evalS3ListResources =
  props.evalTestCasesBucket.bucketArn === props.evalResultsBucket.bucketArn
    ? [props.evalTestCasesBucket.bucketArn]
    : [props.evalTestCasesBucket.bucketArn, props.evalResultsBucket.bucketArn];
evalResultsAPIHandlerFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:ListBucket'],
    resources: evalS3ListResources,
    conditions: {
      StringLike: { 's3:prefix': ['evaluations/*'] },
    },
  }),
);
const evalS3DeleteObjectResources =
  props.evalTestCasesBucket.bucketArn === props.evalResultsBucket.bucketArn
    ? [`${props.evalTestCasesBucket.bucketArn}/evaluations/*`]
    : [
        `${props.evalTestCasesBucket.bucketArn}/evaluations/*`,
        `${props.evalResultsBucket.bucketArn}/evaluations/*`,
      ];
evalResultsAPIHandlerFunction.addToRolePolicy(
  new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['s3:DeleteObject'],
    resources: evalS3DeleteObjectResources,
  }),
);

// Step Functions DescribeExecution / GetExecutionHistory granted in index.ts

// ─── Sync Domain ────────────────────────────────────────────────────

// Orchestrator: reads from the staging bucket, copies files to the
// appropriate destination (KB bucket or index bucket), triggers a
// Bedrock KB ingestion job, and logs the run to SyncHistoryTable.
// 5-min timeout + 256 MB: may copy many files and wait for ingestion.
const syncOrchestratorFunction = new lambda.Function(scope, 'SyncOrchestratorFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'sync-orchestrator')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    STAGING_BUCKET: props.dataStagingBucket.bucketName,
    KB_BUCKET: props.knowledgeBucket.bucketName,
    INDEX_BUCKET: props.contractIndexBucket.bucketName,
    KB_ID: props.knowledgeBase.attrKnowledgeBaseId,
    KB_DATA_SOURCE_ID: props.knowledgeBaseSource.attrDataSourceId,
    SYNC_HISTORY_TABLE: props.syncHistoryTable.tableName,
  },
  timeout: cdk.Duration.minutes(5),
  memorySize: 256,
});
syncOrchestratorFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:ListBucket', 's3:GetObject', 's3:DeleteObject'],
  resources: [props.dataStagingBucket.bucketArn, props.dataStagingBucket.bucketArn + '/*'],
}));
syncOrchestratorFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:PutObject'],
  resources: [props.knowledgeBucket.bucketArn + '/*', props.contractIndexBucket.bucketArn + '/*'],
}));
syncOrchestratorFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['bedrock:StartIngestionJob', 'bedrock:ListIngestionJobs'],
  resources: [props.knowledgeBase.attrKnowledgeBaseArn],
}));
syncOrchestratorFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:PutItem'],
  resources: [props.syncHistoryTable.tableArn],
}));
this.syncOrchestratorFunction = syncOrchestratorFunction;

// EventBridge Scheduler: runs the sync orchestrator every Sunday at 6 AM UTC.
const schedulerRole = new iam.Role(scope, 'SyncSchedulerRole', {
  assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
});
schedulerRole.addToPolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [syncOrchestratorFunction.functionArn],
}));

const scheduleGroup = new scheduler.CfnScheduleGroup(scope, 'ABESyncScheduleGroup', {
  name: `${cdk.Stack.of(scope).stackName}-SyncScheduleGroup`,
});

const syncSchedule = new scheduler.CfnSchedule(scope, 'WeeklySyncSchedule', {
  name: `${cdk.Stack.of(scope).stackName}-WeeklySyncSchedule`,
  groupName: scheduleGroup.name!,
  scheduleExpression: 'cron(0 6 ? * SUN *)',
  scheduleExpressionTimezone: 'UTC',
  state: 'ENABLED',
  flexibleTimeWindow: { mode: 'OFF' },
  target: {
    arn: syncOrchestratorFunction.functionArn,
    roleArn: schedulerRole.roleArn,
  },
});
syncSchedule.addDependency(scheduleGroup);

// Admin API for viewing/updating the sync schedule (enable, disable,
// change cron expression) and viewing sync history.
const syncScheduleFunction = new lambda.Function(scope, 'SyncScheduleFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'sync-schedule')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    SCHEDULE_NAME: syncSchedule.name!,
    SCHEDULE_GROUP: scheduleGroup.name!,
    STAGING_BUCKET: props.dataStagingBucket.bucketName,
    INDEX_REGISTRY_TABLE: props.indexRegistryTable.tableName,
    SYNC_HISTORY_TABLE: props.syncHistoryTable.tableName,
    ORCHESTRATOR_LAMBDA_ARN: syncOrchestratorFunction.functionArn,
  },
  timeout: cdk.Duration.seconds(30),
});
const scheduleArn = cdk.Fn.join('', [
  'arn:aws:scheduler:',
  cdk.Stack.of(scope).region,
  ':',
  cdk.Stack.of(scope).account,
  ':schedule/',
  scheduleGroup.name!,
  '/',
  syncSchedule.name!,
]);
syncScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['scheduler:GetSchedule', 'scheduler:UpdateSchedule'],
  resources: [scheduleArn],
}));
syncScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['iam:PassRole'],
  resources: [schedulerRole.roleArn],
}));
syncScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Query', 'dynamodb:Scan'],
  resources: [
    props.syncHistoryTable.tableArn,
    props.indexRegistryTable.tableArn,
  ],
}));
syncScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:ListBucket'],
  resources: [props.dataStagingBucket.bucketArn],
}));
syncScheduleFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [syncOrchestratorFunction.functionArn],
}));
this.syncScheduleFunction = syncScheduleFunction;
}
}
