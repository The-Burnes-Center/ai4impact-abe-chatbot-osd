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

    const pythonCommonLayer = new lambda.LayerVersion(scope, 'PythonCommonLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, 'layers/python-common')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      description: 'Shared Python utilities for ABE Lambda handlers',
    });

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
            'PRIMARY_MODEL_ID': process.env.PRIMARY_MODEL_ID || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
            'FAST_MODEL_ID': process.env.FAST_MODEL_ID || 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
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
        "FEEDBACK_ANALYSIS_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-3-5-haiku-20241022-v1:0",
        "PROMPT_REWRITE_MODEL_ID": process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-sonnet-4-20250514-v1:0",
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
        "FAST_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-3-5-haiku-20241022-v1:0",
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
websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'lambda:InvokeFunction',
  ],
  resources: [
    metadataRetrievalFunction.functionArn,
  ],
}));

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

const faqClassifierFunction = new lambda.Function(scope, 'FAQClassifierFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'faq-classifier')),
  handler: 'lambda_function.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "ANALYTICS_TABLE_NAME": props.analyticsTable.tableName,
    "FAST_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-3-5-haiku-20241022-v1:0",
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
    "FAST_MODEL_ID": process.env.FAST_MODEL_ID || "us.anthropic.claude-3-5-haiku-20241022-v1:0",
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

// Generic Excel Index: one parser, one query, one API Lambda for all indexes
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
    PRIMARY_MODEL_ID: process.env.PRIMARY_MODEL_ID || 'us.anthropic.claude-sonnet-4-20250514-v1:0',
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
    `arn:aws:bedrock:us-east-1:${cdk.Aws.ACCOUNT_ID}:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0`,
    'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0',
  ],
}));
excelIndexParserFunction.addEventSource(new S3EventSource(props.contractIndexBucket, {
  events: [s3.EventType.OBJECT_CREATED, s3.EventType.OBJECT_REMOVED],
  filters: [{ prefix: 'indexes/', suffix: '.xlsx' }],
}));
this.excelIndexParserFunction = excelIndexParserFunction;

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

const feedbackToTestLibraryProcessFunction = new lambda.Function(scope, 'FeedbackToTestLibraryProcessFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/feedback-to-test-library')),
  handler: 'process.lambda_handler',
  layers: [pythonCommonLayer],
  environment: {
    "TEST_LIBRARY_TABLE": props.testLibraryTable.tableName,
    "MODEL_ID": process.env.PRIMARY_MODEL_ID || "us.anthropic.claude-sonnet-4-20250514-v1:0",
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

// ── Sync Orchestrator Lambda ──
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

// ── EventBridge Scheduler for weekly sync ──
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

// ── Sync Schedule API Lambda ──
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
