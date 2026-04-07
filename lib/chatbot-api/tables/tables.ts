/**
 * DynamoDB tables and SQS queues for the ABE chatbot backend.
 *
 * 13 tables grouped by domain:
 *
 *   Chat
 *     - ChatHistoryTable        — Conversation sessions keyed by user + session
 *     - ResponseTraceTable      — Per-message tool-use traces (debug / audit)
 *     - PromptRegistryTable     — Versioned system prompts (family + version)
 *
 *   Feedback
 *     - UserFeedbackTable       — Legacy thumbs-up/down records by topic
 *     - FeedbackRecordsTable    — Rich feedback with review status, disposition, clusters
 *     - MonitoringCasesTable    — Curated test cases derived from reviewed feedback
 *
 *   Evaluation
 *     - EvalSummaryTable        — One row per evaluation run (aggregate scores)
 *     - EvalResultsTable        — Per-question RAGAS metric results
 *     - TestLibraryTable        — Reusable Q&A test cases (manual + auto-generated)
 *
 *   Analytics
 *     - AnalyticsTable          — Per-question topic/agency classification for dashboards
 *
 *   Excel Index (structured contract/vendor data)
 *     - ExcelIndexDataTable     — Parsed spreadsheet rows (generic pk/sk schema)
 *     - IndexRegistryTable      — Metadata about each registered index
 *
 *   Sync
 *     - SyncHistoryTable        — Audit log of automated data-sync runs (TTL-enabled)
 *
 * Design decisions:
 *   - All tables use PAY_PER_REQUEST billing (no capacity planning needed).
 *   - All tables have point-in-time recovery and RETAIN removal policy.
 *   - GSIs use ALL projection unless only key lookups are needed (TestLibrary).
 *   - Resources are created on `scope` (not `this`) to preserve CloudFormation
 *     logical IDs and avoid accidental table recreation on refactors.
 */
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
  public readonly syncHistoryTable: Table;
  public readonly feedbackToTestLibraryQueue: sqs.Queue;
  public readonly feedbackToTestLibraryDLQ: sqs.Queue;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Resources use `scope` (not `this`) to preserve existing CloudFormation
    // logical IDs. Switching to `this` would change IDs and recreate tables.

    // ─── Chat Domain ───────────────────────────────────────────────────

    // Stores conversation history. Each item is one session for one user.
    // TimeIndex enables "most recent sessions" queries for the session list UI.
    const chatHistoryTable = new Table(scope, 'ChatHistoryTable', {
      partitionKey: { name: 'user_id', type: AttributeType.STRING },
      sortKey: { name: 'session_id', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    chatHistoryTable.addGlobalSecondaryIndex({
      indexName: 'TimeIndex',
      partitionKey: { name: 'user_id', type: AttributeType.STRING },
      sortKey: { name: 'time_stamp', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.historyTable = chatHistoryTable;

    // ─── Feedback Domain ───────────────────────────────────────────────

    // Legacy feedback table partitioned by topic. AnyIndex uses a synthetic
    // partition key ("ALL") to enable cross-topic date-sorted scans.
    const userFeedbackTable = new Table(scope, 'UserFeedbackTable', {
      partitionKey: { name: 'Topic', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    // Rich feedback records with admin review workflow. Five GSIs support
    // filtering by record type, review status, disposition, cluster, and
    // originating message — all sorted by creation date.
    const feedbackRecordsTable = new Table(scope, 'FeedbackRecordsTable', {
      partitionKey: { name: 'FeedbackId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    // Per-message debug traces (tool calls, retrieval results, token counts).
    // SessionCreatedAtIndex lets the admin UI show traces for a given chat session.
    const responseTraceTable = new Table(scope, 'ResponseTraceTable', {
      partitionKey: { name: 'MessageId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    responseTraceTable.addGlobalSecondaryIndex({
      indexName: 'SessionCreatedAtIndex',
      partitionKey: { name: 'SessionId', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.responseTraceTable = responseTraceTable;

    // Versioned system prompts. PromptFamily (e.g. "ABE_CHAT") + VersionId
    // allows A/B testing and rollback of prompt changes without redeploying.
    const promptRegistryTable = new Table(scope, 'PromptRegistryTable', {
      partitionKey: { name: 'PromptFamily', type: AttributeType.STRING },
      sortKey: { name: 'VersionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.promptRegistryTable = promptRegistryTable;

    // Admin-curated test cases grouped into named sets. SourceFeedbackIndex
    // links each case back to the user feedback it was derived from.
    const monitoringCasesTable = new Table(scope, 'MonitoringCasesTable', {
      partitionKey: { name: 'SetName', type: AttributeType.STRING },
      sortKey: { name: 'CaseId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    monitoringCasesTable.addGlobalSecondaryIndex({
      indexName: 'SourceFeedbackIndex',
      partitionKey: { name: 'SourceFeedbackId', type: AttributeType.STRING },
      sortKey: { name: 'CreatedAt', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    this.monitoringCasesTable = monitoringCasesTable;

    // ─── Evaluation Domain ─────────────────────────────────────────────

    // One row per evaluation run with aggregate RAGAS scores.
    const evalSummariesTable = new Table(scope, 'EvaluationSummariesTable', {
      partitionKey: { name: 'PartitionKey', type: AttributeType.STRING },
      sortKey: { name: 'Timestamp', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.evalSummaryTable = evalSummariesTable;

    // Per-question results within an evaluation run (faithfulness, relevancy, etc.).
    const evalResultsTable = new Table(scope, 'EvaluationResultsTable', {
      partitionKey: { name: 'EvaluationId', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    evalResultsTable.addGlobalSecondaryIndex({
      indexName: 'QuestionIndex',
      partitionKey: { name: 'EvaluationId', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.evalResultsTable = evalResultsTable;

    // ─── Analytics Domain ──────────────────────────────────────────────

    // FAQ classification results: each user question is categorized by topic
    // and agency. DateIndex and AgencyIndex power the admin analytics dashboard.
    const analyticsTable = new Table(scope, 'AnalyticsTable', {
      partitionKey: { name: 'topic', type: AttributeType.STRING },
      sortKey: { name: 'timestamp', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    // ─── Excel Index Domain ────────────────────────────────────────────

    // Parsed spreadsheet rows. Generic pk/sk schema allows multiple indexes
    // (e.g. statewide contracts, IT vendors) in one table via pk prefixing.
    const excelIndexDataTable = new Table(scope, 'ExcelIndexDataTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.excelIndexDataTable = excelIndexDataTable;

    // Registry of all uploaded indexes: schema metadata, column mappings,
    // and LLM-generated descriptions used by the query_excel_index tool.
    const indexRegistryTable = new Table(scope, 'IndexRegistryTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.indexRegistryTable = indexRegistryTable;

    // Reusable Q&A test cases for the evaluation pipeline. Cases can be
    // manually authored or auto-generated from positive user feedback.
    // NormalizedQuestionIndex uses KEYS_ONLY projection for dedup lookups.
    const testLibraryTable = new Table(scope, 'TestLibraryTable', {
      partitionKey: { name: 'PartitionKey', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    testLibraryTable.addGlobalSecondaryIndex({
      indexName: 'NormalizedQuestionIndex',
      partitionKey: { name: 'questionNormalized', type: AttributeType.STRING },
      sortKey: { name: 'QuestionId', type: AttributeType.STRING },
      projectionType: ProjectionType.KEYS_ONLY,
    });

    this.testLibraryTable = testLibraryTable;

    // ─── Sync Domain ───────────────────────────────────────────────────

    // Audit log for automated data-sync runs. TTL (expiresAt) auto-deletes
    // old entries so the table does not grow unbounded.
    const syncHistoryTable = new Table(scope, 'SyncHistoryTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'expiresAt',
    });
    this.syncHistoryTable = syncHistoryTable;

    // ─── SQS: Feedback-to-Test-Library Pipeline ────────────────────────
    //
    // When a user gives positive feedback (thumbs-up), the feedback handler
    // enqueues a message. The process Lambda picks it up, rewrites the Q&A
    // pair via LLM, and inserts it into TestLibraryTable.
    //
    // DLQ retains failed messages for 14 days for manual inspection.
    // Main queue allows 3 receive attempts before dead-lettering.
    // Visibility timeout (120s) exceeds the process Lambda's 90s timeout
    // to prevent duplicate processing.

    const feedbackToTestLibraryDLQ = new sqs.Queue(scope, 'FeedbackToTestLibraryDLQ', {
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.feedbackToTestLibraryQueue = feedbackToTestLibraryQueue;
  }
}
