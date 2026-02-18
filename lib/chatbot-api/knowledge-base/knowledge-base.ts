import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

import { aws_bedrock as bedrock } from 'aws-cdk-lib';

import { Construct } from "constructs";
import { OpenSearchStack } from "../opensearch/opensearch";

export interface KnowledgeBaseStackProps {
  readonly openSearch: OpenSearchStack;
  readonly s3bucket: s3.Bucket;
}

export class KnowledgeBaseStack extends Construct {

  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id);

    const stack = cdk.Stack.of(this);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate resources.

    props.openSearch.knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: [
          `arn:aws:aoss:${stack.region}:${stack.account}:collection/${props.openSearch.openSearchCollection.attrId}`,
        ],
      })
    );

    props.openSearch.knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [props.s3bucket.bucketArn, props.s3bucket.bucketArn + "/*"],
    }));

    props.openSearch.knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    }));

    const knowledgeBase = new bedrock.CfnKnowledgeBase(scope, 'KnowledgeBase', {
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      name: `${stack.stackName}-kb`,
      roleArn: props.openSearch.knowledgeBaseRole.roleArn,
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn: props.openSearch.openSearchCollection.attrArn,
          fieldMapping: {
            metadataField: 'metadata_field',
            textField: 'text_field',
            vectorField: 'vector_field',
          },
          vectorIndexName: 'knowledge-base-index',
        },
      },
      description: `Bedrock Knowledge Base for ${stack.stackName}`,
    });

    knowledgeBase.addDependency(props.openSearch.openSearchCollection);
    knowledgeBase.node.addDependency(props.openSearch.lambdaCustomResource);

    const dataSource = new bedrock.CfnDataSource(scope, 'S3DataSource', {
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.s3bucket.bucketArn,
        },
      },
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      name: `${stack.stackName}-kb-ds`,
      description: 'S3 data source',
      // CDK 2.140.0 types don't include SEMANTIC chunking; we inject via
      // addPropertyOverride below. CloudFormation fully supports it.
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'SEMANTIC',
        } as bedrock.CfnDataSource.ChunkingConfigurationProperty,
      },
    });

    dataSource.addDependency(knowledgeBase);

    dataSource.addPropertyOverride(
      'VectorIngestionConfiguration.ChunkingConfiguration.SemanticChunkingConfiguration',
      {
        BreakpointPercentileThreshold: 95,
        BufferSize: 1,
        MaxTokens: 512,
      }
    );

    this.knowledgeBase = knowledgeBase;
    this.dataSource = dataSource;
  }
}