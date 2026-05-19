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
      // InvokeModel: actually call the model during ingestion.
      // GetFoundationModel: Bedrock validates the parser model at DataSource
      //   create time and reads it during ingestion. Without this the create
      //   fails. Earlier attempts using a cross-region inference profile
      //   needed bedrock:GetInferenceProfile too, but that validation races
      //   IAM propagation (CFN reports the policy complete before IAM has
      //   actually published it, so the call fails). Using a direct
      //   foundation-model ARN here sidesteps that race entirely.
      actions: [
        'bedrock:InvokeModel',
        'bedrock:GetFoundationModel',
      ],
      resources: [
        `arn:aws:bedrock:${stack.region}::foundation-model/amazon.titan-embed-text-v2:0`,
        // Parser model for BEDROCK_FOUNDATION_MODEL parsingStrategy (Claude 3
        // Sonnet — vision-capable, available natively in us-east-1, no
        // inference profile required, documented as supported for KB parsing).
        `arn:aws:bedrock:${stack.region}::foundation-model/anthropic.claude-sonnet-4-6`,
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
      // -v2 suffix forces a clean create-then-delete in CloudFormation when the
      // KB is replaced (e.g. enabling multimodal parsing requires replacement,
      // and CFN would otherwise try to create a new resource with the same name
      // as the existing one and fail with AlreadyExists). The OpenSearch
      // collection + vector index are shared; orphan chunks from the old KB
      // remain in the index, filtered out at retrieval by KB-ID metadata.
      name: `${stack.stackName}-kb-v2`,
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

    // Bedrock validates the KB role's bucket access at CreateKnowledgeBase
    // time. Without an explicit dep, CFN runs the role's default-policy
    // update in parallel with the KB create call, causing "IAM role doesn't
    // have access to the specified bucket" failures when the supplemental
    // bucket grant hasn't propagated yet. addToPolicy() above attaches all
    // statements to the role's auto-generated DefaultPolicy resource; force
    // CFN to finish that update before attempting the KB create.
    const kbRoleDefaultPolicy = props.openSearch.knowledgeBaseRole.node.tryFindChild('DefaultPolicy');
    if (kbRoleDefaultPolicy) {
      knowledgeBase.node.addDependency(kbRoleDefaultPolicy);
    }
    // Also depend on the supplemental bucket directly; CDK normally derives
    // this from the bucketName reference, but L1 CfnKnowledgeBase doesn't
    // always pick it up cleanly.
    knowledgeBase.node.addDependency(props.supplementalBucket);

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
            // Direct foundation-model ARN — avoids the inference-profile
            // validation step at DataSource create time, which races IAM
            // propagation (see role policy comment above). Claude 3 Sonnet is
            // vision-capable and documented as supported for KB parsing.
            modelArn: `arn:aws:bedrock:${stack.region}::foundation-model/anthropic.claude-sonnet-4-6`,
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

    // The DataSource also calls Bedrock to validate the parser model at
    // create time and Bedrock checks the role's permissions then. Even with
    // the KB -> policy dep above, the dataSource needs its own dependency
    // because CFN's transitive resolution doesn't always wait long enough for
    // IAM propagation between resources.
    if (kbRoleDefaultPolicy) {
      dataSource.node.addDependency(kbRoleDefaultPolicy);
    }

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