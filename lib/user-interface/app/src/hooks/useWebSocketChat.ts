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

export interface StreamingStatus {
  text: string;
  active: boolean;
}

interface SendOptions {
  userMessage: string;
  userId: string;
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
      let sources: Record<string, any> = {};
      const firstMessage = opts.messageHistory.length < 3;
      let lastActivity = Date.now();

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
            let sourceData = JSON.parse(raw);
            sourceData = sourceData.map((item: any) => {
              if (item.title === "") {
                return {
                  title: item.uri.slice((item.uri as string).lastIndexOf("/") + 1),
                  uri: item.uri,
                };
              }
              return item;
            });
            sources = { Sources: sourceData };
            opts.onSources(sources);
          } catch {
            // ignore malformed source JSON
          }
        }
      });

      ws.addEventListener("error", () => {
        clearInterval(timeoutId);
        opts.onError("Connection lost. Please check your internet and try again.");
      });

      ws.addEventListener("close", () => {
        clearInterval(timeoutId);
        wsRef.current = null;
        opts.onComplete(firstMessage);
      });
    },
    [appContext]
  );

  return { send, abort };
}
