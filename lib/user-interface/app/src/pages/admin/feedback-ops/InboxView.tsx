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
  LinearProgress,
  MenuItem,
  Paper,
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
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import {
  FeedbackItem,
  FeedbackDetail,
  InboxFilters,
  MonitoringData,
  formatDate,
  label,
} from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";

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

  useEffect(() => {
    if (selectedFeedback?.feedback) {
      const fb = selectedFeedback.feedback;
      setOwner(fb.Owner || "");
      setResolutionNote(fb.ResolutionNote || "");
      setAdminNotes(fb.AdminNotes || "");
      setReviewStatus(fb.ReviewStatus || "new");
    } else {
      setOwner("");
      setResolutionNote("");
      setAdminNotes("");
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
          disposition: selectedFeedback.feedback.Disposition || "pending",
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
    } catch (error: any) {
      addNotification("error", error?.message || "Could not rerun analysis.");
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
    } catch (error: any) {
      addNotification("error", error?.message || "Could not add to test library.");
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
    } catch (error: any) {
      addNotification("error", error?.message || "Could not delete feedback.");
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
  }, [selectedFeedback]);

  if (loading && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  const isPositive = (item: FeedbackItem) => item.feedbackKind === "helpful";

  return (
    <Stack spacing={1.5}>
      {(loading || actionLoading) && <LinearProgress sx={{ borderRadius: 1 }} />}

      {/* Filters - single compact row */}
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <TextField
          select
          size="small"
          label="Type"
          value={filters.disposition}
          onChange={(e) => updateFilter("disposition", e.target.value)}
          sx={{ minWidth: 120 }}
          inputProps={{ "aria-label": "Filter by feedback type" }}
        >
          <MenuItem value="">All</MenuItem>
          <MenuItem value="helpful">Positive</MenuItem>
          <MenuItem value="not_helpful">Negative</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label="Status"
          value={filters.reviewStatus}
          onChange={(e) => updateFilter("reviewStatus", e.target.value)}
          sx={{ minWidth: 120 }}
          inputProps={{ "aria-label": "Filter by status" }}
        >
          <MenuItem value="">Any</MenuItem>
          <MenuItem value="new">New</MenuItem>
          <MenuItem value="in_review">Reviewing</MenuItem>
          <MenuItem value="actioned">Resolved</MenuItem>
          <MenuItem value="dismissed">Dismissed</MenuItem>
        </TextField>
        <TextField
          size="small"
          label="From"
          type="date"
          value={filters.dateFrom}
          onChange={(e) => updateFilter("dateFrom", e.target.value)}
          InputLabelProps={{ shrink: true }}
          sx={{ width: 150 }}
          inputProps={{ "aria-label": "From date" }}
        />
        <TextField
          size="small"
          label="To"
          type="date"
          value={filters.dateTo}
          onChange={(e) => updateFilter("dateTo", e.target.value)}
          InputLabelProps={{ shrink: true }}
          sx={{ width: 150 }}
          inputProps={{ "aria-label": "To date" }}
        />
        {hasActiveFilters && (
          <Chip
            label="Clear"
            size="small"
            variant="outlined"
            onDelete={clearFilters}
            onClick={clearFilters}
            sx={{ fontSize: "0.75rem", height: 28 }}
          />
        )}
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
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

      {feedbackItems.length === 0 ? (
        <EmptyInbox />
      ) : (
        <Paper variant="outlined" sx={{ overflow: "hidden" }}>
          <Table size="small" aria-label="Feedback items">
            <TableHead>
              <TableRow sx={{ bgcolor: "grey.50" }}>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem", width: 44 }} />
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Date</TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Question</TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Status</TableCell>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem", width: 160 }} align="right">Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pagedItems.map((item) => {
                const positive = isPositive(item);
                const isActive = selectedFeedback?.feedback?.FeedbackId === item.feedbackId;
                return (
                  <TableRow
                    key={item.feedbackId}
                    hover
                    selected={isActive}
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
                    aria-selected={isActive}
                  >
                    <TableCell sx={{ px: 1.5 }}>
                      <Tooltip title={positive ? "Positive feedback" : "Negative feedback"}>
                        <Stack direction="row" alignItems="center" gap={0.5}>
                          {positive ? (
                            <ThumbUpOutlinedIcon sx={{ fontSize: 18, color: "primary.main" }} aria-label="Positive" />
                          ) : (
                            <ThumbDownOutlinedIcon sx={{ fontSize: 18, color: "warning.dark" }} aria-label="Negative" />
                          )}
                        </Stack>
                      </Tooltip>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.8125rem" }}>
                      {formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.8125rem" }} noWrap title={item.userPromptPreview}>
                        {item.userPromptPreview || "No preview"}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", maxWidth: 360, fontSize: "0.75rem" }}>
                        {item.summary || item.answerPreview}
                      </Typography>
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
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Stack direction="row" gap={0.5} justifyContent="flex-end" alignItems="center">
                        {positive ? (
                          <Button
                            size="small"
                            variant="outlined"
                            color="primary"
                            onClick={(e) => openConfirmDialog(item, "test_library", e)}
                            disabled={actionLoading}
                            sx={{ fontSize: "0.75rem", textTransform: "none", whiteSpace: "nowrap" }}
                          >
                            Add to tests
                          </Button>
                        ) : (
                          <Button
                            size="small"
                            variant="outlined"
                            color="warning"
                            onClick={(e) => openConfirmDialog(item, "fix_prompt", e)}
                            sx={{ fontSize: "0.75rem", textTransform: "none", whiteSpace: "nowrap" }}
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
                <Typography variant="body2" sx={{ mt: 0.5, fontSize: "0.875rem" }}>
                  {confirmDialog.item.userPromptPreview}
                </Typography>
              </Box>
              <Box>
                <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                  ABE's Answer
                </Typography>
                <Typography variant="body2" sx={{ mt: 0.5, fontSize: "0.875rem", maxHeight: 200, overflow: "auto" }}>
                  {confirmDialog.item.answerPreview || "N/A"}
                </Typography>
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
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mt: 0.5, fontSize: "0.875rem" }}>
                    {selectedFeedback.trace?.UserPrompt ||
                      selectedFeedback.feedback?.UserPromptPreview ||
                      "N/A"}
                  </Typography>
                </Box>

                <Divider />

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

                {/* AI Analysis (only for negative) */}
                {selectedFeedback.feedback?.FeedbackKind !== "helpful" && selectedFeedback.feedback?.Analysis?.summary && (
                  <>
                    <Divider />
                    <Paper variant="outlined" sx={{ p: 2 }}>
                      <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
                        AI Analysis
                      </Typography>
                      <Typography variant="body2" sx={{ mt: 0.5, mb: 1.5, fontSize: "0.8125rem" }}>
                        {selectedFeedback.feedback.Analysis.summary}
                      </Typography>
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
                <TextField
                  fullWidth
                  size="small"
                  label="Notes"
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
