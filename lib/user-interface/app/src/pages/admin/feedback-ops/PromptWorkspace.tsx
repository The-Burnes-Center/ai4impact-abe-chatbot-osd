import { useEffect, useMemo, useState } from "react";
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
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import PublishIcon from "@mui/icons-material/Publish";
import AddIcon from "@mui/icons-material/Add";
import EditNoteOutlinedIcon from "@mui/icons-material/EditNoteOutlined";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import HistoryIcon from "@mui/icons-material/History";
import { PromptData, PromptItem, formatDate } from "./types";
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
  const [actionLoading, setActionLoading] = useState(false);
  const [showPublishDialog, setShowPublishDialog] = useState(false);
  const [viewMode, setViewMode] = useState<"edit" | "preview" | "diff">("edit");

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
      setDraft({
        title: currentPrompt.title || "",
        notes: currentPrompt.notes || "",
        template: currentPrompt.template || "",
      });
    }
  }, [currentPrompt]);

  const diffLines = useMemo(
    () => buildDiff(livePrompt?.template || "", draft.template),
    [livePrompt, draft.template]
  );

  const previewText = useMemo(() => renderPreview(draft.template), [draft.template]);

  const isLive = selectedPromptId === promptData.liveVersionId;

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
      const feedbackIds = selectedFeedbackIds.length > 0
        ? selectedFeedbackIds
        : [];
      const result = await apiClient.userFeedback.aiSuggestPrompt(
        selectedPromptId,
        { feedbackIds }
      );
      await onRefresh();
      setSelectedPromptId(result.prompt.versionId);
      addNotification("success", "AI created a draft prompt.");
    } catch (error: any) {
      addNotification("error", error?.message || "AI prompt suggestion failed.");
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
                      onClick={() => setSelectedPromptId(item.versionId)}
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
                              <Chip size="small" label="LIVE" color="success" sx={{ height: 18, fontSize: "0.65rem" }} />
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
                    <Typography variant="caption" color="text.secondary">
                      AI: {currentPrompt.aiSummary}
                    </Typography>
                  )}
                </Stack>
                <Stack direction="row" gap={1} flexWrap="wrap">
                  <Button
                    size="small"
                    startIcon={<AutoFixHighIcon />}
                    onClick={handleAiSuggest}
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
                <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
                  {selectedFeedbackIds.length} feedback item(s) linked for AI draft
                </Typography>
              )}

              {/* View mode tabs */}
              <Stack direction="row" gap={1} sx={{ mt: 2, mb: 1 }}>
                {(["edit", "preview", "diff"] as const).map((mode) => (
                  <Chip
                    key={mode}
                    label={mode.charAt(0).toUpperCase() + mode.slice(1)}
                    variant={viewMode === mode ? "filled" : "outlined"}
                    color={viewMode === mode ? "primary" : "default"}
                    onClick={() => setViewMode(mode)}
                    size="small"
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
                    fontSize: "0.75rem",
                    whiteSpace: "pre-wrap",
                    maxHeight: 600,
                    overflow: "auto",
                  }}
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
                        }}
                      >
                        {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
                        {line.text}
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
                  <Typography variant="caption" color="text.secondary">
                    Version ID: {currentPrompt.versionId}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    Status: {currentPrompt.status}
                  </Typography>
                  {currentPrompt.parentVersionId && (
                    <Typography variant="caption" color="text.secondary">
                      Parent: {currentPrompt.parentVersionId}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    Created: {formatDate(currentPrompt.createdAt)} by {currentPrompt.createdBy || "unknown"}
                  </Typography>
                  {currentPrompt.publishedAt && (
                    <Typography variant="caption" color="text.secondary">
                      Published: {formatDate(currentPrompt.publishedAt)}
                    </Typography>
                  )}
                  {(currentPrompt.linkedFeedbackIds || []).length > 0 && (
                    <Typography variant="caption" color="text.secondary">
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
      <Dialog open={showPublishDialog} onClose={() => setShowPublishDialog(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Publish prompt?</DialogTitle>
        <DialogContent>
          <Typography variant="body2" gutterBottom>
            This will make <strong>{currentPrompt?.title || selectedPromptId}</strong> the live prompt for all ABE users.
          </Typography>
          {livePrompt && (
            <Typography variant="body2" color="text.secondary">
              Current live prompt: {livePrompt.title || livePrompt.versionId}
              {livePrompt.publishedAt ? ` (published ${formatDate(livePrompt.publishedAt)})` : ""}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowPublishDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={handlePublish} disabled={actionLoading}>
            Publish
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
