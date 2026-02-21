import * as React from "react";
import { useState } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Select from "@mui/material/Select";
import FormControl from "@mui/material/FormControl";
import InputLabel from "@mui/material/InputLabel";
import MuiMenuItem from "@mui/material/MenuItem";
import Avatar from "@mui/material/Avatar";
import CircularProgress from "@mui/material/CircularProgress";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import ThumbUpIcon from "@mui/icons-material/ThumbUp";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownIcon from "@mui/icons-material/ThumbDown";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Collapse from "@mui/material/Collapse";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../../styles/chat.module.scss";
import {
  ChatBotHistoryItem,
  ChatBotMessageType,
} from "./types";
import { StreamingStatus } from "../../hooks/useWebSocketChat";

import "../../styles/app.scss";
import { useNotifications } from "../notif-manager";
import { Utils } from "../../common/utils";
import { feedbackCategories, feedbackTypes } from "../../common/constants";

export interface ChatMessageProps {
  message: ChatBotHistoryItem;
  isLastAiMessage?: boolean;
  streamingStatus?: StreamingStatus;
  onThumbsUp: () => void;
  onThumbsDown: (feedbackTopic: string, feedbackType: string, feedbackMessage: string) => void;
}

export default function ChatMessage(props: ChatMessageProps) {
  const [selectedIcon, setSelectedIcon] = useState<1 | 0 | null>(null);
  const { addNotification, removeNotification } = useNotifications();
  const [modalVisible, setModalVisible] = useState(false);
  const [selectedTopic, setSelectedTopic] = React.useState("");
  const [selectedFeedbackType, setSelectedFeedbackType] = React.useState("");
  const [value, setValue] = useState("");
  const [copied, setCopied] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);

  const formattedTime = props.message.timestamp
    ? new Date(props.message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  const content =
    props.message.content && props.message.content.length > 0
      ? props.message.content
      : "";

  const showSources =
    props.message.metadata?.Sources &&
    (props.message.metadata.Sources as any[]).length > 0;

  const handleCopy = () => {
    navigator.clipboard.writeText(props.message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      {/* Feedback dialog */}
      <Dialog
        open={modalVisible}
        onClose={() => setModalVisible(false)}
        maxWidth="sm"
        fullWidth
        aria-labelledby="feedback-dialog-title"
      >
        <DialogTitle id="feedback-dialog-title">Provide Feedback</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <FormControl fullWidth size="small">
              <InputLabel id="feedback-topic-label">Topic</InputLabel>
              <Select
                labelId="feedback-topic-label"
                value={selectedTopic}
                label="Topic"
                onChange={(e) => setSelectedTopic(e.target.value)}
              >
                {feedbackCategories.map((cat) => (
                  <MuiMenuItem key={cat.value} value={cat.value} disabled={cat.disabled}>
                    {cat.label}
                  </MuiMenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth size="small">
              <InputLabel id="feedback-problem-label">Problem</InputLabel>
              <Select
                labelId="feedback-problem-label"
                value={selectedFeedbackType}
                label="Problem"
                onChange={(e) => setSelectedFeedbackType(e.target.value)}
              >
                {feedbackTypes.map((ft) => (
                  <MuiMenuItem key={ft.value} value={ft.value} disabled={ft.disabled}>
                    {ft.label}
                  </MuiMenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              label="Please enter feedback here"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              fullWidth
              size="small"
              multiline
              minRows={2}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => {
              setModalVisible(false);
              setValue("");
              setSelectedTopic("");
              setSelectedFeedbackType("");
            }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => {
              if (!selectedTopic || !selectedFeedbackType || value.trim() === "") {
                const id = addNotification("error", "Please fill out all fields.");
                Utils.delay(3000).then(() => removeNotification(id));
                return;
              }
              setModalVisible(false);
              setValue("");
              const id = addNotification("success", "Your feedback has been submitted.");
              Utils.delay(3000).then(() => removeNotification(id));
              props.onThumbsDown(selectedTopic, selectedFeedbackType, value.trim());
              setSelectedIcon(0);
              setSelectedTopic("");
              setSelectedFeedbackType("");
            }}
          >
            Submit
          </Button>
        </DialogActions>
      </Dialog>

      {/* AI Message */}
      {props.message?.type === ChatBotMessageType.AI && (
        <div className={styles.aiMessage} role="article" aria-label="ABE response">
          <Avatar
            className={styles.aiAvatar}
            sx={{
              bgcolor: "primary.light",
              color: "primary.main",
              width: 32,
              height: 32,
              fontWeight: 800,
              fontSize: "0.625rem",
              letterSpacing: "-0.02em",
            }}
          >
            ABE
          </Avatar>
          <Box className={`${styles.aiContent} ${styles.messageWrapper}`} sx={{ minWidth: 0, flex: 1 }}>
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: "var(--abe-chatAiBg)",
                borderColor: "var(--abe-chatAiBorder)",
              }}
            >
              {content.length === 0 && !props.streamingStatus?.active ? (
                <div className={styles.typingIndicator} aria-label="ABE is typing" role="status">
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                </div>
              ) : null}

              {props.isLastAiMessage && props.streamingStatus?.active ? (
                <div className={styles.statusIndicator} role="status" aria-live="polite">
                  <CircularProgress size={14} sx={{ color: "primary.main" }} />
                  <Typography variant="body2" sx={{ color: "text.secondary", fontStyle: "italic" }}>
                    {props.streamingStatus.text}
                  </Typography>
                </div>
              ) : null}

              {props.message.content.length > 0 && (
                <div className={styles.btn_chabot_message_copy}>
                  <Tooltip title={copied ? "Copied!" : "Copy to clipboard"} placement="top">
                    <IconButton
                      size="small"
                      onClick={handleCopy}
                      aria-label="Copy message to clipboard"
                    >
                      {copied ? (
                        <CheckIcon fontSize="small" color="success" />
                      ) : (
                        <ContentCopyIcon fontSize="small" />
                      )}
                    </IconButton>
                  </Tooltip>
                </div>
              )}

              <Box sx={{ "& p": { my: 0.5 }, "& p:first-of-type": { mt: 0 }, "& p:last-of-type": { mb: 0 }, lineHeight: 1.7 }}>
                <ReactMarkdown
                  children={content}
                  remarkPlugins={[remarkGfm]}
                  components={{
                    pre(props) {
                      const { children, ...rest } = props;
                      return (
                        <pre {...rest} className={styles.codeMarkdown}>
                          {children}
                        </pre>
                      );
                    },
                    table(props) {
                      const { children, ...rest } = props;
                      return (
                        <table {...rest} className={styles.markdownTable}>
                          {children}
                        </table>
                      );
                    },
                    th(props) {
                      const { children, ...rest } = props;
                      return (
                        <th {...rest} className={styles.markdownTableCell}>
                          {children}
                        </th>
                      );
                    },
                    td(props) {
                      const { children, ...rest } = props;
                      return (
                        <td {...rest} className={styles.markdownTableCell}>
                          {children}
                        </td>
                      );
                    },
                    a(props) {
                      const { children, href, ...rest } = props;
                      return (
                        <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
                          {children}
                        </a>
                      );
                    },
                  }}
                />
                {props.isLastAiMessage && content.length > 0 && !props.streamingStatus?.active && !showSources ? (
                  <span className={styles.streamingCursor} aria-hidden="true" />
                ) : null}
              </Box>

              {/* Feedback buttons */}
              {content.length > 0 && (
                <div className={styles.thumbsContainer}>
                  {(selectedIcon === 1 || selectedIcon === null) && (
                    <IconButton
                      size="small"
                      onClick={() => {
                        props.onThumbsUp();
                        const id = addNotification("success", "Thank you for your valuable feedback!");
                        Utils.delay(3000).then(() => removeNotification(id));
                        setSelectedIcon(1);
                      }}
                      aria-label="Mark response as helpful"
                      sx={{ borderRadius: 1.5, px: 1, gap: 0.5 }}
                    >
                      {selectedIcon === 1 ? (
                        <ThumbUpIcon sx={{ fontSize: 16 }} color="primary" />
                      ) : (
                        <ThumbUpOutlinedIcon sx={{ fontSize: 16 }} />
                      )}
                      <Typography variant="caption" sx={{ fontSize: "0.7rem", color: selectedIcon === 1 ? "primary.main" : "text.secondary" }}>
                        Helpful
                      </Typography>
                    </IconButton>
                  )}
                  {(selectedIcon === 0 || selectedIcon === null) && (
                    <IconButton
                      size="small"
                      onClick={() => setModalVisible(true)}
                      aria-label="Mark response as not helpful and provide feedback"
                      sx={{ borderRadius: 1.5, px: 1, gap: 0.5 }}
                    >
                      {selectedIcon === 0 ? (
                        <ThumbDownIcon sx={{ fontSize: 16 }} color="primary" />
                      ) : (
                        <ThumbDownOutlinedIcon sx={{ fontSize: 16 }} />
                      )}
                      <Typography variant="caption" sx={{ fontSize: "0.7rem", color: selectedIcon === 0 ? "primary.main" : "text.secondary" }}>
                        Not helpful
                      </Typography>
                    </IconButton>
                  )}
                </div>
              )}
            </Paper>

            {/* Collapsible sources */}
            {showSources && (
              <Box sx={{ mt: 1 }}>
                <button
                  className={styles.sourcesToggle}
                  onClick={() => setSourcesOpen((o) => !o)}
                  aria-expanded={sourcesOpen}
                  aria-controls="sources-list"
                >
                  <DescriptionOutlinedIcon sx={{ fontSize: 16, color: "text.secondary" }} />
                  <Typography variant="body2" sx={{ color: "text.secondary", fontSize: "0.8125rem" }}>
                    {(props.message.metadata.Sources as any[]).length} source
                    {(props.message.metadata.Sources as any[]).length !== 1 ? "s" : ""} found
                  </Typography>
                  <ExpandMoreIcon
                    sx={{
                      fontSize: 18,
                      color: "text.secondary",
                      transition: "transform 200ms ease",
                      transform: sourcesOpen ? "rotate(180deg)" : "rotate(0deg)",
                    }}
                  />
                </button>
                <Collapse in={sourcesOpen} timeout={200}>
                  <div id="sources-list" className={styles.sourcesList}>
                    {(props.message.metadata.Sources as any[]).map((item, idx) => (
                      <a
                        key={`source-${idx}`}
                        href={item.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.sourceLink}
                      >
                        <OpenInNewIcon sx={{ fontSize: 13, flexShrink: 0 }} />
                        <span className={styles.sourceLinkText}>{item.title}</span>
                      </a>
                    ))}
                  </div>
                </Collapse>
              </Box>
            )}
          </Box>
        </div>
      )}

      {/* Human Message */}
      {props.message?.type === ChatBotMessageType.Human && (
        <div className={styles.humanMessage} role="article" aria-label="Your message">
          <div>
            <div className={styles.humanBubble}>
              {props.message.content}
            </div>
            {formattedTime && (
              <Typography
                variant="caption"
                sx={{ display: "block", textAlign: "right", mt: 0.5, color: "text.tertiary", fontSize: "0.6875rem" }}
              >
                {formattedTime}
              </Typography>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
