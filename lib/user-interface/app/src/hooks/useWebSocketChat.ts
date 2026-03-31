import { useRef, useCallback, useContext } from "react";
import { AppContext } from "../common/app-context";
import { Utils } from "../common/utils";
import {
  ChatBotHistoryItem,
  ChatBotMessageType,
} from "../components/chatbot/types";
import { assembleHistory } from "../components/chatbot/utils";

const STATUS_PREFIX = "!<|STATUS|>!";
const EOF_MARKER = "!<|EOF_STREAM|>!";
const ERROR_PREFIX = "<!ERROR!>:";
const TIMEOUT_MS = 90_000;
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 1_000;

export interface StreamingStatus {
  text: string;
  active: boolean;
}

interface SendOptions {
  userMessage: string;
  userId: string;
  displayName?: string;
  agency?: string;
  sessionId: string;
  messageHistory: ChatBotHistoryItem[];
  retrievalSource?: string;
  onStreamChunk: (accumulated: string) => void;
  onStatusChange: (status: StreamingStatus) => void;
  onSources: (sources: Record<string, any>) => void;
  onComplete: (firstMessage: boolean) => void;
  onError: (message: string) => void;
}

export function useWebSocketChat() {
  const appContext = useContext(AppContext);
  const wsRef = useRef<WebSocket | null>(null);

  const abort = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const send = useCallback(
    async (opts: SendOptions) => {
      if (!appContext) {
        opts.onError("App not configured. Please refresh the page.");
        return;
      }

      const wsUrl = appContext.wsEndpoint + "/";
      const firstMessage = opts.messageHistory.length < 3;

      const connect = async (attempt: number) => {
        let token: string;
        try {
          token = await Utils.authenticate();
        } catch {
          opts.onError("Your session has expired. Please sign in again.");
          return;
        }

        const ws = new WebSocket(wsUrl + "?Authorization=" + token);
        wsRef.current = ws;

        let receivedData = "";
        let incomingMetadata = false;
        let responseMetadata: Record<string, any> = {};
        let lastActivity = Date.now();
        let eofReceived = false;

        const timeoutId = setInterval(() => {
          if (receivedData === "" && Date.now() - lastActivity > TIMEOUT_MS) {
            clearInterval(timeoutId);
            ws.close();
            opts.onError("The request timed out. Please try again.");
          }
        }, 5_000);

        ws.addEventListener("open", () => {
          ws.send(
            JSON.stringify({
              action: "getChatbotResponse",
              data: {
                userMessage: opts.userMessage,
                chatHistory: assembleHistory(opts.messageHistory),
                user_id: opts.userId,
                session_id: opts.sessionId,
                display_name: opts.displayName ?? "",
                agency: opts.agency ?? "",
                retrievalSource: opts.retrievalSource ?? "kb",
              },
            })
          );
        });

        ws.addEventListener("message", (event) => {
          const raw: string = event.data;

          try {
            const parsed = JSON.parse(raw);
            if (parsed.message === "Endpoint request timed out" && parsed.connectionId) {
              return;
            }
          } catch {
            // not JSON gateway timeout — continue
          }

          lastActivity = Date.now();

          if (raw.startsWith(ERROR_PREFIX)) {
            clearInterval(timeoutId);
            opts.onError(raw.replace(ERROR_PREFIX, "").trim());
            ws.close();
            return;
          }

          if (raw.startsWith(STATUS_PREFIX)) {
            const statusText = raw.slice(STATUS_PREFIX.length);
            opts.onStatusChange({ text: statusText, active: true });
            return;
          }

          if (raw === EOF_MARKER) {
            eofReceived = true;
            incomingMetadata = true;
            opts.onStatusChange({ text: "", active: false });
            return;
          }

          if (!incomingMetadata) {
            opts.onStatusChange({ text: "", active: false });
            receivedData += raw;
            opts.onStreamChunk(receivedData);
          } else {
            try {
              const parsed = JSON.parse(raw);

              if (Array.isArray(parsed)) {
                const sourceData = parsed.map((item: any) => {
                  const isLegacy = !("chunkIndex" in item);
                  if (isLegacy) {
                    const fallbackTitle = item.title || (item.uri
                      ? item.uri.slice((item.uri as string).lastIndexOf("/") + 1)
                      : "Unknown source");
                    return {
                      chunkIndex: null,
                      title: fallbackTitle,
                      uri: item.uri ?? null,
                      excerpt: null,
                      score: null,
                      page: null,
                      s3Key: null,
                      sourceType: "knowledgeBase",
                    };
                  }
                  if (item.title === "" && item.uri) {
                    item.title = item.uri.slice((item.uri as string).lastIndexOf("/") + 1);
                  }
                  return item;
                });
                responseMetadata = { Sources: sourceData };
              } else if (parsed && typeof parsed === "object") {
                const sources = Array.isArray(parsed.Sources) ? parsed.Sources : [];
                responseMetadata = { ...parsed, Sources: sources };
              }

              opts.onSources(responseMetadata);
            } catch {
              // ignore malformed metadata JSON
            }
          }
        });

        ws.addEventListener("error", () => {
          // close event fires immediately after; reconnection logic lives there
        });

        ws.addEventListener("close", (event) => {
          clearInterval(timeoutId);
          wsRef.current = null;

          if (eofReceived) {
            // Normal completion
            opts.onComplete(firstMessage);
            return;
          }

          // Unexpected close — retry unless it was a clean server close or we're out of attempts
          const isCleanClose = event.code === 1000 || event.code === 1001;
          if (!isCleanClose && attempt < MAX_RECONNECT_ATTEMPTS) {
            const delay = RECONNECT_BASE_DELAY_MS * 2 ** attempt;
            opts.onStatusChange({
              text: `Connection lost, reconnecting… (attempt ${attempt + 1} of ${MAX_RECONNECT_ATTEMPTS})`,
              active: true,
            });
            setTimeout(() => connect(attempt + 1), delay);
          } else {
            opts.onError("Connection lost. Please check your internet and try again.");
          }
        });
      };

      await connect(0);
    },
    [appContext]
  );

  return { send, abort };
}
