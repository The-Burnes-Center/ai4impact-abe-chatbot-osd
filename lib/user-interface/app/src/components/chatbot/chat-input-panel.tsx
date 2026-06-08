import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import MicIcon from "@mui/icons-material/Mic";
import MicOffIcon from "@mui/icons-material/MicOff";
import SendIcon from "@mui/icons-material/Send";
import StopCircleOutlinedIcon from "@mui/icons-material/StopCircleOutlined";
import {
  Dispatch,
  SetStateAction,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useTranscribeDictation,
  transcribeDictationSupported,
} from "../../hooks/useTranscribeDictation";
import { AppContext } from "../../common/app-context";
import { getCurrentUser, fetchAuthSession } from "aws-amplify/auth";
import TextareaAutosize from "react-textarea-autosize";
import styles from "../../styles/chat.module.scss";

import {
  ChatBotHistoryItem,
  ChatBotMessageType,
  ChatInputState,
} from "./types";

import { SessionRefreshContext } from "../../common/session-refresh-context";
import { useNotifications } from "../notif-manager";
import { useWebSocketChat, StreamingStatus } from "../../hooks/useWebSocketChat";
import { Utils } from "../../common/utils";

export interface ChatInputPanelProps {
  running: boolean;
  setRunning: Dispatch<SetStateAction<boolean>>;
  session: { id: string; loading: boolean };
  messageHistory: ChatBotHistoryItem[];
  setMessageHistory: (history: ChatBotHistoryItem[]) => void;
  streamingStatus: StreamingStatus;
  setStreamingStatus: Dispatch<SetStateAction<StreamingStatus>>;
  onStop?: () => void;
  queuedPrompt?: string | null;
  onQueuedPromptHandled?: () => void;
}

const ChatInputPanel = forwardRef<HTMLTextAreaElement, ChatInputPanelProps>(
  function ChatInputPanel(props, ref) {
  const { setNeedsRefresh } = useContext(SessionRefreshContext);
  const appConfig = useContext(AppContext);
  const [state, setState] = useState<ChatInputState>({
    value: "",
  });
  const { addNotification } = useNotifications();
  const messageHistoryRef = useRef<ChatBotHistoryItem[]>([]);
  const handleSendRef = useRef<(msg?: string) => Promise<void>>();
  // Text already in the box when dictation started, so live speech is appended
  // to it rather than overwriting it.
  const dictationBaseRef = useRef("");
  const { send } = useWebSocketChat();

  // Live dictation via Amazon Transcribe streaming. The backend mints a
  // short-lived presigned WebSocket URL (no AWS creds in the browser); audio
  // streams browser→Transcribe directly. Works on the OSD network, unlike the
  // old browser Web Speech API which routed audio through Google.
  const dictationSupported = transcribeDictationSupported();
  const getPresignedUrl = useCallback(async () => {
    const auth = await Utils.authenticate();
    const base = (appConfig?.httpEndpoint ?? "").replace(/\/$/, "");
    const res = await fetch(`${base}/transcribe-stream-url`, {
      headers: { Authorization: auth },
    });
    if (!res.ok) throw new Error("Failed to get dictation URL");
    return res.json();
  }, [appConfig]);
  const {
    listening,
    toggle: toggleDictation,
    stop: stopDictation,
  } = useTranscribeDictation({
    getPresignedUrl,
    onTranscript: (text) => {
      const base = dictationBaseRef.current;
      setState((s) => ({ ...s, value: base ? `${base} ${text}` : text }));
    },
    onError: (message) => addNotification("error", message),
  });

  useEffect(() => {
    messageHistoryRef.current = props.messageHistory;
  }, [props.messageHistory]);

  // Capture whatever's already typed before starting so dictation appends to
  // it rather than replacing it; toggling again stops the stream.
  const handleToggleDictation = () => {
    if (!listening) {
      dictationBaseRef.current = state.value.trim();
    }
    toggleDictation();
  };

  const handleSendMessage = async (overrideMessage?: string) => {
    if (props.running) return;

    let username: string | undefined;
    let displayName = "";
    let agency = "";
    try {
      const user = await getCurrentUser();
      username = user.username;
      const session = await fetchAuthSession();
      const rawName = (session.tokens?.idToken?.payload?.name as string) ?? "";
      const identity = Utils.parseUserIdentity(rawName);
      displayName = identity.displayName;
      agency = identity.agency;
    } catch {
      // Session is gone/expired — bounce the user to re-authenticate rather than
      // stranding them with a notification they can't act on.
      Utils.redirectToLogin();
      return;
    }
    if (!username) return;

    const messageToSend = (overrideMessage ?? state.value).trim();
    if (messageToSend.length === 0) {
      addNotification("error", "Please do not submit blank text!");
      return;
    }
    if (!overrideMessage) {
      setState({ value: "" });
    }
    // Stop any in-progress dictation so it doesn't bleed into the next message.
    if (listening) stopDictation();
    dictationBaseRef.current = "";

    props.setRunning(true);
    props.setStreamingStatus({ text: "", active: false });

    const now = Date.now();
    messageHistoryRef.current = [
      ...messageHistoryRef.current,
      {
        type: ChatBotMessageType.Human,
        content: messageToSend,
        metadata: {},
        timestamp: now,
      },
      {
        type: ChatBotMessageType.AI,
        content: "",
        metadata: {},
        timestamp: now,
      },
    ];
    props.setMessageHistory(messageHistoryRef.current);

    send({
      userMessage: messageToSend,
      userId: username,
      displayName,
      agency,
      sessionId: props.session.id,
      messageHistory: messageHistoryRef.current.slice(0, -2),

      onStreamChunk(accumulated) {
        messageHistoryRef.current = [
          ...messageHistoryRef.current.slice(0, -2),
          {
            type: ChatBotMessageType.Human,
            content: messageToSend,
            metadata: {},
          },
          {
            type: ChatBotMessageType.AI,
            content: accumulated,
            metadata: {},
          },
        ];
        props.setMessageHistory(messageHistoryRef.current);
      },

      onStatusChange(status) {
        props.setStreamingStatus(status);
      },

      onSources(sources) {
        messageHistoryRef.current = [
          ...messageHistoryRef.current.slice(0, -1),
          {
            ...messageHistoryRef.current[messageHistoryRef.current.length - 1],
            metadata: sources,
          },
        ];
        props.setMessageHistory(messageHistoryRef.current);
      },

      onComplete(firstMessage) {
        props.setStreamingStatus({ text: "", active: false });
        if (firstMessage) {
          Utils.delay(1500).then(() => setNeedsRefresh(true));
        }
        props.setRunning(false);
      },

      onError(message) {
        props.setStreamingStatus({ text: "", active: false });
        messageHistoryRef.current = messageHistoryRef.current.slice(0, -1);
        props.setMessageHistory(messageHistoryRef.current);
        addNotification(
          "error",
          message || "Sorry, something went wrong. Please try again."
        );
        props.setRunning(false);
      },
    });
  };
  handleSendRef.current = handleSendMessage;

  useEffect(() => {
    if (props.queuedPrompt && !props.running && !props.session.loading) {
      handleSendRef.current?.(props.queuedPrompt);
      props.onQueuedPromptHandled?.();
    }
  }, [props.queuedPrompt, props.running, props.session.loading]);

  const isSendDisabled =
    props.running ||
    state.value.trim().length === 0 ||
    props.session.loading;

  return (
    <Stack direction="column" spacing={1}>
      <Paper
        sx={{
          p: 1.5,
          borderRadius: 3,
          boxShadow: "var(--abe-shadow-md)",
          borderColor: "var(--abe-border)",
          transition: "border-color var(--abe-transition-fast), box-shadow var(--abe-transition-fast)",
          "&:focus-within": {
            borderColor: "primary.main",
            boxShadow: "var(--abe-shadow-lg)",
          },
        }}
      >
        <div className={styles.input_textarea_container}>
          <label htmlFor="abe-chat-input" className="sr-only">
            Message ABE
          </label>
          <TextareaAutosize
            id="abe-chat-input"
            ref={ref}
            className={styles.input_textarea}
            maxRows={6}
            minRows={1}
            spellCheck={true}
            autoFocus
            onChange={(e) =>
              setState((s) => ({ ...s, value: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSendMessage();
              }
            }}
            value={state.value}
            placeholder="Ask ABE a question..."
            aria-label="Message ABE"
            aria-multiline="true"
          />
          <Stack direction="row" spacing={0.5} alignItems="center" sx={{ ml: 1 }}>
            {dictationSupported && (
              <Tooltip title={listening ? "Stop dictation" : "Start dictation"}>
                <IconButton
                  size="small"
                  aria-label={listening ? "Stop dictation" : "Start dictation"}
                  aria-pressed={listening}
                  onClick={handleToggleDictation}
                  color={listening ? "primary" : "default"}
                >
                  {listening ? (
                    <MicOffIcon fontSize="small" aria-hidden="true" />
                  ) : (
                    <MicIcon fontSize="small" aria-hidden="true" />
                  )}
                </IconButton>
              </Tooltip>
            )}
            {props.running ? (
              <Tooltip title="Stop response">
                <IconButton
                  onClick={() => {
                    props.onStop?.();
                    props.setRunning(false);
                    props.setStreamingStatus({ text: "", active: false });
                    // The answer arrives in one frame at the end, so on stop the
                    // assistant bubble is still empty — drop it instead of leaving
                    // a blank response on screen.
                    const hist = props.messageHistory;
                    const last = hist[hist.length - 1];
                    if (last && last.type === ChatBotMessageType.AI && !last.content?.trim()) {
                      props.setMessageHistory(hist.slice(0, -1));
                    }
                  }}
                  aria-label="Stop response"
                  color="error"
                  size="small"
                  sx={{ border: 1, borderColor: "error.main" }}
                >
                  <StopCircleOutlinedIcon fontSize="small" aria-hidden="true" />
                </IconButton>
              </Tooltip>
            ) : (
              <Tooltip title="Send message">
                <span>
                  <Button
                    disabled={isSendDisabled}
                    onClick={() => handleSendMessage()}
                    variant="contained"
                    aria-label="Send message"
                    sx={{
                      minWidth: "auto",
                      borderRadius: 2,
                      px: 2,
                    }}
                    endIcon={<SendIcon fontSize="small" aria-hidden="true" />}
                  >
                    Send
                  </Button>
                </span>
              </Tooltip>
            )}
          </Stack>
        </div>
      </Paper>
    </Stack>
  );
});

export default ChatInputPanel;
