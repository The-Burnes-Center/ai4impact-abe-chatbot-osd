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
 *  - `REPLACE_PREFIX` (`!<|REPLACE|>!`) -- the text after it replaces the
 *    accumulated answer wholesale: the citation-finalized version at end of
 *    stream, or an empty payload to clear intermediate tool-round text. Plain
 *    (non-sentinel) frames before it stream in as deltas and are appended.
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
 * The metadata frame after `EOF_MARKER` is JSON shaped as
 * `{ Sources, Trace, ContextUsage }`. ContextUsage carries
 * `{ estimatedTokens, maxTokens, percent, compactionRounds }` so the chat
 * UI can render a live memory-usage indicator. The whole object is forwarded
 * to `onSources` so the existing callback wiring continues to work.
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
 * ## Completion
 *
 * The response is considered complete as soon as the `EOF_MARKER` and the
 * trailing metadata frame have arrived — we then report completion and close
 * the socket ourselves (see `finalize`). We do NOT wait for the server to
 * close the connection, because the backend holds the socket open while it
 * does post-response work (title generation, session save); a slow or failed
 * step there must never leave the UI stuck mid-stream.
 *
 * ## Timeout
 *
 * A 120-second inactivity timer (`TIMEOUT_MS`) runs until the response
 * completes (EOF received). If no frame — status or text — arrives within that
 * window the socket is closed and the user sees a timeout error. The timer is
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
/** Replaces the accumulated answer text wholesale (citation-finalized flush at
 *  end of stream, or empty payload to clear intermediate tool-round text). */
const REPLACE_PREFIX = "!<|REPLACE|>!";
/** Prefix for error frames; the socket is closed immediately after. */
const ERROR_PREFIX = "<!ERROR!>:";
/** Inactivity timeout (ms) before the request is considered stalled. */
const TIMEOUT_MS = 120_000;
/** Grace window (ms) after EOF to collect trailing metadata before completing. */
const FINALIZE_GRACE_MS = 1_000;
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
  // Set when the user presses stop, so the per-request close handler can tell a
  // deliberate cancel apart from an unexpected disconnect (which would otherwise
  // reconnect and resend the same message).
  const userAbortedRef = useRef(false);

  const abort = useCallback(() => {
    userAbortedRef.current = true;
    if (wsRef.current) {
      wsRef.current.close(1000);
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

      // New user-initiated request — clear any prior stop/abort latch.
      userAbortedRef.current = false;

      const wsUrl = appContext.wsEndpoint + "/";
      const firstMessage = opts.messageHistory.length < 3;

      // The outbound history is capped client-side by `assembleHistory`
      // (see lib/user-interface/app/src/components/chatbot/utils.ts) to match
      // the backend sliding window, which keeps us comfortably under API
      // Gateway's 128 KB per-frame limit even on long sessions.
      const outboundFrame = JSON.stringify({
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
      });

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
        // Latched once a terminal callback (error/session-full) has fired so the
        // subsequent close event does not re-fire onError as "connection lost".
        let terminalHandled = false;
        // Latched once the request has been completed exactly once (see finalize).
        let finalized = false;
        let finalizeTimer: ReturnType<typeof setTimeout> | null = null;

        // Time out only while the response is still pending (no EOF yet). This
        // catches both a request that never starts AND a stream that stalls
        // partway; once EOF arrives, completion is driven by finalize() instead.
        const timeoutId = setInterval(() => {
          if (!finalized && !eofReceived && Date.now() - lastActivity > TIMEOUT_MS) {
            clearInterval(timeoutId);
            terminalHandled = true;
            ws.close();
            opts.onError("The request timed out. Please try again.");
          }
        }, 5_000);

        // Completes the request exactly once: stops timers, reports completion,
        // and closes the socket ourselves. Completion is driven by the protocol's
        // EOF + metadata frames rather than the transport `close` event, because
        // the backend keeps the socket open while it does post-response work
        // (title generation, session save) — a slow or failed step there must
        // never leave the UI stuck mid-stream.
        const finalize = () => {
          if (finalized) return;
          finalized = true;
          clearInterval(timeoutId);
          if (finalizeTimer) clearTimeout(finalizeTimer);
          wsRef.current = null;
          opts.onComplete(firstMessage);
          try {
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
              ws.close(1000);
            }
          } catch {
            // socket already closing/closed
          }
        };

        // After EOF the only remaining frame is the metadata burst; give it a
        // brief window to arrive, then complete without waiting for the server
        // to close the socket.
        const scheduleFinalize = () => {
          if (finalized) return;
          if (finalizeTimer) clearTimeout(finalizeTimer);
          finalizeTimer = setTimeout(finalize, FINALIZE_GRACE_MS);
        };

        ws.addEventListener("open", () => {
          ws.send(outboundFrame);
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

          if (raw.startsWith(ERROR_PREFIX)) {
            clearInterval(timeoutId);
            terminalHandled = true;
            opts.onError(raw.replace(ERROR_PREFIX, "").trim());
            ws.close();
            return;
          }

          if (raw.startsWith(STATUS_PREFIX)) {
            lastActivity = Date.now();
            const statusText = raw.slice(STATUS_PREFIX.length);
            opts.onStatusChange({ text: statusText, active: true });
            return;
          }

          if (raw.startsWith(REPLACE_PREFIX)) {
            // Server replaces the streamed text wholesale — swapping the raw
            // answer for the citation-finalized version at end of stream, or
            // clearing intermediate tool-round text (empty payload).
            lastActivity = Date.now();
            receivedData = raw.slice(REPLACE_PREFIX.length);
            opts.onStatusChange({ text: "", active: false });
            opts.onStreamChunk(receivedData);
            return;
          }

          if (raw === EOF_MARKER) {
            // EOF with zero text chunks means the model produced no output
            // (e.g. empty Bedrock content / guardrail intervention). Surface
            // an error rather than silently completing with an empty bubble,
            // which would leave the UI stuck on the "Thinking..." indicator.
            if (receivedData === "") {
              clearInterval(timeoutId);
              terminalHandled = true;
              opts.onError("I wasn't able to generate a response for that question. Please try again or rephrase your question.");
              ws.close();
              return;
            }
            eofReceived = true;
            incomingMetadata = true;
            opts.onStatusChange({ text: "", active: false });
            scheduleFinalize();
            return;
          }

          if (!incomingMetadata) {
            lastActivity = Date.now();
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
              scheduleFinalize();
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
          if (finalizeTimer) clearTimeout(finalizeTimer);
          wsRef.current = null;

          // User pressed stop: the input has already been reset by the stop
          // button, so don't reconnect, resend, complete, or surface an error.
          if (userAbortedRef.current) {
            return;
          }

          if (eofReceived) {
            // Normal completion (idempotent — the EOF grace timer may have
            // already finalized if the server was slow to close the socket).
            finalize();
            return;
          }

          // A terminal callback (error frame / timeout) already fired, or we
          // already finalized; the close that follows our own ws.close() is
          // expected and must not re-fire onError as "connection lost".
          if (terminalHandled || finalized) {
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
