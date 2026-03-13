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

export interface ChatMessageMetadata {
  Sources?: any[];
  Trace?: MessageTraceMetadata;
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
