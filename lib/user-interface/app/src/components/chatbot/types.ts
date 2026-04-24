export interface ChatInputState {
  value: string;  
}

export interface MessageTraceMetadata {
  messageId?: string;
  sessionId?: string;
  promptVersionId?: string;
  promptTemplateHash?: string;
  turnIndex?: number;
}

/** Server-reported context-window usage for the most recent response. */
export interface ContextUsage {
  estimatedTokens: number;
  maxTokens: number;
  /** 0-100 inclusive. */
  percent: number;
  /** Number of in-session compaction rounds applied so far this conversation. */
  compactionRounds: number;
}

export interface ChatMessageMetadata {
  Sources?: any[];
  Trace?: MessageTraceMetadata;
  ContextUsage?: ContextUsage;
  [key: string]: any;
}

export enum ChatBotMessageType {
  AI = "ai",
  Human = "human",
}

export interface ChatBotHistoryItem {
  type: ChatBotMessageType;
  content: string;
  metadata: ChatMessageMetadata;
  timestamp?: number;
}

export interface FeedbackSubmission {
  messageId: string;
  feedbackKind: "helpful" | "not_helpful";
  issueTags: string[];
  userComment?: string;
  expectedAnswer?: string;
  wrongSnippet?: string;
  sourceAssessment?: string;
  regenerateRequested?: boolean;
}
