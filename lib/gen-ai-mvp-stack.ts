import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { ChatBotApi } from "./chatbot-api";
import { cognitoDomainName } from "./constants";
import { AuthorizationStack } from "./authorization";
import { UserInterface } from "./user-interface";

export interface GenAiMvpStackProps extends cdk.StackProps {
  // Custom domain (CloudFront alternate domain name) + its ACM certificate ARN (us-east-1).
  // Supplied per-deployment via CDK context / env vars (never hardcoded), so each branch and
  // account that deploys this code provides its own values — or none, in which case the app
  // stays on the default CloudFront domain.
  readonly customDomain?: string;
  readonly certificateArn?: string;
}

export class GenAiMvpStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: GenAiMvpStackProps) {
    super(scope, id, props);

    const authentication = new AuthorizationStack(this, "Authorization");
    const alarmEmail = this.node.tryGetContext('alarmEmail') as string | undefined;

    // Bind the custom domain only when BOTH the hostname and its cert ARN were provided for
    // this deployment; otherwise everything below falls back to the CloudFront domain.
    const customDomain = props?.customDomain && props?.certificateArn ? props.customDomain : undefined;
    const certificateArn = props?.certificateArn || undefined;

    // CloudFront is created inside UserInterface (after ChatBotApi), so we use a Lazy token
    // to defer CORS origin resolution until CDK synth — by then the distribution domain is set.
    const cfOriginRef = { value: '*' };
    const allowedOrigin = cdk.Lazy.string({ produce: () => cfOriginRef.value });

    const chatbotAPI = new ChatBotApi(this, "ChatbotAPI", { authentication, alarmEmail, allowedOrigin });
    const userInterface = new UserInterface(this, "UserInterface", {
      userPoolId: authentication.userPool.userPoolId,
      userPoolClientId: authentication.userPoolClient.userPoolClientId,
      cognitoDomain: cognitoDomainName,
      api: chatbotAPI,
      customDomain,
      certificateArn,
    });
    // Populate after construction — the Lazy producer reads this during app.synth().
    // When a custom domain is bound, the browser's Origin is that domain, so CORS
    // (HTTP API + S3) must allow it instead of the CloudFront domain.
    cfOriginRef.value = customDomain
      ? `https://${customDomain}`
      : `https://${userInterface.distribution.distributionDomainName}`;

    // Resource tags applied to every taggable resource in the stack.
    // AOSS resources are excluded: the deployed collection was created with a legacy name
    // and adding tags would put it in the CloudFormation changeset, surfacing the name
    // mismatch and requiring replacement. Exclude until the collection is properly renamed.
    const tagOpts = {
      excludeResourceTypes: ['AWS::OpenSearchServerless::Collection'],
    };
    cdk.Tags.of(this).add('Project', 'ABE', tagOpts);
    cdk.Tags.of(this).add('Environment', id, tagOpts); // e.g. ABEStackNonProd
    cdk.Tags.of(this).add('ManagedBy', 'CDK', tagOpts);
    cdk.Tags.of(this).add('DataClass', 'Sensitive', tagOpts); // government procurement data

    this.addNagSuppressions();
  }

  private addNagSuppressions() {
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for all Lambda functions to write logs to CloudWatch.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'],
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AmazonAPIGatewayPushToCloudWatchLogs is the AWS-managed policy required for API Gateway access logging.',
        appliesTo: ['Policy::arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'X-Ray tracing requires xray:PutTraceSegments/PutTelemetryRecords on Resource::* -- this is the standard pattern for X-Ray.',
        appliesTo: ['Resource::*'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'S3 object-level operations require /* suffix to access all objects in a bucket. Actions are scoped to specific buckets.',
        appliesTo: [
          'Resource::<ChatbotAPIKnowledgeSourceBucketD704DDFD.Arn>/*',
          'Resource::<ChatbotAPIFeedbackDownloadBucket5357D600.Arn>/*',
          'Resource::<ChatbotAPIEvalResultsBucketCB2F9C6D.Arn>/*',
          'Resource::<ChatbotAPIEvalTestCasesBucket3A06FDF6.Arn>/*',
          'Resource::<UserInterfaceWebsiteBucket2BDEA247.Arn>/*',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB GSI access requires /index/* suffix. Actions are scoped to specific tables.',
        appliesTo: [
          'Resource::<ChatbotAPIChatHistoryTable86F70C1D.Arn>/index/*',
          'Resource::<ChatbotAPIUserFeedbackTableF734E54F.Arn>/index/*',
          'Resource::<ChatbotAPIEvaluationResultsTableE72FCF7C.Arn>/index/*',
          'Resource::<ChatbotAPIEvaluationSummariesTableE9B95A54.Arn>/index/*',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Bedrock model wildcards are required for cross-region inference profiles and to allow model upgrades without redeploying IAM policies.',
        appliesTo: [
          'Resource::arn:aws:bedrock:*::foundation-model/anthropic.*',
          'Resource::arn:aws:bedrock:*::foundation-model/amazon.titan-embed-*',
          'Resource::arn:aws:bedrock:*:<AWS::AccountId>:inference-profile/*',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'WebSocket connection management requires wildcard on @connections/* to send messages to any connected client.',
        appliesTo: [
          'Resource::arn:<AWS::Partition>:execute-api:<AWS::Region>:<AWS::AccountId>:<ChatbotAPIWebsocketBackendWSAPI75718B83>/*/*/@connections/*',
        ],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Step Functions Lambda invoke requires :* suffix to support Lambda function versions and aliases.',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CDK BucketDeployment and custom resources require broad S3 permissions -- these are CDK-managed constructs.',
        appliesTo: [
          'Action::s3:GetBucket*',
          'Action::s3:GetObject*',
          'Action::s3:List*',
          'Action::s3:Abort*',
          'Action::s3:DeleteObject*',
        ],
      },
      {
        id: 'AwsSolutions-S1',
        reason: 'Access logging on internal data buckets (eval, RAGAS, feedback, knowledge) adds cost without proportional security benefit. Distribution and website buckets already have access logging enabled.',
      },
      {
        id: 'AwsSolutions-COG2',
        reason: 'MFA is set to OPTIONAL. Users with admin roles are encouraged to enable MFA. Making MFA REQUIRED would break OIDC federation flows.',
      },
      {
        id: 'AwsSolutions-APIG4',
        reason: 'OPTIONS routes handle CORS preflight requests which cannot carry authorization headers by browser specification.',
      },
      {
        id: 'AwsSolutions-APIG1',
        reason: 'Access logging is configured on both HTTP API and WebSocket API stages via CfnStage escape hatches. CDK Nag may not detect it on the L2 construct.',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'CDK-managed custom resource Lambda runtimes (BucketDeployment, Provider framework) are controlled by CDK, not application code.',
      },
      {
        id: 'AwsSolutions-SNS2',
        reason: 'Monitoring SNS topic carries alarm notifications only (no sensitive data). SSE adds cost without security benefit here.',
      },
      {
        id: 'AwsSolutions-SNS3',
        reason: 'Monitoring SNS topic uses HTTPS subscriptions by default. Enforcing SSL transport is not configurable on L2 SNS Topic.',
      },
    ]);
  }
}
