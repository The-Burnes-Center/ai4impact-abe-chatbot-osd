import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Grid,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
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
import SearchIcon from "@mui/icons-material/Search";
import FilterAltOffIcon from "@mui/icons-material/FilterAltOff";
import InboxOutlinedIcon from "@mui/icons-material/InboxOutlined";
import {
  FeedbackItem,
  FeedbackDetail,
  InboxFilters,
  DISPOSITIONS,
  REVIEW_STATUSES,
  formatDate,
  label,
} from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";

interface InboxViewProps {
  feedbackItems: FeedbackItem[];
  selectedFeedback: FeedbackDetail | null;
  filters: InboxFilters;
  loading: boolean;
  apiClient: ApiClient | null;
  onFiltersChange: (filters: InboxFilters) => void;
  onRefresh: () => Promise<void>;
  onSelectFeedback: (detail: FeedbackDetail | null) => void;
  onLoadFeedbackDetail: (id: string) => Promise<void>;
  onFeedbackUpdated: () => Promise<void>;
  selectedFeedbackIds: string[];
  onSelectedFeedbackIdsChange: (ids: string[]) => void;
}

const ROOT_CAUSE_CHIPS: Record<string, { label: string; color: "error" | "warning" | "info" | "default" }> = {
  retrieval_gap: { label: "Missing info", color: "warning" },
  grounding_error: { label: "Wrong answer", color: "error" },
  prompt_issue: { label: "Response style", color: "info" },
  answer_quality: { label: "Low quality", color: "warning" },
  product_bug: { label: "System bug", color: "error" },
  needs_human_review: { label: "Needs review", color: "default" },
};

function InboxSkeleton() {
  return (
    <Stack spacing={2}>
      <Skeleton variant="rounded" height={80} />
      <Grid container spacing={2}>
        <Grid item xs={12} lg={6}>
          <Skeleton variant="rounded" height={400} />
        </Grid>
        <Grid item xs={12} lg={6}>
          <Skeleton variant="rounded" height={400} />
        </Grid>
      </Grid>
    </Stack>
  );
}

function EmptyInbox() {
  return (
    <Paper
      variant="outlined"
      sx={{ p: 6, textAlign: "center" }}
    >
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

export default function InboxView(props: InboxViewProps) {
  const {
    feedbackItems,
    selectedFeedback,
    filters,
    loading,
    apiClient,
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
  const [bulkDisposition, setBulkDisposition] = useState("prompt update");
  const [bulkReviewStatus, setBulkReviewStatus] = useState("in_review");
  const [owner, setOwner] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [actionLoading, setActionLoading] = useState(false);
  const [page, setPage] = useState(0);
  const pageSize = 25;
  const totalPages = Math.ceil(feedbackItems.length / pageSize);
  const pagedItems = useMemo(
    () => feedbackItems.slice(page * pageSize, (page + 1) * pageSize),
    [feedbackItems, page]
  );

  const updateFilter = useCallback(
    (key: keyof InboxFilters, value: string) => {
      onFiltersChange({ ...filters, [key]: value });
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
  }, [onFiltersChange]);

  const hasActiveFilters = Object.values(filters).some(Boolean);

  const handleApplyBulkDisposition = async () => {
    if (!apiClient || selectedFeedbackIds.length === 0) return;
    try {
      setActionLoading(true);
      await Promise.all(
        selectedFeedbackIds.map((id) =>
          apiClient.userFeedback.setFeedbackDisposition(id, {
            disposition: bulkDisposition,
            reviewStatus: bulkReviewStatus,
          })
        )
      );
      onSelectedFeedbackIdsChange([]);
      await onRefresh();
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
          reviewStatus: selectedFeedback.feedback.ReviewStatus || "in_review",
          disposition: selectedFeedback.feedback.Disposition || "pending",
          owner,
          resolutionNote,
          adminNotes,
        }
      );
      await onLoadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await onFeedbackUpdated();
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save review.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleReanalyze = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.analyzeFeedback(
        selectedFeedback.feedback.FeedbackId
      );
      await onLoadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await onFeedbackUpdated();
    } catch (error: any) {
      addNotification("error", error?.message || "Could not rerun analysis.");
    } finally {
      setActionLoading(false);
    }
  };

  const handlePromoteCandidate = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.promoteToCandidate(
        selectedFeedback.feedback.FeedbackId
      );
      await onFeedbackUpdated();
      addNotification("success", "Candidate monitoring case created.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not create candidate case.");
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

  if (loading && feedbackItems.length === 0) {
    return <InboxSkeleton />;
  }

  return (
    <Stack spacing={2}>
      {(loading || actionLoading) && <LinearProgress sx={{ borderRadius: 1 }} />}

      {/* Filters */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} gap={1.5} flexWrap="wrap" alignItems={{ md: "flex-end" }}>
          <TextField
            select
            size="small"
            label="Status"
            value={filters.reviewStatus}
            onChange={(e) => updateFilter("reviewStatus", e.target.value)}
            sx={{ minWidth: 150 }}
            InputProps={{ "aria-label": "Filter by status" } as any}
          >
            <MenuItem value="">All</MenuItem>
            {REVIEW_STATUSES.map((s) => (
              <MenuItem key={s} value={s}>{label(s)}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Action"
            value={filters.disposition}
            onChange={(e) => updateFilter("disposition", e.target.value)}
            sx={{ minWidth: 170 }}
            InputProps={{ "aria-label": "Filter by action" } as any}
          >
            <MenuItem value="">All</MenuItem>
            {DISPOSITIONS.map((d) => (
              <MenuItem key={d} value={d}>{label(d)}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Issue tag"
            value={filters.issueTag}
            onChange={(e) => updateFilter("issueTag", e.target.value)}
            sx={{ minWidth: 120 }}
          />
          <TextField
            size="small"
            label="Source title"
            value={filters.sourceTitle}
            onChange={(e) => updateFilter("sourceTitle", e.target.value)}
            sx={{ minWidth: 140 }}
          />
          <TextField
            size="small"
            label="From"
            type="date"
            value={filters.dateFrom}
            onChange={(e) => updateFilter("dateFrom", e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ minWidth: 140 }}
          />
          <TextField
            size="small"
            label="To"
            type="date"
            value={filters.dateTo}
            onChange={(e) => updateFilter("dateTo", e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ minWidth: 140 }}
          />
          <Stack direction="row" gap={0.5}>
            <Tooltip title="Refresh">
              <IconButton onClick={onRefresh} disabled={loading} aria-label="Refresh feedback list">
                <RefreshIcon />
              </IconButton>
            </Tooltip>
            {hasActiveFilters && (
              <Tooltip title="Clear all filters">
                <IconButton onClick={clearFilters} aria-label="Clear all filters">
                  <FilterAltOffIcon />
                </IconButton>
              </Tooltip>
            )}
          </Stack>
        </Stack>

        {/* Bulk actions */}
        {selectedFeedbackIds.length > 0 && (
          <>
            <Divider sx={{ my: 2 }} />
            <Stack direction={{ xs: "column", md: "row" }} gap={1.5} alignItems={{ md: "center" }}>
              <Typography variant="body2" fontWeight={600}>
                {selectedFeedbackIds.length} selected
              </Typography>
              <Select
                size="small"
                value={bulkDisposition}
                onChange={(e) => setBulkDisposition(e.target.value)}
                sx={{ minWidth: 180 }}
                aria-label="Bulk action"
              >
                {DISPOSITIONS.filter((d) => d !== "pending").map((d) => (
                  <MenuItem key={d} value={d}>{label(d)}</MenuItem>
                ))}
              </Select>
              <Select
                size="small"
                value={bulkReviewStatus}
                onChange={(e) => setBulkReviewStatus(e.target.value)}
                sx={{ minWidth: 150 }}
                aria-label="Bulk status"
              >
                {(["in_review", "actioned", "dismissed"] as const).map((s) => (
                  <MenuItem key={s} value={s}>{label(s)}</MenuItem>
                ))}
              </Select>
              <Button
                variant="contained"
                size="small"
                onClick={handleApplyBulkDisposition}
                disabled={actionLoading}
              >
                Apply to {selectedFeedbackIds.length}
              </Button>
            </Stack>
          </>
        )}
      </Paper>

      {feedbackItems.length === 0 ? (
        <EmptyInbox />
      ) : (
        <Grid container spacing={2}>
          {/* Feedback table */}
          <Grid item xs={12} lg={6}>
            <Paper variant="outlined" sx={{ overflow: "hidden" }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox">
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
                    <TableCell>When</TableCell>
                    <TableCell>Issues</TableCell>
                    <TableCell>Summary</TableCell>
                    <TableCell align="center">Count</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pagedItems.map((item) => {
                    const isSelected =
                      selectedFeedback?.feedback?.FeedbackId === item.feedbackId;
                    return (
                      <TableRow
                        key={item.feedbackId}
                        hover
                        selected={isSelected}
                        onClick={() =>
                          navigate(`/admin/user-feedback/${item.feedbackId}`)
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            navigate(`/admin/user-feedback/${item.feedbackId}`);
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
                            aria-label={`Select feedback ${item.feedbackId}`}
                          />
                        </TableCell>
                        <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.8125rem" }}>
                          {formatDate(item.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" gap={0.5} flexWrap="wrap">
                            {(item.issueTags || []).slice(0, 2).map((tag) => (
                              <Chip key={tag} size="small" label={tag} />
                            ))}
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600} noWrap sx={{ maxWidth: 200 }}>
                            {item.userPromptPreview || "No prompt preview"}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: "block", maxWidth: 200 }}>
                            {item.summary || item.answerPreview}
                          </Typography>
                        </TableCell>
                        <TableCell align="center">
                          {(item.recurrenceCount ?? 0) > 1 && (
                            <Chip size="small" label={item.recurrenceCount} color="warning" variant="outlined" />
                          )}
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
                          <Typography variant="caption" color="text.secondary">
                            {feedbackItems.length} items · Page {page + 1} of {totalPages}
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
          </Grid>

          {/* Detail pane */}
          <Grid item xs={12} lg={6}>
            <Paper variant="outlined" sx={{ p: 2, minHeight: 560 }}>
              {!selectedFeedback ? (
                <Box sx={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 400, color: "text.secondary" }}>
                  <SearchIcon sx={{ fontSize: 40, mb: 1, opacity: 0.4 }} />
                  <Typography variant="body1">Select a feedback record to review</Typography>
                  <Typography variant="caption">Click a row on the left to view details</Typography>
                </Box>
              ) : (
                <Stack spacing={2}>
                  <Stack direction="row" justifyContent="space-between" alignItems="center">
                    <Typography variant="h6">Feedback Detail</Typography>
                    <Chip
                      size="small"
                      label={label(selectedFeedback.feedback?.ReviewStatus || "new")}
                      color={
                        selectedFeedback.feedback?.ReviewStatus === "actioned"
                          ? "success"
                          : selectedFeedback.feedback?.ReviewStatus === "dismissed"
                            ? "default"
                            : "info"
                      }
                      variant="outlined"
                    />
                  </Stack>

                  {/* Q&A section */}
                  <Grid container spacing={2}>
                    <Grid item xs={12} md={6}>
                      <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
                        <Typography variant="subtitle2" gutterBottom color="text.secondary">
                          User Question
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", mb: 2 }}>
                          {selectedFeedback.trace?.UserPrompt ||
                            selectedFeedback.feedback?.UserPromptPreview ||
                            "N/A"}
                        </Typography>
                        <Divider sx={{ my: 1.5 }} />
                        <Typography variant="subtitle2" gutterBottom color="text.secondary">
                          ABE's Answer
                        </Typography>
                        <Typography
                          variant="body2"
                          sx={{ whiteSpace: "pre-wrap", maxHeight: 200, overflow: "auto" }}
                        >
                          {selectedFeedback.trace?.FinalAnswer ||
                            selectedFeedback.feedback?.AnswerPreview ||
                            "N/A"}
                        </Typography>

                        {/* Expected vs actual comparison */}
                        {selectedFeedback.feedback?.ExpectedAnswer && (
                          <>
                            <Divider sx={{ my: 1.5 }} />
                            <Typography variant="subtitle2" gutterBottom color="text.secondary">
                              What User Expected
                            </Typography>
                            <Paper
                              variant="outlined"
                              sx={{ p: 1.5, bgcolor: "rgba(46, 160, 67, 0.06)", borderColor: "rgba(46, 160, 67, 0.3)" }}
                            >
                              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                                {selectedFeedback.feedback.ExpectedAnswer}
                              </Typography>
                            </Paper>
                          </>
                        )}
                        {selectedFeedback.feedback?.WrongSnippet && (
                          <>
                            <Divider sx={{ my: 1.5 }} />
                            <Typography variant="subtitle2" gutterBottom color="text.secondary">
                              What Was Wrong
                            </Typography>
                            <Paper
                              variant="outlined"
                              sx={{ p: 1.5, bgcolor: "rgba(248, 81, 73, 0.06)", borderColor: "rgba(248, 81, 73, 0.3)" }}
                            >
                              <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                                {selectedFeedback.feedback.WrongSnippet}
                              </Typography>
                            </Paper>
                          </>
                        )}
                        {selectedFeedback.feedback?.UserComment && (
                          <>
                            <Divider sx={{ my: 1.5 }} />
                            <Typography variant="subtitle2" gutterBottom color="text.secondary">
                              User Comment
                            </Typography>
                            <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                              {selectedFeedback.feedback.UserComment}
                            </Typography>
                          </>
                        )}
                        <Divider sx={{ my: 1.5 }} />
                        <Typography variant="subtitle2" gutterBottom color="text.secondary">
                          Sources
                        </Typography>
                        <Stack direction="row" gap={0.75} flexWrap="wrap">
                          {(selectedFeedback.feedback?.SourceTitles || []).map(
                            (title) => (
                              <Chip key={title} size="small" label={title} variant="outlined" />
                            )
                          )}
                          {(selectedFeedback.feedback?.SourceTitles || []).length === 0 && (
                            <Typography variant="caption" color="text.secondary">None</Typography>
                          )}
                        </Stack>
                        <Divider sx={{ my: 1.5 }} />
                        <Stack spacing={0.5}>
                          <Typography variant="caption" color="text.secondary">
                            Message ID: {selectedFeedback.trace?.MessageId || selectedFeedback.feedback?.MessageId}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Prompt version: {selectedFeedback.feedback?.PromptVersionId || "unknown"}
                          </Typography>
                        </Stack>
                      </Paper>
                    </Grid>

                    {/* Diagnosis & actions */}
                    <Grid item xs={12} md={6}>
                      <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
                        <Typography variant="subtitle2" gutterBottom color="text.secondary">
                          AI Analysis
                        </Typography>
                        <Typography variant="body2" sx={{ mb: 1.5 }}>
                          {selectedFeedback.feedback?.Analysis?.summary || "No analysis available."}
                        </Typography>
                        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 2 }}>
                          {(() => {
                            const rc = selectedFeedback.feedback?.Analysis?.likelyRootCause || "";
                            const chipInfo = ROOT_CAUSE_CHIPS[rc];
                            return chipInfo ? (
                              <Chip size="small" label={chipInfo.label} color={chipInfo.color} />
                            ) : (
                              <Chip size="small" label={label(rc) || "unknown"} />
                            );
                          })()}
                          <Chip
                            size="small"
                            label={label(selectedFeedback.feedback?.Analysis?.recommendedAction || "pending")}
                            variant="outlined"
                          />
                          {selectedFeedback.feedback?.Analysis?.confidence != null && (
                            <Chip
                              size="small"
                              label={`${Math.round((selectedFeedback.feedback.Analysis.confidence ?? 0) * 100)}% confidence`}
                              variant="outlined"
                            />
                          )}
                        </Stack>

                        <Divider sx={{ my: 1.5 }} />

                        <TextField
                          select
                          fullWidth
                          size="small"
                          label="Action"
                          value={selectedFeedback.feedback?.Disposition || "pending"}
                          onChange={(e) =>
                            onSelectFeedback({
                              ...selectedFeedback,
                              feedback: {
                                ...selectedFeedback.feedback,
                                Disposition: e.target.value,
                              },
                            })
                          }
                        >
                          {DISPOSITIONS.map((d) => (
                            <MenuItem key={d} value={d}>{label(d)}</MenuItem>
                          ))}
                        </TextField>
                        <TextField
                          select
                          fullWidth
                          size="small"
                          label="Status"
                          sx={{ mt: 1.5 }}
                          value={selectedFeedback.feedback?.ReviewStatus || "in_review"}
                          onChange={(e) =>
                            onSelectFeedback({
                              ...selectedFeedback,
                              feedback: {
                                ...selectedFeedback.feedback,
                                ReviewStatus: e.target.value,
                              },
                            })
                          }
                        >
                          {REVIEW_STATUSES.map((s) => (
                            <MenuItem key={s} value={s}>{label(s)}</MenuItem>
                          ))}
                        </TextField>
                        <TextField
                          fullWidth
                          size="small"
                          label="Owner"
                          sx={{ mt: 1.5 }}
                          value={owner}
                          onChange={(e) => setOwner(e.target.value)}
                        />
                        <TextField
                          fullWidth
                          size="small"
                          label="Resolution note"
                          sx={{ mt: 1.5 }}
                          multiline
                          minRows={2}
                          value={resolutionNote}
                          onChange={(e) => setResolutionNote(e.target.value)}
                        />
                        <TextField
                          fullWidth
                          size="small"
                          label="Admin notes"
                          sx={{ mt: 1.5 }}
                          multiline
                          minRows={2}
                          value={adminNotes}
                          onChange={(e) => setAdminNotes(e.target.value)}
                        />
                        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2 }}>
                          <Button
                            variant="contained"
                            size="small"
                            onClick={handleSaveReview}
                            disabled={actionLoading}
                          >
                            Save review
                          </Button>
                          <Button size="small" onClick={handleReanalyze} disabled={actionLoading}>
                            Run AI analysis
                          </Button>
                          <Button size="small" onClick={handlePromoteCandidate} disabled={actionLoading}>
                            Add to watchlist
                          </Button>
                        </Stack>
                      </Paper>
                    </Grid>
                  </Grid>

                  {/* Similar reports */}
                  {(selectedFeedback.similarReports || []).length > 0 && (
                    <Paper variant="outlined" sx={{ p: 2 }}>
                      <Typography variant="subtitle2" gutterBottom>
                        Similar reports ({selectedFeedback.similarReports.length})
                      </Typography>
                      <List dense disablePadding>
                        {selectedFeedback.similarReports.map((item) => (
                          <ListItemButton
                            key={item.feedbackId}
                            onClick={() =>
                              navigate(`/admin/user-feedback/${item.feedbackId}`)
                            }
                          >
                            <ListItemText
                              primary={item.userPromptPreview}
                              secondary={`${item.summary || item.rootCause} · ${formatDate(item.createdAt)}`}
                            />
                          </ListItemButton>
                        ))}
                      </List>
                    </Paper>
                  )}
                </Stack>
              )}
            </Paper>
          </Grid>
        </Grid>
      )}
    </Stack>
  );
}
