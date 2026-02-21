import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import MicIcon from "@mui/icons-material/Mic";
import MicOffIcon from "@mui/icons-material/MicOff";
import SendIcon from "@mui/icons-material/Send";
import {
  Dispatch,
  SetStateAction,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import { Auth } from "aws-amplify";
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
}

export default function ChatInputPanel(props: ChatInputPanelProps) {
  const { setNeedsRefresh } = useContext(SessionRefreshContext);
  const { transcript, listening, browserSupportsSpeechRecognition } =
    useSpeechRecognition();
  const [state, setState] = useState<ChatInputState>({
    value: "",
  });
  const { addNotification } = useNotifications();
  const messageHistoryRef = useRef<ChatBotHistoryItem[]>([]);
  const { send } = useWebSocketChat();

  useEffect(() => {
    messageHistoryRef.current = props.messageHistory;
  }, [props.messageHistory]);

  useEffect(() => {
    if (transcript) {
      setState((s) => ({ ...s, value: transcript }));
    }
  }, [transcript]);

  const handleSendMessage = async () => {
    if (props.running) return;

    let username: string | undefined;
    try {
      const user = await Auth.currentAuthenticatedUser();
      username = user.username;
    } catch {
      addNotification("error", "Please sign in to continue.");
      return;
    }
    if (!username) return;

    const messageToSend = state.value.trim();
    if (messageToSend.length === 0) {
      addNotification("error", "Please do not submit blank text!");
      return;
    }
    setState({ value: "" });

    props.setRunning(true);
    props.setStreamingStatus({ text: "", active: false });

    messageHistoryRef.current = [
      ...messageHistoryRef.current,
      {
        type: ChatBotMessageType.Human,
        content: messageToSend,
        metadata: {},
      },
      {
        type: ChatBotMessageType.AI,
        content: "",
        metadata: {},
      },
    ];
    props.setMessageHistory(messageHistoryRef.current);

    send({
      userMessage: messageToSend,
      userId: username,
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
        addNotification(
          "error",
          message || "Sorry, something went wrong. Please try again."
        );
        props.setRunning(false);
      },
    });
  };

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
          <Stack direction="row" spacing={0.5} alignItems="center">
            {browserSupportsSpeechRecognition ? (
              <Tooltip title={listening ? "Stop listening" : "Start voice input"}>
                <IconButton
                  size="small"
                  aria-label={listening ? "Stop voice input" : "Start voice input"}
                  onClick={() =>
                    listening
                      ? SpeechRecognition.stopListening()
                      : SpeechRecognition.startListening()
                  }
                  color={listening ? "primary" : "default"}
                >
                  {listening ? (
                    <MicOffIcon fontSize="small" />
                  ) : (
                    <MicIcon fontSize="small" />
                  )}
                </IconButton>
              </Tooltip>
            ) : (
              <MicOffIcon fontSize="small" color="disabled" />
            )}
          </Stack>
          <TextareaAutosize
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
            aria-label="Type your message to ABE"
          />
          <div style={{ marginLeft: "8px" }}>
            <Tooltip title={props.running ? "Generating response..." : "Send message"}>
              <span>
                <Button
                  disabled={isSendDisabled}
                  onClick={handleSendMessage}
                  variant="contained"
                  aria-label="Send message"
                  sx={{
                    minWidth: "auto",
                    borderRadius: 2,
                    px: props.running ? 2.5 : 2,
                  }}
                  endIcon={
                    !props.running ? <SendIcon fontSize="small" /> : undefined
                  }
                >
                  {props.running ? (
                    <>
                      Thinking
                      <CircularProgress
                        size={14}
                        color="inherit"
                        sx={{ ml: 1 }}
                      />
                    </>
                  ) : (
                    "Send"
                  )}
                </Button>
              </span>
            </Tooltip>
          </div>
        </div>
      </Paper>
    </Stack>
  );
}
