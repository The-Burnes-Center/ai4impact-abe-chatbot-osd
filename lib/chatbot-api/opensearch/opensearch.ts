import * as cdk from 'aws-cdk-lib';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';

import { Construct } from "constructs";
import { aws_opensearchserverless as opensearchserverless } from 'aws-cdk-lib';

export interface OpenSearchStackProps {}

export class OpenSearchStack extends Construct {

  public readonly openSearchCollection: opensearchserverless.CfnCollection;
  public readonly collectionName: string;
  public readonly knowledgeBaseRole: iam.Role;
  public readonly lambdaCustomResource: cdk.CustomResource;

  constructor(scope: Construct, id: string, props: OpenSearchStackProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);
    const prefix = stack.stackName.toLowerCase().slice(0, 10);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate resources.

    this.collectionName = `${stack.stackName.toLowerCase()}-oss-collection`;
    const openSearchCollection = new opensearchserverless.CfnCollection(scope, 'OpenSearchCollection', {
      name: this.collectionName,
      description: `OpenSearch Serverless Collection for ${stack.stackName}`,
      standbyReplicas: 'DISABLED',
      type: 'VECTORSEARCH',
    });

    const encPolicy = new opensearchserverless.CfnSecurityPolicy(scope, 'OSSEncryptionPolicy', {
      name: `${prefix}-oss-enc-policy`,
      policy: `{"Rules":[{"ResourceType":"collection","Resource":["collection/${this.collectionName}"]}],"AWSOwnedKey":true}`,
      type: 'encryption',
    });

    const networkPolicy = new opensearchserverless.CfnSecurityPolicy(scope, "OSSNetworkPolicy", {
      name: `${prefix}-oss-network-policy`,
      type: "network",
      policy: `[{"Rules":[{"ResourceType":"dashboard","Resource":["collection/${this.collectionName}"]},{"ResourceType":"collection","Resource":["collection/${this.collectionName}"]}],"AllowFromPublic":true}]`,
    });

    const indexFunctionRole = new iam.Role(scope, 'IndexFunctionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    const knowledgeBaseRole = new iam.Role(scope, "KnowledgeBaseRole", {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });

    this.knowledgeBaseRole = knowledgeBaseRole;

    const accessPolicy = new opensearchserverless.CfnAccessPolicy(scope, "OSSAccessPolicy", {
      name: `${prefix}-oss-access-policy`,
      type: "data",
      policy: JSON.stringify([
        {
          "Rules": [
            {
              "ResourceType": "index",
              "Resource": [`index/${this.collectionName}/*`],
              "Permission": [
                "aoss:UpdateIndex",
                "aoss:DescribeIndex",
                "aoss:ReadDocument",
                "aoss:WriteDocument",
                "aoss:CreateIndex",
              ],
            },
            {
              "ResourceType": "collection",
              "Resource": [`collection/${this.collectionName}`],
              "Permission": [
                "aoss:DescribeCollectionItems",
                "aoss:CreateCollectionItems",
                "aoss:UpdateCollectionItems",
              ],
            },
          ],
          "Principal": [indexFunctionRole.roleArn, new iam.AccountPrincipal(stack.account).arn, knowledgeBaseRole.roleArn],
        },
      ]),
    });

    openSearchCollection.addDependency(encPolicy);
    openSearchCollection.addDependency(networkPolicy);
    openSearchCollection.addDependency(accessPolicy);

    this.openSearchCollection = openSearchCollection;

    const openSearchCreateIndexFunction = new lambda.Function(scope, 'OpenSearchCreateIndexFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, 'create-index-lambda'), {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          command: [
            'bash', '-c',
            'pip install -r requirements.txt -t /asset-output && cp -au . /asset-output',
          ],
        },
      }),
      handler: 'lambda_function.lambda_handler',
      role: indexFunctionRole,
      environment: {
        COLLECTION_ENDPOINT: `${openSearchCollection.attrId}.${stack.region}.aoss.amazonaws.com`,
        INDEX_NAME: 'knowledge-base-index',
        EMBEDDING_DIM: '1024',
        REGION: stack.region,
      },
      timeout: cdk.Duration.seconds(120),
    });

    indexFunctionRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['aoss:APIAccessAll'],
      resources: [`arn:aws:aoss:${stack.region}:${stack.account}:collection/${openSearchCollection.attrId}`],
    }));

    const lambdaProvider = new cr.Provider(scope, "CreateIndexFunctionCustomProvider", {
      onEventHandler: openSearchCreateIndexFunction,
    });

    const lambdaCustomResource = new cdk.CustomResource(scope, "CreateIndexFunctionCustomResource", {
      serviceToken: lambdaProvider.serviceToken,
    });

    this.lambdaCustomResource = lambdaCustomResource;
  }
}