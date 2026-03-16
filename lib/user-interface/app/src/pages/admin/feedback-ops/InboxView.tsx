import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Drawer,
  Grid,
  IconButton,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableRow,
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
import {
  FeedbackItem,
  FeedbackDetail,
  InboxFilters,
  MonitoringData,
  HealthSummary,
  formatDate,
  label,
} from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";

const ISSUE_TAG_OPTIONS = [
  "incorrect", "missing", "irrelevant", "unclear", "bad_source", "formatting", "other",
];

const ROOT_CAUSE_CHIPS: Record<string, { label: string; color: "error" | "warning" | "info" | "default" }> = {
  retrieval_gap: { label: "Missing info", color: "warning" },
  grounding_error: { label: "Wrong answer", color: "error" },
  prompt_issue: { label: "Response style", color: "info" },
  answer_quality: { label: "Low quality", color: "warning" },
  product_bug: { label: "System bug", color: "error" },
  needs_human_review: { label: "Needs review", color: "default" },
};

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
      <Skeleton variant="rounded" height={60} />
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
        Feedback from chat users will appear here once submitted. Try adjusting your filters if you expected results.
      </Typography>
    </Paper>
  );
}

function HealthCards({ health, itemCount, pendingCount }: { health: HealthSummary; itemCount: number; pendingCount: number }) {
  return (
    <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
      <Grid item xs={6} sm={3}>
        <Paper variant="outlined" sx={{ p: 1.5, borderLeft: "3px solid", borderLeftColor: "primary.main" }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, fontSize: "0.75rem" }}>
            Negative Reports
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>{itemCount}</Typography>
        </Paper>
      </Grid>
      <Grid item xs={6} sm={3}>
        <Paper
          variant="outlined"
          sx={{
            p: 1.5,
            borderLeft: "3px solid",
            borderLeftColor: pendingCount > 10 ? "error.main" : "warning.main",
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, fontSize: "0.75rem" }}>
            Needs Review
          </Typography>
          <Typography
            variant="h6"
            sx={{ fontWeight: 700 }}
            color={pendingCount > 10 ? "error.main" : "text.primary"}
          >
            {pendingCount}
          </Typography>
        </Paper>
      </Grid>
      <Grid item xs={6} sm={3}>
        <Paper
          variant="outlined"
          sx={{
            p: 1.5,
            borderLeft: "3px solid",
            borderLeftColor: health.negativeRate > 0.5 ? "error.main" : "grey.400",
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, fontSize: "0.75rem" }}>
            Negative Rate
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {Math.round(health.negativeRate * 100)}%
          </Typography>
        </Paper>
      </Grid>
      <Grid item xs={6} sm={3}>
        <Paper variant="outlined" sx={{ p: 1.5, borderLeft: "3px solid", borderLeftColor: "success.main" }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, fontSize: "0.75rem" }}>
            Current Prompt
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700, mt: 0.25 }} noWrap>
            {health.livePromptVersionId || "None"}
          </Typography>
        </Paper>
      </Grid>
    </Grid>
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
    selectedFeedbackIds,
    onSelectedFeedbackIdsChange,
  } = props;

  const navigate = useNavigate();
  const { addNotification } = useNotifications();
  const [bulkReviewStatus, setBulkReviewStatus] = useState("in_review");
  const [owner, setOwner] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [reviewDisposition, setReviewDisposition] = useState("pending");
  const [reviewStatus, setReviewStatus] = useState("new");
  const [actionLoading, setActionLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  const pageSize = 25;
  const totalPages = Math.ceil(feedbackItems.length / pageSize);
  const pagedItems = useMemo(
    () => feedbackItems.slice(page * pageSize, (page + 1) * pageSize),
    [feedbackItems, page]
  );

  const knownSourceTitles = useMemo(() => {
    const titles = new Set<string>();
    feedbackItems.forEach((item) => {
      (item.sourceTitles || []).forEach((t) => titles.add(t));
    });
    return Array.from(titles).sort();
  }, [feedbackItems]);

  // Populate review fields when selection changes
  useEffect(() => {
    if (selectedFeedback?.feedback) {
      const fb = selectedFeedback.feedback;
      setOwner(fb.Owner || "");
      setResolutionNote(fb.ResolutionNote || "");
      setAdminNotes(fb.AdminNotes || "");
      setReviewDisposition(fb.Disposition || "pending");
      setReviewStatus(fb.ReviewStatus || "new");
    } else {
      setOwner("");
      setResolutionNote("");
      setAdminNotes("");
      setReviewDisposition("pending");
      setReviewStatus("new");
    }
  }, [selectedFeedback]);

  const updateFilter = useCallback(
    (key: keyof InboxFilters, value: string) => {
      onFiltersChange({ ...filters, [key]: value });
      setPage(0);
    },
    [filters, onFiltersChange]
  );

  const clearFilters = useCallback(() => {
    onFiltersChange({
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

  const applyQuickFilter = (preset: "needs_review" | "this_week") => {
    if (preset === "needs_review") {
      onFiltersChange({ ...filters, reviewStatus: "", disposition: "pending" });
    } else if (preset === "this_week") {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      onFiltersChange({ ...filters, dateFrom: weekAgo.toISOString().split("T")[0], dateTo: "" });
    }
    setPage(0);
  };

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

  const handleApplyBulkDisposition = async () => {
    if (!apiClient || selectedFeedbackIds.length === 0) return;
    try {
      setActionLoading(true);
      await Promise.all(
        selectedFeedbackIds.map((id) =>
          apiClient.userFeedback.setFeedbackDisposition(id, {
            reviewStatus: bulkReviewStatus,
          })
        )
      );
      onSelectedFeedbackIdsChange([]);
      await onRefresh();
      addNotification("success", `Updated ${selectedFeedbackIds.length} items.`);
    } catch (error: any) {
      addNotification("error", error?.message || "Bulk update failed.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveReview = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.setFeedbackDisposition(
        selectedFeedback.feedback.FeedbackId,
        {
          reviewStatus,
          disposition: reviewDisposition,
          owner,
          resolutionNote,
          adminNotes,
        }
      );
      await onLoadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await onFeedbackUpdated();
      addNotification("success", "Review saved.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save review.");
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
      (item, idx) => idx > currentIndex && (item.disposition === "pending" || item.reviewStatus === "new")
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
    } catch (error: any) {
      addNotification("error", error?.message || "Could not rerun analysis.");
    } finally {
      setActionLoading(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedFeedbackIds.length === feedbackItems.length) {
      onSelectedFeedbackIdsChange([]);
    } else {
      onSelectedFeedbackIdsChange(feedbackItems.map((i) => i.feedbackId));
    }
  };

  // Open detail drawer if we navigated here with a feedbackId
  useEffect(() => {
    if (selectedFeedback && !detailOpen) {
      setDetailOpen(true);
    }
  }, [selectedFeedback]);

  if (loading && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  return (
    <Stack spacing={2}>
      {(loading || actionLoading) && <LinearProgress sx={{ borderRadius: 1 }} />}

      {/* Health cards */}
      {monitoring?.health && (
        <HealthCards
          health={monitoring.health}
          itemCount={feedbackItems.length}
          pendingCount={feedbackItems.filter((i) => i.disposition === "pending").length}
        />
      )}

      {/* Quick filters */}
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <Chip
          label="Needs review"
          size="small"
          variant={filters.disposition === "pending" ? "filled" : "outlined"}
          color={filters.disposition === "pending" ? "warning" : "default"}
          onClick={() => applyQuickFilter("needs_review")}
          sx={{ fontSize: "0.75rem", height: 28, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 1 } }}
        />
        <Chip
          label="This week"
          size="small"
          variant={filters.dateFrom ? "filled" : "outlined"}
          color={filters.dateFrom ? "primary" : "default"}
          onClick={() => applyQuickFilter("this_week")}
          sx={{ fontSize: "0.75rem", height: 28, "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 1 } }}
        />
        {hasActiveFilters && (
          <Chip
            label="Clear all"
            size="small"
            variant="outlined"
            onDelete={clearFilters}
            onClick={clearFilters}
            sx={{ fontSize: "0.75rem", height: 28 }}
          />
        )}
      </Stack>

      {/* Filters */}
      <Paper variant="outlined" sx={{ p: 1.5 }}>
        <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
          <TextField
            select
            size="small"
            label="Status"
            value={filters.reviewStatus}
            onChange={(e) => updateFilter("reviewStatus", e.target.value)}
            sx={{ minWidth: 130 }}
            inputProps={{ "aria-label": "Filter by review status" }}
          >
            <MenuItem value="">Any</MenuItem>
            <MenuItem value="new">New</MenuItem>
            <MenuItem value="in_review">Reviewing</MenuItem>
            <MenuItem value="actioned">Resolved</MenuItem>
            <MenuItem value="dismissed">Dismissed</MenuItem>
          </TextField>
          <TextField
            select
            size="small"
            label="Issue type"
            value={filters.issueTag}
            onChange={(e) => updateFilter("issueTag", e.target.value)}
            sx={{ minWidth: 130 }}
            inputProps={{ "aria-label": "Filter by issue type" }}
          >
            <MenuItem value="">Any</MenuItem>
            {ISSUE_TAG_OPTIONS.map((tag) => (
              <MenuItem key={tag} value={tag}>{label(tag)}</MenuItem>
            ))}
          </TextField>
          {knownSourceTitles.length > 0 && (
            <TextField
              select
              size="small"
              label="Source document"
              value={filters.sourceTitle}
              onChange={(e) => updateFilter("sourceTitle", e.target.value)}
              sx={{ minWidth: 160, maxWidth: 220 }}
              inputProps={{ "aria-label": "Filter by source document" }}
            >
              <MenuItem value="">Any</MenuItem>
              {knownSourceTitles.map((t) => (
                <MenuItem key={t} value={t}>{t}</MenuItem>
              ))}
            </TextField>
          )}
          <TextField
            size="small"
            label="From"
            type="date"
            value={filters.dateFrom}
            onChange={(e) => updateFilter("dateFrom", e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ width: 150 }}
            inputProps={{ "aria-label": "Filter from date" }}
          />
          <TextField
            size="small"
            label="To"
            type="date"
            value={filters.dateTo}
            onChange={(e) => updateFilter("dateTo", e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ width: 150 }}
            inputProps={{ "aria-label": "Filter to date" }}
          />
          <Tooltip title="Refresh">
            <IconButton
              onClick={onRefresh}
              disabled={loading}
              size="small"
              aria-label="Refresh feedback list"
              sx={{ "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>

        {/* Bulk actions bar */}
        {selectedFeedbackIds.length > 0 && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
              <Chip
                label={`${selectedFeedbackIds.length} selected`}
                color="primary"
                size="small"
                sx={{ fontWeight: 600, fontSize: "0.75rem", height: 26 }}
              />
              <Typography variant="body2" sx={{ fontSize: "0.8125rem" }}>Mark as:</Typography>
              <Select
                size="small"
                value={bulkReviewStatus}
                onChange={(e) => setBulkReviewStatus(e.target.value)}
                sx={{ minWidth: 130 }}
                aria-label="Bulk review status"
              >
                <MenuItem value="in_review">Reviewing</MenuItem>
                <MenuItem value="actioned">Resolved</MenuItem>
                <MenuItem value="dismissed">Dismissed</MenuItem>
              </Select>
              <Button
                variant="contained"
                size="small"
                onClick={handleApplyBulkDisposition}
                disabled={actionLoading}
                sx={{ fontSize: "0.8125rem" }}
              >
                Apply
              </Button>
              <Button
                size="small"
                onClick={() => onSelectedFeedbackIdsChange([])}
                sx={{ fontSize: "0.8125rem" }}
              >
                Deselect all
              </Button>
            </Stack>
          </>
        )}
      </Paper>

      {feedbackItems.length === 0 ? (
        <EmptyInbox />
      ) : (
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          <Table size="small" aria-label="Feedback items">
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox" scope="col">
                  <Checkbox
                    indeterminate={
                      selectedFeedbackIds.length > 0 &&
                      selectedFeedbackIds.length < feedbackItems.length
                    }
                    checked={selectedFeedbackIds.length === feedbackItems.length && feedbackItems.length > 0}
                    onChange={toggleSelectAll}
                    aria-label="Select all feedback items"
                  />
                </TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Status</TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Date</TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Question</TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Issues</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pagedItems.map((item) => {
                const isSelected = selectedFeedback?.feedback?.FeedbackId === item.feedbackId;
                return (
                  <TableRow
                    key={item.feedbackId}
                    hover
                    selected={isSelected}
                    onClick={() => handleOpenDetail(item.feedbackId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleOpenDetail(item.feedbackId);
                      }
                    }}
                    tabIndex={0}
                    sx={{ cursor: "pointer" }}
                    role="row"
                    aria-selected={isSelected}
                  >
                    <TableCell
                      padding="checkbox"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        checked={selectedFeedbackIds.includes(item.feedbackId)}
                        onChange={(e) => {
                          onSelectedFeedbackIdsChange(
                            e.target.checked
                              ? [...selectedFeedbackIds, item.feedbackId]
                              : selectedFeedbackIds.filter((id) => id !== item.feedbackId)
                          );
                        }}
                        aria-label={`Select feedback from ${formatDate(item.createdAt)}`}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={label(item.reviewStatus || "new")}
                        color={
                          item.reviewStatus === "actioned" ? "success"
                            : item.reviewStatus === "dismissed" ? "default"
                              : item.reviewStatus === "in_review" ? "info"
                                : "warning"
                        }
                        variant={item.reviewStatus === "actioned" || item.reviewStatus === "dismissed" ? "filled" : "outlined"}
                        sx={{ height: 24, fontSize: "0.75rem" }}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.8125rem" }}>
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.8125rem" }} noWrap title={item.userPromptPreview}>
                        {item.userPromptPreview || "No preview"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", maxWidth: 320, fontSize: "0.75rem" }}>
                        {item.summary || item.answerPreview}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" gap={0.5} flexWrap="wrap">
                        {(item.issueTags || []).slice(0, 2).map((tag) => (
                          <Chip key={tag} size="small" label={label(tag)} variant="outlined" sx={{ height: 22, fontSize: "0.75rem" }} />
                        ))}
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {totalPages > 1 && (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={5}>
                    <Stack direction="row" justifyContent="space-between" alignItems="center">
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                        {feedbackItems.length} items — Page {page + 1} of {totalPages}
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
                  </TableCell>
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </Paper>
      )}

      {/* Detail slide-out drawer */}
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
            {/* Detail header */}
            <Stack
              direction="row"
              justifyContent="space-between"
              alignItems="center"
              sx={{ px: 2.5, py: 2, borderBottom: "1px solid", borderColor: "divider", flexShrink: 0 }}
            >
              <Stack direction="row" gap={1} alignItems="center">
                <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
                  Feedback Detail
                </Typography>
                <Chip
                  size="small"
                  label={label(selectedFeedback.feedback?.ReviewStatus || "new")}
                  color={
                    selectedFeedback.feedback?.ReviewStatus === "actioned" ? "success"
                      : selectedFeedback.feedback?.ReviewStatus === "dismissed" ? "default"
                        : selectedFeedback.feedback?.ReviewStatus === "in_review" ? "info"
                          : "warning"
                  }
                  variant={selectedFeedback.feedback?.ReviewStatus === "actioned" || selectedFeedback.feedback?.ReviewStatus === "dismissed" ? "filled" : "outlined"}
                  sx={{ height: 24, fontSize: "0.75rem" }}
                />
              </Stack>
              <IconButton size="small" onClick={handleCloseDetail} aria-label="Close detail panel">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Stack>

            {/* Scrollable content */}
            <Box sx={{ flex: 1, overflow: "auto", px: 2.5, py: 2 }}>
              <Stack spacing={2.5}>
                {/* User Question */}
                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    User Question
                  </Typography>
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.5, fontSize: "0.875rem" }}>
                    {selectedFeedback.trace?.UserPrompt ||
                      selectedFeedback.feedback?.UserPromptPreview ||
                      "N/A"}
                  </Typography>
                </Box>

                <Divider />

                {/* ABE's Answer */}
                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    ABE's Answer
                  </Typography>
                  <Typography
                    variant="body2"
                    sx={{ whiteSpace: "pre-wrap", mt: 0.5, maxHeight: 200, overflow: "auto", fontSize: "0.875rem" }}
                  >
                    {selectedFeedback.trace?.FinalAnswer ||
                      selectedFeedback.feedback?.AnswerPreview ||
                      "N/A"}
                  </Typography>
                </Box>

                {/* User details */}
                {(selectedFeedback.feedback?.ExpectedAnswer ||
                  selectedFeedback.feedback?.WrongSnippet ||
                  selectedFeedback.feedback?.UserComment) && (
                  <>
                    <Divider />
                    {selectedFeedback.feedback?.WrongSnippet && (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "error.50", borderColor: "error.200" }}>
                        <Typography variant="overline" color="error.dark" sx={{ fontSize: "0.6875rem" }}>
                          What was wrong
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.5, fontSize: "0.8125rem" }}>
                          {selectedFeedback.feedback.WrongSnippet}
                        </Typography>
                      </Paper>
                    )}
                    {selectedFeedback.feedback?.ExpectedAnswer && (
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: "success.50", borderColor: "success.200" }}>
                        <Typography variant="overline" color="success.dark" sx={{ fontSize: "0.6875rem" }}>
                          What user expected
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.5, fontSize: "0.8125rem" }}>
                          {selectedFeedback.feedback.ExpectedAnswer}
                        </Typography>
                      </Paper>
                    )}
                    {selectedFeedback.feedback?.UserComment && (
                      <Box>
                        <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                          User comment
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.5, fontSize: "0.8125rem" }}>
                          {selectedFeedback.feedback.UserComment}
                        </Typography>
                      </Box>
                    )}
                  </>
                )}

                <Divider />

                {/* Sources */}
                <Box>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    Sources
                  </Typography>
                  <Stack direction="row" gap={0.5} flexWrap="wrap" sx={{ mt: 0.5 }}>
                    {(selectedFeedback.feedback?.SourceTitles || []).map((title) => (
                      <Chip key={title} size="small" label={title} variant="outlined" sx={{ height: 24, fontSize: "0.75rem" }} />
                    ))}
                    {(selectedFeedback.feedback?.SourceTitles || []).length === 0 && (
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>None</Typography>
                    )}
                  </Stack>
                </Box>

                <Divider />

                {/* AI Analysis */}
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                    AI Analysis
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 0.5, mb: 1.5, fontSize: "0.8125rem" }}>
                    {selectedFeedback.feedback?.Analysis?.summary || "No analysis available."}
                  </Typography>
                  <Stack direction="row" gap={0.75} flexWrap="wrap">
                    {(() => {
                      const rc = selectedFeedback.feedback?.Analysis?.likelyRootCause || "";
                      const chipInfo = ROOT_CAUSE_CHIPS[rc];
                      return chipInfo ? (
                        <Chip size="small" label={chipInfo.label} color={chipInfo.color} sx={{ height: 24, fontSize: "0.75rem" }} />
                      ) : (
                        <Chip size="small" label={label(rc) || "Unknown"} sx={{ height: 24, fontSize: "0.75rem" }} />
                      );
                    })()}
                    <Chip
                      size="small"
                      label={label(selectedFeedback.feedback?.Analysis?.recommendedAction || "pending")}
                      variant="outlined"
                      sx={{ height: 24, fontSize: "0.75rem" }}
                    />
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

                <Divider />

                {/* Admin review form */}
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
                  inputProps={{ "aria-label": "Select review status" }}
                >
                  <MenuItem value="new">New</MenuItem>
                  <MenuItem value="in_review">Reviewing</MenuItem>
                  <MenuItem value="actioned">Resolved</MenuItem>
                  <MenuItem value="dismissed">Dismissed</MenuItem>
                </TextField>
                <TextField
                  fullWidth
                  size="small"
                  label="Owner"
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                  inputProps={{ "aria-label": "Assign owner" }}
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
                />
                <TextField
                  fullWidth
                  size="small"
                  label="Admin notes"
                  multiline
                  minRows={2}
                  value={adminNotes}
                  onChange={(e) => setAdminNotes(e.target.value)}
                  inputProps={{ "aria-label": "Internal admin notes" }}
                />

                {/* Metadata */}
                <Stack spacing={0.5} sx={{ pt: 1 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    Message ID: {selectedFeedback.trace?.MessageId || selectedFeedback.feedback?.MessageId}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    Prompt: {selectedFeedback.feedback?.PromptVersionId || "unknown"}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    Submitted: {formatDate(selectedFeedback.feedback?.CreatedAt)}
                  </Typography>
                </Stack>

                {/* Similar reports */}
                {(selectedFeedback.similarReports || []).length > 0 && (
                  <>
                    <Divider />
                    <Box>
                      <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                        Similar Reports ({selectedFeedback.similarReports.length})
                      </Typography>
                      <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                        {selectedFeedback.similarReports.map((item) => (
                          <Paper
                            key={item.feedbackId}
                            variant="outlined"
                            sx={{
                              p: 1.5,
                              cursor: "pointer",
                              "&:hover": { bgcolor: "action.hover" },
                              "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main" },
                            }}
                            tabIndex={0}
                            role="button"
                            aria-label={`View similar: ${item.userPromptPreview}`}
                            onClick={() => handleOpenDetail(item.feedbackId)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                handleOpenDetail(item.feedbackId);
                              }
                            }}
                          >
                            <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.8125rem" }} noWrap>
                              {item.userPromptPreview}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                              {item.summary || item.rootCause} — {formatDate(item.createdAt)}
                            </Typography>
                          </Paper>
                        ))}
                      </Stack>
                    </Box>
                  </>
                )}
              </Stack>
            </Box>

            {/* Sticky action bar */}
            <Stack
              direction="row"
              gap={1}
              flexWrap="wrap"
              sx={{
                px: 2.5,
                py: 1.5,
                borderTop: "1px solid",
                borderColor: "divider",
                bgcolor: "background.paper",
                flexShrink: 0,
              }}
            >
              <Button
                variant="contained"
                size="small"
                onClick={handleSaveAndNext}
                disabled={actionLoading}
                endIcon={<SkipNextIcon />}
                sx={{ fontSize: "0.8125rem" }}
              >
                Save & next
              </Button>
              <Button
                size="small"
                onClick={handleSaveReview}
                disabled={actionLoading}
                sx={{ fontSize: "0.8125rem" }}
              >
                Save
              </Button>
              <Button
                size="small"
                onClick={handleReanalyze}
                disabled={actionLoading}
                sx={{ fontSize: "0.8125rem" }}
              >
                Re-analyze
              </Button>
            </Stack>
          </Box>
        )}
      </Drawer>
    </Stack>
  );
}
