import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from "constructs";

export class S3BucketStack extends Construct {
  public readonly knowledgeBucket: s3.Bucket;
  public readonly feedbackBucket: s3.Bucket;
  public readonly evalResultsBucket: s3.Bucket;
  public readonly evalTestCasesBucket: s3.Bucket;
  public readonly ragasDependenciesBucket: s3.Bucket;
  public readonly contractIndexBucket: s3.Bucket;
  public readonly dataStagingBucket: s3.Bucket;

  constructor(scope: Construct, id: string, allowedOrigin: string) {
    super(scope, id);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate buckets.

    this.knowledgeBucket = new s3.Bucket(scope, 'KnowledgeSourceBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });

    this.feedbackBucket = new s3.Bucket(scope, 'FeedbackDownloadBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });

    this.evalResultsBucket = new s3.Bucket(scope, 'EvalResultsBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });

    this.evalTestCasesBucket = new s3.Bucket(scope, 'EvalTestCasesBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });

    this.ragasDependenciesBucket = new s3.Bucket(scope, 'RagasDependenciesBucket', {
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT, s3.HttpMethods.DELETE],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });

    this.contractIndexBucket = new s3.Bucket(scope, 'ContractIndexBucket', {
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });

    this.dataStagingBucket = new s3.Bucket(scope, 'DataStagingBucket', {
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
        allowedOrigins: [allowedOrigin],
        allowedHeaders: ['*'],
      }],
    });
  }
}
