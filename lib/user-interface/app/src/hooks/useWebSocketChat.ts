/**
 * useWebSocketChat -- React hook for streaming chat over a WebSocket.
 *
 * Opens a one-shot WebSocket to the API Gateway `$default` stage, sends
 * the user message via the `getChatbotResponse` action, and streams the
 * response back through a series of callback props.
 *
 * ## Wire protocol
 *
 * The Lambda handler sends frames as plain-text strings. Three sentinel
 * prefixes are used to distinguish control frames from content:
 *
 *  - `STATUS_PREFIX` (`!<|STATUS|>!`)  -- followed by a human-readable
 *    status string (e.g. "Searching knowledge base..."). The UI shows
 *    this as a progress indicator while the agentic loop is running.
 *
 *  - `EOF_MARKER` (`!<|EOF_STREAM|>!`) -- signals the end of the
 *    assistant's text. Everything received *after* this marker is
 *    treated as JSON metadata (sources / citations).
 *
 *  - `ERROR_PREFIX` (`<!ERROR!>:`)     -- followed by an error message.
 *    The connection is closed immediately after.
 *
 * Any frame that does not match a sentinel is appended to the
 * accumulated response text and forwarded via `onStreamChunk`.
 *
 * ## Reconnection strategy
 *
 * If the socket closes unexpectedly (code other than 1000/1001) before
 * the `EOF_MARKER` is received, the hook retries up to
 * `MAX_RECONNECT_ATTEMPTS` (3) times with exponential back-off:
 *   attempt 0 -> 1 s, attempt 1 -> 2 s, attempt 2 -> 4 s.
 * Each retry re-authenticates (fetches a fresh Cognito token) before
 * opening the new socket.
 *
 * ## Timeout
 *
 * A 90-second inactivity timer (`TIMEOUT_MS`) runs while no response
 * text has been received. If no data arrives within that window the
 * socket is closed and the user sees a timeout error. The timer is
 * polled every 5 seconds via `setInterval`.
 */
import { useRef, useCallback, useContext } from "react";
import { AppContext } from "../common/app-context";
import { Utils } from "../common/utils";
import {
  ChatBotHistoryItem,
  ChatBotMessageType,
} from "../components/chatbot/types";
import { assembleHistory } from "../components/chatbot/utils";

/** Prefix for status/progress frames sent during the agentic tool-use loop. */
const STATUS_PREFIX = "!<|STATUS|>!";
/** Marks the end of the assistant's streamed text; metadata follows. */
const EOF_MARKER = "!<|EOF_STREAM|>!";
/** Prefix for error frames; the socket is closed immediately after. */
const ERROR_PREFIX = "<!ERROR!>:";
/** Inactivity timeout (ms) before the request is considered stalled. */
const TIMEOUT_MS = 90_000;
/** Maximum number of automatic reconnection attempts on unexpected close. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** Base delay (ms) for exponential back-off between reconnection attempts. */
const RECONNECT_BASE_DELAY_MS = 1_000;

/** Represents the current streaming progress indicator shown in the UI. */
export interface StreamingStatus {
  /** Human-readable status text (e.g. "Searching knowledge base..."), or empty when idle. */
  text: string;
  /** True while the agentic loop is actively processing (spinner visible). */
  active: boolean;
}

/** Options passed to the `send` function to initiate a chat request. */
interface SendOptions {
  /** The user's message text. */
  userMessage: string;
  /** Cognito user ID for session attribution. */
  userId: string;
  /** Optional display name sent to the backend for logging. */
  displayName?: string;
  /** Optional agency identifier for the user's organization. */
  agency?: string;
  /** Chat session ID used to maintain conversation continuity. */
  sessionId: string;
  /** Full conversation history; the last entries are sent as context. */
  messageHistory: ChatBotHistoryItem[];
  /** Retrieval source hint (defaults to "kb" for Knowledge Base). */
  retrievalSource?: string;
  /** Called on each text frame with the *accumulated* response so far. */
  onStreamChunk: (accumulated: string) => void;
  /** Called when the backend sends a status update or clears the status. */
  onStatusChange: (status: StreamingStatus) => void;
  /** Called once after EOF with parsed citation/source metadata. */
  onSources: (sources: Record<string, any>) => void;
  /** Called on successful completion; `firstMessage` is true for new sessions. */
  onComplete: (firstMessage: boolean) => void;
  /** Called on any error (timeout, auth failure, server error). */
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

  /**
   * Send a chat message over a new WebSocket connection.
   *
   * Opens a WebSocket to the API Gateway endpoint, authenticates via a
   * Cognito JWT in the query string, sends the `getChatbotResponse`
   * action, and streams the response through the provided callbacks.
   *
   * The connection is automatically retried up to 3 times on unexpected
   * closure (see reconnection strategy in the file-level doc). Call
   * `abort()` to cancel an in-flight request.
   */
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
