import * as React from "react";
import { useState, useMemo, useCallback, useRef } from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import TextField from "@mui/material/TextField";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Avatar from "@mui/material/Avatar";
import CircularProgress from "@mui/material/CircularProgress";
import Popper from "@mui/material/Popper";
import Fade from "@mui/material/Fade";
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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../../styles/chat.module.scss";
import {
  ChatBotHistoryItem,
  ChatBotMessageType,
  FeedbackSubmission,
} from "./types";
import { StreamingStatus } from "../../hooks/useWebSocketChat";

import "../../styles/app.scss";
import { useNotifications } from "../notif-manager";

interface SourceItem {
  chunkIndex: number | null;
  title: string;
  uri: string | null;
  excerpt: string | null;
  score: number | null;
  page: number | null;
  s3Key: string | null;
  sourceType: "knowledgeBase" | "excelIndex";
  cited?: boolean;
}

function CitedIndicator() {
  return (
    <span className={`${styles.relevancePill} ${styles.relevanceCited}`}>
      <span className={styles.relevanceDot} />
      Cited in response
    </span>
  );
}

function CitationBadge({ source, onCitationClick }: { source: SourceItem; onCitationClick?: (chunkIndex: number) => void }) {
  const [anchorEl, setAnchorEl] = React.useState<HTMLElement | null>(null);
  const open = Boolean(anchorEl);

  const handleClick = () => {
    if (source.chunkIndex != null && onCitationClick) {
      onCitationClick(source.chunkIndex);
    }
  };

  return (
    <>
      <span
        className={styles.citationBadge}
        onMouseEnter={(e) => setAnchorEl(e.currentTarget)}
        onMouseLeave={() => setAnchorEl(null)}
        onFocus={(e) => setAnchorEl(e.currentTarget)}
        onBlur={() => setAnchorEl(null)}
        onClick={handleClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleClick(); }}
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
                {source.cited && <CitedIndicator />}
                {source.page != null && source.cited && (
                  <span className={styles.metaDivider}>·</span>
                )}
                {source.page != null && (
                  <Typography variant="caption" sx={{ fontSize: "0.6875rem", color: "text.secondary" }}>
                    Page {source.page}
                  </Typography>
                )}
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
                  Click to open document
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
  onCitationClick?: (chunkIndex: number) => void,
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
          return <CitationBadge key={`${keyPrefix}-${i}`} source={source} onCitationClick={onCitationClick} />;
        }
      }
      return part;
    });
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      renderWithCitations(child, sources, onCitationClick, `${keyPrefix}-${i}`)
    );
  }
  if (React.isValidElement(children) && children.props?.children) {
    return React.cloneElement(
      children,
      { ...children.props, key: children.key ?? `${keyPrefix}-el` },
      renderWithCitations(children.props.children, sources, onCitationClick, `${keyPrefix}-ch`)
    );
  }
  return children;
}

function buildMarkdownComponents(sources: SourceItem[], onCitationClick?: (chunkIndex: number) => void) {
  const wrapChildren = (Tag: string) =>
    function WrappedComponent(props: any) {
      const { children, node, ...rest } = props;
      return React.createElement(Tag, rest, renderWithCitations(children, sources, onCitationClick));
    };

  return {
    p: wrapChildren("p"),
    li: wrapChildren("li"),
    h1: wrapChildren("h1"),
    h2: wrapChildren("h2"),
    h3: wrapChildren("h3"),
    h4: wrapChildren("h4"),
    h5: wrapChildren("h5"),
    h6: wrapChildren("h6"),
    strong: wrapChildren("strong"),
    em: wrapChildren("em"),
    td(props: any) {
      const { children, node, ...rest } = props;
      return (
        <td {...rest} className={styles.markdownTableCell}>
          {renderWithCitations(children, sources, onCitationClick)}
        </td>
      );
    },
    th(props: any) {
      const { children, node, ...rest } = props;
      return (
        <th {...rest} className={styles.markdownTableCell}>
          {renderWithCitations(children, sources, onCitationClick)}
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

interface MergedCard {
  chunkIndices: number[];
  excerpt: string | null;
  score: number | null;
  cited: boolean;
  page: number | null;
  uri: string | null;
}

interface SourceGroup {
  documentTitle: string;
  s3Key: string | null;
  sourceType: "knowledgeBase" | "excelIndex";
  cards: MergedCard[];
}

function groupSources(sources: SourceItem[]): SourceGroup[] {
  const docGroups: Map<string, { title: string; s3Key: string | null; sourceType: SourceItem["sourceType"]; items: SourceItem[] }> = new Map();
  for (const src of sources) {
    const key = src.s3Key || `__excel__${src.title}`;
    if (!docGroups.has(key)) {
      docGroups.set(key, { title: src.title, s3Key: src.s3Key, sourceType: src.sourceType, items: [] });
    }
    docGroups.get(key)!.items.push(src);
  }

  const result: SourceGroup[] = [];
  for (const doc of docGroups.values()) {
    const pageMap: Map<string, SourceItem[]> = new Map();
    for (const item of doc.items) {
      const pageKey = item.page != null ? String(item.page) : `__chunk_${item.chunkIndex}`;
      if (!pageMap.has(pageKey)) pageMap.set(pageKey, []);
      pageMap.get(pageKey)!.push(item);
    }

    const cards: MergedCard[] = [];
    for (const items of pageMap.values()) {
      const indices = [...new Set(items.map((i) => i.chunkIndex).filter((i): i is number => i != null))].sort((a, b) => a - b);
      const bestScore = items.reduce<number | null>((best, i) => {
        if (i.score == null) return best;
        return best == null || i.score > best ? i.score : best;
      }, null);
      const isCited = items.some((i) => i.cited === true);
      const excerpts = items.map((i) => i.excerpt).filter((e): e is string => !!e);
      const merged = excerpts.length > 1 ? excerpts.join(" ... ") : excerpts[0] ?? null;
      cards.push({
        chunkIndices: indices,
        excerpt: merged,
        score: bestScore,
        cited: isCited,
        page: items[0].page,
        uri: items[0].uri,
      });
    }
    result.push({ documentTitle: doc.title, s3Key: doc.s3Key, sourceType: doc.sourceType, cards });
  }
  return result;
}

export interface ChatMessageProps {
  message: ChatBotHistoryItem;
  isLastAiMessage?: boolean;
  streamingStatus?: StreamingStatus;
  onThumbsUp: () => Promise<void> | void;
  onSubmitFeedback: (
    payload: Omit<FeedbackSubmission, "messageId" | "feedbackKind">
  ) => Promise<void> | void;
  onOpenSource?: (s3Key: string) => void;
}

export default function ChatMessage(props: ChatMessageProps) {
  const [selectedIcon, setSelectedIcon] = useState<1 | 0 | null>(null);
  const { addNotification } = useNotifications();
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);
  const [selectedIssues, setSelectedIssues] = useState<string[]>([]);
  const [feedbackComment, setFeedbackComment] = useState("");
  const [regenerateRequested, setRegenerateRequested] = useState(false);
  const [submittingFeedback, setSubmittingFeedback] = useState(false);
  const [copied, setCopied] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [highlightedChunk, setHighlightedChunk] = useState<number | null>(null);
  const sourcesListRef = useRef<HTMLDivElement>(null);
  const canSubmitFeedback = Boolean(props.message.metadata?.Trace?.messageId);

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

  const citedSources = useMemo(() => sourcesArray.filter(s => s.cited === true), [sourcesArray]);
  const showSources = citedSources.length > 0;
  const sourceGroups = useMemo(() => groupSources(citedSources), [citedSources]);

  const scrollToChunk = useCallback((chunkIndex: number) => {
    const el = sourcesListRef.current?.querySelector(`[data-chunk-indices~="${chunkIndex}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      setHighlightedChunk(chunkIndex);
      setTimeout(() => setHighlightedChunk(null), 1500);
    }
  }, []);

  const handleCitationClick = useCallback((chunkIndex: number) => {
    if (!sourcesOpen) {
      setSourcesOpen(true);
      setTimeout(() => scrollToChunk(chunkIndex), 250);
    } else {
      scrollToChunk(chunkIndex);
    }
  }, [sourcesOpen, scrollToChunk]);

  const mdComponents = useMemo(() => buildMarkdownComponents(sourcesArray, handleCitationClick), [sourcesArray, handleCitationClick]);

  const handleCopy = () => {
    navigator.clipboard.writeText(props.message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const resetFeedback = () => {
    setSelectedIssues([]);
    setFeedbackComment("");
    setRegenerateRequested(false);
    setSubmittingFeedback(false);
  };

  const toggleIssue = (issue: string) => {
    setSelectedIssues((current) =>
      current.includes(issue)
        ? current.filter((entry) => entry !== issue)
        : [...current, issue]
    );
  };

  const issueOptions = [
    { id: "incorrect", label: "Incorrect" },
    { id: "missing", label: "Missing info" },
    { id: "irrelevant", label: "Off target" },
    { id: "unclear", label: "Unclear" },
    { id: "bad_source", label: "Bad source" },
    { id: "formatting", label: "Formatting" },
    { id: "other", label: "Other" },
  ];

  const handleHelpfulClick = async () => {
    if (!canSubmitFeedback) {
      addNotification("error", "Feedback is only available on new responses.");
      return;
    }
    if (selectedIcon === 1) return;
    try {
      await props.onThumbsUp();
      setSelectedIcon(1);
      setFeedbackOpen(false);
      resetFeedback();
      setFeedbackSuccess(true);
      setTimeout(() => setFeedbackSuccess(false), 3000);
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save feedback.");
    }
  };

  const handleNotHelpfulClick = () => {
    if (!canSubmitFeedback) {
      addNotification("error", "Feedback is only available on new responses.");
      return;
    }
    if (feedbackOpen) {
      setFeedbackOpen(false);
      resetFeedback();
    } else {
      setFeedbackOpen(true);
      setFeedbackSuccess(false);
    }
  };

  const handleNegativeSubmit = async () => {
    if (!canSubmitFeedback) {
      addNotification("error", "Feedback is only available on new responses.");
      return;
    }
    if (selectedIssues.length === 0) {
      addNotification("error", "Select at least one issue.");
      return;
    }
    setSubmittingFeedback(true);
    try {
      await props.onSubmitFeedback({
        issueTags: selectedIssues,
        userComment: feedbackComment.trim(),
        expectedAnswer: "",
        wrongSnippet: "",
        sourceAssessment: "",
        regenerateRequested,
      });
      setFeedbackOpen(false);
      resetFeedback();
      setSelectedIcon(0);
      setFeedbackSuccess(true);
      setTimeout(() => setFeedbackSuccess(false), 4000);
    } catch (error: any) {
      addNotification("error", error?.message || "Could not submit feedback.");
    } finally {
      setSubmittingFeedback(false);
    }
  };

  return (
    <div>
      {/* AI Message */}
      {props.message?.type === ChatBotMessageType.AI && (
        <div
          className={styles.aiMessage}
          role="article"
          aria-label="ABE response"
          aria-busy={Boolean(
            props.isLastAiMessage &&
              (props.streamingStatus?.active || props.message.content.length === 0)
          )}
        >
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
                <div className={styles.statusIndicator} role="status" aria-live="polite">
                  <CircularProgress size={14} sx={{ color: "primary.main" }} />
                  <Typography variant="body2" sx={{ color: "text.secondary", fontStyle: "italic" }}>
                    Thinking…
                  </Typography>
                </div>
              ) : null}

              {props.isLastAiMessage && props.streamingStatus?.active ? (
                <div className={styles.statusIndicator} role="status" aria-live="off">
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

              {/* Feedback buttons — both always visible so user can switch */}
              {content.length > 0 && (
                <div className={styles.thumbsContainer} role="group" aria-label="Rate this response">
                  <IconButton
                    size="small"
                    onClick={handleHelpfulClick}
                    aria-label="Mark response as helpful"
                    aria-pressed={selectedIcon === 1}
                    sx={{
                      borderRadius: 1.5,
                      px: 1,
                      gap: 0.5,
                      "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
                    }}
                    disabled={!canSubmitFeedback}
                  >
                    {selectedIcon === 1 ? (
                      <ThumbUpIcon sx={{ fontSize: 16 }} color="primary" />
                    ) : (
                      <ThumbUpOutlinedIcon sx={{ fontSize: 16 }} />
                    )}
                    <Typography variant="caption" sx={{ fontSize: "0.75rem", color: selectedIcon === 1 ? "primary.main" : "text.secondary" }}>
                      Helpful
                    </Typography>
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={handleNotHelpfulClick}
                    aria-label="Mark response as not helpful and provide feedback"
                    aria-pressed={selectedIcon === 0}
                    aria-expanded={feedbackOpen}
                    aria-controls={feedbackOpen ? "abe-feedback-form-panel" : undefined}
                    sx={{
                      borderRadius: 1.5,
                      px: 1,
                      gap: 0.5,
                      "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
                    }}
                    disabled={!canSubmitFeedback}
                  >
                    {selectedIcon === 0 || feedbackOpen ? (
                      <ThumbDownIcon sx={{ fontSize: 16 }} color={selectedIcon === 0 ? "primary" : "action"} />
                    ) : (
                      <ThumbDownOutlinedIcon sx={{ fontSize: 16 }} />
                    )}
                    <Typography variant="caption" sx={{ fontSize: "0.75rem", color: selectedIcon === 0 ? "primary.main" : "text.secondary" }}>
                      Not helpful
                    </Typography>
                  </IconButton>
                </div>
              )}

              {/* Inline success message */}
              <Collapse in={feedbackSuccess} timeout={200}>
                <Stack
                  direction="row"
                  alignItems="center"
                  gap={1}
                  sx={{ mt: 1, py: 1, px: 1.5, borderRadius: 1, bgcolor: "success.50", border: "1px solid", borderColor: "success.200" }}
                  role="status"
                  aria-live="polite"
                >
                  <CheckCircleOutlineIcon sx={{ fontSize: 18, color: "success.main" }} />
                  <Typography variant="body2" sx={{ fontSize: "0.8125rem", color: "success.dark" }}>
                    {regenerateRequested ? "Thanks! ABE is retrying your question." : "Thanks for your feedback!"}
                  </Typography>
                </Stack>
              </Collapse>

              {/* Inline feedback form — replaces bottom drawer */}
              <Collapse in={feedbackOpen} timeout={200}>
                <Box
                  id="abe-feedback-form-panel"
                  sx={{
                    mt: 1.5,
                    pt: 1.5,
                    borderTop: "1px solid",
                    borderColor: "divider",
                  }}
                  role="form"
                  aria-label="Feedback form"
                >
                  <Stack spacing={1.5}>
                    <Typography component="h3" variant="subtitle2" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>
                      What went wrong? <Typography component="span" variant="caption" color="text.secondary">(select all that apply)</Typography>
                    </Typography>

                    <Stack direction="row" gap={0.75} flexWrap="wrap" role="group" aria-label="Issue categories">
                      {issueOptions.map((issue) => (
                        <Chip
                          key={issue.id}
                          label={issue.label}
                          size="small"
                          color={selectedIssues.includes(issue.id) ? "primary" : "default"}
                          variant={selectedIssues.includes(issue.id) ? "filled" : "outlined"}
                          onClick={() => toggleIssue(issue.id)}
                          aria-pressed={selectedIssues.includes(issue.id)}
                          sx={{
                            fontSize: "0.75rem",
                            height: 28,
                            "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 1 },
                          }}
                        />
                      ))}
                    </Stack>

                    <TextField
                      label="Tell us more (optional)"
                      value={feedbackComment}
                      onChange={(e) => setFeedbackComment(e.target.value)}
                      fullWidth
                      size="small"
                      multiline
                      minRows={2}
                      maxRows={4}
                      placeholder="What did you expect instead? What was wrong?"
                      inputProps={{ "aria-describedby": "feedback-hint" }}
                      sx={{ "& .MuiInputBase-root": { fontSize: "0.875rem" } }}
                    />
                    <Typography id="feedback-hint" variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                      Your feedback helps us improve ABE for everyone.
                    </Typography>

                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={regenerateRequested}
                          onChange={(e) => setRegenerateRequested(e.target.checked)}
                        />
                      }
                      label={
                        <Typography variant="body2" sx={{ fontSize: "0.8125rem" }}>
                          Also retry my question
                        </Typography>
                      }
                    />

                    <Stack direction="row" justifyContent="flex-end" gap={1}>
                      <Button
                        size="small"
                        onClick={() => { setFeedbackOpen(false); resetFeedback(); }}
                        sx={{ fontSize: "0.8125rem" }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="contained"
                        size="small"
                        onClick={handleNegativeSubmit}
                        disabled={selectedIssues.length === 0 || submittingFeedback}
                        sx={{ fontSize: "0.8125rem" }}
                      >
                        {submittingFeedback ? "Sending..." : "Send feedback"}
                      </Button>
                    </Stack>
                  </Stack>
                </Box>
              </Collapse>
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
                    {sourceGroups.length} document{sourceGroups.length !== 1 ? "s" : ""} referenced
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
                  <div id="sources-list" className={styles.sourcesList} ref={sourcesListRef}>
                    {sourceGroups.map((group, gi) => (
                      <div key={`group-${gi}`} className={styles.sourceGroup}>
                        <div className={styles.sourceGroupHeader}>
                          {group.sourceType === "excelIndex" ? (
                            <TableChartOutlinedIcon sx={{ fontSize: 16, color: "var(--abe-primary, #14558f)", flexShrink: 0 }} />
                          ) : (
                            <DescriptionOutlinedIcon sx={{ fontSize: 16, color: "var(--abe-primary, #14558f)", flexShrink: 0 }} />
                          )}
                          <Typography variant="body2" className={styles.sourceGroupTitle} noWrap>
                            {group.documentTitle}
                          </Typography>
                          {(group.s3Key || group.cards[0]?.uri) && (
                            <button
                              type="button"
                              className={styles.sourceCardLink}
                              aria-label={`Open ${group.documentTitle}`}
                              onClick={() => {
                                if (group.s3Key && props.onOpenSource) {
                                  props.onOpenSource(group.s3Key);
                                } else if (group.cards[0]?.uri) {
                                  window.open(group.cards[0].uri, "_blank", "noopener,noreferrer");
                                }
                              }}
                            >
                              <OpenInNewIcon sx={{ fontSize: 14 }} />
                            </button>
                          )}
                        </div>
                        {group.cards.map((card, ci) => {
                          const isHighlighted = highlightedChunk != null && card.chunkIndices.includes(highlightedChunk);
                          return (
                          <div
                            key={`src-${gi}-${ci}`}
                            className={`${styles.sourceCard} ${isHighlighted ? styles.sourceCardHighlight : ""}`}
                            data-chunk-indices={card.chunkIndices.join(" ")}
                          >
                            <div className={styles.sourceCardTop}>
                              {card.chunkIndices.length > 0 && (
                                <span className={styles.sourceCardBadges}>
                                  {card.chunkIndices.map((idx) => (
                                    <span key={idx} className={styles.sourceCardBadge}>{idx}</span>
                                  ))}
                                </span>
                              )}
                              <div className={styles.sourceCardInfo}>
                                {card.page != null && (
                                  <Typography variant="caption" sx={{ fontSize: "0.75rem", color: "text.secondary" }}>
                                    Page {card.page}
                                  </Typography>
                                )}
                              </div>
                            </div>
                            {card.excerpt && (
                              <Typography variant="body2" className={styles.sourceCardExcerpt}>
                                {card.excerpt.length > 250 ? card.excerpt.slice(0, 250) + "..." : card.excerpt}
                              </Typography>
                            )}
                          </div>
                          );
                        })}
                      </div>
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
          <div className={styles.humanMessageInner}>
            <div className={styles.humanBubble}>
              {typeof content === "string" ? content : ""}
            </div>
            {formattedTime && (
              <Typography
                variant="caption"
                component="span"
                sx={{ display: "block", textAlign: "right", mt: 0.5, color: "text.secondary", fontSize: "0.75rem" }}
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
