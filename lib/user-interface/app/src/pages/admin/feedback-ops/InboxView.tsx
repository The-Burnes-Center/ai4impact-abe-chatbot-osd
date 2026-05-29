import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  LinearProgress,
  Link,
  Paper,
  Skeleton,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import NavigateBeforeIcon from "@mui/icons-material/NavigateBefore";
import NavigateNextIcon from "@mui/icons-material/NavigateNext";
import RefreshIcon from "@mui/icons-material/Refresh";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import CloseIcon from "@mui/icons-material/Close";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import SearchIcon from "@mui/icons-material/Search";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import {
  FeedbackItem,
  FeedbackDetail,
  InboxFilters,
  REVIEW_STATUS_OPTIONS,
  feedbackStatusChip,
  formatDate,
} from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import AdminMarkdown from "../../../components/admin-markdown";
import { useNotifications } from "../../../components/notif-manager";

/** Plain-language name for the AI's guess at what went wrong. */
const ISSUE_LABELS: Record<string, { label: string; color: "error" | "warning" | "info" | "default" }> = {
  retrieval_gap: { label: "Missing info", color: "warning" },
  grounding_error: { label: "Wrong answer", color: "error" },
  prompt_issue: { label: "Response style", color: "info" },
  answer_quality: { label: "Low quality", color: "warning" },
  product_bug: { label: "System bug", color: "error" },
};

type ViewFilter = "needs" | "helpful" | "all";

function itemNeedsTriage(item: FeedbackItem): boolean {
  if (item.feedbackKind === "helpful") return false;
  if (item.reviewStatus === "actioned" || item.reviewStatus === "dismissed") return false;
  return true;
}

function plainPreview(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  // Strip the most common markdown noise so a one-line card preview reads cleanly.
  return text
    .replace(/[#*_>`~]/g, "")
    .replace(/\[(\d+)\]/g, "")
    .replace(/\s+/g, " ")
    .trim() || fallback;
}

interface InboxViewProps {
  feedbackItems: FeedbackItem[];
  selectedFeedback: FeedbackDetail | null;
  filters: InboxFilters;
  loadingFeedback: boolean;
  loadingMeta: boolean;
  apiClient: ApiClient | null;
  onFiltersChange: (filters: InboxFilters) => void;
  onRefresh: () => Promise<void>;
  onSelectFeedback: (detail: FeedbackDetail | null) => void;
  onLoadFeedbackDetail: (id: string) => Promise<void>;
  onFeedbackUpdated: () => Promise<void>;
  selectedFeedbackIds: string[];
  onSelectedFeedbackIdsChange: (ids: string[]) => void;
}

function InboxSkeleton() {
  return (
    <Stack spacing={2}>
      <Skeleton variant="rounded" height={48} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={120} />
      <Skeleton variant="rounded" height={120} />
    </Stack>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <InboxOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        {body}
      </Typography>
    </Paper>
  );
}

export default function InboxView(props: InboxViewProps) {
  const {
    feedbackItems,
    selectedFeedback,
    filters,
    loadingFeedback,
    loadingMeta,
    apiClient,
    onFiltersChange,
    onRefresh,
    onSelectFeedback,
    onLoadFeedbackDetail,
    onFeedbackUpdated,
    onSelectedFeedbackIdsChange,
  } = props;

  const navigate = useNavigate();
  const { addNotification } = useNotifications();

  const [notes, setNotes] = useState("");
  const [reviewStatus, setReviewStatus] = useState("new");
  const [actionLoading, setActionLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [view, setView] = useState<ViewFilter>("needs");
  const [detailOpen, setDetailOpen] = useState(false);
  const [exampleDialog, setExampleDialog] = useState<FeedbackItem | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; feedbackId: string; question: string }>({
    open: false,
    feedbackId: "",
    question: "",
  });
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const pageSize = 25;

  const counts = useMemo(
    () => ({
      needs: feedbackItems.filter(itemNeedsTriage).length,
      helpful: feedbackItems.filter((i) => i.feedbackKind === "helpful").length,
      all: feedbackItems.length,
    }),
    [feedbackItems]
  );

  const visibleItems = useMemo(() => {
    if (view === "needs") return feedbackItems.filter(itemNeedsTriage);
    if (view === "helpful") return feedbackItems.filter((i) => i.feedbackKind === "helpful");
    return feedbackItems;
  }, [feedbackItems, view]);

  const totalPages = Math.ceil(visibleItems.length / pageSize);
  const pagedItems = useMemo(
    () => visibleItems.slice(page * pageSize, (page + 1) * pageSize),
    [visibleItems, page]
  );

  useEffect(() => {
    const fb = selectedFeedback?.feedback;
    setNotes(fb?.ResolutionNote || fb?.AdminNotes || "");
    setReviewStatus(fb?.ReviewStatus === "analyzed" ? "new" : fb?.ReviewStatus || "new");
  }, [selectedFeedback]);

  useEffect(() => {
    setPage(0);
  }, [view]);

  useEffect(() => {
    setPage((currentPage) => Math.min(currentPage, Math.max(0, totalPages - 1)));
  }, [totalPages]);

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchDraft === filtersRef.current.search) return undefined;
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      searchDebounceRef.current = null;
      onFiltersChange({ ...filtersRef.current, search: searchDraft });
      setPage(0);
    }, 300);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchDraft, onFiltersChange]);

  const handleOpenDetail = useCallback(
    async (id: string) => {
      await onLoadFeedbackDetail(id);
      setDetailOpen(true);
      onSelectedFeedbackIdsChange([id]);
      navigate(`/admin/user-feedback/${id}`, { replace: true });
    },
    [onLoadFeedbackDetail, onSelectedFeedbackIdsChange, navigate]
  );

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false);
    onSelectFeedback(null);
    onSelectedFeedbackIdsChange([]);
    navigate("/admin/user-feedback", { replace: true });
  }, [onSelectFeedback, onSelectedFeedbackIdsChange, navigate]);

  const handleSaveReview = async () => {
    const fb = selectedFeedback?.feedback;
    if (!apiClient || !fb?.FeedbackId) return;
    try {
      setActionLoading(true);
      // Preserve fields we no longer surface (owner/disposition) so saving never wipes existing data.
      await apiClient.userFeedback.setFeedbackDisposition(fb.FeedbackId, {
        reviewStatus,
        disposition: fb.Disposition || "pending",
        owner: fb.Owner || "",
        resolutionNote: notes,
        adminNotes: notes,
      });
      await onLoadFeedbackDetail(fb.FeedbackId);
      await onFeedbackUpdated();
      addNotification("success", "Saved.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not save.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveAndNext = async () => {
    await handleSaveReview();
    const currentIndex = visibleItems.findIndex((i) => i.feedbackId === selectedFeedback?.feedback?.FeedbackId);
    const next = visibleItems.find((item, idx) => idx > currentIndex && itemNeedsTriage(item));
    if (next) {
      await handleOpenDetail(next.feedbackId);
    } else {
      addNotification("info", "That was the last item needing review.");
    }
  };

  const handleSummarize = async () => {
    const fb = selectedFeedback?.feedback;
    if (!apiClient || !fb?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.analyzeFeedback(fb.FeedbackId);
      await onLoadFeedbackDetail(fb.FeedbackId);
      await onFeedbackUpdated();
      addNotification("success", "AI summary updated.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not generate an AI summary.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveAsExample = async (item: FeedbackItem) => {
    if (!apiClient) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.promoteToCandidate(item.feedbackId);
      await onFeedbackUpdated();
      addNotification("success", "Saved as a good example for quality checks.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not save this example.");
    } finally {
      setActionLoading(false);
      setExampleDialog(null);
    }
  };

  const handleDeleteFeedback = async () => {
    if (!apiClient || !deleteDialog.feedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.deleteFeedback(deleteDialog.feedbackId);
      if (selectedFeedback?.feedback?.FeedbackId === deleteDialog.feedbackId) {
        handleCloseDetail();
      }
      await onFeedbackUpdated();
      addNotification("success", "Deleted.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not delete.");
    } finally {
      setActionLoading(false);
      setDeleteDialog({ open: false, feedbackId: "", question: "" });
    }
  };

  useEffect(() => {
    if (selectedFeedback && !detailOpen) setDetailOpen(true);
  }, [detailOpen, selectedFeedback]);

  if (loadingFeedback && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  const listBusy = loadingFeedback || loadingMeta || actionLoading;
  const selected = selectedFeedback?.feedback;
  const isHelpful = selected?.FeedbackKind === "helpful";
  const aiSummary = selected?.Analysis?.summary;
  const aiIssue = selected?.Analysis?.likelyRootCause ? ISSUE_LABELS[selected.Analysis.likelyRootCause] : undefined;

  return (
    <Stack spacing={2}>
      {listBusy && (
        <Box role="progressbar" aria-label="Loading feedback" aria-busy="true" sx={{ borderRadius: 1 }}>
          <LinearProgress sx={{ borderRadius: 1 }} />
        </Box>
      )}

      {/* Simple controls: what to show + search */}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        gap={1.5}
        alignItems={{ sm: "center" }}
        justifyContent="space-between"
      >
        <ToggleButtonGroup
          value={view}
          exclusive
          size="small"
          onChange={(_, value: ViewFilter | null) => {
            if (value) setView(value);
          }}
          aria-label="Which feedback to show"
        >
          <ToggleButton value="needs" sx={{ textTransform: "none", px: 1.75 }}>
            Needs review{counts.needs > 0 ? ` (${counts.needs})` : ""}
          </ToggleButton>
          <ToggleButton value="helpful" sx={{ textTransform: "none", px: 1.75 }}>
            Helpful{counts.helpful > 0 ? ` (${counts.helpful})` : ""}
          </ToggleButton>
          <ToggleButton value="all" sx={{ textTransform: "none", px: 1.75 }}>
            All ({counts.all})
          </ToggleButton>
        </ToggleButtonGroup>

        <Stack direction="row" gap={1} alignItems="center" sx={{ flex: 1, maxWidth: { sm: 360 } }}>
          <TextField
            size="small"
            placeholder="Search feedback"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            sx={{ flex: 1 }}
            inputProps={{ "aria-label": "Search feedback" }}
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <Tooltip title="Refresh">
            <span>
              <IconButton onClick={onRefresh} disabled={listBusy} size="small" aria-label="Refresh">
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      </Stack>

      {/* List */}
      {visibleItems.length === 0 ? (
        view === "needs" ? (
          <EmptyState
            title="Nothing needs your review"
            body="You're all caught up. Switch to “All” or “Helpful” to see other feedback."
          />
        ) : feedbackItems.length === 0 ? (
          <EmptyState title="No feedback yet" body="Feedback from chat users will show up here once they submit it." />
        ) : (
          <EmptyState title="No matches" body="Try a different search or filter." />
        )
      ) : (
        <Stack spacing={1.5} sx={{ maxWidth: 860 }} role="list" aria-label="Feedback">
          {pagedItems.map((item) => {
            const positive = item.feedbackKind === "helpful";
            const isActive = selected?.FeedbackId === item.feedbackId;
            const status = feedbackStatusChip(item);
            const issue = item.rootCause ? ISSUE_LABELS[item.rootCause] : undefined;
            const question = plainPreview(item.userPromptPreview, "(no question captured)");
            const preview = plainPreview(item.summary || item.answerPreview, "No preview available.");

            return (
              <Paper
                key={item.feedbackId}
                variant="outlined"
                component="article"
                role="listitem"
                tabIndex={0}
                onClick={() => handleOpenDetail(item.feedbackId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleOpenDetail(item.feedbackId);
                  }
                }}
                aria-current={isActive ? "true" : undefined}
                aria-label={`${status.label}. ${question}`}
                sx={{
                  cursor: "pointer",
                  borderRadius: 2,
                  p: 2,
                  borderLeftWidth: 4,
                  borderLeftStyle: "solid",
                  borderLeftColor: positive ? "success.main" : "warning.main",
                  transition: "box-shadow 160ms ease",
                  ...(isActive && { boxShadow: (t) => `0 0 0 2px ${alpha(t.palette.primary.main, 0.35)}` }),
                  "&:hover": { boxShadow: (t) => `0 6px 20px ${alpha(t.palette.common.black, 0.08)}` },
                  "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
                }}
              >
                <Stack spacing={1}>
                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                    {positive ? (
                      <ThumbUpOutlinedIcon sx={{ fontSize: 18, color: "success.main" }} aria-hidden />
                    ) : (
                      <ThumbDownOutlinedIcon sx={{ fontSize: 18, color: "warning.dark" }} aria-hidden />
                    )}
                    <Chip size="small" color={status.color} label={status.label} sx={{ height: 22, fontSize: "0.75rem" }} />
                    {issue && (
                      <Chip
                        size="small"
                        variant="outlined"
                        color={issue.color}
                        label={issue.label}
                        sx={{ height: 22, fontSize: "0.75rem" }}
                      />
                    )}
                    {item.recurrenceCount && item.recurrenceCount > 1 && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`Seen ${item.recurrenceCount}×`}
                        sx={{ height: 22, fontSize: "0.75rem" }}
                      />
                    )}
                    <Box sx={{ flex: 1 }} />
                    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                      {formatDate(item.createdAt)}
                    </Typography>
                  </Stack>

                  <Typography
                    sx={{
                      fontWeight: 600,
                      fontSize: "0.95rem",
                      lineHeight: 1.4,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {question}
                  </Typography>

                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      fontSize: "0.8125rem",
                      lineHeight: 1.5,
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {preview}
                  </Typography>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ maxWidth: 860, pt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Page {page + 1} of {totalPages}
          </Typography>
          <Stack direction="row" gap={0.5}>
            <IconButton size="small" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} aria-label="Previous page">
              <NavigateBeforeIcon />
            </IconButton>
            <IconButton
              size="small"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              aria-label="Next page"
            >
              <NavigateNextIcon />
            </IconButton>
          </Stack>
        </Stack>
      )}

      {/* Detail panel */}
      <Drawer
        anchor="right"
        open={detailOpen && selectedFeedback != null}
        onClose={handleCloseDetail}
        sx={{ zIndex: (t) => t.zIndex.modal + 2 }}
        slotProps={{ backdrop: { "aria-hidden": true } }}
        PaperProps={{
          sx: { width: { xs: "100%", md: 540 }, p: 0 },
          role: "dialog",
          "aria-modal": true,
          "aria-label": "Feedback detail",
        }}
      >
        {selectedFeedback && selected && (
          <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
            {/* Header */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 2, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}
            >
              <Stack direction="row" gap={1} alignItems="center">
                {isHelpful ? (
                  <ThumbUpOutlinedIcon sx={{ fontSize: 20, color: "success.main" }} aria-hidden="true" />
                ) : (
                  <ThumbDownOutlinedIcon sx={{ fontSize: 20, color: "warning.dark" }} aria-hidden="true" />
                )}
                <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
                  {isHelpful ? "Helpful feedback" : "Feedback to review"}
                </Typography>
              </Stack>
              <IconButton size="small" onClick={handleCloseDetail} aria-label="Close">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            {/* Conversation + review */}
            <Box sx={{ flex: 1, overflow: "auto", px: 2.5, py: 2.5 }}>
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    What the user asked
                  </Typography>
                  <AdminMarkdown
                    content={selectedFeedback.trace?.UserPrompt || selected.UserPromptPreview || "N/A"}
                    sx={{ mt: 0.5 }}
                  />
                </Box>

                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    How ABE answered
                  </Typography>
                  <AdminMarkdown
                    content={selectedFeedback.trace?.FinalAnswer || selected.AnswerPreview || "N/A"}
                    maxHeight={260}
                    sx={{ mt: 0.5 }}
                  />
                </Box>

                {/* What the user told us */}
                {(selected.WrongSnippet || selected.ExpectedAnswer || selected.UserComment) && (
                  <Stack spacing={1.5}>
                    {selected.WrongSnippet && (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "error.50", borderColor: "error.200" }}>
                        <Typography variant="overline" color="error.dark" sx={{ fontSize: "0.6875rem" }}>
                          What was wrong
                        </Typography>
                        <AdminMarkdown content={selected.WrongSnippet} compact sx={{ mt: 0.5 }} />
                      </Paper>
                    )}
                    {selected.ExpectedAnswer && (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "success.50", borderColor: "success.200" }}>
                        <Typography variant="overline" color="success.dark" sx={{ fontSize: "0.6875rem" }}>
                          What they expected instead
                        </Typography>
                        <AdminMarkdown content={selected.ExpectedAnswer} compact sx={{ mt: 0.5 }} />
                      </Paper>
                    )}
                    {selected.UserComment && (
                      <Box>
                        <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                          Their note
                        </Typography>
                        <AdminMarkdown content={selected.UserComment} compact sx={{ mt: 0.5 }} />
                      </Box>
                    )}
                  </Stack>
                )}

                {/* AI summary — only for negative feedback */}
                {!isHelpful && (
                  <Paper variant="outlined" sx={{ p: 1.75, bgcolor: (t) => alpha(t.palette.info.main, 0.05) }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                      <Stack direction="row" gap={0.75} alignItems="center">
                        <AutoAwesomeOutlinedIcon sx={{ fontSize: 16, color: "info.main" }} aria-hidden />
                        <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                          AI summary
                        </Typography>
                      </Stack>
                      <Button
                        size="small"
                        onClick={handleSummarize}
                        disabled={actionLoading}
                        sx={{ textTransform: "none", fontSize: "0.75rem", minWidth: "auto" }}
                      >
                        {aiSummary ? "Refresh" : "Generate"}
                      </Button>
                    </Stack>
                    {aiSummary ? (
                      <>
                        <AdminMarkdown content={aiSummary} compact sx={{ mt: 0.5 }} />
                        {aiIssue && (
                          <Chip
                            size="small"
                            color={aiIssue.color}
                            label={aiIssue.label}
                            sx={{ mt: 1, height: 24, fontSize: "0.75rem" }}
                          />
                        )}
                      </>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, fontSize: "0.8125rem" }}>
                        No AI summary yet. Click Generate to have AI explain what likely went wrong.
                      </Typography>
                    )}
                  </Paper>
                )}

                <Divider />

                {/* The review: just a status + an optional note */}
                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    Status
                  </Typography>
                  <ToggleButtonGroup
                    value={reviewStatus}
                    exclusive
                    fullWidth
                    size="small"
                    onChange={(_, value: string | null) => {
                      if (value) setReviewStatus(value);
                    }}
                    aria-label="Status"
                    sx={{ mt: 0.75, flexWrap: "wrap" }}
                  >
                    {REVIEW_STATUS_OPTIONS.map((option) => (
                      <ToggleButton
                        key={option.value}
                        value={option.value}
                        sx={{ textTransform: "none", fontSize: "0.8125rem", py: 0.75 }}
                      >
                        {option.label}
                      </ToggleButton>
                    ))}
                  </ToggleButtonGroup>
                </Box>

                <TextField
                  fullWidth
                  size="small"
                  label="Notes (optional)"
                  multiline
                  minRows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  inputProps={{ "aria-label": "Notes" }}
                  helperText="A quick note on what you found or decided"
                  FormHelperTextProps={{ sx: { fontSize: "0.7rem", m: 0, mt: 0.5 } }}
                />

                <Typography variant="caption" color="text.secondary">
                  Submitted {formatDate(selected.CreatedAt)}
                </Typography>
                {selectedFeedback.trace?.SessionId && (
                  <Link
                    component={RouterLink}
                    to={`/chatbot/playground/${selectedFeedback.trace.SessionId}`}
                    variant="body2"
                    sx={{ fontSize: "0.8125rem" }}
                  >
                    View the full chat conversation
                  </Link>
                )}
              </Stack>
            </Box>

            {/* Actions */}
            <Stack
              direction="row"
              gap={1}
              alignItems="center"
              sx={{ px: 2.5, py: 1.5, borderTop: "1px solid", borderColor: "divider", flexShrink: 0 }}
            >
              {isHelpful ? (
                <>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleSaveReview}
                    disabled={actionLoading}
                    sx={{ textTransform: "none" }}
                  >
                    Save
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      const item = feedbackItems.find((i) => i.feedbackId === selected.FeedbackId);
                      if (item) setExampleDialog(item);
                    }}
                    disabled={actionLoading}
                    sx={{ textTransform: "none" }}
                  >
                    Save as good example
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleSaveAndNext}
                    disabled={actionLoading}
                    endIcon={<SkipNextIcon />}
                    sx={{ textTransform: "none" }}
                  >
                    Save &amp; next
                  </Button>
                  <Button size="small" onClick={handleSaveReview} disabled={actionLoading} sx={{ textTransform: "none" }}>
                    Save
                  </Button>
                </>
              )}
              <Tooltip title="Delete this feedback">
                <span style={{ marginLeft: "auto" }}>
                  <IconButton
                    size="small"
                    onClick={() =>
                      setDeleteDialog({
                        open: true,
                        feedbackId: selected.FeedbackId,
                        question: selected.UserPromptPreview || "this item",
                      })
                    }
                    disabled={actionLoading}
                    aria-label="Delete feedback"
                    sx={{ color: "text.secondary", "&:hover": { color: "error.main" } }}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        )}
      </Drawer>

      {/* Save as good example confirm */}
      <Dialog open={exampleDialog != null} onClose={() => setExampleDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>Save as a good example?</DialogTitle>
        <DialogContent>
          {exampleDialog && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.875rem" }}>
                This question and ABE's answer will be saved as a good example. We use these examples to automatically
                check that ABE keeps giving high-quality answers over time.
              </Typography>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                  Question
                </Typography>
                <AdminMarkdown content={exampleDialog.userPromptPreview || "N/A"} sx={{ mt: 0.5 }} />
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setExampleDialog(null)} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={() => exampleDialog && handleSaveAsExample(exampleDialog)}
            disabled={actionLoading}
            sx={{ textTransform: "none" }}
          >
            Save example
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, feedbackId: "", question: "" })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>Delete this feedback?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ fontSize: "0.875rem" }}>
            This permanently removes the feedback for:
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, mt: 1, fontSize: "0.875rem" }}>
            "{deleteDialog.question}"
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, fontSize: "0.8125rem" }}>
            This can't be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteDialog({ open: false, feedbackId: "", question: "" })} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button variant="contained" color="error" onClick={handleDeleteFeedback} disabled={actionLoading} sx={{ textTransform: "none" }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
