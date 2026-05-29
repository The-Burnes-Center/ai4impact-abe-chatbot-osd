import { useEffect, useState } from "react";
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
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import ThumbUpOutlinedIcon from "@mui/icons-material/ThumbUpOutlined";
import ThumbDownOutlinedIcon from "@mui/icons-material/ThumbDownOutlined";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import {
  FeedbackDetail,
  FeedbackItem,
  REVIEW_STATUS_OPTIONS,
  feedbackStatusChip,
  formatDate,
  itemNeedsTriage,
} from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import AdminMarkdown from "../../../components/admin-markdown";
import { useNotifications } from "../../../components/notif-manager";

const ISSUE_LABELS: Record<string, { label: string; color: "error" | "warning" | "info" | "default" }> = {
  retrieval_gap: { label: "Missing info", color: "warning" },
  grounding_error: { label: "Wrong answer", color: "error" },
  prompt_issue: { label: "Response style", color: "info" },
  answer_quality: { label: "Low quality", color: "warning" },
  product_bug: { label: "System bug", color: "error" },
};

interface FeedbackDetailViewProps {
  detail: FeedbackDetail | null;
  feedbackItems: FeedbackItem[];
  apiClient: ApiClient | null;
  loading: boolean;
  onUpdated: () => Promise<void>;
  onReloadDetail: (id: string) => Promise<void>;
}

export default function FeedbackDetailView(props: FeedbackDetailViewProps) {
  const { detail, feedbackItems, apiClient, loading, onUpdated, onReloadDetail } = props;
  const navigate = useNavigate();
  const { addNotification } = useNotifications();

  const [notes, setNotes] = useState("");
  const [reviewStatus, setReviewStatus] = useState("new");
  const [actionLoading, setActionLoading] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const feedback = detail?.feedback;

  useEffect(() => {
    setNotes(feedback?.ResolutionNote || feedback?.AdminNotes || "");
    setReviewStatus(feedback?.ReviewStatus === "analyzed" ? "new" : feedback?.ReviewStatus || "new");
  }, [feedback]);

  const goBack = () => navigate("/admin/user-feedback");

  const handleSave = async () => {
    if (!apiClient || !feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.setFeedbackDisposition(feedback.FeedbackId, {
        reviewStatus,
        disposition: feedback.Disposition || "pending",
        owner: feedback.Owner || "",
        resolutionNote: notes,
        adminNotes: notes,
      });
      await onReloadDetail(feedback.FeedbackId);
      await onUpdated();
      addNotification("success", "Saved.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not save.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveAndNext = async () => {
    await handleSave();
    const currentIndex = feedbackItems.findIndex((i) => i.feedbackId === feedback?.FeedbackId);
    const next = feedbackItems.find((item, idx) => idx > currentIndex && itemNeedsTriage(item));
    if (next) {
      navigate(`/admin/user-feedback/${next.feedbackId}`);
    } else {
      addNotification("info", "That was the last item needing review.");
      goBack();
    }
  };

  const handleSummarize = async () => {
    if (!apiClient || !feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.analyzeFeedback(feedback.FeedbackId);
      await onReloadDetail(feedback.FeedbackId);
      await onUpdated();
      addNotification("success", "AI summary updated.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not generate an AI summary.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveAsExample = async () => {
    if (!apiClient || !feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.promoteToCandidate(feedback.FeedbackId);
      await onUpdated();
      addNotification("success", "Saved as a good example for quality checks.");
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not save this example.");
    } finally {
      setActionLoading(false);
      setExampleOpen(false);
    }
  };

  const handleDelete = async () => {
    if (!apiClient || !feedback?.FeedbackId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.deleteFeedback(feedback.FeedbackId);
      await onUpdated();
      addNotification("success", "Deleted.");
      goBack();
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Could not delete.");
    } finally {
      setActionLoading(false);
      setDeleteOpen(false);
    }
  };

  if (loading && !detail) {
    return (
      <Stack spacing={2}>
        <Skeleton variant="rounded" height={40} width={220} />
        <Skeleton variant="rounded" height={420} />
      </Stack>
    );
  }

  if (!feedback) {
    return (
      <Stack spacing={2} alignItems="flex-start">
        <Button onClick={goBack} startIcon={<ArrowBackIcon />} sx={{ textTransform: "none" }}>
          Back to feedback
        </Button>
        <Typography color="text.secondary">This feedback could not be loaded. It may have been deleted.</Typography>
      </Stack>
    );
  }

  const isHelpful = feedback.FeedbackKind === "helpful";
  const status = feedbackStatusChip({ feedbackKind: feedback.FeedbackKind, reviewStatus: feedback.ReviewStatus });
  const aiSummary = feedback.Analysis?.summary;
  const aiIssue = feedback.Analysis?.likelyRootCause ? ISSUE_LABELS[feedback.Analysis.likelyRootCause] : undefined;

  return (
    <Stack spacing={2}>
      {actionLoading && (
        <Box role="progressbar" aria-label="Working" aria-busy="true" sx={{ borderRadius: 1 }}>
          <LinearProgress sx={{ borderRadius: 1 }} />
        </Box>
      )}

      {/* Top bar */}
      <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
        <Button onClick={goBack} startIcon={<ArrowBackIcon />} size="small" sx={{ textTransform: "none" }}>
          Back to feedback
        </Button>
        <Stack direction="row" gap={1} alignItems="center">
          {isHelpful ? (
            <ThumbUpOutlinedIcon sx={{ fontSize: 20, color: "success.main" }} aria-hidden="true" />
          ) : (
            <ThumbDownOutlinedIcon sx={{ fontSize: 20, color: "warning.dark" }} aria-hidden="true" />
          )}
          <Typography variant="h6" sx={{ fontSize: "1.0625rem", fontWeight: 600 }}>
            {isHelpful ? "Helpful feedback" : "Feedback to review"}
          </Typography>
          <Chip size="small" color={status.color} label={status.label} sx={{ height: 22, fontSize: "0.75rem" }} />
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Delete this feedback">
          <span>
            <Button
              size="small"
              color="inherit"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => setDeleteOpen(true)}
              disabled={actionLoading}
              sx={{ textTransform: "none", color: "text.secondary", "&:hover": { color: "error.main" } }}
            >
              Delete
            </Button>
          </span>
        </Tooltip>
      </Stack>

      {/* Two columns: conversation (wide) + review (sticky) */}
      <Stack direction={{ xs: "column", md: "row" }} spacing={2.5} alignItems="flex-start">
        {/* Conversation */}
        <Stack spacing={2.5} sx={{ flex: 1, minWidth: 0, width: "100%" }}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
              What the user asked
            </Typography>
            <AdminMarkdown content={detail?.trace?.UserPrompt || feedback.UserPromptPreview || "N/A"} sx={{ mt: 0.5 }} />
          </Paper>

          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem", letterSpacing: 1 }}>
              How ABE answered
            </Typography>
            <AdminMarkdown content={detail?.trace?.FinalAnswer || feedback.AnswerPreview || "N/A"} sx={{ mt: 0.5 }} />
          </Paper>

          {(feedback.WrongSnippet || feedback.ExpectedAnswer || feedback.UserComment) && (
            <Stack spacing={1.5}>
              {feedback.WrongSnippet && (
                <Paper variant="outlined" sx={{ p: 2, bgcolor: "error.50", borderColor: "error.200" }}>
                  <Typography variant="overline" color="error.dark" sx={{ fontSize: "0.6875rem" }}>
                    What was wrong
                  </Typography>
                  <AdminMarkdown content={feedback.WrongSnippet} compact sx={{ mt: 0.5 }} />
                </Paper>
              )}
              {feedback.ExpectedAnswer && (
                <Paper variant="outlined" sx={{ p: 2, bgcolor: "success.50", borderColor: "success.200" }}>
                  <Typography variant="overline" color="success.dark" sx={{ fontSize: "0.6875rem" }}>
                    What they expected instead
                  </Typography>
                  <AdminMarkdown content={feedback.ExpectedAnswer} compact sx={{ mt: 0.5 }} />
                </Paper>
              )}
              {feedback.UserComment && (
                <Paper variant="outlined" sx={{ p: 2 }}>
                  <Typography variant="overline" color="text.secondary" sx={{ fontSize: "0.6875rem" }}>
                    Their note
                  </Typography>
                  <AdminMarkdown content={feedback.UserComment} compact sx={{ mt: 0.5 }} />
                </Paper>
              )}
            </Stack>
          )}

          {!isHelpful && (
            <Paper variant="outlined" sx={{ p: 2.5, bgcolor: (t) => alpha(t.palette.info.main, 0.05) }}>
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
                    <Chip size="small" color={aiIssue.color} label={aiIssue.label} sx={{ mt: 1, height: 24, fontSize: "0.75rem" }} />
                  )}
                </>
              ) : (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, fontSize: "0.8125rem" }}>
                  No AI summary yet. Click Generate to have AI explain what likely went wrong.
                </Typography>
              )}
            </Paper>
          )}
        </Stack>

        {/* Review (sticky on desktop) */}
        <Paper
          variant="outlined"
          sx={{
            p: 2.5,
            width: { xs: "100%", md: 360 },
            flexShrink: 0,
            position: { md: "sticky" },
            top: { md: 16 },
          }}
        >
          <Typography variant="subtitle1" sx={{ fontWeight: 600, fontSize: "0.9375rem", mb: 1.5 }}>
            Your review
          </Typography>

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
            sx={{ mt: 0.75, mb: 2, flexWrap: "wrap" }}
          >
            {REVIEW_STATUS_OPTIONS.map((option) => (
              <ToggleButton key={option.value} value={option.value} sx={{ textTransform: "none", fontSize: "0.8125rem", py: 0.75 }}>
                {option.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <TextField
            fullWidth
            size="small"
            label="Notes (optional)"
            multiline
            minRows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            inputProps={{ "aria-label": "Notes" }}
            helperText="A quick note on what you found or decided"
            FormHelperTextProps={{ sx: { fontSize: "0.7rem", m: 0, mt: 0.5 } }}
          />

          <Stack spacing={1} sx={{ mt: 2 }}>
            {isHelpful ? (
              <>
                <Button variant="contained" onClick={handleSave} disabled={actionLoading} sx={{ textTransform: "none" }}>
                  Save
                </Button>
                <Button onClick={() => setExampleOpen(true)} disabled={actionLoading} sx={{ textTransform: "none" }}>
                  Save as good example
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="contained"
                  onClick={handleSaveAndNext}
                  disabled={actionLoading}
                  endIcon={<SkipNextIcon />}
                  sx={{ textTransform: "none" }}
                >
                  Save &amp; next
                </Button>
                <Button onClick={handleSave} disabled={actionLoading} sx={{ textTransform: "none" }}>
                  Save
                </Button>
              </>
            )}
          </Stack>

          <Divider sx={{ my: 2 }} />

          <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
            Submitted {formatDate(feedback.CreatedAt)}
          </Typography>
          {detail?.trace?.SessionId && (
            <Link
              component={RouterLink}
              to={`/chatbot/playground/${detail.trace.SessionId}`}
              variant="body2"
              sx={{ fontSize: "0.8125rem", mt: 0.5, display: "inline-block" }}
            >
              View the full chat conversation
            </Link>
          )}
        </Paper>
      </Stack>

      {/* Save as good example confirm */}
      <Dialog open={exampleOpen} onClose={() => setExampleOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>Save as a good example?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.875rem" }}>
            This question and ABE's answer will be saved as a good example. We use these examples to automatically check
            that ABE keeps giving high-quality answers over time.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setExampleOpen(false)} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleSaveAsExample} disabled={actionLoading} sx={{ textTransform: "none" }}>
            Save example
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: "1rem", fontWeight: 600 }}>Delete this feedback?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ fontSize: "0.875rem" }}>
            This permanently removes the feedback for:
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 600, mt: 1, fontSize: "0.875rem" }}>
            "{feedback.UserPromptPreview || "this item"}"
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5, fontSize: "0.8125rem" }}>
            This can't be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleteOpen(false)} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button variant="contained" color="error" onClick={handleDelete} disabled={actionLoading} sx={{ textTransform: "none" }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
