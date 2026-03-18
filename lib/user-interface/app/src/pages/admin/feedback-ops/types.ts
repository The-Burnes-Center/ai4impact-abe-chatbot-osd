export interface FeedbackItem {
  feedbackId: string;
  messageId?: string;
  feedbackKind?: string;
  issueTags: string[];
  reviewStatus?: string;
  disposition?: string;
  createdAt?: string;
  updatedAt?: string;
  summary?: string;
  rootCause?: string;
  promptVersionId?: string;
  sourceTitles: string[];
  clusterId?: string;
  recurrenceCount?: number;
  userPromptPreview?: string;
  answerPreview?: string;
}

export interface FeedbackAnalysis {
  summary?: string;
  likelyRootCause?: string;
  confidence?: number;
  similarityKey?: string;
  recommendedAction?: string;
  candidatePromptRevisionNote?: string;
  candidateKbGap?: string;
  candidateMonitoringCase?: {
    question?: string;
    referenceAnswer?: string;
    reason?: string;
  };
}

export interface FeedbackRecord {
  FeedbackId: string;
  MessageId?: string;
  SessionId?: string;
  FeedbackKind?: string;
  IssueTags?: string[];
  UserComment?: string;
  ExpectedAnswer?: string;
  WrongSnippet?: string;
  SourceAssessment?: string;
  RegenerateRequested?: boolean;
  ReviewStatus?: string;
  Disposition?: string;
  ClusterId?: string;
  PromptVersionId?: string;
  SourceTitles?: string[];
  CreatedAt?: string;
  UpdatedAt?: string;
  UserPromptPreview?: string;
  AnswerPreview?: string;
  AdminNotes?: string;
  Owner?: string;
  ResolutionNote?: string;
  Analysis?: FeedbackAnalysis;
}

export interface ResponseTrace {
  MessageId?: string;
  SessionId?: string;
  UserPrompt?: string;
  FinalAnswer?: string;
  Sources?: string;
  PromptVersionId?: string;
  PromptTemplateHash?: string;
  ModelId?: string;
}

export interface FeedbackDetail {
  feedback: FeedbackRecord;
  trace: ResponseTrace;
  similarReports: FeedbackItem[];
}

export interface PromptItem {
  promptFamily?: string;
  versionId: string;
  itemType?: string;
  title: string;
  notes: string;
  template: string;
  status: string;
  parentVersionId?: string;
  linkedFeedbackIds?: string[];
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  publishedAt?: string;
  aiSummary?: string;
}

export interface PromptData {
  items: PromptItem[];
  liveVersionId?: string | null;
}

export interface MonitoringCase {
  SetName: string;
  CaseId: string;
  SourceFeedbackId?: string;
  CreatedAt?: string;
  Question?: string;
  ReferenceAnswer?: string;
  Summary?: string;
  Status?: string;
}

export interface ClusterSummary {
  clusterId: string;
  count: number;
  summary?: string;
  rootCause?: string;
  recommendedAction?: string;
  promptVersionId?: string;
  latestCreatedAt?: string;
  sampleFeedbackId?: string;
  samplePrompt?: string;
  sourceTitles: string[];
}

export interface SourceTriageItem {
  sourceTitle: string;
  count: number;
  topIssueTags: [string, number][];
  latestCreatedAt?: string;
  promptVersions: string[];
}

export interface MonitoringSetInfo {
  setName: string;
  count: number;
  provenance: string;
  recentCases: MonitoringCase[];
}

export interface FeedbackOverview {
  totalFeedback: number;
  dispositionCounts: Record<string, number>;
  rootCauseCounts: Record<string, number>;
}

export interface PromptActivity {
  promptVersionId: string;
  feedbackCount: number;
}

export interface HealthSummary {
  livePromptVersionId: string;
  totalFeedback: number;
  pendingTriage: number;
  negativeRate: number;
}

export interface ActivityLogEntry {
  action: string;
  entityType: string;
  entityId: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface MonitoringData {
  coreMonitoringSet: MonitoringSetInfo;
  candidateSet: MonitoringSetInfo;
  feedbackOverview: FeedbackOverview;
  clusterSummaries: ClusterSummary[];
  sourceTriage: SourceTriageItem[];
  promptActivity: PromptActivity[];
  health?: HealthSummary;
}

export interface InboxFilters {
  feedbackKind: string;
  reviewStatus: string;
  disposition: string;
  issueTag: string;
  promptVersionId: string;
  sourceTitle: string;
  rootCause: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}

export const DISPOSITIONS = [
  "pending",
  "prompt update",
  "KB/source fix",
  "retrieval/config issue",
  "product/UX bug",
] as const;

export const REVIEW_STATUSES = [
  "new",
  "analyzed",
  "in_review",
  "actioned",
  "dismissed",
] as const;

export const LABELS: Record<string, string> = {
  // Dispositions (what action to take)
  "pending": "Needs review",
  "prompt update": "Fix prompt",
  "KB/source fix": "Fix document",
  "retrieval/config issue": "Fix search",
  "product/UX bug": "System bug",
  "helpful": "Helpful",
  "not_helpful": "Needs attention",

  // Root causes (issue types)
  "retrieval_gap": "Missing info",
  "grounding_error": "Wrong answer",
  "prompt_issue": "Response style",
  "answer_quality": "Low quality",
  "product_bug": "System bug",
  "needs_human_review": "Needs review",
  "positive_signal": "Positive",
  "unknown": "Unknown",

  // Review statuses (simple workflow)
  "new": "New",
  "analyzed": "AI analyzed",
  "in_review": "Reviewing",
  "actioned": "Resolved",
  "dismissed": "Dismissed",

  // Activity log actions
  "disposition_set": "Review updated",
  "promoted_to_candidate": "Added to tests",
  "feedback_deleted": "Feedback deleted",
  "prompt_published": "Prompt published",
  "prompt_deleted": "Prompt deleted",
  "prompt_created": "Prompt created",
  "prompt_updated": "Prompt updated",
};

export function label(key: string): string {
  return LABELS[key] || key.replace(/_/g, " ");
}

export function formatDate(value?: string): string {
  if (!value) return "N/A";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
