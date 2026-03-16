import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  Collapse,
  Grid,
  Paper,
  Stack,
  Tab,
  Tabs,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import TimelineIcon from "@mui/icons-material/Timeline";
import AdminPageLayout from "../../../components/admin-page-layout";
import { useDocumentTitle } from "../../../common/hooks/use-document-title";
import { AppContext } from "../../../common/app-context";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";
import InboxView from "./InboxView";
import ClusterView from "./ClusterView";
import PromptWorkspace from "./PromptWorkspace";
import MonitoringView from "./MonitoringView";
import SourceTriageView from "./SourceTriageView";
import {
  FeedbackItem,
  FeedbackDetail,
  MonitoringData,
  PromptData,
  InboxFilters,
  ActivityLogEntry,
  formatDate,
  label,
} from "./types";

type TabValue = "inbox" | "clusters" | "prompts" | "monitoring" | "sources";

export default function FeedbackOpsPage() {
  useDocumentTitle("Feedback Manager");
  const { feedbackId } = useParams();
  const appContext = useContext(AppContext);
  const { addNotification } = useNotifications();

  const [tab, setTab] = useState<TabValue>("inbox");
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<InboxFilters>({
    reviewStatus: "",
    disposition: "",
    issueTag: "",
    promptVersionId: "",
    sourceTitle: "",
    dateFrom: "",
    dateTo: "",
    search: "",
  });
  const [feedbackItems, setFeedbackItems] = useState<FeedbackItem[]>([]);
  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackDetail | null>(null);
  const [selectedFeedbackIds, setSelectedFeedbackIds] = useState<string[]>([]);
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null);
  const [promptData, setPromptData] = useState<PromptData>({ items: [], liveVersionId: null });
  const [activityLog, setActivityLog] = useState<ActivityLogEntry[]>([]);
  const [showActivity, setShowActivity] = useState(false);

  const apiClient = useMemo(
    () => (appContext ? new ApiClient(appContext) : null),
    [appContext]
  );

  const loadFeedback = useCallback(async () => {
    if (!apiClient) return;
    const filterParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(filters)) {
      if (v) filterParams[k] = v;
    }
    const result = await apiClient.userFeedback.getAdminFeedback(filterParams);
    setFeedbackItems(result.items || []);
  }, [apiClient, filters]);

  const loadFeedbackDetail = useCallback(
    async (id: string) => {
      if (!apiClient || !id) return;
      const result = await apiClient.userFeedback.getAdminFeedbackDetail(id);
      setSelectedFeedback(result);
    },
    [apiClient]
  );

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

  const loadActivityLog = useCallback(async () => {
    if (!apiClient) return;
    try {
      const result = await apiClient.userFeedback.getActivityLog();
      setActivityLog(result.entries || []);
    } catch {
      // Activity log is non-critical
    }
  }, [apiClient]);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadFeedback(), loadMonitoring(), loadPrompts(), loadActivityLog()]);
      if (feedbackId) {
        await loadFeedbackDetail(feedbackId);
      }
    } catch (error: any) {
      addNotification("error", error?.message || "Failed to refresh Feedback Ops.");
    } finally {
      setLoading(false);
    }
  }, [addNotification, feedbackId, loadFeedback, loadFeedbackDetail, loadMonitoring, loadPrompts, loadActivityLog]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (feedbackId) {
      setTab("inbox");
      loadFeedbackDetail(feedbackId);
    } else {
      setSelectedFeedback(null);
    }
  }, [feedbackId, loadFeedbackDetail]);

  const handleFeedbackUpdated = useCallback(async () => {
    await Promise.all([loadFeedback(), loadMonitoring()]);
  }, [loadFeedback, loadMonitoring]);

  const pendingCount = feedbackItems.filter((i) => i.disposition === "pending").length;

  return (
    <AdminPageLayout
      title="Feedback Manager"
      description="Review user feedback, spot trends, and improve ABE's responses."
      breadcrumbLabel="Feedback Manager"
    >
      <Stack spacing={2.5}>
        {/* Header */}
        <Stack direction={{ xs: "column", md: "row" }} justifyContent="space-between" gap={1}>
          <Box>
            <Typography variant="h5" fontWeight={700}>
              Feedback Manager
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Review user feedback, spot trends, and improve ABE's responses.
            </Typography>
          </Box>
          <Stack direction="row" gap={1} alignItems="center">
            {promptData.liveVersionId && (
              <Chip
                size="small"
                label={`Live: ${promptData.liveVersionId}`}
                color="success"
                variant="outlined"
              />
            )}
            <Button
              startIcon={<RefreshIcon />}
              onClick={refreshAll}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          </Stack>
        </Stack>

        {/* Health Dashboard */}
        {monitoring?.health && (
          <Grid container spacing={2}>
            <Grid item xs={6} sm={3}>
              <Paper variant="outlined" sx={{ p: 1.5, borderLeft: "3px solid #1976d2" }}>
                <Typography variant="caption" color="text.secondary" fontWeight={600}>Current Prompt</Typography>
                <Typography variant="body2" fontWeight={700} noWrap>
                  {monitoring.health.livePromptVersionId}
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Paper variant="outlined" sx={{ p: 1.5, borderLeft: "3px solid #2e7d32" }}>
                <Typography variant="caption" color="text.secondary" fontWeight={600}>Total Reports</Typography>
                <Typography variant="h6" fontWeight={700}>{monitoring.health.totalFeedback}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Paper variant="outlined" sx={{ p: 1.5, borderLeft: `3px solid ${monitoring.health.pendingTriage > 10 ? "#d32f2f" : "#ed6c02"}` }}>
                <Typography variant="caption" color="text.secondary" fontWeight={600}>Needs Review</Typography>
                <Typography variant="h6" fontWeight={700} color={monitoring.health.pendingTriage > 10 ? "error" : "text.primary"}>
                  {monitoring.health.pendingTriage}
                </Typography>
              </Paper>
            </Grid>
            <Grid item xs={6} sm={3}>
              <Paper variant="outlined" sx={{ p: 1.5, borderLeft: `3px solid ${monitoring.health.negativeRate > 0.5 ? "#d32f2f" : "#9e9e9e"}` }}>
                <Typography variant="caption" color="text.secondary" fontWeight={600}>Negative %</Typography>
                <Typography variant="h6" fontWeight={700}>
                  {Math.round(monitoring.health.negativeRate * 100)}%
                </Typography>
              </Paper>
            </Grid>
          </Grid>
        )}

        {/* Activity Log (collapsible) */}
        {activityLog.length > 0 && (
          <Paper variant="outlined" sx={{ overflow: "hidden" }}>
            <Button
              fullWidth
              onClick={() => setShowActivity((v) => !v)}
              startIcon={<TimelineIcon />}
              endIcon={<ExpandMoreIcon sx={{ transform: showActivity ? "rotate(180deg)" : "rotate(0)", transition: "0.2s" }} />}
              sx={{ justifyContent: "space-between", px: 2, py: 1, textTransform: "none", color: "text.secondary" }}
            >
              Recent Activity ({activityLog.length})
            </Button>
            <Collapse in={showActivity}>
              <Box sx={{ px: 2, pb: 2, maxHeight: 250, overflow: "auto" }}>
                {activityLog.slice(0, 20).map((entry, i) => (
                  <Stack key={i} direction="row" gap={1.5} alignItems="baseline" sx={{ py: 0.5, borderBottom: "1px solid", borderColor: "divider" }}>
                    <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap", minWidth: 130 }}>
                      {formatDate(entry.createdAt)}
                    </Typography>
                    <Chip size="small" label={label(entry.action)} sx={{ height: 20, fontSize: "0.65rem" }} />
                    <Typography variant="caption">
                      {entry.entityType} <strong>{entry.entityId.slice(0, 12)}</strong>
                      {entry.actor && ` by ${entry.actor}`}
                    </Typography>
                  </Stack>
                ))}
              </Box>
            </Collapse>
          </Paper>
        )}

        {/* Tabs */}
        <Paper variant="outlined">
          <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            aria-label="Feedback Ops navigation"
          >
            <Tab
              value="inbox"
              label={
                <Stack direction="row" gap={0.75} alignItems="center">
                  Feedback
                  {pendingCount > 0 && (
                    <Chip
                      size="small"
                      label={pendingCount}
                      color="error"
                      sx={{ height: 18, fontSize: "0.65rem" }}
                    />
                  )}
                </Stack>
              }
            />
            <Tab value="clusters" label="Patterns" />
            <Tab value="prompts" label="Prompts" />
            <Tab value="monitoring" label="Dashboard" />
            <Tab value="sources" label="Documents" />
          </Tabs>
        </Paper>

        {/* Views */}
        {tab === "inbox" && (
          <InboxView
            feedbackItems={feedbackItems}
            selectedFeedback={selectedFeedback}
            filters={filters}
            loading={loading}
            apiClient={apiClient}
            onFiltersChange={setFilters}
            onRefresh={refreshAll}
            onSelectFeedback={setSelectedFeedback}
            onLoadFeedbackDetail={loadFeedbackDetail}
            onFeedbackUpdated={handleFeedbackUpdated}
            selectedFeedbackIds={selectedFeedbackIds}
            onSelectedFeedbackIdsChange={setSelectedFeedbackIds}
          />
        )}
        {tab === "clusters" && (
          <ClusterView
            clusters={monitoring?.clusterSummaries || []}
            loading={loading}
          />
        )}
        {tab === "prompts" && (
          <PromptWorkspace
            promptData={promptData}
            loading={loading}
            apiClient={apiClient}
            onRefresh={async () => {
              await loadPrompts();
              await loadMonitoring();
            }}
            selectedFeedbackIds={selectedFeedbackIds}
          />
        )}
        {tab === "monitoring" && (
          <MonitoringView
            monitoring={monitoring}
            loading={loading}
          />
        )}
        {tab === "sources" && (
          <SourceTriageView
            sources={monitoring?.sourceTriage || []}
            loading={loading}
          />
        )}
      </Stack>
    </AdminPageLayout>
  );
}
