import {
  Typography,
  Stack,
  Paper,
  Breadcrumbs,
  Link,
  Alert,
  Tabs,
  Tab,
  Box,
} from "@mui/material";
import { useNavigate } from "react-router-dom";
import DocumentsTab from "./documents-tab";
import { CHATBOT_NAME } from "../../common/constants";
import { useState, useEffect, useContext } from "react";
import { Auth } from "aws-amplify";
import DataFileUpload from "./file-upload-tab.tsx";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";

export default function DataPage() {
  const navigate = useNavigate();
  const [admin, setAdmin] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState(0);
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [lastSyncTime, setLastSyncTime] = useState<string>("");
  const [lastSyncData, setLastSyncData] = useState<{
    status: string;
    startedAt: string | null;
    completedAt: string | null;
  } | null>(null);
  const [showUnsyncedAlert, setShowUnsyncedAlert] = useState(false);

  /** Function to get the last synced time */
  const refreshSyncTime = async () => {
    try {
      const syncData = await apiClient.knowledgeManagement.lastKendraSync();
      setLastSyncData(syncData);

      if (syncData.status === "COMPLETE" && syncData.completedAt) {
        const formattedTime = Utils.formatToEasternTime(syncData.completedAt);
        setLastSyncTime(formattedTime);
      } else if (syncData.status === "NO_SYNC_HISTORY") {
        setLastSyncTime("No sync history available");
      } else {
        setLastSyncTime("Unknown");
      }
    } catch (e) {
      console.log(e);
      setLastSyncTime("Error loading sync time");
    }
  };

  /** Checks for admin status */
  useEffect(() => {
    (async () => {
      try {
        const result = await Auth.currentAuthenticatedUser();
        if (!result || Object.keys(result).length === 0) {
          console.log("Signed out!");
          Auth.signOut();
          return;
        }
        const admin =
          result?.signInUserSession?.idToken?.payload["custom:role"];
        if (admin) {
          const data = JSON.parse(admin);
          if (data.includes("Admin") || data.includes("MasterAdmin")) {
            setAdmin(true);
          }
        }
      } catch (e) {
        console.log(e);
      }
    })();
  }, []);

  useEffect(() => {
    if (admin) {
      refreshSyncTime();
    }
  }, [admin]);

  if (!admin) {
    return (
      <Box
        sx={{
          height: "90vh",
          width: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Alert severity="error">
          You are not authorized to view this page!
        </Alert>
      </Box>
    );
  }

  return (
    <Stack spacing={3}>
      <Breadcrumbs>
        <Link
          component="button"
          underline="hover"
          onClick={() => navigate("/")}
        >
          {CHATBOT_NAME}
        </Link>
        <Typography color="text.primary">View Data</Typography>
      </Breadcrumbs>

      <Typography variant="h4">Data Dashboard</Typography>

      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          {lastSyncData?.status === "COMPLETE"
            ? `Last successful sync: ${lastSyncTime}`
            : lastSyncTime || "Last sync"}
        </Typography>
        <Stack spacing={1}>
          <Typography variant="body2">
            Manage the chatbot's data here. You can view, add, or remove data
            for the chatbot to reference.
          </Typography>
          <Typography variant="body2">
            Please make sure to sync data with the chatbot when you are done
            adding or removing new files.
          </Typography>
          {showUnsyncedAlert && (
            <Alert
              severity="warning"
              onClose={() => setShowUnsyncedAlert(false)}
            >
              Some files have been added or modified since the last sync. Please
              sync the data to ensure the chatbot has the latest information.
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
          <Tab label="Test Cases" />
        </Tabs>
        <Box sx={{ pt: 2 }}>
          {activeTab === 0 && (
            <DocumentsTab
              documentType="file"
              tabChangeFunction={() => setActiveTab(1)}
              statusRefreshFunction={refreshSyncTime}
              lastSyncTime={lastSyncData?.completedAt || null}
              setShowUnsyncedAlert={setShowUnsyncedAlert}
            />
          )}
          {activeTab === 1 && (
            <DataFileUpload tabChangeFunction={() => setActiveTab(0)} />
          )}
        </Box>
      </Box>
    </Stack>
  );
}
