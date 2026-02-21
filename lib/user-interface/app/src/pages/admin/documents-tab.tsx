import {
  Box,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Paper,
  Button,
  Typography,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Checkbox,
  IconButton,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useCallback, useContext, useEffect, useState, useRef } from "react";
import { AdminDataType } from "../../common/types";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { getColumnDefinition } from "./columns";
import { Utils } from "../../common/utils";
import { useNotifications } from "../../components/notif-manager";

export interface DocumentsTabProps {
  tabChangeFunction: () => void;
  documentType: AdminDataType;
  statusRefreshFunction: () => void;
  lastSyncTime: string | null;
  setShowUnsyncedAlert: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function DocumentsTab(props: DocumentsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState<any[]>([]);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [showModalDelete, setShowModalDelete] = useState(false);
  const { addNotification, removeNotification } = useNotifications();
  const previousSyncStatusRef = useRef<boolean>(false);

  useEffect(() => {
    if (!props.lastSyncTime) {
      props.setShowUnsyncedAlert(false);
      return;
    }

    try {
      const lastSyncDate = new Date(props.lastSyncTime);

      if (isNaN(lastSyncDate.getTime())) {
        console.error("Invalid lastSyncTime format:", props.lastSyncTime);
        props.setShowUnsyncedAlert(false);
        return;
      }

      const hasUnsyncedFiles = pages.some((page) =>
        page.Contents?.some((file) => {
          const fileDate = new Date(file.LastModified);
          return fileDate > lastSyncDate;
        })
      );

      props.setShowUnsyncedAlert(hasUnsyncedFiles);
    } catch (error) {
      console.error("Error comparing sync time:", error);
      props.setShowUnsyncedAlert(false);
    }
  }, [pages, props.lastSyncTime, props.setShowUnsyncedAlert]);

  /** Function to get documents */
  const getDocuments = useCallback(
    async (params: { continuationToken?: string; pageIndex?: number }) => {
      setLoading(true);
      try {
        const result = await apiClient.knowledgeManagement.getDocuments(
          params?.continuationToken,
          params?.pageIndex
        );
        await props.statusRefreshFunction();
        setPages((current) => {
          if (typeof params.pageIndex !== "undefined") {
            current[params.pageIndex - 1] = result;
            return [...current];
          } else {
            return [...current, result];
          }
        });
      } catch (error) {
        console.error(Utils.getErrorMessage(error));
      }

      console.log(pages);
      setLoading(false);
    },
    [appContext, props.documentType]
  );

  useEffect(() => {
    getDocuments({});
  }, [getDocuments]);

  const onNextPageClick = async () => {
    const continuationToken =
      pages[currentPageIndex - 1]?.NextContinuationToken;

    if (continuationToken) {
      if (pages.length <= currentPageIndex) {
        await getDocuments({ continuationToken });
      }
      setCurrentPageIndex((current) =>
        Math.min(pages.length + 1, current + 1)
      );
    }
  };

  const onPreviousPageClick = async () => {
    setCurrentPageIndex((current) =>
      Math.max(1, Math.min(pages.length - 1, current - 1))
    );
  };

  const refreshPage = async () => {
    if (currentPageIndex <= 1) {
      await getDocuments({ pageIndex: currentPageIndex });
    } else {
      const continuationToken =
        pages[currentPageIndex - 2]?.NextContinuationToken!;
      await getDocuments({ continuationToken });
    }
  };

  const columnDefinitions = getColumnDefinition(props.documentType, () => {});

  const deleteSelectedFiles = async () => {
    if (!appContext) return;
    setLoading(true);
    setShowModalDelete(false);

    const apiClient = new ApiClient(appContext);
    try {
      await Promise.all(
        selectedItems.map((s) =>
          apiClient.knowledgeManagement.deleteFile(s.Key!)
        )
      );
    } catch (e) {
      addNotification("error", "Error deleting files");
      console.error(e);
    }
    await getDocuments({ pageIndex: currentPageIndex });

    setSelectedItems([]);
    setLoading(false);
  };

  useEffect(() => {
    if (!appContext) return undefined;
    const apiClient = new ApiClient(appContext);
    let intervalId: NodeJS.Timeout | null = null;

    const getStatus = async () => {
      try {
        const result = await apiClient.knowledgeManagement.kendraIsSyncing();
        console.log("Sync status check:", result);
        const isCurrentlySyncing = result != "DONE SYNCING";
        const wasSyncing = previousSyncStatusRef.current;

        console.log(
          `Sync status: wasSyncing=${wasSyncing}, isCurrentlySyncing=${isCurrentlySyncing}`
        );

        setSyncing(isCurrentlySyncing);

        if (wasSyncing && !isCurrentlySyncing) {
          console.log(
            "Sync completed! Transition detected: wasSyncing=true -> isCurrentlySyncing=false"
          );
          try {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await props.statusRefreshFunction();
          } catch (error) {
            console.error("Error calling statusRefreshFunction():", error);
          }
        }

        previousSyncStatusRef.current = isCurrentlySyncing;

        if (intervalId) {
          clearInterval(intervalId);
        }
        const pollInterval = isCurrentlySyncing ? 5000 : 10000;
        intervalId = setInterval(getStatus, pollInterval);
      } catch (error) {
        addNotification(
          "error",
          "Error checking sync status, please try again later."
        );
        console.error("Error checking sync status:", error);
      }
    };

    getStatus();

    return () => {
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [appContext, props]);

  const syncKendra = async () => {
    if (syncing) return;
    console.log("Starting sync...");
    setSyncing(true);
    previousSyncStatusRef.current = true;
    try {
      const state = await apiClient.knowledgeManagement.syncKendra();
      console.log("Sync started, response:", state);
      if (state != "STARTED SYNCING") {
        addNotification(
          "error",
          "Error running sync, please try again later."
        );
        setSyncing(false);
        previousSyncStatusRef.current = false;
        return;
      }
      setTimeout(async () => {
        try {
          const result = await apiClient.knowledgeManagement.kendraIsSyncing();
          const isCurrentlySyncing = result != "DONE SYNCING";
          setSyncing(isCurrentlySyncing);
          previousSyncStatusRef.current = isCurrentlySyncing;
          if (!isCurrentlySyncing) {
            await props.statusRefreshFunction();
          }
        } catch (error) {
          console.error("Error in immediate status check:", error);
        }
      }, 2000);
    } catch (error) {
      console.log(error);
      addNotification(
        "error",
        "Error running sync, please try again later."
      );
      setSyncing(false);
      previousSyncStatusRef.current = false;
    }
  };

  const currentItems =
    pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Contents || [];

  const isSelected = (item: any) =>
    selectedItems.some((s) => s.Key === item.Key);

  const toggleSelection = (item: any) => {
    setSelectedItems((prev) =>
      isSelected(item)
        ? prev.filter((s) => s.Key !== item.Key)
        : [...prev, item]
    );
  };

  const toggleSelectAll = () => {
    if (selectedItems.length === currentItems.length) {
      setSelectedItems([]);
    } else {
      setSelectedItems([...currentItems]);
    }
  };

  return (
    <>
      <Dialog
        open={showModalDelete}
        onClose={() => setShowModalDelete(false)}
      >
        <DialogTitle>
          {"Delete file" + (selectedItems.length > 1 ? "s" : "")}
        </DialogTitle>
        <DialogContent>
          <Typography>
            Do you want to delete{" "}
            {selectedItems.length == 1
              ? `file ${selectedItems[0]?.Key}?`
              : `${selectedItems.length} files?`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModalDelete(false)}>Cancel</Button>
          <Button onClick={deleteSelectedFiles} variant="contained">
            Ok
          </Button>
        </DialogActions>
      </Dialog>

      <Stack spacing={2}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
        >
          <Box>
            <Typography variant="h6">Files</Typography>
            <Typography variant="body2" color="text.secondary">
              Please expect a delay for your changes to be reflected. Press the
              refresh button to see the latest changes.
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <IconButton onClick={refreshPage} aria-label="Refresh">
              <RefreshIcon />
            </IconButton>
            <Button onClick={props.tabChangeFunction} variant="outlined" size="small">
              Add Files
            </Button>
            <Button
              variant="contained"
              color="error"
              size="small"
              disabled={selectedItems.length === 0}
              onClick={() => {
                if (selectedItems.length > 0) setShowModalDelete(true);
              }}
            >
              Delete
            </Button>
            <Button
              variant="contained"
              size="small"
              disabled={syncing}
              onClick={syncKendra}
            >
              {syncing ? (
                <Stack direction="row" spacing={1} alignItems="center">
                  <span>Syncing data...</span>
                  <CircularProgress size={16} color="inherit" />
                </Stack>
              ) : (
                "Sync data now"
              )}
            </Button>
          </Stack>
        </Stack>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress />
          </Box>
        ) : currentItems.length === 0 ? (
          <Box sx={{ textAlign: "center", p: 4 }}>
            <Typography color="text.secondary">No files available</Typography>
          </Box>
        ) : (
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      indeterminate={
                        selectedItems.length > 0 &&
                        selectedItems.length < currentItems.length
                      }
                      checked={
                        currentItems.length > 0 &&
                        selectedItems.length === currentItems.length
                      }
                      onChange={toggleSelectAll}
                    />
                  </TableCell>
                  {columnDefinitions.map((col) => (
                    <TableCell key={col.id} sx={{ fontWeight: "bold" }}>
                      {col.header}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {currentItems.map((item, index) => (
                  <TableRow
                    key={item.Key || index}
                    hover
                    selected={isSelected(item)}
                  >
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={isSelected(item)}
                        onChange={() => toggleSelection(item)}
                      />
                    </TableCell>
                    {columnDefinitions.map((col) => (
                      <TableCell key={col.id}>{col.cell(item)}</TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {pages.length > 0 && (
          <Stack
            direction="row"
            justifyContent="center"
            spacing={2}
            sx={{ py: 1 }}
          >
            <Button
              size="small"
              disabled={currentPageIndex <= 1}
              onClick={onPreviousPageClick}
            >
              Previous
            </Button>
            <Typography variant="body2" sx={{ alignSelf: "center" }}>
              Page {currentPageIndex}
            </Typography>
            <Button
              size="small"
              disabled={
                !pages[currentPageIndex - 1]?.NextContinuationToken
              }
              onClick={onNextPageClick}
            >
              Next
            </Button>
          </Stack>
        )}
      </Stack>
    </>
  );
}
