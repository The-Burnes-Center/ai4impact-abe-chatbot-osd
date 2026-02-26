import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from "aws-cdk-lib/aws-s3";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { StepFunctionsStack } from './step-functions/step-functions';

interface LambdaFunctionStackProps {
  readonly wsApiEndpoint: string;
  readonly sessionTable: Table;
  readonly feedbackTable: Table;
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
  readonly contractIndexTable: Table;
  readonly tradeIndexTable: Table;
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
  public readonly contractIndexParserFunction: lambda.Function;
  public readonly contractIndexQueryFunction: lambda.Function;
  public readonly contractIndexApiFunction: lambda.Function;
  public readonly tradeIndexParserFunction: lambda.Function;
  public readonly tradeIndexQueryFunction: lambda.Function;
  public readonly tradeIndexApiFunction: lambda.Function;

  constructor(scope: Construct, id: string, props: LambdaFunctionStackProps) {
    super(scope, id);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate functions.

    const sessionAPIHandlerFunction = new lambda.Function(scope, 'SessionHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'session-handler')),
      handler: 'lambda_function.lambda_handler',
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
      environment: {
        "FEEDBACK_TABLE": props.feedbackTable.tableName,
        "FEEDBACK_S3_DOWNLOAD": props.feedbackBucket.bucketName,
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
      resources: [props.feedbackTable.tableArn, props.feedbackTable.tableArn + "/index/*"]
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

    this.feedbackFunction = feedbackAPIHandlerFunction;
    
    const deleteS3APIHandlerFunction = new lambda.Function(scope, 'DeleteS3FilesHandlerFunction', {
      ...LAMBDA_DEFAULTS,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/delete-s3')),
      handler: 'lambda_function.lambda_handler',
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
  environment: {
    "EVALUATION_RESULTS_TABLE": props.evalResutlsTable.tableName,
    "EVALUATION_SUMMARIES_TABLE": props.evalSummariesTable.tableName,
  },
  timeout: cdk.Duration.seconds(30),
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

// Contract Index: parser (S3 trigger → DynamoDB), query (agent + REST reads from DynamoDB)
const contractIndexParserFunction = new lambda.Function(scope, 'ContractIndexParserFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'contract-index/parser'), {
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
  environment: {
    BUCKET: props.contractIndexBucket.bucketName,
    TABLE_NAME: props.contractIndexTable.tableName,
  },
  timeout: cdk.Duration.minutes(2),
  memorySize: 512,
});
contractIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
  resources: [props.contractIndexBucket.bucketArn, props.contractIndexBucket.bucketArn + '/*'],
}));
contractIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem'],
  resources: [props.contractIndexTable.tableArn, props.contractIndexTable.tableArn + '/index/*'],
}));
contractIndexParserFunction.addEventSource(new S3EventSource(props.contractIndexBucket, {
  events: [s3.EventType.OBJECT_CREATED],
  filters: [{ prefix: 'swc-index/', suffix: '.xlsx' }],
}));
this.contractIndexParserFunction = contractIndexParserFunction;

const contractIndexQueryFunction = new lambda.Function(scope, 'ContractIndexQueryFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'contract-index/query'), {
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
  environment: {
    TABLE_NAME: props.contractIndexTable.tableName,
  },
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
});
contractIndexQueryFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: [props.contractIndexTable.tableArn, props.contractIndexTable.tableArn + '/index/*'],
}));
this.contractIndexQueryFunction = contractIndexQueryFunction;

const contractIndexApiFunction = new lambda.Function(scope, 'ContractIndexApiFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'contract-index/api')),
  handler: 'index.handler',
  environment: {
    CONTRACT_INDEX_QUERY_FUNCTION: contractIndexQueryFunction.functionName,
    BUCKET: props.contractIndexBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(30),
});
contractIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [contractIndexQueryFunction.functionArn],
}));
contractIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:PutObject'],
  resources: [props.contractIndexBucket.bucketArn, props.contractIndexBucket.bucketArn + '/*'],
}));
this.contractIndexApiFunction = contractIndexApiFunction;

websocketAPIFunction.addEnvironment('CONTRACT_INDEX_QUERY_FUNCTION', contractIndexQueryFunction.functionName);
websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [contractIndexQueryFunction.functionArn],
}));

// Trade Index: parser (S3 trigger → DynamoDB), query (agent + REST reads from DynamoDB)
const tradeIndexParserFunction = new lambda.Function(scope, 'TradeIndexParserFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'trade-index/parser'), {
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
  environment: {
    BUCKET: props.contractIndexBucket.bucketName,
    TABLE_NAME: props.tradeIndexTable.tableName,
  },
  timeout: cdk.Duration.minutes(2),
  memorySize: 512,
});
tradeIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
  resources: [props.contractIndexBucket.bucketArn, props.contractIndexBucket.bucketArn + '/*'],
}));
tradeIndexParserFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:Query', 'dynamodb:BatchWriteItem', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:UpdateItem', 'dynamodb:GetItem'],
  resources: [props.tradeIndexTable.tableArn, props.tradeIndexTable.tableArn + '/index/*'],
}));
tradeIndexParserFunction.addEventSource(new S3EventSource(props.contractIndexBucket, {
  events: [s3.EventType.OBJECT_CREATED],
  filters: [{ prefix: 'trade-index/', suffix: '.xlsx' }],
}));
this.tradeIndexParserFunction = tradeIndexParserFunction;

const tradeIndexQueryFunction = new lambda.Function(scope, 'TradeIndexQueryFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'trade-index/query'), {
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
  environment: {
    TABLE_NAME: props.tradeIndexTable.tableName,
  },
  timeout: cdk.Duration.seconds(30),
  memorySize: 256,
});
tradeIndexQueryFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
  resources: [props.tradeIndexTable.tableArn, props.tradeIndexTable.tableArn + '/index/*'],
}));
this.tradeIndexQueryFunction = tradeIndexQueryFunction;

const tradeIndexApiFunction = new lambda.Function(scope, 'TradeIndexApiFunction', {
  ...LAMBDA_DEFAULTS,
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'trade-index/api')),
  handler: 'index.handler',
  environment: {
    TRADE_INDEX_QUERY_FUNCTION: tradeIndexQueryFunction.functionName,
    BUCKET: props.contractIndexBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(30),
});
tradeIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [tradeIndexQueryFunction.functionArn],
}));
tradeIndexApiFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['s3:PutObject'],
  resources: [props.contractIndexBucket.bucketArn, props.contractIndexBucket.bucketArn + '/*'],
}));
this.tradeIndexApiFunction = tradeIndexApiFunction;

websocketAPIFunction.addEnvironment('TRADE_INDEX_QUERY_FUNCTION', tradeIndexQueryFunction.functionName);
websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: ['lambda:InvokeFunction'],
  resources: [tradeIndexQueryFunction.functionArn],
}));

this.stepFunctionsStack = new StepFunctionsStack(scope, 'StepFunctionsStack', {
  knowledgeBase: props.knowledgeBase,
  evalSummariesTable: props.evalSummariesTable,
  evalResutlsTable: props.evalResutlsTable,
  evalTestCasesBucket: props.evalTestCasesBucket,
  evalResultsBucket: props.evalResultsBucket,
  wsEndpoint: props.wsApiEndpoint
});
}
}
