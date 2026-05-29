import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import PublishIcon from "@mui/icons-material/Publish";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import { PromptData, formatDate } from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";

interface PromptWorkspaceProps {
  promptData: PromptData;
  loadingMeta: boolean;
  apiClient: ApiClient | null;
  onRefresh: () => Promise<void>;
  selectedFeedbackIds: string[];
}

function PromptSkeleton() {
  return (
    <Stack spacing={2} sx={{ maxWidth: 820, mx: "auto" }}>
      <Skeleton variant="rounded" height={48} />
      <Skeleton variant="rounded" height={420} />
    </Stack>
  );
}

export default function PromptWorkspace(props: PromptWorkspaceProps) {
  const { promptData, loadingMeta, apiClient, onRefresh, selectedFeedbackIds } = props;
  const { addNotification } = useNotifications();

  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [draft, setDraft] = useState({ title: "", notes: "", template: "" });
  const [savedDraft, setSavedDraft] = useState({ title: "", notes: "", template: "" });
  const [actionLoading, setActionLoading] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showAiDialog, setShowAiDialog] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingPromptId, setPendingPromptId] = useState("");
  const [aiNote, setAiNote] = useState("");

  const hasUnsavedChanges =
    draft.title !== savedDraft.title || draft.notes !== savedDraft.notes || draft.template !== savedDraft.template;

  const currentPrompt = useMemo(
    () => promptData.items.find((p) => p.versionId === selectedPromptId) || null,
    [promptData, selectedPromptId]
  );
  const livePrompt = useMemo(
    () => promptData.items.find((p) => p.versionId === promptData.liveVersionId) || null,
    [promptData]
  );
  const drafts = useMemo(
    () => promptData.items.filter((p) => p.versionId !== promptData.liveVersionId),
    [promptData]
  );

  useEffect(() => {
    if (!selectedPromptId && promptData.liveVersionId) {
      setSelectedPromptId(promptData.liveVersionId);
    }
  }, [promptData, selectedPromptId]);

  useEffect(() => {
    if (currentPrompt) {
      const d = {
        title: currentPrompt.title || "",
        notes: currentPrompt.notes || "",
        template: currentPrompt.template || "",
      };
      setDraft(d);
      setSavedDraft(d);
    }
  }, [currentPrompt]);

  const isLive = selectedPromptId !== "" && selectedPromptId === promptData.liveVersionId;
  const isSystemDefault = currentPrompt?.isSystemDefault === true;
  const isReadOnly = isLive || isSystemDefault;
  // Mode B (editor) whenever a non-live version is selected; otherwise Mode A (overview).
  const inEditor = selectedPromptId !== "" && selectedPromptId !== promptData.liveVersionId;

  const handleSelectPrompt = useCallback(
    (versionId: string) => {
      if (hasUnsavedChanges && !isReadOnly) {
        setPendingPromptId(versionId);
        setShowUnsavedDialog(true);
      } else {
        setSelectedPromptId(versionId);
      }
    },
    [hasUnsavedChanges, isReadOnly]
  );

  const handleDiscardAndSwitch = () => {
    setShowUnsavedDialog(false);
    setSelectedPromptId(pendingPromptId);
    setPendingPromptId("");
  };

  const handleBackToCurrent = () => {
    handleSelectPrompt(promptData.liveVersionId || "");
  };

  const handleCreateDraft = async () => {
    if (!apiClient) return;
    try {
      setActionLoading(true);
      const result = await apiClient.userFeedback.createPrompt({
        title: livePrompt ? `Copy of ${livePrompt.title || "current instructions"}` : "New instructions",
        parentVersionId: livePrompt?.versionId,
        template: livePrompt?.template || "# ABE Instructions\n\n{{current_date}}",
      });
      await onRefresh();
      setSelectedPromptId(result.prompt.versionId);
    } catch (error: any) {
      addNotification("error", error?.message || "Could not start a draft.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleSave = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setActionLoading(true);
      await apiClient.userFeedback.updatePrompt(selectedPromptId, draft);
      setSavedDraft({ ...draft });
      await onRefresh();
      addNotification("success", "Draft saved.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save.");
    } finally {
      setActionLoading(false);
    }
  };

  const handlePublish = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setActionLoading(true);
      setShowPublishDialog(false);
      await apiClient.userFeedback.publishPrompt(selectedPromptId);
      await onRefresh();
      setSelectedPromptId(selectedPromptId);
      addNotification("success", "These instructions are now live for all users.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not publish.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAiSuggest = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setActionLoading(true);
      setShowAiDialog(false);
      const result = await apiClient.userFeedback.aiSuggestPrompt(selectedPromptId, {
        feedbackIds: selectedFeedbackIds,
        note: aiNote.trim(),
      });
      await onRefresh();
      setSelectedPromptId(result.prompt.versionId);
      setAiNote("");
      addNotification("success", "AI created a new draft with suggested changes.");
    } catch (error: any) {
      addNotification("error", error?.message || "AI could not suggest changes.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setActionLoading(true);
      setShowDeleteDialog(false);
      await apiClient.userFeedback.deletePrompt(selectedPromptId);
      setSelectedPromptId(promptData.liveVersionId || "");
      await onRefresh();
      addNotification("success", "Draft deleted.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not delete.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loadingMeta && promptData.items.length === 0) return <PromptSkeleton />;

  return (
    <Box sx={{ maxWidth: 820, mx: "auto" }}>
      {actionLoading && (
        <Box role="progressbar" aria-label="Loading" aria-busy="true" sx={{ mb: 1.5, borderRadius: 1 }}>
          <LinearProgress sx={{ borderRadius: 1 }} />
        </Box>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        These are the instructions ABE follows when answering. Editing and publishing them changes how ABE responds
        for <strong>everyone</strong>, so changes are saved as a draft first and only go live when you publish.
      </Typography>

      {!inEditor ? (
        /* ---------- Overview: current instructions + drafts ---------- */
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1 }}>
              <CheckCircleOutlineIcon fontSize="small" color="success" />
              <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
                Current instructions
              </Typography>
              <Chip size="small" label="Live" color="success" sx={{ height: 22, fontSize: "0.75rem" }} />
            </Stack>
            {livePrompt ? (
              <>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {livePrompt.title || "ABE instructions"}
                </Typography>
                <Box
                  sx={{
                    p: 1.5,
                    borderRadius: 1,
                    bgcolor: "grey.50",
                    border: "1px solid",
                    borderColor: "divider",
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "0.8rem",
                    whiteSpace: "pre-wrap",
                    maxHeight: 280,
                    overflow: "auto",
                  }}
                >
                  {livePrompt.template}
                </Box>
              </>
            ) : (
              <Alert severity="info">No live instructions are set yet. Start a draft to create them.</Alert>
            )}
            <Stack direction="row" gap={1} sx={{ mt: 2 }} flexWrap="wrap">
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={handleCreateDraft}
                disabled={actionLoading}
                sx={{ textTransform: "none" }}
              >
                Edit a copy
              </Button>
            </Stack>
          </Paper>

          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, fontSize: "0.9375rem", mb: 1 }}>
              Drafts
            </Typography>
            {drafts.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No drafts yet. Click “Edit a copy” above to start changing ABE's instructions.
              </Typography>
            ) : (
              <Stack spacing={1}>
                {drafts.map((item) => (
                  <Paper
                    key={item.versionId}
                    variant="outlined"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectPrompt(item.versionId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        handleSelectPrompt(item.versionId);
                      }
                    }}
                    sx={{
                      p: 1.5,
                      cursor: "pointer",
                      transition: "box-shadow 0.15s, border-color 0.15s",
                      "&:hover": { boxShadow: 2, borderColor: "primary.main" },
                      "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
                    }}
                  >
                    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1}>
                      <Stack direction="row" gap={1} alignItems="center" sx={{ minWidth: 0 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600, fontSize: "0.875rem" }} noWrap>
                          {item.title || "Untitled draft"}
                        </Typography>
                        {item.isSystemDefault && (
                          <Chip size="small" variant="outlined" label="ABE's original" sx={{ height: 20, fontSize: "0.7rem" }} />
                        )}
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
                        {formatDate(item.updatedAt || item.createdAt)}
                      </Typography>
                    </Stack>
                  </Paper>
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      ) : (
        /* ---------- Editor: a single selected draft ---------- */
        <Stack spacing={2}>
          <Button
            onClick={handleBackToCurrent}
            startIcon={<ArrowBackIcon />}
            sx={{ alignSelf: "flex-start", textTransform: "none" }}
            size="small"
          >
            Back to current instructions
          </Button>

          <Paper variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
              <Stack direction="row" gap={1} alignItems="center">
                <Typography variant="h6" sx={{ fontSize: "1.0625rem", fontWeight: 600 }}>
                  {isSystemDefault ? "ABE's original instructions" : "Edit draft"}
                </Typography>
                {isSystemDefault && (
                  <Chip size="small" variant="outlined" label="Read-only" sx={{ height: 22, fontSize: "0.75rem" }} />
                )}
              </Stack>
              {hasUnsavedChanges && !isReadOnly && (
                <Stack direction="row" gap={0.5} alignItems="center">
                  <WarningAmberIcon sx={{ fontSize: 16, color: "warning.main" }} />
                  <Typography variant="caption" color="warning.dark" sx={{ fontWeight: 600 }}>
                    Unsaved changes
                  </Typography>
                </Stack>
              )}
            </Stack>

            {currentPrompt?.aiSummary && (
              <Alert severity={currentPrompt.aiSummary.startsWith("No changes") ? "warning" : "info"} sx={{ mt: 1.5 }}>
                <Typography variant="caption" sx={{ fontWeight: 700, display: "block", mb: 0.25 }}>
                  What the AI changed
                </Typography>
                <Typography variant="body2" sx={{ fontSize: "0.8125rem", whiteSpace: "pre-line" }}>
                  {currentPrompt.aiSummary}
                </Typography>
              </Alert>
            )}

            <TextField
              fullWidth
              size="small"
              label="Name"
              sx={{ mt: 2 }}
              value={draft.title}
              onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
              disabled={isReadOnly}
            />
            <TextField
              fullWidth
              multiline
              minRows={16}
              maxRows={36}
              label="Instructions"
              sx={{ mt: 1.5 }}
              value={draft.template}
              onChange={(e) => setDraft((d) => ({ ...d, template: e.target.value }))}
              disabled={isReadOnly}
            />
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.75, display: "block" }}>
              Tip: leave <code>{"{{current_date}}"}</code> in place — ABE replaces it with today's date when it answers.
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="Notes (optional)"
              sx={{ mt: 1.5 }}
              value={draft.notes}
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
              disabled={isReadOnly}
              helperText="A short note on what you changed and why"
            />

            <Stack direction="row" gap={1} sx={{ mt: 2 }} flexWrap="wrap">
              {!isReadOnly && (
                <Button size="small" onClick={handleSave} disabled={actionLoading} sx={{ textTransform: "none" }}>
                  Save draft
                </Button>
              )}
              {!isReadOnly && (
                <Button
                  size="small"
                  startIcon={<AutoFixHighIcon />}
                  onClick={() => setShowAiDialog(true)}
                  disabled={actionLoading}
                  sx={{ textTransform: "none" }}
                >
                  Ask AI to improve
                </Button>
              )}
              <Button
                size="small"
                variant="contained"
                startIcon={<PublishIcon />}
                onClick={() => setShowPublishDialog(true)}
                disabled={actionLoading || hasUnsavedChanges}
                sx={{ textTransform: "none" }}
              >
                {isSystemDefault ? "Make this live" : "Publish"}
              </Button>
              {!isSystemDefault && (
                <Button
                  size="small"
                  color="error"
                  startIcon={<DeleteOutlineIcon />}
                  onClick={() => setShowDeleteDialog(true)}
                  disabled={actionLoading}
                  sx={{ ml: "auto", textTransform: "none" }}
                >
                  Delete draft
                </Button>
              )}
            </Stack>
            {hasUnsavedChanges && !isReadOnly && (
              <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
                Save your draft before you can publish it.
              </Typography>
            )}
          </Paper>
        </Stack>
      )}

      {/* Publish confirmation */}
      <Dialog open={showPublishDialog} onClose={() => setShowPublishDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Make these instructions live?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" gutterBottom>
            <strong>{currentPrompt?.title || "This draft"}</strong> will immediately become the instructions ABE uses
            for <strong>all users</strong>.
          </Typography>
          {livePrompt && (
            <Typography variant="body2" color="text.secondary">
              It replaces the current live instructions ({livePrompt.title || "current instructions"}). You can switch
              back later by publishing a different version.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowPublishDialog(false)} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handlePublish} disabled={actionLoading} sx={{ textTransform: "none" }}>
            Publish now
          </Button>
        </DialogActions>
      </Dialog>

      {/* Unsaved changes */}
      <Dialog open={showUnsavedDialog} onClose={() => setShowUnsavedDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Discard unsaved changes?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">You have unsaved changes to this draft. Leaving will discard them.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowUnsavedDialog(false)} sx={{ textTransform: "none" }}>
            Keep editing
          </Button>
          <Button variant="contained" color="warning" onClick={handleDiscardAndSwitch} sx={{ textTransform: "none" }}>
            Discard
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={showDeleteDialog} onClose={() => setShowDeleteDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete this draft?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            <strong>{currentPrompt?.title || "This draft"}</strong> will be permanently removed. This can't be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowDeleteDialog(false)} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button variant="contained" color="error" onClick={handleDelete} disabled={actionLoading} sx={{ textTransform: "none" }}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Ask AI to improve */}
      <Dialog open={showAiDialog} onClose={() => { setShowAiDialog(false); setAiNote(""); }} maxWidth="sm" fullWidth>
        <DialogTitle>Ask AI to improve these instructions</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              The AI makes small, targeted edits to the current draft and saves the result as a new draft. It won't go
              live until you publish it.
            </Typography>
            <TextField
              fullWidth
              multiline
              minRows={3}
              maxRows={6}
              label="What should ABE do better? (optional)"
              placeholder="e.g. Be more concise, always cite the source document, avoid legal advice…"
              value={aiNote}
              onChange={(e) => setAiNote(e.target.value)}
            />
            {selectedFeedbackIds.length > 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8125rem" }}>
                {selectedFeedbackIds.length} recent feedback item(s) will be shared with the AI as examples.
              </Typography>
            ) : (
              <Alert severity="info" role="status">
                Tip: open a feedback item first and the AI will use it as an example of what to fix.
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setShowAiDialog(false); setAiNote(""); }} sx={{ textTransform: "none" }}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleAiSuggest} disabled={actionLoading} startIcon={<AutoFixHighIcon />} sx={{ textTransform: "none" }}>
            Generate draft
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
