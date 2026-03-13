import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Divider,
  Grid,
  List,
  ListItemButton,
  ListItemText,
  MenuItem,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import AutoFixHighIcon from "@mui/icons-material/AutoFixHigh";
import PublishIcon from "@mui/icons-material/Publish";
import AddIcon from "@mui/icons-material/Add";
import AdminPageLayout from "../../components/admin-page-layout";
import { useDocumentTitle } from "../../common/hooks/use-document-title";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { useNotifications } from "../../components/notif-manager";

type FeedbackItem = any;
type PromptItem = any;

function formatDate(value?: string) {
  if (!value) return "N/A";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function buildPromptDiff(baseTemplate?: string, candidateTemplate?: string) {
  const baseLines = (baseTemplate || "").split("\n");
  const candidateLines = (candidateTemplate || "").split("\n");
  const maxLines = Math.max(baseLines.length, candidateLines.length);
  const output: string[] = [];

  for (let index = 0; index < maxLines; index += 1) {
    const left = baseLines[index] ?? "";
    const right = candidateLines[index] ?? "";
    if (left === right) {
      output.push(`  ${left}`);
    } else {
      if (left) output.push(`- ${left}`);
      if (right) output.push(`+ ${right}`);
    }
  }

  return output.join("\n");
}

export default function FeedbackOpsPage() {
  useDocumentTitle("Feedback Ops");
  const { feedbackId } = useParams();
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const { addNotification } = useNotifications();
  const [tab, setTab] = useState("inbox");
  const [filters, setFilters] = useState({
    reviewStatus: "",
    disposition: "",
    issueTag: "",
    promptVersionId: "",
    sourceTitle: "",
  });
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);
  const [selectedFeedbackIds, setSelectedFeedbackIds] = useState<string[]>([]);
  const [selectedFeedback, setSelectedFeedback] = useState<any>(null);
  const [monitoring, setMonitoring] = useState<any>(null);
  const [promptData, setPromptData] = useState<{ items: PromptItem[]; liveVersionId?: string | null }>({
    items: [],
    liveVersionId: null,
  });
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [promptDraft, setPromptDraft] = useState({
    title: "",
    notes: "",
    template: "",
  });
  const [bulkDisposition, setBulkDisposition] = useState("prompt update");
  const [bulkReviewStatus, setBulkReviewStatus] = useState("in_review");
  const [owner, setOwner] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [adminNotes, setAdminNotes] = useState("");
  const [loading, setLoading] = useState(false);

  const apiClient = useMemo(() => (appContext ? new ApiClient(appContext) : null), [appContext]);

  const loadFeedback = useCallback(async () => {
    if (!apiClient) return;
    const result = await apiClient.userFeedback.getAdminFeedback(filters);
    setFeedbackItems(result.items || []);
  }, [apiClient, filters]);

  const loadFeedbackDetail = useCallback(async (id: string) => {
    if (!apiClient || !id) return;
    const result = await apiClient.userFeedback.getAdminFeedbackDetail(id);
    setSelectedFeedback(result);
    const feedback = result.feedback;
    setOwner(feedback?.Owner || "");
    setResolutionNote(feedback?.ResolutionNote || "");
    setAdminNotes(feedback?.AdminNotes || "");
  }, [apiClient]);

  const loadMonitoring = useCallback(async () => {
    if (!apiClient) return;
    const result = await apiClient.userFeedback.getMonitoring();
    setMonitoring(result);
  }, [apiClient]);

  const loadPrompts = useCallback(async () => {
    if (!apiClient) return;
    const result = await apiClient.userFeedback.getPrompts();
    setPromptData(result);
  }, [apiClient]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadFeedback(), loadMonitoring(), loadPrompts()]);
      if (feedbackId) {
        await loadFeedbackDetail(feedbackId);
      }
    } catch (error: any) {
      addNotification("error", error?.message || "Failed to refresh Feedback Ops.");
    } finally {
      setLoading(false);
    }
  }, [addNotification, feedbackId, loadFeedback, loadFeedbackDetail, loadMonitoring, loadPrompts]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    loadFeedback().catch((error: any) => {
      addNotification("error", error?.message || "Could not load feedback.");
    });
  }, [addNotification, loadFeedback]);

  useEffect(() => {
    if (feedbackId) {
      setTab("inbox");
      loadFeedbackDetail(feedbackId);
    } else {
      setSelectedFeedback(null);
    }
  }, [feedbackId, loadFeedbackDetail]);

  useEffect(() => {
    if (!selectedPromptId && promptData.liveVersionId) {
      setSelectedPromptId(promptData.liveVersionId);
    } else if (!selectedPromptId && promptData.items.length > 0) {
      setSelectedPromptId(promptData.items[0].versionId);
    }
  }, [promptData, selectedPromptId]);

  const currentPrompt = useMemo(
    () => promptData.items.find((item) => item.versionId === selectedPromptId) || null,
    [promptData, selectedPromptId]
  );
  const livePrompt = useMemo(
    () => promptData.items.find((item) => item.versionId === promptData.liveVersionId) || null,
    [promptData]
  );

  useEffect(() => {
    if (currentPrompt) {
      setPromptDraft({
        title: currentPrompt.title || "",
        notes: currentPrompt.notes || "",
        template: currentPrompt.template || "",
      });
    }
  }, [currentPrompt]);

  const promptDiff = useMemo(
    () => buildPromptDiff(livePrompt?.template, promptDraft.template),
    [livePrompt, promptDraft.template]
  );

  const selectedFeedbackIdsForPrompt = useMemo(() => {
    if (selectedFeedbackIds.length > 0) return selectedFeedbackIds;
    if (selectedFeedback?.feedback?.FeedbackId) return [selectedFeedback.feedback.FeedbackId];
    return [];
  }, [selectedFeedback, selectedFeedbackIds]);

  const handleApplyBulkDisposition = async () => {
    if (!apiClient || selectedFeedbackIds.length === 0) return;
    try {
      setLoading(true);
      await Promise.all(
        selectedFeedbackIds.map((id) =>
          apiClient.userFeedback.setFeedbackDisposition(id, {
            disposition: bulkDisposition,
            reviewStatus: bulkReviewStatus,
          })
        )
      );
      await refreshAll();
    } catch (error: any) {
      addNotification("error", error?.message || "Bulk update failed.");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveReview = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setLoading(true);
      await apiClient.userFeedback.setFeedbackDisposition(selectedFeedback.feedback.FeedbackId, {
        reviewStatus: selectedFeedback.feedback.ReviewStatus || "in_review",
        disposition: selectedFeedback.feedback.Disposition || "pending",
        owner,
        resolutionNote,
        adminNotes,
      });
      await loadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await loadFeedback();
      await loadMonitoring();
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save review.");
    } finally {
      setLoading(false);
    }
  };

  const handleReanalyze = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setLoading(true);
      await apiClient.userFeedback.analyzeFeedback(selectedFeedback.feedback.FeedbackId);
      await loadFeedbackDetail(selectedFeedback.feedback.FeedbackId);
      await loadFeedback();
      await loadMonitoring();
    } catch (error: any) {
      addNotification("error", error?.message || "Could not rerun analysis.");
    } finally {
      setLoading(false);
    }
  };

  const handlePromoteCandidate = async () => {
    if (!apiClient || !selectedFeedback?.feedback?.FeedbackId) return;
    try {
      setLoading(true);
      await apiClient.userFeedback.promoteToCandidate(selectedFeedback.feedback.FeedbackId);
      await loadMonitoring();
      addNotification("success", "Candidate monitoring case created.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not create candidate case.");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDraft = async () => {
    if (!apiClient) return;
    try {
      setLoading(true);
      const result = await apiClient.userFeedback.createPrompt({
        title: livePrompt ? `Draft from ${livePrompt.versionId}` : "New draft",
        parentVersionId: livePrompt?.versionId,
        template: livePrompt?.template || "# ABE Prompt\n\n{{current_date}}\n\n{{metadata_json}}",
      });
      await loadPrompts();
      setSelectedPromptId(result.prompt.versionId);
    } catch (error: any) {
      addNotification("error", error?.message || "Could not create draft.");
    } finally {
      setLoading(false);
    }
  };

  const handleSavePrompt = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setLoading(true);
      await apiClient.userFeedback.updatePrompt(selectedPromptId, promptDraft);
      await loadPrompts();
      addNotification("success", "Prompt draft saved.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not save prompt.");
    } finally {
      setLoading(false);
    }
  };

  const handleAiSuggestPrompt = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setLoading(true);
      const result = await apiClient.userFeedback.aiSuggestPrompt(selectedPromptId, {
        feedbackIds: selectedFeedbackIdsForPrompt,
      });
      await loadPrompts();
      setSelectedPromptId(result.prompt.versionId);
      addNotification("success", "AI created a draft prompt.");
    } catch (error: any) {
      addNotification("error", error?.message || "AI prompt suggestion failed.");
    } finally {
      setLoading(false);
    }
  };

  const handlePublishPrompt = async () => {
    if (!apiClient || !selectedPromptId) return;
    try {
      setLoading(true);
      await apiClient.userFeedback.publishPrompt(selectedPromptId);
      await loadPrompts();
      await loadMonitoring();
      addNotification("success", "Prompt published.");
    } catch (error: any) {
      addNotification("error", error?.message || "Could not publish prompt.");
    } finally {
      setLoading(false);
    }
  };

  const renderInbox = () => (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack direction={{ xs: "column", md: "row" }} gap={1.5} flexWrap="wrap">
          <TextField
            select
            size="small"
            label="Review status"
            value={filters.reviewStatus}
            onChange={(event) => setFilters((current) => ({ ...current, reviewStatus: event.target.value }))}
            sx={{ minWidth: 160 }}
          >
            <MenuItem value="">All</MenuItem>
            {["new", "analyzed", "in_review", "actioned", "dismissed"].map((status) => (
              <MenuItem key={status} value={status}>{status}</MenuItem>
            ))}
          </TextField>
          <TextField
            select
            size="small"
            label="Disposition"
            value={filters.disposition}
            onChange={(event) => setFilters((current) => ({ ...current, disposition: event.target.value }))}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="">All</MenuItem>
            {["pending", "prompt update", "KB/source fix", "retrieval/config issue", "product/UX bug"].map((status) => (
              <MenuItem key={status} value={status}>{status}</MenuItem>
            ))}
          </TextField>
          <TextField
            size="small"
            label="Issue tag"
            value={filters.issueTag}
            onChange={(event) => setFilters((current) => ({ ...current, issueTag: event.target.value }))}
          />
          <TextField
            size="small"
            label="Prompt version"
            value={filters.promptVersionId}
            onChange={(event) => setFilters((current) => ({ ...current, promptVersionId: event.target.value }))}
          />
          <TextField
            size="small"
            label="Source title"
            value={filters.sourceTitle}
            onChange={(event) => setFilters((current) => ({ ...current, sourceTitle: event.target.value }))}
          />
          <Button startIcon={<RefreshIcon />} onClick={refreshAll} disabled={loading}>
            Refresh
          </Button>
        </Stack>
        <Divider sx={{ my: 2 }} />
        <Stack direction={{ xs: "column", md: "row" }} gap={1.5} alignItems={{ md: "center" }}>
          <Typography variant="body2" color="text.secondary">
            Bulk triage for selected rows
          </Typography>
          <Select
            size="small"
            value={bulkDisposition}
            onChange={(event) => setBulkDisposition(event.target.value)}
            sx={{ minWidth: 180 }}
          >
            {["prompt update", "KB/source fix", "retrieval/config issue", "product/UX bug"].map((value) => (
              <MenuItem key={value} value={value}>{value}</MenuItem>
            ))}
          </Select>
          <Select
            size="small"
            value={bulkReviewStatus}
            onChange={(event) => setBulkReviewStatus(event.target.value)}
            sx={{ minWidth: 160 }}
          >
            {["in_review", "actioned", "dismissed"].map((value) => (
              <MenuItem key={value} value={value}>{value}</MenuItem>
            ))}
          </Select>
          <Button variant="contained" onClick={handleApplyBulkDisposition} disabled={selectedFeedbackIds.length === 0}>
            Apply to {selectedFeedbackIds.length || 0}
          </Button>
        </Stack>
      </Paper>
      <Grid container spacing={2}>
        <Grid item xs={12} lg={6}>
          <Paper variant="outlined" sx={{ overflow: "hidden" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell>When</TableCell>
                  <TableCell>Issue</TableCell>
                  <TableCell>Summary</TableCell>
                  <TableCell>Recurring</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {feedbackItems.map((item) => (
                  <TableRow
                    key={item.feedbackId}
                    hover
                    selected={selectedFeedback?.feedback?.FeedbackId === item.feedbackId}
                    onClick={() => navigate(`/admin/user-feedback/${item.feedbackId}`)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell padding="checkbox" onClick={(event) => event.stopPropagation()}>
                      <Checkbox
                        checked={selectedFeedbackIds.includes(item.feedbackId)}
                        onChange={(event) => {
                          setSelectedFeedbackIds((current) =>
                            event.target.checked
                              ? [...current, item.feedbackId]
                              : current.filter((id) => id !== item.feedbackId)
                          );
                        }}
                      />
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap" }}>{formatDate(item.createdAt)}</TableCell>
                    <TableCell>
                      <Stack direction="row" gap={0.5} flexWrap="wrap">
                        {(item.issueTags || []).slice(0, 2).map((tag: string) => (
                          <Chip key={tag} size="small" label={tag} />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>{item.userPromptPreview || "No prompt preview"}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {item.summary || item.answerPreview}
                      </Typography>
                    </TableCell>
                    <TableCell>{item.recurrenceCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} lg={6}>
          <Paper variant="outlined" sx={{ p: 2, minHeight: 560 }}>
            {!selectedFeedback ? (
              <Typography color="text.secondary">Select a feedback record to review.</Typography>
            ) : (
              <Stack spacing={2}>
                <Typography variant="h6">Feedback detail</Typography>
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
                      <Typography variant="subtitle2" gutterBottom>User question</Typography>
                      <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                        {selectedFeedback.trace?.UserPrompt || selectedFeedback.feedback?.UserPromptPreview || "N/A"}
                      </Typography>
                      <Divider sx={{ my: 2 }} />
                      <Typography variant="subtitle2" gutterBottom>Answer</Typography>
                      <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                        {selectedFeedback.trace?.FinalAnswer || selectedFeedback.feedback?.AnswerPreview || "N/A"}
                      </Typography>
                      <Divider sx={{ my: 2 }} />
                      <Typography variant="subtitle2" gutterBottom>Sources</Typography>
                      <Stack direction="row" gap={0.75} flexWrap="wrap">
                        {(selectedFeedback.feedback?.SourceTitles || []).map((title: string) => (
                          <Chip key={title} size="small" label={title} />
                        ))}
                      </Stack>
                      <Divider sx={{ my: 2 }} />
                      <Typography variant="subtitle2" gutterBottom>Trace</Typography>
                      <Typography variant="caption" display="block" color="text.secondary">
                        Message ID: {selectedFeedback.trace?.MessageId || selectedFeedback.feedback?.MessageId}
                      </Typography>
                      <Typography variant="caption" display="block" color="text.secondary">
                        Prompt version: {selectedFeedback.feedback?.PromptVersionId || "unknown"}
                      </Typography>
                    </Paper>
                  </Grid>
                  <Grid item xs={12} md={6}>
                    <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
                      <Typography variant="subtitle2" gutterBottom>AI diagnosis</Typography>
                      <Typography variant="body2">
                        {(selectedFeedback.feedback?.Analysis || {}).summary || "No analysis available."}
                      </Typography>
                      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 1.5 }}>
                        <Chip size="small" label={`Root cause: ${(selectedFeedback.feedback?.Analysis || {}).likelyRootCause || "unknown"}`} />
                        <Chip size="small" label={`Action: ${(selectedFeedback.feedback?.Analysis || {}).recommendedAction || "pending"}`} />
                        <Chip size="small" label={`Cluster: ${selectedFeedback.feedback?.ClusterId || "n/a"}`} />
                      </Stack>
                      <Divider sx={{ my: 2 }} />
                      <TextField
                        select
                        fullWidth
                        size="small"
                        label="Disposition"
                        value={selectedFeedback.feedback?.Disposition || "pending"}
                        onChange={(event) =>
                          setSelectedFeedback((current: any) => ({
                            ...current,
                            feedback: { ...current.feedback, Disposition: event.target.value },
                          }))
                        }
                      >
                        {["pending", "prompt update", "KB/source fix", "retrieval/config issue", "product/UX bug"].map((value) => (
                          <MenuItem key={value} value={value}>{value}</MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        select
                        fullWidth
                        size="small"
                        label="Review status"
                        sx={{ mt: 1.5 }}
                        value={selectedFeedback.feedback?.ReviewStatus || "in_review"}
                        onChange={(event) =>
                          setSelectedFeedback((current: any) => ({
                            ...current,
                            feedback: { ...current.feedback, ReviewStatus: event.target.value },
                          }))
                        }
                      >
                        {["new", "analyzed", "in_review", "actioned", "dismissed"].map((value) => (
                          <MenuItem key={value} value={value}>{value}</MenuItem>
                        ))}
                      </TextField>
                      <TextField
                        fullWidth
                        size="small"
                        label="Owner"
                        sx={{ mt: 1.5 }}
                        value={owner}
                        onChange={(event) => setOwner(event.target.value)}
                      />
                      <TextField
                        fullWidth
                        size="small"
                        label="Resolution note"
                        sx={{ mt: 1.5 }}
                        multiline
                        minRows={2}
                        value={resolutionNote}
                        onChange={(event) => setResolutionNote(event.target.value)}
                      />
                      <TextField
                        fullWidth
                        size="small"
                        label="Admin notes"
                        sx={{ mt: 1.5 }}
                        multiline
                        minRows={3}
                        value={adminNotes}
                        onChange={(event) => setAdminNotes(event.target.value)}
                      />
                      <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mt: 2 }}>
                        <Button variant="contained" onClick={handleSaveReview}>Save review</Button>
                        <Button onClick={handleReanalyze}>Re-analyze</Button>
                        <Button onClick={handlePromoteCandidate}>Promote to candidate</Button>
                      </Stack>
                    </Paper>
                  </Grid>
                </Grid>
                {(selectedFeedback.similarReports || []).length > 0 && (
                  <Paper variant="outlined" sx={{ p: 2 }}>
                    <Typography variant="subtitle2" gutterBottom>Similar reports</Typography>
                    <List dense disablePadding>
                      {selectedFeedback.similarReports.map((item: any) => (
                        <ListItemButton
                          key={item.feedbackId}
                          onClick={() => navigate(`/admin/user-feedback/${item.feedbackId}`)}
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
    </Stack>
  );

  const renderClusters = () => (
    <Grid container spacing={2}>
      {(monitoring?.clusterSummaries || []).map((cluster: any) => (
        <Grid item xs={12} md={6} lg={4} key={cluster.clusterId}>
          <Paper variant="outlined" sx={{ p: 2, height: "100%" }}>
            <Stack spacing={1.5}>
              <Stack direction="row" justifyContent="space-between" gap={1}>
                <Typography variant="subtitle1" fontWeight={700}>{cluster.rootCause || "Unclassified"}</Typography>
                <Chip size="small" label={`${cluster.count} reports`} />
              </Stack>
              <Typography variant="body2">{cluster.summary || "No AI summary available."}</Typography>
              <Typography variant="caption" color="text.secondary">
                Prompt {cluster.promptVersionId || "unknown"} · {formatDate(cluster.latestCreatedAt)}
              </Typography>
              <Stack direction="row" gap={0.5} flexWrap="wrap">
                {(cluster.sourceTitles || []).map((title: string) => (
                  <Chip key={title} label={title} size="small" variant="outlined" />
                ))}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                Recommended action: {cluster.recommendedAction || "pending"}
              </Typography>
              <Button
                size="small"
                onClick={() => navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`)}
              >
                Open sample
              </Button>
            </Stack>
          </Paper>
        </Grid>
      ))}
    </Grid>
  );

  const renderPromptWorkspace = () => (
    <Grid container spacing={2}>
      <Grid item xs={12} lg={4}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Typography variant="h6">Prompt versions</Typography>
            <Button size="small" startIcon={<AddIcon />} onClick={handleCreateDraft}>
              Draft
            </Button>
          </Stack>
          <List dense>
            {promptData.items.map((item) => (
              <ListItemButton
                key={item.versionId}
                selected={item.versionId === selectedPromptId}
                onClick={() => setSelectedPromptId(item.versionId)}
              >
                <ListItemText
                  primary={item.title || item.versionId}
                  secondary={`${item.status} · ${item.versionId}${item.versionId === promptData.liveVersionId ? " · live" : ""}`}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      </Grid>
      <Grid item xs={12} lg={8}>
        <Stack spacing={2}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Stack direction={{ xs: "column", md: "row" }} gap={1} justifyContent="space-between">
              <Typography variant="h6">{currentPrompt?.title || "Select a prompt"}</Typography>
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Button startIcon={<AutoFixHighIcon />} onClick={handleAiSuggestPrompt} disabled={!selectedPromptId}>
                  AI draft
                </Button>
                <Button onClick={handleSavePrompt} disabled={!selectedPromptId}>
                  Save draft
                </Button>
                <Button startIcon={<PublishIcon />} variant="contained" onClick={handlePublishPrompt} disabled={!selectedPromptId}>
                  Publish
                </Button>
              </Stack>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Linked feedback for AI draft: {selectedFeedbackIdsForPrompt.length}
            </Typography>
            <TextField
              fullWidth
              size="small"
              label="Title"
              sx={{ mt: 2 }}
              value={promptDraft.title}
              onChange={(event) => setPromptDraft((current) => ({ ...current, title: event.target.value }))}
            />
            <TextField
              fullWidth
              size="small"
              label="Notes"
              sx={{ mt: 1.5 }}
              value={promptDraft.notes}
              onChange={(event) => setPromptDraft((current) => ({ ...current, notes: event.target.value }))}
            />
            <TextField
              fullWidth
              multiline
              minRows={18}
              label="Prompt template"
              sx={{ mt: 1.5 }}
              value={promptDraft.template}
              onChange={(event) => setPromptDraft((current) => ({ ...current, template: event.target.value }))}
            />
          </Paper>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom>Diff against live prompt</Typography>
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 2,
                overflow: "auto",
                bgcolor: "grey.50",
                borderRadius: 1,
                fontFamily: "monospace",
                fontSize: "0.75rem",
                whiteSpace: "pre-wrap",
              }}
            >
              {promptDiff}
            </Box>
          </Paper>
        </Stack>
      </Grid>
    </Grid>
  );

  const renderMonitoring = () => (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">Core monitoring set</Typography>
            <Typography variant="h4">{monitoring?.coreMonitoringSet?.count || 0}</Typography>
            <Typography variant="body2" color="text.secondary">
              Provenance: {monitoring?.coreMonitoringSet?.provenance || "admin_curated"}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">Candidate set</Typography>
            <Typography variant="h4">{monitoring?.candidateSet?.count || 0}</Typography>
            <Typography variant="body2" color="text.secondary">
              Provenance: {monitoring?.candidateSet?.provenance || "feedback_candidate"}
            </Typography>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" color="text.secondary">Total feedback</Typography>
            <Typography variant="h4">{monitoring?.feedbackOverview?.totalFeedback || 0}</Typography>
            <Typography variant="body2" color="text.secondary">
              Sample size and provenance are shown separately from curated monitoring.
            </Typography>
          </Paper>
        </Grid>
      </Grid>
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom>Disposition mix</Typography>
            <Table size="small">
              <TableBody>
                {Object.entries(monitoring?.feedbackOverview?.dispositionCounts || {}).map(([label, count]) => (
                  <TableRow key={label}>
                    <TableCell>{label}</TableCell>
                    <TableCell align="right">{count as number}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" gutterBottom>Root cause mix</Typography>
            <Table size="small">
              <TableBody>
                {Object.entries(monitoring?.feedbackOverview?.rootCauseCounts || {}).map(([label, count]) => (
                  <TableRow key={label}>
                    <TableCell>{label}</TableCell>
                    <TableCell align="right">{count as number}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" gutterBottom>Prompt activity</Typography>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Prompt version</TableCell>
              <TableCell align="right">Feedback count</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(monitoring?.promptActivity || []).map((row: any) => (
              <TableRow key={row.promptVersionId}>
                <TableCell>{row.promptVersionId}</TableCell>
                <TableCell align="right">{row.feedbackCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Stack>
  );

  const renderSources = () => (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>Source</TableCell>
            <TableCell align="right">Negative feedback</TableCell>
            <TableCell>Top issues</TableCell>
            <TableCell>Prompt versions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {(monitoring?.sourceTriage || []).map((row: any) => (
            <TableRow key={row.sourceTitle}>
              <TableCell>{row.sourceTitle}</TableCell>
              <TableCell align="right">{row.count}</TableCell>
              <TableCell>
                <Stack direction="row" gap={0.5} flexWrap="wrap">
                  {(row.topIssueTags || []).map(([tag, count]: [string, number]) => (
                    <Chip key={tag} size="small" label={`${tag} (${count})`} />
                  ))}
                </Stack>
              </TableCell>
              <TableCell>
                <Stack direction="row" gap={0.5} flexWrap="wrap">
                  {(row.promptVersions || []).map((version: string) => (
                    <Chip key={version} size="small" label={version} variant="outlined" />
                  ))}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );

  return (
    <AdminPageLayout
      title="Feedback Ops"
      description="Triaging, clustering, prompt improvement, and monitoring for ABE."
      breadcrumbLabel="Feedback Ops"
    >
      <Stack spacing={2.5}>
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1}>
          <Box>
            <Typography variant="h5" fontWeight={700}>Feedback Ops</Typography>
            <Typography variant="body2" color="text.secondary">
              Use this workspace to move from raw complaints to prompt, source, retrieval, and product actions.
            </Typography>
          </Box>
          <Button startIcon={<RefreshIcon />} onClick={refreshAll} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </Button>
        </Stack>
        <Paper variant="outlined">
          <Tabs value={tab} onChange={(_, value) => setTab(value)} variant="scrollable" scrollButtons="auto">
            <Tab value="inbox" label="Inbox" />
            <Tab value="clusters" label="Clusters" />
            <Tab value="prompts" label="Prompt Workspace" />
            <Tab value="monitoring" label="Monitoring" />
            <Tab value="sources" label="Source Triage" />
          </Tabs>
        </Paper>
        {tab === "inbox" && renderInbox()}
        {tab === "clusters" && renderClusters()}
        {tab === "prompts" && renderPromptWorkspace()}
        {tab === "monitoring" && renderMonitoring()}
        {tab === "sources" && renderSources()}
      </Stack>
    </AdminPageLayout>
  );
}
