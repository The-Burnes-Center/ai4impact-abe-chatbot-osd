import {
  ChatBotHistoryItem,
  ChatBotMessageType,
} from "./types";

/** Assembles local message history copy into a format suitable for the chat API.
 *  Metadata (sources/citations) is intentionally omitted -- the backend does not
 *  use it, and including pre-signed S3 URLs from every turn can push the
 *  WebSocket frame past API Gateway's 128 KB limit on long conversations. */
export function assembleHistory(history: ChatBotHistoryItem[]) {
  const hist: Record<string, string>[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    if (history[i].type === ChatBotMessageType.Human) {
      hist.push({
        user: history[i].content,
        chatbot: history[i + 1].content,
      });
    }
  }
  return hist;
}
