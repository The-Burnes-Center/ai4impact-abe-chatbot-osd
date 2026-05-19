import {
  Typography,
  Paper,
  Alert,
  Tabs,
  Tab,
  Box,
  Stack,
  CircularProgress,
} from "@mui/material";
import { useState, useEffect, useContext } from "react";
import { useDocumentTitle } from "../../common/hooks/use-document-title";
import DocumentsTab from "./documents-tab";
import DataIndexesTab from "./data-indexes-tab";
import AutomationTab from "./automation-tab";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import AdminPageLayout from "../../components/admin-page-layout";
import StatusChip, { type StatusVariant } from "./status-chip";
import type { SyncSchedule } from "../../common/api-client/sync-client";

export default function DataPage() {
  useDocumentTitle("Admin \u00b7 Data");
  const [activeTab, setActiveTab] = useState(0);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext!);
  const [lastSyncTime, setLastSyncTime] = useState("");
  const [lastSyncData, setLastSyncData] = useState<{
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    // Present when status === "FAILED"; Bedrock's failure reason string.
    failureMessage?: string | null;
  } | null>(null);
  const [showUnsyncedAlert, setShowUnsyncedAlert] = useState(false);
  const [syncSchedule, setSyncSchedule] = useState<SyncSchedule | null>(null);

  const refreshSyncTime = async () => {
    try {
      const syncData =
        await apiClient.knowledgeManagement.lastKendraSync();
      setLastSyncData(syncData);
      if (syncData.status === "COMPLETE" && syncData.completedAt) {
        setLastSyncTime(Utils.formatToEasternTime(syncData.completedAt));
      } else if (syncData.status === "FAILED") {
        const when = syncData.completedAt
          ? Utils.formatToEasternTime(syncData.completedAt)
          : "recently";
        setLastSyncTime(`Failed ${when}`);
      } else if (syncData.status === "NO_SYNC_HISTORY") {
        setLastSyncTime("No sync history available");
      } else {
        setLastSyncTime("Unknown");
      }
    } catch {
      setLastSyncTime("Error loading sync time");
    }
  };

  useEffect(() => {
    refreshSyncTime();
    apiClient.sync.getSyncSchedule().then(setSyncSchedule).catch(() => {});
  }, []);

  const kbChipVariant = (): StatusVariant => {
    if (!lastSyncData) return "empty";
    if (lastSyncData.status === "COMPLETE") return "ready";
    if (lastSyncData.status === "FAILED") return "error";
    if (lastSyncData.status === "NO_SYNC_HISTORY") return "empty";
    return "processing";
  };

  const kbChipLabel = (): string => {
    if (!lastSyncData) return "Loading";
    if (lastSyncData.status === "COMPLETE") return "Synced";
    if (lastSyncData.status === "FAILED") return "Sync failed";
    if (lastSyncData.status === "NO_SYNC_HISTORY") return "Never synced";
    return "Syncing";
  };

  const kbDetail = (): string => {
    if (lastSyncData?.status === "COMPLETE" && lastSyncTime) {
      return lastSyncTime;
    }
    if (lastSyncData?.status === "FAILED") {
      // Show "Failed <when>" plus the Bedrock reason if we got one, so the
      // admin can see *why* it failed without digging into CloudWatch.
      const base = lastSyncTime || "Sync failed";
      return lastSyncData.failureMessage
        ? `${base} — ${lastSyncData.failureMessage}`
        : base;
    }
    return lastSyncTime || "";
  };

  const autoSyncChipVariant = (): StatusVariant => {
    if (!syncSchedule) return "empty";
    if (syncSchedule.enabled) return "ready";
    return "empty";
  };

  const autoSyncChipLabel = (): string => {
    if (!syncSchedule) return "Loading";
    if (syncSchedule.state === "NOT_FOUND") return "Not configured";
    return syncSchedule.enabled ? "Scheduled" : "Disabled";
  };

  const autoSyncDetail = (): string => {
    if (!syncSchedule) return "";
    return syncSchedule.humanReadable ?? "";
  };

  return (
    <AdminPageLayout
      title="Data Dashboard"
      description="Manage the chatbot's knowledge base and data indexes."
      breadcrumbLabel="Data"
    >
      {/* Status overview bar */}
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
      >
        <StatusCard
          title="KB Documents"
          detail={kbDetail()}
          chipVariant={kbChipVariant()}
          chipLabel={kbChipLabel()}
        />
        <StatusCard
          title="Auto-Sync"
          detail={autoSyncDetail()}
          chipVariant={autoSyncChipVariant()}
          chipLabel={autoSyncChipLabel()}
        />
      </Stack>

      {showUnsyncedAlert && (
        <Alert
          severity="warning"
          onClose={() => setShowUnsyncedAlert(false)}
        >
          Some files may have been added or modified since the last sync.
          Please sync with the &apos;Sync data now&apos; button.
        </Alert>
      )}

      {/* Tabs */}
      <Box>
        <Tabs
          value={activeTab}
          onChange={(_, newValue) => setActiveTab(newValue)}
          aria-label="Data sections"
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Documents" id="data-tab-0" aria-controls="data-tabpanel-0" />
          <Tab label="Data Indexes" id="data-tab-1" aria-controls="data-tabpanel-1" />
          <Tab label="Automation" id="data-tab-2" aria-controls="data-tabpanel-2" />
        </Tabs>
        <Box sx={{ pt: 2 }}>
          {activeTab === 0 && (
            <Box role="tabpanel" id="data-tabpanel-0" aria-labelledby="data-tab-0">
              <DocumentsTab
                documentType="file"
                statusRefreshFunction={refreshSyncTime}
                lastSyncTime={lastSyncData?.completedAt || null}
                setShowUnsyncedAlert={setShowUnsyncedAlert}
              />
            </Box>
          )}
          {activeTab === 1 && (
            <Box role="tabpanel" id="data-tabpanel-1" aria-labelledby="data-tab-1">
              <DataIndexesTab />
            </Box>
          )}
          {activeTab === 2 && (
            <Box role="tabpanel" id="data-tabpanel-2" aria-labelledby="data-tab-2">
              <AutomationTab onScheduleChange={setSyncSchedule} />
            </Box>
          )}
        </Box>
      </Box>
    </AdminPageLayout>
  );
}

/* ---- Internal status card used for the overview bar ---- */

interface StatusCardProps {
  title: string;
  detail: string;
  chipVariant: StatusVariant;
  chipLabel: string;
}

function StatusCard({ title, detail, chipVariant, chipLabel }: StatusCardProps) {
  const borderColors: Record<StatusVariant, string> = {
    ready: "success.main",
    processing: "warning.main",
    error: "error.main",
    empty: "divider",
  };

  return (
    <Paper
      sx={{
        flex: 1,
        px: 2.5,
        py: 2,
        borderLeft: 4,
        borderLeftColor: borderColors[chipVariant],
      }}
    >
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="subtitle2"
            component="span"
            color="text.secondary"
            noWrap
            sx={{ display: "block" }}
          >
            {title}
          </Typography>
          <Typography variant="body2" noWrap>
            {detail || (
              <CircularProgress
                size={14}
                aria-label="Loading"
                role="status"
                sx={{ verticalAlign: "middle" }}
              />
            )}
          </Typography>
        </Box>
        <StatusChip status={chipVariant} label={chipLabel} />
      </Stack>
    </Paper>
  );
}
