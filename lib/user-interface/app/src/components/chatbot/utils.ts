import {
  ChatBotHistoryItem,
  ChatBotMessageType,
} from "./types";

/**
 * Maximum number of user/assistant exchange pairs to send to the backend.
 *
 * The backend already slices the incoming history to its own sliding window
 * (`lastMessages = chatHistory.slice(-12)` in
 * `lib/chatbot-api/functions/websocket-chat/index.mjs`). Sending more than
 * that wastes bandwidth and risks bumping the WebSocket frame past API
 * Gateway's 128 KB per-frame limit on very long sessions.
 *
 * Older history is preserved server-side via the persisted context summary
 * (loaded from DynamoDB on each request), so trimming the client payload does
 * not lose information.
 */
const MAX_HISTORY_PAIRS = 12;

/** Assembles local message history copy into a format suitable for the chat API.
 *  Metadata (sources/citations) is intentionally omitted -- the backend does not
 *  use it, and including pre-signed S3 URLs from every turn can push the
 *  WebSocket frame past API Gateway's 128 KB limit on long conversations.
 *
 *  The result is capped to the last `MAX_HISTORY_PAIRS` pairs to match the
 *  backend's own sliding window. */
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
  if (hist.length > MAX_HISTORY_PAIRS) {
    return hist.slice(-MAX_HISTORY_PAIRS);
  }
  return hist;
}
