import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Grid,
  LinearProgress,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import PublishIcon from "@mui/icons-material/Publish";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HistoryIcon from "@mui/icons-material/History";
import { PromptData, formatDate } from "./types";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";

interface PromptWorkspaceProps {
  promptData: PromptData;
  loading: boolean;
  apiClient: ApiClient | null;
  onRefresh: () => Promise<void>;
  selectedFeedbackIds: string[];
}

function buildDiff(base: string, candidate: string): { type: "same" | "add" | "remove"; text: string }[] {
  const baseLines = (base || "").split("\n");
  const candidateLines = (candidate || "").split("\n");
  const maxLines = Math.max(baseLines.length, candidateLines.length);
  const result: { type: "same" | "add" | "remove"; text: string }[] = [];

  for (let i = 0; i < maxLines; i++) {
    const left = baseLines[i] ?? "";
    const right = candidateLines[i] ?? "";
    if (left === right) {
      result.push({ type: "same", text: left });
    } else {
      if (left) result.push({ type: "remove", text: left });
      if (right) result.push({ type: "add", text: right });
    }
  }
  return result;
}

function renderPreview(template: string): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "America/New_York",
  });
  return template
    .replace(/\{\{current_date\}\}/g, dateStr)
    .replace(/\{\{metadata_json\}\}/g, JSON.stringify(
      { documents: [{ title: "Sample Document.pdf", uri: "s3://bucket/key" }] },
      null,
      2
    ));
}

function PromptSkeleton() {
  return (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={4}>
        <Skeleton variant="rounded" height={300} />
      </Grid>
      <Grid item xs={12} lg={8}>
        <Skeleton variant="rounded" height={500} />
      </Grid>
    </Grid>
  );
}

export default function PromptWorkspace(props: PromptWorkspaceProps) {
  const { promptData, loading, apiClient, onRefresh, selectedFeedbackIds } = props;
  const { addNotification } = useNotifications();

  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [draft, setDraft] = useState({ title: "", notes: "", template: "" });
  const [savedDraft, setSavedDraft] = useState({ title: "", notes: "", template: "" });
  const [actionLoading, setActionLoading] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [publishConfirmText, setPublishConfirmText] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showAiDialog, setShowAiDialog] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [pendingPromptId, setPendingPromptId] = useState("");
  const [aiNote, setAiNote] = useState("");
  const [viewMode, setViewMode] = useState<"edit" | "preview" | "diff">("edit");

  const hasUnsavedChanges = draft.title !== savedDraft.title || draft.notes !== savedDraft.notes || draft.template !== savedDraft.template;

  const currentPrompt = useMemo(
    () => promptData.items.find((p) => p.versionId === selectedPromptId) || null,
    [promptData, selectedPromptId]
  );
  const livePrompt = useMemo(
    () => promptData.items.find((p) => p.versionId === promptData.liveVersionId) || null,
    [promptData]
  );

  useEffect(() => {
    if (!selectedPromptId && promptData.liveVersionId) {
      setSelectedPromptId(promptData.liveVersionId);
    } else if (!selectedPromptId && promptData.items.length > 0) {
      setSelectedPromptId(promptData.items[0].versionId);
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

  const diffLines = useMemo(
    () => buildDiff(livePrompt?.template || "", draft.template),
    [livePrompt, draft.template]
  );

  const previewText = useMemo(() => renderPreview(draft.template), [draft.template]);

  const isLive = selectedPromptId === promptData.liveVersionId;

  const handleSelectPrompt = useCallback((versionId: string) => {
    if (hasUnsavedChanges && !isLive) {
      setPendingPromptId(versionId);
      setShowUnsavedDialog(true);
    } else {
      setSelectedPromptId(versionId);
    }
  }, [hasUnsavedChanges, isLive]);

  const handleDiscardAndSwitch = () => {
    setShowUnsavedDialog(false);
    setSelectedPromptId(pendingPromptId);
    setPendingPromptId("");
  };

  const handleCreateDraft = async () => {
    if (!apiClient) return;
    try {
      setActionLoading(true);
      const result = await apiClient.userFeedback.createPrompt({
        title: livePrompt ? `Draft from ${livePrompt.versionId}` : "New draft",
        parentVersionId: livePrompt?.versionId,
        template: livePrompt?.template || "# ABE Prompt\n\n{{current_date}}\n\n{{metadata_json}}",
      });
      await onRefresh();
      setSelectedPromptId(result.prompt.versionId);
    } catch (error: any) {
      addNotification("error", error?.message || "Could not create draft.");
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
      addNotification("success", "Prompt draft saved.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save prompt.");
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
      addNotification("success", "Prompt published and now live.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not publish prompt.");
    } finally {
      setActionLoading(false);
    }
  };

  const handleAiSuggest = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setActionLoading(true);
      setShowAiDialog(false);
      const feedbackIds = selectedFeedbackIds.length > 0
        ? selectedFeedbackIds
        : [];
      const result = await apiClient.userFeedback.aiSuggestPrompt(
        selectedPromptId,
        { feedbackIds, note: aiNote.trim() }
      );
      await onRefresh();
      setSelectedPromptId(result.prompt.versionId);
      setAiNote("");
      addNotification("success", "AI created a draft prompt.");
    } catch (error: any) {
      addNotification("error", error?.message || "AI prompt suggestion failed.");
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
      setSelectedPromptId("");
      await onRefresh();
      addNotification("success", "Draft deleted.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not delete prompt.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && promptData.items.length === 0) return <PromptSkeleton />;

  return (
    <>
      {actionLoading && <LinearProgress sx={{ mb: 1, borderRadius: 1 }} />}

      <Grid container spacing={2}>
        {/* Version list */}
        <Grid item xs={12} lg={4}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
              <Typography variant="h6">Versions</Typography>
              <Button size="small" startIcon={<AddIcon />} onClick={handleCreateDraft} disabled={actionLoading}>
                New Draft
              </Button>
            </Stack>
            {promptData.items.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
                No prompt versions yet. Create a draft to get started.
              </Typography>
            ) : (
              <List dense disablePadding>
                {promptData.items.map((item) => {
                  const isItemLive = item.versionId === promptData.liveVersionId;
                  return (
                    <ListItemButton
                      key={item.versionId}
                      selected={item.versionId === selectedPromptId}
                      onClick={() => handleSelectPrompt(item.versionId)}
                      sx={{ "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: -2 } }}
                    >
                      <ListItemIcon sx={{ minWidth: 32 }}>
                        {isItemLive ? (
                          <CheckCircleOutlineIcon fontSize="small" color="success" />
                        ) : (
                          <EditNoteOutlinedIcon fontSize="small" color="action" />
                        )}
                      </ListItemIcon>
                      <ListItemText
                        primary={
                          <Stack direction="row" gap={1} alignItems="center">
                            <Typography variant="body2" fontWeight={isItemLive ? 700 : 400} noWrap>
                              {item.title || item.versionId}
                            </Typography>
                            {isItemLive && (
                              <Chip size="small" label="LIVE" color="success" sx={{ height: 20, fontSize: "0.75rem" }} />
                            )}
                          </Stack>
                        }
                        secondary={
                          <Typography variant="caption" color="text.secondary">
                            {item.status} · {formatDate(item.updatedAt || item.createdAt)}
                          </Typography>
                        }
                      />
                    </ListItemButton>
                  );
                })}
              </List>
            )}
          </Paper>
        </Grid>

        {/* Editor */}
        <Grid item xs={12} lg={8}>
          <Stack spacing={2}>
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack direction={{ xs: "column", md: "row" }} gap={1} justifyContent="space-between" alignItems={{ md: "center" }}>
                <Stack>
                  <Typography variant="h6">{currentPrompt?.title || "Select a prompt"}</Typography>
                  {currentPrompt?.aiSummary && (
                    <Paper
                      variant="outlined"
                      sx={{
                        mt: 0.75,
                        p: 1.25,
                        bgcolor: currentPrompt.aiSummary.startsWith("No changes")
                          ? "warning.50"
                          : "info.50",
                        borderColor: currentPrompt.aiSummary.startsWith("No changes")
                          ? "warning.200"
                          : "info.200",
                      }}
                    >
                      <Typography
                        variant="caption"
                        sx={{
                          display: "block",
                          fontWeight: 600,
                          fontSize: "0.6875rem",
                          mb: 0.5,
                          letterSpacing: 0.5,
                          textTransform: "uppercase",
                          color: currentPrompt.aiSummary.startsWith("No changes")
                            ? "warning.dark"
                            : "info.dark",
                        }}
                      >
                        AI Reasoning
                      </Typography>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ fontSize: "0.8125rem", whiteSpace: "pre-line" }}
                      >
                        {currentPrompt.aiSummary}
                      </Typography>
                    </Paper>
                  )}
                </Stack>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Button
                    size="small"
                    startIcon={<AutoFixHighIcon />}
                    onClick={() => setShowAiDialog(true)}
                    disabled={!selectedPromptId || actionLoading}
                  >
                    AI Draft
                  </Button>
                  <Button
                    size="small"
                    onClick={handleSave}
                    disabled={!selectedPromptId || isLive || actionLoading}
                  >
                    Save Draft
                  </Button>
                  <Button
                    size="small"
                    color="error"
                    startIcon={<DeleteOutlineIcon />}
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={!selectedPromptId || isLive || actionLoading}
                  >
                    Delete
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    startIcon={<PublishIcon />}
                    onClick={() => setShowPublishDialog(true)}
                    disabled={!selectedPromptId || actionLoading}
                  >
                    Publish
                  </Button>
                </Stack>
              </Stack>

              {selectedFeedbackIds.length > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block", fontSize: "0.75rem" }}>
                  {selectedFeedbackIds.length} feedback item(s) linked for AI draft
                </Typography>
              )}

              {hasUnsavedChanges && !isLive && (
                <Stack direction="row" gap={0.75} alignItems="center" sx={{ mt: 1 }}>
                  <WarningAmberIcon sx={{ fontSize: 16, color: "warning.main" }} />
                  <Typography variant="caption" color="warning.dark" sx={{ fontSize: "0.75rem", fontWeight: 600 }}>
                    You have unsaved changes
                  </Typography>
                </Stack>
              )}

              {/* View mode tabs */}
              <Stack direction="row" gap={1} sx={{ mt: 2, mb: 1 }} role="tablist" aria-label="Prompt view mode">
                {(["edit", "preview", "diff"] as const).map((mode) => (
                  <Chip
                    key={mode}
                    label={mode.charAt(0).toUpperCase() + mode.slice(1)}
                    variant={viewMode === mode ? "filled" : "outlined"}
                    color={viewMode === mode ? "primary" : "default"}
                    onClick={() => setViewMode(mode)}
                    size="small"
                    role="tab"
                    aria-selected={viewMode === mode}
                    sx={{
                      fontSize: "0.75rem",
                      "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 1 },
                    }}
                  />
                ))}
              </Stack>

              <TextField
                fullWidth
                size="small"
                label="Title"
                sx={{ mt: 1 }}
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                disabled={isLive}
              />
              <TextField
                fullWidth
                size="small"
                label="Notes"
                sx={{ mt: 1.5 }}
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                disabled={isLive}
              />

              {viewMode === "edit" && (
                <TextField
                  fullWidth
                  multiline
                  minRows={18}
                  maxRows={40}
                  label="Prompt template"
                  sx={{ mt: 1.5 }}
                  value={draft.template}
                  onChange={(e) => setDraft((d) => ({ ...d, template: e.target.value }))}
                  disabled={isLive}
                />
              )}

              {viewMode === "preview" && (
                <Box
                  sx={{
                    mt: 1.5,
                    p: 2,
                    borderRadius: 1,
                    bgcolor: "grey.50",
                    border: "1px solid",
                    borderColor: "divider",
                    fontFamily: "monospace",
                    fontSize: "0.8rem",
                    whiteSpace: "pre-wrap",
                    maxHeight: 600,
                    overflow: "auto",
                  }}
                >
                  {previewText}
                </Box>
              )}

              {viewMode === "diff" && (
                <Box
                  sx={{
                    mt: 1.5,
                    p: 2,
                    borderRadius: 1,
                    bgcolor: "grey.50",
                    border: "1px solid",
                    borderColor: "divider",
                    fontFamily: "monospace",
                    fontSize: "0.8125rem",
                    whiteSpace: "pre-wrap",
                    maxHeight: 600,
                    overflow: "auto",
                  }}
                  role="region"
                  aria-label="Diff between live prompt and current draft"
                >
                  {livePrompt ? (
                    diffLines.map((line, i) => (
                      <div
                        key={i}
                        style={{
                          backgroundColor:
                            line.type === "add"
                              ? "rgba(46, 160, 67, 0.15)"
                              : line.type === "remove"
                                ? "rgba(248, 81, 73, 0.15)"
                                : "transparent",
                          color:
                            line.type === "add"
                              ? "#1a7f37"
                              : line.type === "remove"
                                ? "#cf222e"
                                : "inherit",
                          display: "flex",
                          gap: "8px",
                        }}
                        aria-label={line.type === "add" ? "Added line" : line.type === "remove" ? "Removed line" : undefined}
                      >
                        <span style={{ opacity: 0.5, userSelect: "none", minWidth: "2ch", textAlign: "right" }}>{i + 1}</span>
                        <span>{line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}{line.text}</span>
                      </div>
                    ))
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      No live prompt to compare against.
                    </Typography>
                  )}
                </Box>
              )}
            </Paper>

            {/* Version history */}
            {currentPrompt && (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1.5 }}>
                  <HistoryIcon fontSize="small" color="action" />
                  <Typography variant="subtitle2">Version Info</Typography>
                </Stack>
                <Stack spacing={0.5}>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    Version ID: {currentPrompt.versionId}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    Status: {currentPrompt.status}
                  </Typography>
                  {currentPrompt.parentVersionId && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                      Parent: {currentPrompt.parentVersionId}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    Created: {formatDate(currentPrompt.createdAt)} by {currentPrompt.createdBy || "unknown"}
                  </Typography>
                  {currentPrompt.publishedAt && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                      Published: {formatDate(currentPrompt.publishedAt)}
                    </Typography>
                  )}
                  {(currentPrompt.linkedFeedbackIds || []).length > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                      Linked feedback: {currentPrompt.linkedFeedbackIds!.length} item(s)
                    </Typography>
                  )}
                </Stack>
              </Paper>
            )}
          </Stack>
        </Grid>
      </Grid>

      {/* Publish confirmation dialog */}
      <Dialog
        open={showPublishDialog}
        onClose={() => { setShowPublishDialog(false); setPublishConfirmText(""); }}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Publish prompt?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" gutterBottom>
            This will make <strong>{currentPrompt?.title || selectedPromptId}</strong> the live prompt for all ABE users.
            This action takes effect immediately.
          </Typography>
          {livePrompt && (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Current live prompt: {livePrompt.title || livePrompt.versionId}
              {livePrompt.publishedAt ? ` (published ${formatDate(livePrompt.publishedAt)})` : ""}
            </Typography>
          )}
          <TextField
            fullWidth
            size="small"
            label='Type "publish" to confirm'
            value={publishConfirmText}
            onChange={(e) => setPublishConfirmText(e.target.value)}
            autoFocus
            inputProps={{ "aria-label": "Type publish to confirm" }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setShowPublishDialog(false); setPublishConfirmText(""); }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handlePublish}
            disabled={actionLoading || publishConfirmText.toLowerCase() !== "publish"}
          >
            Publish
          </Button>
        </DialogActions>
      </Dialog>

      {/* Unsaved changes dialog */}
      <Dialog open={showUnsavedDialog} onClose={() => setShowUnsavedDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Unsaved changes</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            You have unsaved changes to this draft. Do you want to discard them?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowUnsavedDialog(false)}>Keep editing</Button>
          <Button variant="contained" color="warning" onClick={handleDiscardAndSwitch}>
            Discard changes
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteDialog} onClose={() => setShowDeleteDialog(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete draft?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            <strong>{currentPrompt?.title || selectedPromptId}</strong> will be permanently removed. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowDeleteDialog(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDelete} disabled={actionLoading}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* AI Draft context dialog */}
      <Dialog open={showAiDialog} onClose={() => { setShowAiDialog(false); setAiNote(""); }} maxWidth="sm" fullWidth>
        <DialogTitle>Generate AI Draft</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            The AI will rewrite the current prompt based on feedback patterns.
            Optionally describe what you want it to focus on.
          </Typography>
          <TextField
            fullWidth
            multiline
            minRows={3}
            maxRows={6}
            label="What should this prompt improve? (optional)"
            placeholder="e.g. Improve accuracy for contract questions, be more concise, cite sources better..."
            value={aiNote}
            onChange={(e) => setAiNote(e.target.value)}
          />
          {selectedFeedbackIds.length > 0 && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
              {selectedFeedbackIds.length} feedback item(s) will be used as context.
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setShowAiDialog(false); setAiNote(""); }}>Cancel</Button>
          <Button variant="contained" onClick={handleAiSuggest} disabled={actionLoading} startIcon={<AutoFixHighIcon />}>
            Generate Draft
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
