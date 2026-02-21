export interface ChatInputState {
  value: string;  
}

export enum ChatBotMessageType {
  AI = "ai",
  Human = "human",
}

export interface ChatBotHistoryItem {
  type: ChatBotMessageType;
  content: string;
  metadata: Record<
    string,
    | string
    | boolean
    | number
    | null
    | undefined    
    | string[]
    | string[][]
  >;
  timestamp?: number;
}

export interface FeedbackData {
  sessionId: string;  
  feedback: number;
  prompt: string;
  completion: string;    
  topic: string,
  problem: string,
  comment: string,
  sources: string     
}
