import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
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
import {
  DISPOSITIONS,
  FeedbackItem,
  FeedbackDetail,
  InboxFilters,
  MonitoringData,
  formatDate,
  label,
} from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import AdminMarkdown from "../../../components/admin-markdown";
import { useNotifications } from "../../../components/notif-manager";

const ROOT_CAUSE_CHIPS: Record<string, { label: string; color: "error" | "warning" | "info" | "default" }> = {
  retrieval_gap: { label: "Missing info", color: "warning" },
  grounding_error: { label: "Wrong answer", color: "error" },
  prompt_issue: { label: "Response style", color: "info" },
  answer_quality: { label: "Low quality", color: "warning" },
  product_bug: { label: "System bug", color: "error" },
  needs_human_review: { label: "Needs review", color: "default" },
  positive_signal: { label: "Helpful", color: "info" },
};


function getReviewStatusColor(status?: string): "default" | "success" | "info" | "warning" {
  if (status === "actioned") return "success";
  if (status === "dismissed") return "default";
  if (status === "in_review") return "info";
  return "warning";
}

function summarizeSources(item: FeedbackItem): { primary: string; secondary: string } {
  const sources = item.sourceTitles || [];
  if (sources.length === 0) {
    return { primary: "No source documents captured", secondary: item.promptVersionId ? `Prompt ${item.promptVersionId}` : "Prompt version unavailable" };
  }

  const [first, ...rest] = sources;
  return {
    primary: first,
    secondary: rest.length > 0
      ? `+${rest.length} more source${rest.length > 1 ? "s" : ""}${item.promptVersionId ? ` | Prompt ${item.promptVersionId}` : ""}`
      : item.promptVersionId ? `Prompt ${item.promptVersionId}` : "Single source hit",
  };
}

interface InboxViewProps {
  feedbackItems: FeedbackItem[];
  selectedFeedback: FeedbackDetail | null;
  filters: InboxFilters;
  loading: boolean;
  apiClient: ApiClient | null;
  monitoring: MonitoringData | null;
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
      <Skeleton variant="rounded" height={400} />
    </Stack>
  );
}

function EmptyInbox() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <InboxOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        No feedback yet
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Feedback from chat users will appear here once submitted.
      </Typography>
    </Paper>
  );
}

function FilteredEmptyInbox() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <InboxOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        No results match these filters
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Try clearing the date range or broadening the queue filters.
      </Typography>
    </Paper>
  );
}

export default function InboxView(props: InboxViewProps) {
  const {
    feedbackItems,
    selectedFeedback,
    filters,
    loading,
    apiClient,
    monitoring,
    onFiltersChange,
    onRefresh,
    onSelectFeedback,
    onLoadFeedbackDetail,
    onFeedbackUpdated,
  } = props;

  const navigate = useNavigate();
  const { addNotification } = useNotifications();
  const [owner, setOwner] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [reviewStatus, setReviewStatus] = useState("new");
  const [disposition, setDisposition] = useState("pending");
  const [actionLoading, setActionLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    item: FeedbackItem | null;
    action: "test_library" | "fix_prompt";
  }>({ open: false, item: null, action: "test_library" });
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    feedbackId: string;
    question: string;
  }>({ open: false, feedbackId: "", question: "" });

  const pageSize = 25;
  const totalPages = Math.ceil(feedbackItems.length / pageSize);
  const pagedItems = useMemo(
    () => feedbackItems.slice(page * pageSize, (page + 1) * pageSize),
    [feedbackItems, page]
  );
  const rootCauseOptions = useMemo(() => {
    const available = monitoring?.feedbackOverview?.rootCauseCounts
      ? Object.keys(monitoring.feedbackOverview.rootCauseCounts)
      : [];
    const fallback = Object.keys(ROOT_CAUSE_CHIPS);
    return Array.from(new Set([...available, ...fallback])).filter((key) => key && key !== "unknown");
  }, [monitoring]);
  const queueStats = useMemo(
    () => ({
      shown: feedbackItems.length,
      needsReview: feedbackItems.filter((item) => item.feedbackKind !== "helpful" && item.reviewStatus !== "actioned").length,
      resolved: feedbackItems.filter((item) => item.reviewStatus === "actioned").length,
      positive: feedbackItems.filter((item) => item.feedbackKind === "helpful").length,
    }),
    [feedbackItems]
  );

  useEffect(() => {
    if (selectedFeedback?.feedback) {
      const fb = selectedFeedback.feedback;
      setOwner(fb.Owner || "");
      setResolutionNote(fb.ResolutionNote || "");
      setAdminNotes(fb.AdminNotes || "");
      setReviewStatus(fb.ReviewStatus || "new");
      setDisposition(fb.Disposition || "pending");
    } else {
      setOwner("");
      setResolutionNote("");
      setAdminNotes("");
      setReviewStatus("new");
      setDisposition("pending");
    }
  }, [selectedFeedback]);

  useEffect(() => {
    setPage((currentPage) => {
      if (feedbackItems.length === 0) {
        return 0;
      }
      return Math.min(currentPage, Math.max(0, Math.ceil(feedbackItems.length / pageSize) - 1));
    });
  }, [feedbackItems.length]);

  const updateFilter = useCallback(
    (key: keyof InboxFilters, value: string) => {
      const nextFilters = { ...filters, [key]: value };
      if (key === "dateFrom" && value && nextFilters.dateTo && value > nextFilters.dateTo) {
        nextFilters.dateTo = value;
      }
      if (key === "dateTo" && value && nextFilters.dateFrom && value < nextFilters.dateFrom) {
        nextFilters.dateTo = nextFilters.dateFrom;
      }
      onFiltersChange(nextFilters);
      setPage(0);
    },
    [filters, onFiltersChange]
  );

  const clearFilters = useCallback(() => {
    onFiltersChange({
      feedbackKind: "",
      reviewStatus: "",
      disposition: "",
      issueTag: "",
      promptVersionId: "",
      sourceTitle: "",
      rootCause: "",
      dateFrom: "",
      dateTo: "",
      search: "",
    });
    setPage(0);
  }, [onFiltersChange]);

  const hasActiveFilters = Object.values(filters).some(Boolean);

  const handleOpenDetail = useCallback(async (id: string) => {
    await onLoadFeedbackDetail(id);
    setDetailOpen(true);
    navigate(`/admin/user-feedback/${id}`, { replace: true });
  }, [onLoadFeedbackDetail, navigate]);

  const handleCloseDetail = useCallback(() => {
    setDetailOpen(false);
    onSelectFeedback(null);
    navigate("/admin/user-feedback", { replace: true });
  }, [onSelectFeedback, navigate]);

  const handleSaveReview = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.setFeedbackDisposition(
        selectedFeedback.feedback.FeedbackId,
        {
          reviewStatus,
          disposition,
          owner,
          resolutionNote,
          adminNotes,
        }
      );
      await onLoadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await onFeedbackUpdated();
      addNotification("success", "Review saved.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not save review.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveAndNext = async () => {
    await handleSaveReview();
    const currentIndex = feedbackItems.findIndex(
      (i) => i.feedbackId === selectedFeedback?.feedback?.FeedbackId
    );
    const nextUnreviewed = feedbackItems.find(
      (item, idx) => idx > currentIndex && item.feedbackKind !== "helpful" && item.reviewStatus === "new"
    );
    if (nextUnreviewed) {
      await handleOpenDetail(nextUnreviewed.feedbackId);
    } else {
      addNotification("info", "No more items to review.");
    }
  };

  const handleReanalyze = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.analyzeFeedback(selectedFeedback.feedback.FeedbackId);
      await onLoadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await onFeedbackUpdated();
      addNotification("success", "AI analysis complete.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not rerun analysis.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAddToTestLibrary = async (item: FeedbackItem) => {
    if (!apiClient) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.promoteToCandidate(item.feedbackId);
      await onFeedbackUpdated();
      addNotification("success", "Added to test library.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not add to test library.");
    } finally {
      setActionLoading(false);
      setConfirmDialog({ open: false, item: null, action: "test_library" });
    }
  };

  const handleQuickFixPrompt = (item: FeedbackItem) => {
    handleOpenDetail(item.feedbackId);
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
      addNotification("success", "Feedback deleted.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not delete feedback.");
    } finally {
      setActionLoading(false);
      setDeleteDialog({ open: false, feedbackId: "", question: "" });
    }
  };

  const openConfirmDialog = (item: FeedbackItem, action: "test_library" | "fix_prompt", e: React.MouseEvent) => {
    e.stopPropagation();
    if (action === "fix_prompt") {
      handleQuickFixPrompt(item);
      return;
    }
    setConfirmDialog({ open: true, item, action });
  };

  useEffect(() => {
    if (selectedFeedback && !detailOpen) {
      setDetailOpen(true);
    }
  }, [detailOpen, selectedFeedback]);

  if (loading && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  const isPositive = (item: FeedbackItem) => item.feedbackKind === "helpful";

  return (
    <Stack spacing={1.5}>
      {(loading || actionLoading) && <LinearProgress sx={{ borderRadius: 1 }} />}

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack spacing={1.25}>
          <Stack direction={{ xs: "column", xl: "row" }} gap={1} alignItems={{ xl: "center" }}>
            <TextField
              size="small"
              label="Search queue"
              value={filters.search}
              onChange={(e) => updateFilter("search", e.target.value)}
              sx={{ flex: 1, minWidth: { xs: "100%", xl: 280 } }}
              inputProps={{ "aria-label": "Search the feedback queue" }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <TextField
              select
              size="small"
              label="Feedback"
              value={filters.feedbackKind}
              onChange={(e) => updateFilter("feedbackKind", e.target.value)}
              sx={{ minWidth: 150 }}
              inputProps={{ "aria-label": "Filter by feedback type" }}
            >
              <MenuItem value="">All signals</MenuItem>
              <MenuItem value="not_helpful">Needs attention</MenuItem>
              <MenuItem value="helpful">Helpful</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label="Status"
              value={filters.reviewStatus}
              onChange={(e) => updateFilter("reviewStatus", e.target.value)}
              sx={{ minWidth: 150 }}
              inputProps={{ "aria-label": "Filter by review status" }}
            >
              <MenuItem value="">Any status</MenuItem>
              <MenuItem value="new">New</MenuItem>
              <MenuItem value="analyzed">AI analyzed</MenuItem>
              <MenuItem value="in_review">Reviewing</MenuItem>
              <MenuItem value="actioned">Resolved</MenuItem>
              <MenuItem value="dismissed">Dismissed</MenuItem>
            </TextField>
            <TextField
              select
              size="small"
              label="Root cause"
              value={filters.rootCause}
              onChange={(e) => updateFilter("rootCause", e.target.value)}
              sx={{ minWidth: 170 }}
              inputProps={{ "aria-label": "Filter by likely root cause" }}
            >
              <MenuItem value="">All causes</MenuItem>
              {rootCauseOptions.map((rootCause) => (
                <MenuItem key={rootCause} value={rootCause}>
                  {label(rootCause)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Stack direction={{ xs: "column", lg: "row" }} gap={1} alignItems={{ lg: "flex-start" }}>
            <TextField
              select
              size="small"
              label="Action"
              value={filters.disposition}
              onChange={(e) => updateFilter("disposition", e.target.value)}
              sx={{ minWidth: 170 }}
              inputProps={{ "aria-label": "Filter by disposition" }}
            >
              <MenuItem value="">Any action</MenuItem>
              {DISPOSITIONS.map((option) => (
                <MenuItem key={option} value={option}>
                  {label(option)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              size="small"
              label="From"
              type="date"
              value={filters.dateFrom}
              onChange={(e) => updateFilter("dateFrom", e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ width: 160 }}
              inputProps={{ "aria-label": "From date", max: filters.dateTo || undefined }}
              helperText=" "
              FormHelperTextProps={{ sx: { minHeight: 20 } }}
            />
            <TextField
              size="small"
              label="To"
              type="date"
              value={filters.dateTo}
              onChange={(e) => updateFilter("dateTo", e.target.value)}
              InputLabelProps={{ shrink: true }}
              sx={{ width: 160 }}
              inputProps={{ "aria-label": "To date", min: filters.dateFrom || undefined }}
              helperText={filters.dateFrom ? "Inclusive range" : " "}
              FormHelperTextProps={{ sx: { minHeight: 20 } }}
            />
            {hasActiveFilters && (
              <Chip
                label="Clear filters"
                size="small"
                variant="outlined"
                onDelete={clearFilters}
                onClick={clearFilters}
                sx={{ fontSize: "0.75rem", height: 28 }}
              />
            )}
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Refresh queue and analytics">
              <IconButton
                onClick={onRefresh}
                disabled={loading}
                size="small"
                aria-label="Refresh"
                sx={{ "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
            <Chip size="small" label={`${queueStats.shown} shown`} sx={{ height: 24, fontSize: "0.75rem" }} />
            <Chip size="small" color="warning" variant="outlined" label={`${queueStats.needsReview} need review`} sx={{ height: 24, fontSize: "0.75rem" }} />
            <Chip size="small" color="success" variant="outlined" label={`${queueStats.resolved} resolved`} sx={{ height: 24, fontSize: "0.75rem" }} />
            <Chip size="small" color="primary" variant="outlined" label={`${queueStats.positive} helpful`} sx={{ height: 24, fontSize: "0.75rem" }} />
          </Stack>
        </Stack>
      </Paper>

      {feedbackItems.length === 0 ? (
        hasActiveFilters ? <FilteredEmptyInbox /> : <EmptyInbox />
      ) : (
        <Stack spacing={1.25} sx={{ maxWidth: 900 }} role="list" aria-label="Feedback items">
          {pagedItems.map((item) => {
            const positive = isPositive(item);
            const isActive = selectedFeedback?.feedback?.FeedbackId === item.feedbackId;
            const sourceSummary = summarizeSources(item);
            const rootCauseKey = item.rootCause || (positive ? "positive_signal" : "needs_human_review");
            const rootCauseChip = ROOT_CAUSE_CHIPS[rootCauseKey];

            return (
              <Paper
                key={item.feedbackId}
                variant="outlined"
                role="listitem"
                tabIndex={0}
                onClick={() => handleOpenDetail(item.feedbackId)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleOpenDetail(item.feedbackId);
                  }
                }}
                aria-selected={isActive}
                sx={{
                  cursor: "pointer",
                  borderLeft: "3px solid",
                  borderLeftColor: positive ? "primary.main" : "warning.main",
                  transition: "box-shadow 150ms ease, background-color 150ms ease",
                  ...(isActive && { bgcolor: "action.selected" }),
                  "&:hover": {
                    boxShadow: "0 4px 12px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.04)",
                  },
                }}
              >
                <Stack sx={{ p: 2, gap: 1.25 }}>
                  {/* Top bar: signal, status, date */}
                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                    <Tooltip title={positive ? "Helpful feedback" : "Feedback that needs review"}>
                      <Stack direction="row" alignItems="center" gap={0.75}>
                        {positive ? (
                          <ThumbUpOutlinedIcon sx={{ fontSize: 18, color: "primary.main" }} aria-label="Helpful" />
                        ) : (
                          <ThumbDownOutlinedIcon sx={{ fontSize: 18, color: "warning.dark" }} aria-label="Needs attention" />
                        )}
                        <Typography variant="body2" sx={{ fontSize: "0.8125rem", fontWeight: 600 }}>
                          {label(item.feedbackKind || "not_helpful")}
                        </Typography>
                      </Stack>
                    </Tooltip>
                    <Chip
                      size="small"
                      label={label(item.reviewStatus || "new")}
                      color={getReviewStatusColor(item.reviewStatus)}
                      variant={item.reviewStatus === "actioned" || item.reviewStatus === "dismissed" ? "filled" : "outlined"}
                      sx={{ height: 22, fontSize: "0.7rem" }}
                    />
                    <Box sx={{ flex: 1 }} />
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                      {formatDate(item.createdAt)}
                    </Typography>
                  </Stack>

                  {/* User question */}
                  <Box sx={{ maxHeight: 48, overflow: "hidden" }}>
                    <AdminMarkdown
                      content={item.userPromptPreview || "No question preview captured."}
                      compact
                      sx={{ fontWeight: 600, fontSize: "0.875rem" }}
                    />
                  </Box>

                  {/* ABE answer preview */}
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{
                      fontSize: "0.8125rem",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {item.answerPreview || "No answer preview captured."}
                  </Typography>

                  {/* Root cause + recurrence chips + analysis summary */}
                  <Stack direction="row" gap={0.75} flexWrap="wrap" alignItems="center">
                    <Chip
                      size="small"
                      label={rootCauseChip ? rootCauseChip.label : label(rootCauseKey)}
                      color={rootCauseChip?.color || "default"}
                      variant="outlined"
                      sx={{ height: 22, fontSize: "0.7rem" }}
                    />
                    {item.recurrenceCount && item.recurrenceCount > 1 && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`Seen ${item.recurrenceCount}x`}
                        sx={{ height: 22, fontSize: "0.7rem" }}
                      />
                    )}
                  </Stack>
                  {item.summary && (
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{
                        fontSize: "0.8125rem",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {item.summary}
                    </Typography>
                  )}

                  {/* Footer: sources, disposition, actions */}
                  <Divider sx={{ mt: 0.25 }} />
                  <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{
                        fontSize: "0.75rem",
                        maxWidth: 260,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={sourceSummary.primary}
                    >
                      {sourceSummary.primary}
                    </Typography>
                    {sourceSummary.secondary && sourceSummary.primary !== "No source documents captured" && (
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.7rem" }}>
                        {sourceSummary.secondary}
                      </Typography>
                    )}
                    {!positive && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={label(item.disposition || "pending")}
                        sx={{ height: 20, fontSize: "0.675rem" }}
                      />
                    )}
                    <Box sx={{ flex: 1 }} />
                    <Stack direction="row" gap={0.5} alignItems="center" onClick={(e) => e.stopPropagation()}>
                      {positive ? (
                        <Button
                          size="small"
                          variant="outlined"
                          color="primary"
                          onClick={(e) => openConfirmDialog(item, "test_library", e)}
                          disabled={actionLoading}
                          sx={{ fontSize: "0.75rem", textTransform: "none", whiteSpace: "nowrap", py: 0.25 }}
                        >
                          Add to tests
                        </Button>
                      ) : (
                        <Button
                          size="small"
                          variant="outlined"
                          color="warning"
                          onClick={(e) => openConfirmDialog(item, "fix_prompt", e)}
                          sx={{ fontSize: "0.75rem", textTransform: "none", whiteSpace: "nowrap", py: 0.25 }}
                        >
                          Review
                        </Button>
                      )}
                      <Tooltip title="Delete">
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteDialog({
                              open: true,
                              feedbackId: item.feedbackId,
                              question: item.userPromptPreview || "this item",
                            });
                          }}
                          aria-label="Delete feedback"
                          sx={{ color: "text.secondary", "&:hover": { color: "error.main" } }}
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Stack>
                  </Stack>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Pagination */}
      {totalPages > 1 && feedbackItems.length > 0 && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ maxWidth: 900, pt: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
            {feedbackItems.length} items &middot; Page {page + 1} of {totalPages}
          </Typography>
          <Stack direction="row" gap={0.5}>
            <IconButton
              size="small"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Previous page"
            >
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

      {/* Confirm "Add to test library" dialog */}
      <Dialog
        open={confirmDialog.open && confirmDialog.action === "test_library"}
        onClose={() => setConfirmDialog({ open: false, item: null, action: "test_library" })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>
          Add to test library?
        </DialogTitle>
        <DialogContent>
          {confirmDialog.item && (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                  Question
                </Typography>
                <AdminMarkdown content={confirmDialog.item.userPromptPreview || "N/A"} sx={{ mt: 0.5 }} />
              </Box>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                  ABE's Answer
                </Typography>
                <AdminMarkdown content={confirmDialog.item.answerPreview || "N/A"} maxHeight={200} sx={{ mt: 0.5 }} />
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8125rem" }}>
                This Q&A pair will be saved to the test library as a reference for future evaluations.
              </Typography>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setConfirmDialog({ open: false, item: null, action: "test_library" })}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="primary"
            onClick={() => confirmDialog.item && handleAddToTestLibrary(confirmDialog.item)}
            disabled={actionLoading}
            sx={{ textTransform: "none" }}
          >
            Confirm
          </Button>
        </DialogActions>
      </Dialog>

      {/* Detail slide-out drawer (negative feedback review) */}
      <Drawer
        anchor="right"
        open={detailOpen && selectedFeedback != null}
        onClose={handleCloseDetail}
        PaperProps={{
          sx: { width: { xs: "100%", md: 520 }, p: 0 },
          role: "complementary",
          "aria-label": "Feedback detail panel",
        }}
      >
        {selectedFeedback && (
          <Box sx={{ height: "100%", display: "flex", flexDirection: "column" }}>
            {/* Header */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 2, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}
            >
              <Stack direction="row" gap={1} alignItems="center">
                {selectedFeedback.feedback?.FeedbackKind === "helpful" ? (
                  <ThumbUpOutlinedIcon sx={{ fontSize: 20, color: "primary.main" }} aria-hidden="true" />
                ) : (
                  <ThumbDownOutlinedIcon sx={{ fontSize: 20, color: "warning.dark" }} aria-hidden="true" />
                )}
                <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
                  Feedback Detail
                </Typography>
              </Stack>
              <IconButton size="small" onClick={handleCloseDetail} aria-label="Close detail panel">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            {/* Scrollable content */}
            <Box sx={{ flex: 1, overflow: "auto", px: 2.5, py: 2 }}>
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    User Question
                  </Typography>
                  <AdminMarkdown
                    content={
                      selectedFeedback.trace?.UserPrompt ||
                      selectedFeedback.feedback?.UserPromptPreview ||
                      "N/A"
                    }
                    sx={{ mt: 0.5 }}
                  />
                </Box>

                <Divider />

                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    ABE's Answer
                  </Typography>
                  <AdminMarkdown
                    content={
                      selectedFeedback.trace?.FinalAnswer ||
                      selectedFeedback.feedback?.AnswerPreview ||
                      "N/A"
                    }
                    maxHeight={240}
                    sx={{ mt: 0.5 }}
                  />
                </Box>

                {/* User's feedback details */}
                {(selectedFeedback.feedback?.UserComment ||
                  selectedFeedback.feedback?.WrongSnippet ||
                  selectedFeedback.feedback?.ExpectedAnswer) && (
                  <>
                    <Divider />
                    {selectedFeedback.feedback?.WrongSnippet && (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "error.50", borderColor: "error.200" }}>
                        <Typography variant="overline" color="error.dark" sx={{ fontSize: "0.6875rem" }}>
                          What was wrong
                        </Typography>
                        <AdminMarkdown content={selectedFeedback.feedback.WrongSnippet} compact sx={{ mt: 0.5 }} />
                      </Paper>
                    )}
                    {selectedFeedback.feedback?.ExpectedAnswer && (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "success.50", borderColor: "success.200" }}>
                        <Typography variant="overline" color="success.dark" sx={{ fontSize: "0.6875rem" }}>
                          What user expected
                        </Typography>
                        <AdminMarkdown content={selectedFeedback.feedback.ExpectedAnswer} compact sx={{ mt: 0.5 }} />
                      </Paper>
                    )}
                    {selectedFeedback.feedback?.UserComment && (
                      <Box>
                        <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                          User comment
                        </Typography>
                        <AdminMarkdown content={selectedFeedback.feedback.UserComment} compact sx={{ mt: 0.5 }} />
                      </Box>
                    )}
                  </>
                )}

                {/* AI Analysis (only for negative) */}
                {selectedFeedback.feedback?.FeedbackKind !== "helpful" && selectedFeedback.feedback?.Analysis?.summary && (
                  <>
                    <Divider />
                    <Paper variant="outlined" sx={{ p: 2 }}>
                      <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                        AI Analysis
                      </Typography>
                      <AdminMarkdown content={selectedFeedback.feedback.Analysis.summary} compact sx={{ mt: 0.5, mb: 1.5 }} />
                      <Stack direction="row" gap={0.75} flexWrap="wrap">
                        {(() => {
                          const rc = selectedFeedback.feedback?.Analysis?.likelyRootCause || "";
                          const chipInfo = ROOT_CAUSE_CHIPS[rc];
                          return chipInfo ? (
                            <Chip size="small" label={chipInfo.label} color={chipInfo.color} sx={{ height: 24, fontSize: "0.75rem" }} />
                          ) : rc ? (
                            <Chip size="small" label={label(rc)} sx={{ height: 24, fontSize: "0.75rem" }} />
                          ) : null;
                        })()}
                        {selectedFeedback.feedback?.Analysis?.confidence != null && (
                          <Chip
                            size="small"
                            label={`${Math.round((selectedFeedback.feedback.Analysis.confidence ?? 0) * 100)}% confidence`}
                            variant="outlined"
                            sx={{ height: 24, fontSize: "0.75rem" }}
                          />
                        )}
                      </Stack>
                    </Paper>
                  </>
                )}

                <Divider />

                {/* Admin review */}
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                  Your Review
                </Typography>
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Status"
                  value={reviewStatus}
                  onChange={(e) => setReviewStatus(e.target.value)}
                  inputProps={{ "aria-label": "Review status" }}
                >
                  <MenuItem value="new">New</MenuItem>
                  <MenuItem value="in_review">Reviewing</MenuItem>
                  <MenuItem value="actioned">Resolved</MenuItem>
                  <MenuItem value="dismissed">Dismissed</MenuItem>
                </TextField>
                {selectedFeedback.feedback?.FeedbackKind !== "helpful" && (
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Action needed"
                    value={disposition}
                    onChange={(e) => setDisposition(e.target.value)}
                    inputProps={{ "aria-label": "Disposition" }}
                  >
                    {DISPOSITIONS.map((option) => (
                      <MenuItem key={option} value={option}>
                        {label(option)}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
                <TextField
                  fullWidth
                  size="small"
                  label="Internal notes"
                  multiline
                  minRows={2}
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  inputProps={{ "aria-label": "Admin notes" }}
                />

                {/* Metadata */}
                <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                  Submitted {formatDate(selectedFeedback.feedback?.CreatedAt)}
                  {selectedFeedback.feedback?.PromptVersionId && ` · Prompt: ${selectedFeedback.feedback.PromptVersionId}`}
                </Typography>
              </Stack>
            </Box>

            {/* Action bar */}
            <Stack
              direction="row"
              gap={1}
              sx={{
                px: 2.5,
                py: 1.5,
                borderTop: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
                flexShrink: 0,
              }}
            >
              {selectedFeedback.feedback?.FeedbackKind === "helpful" ? (
                <Button
                  variant="contained"
                  size="small"
                  color="primary"
                  onClick={() => {
                    const item = feedbackItems.find(
                      (i) => i.feedbackId === selectedFeedback.feedback?.FeedbackId
                    );
                    if (item) setConfirmDialog({ open: true, item, action: "test_library" });
                  }}
                  disabled={actionLoading}
                  sx={{ fontSize: "0.8125rem", textTransform: "none" }}
                >
                  Add to test library
                </Button>
              ) : (
                <>
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleSaveAndNext}
                    disabled={actionLoading}
                    endIcon={<SkipNextIcon />}
                    sx={{ fontSize: "0.8125rem", textTransform: "none" }}
                  >
                    Save & next
                  </Button>
                  <Button
                    size="small"
                    onClick={handleSaveReview}
                    disabled={actionLoading}
                    sx={{ fontSize: "0.8125rem", textTransform: "none" }}
                  >
                    Save
                  </Button>
                  <Button
                    size="small"
                    onClick={handleReanalyze}
                    disabled={actionLoading}
                    sx={{ fontSize: "0.8125rem", textTransform: "none" }}
                  >
                    Re-analyze
                  </Button>
                </>
              )}
              <Tooltip title="Delete this feedback">
                <IconButton
                  size="small"
                  onClick={() => {
                    if (selectedFeedback?.feedback?.FeedbackId) {
                      setDeleteDialog({
                        open: true,
                        feedbackId: selectedFeedback.feedback.FeedbackId,
                        question: selectedFeedback.feedback.UserPromptPreview || "this item",
                      });
                    }
                  }}
                  disabled={actionLoading}
                  aria-label="Delete feedback"
                  sx={{ ml: "auto", color: "text.secondary", "&:hover": { color: "error.main" } }}
                >
                  <DeleteOutlineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
          </Box>
        )}
      </Drawer>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={() => setDeleteDialog({ open: false, feedbackId: "", question: "" })}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>
          Delete feedback?
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ fontSize: "0.875rem" }}>
            This will permanently remove the feedback for:
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, mt: 1, fontSize: "0.875rem" }}>
            "{deleteDialog.question}"
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, fontSize: "0.8125rem" }}>
            This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button
            onClick={() => setDeleteDialog({ open: false, feedbackId: "", question: "" })}
            sx={{ textTransform: "none" }}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            onClick={handleDeleteFeedback}
            disabled={actionLoading}
            sx={{ textTransform: "none" }}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
