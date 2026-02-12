import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as triggers from 'aws-cdk-lib/triggers'
import * as cr from 'aws-cdk-lib/custom-resources'

import { aws_opensearchserverless as opensearchserverless } from 'aws-cdk-lib';
import { aws_bedrock as bedrock } from 'aws-cdk-lib';

import { Construct } from "constructs";
import { stackName } from "../../constants"
import { OpenSearchStack } from "../opensearch/opensearch"

export interface KnowledgeBaseStackProps {
  readonly openSearch: OpenSearchStack,
  readonly s3bucket : s3.Bucket
}

export class KnowledgeBaseStack extends cdk.Stack {

  public readonly knowledgeBase: bedrock.CfnKnowledgeBase;
  public readonly dataSource: bedrock.CfnDataSource;

  constructor(scope: Construct, id: string, props: KnowledgeBaseStackProps) {
    super(scope, id);

    // add AOSS access to the role
    props.openSearch.knowledgeBaseRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['aoss:APIAccessAll'],
        resources: [
          `arn:aws:aoss:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:collection/${props.openSearch.openSearchCollection.attrId}`
        ]
      }
      )
    )

    // add s3 access to the role
    props.openSearch.knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        's3:GetObject',
        's3:ListBucket',
      ],
      resources: [props.s3bucket.bucketArn, props.s3bucket.bucketArn + "/*"]
    }));

    // add bedrock access to the role
    props.openSearch.knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/amazon.titan-embed-text-v2:0`
      ]
    }
    )
    )


    const knowledgeBase = new bedrock.CfnKnowledgeBase(scope, 'KnowledgeBase', {
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${cdk.Stack.of(this).region}::foundation-model/amazon.titan-embed-text-v2:0`,
        },
      },
      name: `${stackName}-kb`,
      roleArn: props.openSearch.knowledgeBaseRole.roleArn,
      storageConfiguration: {
        type: 'OPENSEARCH_SERVERLESS',

        // the properties below are optional
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

      // the properties below are optional
      description: `Bedrock Knowledge Base for ${stackName}`,
    });

    knowledgeBase.addDependency(props.openSearch.openSearchCollection);
    knowledgeBase.node.addDependency(props.openSearch.lambdaCustomResource)

    const dataSource = new bedrock.CfnDataSource(scope, 'S3DataSource', {
      dataSourceConfiguration: {
        type: 'S3',
        s3Configuration: {
          bucketArn: props.s3bucket.bucketArn,
        },

      },
      knowledgeBaseId: knowledgeBase.attrKnowledgeBaseId,
      // Name must differ from the old DataSource during CloudFormation Replacement
      // (CFN creates the new resource before deleting the old one).
      name: `${stackName}-kb-ds`,

      // the properties below are optional      
      description: 'S3 data source',
      // Chunking config is applied via addPropertyOverride below because
      // CDK 2.140.0 types don't include SEMANTIC chunking (added in later versions).
      // CloudFormation fully supports it -- we inject the raw CFN properties.
      vectorIngestionConfiguration: {
        chunkingConfiguration: {
          chunkingStrategy: 'SEMANTIC',
        } as bedrock.CfnDataSource.ChunkingConfigurationProperty,
      },
    });

    dataSource.addDependency(knowledgeBase);

    // Inject semantic chunking config via CloudFormation override.
    // CDK 2.140.0 L1 types don't include SemanticChunkingConfiguration,
    // so we bypass the type system to set it directly in the CFN template.
    // Semantic chunking splits documents based on meaning changes using NLP --
    // far better for procurement docs (policies, contracts, memos) than fixed-size.
    dataSource.addPropertyOverride(
      'VectorIngestionConfiguration.ChunkingConfiguration.SemanticChunkingConfiguration',
      {
        // 95th percentile = only the top 5% most dissimilar sentence pairs
        // trigger a split. Conservative setting keeps related content together.
        BreakpointPercentileThreshold: 95,
        // bufferSize 1 = compare each sentence with 1 adjacent sentence for context
        BufferSize: 1,
        // 512 tokens max per chunk (up from 300 fixed). Semantic chunking
        // naturally produces variable-size chunks; this caps the upper bound.
        MaxTokens: 512,
      }
    );

    this.knowledgeBase = knowledgeBase;
    this.dataSource = dataSource;
  }
}