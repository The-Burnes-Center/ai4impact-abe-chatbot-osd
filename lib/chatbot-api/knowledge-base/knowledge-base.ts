import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

import { aws_bedrock as bedrock } from 'aws-cdk-lib';

import { Construct } from "constructs";
import { OpenSearchStack } from "../opensearch/opensearch";

export interface KnowledgeBaseStackProps {
  readonly openSearch: OpenSearchStack;
  readonly s3bucket: s3.Bucket;
  /**
   * Supplemental storage bucket required when the data source uses
   * parsingModality=MULTIMODAL. The Bedrock parser writes extracted page
   * images and visual elements here; the KB reads them back at query time.
   */
  readonly supplementalBucket: s3.Bucket;
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

    // Bedrock KB needs read+write on the supplemental bucket so the multimodal
    // parser can persist extracted page images during ingestion and the KB can
    // retrieve them at query time.
    props.openSearch.knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket'],
      resources: [
        props.supplementalBucket.bucketArn,
        props.supplementalBucket.bucketArn + "/*",
      ],
    }));

    props.openSearch.knowledgeBaseRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        // Parser model for BEDROCK_FOUNDATION_MODEL parsingStrategy (vision-capable
        // layout extraction so checkbox state survives ingestion).
        `arn:aws:bedrock:${stack.region}::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0`,
        // The us. inference profile dispatches across these regions; AWS requires
        // explicit permission on each underlying foundation-model ARN.
        `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
        `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0`,
      ],
    }));

    const knowledgeBase = new bedrock.CfnKnowledgeBase(scope, 'KnowledgeBase', {
      knowledgeBaseConfiguration: {
        type: 'VECTOR',
        vectorKnowledgeBaseConfiguration: {
          embeddingModelArn: `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
          // Required by Bedrock when any data source uses parsingModality=MULTIMODAL.
          // The parser writes extracted images/visual elements here during ingestion.
          supplementalDataStorageConfiguration: {
            supplementalDataStorageLocations: [
              {
                supplementalDataStorageLocationType: 'S3',
                s3Location: {
                  uri: `s3://${props.supplementalBucket.bucketName}/`,
                },
              },
            ],
          },
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
        // Use a vision-capable Claude model to parse PDFs at ingestion time.
        // The default Bedrock parser is text-only and drops form-field state
        // (e.g. RFR section 1.4.6 acquisition-method checkboxes), which made
        // ABE unable to identify which option was marked. Multimodal parsing
        // renders each page as an image and transcribes form fields with
        // their state preserved.
        parsingConfiguration: {
          parsingStrategy: 'BEDROCK_FOUNDATION_MODEL',
          bedrockFoundationModelConfiguration: {
            // Cross-region inference profile — required for Claude 3.5 Sonnet
            // v2 in us-east-1 and routes between us-east-1/2 and us-west-2.
            modelArn: `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/us.anthropic.claude-3-5-sonnet-20241022-v2:0`,
            // MULTIMODAL is essential — without it the FM parser falls back to
            // text-only extraction and the checkbox glyphs are still lost.
            parsingModality: 'MULTIMODAL',
            parsingPrompt: {
              parsingPromptText: [
                'Transcribe this document into plain text while preserving its structure.',
                '',
                'CRITICAL — Form fields:',
                '- When you see a checkbox table, render each row as `[X] Label` if the checkbox is marked (filled, checked, or contains an X/✓/✗) and `[ ] Label` if it is empty. Do not omit any row.',
                '- Preserve the *state* of every checkbox, radio button, and form field. The selection is often the most important content on the page.',
                '- For signature/initial fields, write `[signed]` if filled, `[not signed]` if empty.',
                '',
                'Tables: render as Markdown tables with column headers. Keep numeric values verbatim.',
                'Headings: preserve the document\'s section numbering (e.g. "1.4.6 Acquisition Method(s)").',
                'Reading order: top-to-bottom, left-to-right. Multi-column layouts should be linearized correctly.',
                'Do not summarize, paraphrase, or add commentary. Output only the transcribed document content.',
              ].join('\n'),
            },
          },
        },
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