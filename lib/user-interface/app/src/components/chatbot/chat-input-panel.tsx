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
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import { Auth } from "aws-amplify";
import TextareaAutosize from "react-textarea-autosize";
import { ReadyState } from "react-use-websocket";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import styles from "../../styles/chat.module.scss";

import {
  ChatBotHistoryItem,
  ChatBotMessageType,
  ChatInputState,
} from "./types";

import { assembleHistory } from "./utils";

import { Utils } from "../../common/utils";
import { SessionRefreshContext } from "../../common/session-refresh-context";
import { useNotifications } from "../notif-manager";

export interface ChatInputPanelProps {
  running: boolean;
  setRunning: Dispatch<SetStateAction<boolean>>;
  session: { id: string; loading: boolean };
  messageHistory: ChatBotHistoryItem[];
  setMessageHistory: (history: ChatBotHistoryItem[]) => void;
}

export abstract class ChatScrollState {
  static userHasScrolled = false;
  static skipNextScrollEvent = false;
  static skipNextHistoryUpdate = false;
}

export default function ChatInputPanel(props: ChatInputPanelProps) {
  const appContext = useContext(AppContext);
  const { needsRefresh, setNeedsRefresh } = useContext(SessionRefreshContext);
  const { transcript, listening, browserSupportsSpeechRecognition } =
    useSpeechRecognition();
  const [state, setState] = useState<ChatInputState>({
    value: "",
  });
  const { addNotification } = useNotifications();
  const [readyState, setReadyState] = useState<ReadyState>(ReadyState.OPEN);
  const messageHistoryRef = useRef<ChatBotHistoryItem[]>([]);

  const [selectedDataSource, setSelectedDataSource] = useState({
    label: "Bedrock Knowledge Base",
    value: "kb",
  });

  useEffect(() => {
    messageHistoryRef.current = props.messageHistory;
  }, [props.messageHistory]);

  useEffect(() => {
    if (transcript) {
      setState((state) => ({ ...state, value: transcript }));
    }
  }, [transcript]);

  useEffect(() => {
    const onWindowScroll = () => {
      if (ChatScrollState.skipNextScrollEvent) {
        ChatScrollState.skipNextScrollEvent = false;
        return;
      }

      const isScrollToTheEnd =
        Math.abs(
          window.innerHeight +
            window.scrollY -
            document.documentElement.scrollHeight
        ) <= 10;

      if (!isScrollToTheEnd) {
        ChatScrollState.userHasScrolled = true;
      } else {
        ChatScrollState.userHasScrolled = false;
      }
    };

    window.addEventListener("scroll", onWindowScroll);
    return () => {
      window.removeEventListener("scroll", onWindowScroll);
    };
  }, []);

  useLayoutEffect(() => {
    if (ChatScrollState.skipNextHistoryUpdate) {
      ChatScrollState.skipNextHistoryUpdate = false;
      return;
    }

    if (!ChatScrollState.userHasScrolled && props.messageHistory.length > 0) {
      ChatScrollState.skipNextScrollEvent = true;
      window.scrollTo({
        top: document.documentElement.scrollHeight + 1000,
        behavior: "instant",
      });
    }
  }, [props.messageHistory]);

  const handleSendMessage = async () => {
    if (props.running) return;
    if (readyState !== ReadyState.OPEN) return;
    ChatScrollState.userHasScrolled = false;

    let username: string | undefined;
    await Auth.currentAuthenticatedUser().then(
      (value) => (username = value.username)
    );
    if (!username) return;

    const messageToSend = state.value.trim();
    if (messageToSend.length === 0) {
      addNotification("error", "Please do not submit blank text!");
      return;
    }
    setState({ value: "" });

    try {
      props.setRunning(true);
      let receivedData = "";

      messageHistoryRef.current = [
        ...messageHistoryRef.current,
        {
          type: ChatBotMessageType.Human,
          content: messageToSend,
          metadata: {},
        },
        {
          type: ChatBotMessageType.AI,
          content: receivedData,
          metadata: {},
        },
      ];
      props.setMessageHistory(messageHistoryRef.current);

      let firstTime = false;
      if (messageHistoryRef.current.length < 3) {
        firstTime = true;
      }
      const TEST_URL = appContext.wsEndpoint + "/";
      const TOKEN = await Utils.authenticate();
      const wsUrl = TEST_URL + "?Authorization=" + TOKEN;
      const ws = new WebSocket(wsUrl);

      let incomingMetadata: boolean = false;
      let sources = {};

      setTimeout(() => {
        if (receivedData == "") {
          ws.close();
          messageHistoryRef.current.pop();
          messageHistoryRef.current.push({
            type: ChatBotMessageType.AI,
            content: "Response timed out!",
            metadata: {},
          });
        }
      }, 60000);

      ws.addEventListener("open", function open() {
        const message = JSON.stringify({
          action: "getChatbotResponse",
          data: {
            userMessage: messageToSend,
            chatHistory: assembleHistory(
              messageHistoryRef.current.slice(0, -2)
            ),
            user_id: username,
            session_id: props.session.id,
            retrievalSource: selectedDataSource.value,
          },
        });
        ws.send(message);
      });

      ws.addEventListener("message", async function incoming(data) {
        try {
          const parsed = JSON.parse(data.data);
          if (
            parsed.message === "Endpoint request timed out" &&
            parsed.connectionId &&
            parsed.requestId
          ) {
            return;
          }
        } catch (e) {}

        if (data.data.includes("<!ERROR!>:")) {
          addNotification("error", data.data);
          ws.close();
          return;
        }
        if (data.data == "!<|EOF_STREAM|>!") {
          incomingMetadata = true;
          return;
        }
        if (!incomingMetadata) {
          receivedData += data.data;
        } else {
          let sourceData = JSON.parse(data.data);
          sourceData = sourceData.map((item: any) => {
            if (item.title == "") {
              return {
                title: item.uri.slice(
                  (item.uri as string).lastIndexOf("/") + 1
                ),
                uri: item.uri,
              };
            } else {
              return item;
            }
          });
          sources = { Sources: sourceData };
        }

        messageHistoryRef.current = [
          ...messageHistoryRef.current.slice(0, -2),
          {
            type: ChatBotMessageType.Human,
            content: messageToSend,
            metadata: {},
          },
          {
            type: ChatBotMessageType.AI,
            content: receivedData,
            metadata: sources,
          },
        ];
        props.setMessageHistory(messageHistoryRef.current);
      });

      ws.addEventListener("error", function error(err) {
        console.error("WebSocket error:", err);
      });

      ws.addEventListener("close", async function close() {
        if (firstTime) {
          Utils.delay(1500).then(() => setNeedsRefresh(true));
        }
        props.setRunning(false);
      });
    } catch (error) {
      console.error("Error sending message:", error);
      addNotification(
        "error",
        "Sorry, something went wrong. Please try again or refresh the page."
      );
      props.setRunning(false);
    }
  };

  const isSendDisabled =
    readyState !== ReadyState.OPEN ||
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
              setState((state) => ({ ...state, value: e.target.value }))
            }
            onKeyDown={(e) => {
              if (e.key == "Enter" && !e.shiftKey) {
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
