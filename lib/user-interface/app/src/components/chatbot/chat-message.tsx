import * as React from "react";
import { useState, useMemo } from "react";
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
import Popper from "@mui/material/Popper";
import Fade from "@mui/material/Fade";
import LinearProgress from "@mui/material/LinearProgress";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import ThumbUpIcon from "@mui/icons-material/ThumbUp";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownIcon from "@mui/icons-material/ThumbDown";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import TableChartOutlinedIcon from "@mui/icons-material/TableChartOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Collapse from "@mui/material/Collapse";
import Snackbar from "@mui/material/Snackbar";
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

interface SourceItem {
  chunkIndex: number | null;
  title: string;
  uri: string | null;
  excerpt: string | null;
  score: number | null;
  page: number | null;
  s3Key: string | null;
  sourceType: "knowledgeBase" | "excelIndex";
}

function CitationBadge({ source }: { source: SourceItem }) {
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (source.uri) {
      window.open(source.uri, "_blank", "noopener,noreferrer");
    } else {
      setAnchorEl(anchorEl ? null : e.currentTarget);
    }
  };

  return (
    <>
      <span
        className={styles.citationBadge}
        onMouseEnter={(e) => setAnchorEl(e.currentTarget)}
        onMouseLeave={() => setAnchorEl(null)}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleClick(e as any); }}
        role="button"
        tabIndex={0}
        aria-label={`Source ${source.chunkIndex}: ${source.title}`}
      >
        {source.chunkIndex}
      </span>
      <Popper open={open} anchorEl={anchorEl} placement="top" transition style={{ zIndex: 1300 }}>
        {({ TransitionProps }) => (
          <Fade {...TransitionProps} timeout={150}>
            <Paper className={styles.citationCard} elevation={8}>
              <div className={styles.citationCardHeader}>
                {source.sourceType === "excelIndex" ? (
                  <TableChartOutlinedIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
                ) : (
                  <DescriptionOutlinedIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
                )}
                <Typography variant="subtitle2" className={styles.citationCardTitle} noWrap>
                  {source.title}
                </Typography>
              </div>
              <div className={styles.citationCardMeta}>
                {source.score != null && (
                  <div className={styles.citationScorePill}>
                    <LinearProgress
                      variant="determinate"
                      value={source.score * 100}
                      sx={{ width: 40, height: 4, borderRadius: 2, flexShrink: 0 }}
                    />
                    <Typography variant="caption" sx={{ fontSize: "0.6875rem", color: "text.secondary" }}>
                      {Math.round(source.score * 100)}%
                    </Typography>
                  </div>
                )}
                {source.page != null && (
                  <Typography variant="caption" sx={{ fontSize: "0.6875rem", color: "text.secondary" }}>
                    p.{source.page}
                  </Typography>
                )}
                <Chip
                  label={source.sourceType === "excelIndex" ? "Excel" : "KB"}
                  size="small"
                  sx={{ height: 18, fontSize: "0.625rem" }}
                />
              </div>
              {source.excerpt && (
                <Typography variant="body2" className={styles.citationExcerpt}>
                  {source.excerpt.length > 200 ? source.excerpt.slice(0, 200) + "..." : source.excerpt}
                </Typography>
              )}
              {source.uri && (
                <Typography
                  variant="caption"
                  sx={{ color: "primary.main", cursor: "pointer", mt: 0.5, display: "block", fontSize: "0.6875rem" }}
                >
                  Click badge to open document
                </Typography>
              )}
            </Paper>
          </Fade>
        )}
      </Popper>
    </>
  );
}

function renderWithCitations(
  children: React.ReactNode,
  sources: SourceItem[],
  keyPrefix = "cit"
): React.ReactNode {
  if (typeof children === "string") {
    const parts = children.split(/(\[\d+\])/g);
    if (parts.length === 1) return children;
    return parts.map((part, i) => {
      const match = part.match(/^\[(\d+)\]$/);
      if (match) {
        const idx = parseInt(match[1], 10);
        const source = sources.find((s) => s.chunkIndex === idx);
        if (source) {
          return <CitationBadge key={`${keyPrefix}-${i}`} source={source} />;
        }
      }
      return part;
    });
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      renderWithCitations(child, sources, `${keyPrefix}-${i}`)
    );
  }
  if (React.isValidElement(children) && children.props?.children) {
    return React.cloneElement(
      children,
      { ...children.props, key: children.key ?? `${keyPrefix}-el` },
      renderWithCitations(children.props.children, sources, `${keyPrefix}-ch`)
    );
  }
  return children;
}

function buildMarkdownComponents(sources: SourceItem[]) {
  const wrapChildren = (Tag: string) =>
    function WrappedComponent(props: any) {
      const { children, node, ...rest } = props;
      return React.createElement(Tag, rest, renderWithCitations(children, sources));
    };

  return {
    p: wrapChildren("p"),
    li: wrapChildren("li"),
    td(props: any) {
      const { children, node, ...rest } = props;
      return (
        <td {...rest} className={styles.markdownTableCell}>
          {renderWithCitations(children, sources)}
        </td>
      );
    },
    th(props: any) {
      const { children, node, ...rest } = props;
      return (
        <th {...rest} className={styles.markdownTableCell}>
          {renderWithCitations(children, sources)}
        </th>
      );
    },
    pre(props: any) {
      const { children, ...rest } = props;
      return (
        <pre {...rest} className={styles.codeMarkdown}>
          {children}
        </pre>
      );
    },
    table(props: any) {
      const { children, ...rest } = props;
      return (
        <table {...rest} className={styles.markdownTable}>
          {children}
        </table>
      );
    },
    a(props: any) {
      const { children, href, ...rest } = props;
      return (
        <a {...rest} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
  };
}

interface SourceGroup {
  documentTitle: string;
  s3Key: string | null;
  sourceType: "knowledgeBase" | "excelIndex";
  items: SourceItem[];
}

function groupSources(sources: SourceItem[]): SourceGroup[] {
  const groups: Map<string, SourceGroup> = new Map();
  for (const src of sources) {
    const key = src.s3Key || `__excel__${src.title}`;
    if (!groups.has(key)) {
      groups.set(key, {
        documentTitle: src.title,
        s3Key: src.s3Key,
        sourceType: src.sourceType,
        items: [],
      });
    }
    groups.get(key)!.items.push(src);
  }
  return Array.from(groups.values());
}

export interface ChatMessageProps {
  message: ChatBotHistoryItem;
  isLastAiMessage?: boolean;
  streamingStatus?: StreamingStatus;
  onThumbsUp: () => void;
  onThumbsDown: (feedbackTopic: string, feedbackType: string, feedbackMessage: string) => void;
  onAddToTestLibrary?: () => void;
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
  const [showTestLibrarySnackbar, setShowTestLibrarySnackbar] = useState(false);

  const formattedTime = props.message.timestamp
    ? new Date(props.message.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  const content =
    props.message.content && props.message.content.length > 0
      ? props.message.content
      : "";

  const sourcesArray: SourceItem[] = useMemo(() => {
    if (!props.message.metadata?.Sources) return [];
    return (props.message.metadata.Sources as any[]);
  }, [props.message.metadata?.Sources]);

  const showSources = sourcesArray.length > 0;
  const sourceGroups = useMemo(() => groupSources(sourcesArray), [sourcesArray]);
  const mdComponents = useMemo(() => buildMarkdownComponents(sourcesArray), [sourcesArray]);

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

      {/* Save-as-good-example prompt */}
      <Snackbar
        open={showTestLibrarySnackbar}
        autoHideDuration={10000}
        onClose={() => setShowTestLibrarySnackbar(false)}
        message="Help us improve — save this as a good example?"
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
        action={
          <>
            <Button
              size="small"
              onClick={() => setShowTestLibrarySnackbar(false)}
              sx={{ color: "grey.400" }}
            >
              Dismiss
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => {
                setShowTestLibrarySnackbar(false);
                props.onAddToTestLibrary?.();
                const id = addNotification("success", "Saved! Thanks for helping improve ABE.");
                Utils.delay(3000).then(() => removeNotification(id));
              }}
            >
              Save
            </Button>
          </>
        }
      />

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
                  components={mdComponents as any}
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
                        if (props.onAddToTestLibrary) {
                          setShowTestLibrarySnackbar(true);
                        }
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
                    {sourcesArray.length} source{sourcesArray.length !== 1 ? "s" : ""} from{" "}
                    {sourceGroups.length} document{sourceGroups.length !== 1 ? "s" : ""}
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
                    {sourceGroups.map((group, gi) => (
                      <div key={`group-${gi}`} className={styles.sourceGroup}>
                        <div className={styles.sourceGroupHeader}>
                          {group.sourceType === "excelIndex" ? (
                            <TableChartOutlinedIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
                          ) : (
                            <DescriptionOutlinedIcon sx={{ fontSize: 14, color: "text.secondary", flexShrink: 0 }} />
                          )}
                          <Typography variant="caption" className={styles.sourceGroupTitle} noWrap>
                            {group.documentTitle}
                          </Typography>
                          <Chip
                            label={group.sourceType === "excelIndex" ? "Excel" : "Knowledge Base"}
                            size="small"
                            sx={{ height: 18, fontSize: "0.625rem", ml: "auto", flexShrink: 0 }}
                          />
                        </div>
                        {group.items.map((item, ii) => (
                          <div key={`src-${gi}-${ii}`} className={styles.sourceCard}>
                            <div className={styles.sourceCardTop}>
                              {item.chunkIndex != null && (
                                <span className={styles.sourceCardBadge}>{item.chunkIndex}</span>
                              )}
                              <div className={styles.sourceCardInfo}>
                                {item.score != null && (
                                  <div className={styles.sourceCardScore}>
                                    <LinearProgress
                                      variant="determinate"
                                      value={item.score * 100}
                                      sx={{ width: 36, height: 3, borderRadius: 2 }}
                                    />
                                    <Typography variant="caption" sx={{ fontSize: "0.625rem", color: "text.secondary" }}>
                                      {Math.round(item.score * 100)}%
                                    </Typography>
                                  </div>
                                )}
                                {item.page != null && (
                                  <Typography variant="caption" sx={{ fontSize: "0.625rem", color: "text.secondary" }}>
                                    p.{item.page}
                                  </Typography>
                                )}
                              </div>
                              {item.uri && (
                                <a
                                  href={item.uri}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className={styles.sourceCardLink}
                                  aria-label={`Open ${item.title}`}
                                >
                                  <OpenInNewIcon sx={{ fontSize: 12 }} />
                                </a>
                              )}
                            </div>
                            {item.excerpt && (
                              <Typography variant="body2" className={styles.sourceCardExcerpt}>
                                {item.excerpt.length > 180 ? item.excerpt.slice(0, 180) + "..." : item.excerpt}
                              </Typography>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </Collapse>
              </Box>
            )}
          </Box>
        </div>
      )}

      {/* Human Message — same pattern as major chatbots: right-aligned bubble, wrapped text, optional timestamp */}
      {props.message?.type === ChatBotMessageType.Human && (
        <div className={styles.humanMessage} role="article" aria-label="Your message">
          <div className={styles.humanMessageInner}>
            <div className={styles.humanBubble}>
              {typeof content === "string" ? content : ""}
            </div>
            {formattedTime && (
              <Typography
                variant="caption"
                component="span"
                sx={{ display: "block", textAlign: "right", mt: 0.5, color: "text.secondary", fontSize: "0.6875rem" }}
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
