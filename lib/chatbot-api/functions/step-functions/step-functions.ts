import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as path from 'path';
import * as process from 'process';

// Import Lambda L2 construct
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from "aws-cdk-lib/aws-s3";
import * as bedrock from "aws-cdk-lib/aws-bedrock";
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { StateMachine } from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';

interface StepFunctionsStackProps {
    readonly knowledgeBase : bedrock.CfnKnowledgeBase;
    readonly evalSummariesTable : Table;
    readonly evalResutlsTable : Table;
    readonly evalTestCasesBucket : s3.Bucket;
    readonly evalResultsBucket : s3.Bucket;
    readonly wsEndpoint?: string;
}

export class StepFunctionsStack extends Construct {
    public readonly startLlmEvalStateMachineFunction: lambda.Function;
    public readonly splitEvalTestCasesFunction: lambda.Function;
    public readonly llmEvalResultsHandlerFunction: lambda.Function;
    public readonly generateResponseFunction: lambda.Function;
    public readonly llmEvalFunction: lambda.Function;
    public readonly aggregateEvalResultsFunction: lambda.Function;
    public readonly llmEvalCleanupFunction: lambda.Function;
    public readonly llmEvalStateMachine: StateMachine;

    constructor(scope: Construct, id: string, props: StepFunctionsStackProps) {
        super(scope, id);

        const splitEvalTestCasesFunction = new lambda.Function(this, 'SplitEvalTestCasesFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            code: lambda.Code.fromAsset(path.join(__dirname, 'llm-evaluation/split-test-cases')), 
            handler: 'lambda_function.lambda_handler', 
            environment: {
                "TEST_CASES_BUCKET" : props.evalTestCasesBucket.bucketName
            },
            timeout: cdk.Duration.seconds(30)
        });
        splitEvalTestCasesFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:ListBucket',
                's3:PutObject'
            ],
            resources: [
                props.evalTestCasesBucket.bucketArn, 
                props.evalTestCasesBucket.bucketArn + "/*", 
                props.evalTestCasesBucket.arnForObjects('*'),
            ]
        }));
        this.splitEvalTestCasesFunction = splitEvalTestCasesFunction;

        const llmEvalResultsHandlerFunction = new lambda.Function(this, 'LlmEvalResultsHandlerFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            code: lambda.Code.fromAsset(path.join(__dirname, 'llm-evaluation/results-to-ddb')), 
            handler: 'lambda_function.lambda_handler', 
            environment: {
                "EVAL_SUMMARIES_TABLE" : props.evalSummariesTable.tableName,
                "EVAL_RESULTS_TABLE" : props.evalResutlsTable.tableName,
                "EVALUATION_SUMMARIES_TABLE" : props.evalSummariesTable.tableName,
                "EVALUATION_RESULTS_TABLE" : props.evalResutlsTable.tableName,
                "TEST_CASES_BUCKET" : props.evalTestCasesBucket.bucketName,
                "EVAL_RESULTS_BUCKET" : props.evalResultsBucket.bucketName
            },
            timeout: cdk.Duration.seconds(30)
        });
        llmEvalResultsHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
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
        llmEvalResultsHandlerFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:PutObject',
            ],
            resources: [
                props.evalTestCasesBucket.bucketArn, 
                props.evalTestCasesBucket.bucketArn + "/*", 
                props.evalTestCasesBucket.arnForObjects('*'),
                props.evalResultsBucket.bucketArn,
                props.evalResultsBucket.bucketArn + "/*",
                props.evalResultsBucket.arnForObjects('*')
            ]
        }));
        props.evalResutlsTable.grantReadWriteData(llmEvalResultsHandlerFunction);
        props.evalSummariesTable.grantReadWriteData(llmEvalResultsHandlerFunction);
        this.llmEvalResultsHandlerFunction = llmEvalResultsHandlerFunction; 

        const generateResponseFunction = new lambda.Function(this, 'GenerateResponseFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset(path.join(__dirname, '..'), {
                exclude: ['*', '!websocket-chat/models/**', '!step-functions/llm-evaluation/generate-response/**'],
            }),
            handler: 'step-functions/llm-evaluation/generate-response/index.handler', 
            environment : {
                "PROMPT" : `You are a helpful AI chatbot that will answer questions based on your knowledge. 
                You have access to a search tool that you will use to look up answers to questions.`,
                'KB_ID' : props.knowledgeBase.attrKnowledgeBaseId,
                'SYS_PROMPT_HANDLER': process.env.SYS_PROMPT_HANDLER || '',
                'AWS_REGION': process.env.AWS_REGION || 'us-east-1'
            },
            timeout: cdk.Duration.seconds(60)
        });
        generateResponseFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:InvokeModel',
              
            ],
            resources: ["*"]
        }));
        generateResponseFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock:Retrieve'
            ],
            resources: [props.knowledgeBase.attrKnowledgeBaseArn]
        }));
        this.generateResponseFunction = generateResponseFunction;

        const llmEvalFunction = new lambda.DockerImageFunction(this, 'LlmEvaluationFunction', {
            code: lambda.DockerImageCode.fromImageAsset(path.join(__dirname, 'llm-evaluation/eval'), {
                platform: Platform.LINUX_AMD64, // Specify the correct platform
            }),
            environment: {
                "TEST_CASES_BUCKET" : props.evalTestCasesBucket.bucketName,
                "EVAL_RESULTS_BUCKET" : props.evalResultsBucket.bucketName,
                "CHATBOT_API_URL" : props.wsEndpoint || "https://dcf43zj2k8alr.cloudfront.net",
                "GENERATE_RESPONSE_LAMBDA_NAME": generateResponseFunction.functionName,
                "BEDROCK_MODEL_ID": "anthropic.claude-3-sonnet-20240229-v1:0",
                "AWS_REGION": process.env.AWS_REGION || 'us-east-1'
            },
            timeout: cdk.Duration.minutes(15),
            memorySize: 10240
        });
        llmEvalFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'ecr:GetAuthorization',
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchGetImage',
              'ecr:BatchCheckLayerAvailability'
            ],
            resources: ['*']
        }));
        llmEvalFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
              'bedrock:InvokeModelWithResponseStream',
              'bedrock:InvokeModel'
            ],
            resources: ['*']
        }));
        llmEvalFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:PutObject',
            ],
            resources: [
                props.evalTestCasesBucket.bucketArn, 
                props.evalTestCasesBucket.bucketArn + "/*", 
                props.evalTestCasesBucket.arnForObjects('*'),
                props.evalResultsBucket.bucketArn,
                props.evalResultsBucket.bucketArn + "/*",
                props.evalResultsBucket.arnForObjects('*')
            ]
        }));
        generateResponseFunction.grantInvoke(llmEvalFunction);
        this.llmEvalFunction = llmEvalFunction;

        const aggregateEvalResultsFunction = new lambda.Function(this, 'AggregateEvalResultsFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            code: lambda.Code.fromAsset(path.join(__dirname, 'llm-evaluation/aggregate-eval-results')), 
            handler: 'lambda_function.lambda_handler', 
            environment: {
                "TEST_CASES_BUCKET" : props.evalTestCasesBucket.bucketName,
                "EVAL_RESULTS_BUCKET" : props.evalResultsBucket.bucketName
            },
            timeout: cdk.Duration.seconds(30)
        });
        aggregateEvalResultsFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:PutObject',
            ],
            resources: [
                props.evalTestCasesBucket.bucketArn, 
                props.evalTestCasesBucket.bucketArn + "/*", 
                props.evalTestCasesBucket.arnForObjects('*'),
                props.evalResultsBucket.bucketArn,
                props.evalResultsBucket.bucketArn + "/*",
                props.evalResultsBucket.arnForObjects('*')
            ]
        }));
        this.aggregateEvalResultsFunction = aggregateEvalResultsFunction;

        const llmEvalCleanupFunction = new lambda.Function(this, 'LlmEvalCleanupFunction', {
            runtime: lambda.Runtime.PYTHON_3_12,
            code: lambda.Code.fromAsset(path.join(__dirname, 'llm-evaluation/cleanup')), 
            handler: 'lambda_function.lambda_handler', 
            environment: {
                "TEST_CASES_BUCKET" : props.evalTestCasesBucket.bucketName,
                "EVAL_RESULTS_BUCKET" : props.evalResultsBucket.bucketName
            },
            timeout: cdk.Duration.seconds(30)
        });
        llmEvalCleanupFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:ListBucket',
                's3:DeleteObject',
                's3:DeleteObjects'
            ],
            resources: [
                props.evalTestCasesBucket.bucketArn, 
                props.evalTestCasesBucket.bucketArn + "/*", 
                props.evalTestCasesBucket.arnForObjects('*'),
                props.evalResultsBucket.bucketArn,
                props.evalResultsBucket.bucketArn + "/*",
                props.evalResultsBucket.arnForObjects('*')
            ]
        }));
        this.llmEvalCleanupFunction = llmEvalCleanupFunction;

        const splitTestCasesTask = new tasks.LambdaInvoke(this, 'Split Test Cases', {
            lambdaFunction: this.splitEvalTestCasesFunction,
            outputPath: '$.Payload',
          });

        const evaluateTestCasesTask = new tasks.LambdaInvoke(this, 'Evaluate Test Cases', {
            lambdaFunction: this.llmEvalFunction,
            // payload: stepfunctions.TaskInput.fromObject({
            //     'chunk_key.$': '$',
            //     'evaluation_id.$': '$.evaluation_id',
            // }),
            outputPath: '$.Payload',
        });


        const processTestCasesMap = new stepfunctions.Map(this, 'Process Test Cases', {
            itemsPath: '$.chunk_keys',
            maxConcurrency: 5,
            resultPath: '$.partial_result_keys',
            itemSelector: {
                'chunk_key.$': '$$.Map.Item.Value.chunk_key',
                'evaluation_id.$': '$$.Map.Item.Value.evaluation_id',
            },
        });
        processTestCasesMap.itemProcessor(evaluateTestCasesTask);
    
        const aggregateResultsTask = new tasks.LambdaInvoke(this, 'Aggregate Results', {
        lambdaFunction: this.aggregateEvalResultsFunction,
        payload: stepfunctions.TaskInput.fromObject({
            //'partial_results_list.$': '$.ProcessedResults',
            'partial_result_keys.$': '$.partial_result_keys',
            'evaluation_id.$': '$.evaluation_id',
            'evaluation_name.$': '$.evaluation_name',
            'test_cases_key.$': '$.test_cases_key',
        }),
        outputPath: '$.Payload',
        });
      
        const saveResultsTask = new tasks.LambdaInvoke(this, 'Save Evaluation Results', {
        lambdaFunction: this.llmEvalResultsHandlerFunction,
        payload: stepfunctions.TaskInput.fromObject({
            'evaluation_id.$': '$.evaluation_id',
            'evaluation_name.$': '$.evaluation_name',
            'average_similarity.$': '$.average_similarity',
            'average_relevance.$': '$.average_relevance',
            'average_correctness.$': '$.average_correctness',
            'total_questions.$': '$.total_questions',
            'detailed_results_s3_key.$': '$.detailed_results_s3_key',
            // 'detailed_results.$': '$.detailed_results',
            'test_cases_key.$': '$.test_cases_key',
        }),
        outputPath: '$.Payload',
        });

        const cleanupChunksTask = new tasks.LambdaInvoke(this, 'Cleanup Chunks', {
            lambdaFunction: this.llmEvalCleanupFunction,
            payload: stepfunctions.TaskInput.fromObject({
                'body.$': '$.body',
            }),
            outputPath: '$.Payload',
        });
      
        const definition = splitTestCasesTask
        .next(processTestCasesMap)
        .next(aggregateResultsTask)
        .next(saveResultsTask)
        .next(cleanupChunksTask);

        const llmEvalStateMachine = new stepfunctions.StateMachine(this, 'EvaluationStateMachine', {
            definitionBody: stepfunctions.DefinitionBody.fromChainable(definition),
            timeout: cdk.Duration.hours(1),
        });
        this.llmEvalStateMachine = llmEvalStateMachine;

        const startLlmEvalStateMachineFunction = new lambda.Function(this, 'StartLlmEvalStateMachineFunction', {
            runtime: lambda.Runtime.NODEJS_20_X,
            code: lambda.Code.fromAsset(path.join(__dirname, 'llm-evaluation/start-llm-eval')), 
            handler: 'index.handler', 
            environment: {
                "STATE_MACHINE_ARN" : this.llmEvalStateMachine.stateMachineArn
            },
            timeout: cdk.Duration.seconds(30)
        });
        startLlmEvalStateMachineFunction.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['states:StartExecution'],
            resources: [this.llmEvalStateMachine.stateMachineArn], 
        }));
        this.startLlmEvalStateMachineFunction = startLlmEvalStateMachineFunction;
    }
}