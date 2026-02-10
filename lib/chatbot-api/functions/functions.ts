import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';

// Import Lambda L2 construct
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from "aws-cdk-lib/aws-s3";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { S3EventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { StepFunctionsStack } from './step-functions/step-functions';

interface LambdaFunctionStackProps {  
  readonly wsApiEndpoint : string;  
  readonly sessionTable : Table;  
  readonly feedbackTable : Table;
  readonly feedbackBucket : s3.Bucket;
  readonly knowledgeBucket : s3.Bucket;
  readonly knowledgeBase : bedrock.CfnKnowledgeBase;
  readonly knowledgeBaseSource: bedrock.CfnDataSource;
  readonly evalSummariesTable : Table;
  readonly evalResutlsTable : Table;
  readonly evalTestCasesBucket : s3.Bucket;
  readonly evalResultsBucket : s3.Bucket;
}

export class LambdaFunctionStack extends cdk.Stack {  
  public readonly chatFunction : lambda.Function;
  public readonly sessionFunction : lambda.Function;
  public readonly feedbackFunction : lambda.Function;
  public readonly deleteS3Function : lambda.Function;
  public readonly getS3Function : lambda.Function;
  public readonly uploadS3Function : lambda.Function;
  public readonly syncKBFunction : lambda.Function;
  public readonly metadataHandlerFunction: lambda.Function;
  public readonly getS3TestCasesFunction : lambda.Function;
  public readonly stepFunctionsStack : StepFunctionsStack;
  public readonly uploadS3TestCasesFunction : lambda.Function;
  public readonly handleEvalResultsFunction : lambda.Function;
  public readonly metricsHandlerFunction : lambda.Function;


  constructor(scope: Construct, id: string, props: LambdaFunctionStackProps) {
    super(scope, id);    

    const sessionAPIHandlerFunction = new lambda.Function(scope, 'SessionHandlerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'session-handler')), // Points to the lambda directory
      handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "DDB_TABLE_NAME" : props.sessionTable.tableName,
        "METADATA_BUCKET": props.knowledgeBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30)
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

        // Define the Lambda function resource
        const websocketAPIFunction = new lambda.Function(scope, 'ChatHandlerFunction', {
          runtime: lambda.Runtime.NODEJS_20_X, // Choose any supported Node.js runtime
          code: lambda.Code.fromAsset(path.join(__dirname, 'websocket-chat')), // Points to the lambda directory
          handler: 'index.handler', // Points to the 'hello' file in the lambda directory
          environment : {
            "WEBSOCKET_API_ENDPOINT" : props.wsApiEndpoint.replace("wss","https"),
            'KB_ID' : props.knowledgeBase.attrKnowledgeBaseId,
            'GUARDRAIL_ID' : process.env.GUARDRAIL_ID || '',
            'GUARDRAIL_VERSION' : process.env.GUARDRAIL_VERSION || '1',
          },
          timeout: cdk.Duration.seconds(300)
        });
        websocketAPIFunction.addToRolePolicy(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            'bedrock:InvokeModelWithResponseStream',
            'bedrock:InvokeModel',
          ],
          resources: [
            `arn:aws:bedrock:*::foundation-model/anthropic.*`,
            `arn:aws:bedrock:*::foundation-model/mistral.*`,
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
      runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'feedback-handler')), // Points to the lambda directory
      handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "FEEDBACK_TABLE" : props.feedbackTable.tableName,
        "FEEDBACK_S3_DOWNLOAD" : props.feedbackBucket.bucketName
      },
      timeout: cdk.Duration.seconds(30)
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
      runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/delete-s3')), // Points to the lambda directory
      handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "BUCKET" : props.knowledgeBucket.bucketName,        
      },
      timeout: cdk.Duration.seconds(30)
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
      runtime: lambda.Runtime.NODEJS_20_X, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/get-s3')), // Points to the lambda directory
      handler: 'index.handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "BUCKET" : props.knowledgeBucket.bucketName,        
      },
      timeout: cdk.Duration.seconds(30)
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
      runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/kb-sync')), // Points to the lambda directory
      handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "KB_ID" : props.knowledgeBase.attrKnowledgeBaseId,      
        "SOURCE" : props.knowledgeBaseSource.attrDataSourceId  
      },
      timeout: cdk.Duration.seconds(30)
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
      runtime: lambda.Runtime.NODEJS_20_X, // Choose any supported Node.js runtime
      code: lambda.Code.fromAsset(path.join(__dirname, 'knowledge-management/upload-s3')), // Points to the lambda directory
      handler: 'index.handler', // Points to the 'hello' file in the lambda directory
      environment: {
        "BUCKET" : props.knowledgeBucket.bucketName,        
      },
      timeout: cdk.Duration.seconds(30)
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





    // Define the Lambda function for metadata
    const metadataHandlerFunction = new lambda.Function(scope, 'MetadataHandlerFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'metadata-handler')),
      handler: 'lambda_function.lambda_handler',
      timeout: cdk.Duration.seconds(30),
      environment: {
        "BUCKET": props.knowledgeBucket.bucketName,
        "KB_ID": props.knowledgeBase.attrKnowledgeBaseId
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
  runtime: lambda.Runtime.NODEJS_20_X,
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/S3-get-test-cases')),
  handler: 'index.handler',
  environment: {
    "BUCKET": props.evalTestCasesBucket.bucketName,
  },
  timeout: cdk.Duration.seconds(30)
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
  runtime: lambda.Runtime.NODEJS_20_X, // Choose any supported Node.js runtime
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/S3-upload')), // Points to the lambda directory
  handler: 'index.handler', // Points to the 'hello' file in the lambda directory
  environment: {
    "BUCKET" : props.evalTestCasesBucket.bucketName,        
  },
  timeout: cdk.Duration.seconds(30)
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
  runtime: lambda.Runtime.PYTHON_3_12, // Choose any supported Node.js runtime
  code: lambda.Code.fromAsset(path.join(__dirname, 'llm-eval/eval-results-handler')), // Points to the lambda directory
  handler: 'lambda_function.lambda_handler', // Points to the 'hello' file in the lambda directory
  environment: {
    // Using the full table names: 
    // GenAiOsdChatStack-ChatbotAPIEvaluationResultsTableE72FCF7C-136Z3LGPGTSF1
    // GenAiOsdChatStack-ChatbotAPIEvaluationSummariesTableE9B95A54-1S7WAPF93R60M
    "EVALUATION_RESULTS_TABLE" : props.evalResutlsTable.tableName,
    "EVALUATION_SUMMARIES_TABLE" : props.evalSummariesTable.tableName
  },
  timeout: cdk.Duration.seconds(30)
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
  runtime: lambda.Runtime.PYTHON_3_12,
  code: lambda.Code.fromAsset(path.join(__dirname, 'metrics-handler')),
  handler: 'lambda_function.lambda_handler',
  environment: {
    "DDB_TABLE_NAME": props.sessionTable.tableName,
  },
  timeout: cdk.Duration.seconds(60) // Increased timeout for scanning large tables
});

metricsHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    'dynamodb:Scan'
  ],
  resources: [props.sessionTable.tableArn, props.sessionTable.tableArn + "/index/*"]
}));

this.metricsHandlerFunction = metricsHandlerFunction;

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
