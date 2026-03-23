import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link as RouterLink, useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  Collapse,
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
  MenuItem,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { alpha } from "@mui/material/styles";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
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


/** Short label for dense card footers; full id in tooltip */
function promptVersionFootnote(id?: string): string {
  if (!id) return "";
  const trimmed = id.replace(/^v-?/i, "");
  if (trimmed.length <= 22) return trimmed;
  return `${trimmed.slice(0, 10)}…${trimmed.slice(-8)}`;
}

function sourceLineForCard(item: FeedbackItem): string {
  const sources = item.sourceTitles || [];
  if (sources.length === 0) return "No sources recorded for this turn.";
  if (sources.length === 1) return sources[0];
  return `${sources[0]} and ${sources.length - 1} other source${sources.length > 2 ? "s" : ""}`;
}

function itemNeedsTriage(item: FeedbackItem): boolean {
  if (item.feedbackKind === "helpful") return false;
  if (item.reviewStatus === "actioned" || item.reviewStatus === "dismissed") return false;
  return true;
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
  const [filtersExpanded, setFiltersExpanded] = useState(true);
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const pageSize = 25;
  const totalPages = Math.ceil(feedbackItems.length / pageSize);
  const pagedItems = useMemo(
    () => feedbackItems.slice(page * pageSize, (page + 1) * pageSize),
    [feedbackItems, page]
  );
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

  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  useEffect(() => {
    if (searchDraft === filtersRef.current.search) {
      return undefined;
    }
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
      dateFrom: "",
      dateTo: "",
      search: "",
    });
    setPage(0);
  }, [onFiltersChange]);

  const hasActiveFilters = Object.values(filters).some(Boolean);
  const activeFilterCount = useMemo(
    () => Object.values(filters).filter((v) => Boolean(v)).length,
    [filters]
  );

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
      (item, idx) => idx > currentIndex && itemNeedsTriage(item)
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

  if (loadingFeedback && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  const listBusy = loadingFeedback || loadingMeta || actionLoading;

  const isPositive = (item: FeedbackItem) => item.feedbackKind === "helpful";

  return (
    <Stack spacing={1.5}>
      {listBusy && (
        <Box
          role="progressbar"
          aria-label="Loading feedback queue"
          aria-busy="true"
          sx={{ borderRadius: 1 }}
        >
          <LinearProgress sx={{ borderRadius: 1 }} />
        </Box>
      )}

      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack spacing={1.25}>
          {/* Always visible: toggle more filters, search, refresh */}
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
            <Button
              size="small"
              variant="text"
              color="inherit"
              onClick={() => setFiltersExpanded((v) => !v)}
              aria-expanded={filtersExpanded}
              aria-controls="inbox-advanced-filters"
              id="inbox-filters-toggle"
              startIcon={filtersExpanded ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
              sx={{
                textTransform: "none",
                fontWeight: 600,
                fontSize: "0.8125rem",
                color: "text.primary",
                minWidth: "auto",
                px: 0.75,
              }}
            >
              {filtersExpanded ? "Hide filters" : "More filters"}
            </Button>
            {!filtersExpanded && activeFilterCount > 0 && (
              <Chip
                size="small"
                label={`${activeFilterCount} active`}
                color="primary"
                variant="outlined"
                sx={{ height: 24, fontSize: "0.75rem" }}
              />
            )}
            {!filtersExpanded && hasActiveFilters && (
              <Chip
                label="Clear filters"
                size="small"
                variant="outlined"
                onDelete={clearFilters}
                onClick={clearFilters}
                sx={{ fontSize: "0.75rem", height: 28 }}
              />
            )}
            <TextField
              size="small"
              label="Search queue"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              sx={{ flex: 1, minWidth: { xs: "100%", sm: 200 } }}
              inputProps={{ "aria-label": "Search the feedback queue" }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <Tooltip title="Refresh queue and analytics">
              <IconButton
                onClick={onRefresh}
                disabled={listBusy}
                size="small"
                aria-label="Refresh"
                sx={{ "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } }}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          <Collapse in={filtersExpanded} id="inbox-advanced-filters" role="region" aria-labelledby="inbox-filters-toggle">
            <Stack spacing={1.25}>
              <Stack direction={{ xs: "column", xl: "row" }} gap={1} alignItems={{ xl: "center" }}>
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
                  size="small"
                  label="Issue tag"
                  value={filters.issueTag}
                  onChange={(e) => updateFilter("issueTag", e.target.value)}
                  sx={{ minWidth: 160 }}
                  inputProps={{ "aria-label": "Filter by issue tag" }}
                />
                <TextField
                  size="small"
                  label="Prompt version ID"
                  value={filters.promptVersionId}
                  onChange={(e) => updateFilter("promptVersionId", e.target.value)}
                  sx={{ minWidth: 180 }}
                  inputProps={{ "aria-label": "Filter by prompt version id" }}
                />
                <TextField
                  size="small"
                  label="Source title"
                  value={filters.sourceTitle}
                  onChange={(e) => updateFilter("sourceTitle", e.target.value)}
                  sx={{ minWidth: 200, flex: 1 }}
                  inputProps={{ "aria-label": "Filter by source document title" }}
                />
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
              </Stack>
            </Stack>
          </Collapse>

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
        <Stack spacing={2} sx={{ maxWidth: 960 }} role="list" aria-label="Feedback items">
          {pagedItems.map((item) => {
            const positive = isPositive(item);
            const isActive = selectedFeedback?.feedback?.FeedbackId === item.feedbackId;
            const rootCauseKey = item.rootCause || (positive ? "positive_signal" : "needs_human_review");
            const rootCauseChip = ROOT_CAUSE_CHIPS[rootCauseKey];
            const reviewLabel = label(item.reviewStatus || "new");
            const headline = positive ? "Good answer — save for regression tests?" : "Needs your review";
            const subhead = positive
              ? "Users marked this response as helpful."
              : `Queue status: ${reviewLabel}`;

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
                aria-selected={isActive}
                aria-current={isActive ? "true" : undefined}
                aria-label={`${headline}. ${subhead}. Submitted ${formatDate(item.createdAt)}.`}
                sx={{
                  cursor: "pointer",
                  borderRadius: 2,
                  overflow: "hidden",
                  borderLeftWidth: 4,
                  borderLeftStyle: "solid",
                  borderLeftColor: positive ? "primary.main" : "warning.main",
                  transition: "box-shadow 160ms ease, border-color 160ms ease",
                  ...(isActive && {
                    boxShadow: (t) => `0 0 0 2px ${alpha(t.palette.primary.main, 0.35)}`,
                    bgcolor: "action.selected",
                  }),
                  "&:hover": {
                    boxShadow: (t) => `0 8px 24px ${alpha(t.palette.common.black, 0.08)}`,
                  },
                }}
              >
                {/* Status strip — what to do next, not raw enum labels */}
                <Box
                  sx={{
                    px: 2,
                    py: 1.25,
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 1.5,
                    flexWrap: "wrap",
                    bgcolor: (t) =>
                      positive ? alpha(t.palette.primary.main, 0.06) : alpha(t.palette.warning.main, 0.08),
                    borderBottom: 1,
                    borderColor: "divider",
                  }}
                >
                  <Stack direction="row" alignItems="flex-start" gap={1.25} sx={{ minWidth: 0, flex: 1 }}>
                    <Box
                      sx={{
                        width: 36,
                        height: 36,
                        borderRadius: 1,
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        bgcolor: (t) =>
                          positive ? alpha(t.palette.primary.main, 0.12) : alpha(t.palette.warning.main, 0.15),
                      }}
                      aria-hidden
                    >
                      {positive ? (
                        <ThumbUpOutlinedIcon sx={{ fontSize: 20, color: "primary.main" }} />
                      ) : (
                        <ThumbDownOutlinedIcon sx={{ fontSize: 20, color: "warning.dark" }} />
                      )}
                    </Box>
                    <Stack spacing={0.25} sx={{ minWidth: 0 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700, fontSize: "1rem", lineHeight: 1.3 }}>
                        {headline}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8125rem", lineHeight: 1.45 }}>
                        {subhead}
                      </Typography>
                    </Stack>
                  </Stack>
                  <Tooltip title={`Submitted ${formatDate(item.createdAt)}`}>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ fontSize: "0.75rem", whiteSpace: "nowrap", flexShrink: 0, pt: 0.25 }}
                    >
                      {formatDate(item.createdAt)}
                    </Typography>
                  </Tooltip>
                </Box>

                {/* Conversation — primary scan target */}
                <Stack sx={{ px: 2, pt: 2, pb: 1.5 }} spacing={2} role="group" aria-label="Question and answer preview">
                  <Box>
                    <Typography
                      variant="overline"
                      sx={{
                        display: "block",
                        fontSize: "0.65rem",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        color: "text.secondary",
                        mb: 1,
                      }}
                    >
                      User asked
                    </Typography>
                    <Box
                      sx={{
                        borderRadius: 1.5,
                        px: 1.5,
                        py: 1.25,
                        bgcolor: (t) => alpha(t.palette.primary.main, 0.05),
                        border: 1,
                        borderColor: (t) => alpha(t.palette.primary.main, 0.12),
                        minHeight: 48,
                        maxHeight: 108,
                        overflow: "hidden",
                        position: "relative",
                        "&::after":
                          item.userPromptPreview && item.userPromptPreview.length > 120
                            ? {
                                content: '""',
                                position: "absolute",
                                left: 0,
                                right: 0,
                                bottom: 0,
                                height: 28,
                                background: (t) =>
                                  `linear-gradient(transparent, ${alpha(t.palette.primary.main, 0.1)})`,
                                pointerEvents: "none",
                              }
                            : undefined,
                      }}
                    >
                      <AdminMarkdown
                        content={item.userPromptPreview || "No question preview captured."}
                        compact
                        sx={{ fontWeight: 600, fontSize: "0.9375rem", lineHeight: 1.5 }}
                      />
                    </Box>
                  </Box>
                  <Box>
                    <Typography
                      variant="overline"
                      sx={{
                        display: "block",
                        fontSize: "0.65rem",
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        color: "text.secondary",
                        mb: 1,
                      }}
                    >
                      ABE answered
                    </Typography>
                    <Box
                      sx={{
                        borderRadius: 1.5,
                        pl: 1.5,
                        borderLeft: 3,
                        borderColor: "divider",
                        py: 0.25,
                        minHeight: 40,
                        maxHeight: 100,
                        overflow: "hidden",
                        position: "relative",
                        "&::after":
                          item.answerPreview && item.answerPreview.length > 140
                            ? {
                                content: '""',
                                position: "absolute",
                                left: 0,
                                right: 0,
                                bottom: 0,
                                height: 24,
                                background: (t) =>
                                  `linear-gradient(transparent, ${alpha(t.palette.background.paper, 0.97)})`,
                                pointerEvents: "none",
                              }
                            : undefined,
                      }}
                    >
                      <AdminMarkdown
                        content={item.answerPreview || "No answer preview captured."}
                        compact
                        sx={{ color: "text.secondary", fontSize: "0.875rem", lineHeight: 1.55 }}
                      />
                    </Box>
                  </Box>
                </Stack>

                {/* Classification + AI note — why this row exists */}
                <Box sx={{ px: 2, pb: 1.5 }}>
                  <Stack
                    direction="row"
                    gap={0.75}
                    flexWrap="wrap"
                    alignItems="center"
                    sx={{ mb: item.summary ? 1 : 0 }}
                    aria-label="Classification"
                  >
                    <Chip
                      size="small"
                      label={rootCauseChip ? rootCauseChip.label : label(rootCauseKey)}
                      color={rootCauseChip?.color || "default"}
                      variant="outlined"
                      sx={{ height: 26, fontSize: "0.75rem", fontWeight: 600 }}
                    />
                    {item.recurrenceCount && item.recurrenceCount > 1 && (
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`Similar reports · ${item.recurrenceCount}×`}
                        sx={{ height: 26, fontSize: "0.75rem" }}
                      />
                    )}
                    {!positive && item.disposition && item.disposition !== "pending" && (
                      <Chip
                        size="small"
                        variant="outlined"
                        color="secondary"
                        label={`Next: ${label(item.disposition)}`}
                        sx={{ height: 26, fontSize: "0.75rem" }}
                      />
                    )}
                  </Stack>
                  {item.summary && (
                    <Paper
                      variant="outlined"
                      sx={{
                        p: 1.25,
                        borderRadius: 1,
                        bgcolor: (t) => alpha(t.palette.text.primary, 0.02),
                        borderColor: (t) => alpha(t.palette.divider, 0.9),
                      }}
                    >
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: "0.65rem" }}
                      >
                        AI summary
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ fontSize: "0.8125rem", lineHeight: 1.5, mt: 0.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}
                      >
                        {item.summary}
                      </Typography>
                    </Paper>
                  )}
                </Box>

                {/* Technical context + actions — separated from narrative */}
                <Box
                  sx={{
                    px: 2,
                    py: 1.5,
                    bgcolor: (t) => alpha(t.palette.text.primary, 0.025),
                    borderTop: 1,
                    borderColor: "divider",
                  }}
                >
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={1.5}
                    alignItems={{ xs: "stretch", sm: "center" }}
                    justifyContent="space-between"
                  >
                    <Stack spacing={0.5} sx={{ minWidth: 0, flex: 1 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem", lineHeight: 1.5 }}>
                        <Box component="span" sx={{ fontWeight: 600, color: "text.primary" }}>
                          Sources:{" "}
                        </Box>
                        {sourceLineForCard(item)}
                      </Typography>
                      {item.promptVersionId && (
                        <Tooltip title={item.promptVersionId}>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ fontSize: "0.7rem", fontFamily: "ui-monospace, monospace", cursor: "help" }}
                          >
                            Prompt version · {promptVersionFootnote(item.promptVersionId)}
                          </Typography>
                        </Tooltip>
                      )}
                    </Stack>
                    <Stack
                      direction="row"
                      gap={1}
                      alignItems="center"
                      justifyContent={{ xs: "flex-end", sm: "flex-end" }}
                      flexShrink={0}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {positive ? (
                        <Button
                          size="medium"
                          variant="contained"
                          color="primary"
                          onClick={(e) => openConfirmDialog(item, "test_library", e)}
                          disabled={actionLoading}
                          sx={{ textTransform: "none", fontWeight: 600, px: 2, minHeight: 40 }}
                        >
                          Add to tests
                        </Button>
                      ) : (
                        <Button
                          size="medium"
                          variant="contained"
                          color="warning"
                          onClick={(e) => openConfirmDialog(item, "fix_prompt", e)}
                          sx={{ textTransform: "none", fontWeight: 600, px: 2, minHeight: 40 }}
                        >
                          Open review
                        </Button>
                      )}
                      <Tooltip title="Delete">
                        <IconButton
                          size="medium"
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
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Pagination */}
      {totalPages > 1 && feedbackItems.length > 0 && (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ maxWidth: 960, pt: 0.5 }}>
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
        disableRestoreFocus={false}
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
        slotProps={{
          backdrop: { "aria-hidden": true },
        }}
        PaperProps={{
          sx: { width: { xs: "100%", md: 520 }, p: 0 },
          role: "dialog",
          "aria-modal": true,
          "aria-label": "Feedback detail",
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
                  label="Owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  inputProps={{ "aria-label": "Review owner" }}
                  helperText="Who is handling this item"
                  FormHelperTextProps={{ sx: { fontSize: "0.7rem", m: 0, mt: 0.5 } }}
                />
                <TextField
                  fullWidth
                  size="small"
                  label="Resolution note"
                  multiline
                  minRows={2}
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  inputProps={{ "aria-label": "Resolution note" }}
                  helperText="Summary of what was done or decided"
                  FormHelperTextProps={{ sx: { fontSize: "0.7rem", m: 0, mt: 0.5 } }}
                />
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
                {selectedFeedback.trace?.SessionId && (
                  <Link
                    component={RouterLink}
                    to={`/chatbot/playground/${selectedFeedback.trace.SessionId}`}
                    variant="body2"
                    sx={{ fontSize: "0.8125rem" }}
                  >
                    Open chat session in Playground
                  </Link>
                )}
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
        disableRestoreFocus={false}
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
