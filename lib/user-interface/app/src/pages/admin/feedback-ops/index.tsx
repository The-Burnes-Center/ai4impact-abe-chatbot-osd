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

function getDetailText(entry: ActivityLogEntry, key: string): string {
  const value = entry.details?.[key];
  return typeof value === "string" ? value : "";
}

function shortenId(value?: string): string {
  if (!value) return "";
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function describeActivity(entry: ActivityLogEntry): {
  title: string;
  description: string;
  meta: string[];
} {
  const questionPreview = getDetailText(entry, "questionPreview");
  const disposition = getDetailText(entry, "disposition");
  const reviewStatus = getDetailText(entry, "reviewStatus");
  const owner = getDetailText(entry, "owner");
  const promptVersionId = getDetailText(entry, "promptVersionId");
  const caseId = getDetailText(entry, "caseId");
  const title = getDetailText(entry, "title");
  const feedbackKind = getDetailText(entry, "feedbackKind");

  switch (entry.action) {
    case "disposition_set":
      return {
        title: questionPreview || `Feedback ${shortenId(entry.entityId)}`,
        description: `Review updated to ${label(reviewStatus || "new")} with ${label(disposition || "pending")}.`,
        meta: [owner ? `Owner: ${owner}` : "", promptVersionId ? `Prompt: ${promptVersionId}` : ""].filter(Boolean),
      };
    case "promoted_to_candidate":
      return {
        title: questionPreview || `Feedback ${shortenId(entry.entityId)}`,
        description: "Added to the candidate test library for follow-up evaluation.",
        meta: [caseId ? `Case: ${caseId}` : "", promptVersionId ? `Prompt: ${promptVersionId}` : ""].filter(Boolean),
      };
    case "feedback_deleted":
      return {
        title: questionPreview || `Feedback ${shortenId(entry.entityId)}`,
        description: "Feedback was permanently deleted from the review queue.",
        meta: [
          feedbackKind ? `Type: ${label(feedbackKind)}` : "",
          reviewStatus ? `Status: ${label(reviewStatus)}` : "",
          disposition ? `Action: ${label(disposition)}` : "",
        ].filter(Boolean),
      };
    case "prompt_published":
      return {
        title: title || `Prompt ${entry.entityId}`,
        description: `Version ${entry.entityId} is now live.`,
        meta: [],
      };
    case "prompt_deleted":
      return {
        title: title || `Prompt ${entry.entityId}`,
        description: "Draft prompt deleted.",
        meta: [],
      };
    case "prompt_created":
      return {
        title: title || `Prompt ${entry.entityId}`,
        description: "New draft prompt created.",
        meta: [],
      };
    case "prompt_updated":
      return {
        title: title || `Prompt ${entry.entityId}`,
        description: "Draft prompt updated.",
        meta: [],
      };
    default:
      return {
        title: label(entry.action),
        description: `${label(entry.entityType)} ${shortenId(entry.entityId)}`,
        meta: [],
      };
  }
}

export default function FeedbackOpsPage() {
  useDocumentTitle("Feedback Manager");
  const { feedbackId } = useParams();
  const appContext = useContext(AppContext);
  const { addNotification } = useNotifications();

  const [tab, setTab] = useState<TabValue>("queue");
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<InboxFilters>({
    feedbackKind: "",
    reviewStatus: "",
    disposition: "",
    issueTag: "",
    promptVersionId: "",
    sourceTitle: "",
    rootCause: "",
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
    } catch (error: unknown) {
      addNotification("error", error instanceof Error ? error.message : "Failed to refresh Feedback Manager.");
    } finally {
      setLoading(false);
    }
  }, [addNotification, feedbackId, loadFeedback, loadFeedbackDetail, loadMonitoring, loadPrompts, loadActivityLog]);

  useEffect(() => {
    let isActive = true;
    if (!apiClient) {
      return undefined;
    }
    setLoading(true);
    Promise.all([loadMonitoring(), loadPrompts(), loadActivityLog()])
      .catch((error: unknown) => {
        if (isActive) {
          addNotification("error", error instanceof Error ? error.message : "Failed to load Feedback Manager.");
        }
      })
      .finally(() => {
        if (isActive) {
          setLoading(false);
        }
      });
    return () => {
      isActive = false;
    };
  }, [addNotification, apiClient, loadActivityLog, loadMonitoring, loadPrompts]);

  useEffect(() => {
    let isActive = true;
    if (!apiClient) {
      return undefined;
    }
    setLoading(true);
    loadFeedback()
      .catch((error: unknown) => {
        if (isActive) {
          addNotification("error", error instanceof Error ? error.message : "Failed to load feedback.");
        }
      })
      .finally(() => {
        if (isActive) {
          setLoading(false);
        }
      });
    return () => {
      isActive = false;
    };
  }, [addNotification, apiClient, loadFeedback]);

  useEffect(() => {
    if (feedbackId) {
      setTab("queue");
      loadFeedbackDetail(feedbackId);
    } else {
      setSelectedFeedback(null);
    }
  }, [feedbackId, loadFeedbackDetail]);

  const handleFeedbackUpdated = useCallback(async () => {
    await Promise.all([loadFeedback(), loadMonitoring(), loadActivityLog()]);
  }, [loadActivityLog, loadFeedback, loadMonitoring]);

  const handleCreateDraftFromCluster = useCallback(() => {
    setTab("prompts");
  }, []);

  const pendingCount = feedbackItems.filter(
    (i) => i.feedbackKind !== "helpful" && i.disposition === "pending"
  ).length;

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
            feedbackItems={feedbackItems}
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
          {activityLog.slice(0, 30).map((entry, i) => {
            const activity = describeActivity(entry);
            return (
              <Paper key={i} variant="outlined" sx={{ p: 1.5 }}>
                <Stack spacing={1}>
                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                    <Chip
                      size="small"
                      label={label(entry.action)}
                      sx={{ height: 22, fontSize: "0.75rem" }}
                    />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={label(entry.entityType)}
                      sx={{ height: 22, fontSize: "0.75rem" }}
                    />
                  </Stack>
                  <Box>
                    <Typography variant="body2" sx={{ fontSize: "0.875rem", fontWeight: 600 }}>
                      {activity.title}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ fontSize: "0.8125rem", mt: 0.25 }}>
                      {activity.description}
                    </Typography>
                  </Box>
                  {activity.meta.length > 0 && (
                    <Stack direction="row" gap={0.75} flexWrap="wrap">
                      {activity.meta.map((item) => (
                        <Chip
                          key={item}
                          size="small"
                          variant="outlined"
                          label={item}
                          sx={{ height: 22, fontSize: "0.75rem" }}
                        />
                      ))}
                    </Stack>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                    {formatDate(entry.createdAt)}
                    {entry.actor && ` by ${entry.actor}`}
                  </Typography>
                </Stack>
              </Paper>
            );
          })}
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
