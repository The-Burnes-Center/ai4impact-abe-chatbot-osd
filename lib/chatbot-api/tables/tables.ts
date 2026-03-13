import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { AttributeType, BillingMode, Table, ProjectionType } from 'aws-cdk-lib/aws-dynamodb';
import * as sqs from 'aws-cdk-lib/aws-sqs';

export class TableStack extends Construct {
  public readonly historyTable: Table;
  public readonly feedbackTable: Table;
  public readonly feedbackRecordsTable: Table;
  public readonly responseTraceTable: Table;
  public readonly promptRegistryTable: Table;
  public readonly monitoringCasesTable: Table;
  public readonly evalResultsTable: Table;
  public readonly evalSummaryTable: Table;
  public readonly analyticsTable: Table;
  public readonly excelIndexDataTable: Table;
  public readonly indexRegistryTable: Table;
  public readonly testLibraryTable: Table;
  public readonly feedbackToTestLibraryQueue: sqs.Queue;
  public readonly feedbackToTestLibraryDLQ: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate tables.

    const chatHistoryTable = new Table(scope, 'ChatHistoryTable', {
      partitionKey: { name: 'user_id', type: AttributeType.STRING },
      sortKey: { name: 'session_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    chatHistoryTable.addGlobalSecondaryIndex({
      indexName: 'TimeIndex',
      partitionKey: { name: 'user_id', type: AttributeType.STRING },
      sortKey: { name: 'time_stamp', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.historyTable = chatHistoryTable;

    const userFeedbackTable = new Table(scope, 'UserFeedbackTable', {
      partitionKey: { name: 'Topic', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    userFeedbackTable.addGlobalSecondaryIndex({
      indexName: 'CreatedAtIndex',
      partitionKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    userFeedbackTable.addGlobalSecondaryIndex({
      indexName: 'AnyIndex',
      partitionKey: { name: 'Any', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.feedbackTable = userFeedbackTable;

    const feedbackRecordsTable = new Table(scope, 'FeedbackRecordsTable', {
      partitionKey: { name: 'FeedbackId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    feedbackRecordsTable.addGlobalSecondaryIndex({
      indexName: 'RecordTypeCreatedAtIndex',
      partitionKey: { name: 'RecordType', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    feedbackRecordsTable.addGlobalSecondaryIndex({
      indexName: 'ReviewStatusIndex',
      partitionKey: { name: 'ReviewStatus', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    feedbackRecordsTable.addGlobalSecondaryIndex({
      indexName: 'DispositionIndex',
      partitionKey: { name: 'Disposition', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    feedbackRecordsTable.addGlobalSecondaryIndex({
      indexName: 'ClusterIndex',
      partitionKey: { name: 'ClusterId', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    feedbackRecordsTable.addGlobalSecondaryIndex({
      indexName: 'MessageIdIndex',
      partitionKey: { name: 'MessageId', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.feedbackRecordsTable = feedbackRecordsTable;

    const responseTraceTable = new Table(scope, 'ResponseTraceTable', {
      partitionKey: { name: 'MessageId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    responseTraceTable.addGlobalSecondaryIndex({
      indexName: 'SessionCreatedAtIndex',
      partitionKey: { name: 'SessionId', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.responseTraceTable = responseTraceTable;

    const promptRegistryTable = new Table(scope, 'PromptRegistryTable', {
      partitionKey: { name: 'PromptFamily', type: AttributeType.STRING },
      sortKey: { name: 'VersionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    this.promptRegistryTable = promptRegistryTable;

    const monitoringCasesTable = new Table(scope, 'MonitoringCasesTable', {
      partitionKey: { name: 'SetName', type: AttributeType.STRING },
      sortKey: { name: 'CaseId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    monitoringCasesTable.addGlobalSecondaryIndex({
      indexName: 'SourceFeedbackIndex',
      partitionKey: { name: 'SourceFeedbackId', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.monitoringCasesTable = monitoringCasesTable;

    const evalSummariesTable = new Table(scope, 'EvaluationSummariesTable', {
      partitionKey: { name: 'PartitionKey', type: AttributeType.STRING },
      sortKey: { name: 'Timestamp', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.evalSummaryTable = evalSummariesTable;

    const evalResultsTable = new Table(scope, 'EvaluationResultsTable', {
      partitionKey: { name: 'EvaluationId', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    evalResultsTable.addGlobalSecondaryIndex({
      indexName: 'QuestionIndex',
      partitionKey: { name: 'EvaluationId', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.evalResultsTable = evalResultsTable;

    const analyticsTable = new Table(scope, 'AnalyticsTable', {
      partitionKey: { name: 'topic', type: AttributeType.STRING },
      sortKey: { name: 'timestamp', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    analyticsTable.addGlobalSecondaryIndex({
      indexName: 'DateIndex',
      partitionKey: { name: 'date_key', type: AttributeType.STRING },
      sortKey: { name: 'topic', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    analyticsTable.addGlobalSecondaryIndex({
      indexName: 'AgencyIndex',
      partitionKey: { name: 'agency', type: AttributeType.STRING },
      sortKey: { name: 'timestamp', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.analyticsTable = analyticsTable;

    const excelIndexDataTable = new Table(scope, 'ExcelIndexDataTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.excelIndexDataTable = excelIndexDataTable;

    const indexRegistryTable = new Table(scope, 'IndexRegistryTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.indexRegistryTable = indexRegistryTable;

    const testLibraryTable = new Table(scope, 'TestLibraryTable', {
      partitionKey: { name: 'PartitionKey', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    testLibraryTable.addGlobalSecondaryIndex({
      indexName: 'NormalizedQuestionIndex',
      partitionKey: { name: 'questionNormalized', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    this.testLibraryTable = testLibraryTable;

    const feedbackToTestLibraryDLQ = new sqs.Queue(scope, 'FeedbackToTestLibraryDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.feedbackToTestLibraryDLQ = feedbackToTestLibraryDLQ;

    const feedbackToTestLibraryQueue = new sqs.Queue(scope, 'FeedbackToTestLibraryQueue', {
      visibilityTimeout: cdk.Duration.seconds(120),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: feedbackToTestLibraryDLQ,
        maxReceiveCount: 3,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    this.feedbackToTestLibraryQueue = feedbackToTestLibraryQueue;
  }
}
