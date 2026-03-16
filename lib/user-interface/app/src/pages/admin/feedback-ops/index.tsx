import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  Drawer,
  IconButton,
  Paper,
  Stack,
  Tab,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import TimelineIcon from "@mui/icons-material/Timeline";
import CloseIcon from "@mui/icons-material/Close";
import AdminPageLayout from "../../../components/admin-page-layout";
import { useDocumentTitle } from "../../../common/hooks/use-document-title";
import { AppContext } from "../../../common/app-context";
import { ApiClient } from "../../../common/api-client/api-client";
import { useNotifications } from "../../../components/notif-manager";
import InboxView from "./InboxView";
import TrendsView from "./TrendsView";
import PromptWorkspace from "./PromptWorkspace";
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

type TabValue = "queue" | "trends" | "prompts";

export default function FeedbackOpsPage() {
  useDocumentTitle("Feedback Manager");
  const { feedbackId } = useParams();
  const appContext = useContext(AppContext);
  const { addNotification } = useNotifications();

  const [tab, setTab] = useState<TabValue>("queue");
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
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false);

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
      addNotification("error", error?.message || "Failed to refresh Feedback Manager.");
    } finally {
      setLoading(false);
    }
  }, [addNotification, feedbackId, loadFeedback, loadFeedbackDetail, loadMonitoring, loadPrompts, loadActivityLog]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (feedbackId) {
      setTab("queue");
      loadFeedbackDetail(feedbackId);
    } else {
      setSelectedFeedback(null);
    }
  }, [feedbackId, loadFeedbackDetail]);

  const handleFeedbackUpdated = useCallback(async () => {
    await Promise.all([loadFeedback(), loadMonitoring()]);
  }, [loadFeedback, loadMonitoring]);

  const handleCreateDraftFromCluster = useCallback((cluster: { rootCause?: string; summary?: string }) => {
    setTab("prompts");
  }, []);

  const negativeFeedback = useMemo(
    () => feedbackItems.filter((i) => i.feedbackKind !== "helpful"),
    [feedbackItems]
  );

  const pendingCount = negativeFeedback.filter((i) => i.disposition === "pending").length;

  return (
    <AdminPageLayout
      title="Feedback Manager"
      description="Review user feedback, spot trends, and improve ABE's responses."
      breadcrumbLabel="Feedback Manager"
    >
      <Stack spacing={2.5}>
        {/* Compact header row */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
          <Stack direction="row" gap={1} alignItems="center">
            {promptData.liveVersionId && (
              <Chip
                size="small"
                label={`Live prompt: ${promptData.liveVersionId}`}
                color="success"
                variant="outlined"
                sx={{ fontSize: "0.75rem", height: 26 }}
              />
            )}
          </Stack>
          <Stack direction="row" gap={0.5} alignItems="center">
            {activityLog.length > 0 && (
              <Tooltip title="View recent activity">
                <IconButton
                  size="small"
                  onClick={() => setActivityDrawerOpen(true)}
                  aria-label="View recent activity log"
                  sx={{ "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 } }}
                >
                  <TimelineIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Button
              size="small"
              startIcon={<RefreshIcon />}
              onClick={refreshAll}
              disabled={loading}
              sx={{ fontSize: "0.8125rem" }}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          </Stack>
        </Stack>

        {/* Tabs */}
        <Paper variant="outlined" sx={{ borderRadius: 1 }}>
          <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            variant="scrollable"
            scrollButtons="auto"
            aria-label="Feedback Manager sections"
            sx={{
              minHeight: 44,
              "& .MuiTab-root": { minHeight: 44, fontSize: "0.875rem", textTransform: "none" },
            }}
          >
            <Tab
              value="queue"
              label={
                <Stack direction="row" gap={0.75} alignItems="center">
                  Review Queue
                  {pendingCount > 0 && (
                    <Chip
                      size="small"
                      label={pendingCount}
                      color="error"
                      sx={{ height: 20, fontSize: "0.75rem", fontWeight: 600 }}
                    />
                  )}
                </Stack>
              }
            />
            <Tab value="trends" label="Trends" />
            <Tab value="prompts" label="Prompts" />
          </Tabs>
        </Paper>

        {/* Views */}
        {tab === "queue" && (
          <InboxView
            feedbackItems={negativeFeedback}
            selectedFeedback={selectedFeedback}
            filters={filters}
            loading={loading}
            apiClient={apiClient}
            monitoring={monitoring}
            onFiltersChange={setFilters}
            onRefresh={refreshAll}
            onSelectFeedback={setSelectedFeedback}
            onLoadFeedbackDetail={loadFeedbackDetail}
            onFeedbackUpdated={handleFeedbackUpdated}
            selectedFeedbackIds={selectedFeedbackIds}
            onSelectedFeedbackIdsChange={setSelectedFeedbackIds}
          />
        )}
        {tab === "trends" && (
          <TrendsView
            monitoring={monitoring}
            loading={loading}
            onCreateDraftFromCluster={handleCreateDraftFromCluster}
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
      </Stack>

      {/* Activity log drawer */}
      <Drawer
        anchor="right"
        open={activityDrawerOpen}
        onClose={() => setActivityDrawerOpen(false)}
        PaperProps={{ sx: { width: { xs: "100%", sm: 400 }, p: 3 } }}
      >
        <Stack spacing={2}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
              Recent Activity
            </Typography>
            <IconButton
              size="small"
              onClick={() => setActivityDrawerOpen(false)}
              aria-label="Close activity log"
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          </Stack>
          {activityLog.slice(0, 30).map((entry, i) => (
            <Stack
              key={i}
              spacing={0.25}
              sx={{
                py: 1,
                borderBottom: "1px solid",
                borderColor: "divider",
              }}
            >
              <Stack direction="row" gap={1} alignItems="center">
                <Chip
                  size="small"
                  label={label(entry.action)}
                  sx={{ height: 22, fontSize: "0.75rem" }}
                />
                <Typography variant="body2" sx={{ fontSize: "0.8125rem" }}>
                  {entry.entityType}
                </Typography>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                {formatDate(entry.createdAt)}
                {entry.actor && ` by ${entry.actor}`}
              </Typography>
            </Stack>
          ))}
          {activityLog.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No recent activity.
            </Typography>
          )}
        </Stack>
      </Drawer>
    </AdminPageLayout>
  );
}
