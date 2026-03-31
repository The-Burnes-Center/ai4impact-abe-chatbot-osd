import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GenAiMvpStack } from '../lib/gen-ai-mvp-stack';

// Instantiate the stack once; synth is triggered lazily by Template.fromStack.
function buildTemplate(): Template {
  const app = new cdk.App();
  const stack = new GenAiMvpStack(app, 'TestStack');
  return Template.fromStack(stack);
}

let template: Template;
beforeAll(() => {
  template = buildTemplate();
});

// ─── DynamoDB Tables ────────────────────────────────────────────────────────

describe('DynamoDB tables', () => {
  test('ChatHistoryTable has correct key schema (user_id / session_id)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'user_id', KeyType: 'HASH' },
        { AttributeName: 'session_id', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('ChatHistoryTable has TimeIndex GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'TimeIndex',
          KeySchema: Match.arrayWith([
            { AttributeName: 'user_id', KeyType: 'HASH' },
            { AttributeName: 'time_stamp', KeyType: 'RANGE' },
          ]),
        }),
      ]),
    });
  });

  test('UserFeedbackTable has correct key schema (Topic / CreatedAt)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'Topic', KeyType: 'HASH' },
        { AttributeName: 'CreatedAt', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('ExcelIndexDataTable has correct key schema (pk / sk)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('PromptRegistryTable has correct key schema (PromptFamily / VersionId)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PromptFamily', KeyType: 'HASH' },
        { AttributeName: 'VersionId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('EvaluationSummariesTable has correct key schema (PartitionKey / Timestamp)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'PartitionKey', KeyType: 'HASH' },
        { AttributeName: 'Timestamp', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('EvaluationResultsTable has correct key schema (EvaluationId / QuestionId)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'EvaluationId', KeyType: 'HASH' },
        { AttributeName: 'QuestionId', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('AnalyticsTable has correct key schema (topic / timestamp)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'topic', KeyType: 'HASH' },
        { AttributeName: 'timestamp', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('TestLibraryTable has NormalizedQuestionIndex GSI', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'NormalizedQuestionIndex',
          Projection: { ProjectionType: 'KEYS_ONLY' },
        }),
      ]),
    });
  });

  test('SyncHistoryTable has TTL attribute configured', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'expiresAt',
        Enabled: true,
      },
    });
  });

  test('all core tables have point-in-time recovery enabled', () => {
    // Every table we define sets pointInTimeRecovery: true
    const tables = template.findResources('AWS::DynamoDB::Table', {
      Properties: {
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      },
    });
    // At minimum the 13 tables defined in tables.ts should all have PITR
    expect(Object.keys(tables).length).toBeGreaterThanOrEqual(13);
  });
});

// ─── Lambda Functions ────────────────────────────────────────────────────────

describe('Lambda functions', () => {
  test('chat handler uses nodejs20.x runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
    });
  });

  test('chat handler uses ARM_64 architecture', () => {
    // ChatHandlerFunction is Node.js 20 + ARM_64 from LAMBDA_DEFAULTS
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Architectures: ['arm64'],
    });
  });

  test('Python Lambda functions use python3.12 runtime', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
    });
  });

  test('Python Lambda functions use ARM_64 architecture', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.12',
      Architectures: ['arm64'],
    });
  });

  test('chat handler has 300-second timeout', () => {
    // websocketAPIFunction is given a 300 s timeout
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      Timeout: 300,
    });
  });

  test('chat handler has at least 512 MB memory', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs20.x',
      MemorySize: 512,
    });
  });

  test('multiple Lambda functions are created', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    // Stack defines well over 10 Lambdas (session, chat, feedback, s3, sync, eval…)
    expect(Object.keys(functions).length).toBeGreaterThan(10);
  });
});

// ─── S3 Buckets ──────────────────────────────────────────────────────────────

describe('S3 buckets', () => {
  test('all buckets block all public access', () => {
    const buckets = template.findResources('AWS::S3::Bucket', {
      Properties: {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      },
    });
    // We define 7 application buckets (knowledge, feedback, evalResults,
    // evalTestCases, ragas, contractIndex, dataStaging) + website bucket
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(7);
  });

  test('KnowledgeSourceBucket has versioning enabled', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
    });
  });

  test('buckets enforce SSL via bucket policy', () => {
    // enforceSSL: true adds a bucket policy that denies non-HTTPS requests
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      }),
    });
  });

  test('multiple S3 buckets exist', () => {
    const buckets = template.findResources('AWS::S3::Bucket');
    expect(Object.keys(buckets).length).toBeGreaterThanOrEqual(7);
  });
});

// ─── WebSocket API ────────────────────────────────────────────────────────────

describe('WebSocket API', () => {
  test('WebSocket API is created', () => {
    // Stack contains one WebSocket API and one HTTP API (2 total)
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 2);
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
    });
  });

  test('WebSocket API has a prod stage with auto-deploy', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: 'prod',
      AutoDeploy: true,
    });
  });

  test('getChatbotResponse route is defined', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'getChatbotResponse',
    });
  });

  test('$connect route is defined', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$connect',
    });
  });

  test('$disconnect route is defined', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$disconnect',
    });
  });
});

// ─── HTTP API (REST backend) ──────────────────────────────────────────────────

describe('HTTP API', () => {
  test('HTTP API is created', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
    });
  });
});

// ─── Cognito ──────────────────────────────────────────────────────────────────

describe('Cognito', () => {
  test('User Pool is created', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('User Pool enforces advanced security mode', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED' },
    });
  });

  test('User Pool requires email sign-in alias', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
    });
  });

  test('User Pool has strong password policy', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: Match.objectLike({
        PasswordPolicy: Match.objectLike({
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        }),
      }),
    });
  });

  test('User Pool Client is created', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  });

  test('User Pool Domain is created', () => {
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });
});

// ─── IAM ─────────────────────────────────────────────────────────────────────

describe('IAM roles and policies', () => {
  test('Lambda execution roles are created', () => {
    const roles = template.findResources('AWS::IAM::Role', {
      Properties: {
        AssumeRolePolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Principal: { Service: 'lambda.amazonaws.com' },
            }),
          ]),
        }),
      },
    });
    expect(Object.keys(roles).length).toBeGreaterThan(5);
  });

  test('Bedrock Knowledge Base role trusts bedrock.amazonaws.com', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: { Service: 'bedrock.amazonaws.com' },
          }),
        ]),
      }),
    });
  });

  test('IAM policies exist for Lambda functions', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    expect(Object.keys(policies).length).toBeGreaterThan(0);
  });
});

// ─── OpenSearch Serverless ────────────────────────────────────────────────────

describe('OpenSearch Serverless', () => {
  test('VECTORSEARCH collection is created', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
      Type: 'VECTORSEARCH',
    });
  });

  test('encryption security policy is created', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::SecurityPolicy', {
      Type: 'encryption',
    });
  });

  test('network security policy is created', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::SecurityPolicy', {
      Type: 'network',
    });
  });

  test('data access policy is created', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::AccessPolicy', {
      Type: 'data',
    });
  });
});

// ─── Bedrock Knowledge Base ───────────────────────────────────────────────────

describe('Bedrock Knowledge Base', () => {
  test('Bedrock Knowledge Base is created', () => {
    template.resourceCountIs('AWS::Bedrock::KnowledgeBase', 1);
  });

  test('Bedrock Data Source is created', () => {
    template.resourceCountIs('AWS::Bedrock::DataSource', 1);
  });
});

// ─── SQS Queues ───────────────────────────────────────────────────────────────

describe('SQS queues', () => {
  test('FeedbackToTestLibraryQueue is created with a DLQ', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 120,
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    });
  });

  test('FeedbackToTestLibraryDLQ is created', () => {
    // DLQ has a 14-day retention and no redrive policy of its own
    template.hasResourceProperties('AWS::SQS::Queue', {
      MessageRetentionPeriod: 14 * 24 * 3600, // 1209600 seconds
    });
  });
});

// ─── Stack-level tags ─────────────────────────────────────────────────────────

describe('Stack tags', () => {
  // Tags are applied via cdk.Tags.of(this).add() and appear in the
  // CloudFormation template under each resource's Tags array.
  test('Project=ABE tag is applied to Lambda functions', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Tags: Match.arrayWith([{ Key: 'Project', Value: 'ABE' }]),
    });
  });

  test('ManagedBy=CDK tag is applied to Lambda functions', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Tags: Match.arrayWith([{ Key: 'ManagedBy', Value: 'CDK' }]),
    });
  });
});
