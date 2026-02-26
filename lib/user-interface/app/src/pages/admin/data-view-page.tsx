import { Typography, Paper, Alert, Tabs, Tab, Box, Stack } from "@mui/material";
import { useState, useEffect, useContext } from "react";
import DocumentsTab from "./documents-tab";
import DataFileUpload from "./file-upload-tab";
import ContractIndexTab from "./contract-index-tab";
import TradeIndexTab from "./trade-index-tab";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";
import AdminPageLayout from "../../components/admin-page-layout";

export default function DataPage() {
  const [activeTab, setActiveTab] = useState(0);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [lastSyncTime, setLastSyncTime] = useState("");
  const [lastSyncData, setLastSyncData] = useState<{
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null>(null);
  const [showUnsyncedAlert, setShowUnsyncedAlert] = useState(false);

  const refreshSyncTime = async () => {
    try {
      const syncData = await apiClient.knowledgeManagement.lastKendraSync();
      setLastSyncData(syncData);
      if (syncData.status === "COMPLETE" && syncData.completedAt) {
        setLastSyncTime(Utils.formatToEasternTime(syncData.completedAt));
      } else if (syncData.status === "NO_SYNC_HISTORY") {
        setLastSyncTime("No sync history available");
      } else {
        setLastSyncTime("Unknown");
      }
    } catch (e) {
      console.error("Error in refreshSyncTime():", e);
      setLastSyncTime("Error loading sync time");
    }
  };

  useEffect(() => {
    refreshSyncTime();
  }, []);

  return (
    <AdminPageLayout
      title="Data Dashboard"
      description="Manage the chatbot's knowledge base files."
      breadcrumbLabel="Data"
    >
      <Paper sx={{ p: 3 }}>
        <Typography variant="subtitle1" gutterBottom>
          {lastSyncData?.status === "COMPLETE"
            ? `Last successful sync: ${lastSyncTime}`
            : lastSyncTime}
        </Typography>
        <Stack spacing={1}>
          <Typography variant="body2" color="text.secondary">
            View, add, or remove files for the chatbot to reference. Sync data
            when finished adding or removing files.
          </Typography>
          {showUnsyncedAlert && (
            <Alert severity="warning" onClose={() => setShowUnsyncedAlert(false)}>
              Some files may have been added or modified since the last sync.
              Please sync with the &apos;Sync data now&apos; button.
            </Alert>
          )}
        </Stack>
      </Paper>

      <Box>
        <Tabs
          value={activeTab}
          onChange={(_, newValue) => setActiveTab(newValue)}
          sx={{ borderBottom: 1, borderColor: "divider" }}
        >
          <Tab label="Current Files" />
          <Tab label="Add Files" />
          <Tab label="Contract Index" />
          <Tab label="Trade Index" />
        </Tabs>
        <Box sx={{ pt: 2 }}>
          {activeTab === 0 && (
            <DocumentsTab
              tabChangeFunction={() => setActiveTab(1)}
              documentType="file"
              statusRefreshFunction={refreshSyncTime}
              lastSyncTime={lastSyncData?.completedAt || null}
              setShowUnsyncedAlert={setShowUnsyncedAlert}
            />
          )}
          {activeTab === 1 && (
            <DataFileUpload tabChangeFunction={() => setActiveTab(0)} />
          )}
          {activeTab === 2 && <ContractIndexTab />}
          {activeTab === 3 && <TradeIndexTab />}
        </Box>
      </Box>
    </AdminPageLayout>
  );
}
