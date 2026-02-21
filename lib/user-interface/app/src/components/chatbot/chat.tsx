import { useContext, useEffect, useRef, useState } from "react";
import {
  ChatBotHistoryItem,
  ChatBotMessageType,
  FeedbackData,
} from "./types";
import { Auth } from "aws-amplify";
import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Skeleton from "@mui/material/Skeleton";
import Avatar from "@mui/material/Avatar";
import Fab from "@mui/material/Fab";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import { v4 as uuidv4 } from "uuid";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import ChatMessage from "./chat-message";
import ChatInputPanel from "./chat-input-panel";
import styles from "../../styles/chat.module.scss";
import { WELCOME_PAGE, SUGGESTED_PROMPTS } from "../../common/constants";
import { useNotifications } from "../notif-manager";
import { useWebSocketChat, StreamingStatus } from "../../hooks/useWebSocketChat";

export default function Chat(props: { sessionId?: string }) {
  const appContext = useContext(AppContext);
  const [running, setRunning] = useState<boolean>(true);
  const [session, setSession] = useState<{ id: string; loading: boolean }>({
    id: props.sessionId ?? uuidv4(),
    loading: typeof props.sessionId !== "undefined",
  });

  const { addNotification } = useNotifications();
  const { abort } = useWebSocketChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const [messageHistory, setMessageHistory] = useState<ChatBotHistoryItem[]>([]);
  const [streamingStatus, setStreamingStatus] = useState<StreamingStatus>({
    text: "",
    active: false,
  });

  useEffect(() => {
    if (!appContext) return;
    setMessageHistory([]);

    (async () => {
      if (!props.sessionId) {
        setSession({ id: uuidv4(), loading: false });
        return;
      }

      setSession({ id: props.sessionId, loading: true });
      const apiClient = new ApiClient(appContext);
      try {
        let username: string | undefined;
        await Auth.currentAuthenticatedUser().then(
          (value) => (username = value.username)
        );
        if (!username) return;
        const hist = await apiClient.sessions.getSession(
          props.sessionId,
          username
        );

        if (hist) {
          setMessageHistory(
            hist
              .filter((x) => x !== null)
              .map((x) => ({
                type: x!.type as ChatBotMessageType,
                metadata: x!.metadata!,
                content: x!.content,
              }))
          );
        }
        setSession({ id: props.sessionId, loading: false });
        setRunning(false);
      } catch (error: any) {
        addNotification("error", error.message);
        addNotification("info", "Please refresh the page");
      }
    })();
  }, [appContext, props.sessionId]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (messageHistory.length === 0) return;
    const el = scrollContainerRef.current;
    if (!el) return;

    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (isNearBottom || running) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messageHistory, running]);

  // Track scroll position for scroll-to-bottom button
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return undefined;
    const handleScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollButton(distFromBottom > 300);
    };
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  const handleFeedback = (
    feedbackType: 1 | 0,
    idx: number,
    message: ChatBotHistoryItem,
    feedbackTopic?: string,
    feedbackProblem?: string,
    feedbackMessage?: string
  ) => {
    if (props.sessionId) {
      const prompt = messageHistory[idx - 1].content;
      const completion = message.content;
      const feedbackData = {
        sessionId: props.sessionId,
        feedback: feedbackType,
        prompt: prompt,
        completion: completion,
        topic: feedbackTopic,
        problem: feedbackProblem,
        comment: feedbackMessage,
        sources: JSON.stringify(message.metadata.Sources),
      };
      addUserFeedback(feedbackData);
    }
  };

  const addUserFeedback = async (feedbackData: FeedbackData) => {
    if (!appContext) return;
    const apiClient = new ApiClient(appContext);
    await apiClient.userFeedback.sendUserFeedback(feedbackData);
  };

  const isEmpty = messageHistory.length === 0 && !session?.loading;

  const lastAiIdx = (() => {
    for (let i = messageHistory.length - 1; i >= 0; i--) {
      if (messageHistory[i].type === ChatBotMessageType.AI) return i;
    }
    return -1;
  })();

  return (
    <div className={styles.chat_container} style={{ position: "relative" }}>
      {/* Scroll-to-bottom button */}
      {showScrollButton && (
        <div className={styles.scrollToBottom}>
          <Fab
            size="small"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
            sx={{
              bgcolor: "background.paper",
              color: "text.secondary",
              boxShadow: "var(--abe-shadow-md)",
              "&:hover": { bgcolor: "background.paper", color: "text.primary" },
            }}
          >
            <KeyboardArrowDownIcon />
          </Fab>
        </div>
      )}
      {/* Scrollable message area */}
      <div className={styles.messages_scroll} ref={scrollContainerRef}>
        <Box aria-live="polite" aria-relevant="additions">
          <Stack direction="column" spacing={2}>
            {isEmpty && (
              <Alert severity="info" sx={{ mb: 1 }}>
                This tool is for Executive Office use only. While AI can assist,
                always validate critical information and confirm permissions before
                procuring goods or services.
              </Alert>
            )}

            {messageHistory.map((message, idx) => (
              <ChatMessage
                key={idx}
                message={message}
                isLastAiMessage={running && idx === lastAiIdx}
                streamingStatus={running && idx === lastAiIdx ? streamingStatus : undefined}
                onThumbsUp={() => handleFeedback(1, idx, message)}
                onThumbsDown={(
                  feedbackTopic: string,
                  feedbackType: string,
                  feedbackMessage: string
                ) =>
                  handleFeedback(
                    0,
                    idx,
                    message,
                    feedbackTopic,
                    feedbackType,
                    feedbackMessage
                  )
                }
              />
            ))}
          </Stack>
        </Box>

        {/* Empty state */}
        {isEmpty && (
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              py: 6,
              textAlign: "center",
            }}
          >
            <Avatar
              sx={{
                width: 56,
                height: 56,
                bgcolor: "primary.light",
                color: "primary.main",
                mb: 2.5,
                fontWeight: 800,
                fontSize: "1.25rem",
                letterSpacing: "-0.02em",
              }}
            >
              ABE
            </Avatar>
            <Typography
              variant="h2"
              sx={{
                color: "text.primary",
                mb: 1,
                fontSize: { xs: "1.25rem", sm: "1.5rem" },
              }}
            >
              {WELCOME_PAGE}
            </Typography>
            <Typography
              variant="body2"
              sx={{ color: "text.secondary", mb: 3, maxWidth: 420 }}
            >
              Ask me about Massachusetts procurement processes, statewide
              contracts, bidding, and more.
            </Typography>
            <div className={styles.suggestedPrompts}>
              {SUGGESTED_PROMPTS.map((prompt, idx) => (
                <button
                  key={idx}
                  className={styles.suggestedPromptCard}
                  onClick={() => {
                    const textarea = document.querySelector(
                      "textarea"
                    ) as HTMLTextAreaElement | null;
                    if (textarea) {
                      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
                        window.HTMLTextAreaElement.prototype,
                        "value"
                      )?.set;
                      nativeInputValueSetter?.call(textarea, prompt);
                      textarea.dispatchEvent(new Event("input", { bubbles: true }));
                      textarea.focus();
                    }
                  }}
                  aria-label={`Suggested question: ${prompt}`}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </Box>
        )}

        {/* Loading state */}
        {session?.loading && (
          <Box sx={{ py: 4 }}>
            <Stack spacing={2}>
              {[1, 2, 3].map((i) => (
                <Box key={i} sx={{ display: "flex", gap: 1.5 }}>
                  <Skeleton variant="circular" width={32} height={32} />
                  <Box sx={{ flex: 1 }}>
                    <Skeleton variant="rounded" height={60 + i * 20} />
                  </Box>
                </Box>
              ))}
            </Stack>
          </Box>
        )}

        {/* Invisible anchor for auto-scroll */}
        <div ref={messagesEndRef} />
      </div>

      {/* Input panel — always visible at the bottom */}
      <div className={styles.input_container}>
        <ChatInputPanel
          session={session}
          running={running}
          setRunning={setRunning}
          messageHistory={messageHistory}
          setMessageHistory={(history) => setMessageHistory(history)}
          streamingStatus={streamingStatus}
          setStreamingStatus={setStreamingStatus}
          onStop={abort}
        />
      </div>
    </div>
  );
}
