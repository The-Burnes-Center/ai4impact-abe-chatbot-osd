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
  Collapse,
  TextField,
  InputAdornment,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import AddIcon from "@mui/icons-material/Add";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { useCallback, useContext, useEffect, useMemo, useState, useRef } from "react";
import { AdminDataType } from "../../common/types";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { getColumnDefinition } from "./columns";
import { Utils } from "../../common/utils";
import { useNotifications } from "../../components/notif-manager";
import DataFileUpload from "./file-upload-tab";

function devError(...args: unknown[]) {
  if (import.meta.env.DEV) console.error(...args);
}

export interface DocumentsTabProps {
  documentType: AdminDataType;
  statusRefreshFunction: () => void;
  lastSyncTime: string | null;
  setShowUnsyncedAlert: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function DocumentsTab(props: DocumentsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext!);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState<any[]>([]);
  const [selectedItems, setSelectedItems] = useState<any[]>([]);
  const [showModalDelete, setShowModalDelete] = useState(false);
  const [showUploadArea, setShowUploadArea] = useState(false);
  const [search, setSearch] = useState("");
  const { addNotification } = useNotifications();
  const previousSyncStatusRef = useRef<boolean>(false);

  useEffect(() => {
    if (!props.lastSyncTime) {
      props.setShowUnsyncedAlert(false);
      return;
    }

    try {
      const lastSyncDate = new Date(props.lastSyncTime);

      if (isNaN(lastSyncDate.getTime())) {
        devError("Invalid lastSyncTime format:", props.lastSyncTime);
        props.setShowUnsyncedAlert(false);
        return;
      }

      // A file counts as "unsynced" only if it's both newer than the last
      // KB ingestion AND still missing an AI-generated summary. The
      // metadata-handler self-copies each processed file to write its
      // summary into S3 head metadata, which bumps LastModified on every
      // file we touch -- without that HasMetadata guard, every successful
      // sync would immediately re-flag every processed file as unsynced.
      const hasUnsyncedFiles = pages.some((page) =>
        page.Contents?.some(
          (file: { LastModified: string; HasMetadata?: boolean }) => {
            if (file.HasMetadata) return false;
            const fileDate = new Date(file.LastModified);
            return fileDate > lastSyncDate;
          }
        )
      );

      props.setShowUnsyncedAlert(hasUnsyncedFiles);
    } catch (error) {
      devError("Error comparing sync time:", error);
      props.setShowUnsyncedAlert(false);
    }
  }, [pages, props.lastSyncTime, props.setShowUnsyncedAlert]);

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
        devError(Utils.getErrorMessage(error));
      }

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

    const apiClient = new ApiClient(appContext!);
    try {
      await Promise.all(
        selectedItems.map((s) =>
          apiClient.knowledgeManagement.deleteFile(s.Key!)
        )
      );
    } catch (e) {
      addNotification("error", "Error deleting files");
      devError(e);
    }
    await getDocuments({ pageIndex: currentPageIndex });

    setSelectedItems([]);
    setLoading(false);
  };

  useEffect(() => {
    if (!appContext) return undefined;
    const apiClient = new ApiClient(appContext!);
    let intervalId: NodeJS.Timeout | null = null;

    const getStatus = async () => {
      try {
        const result = await apiClient.knowledgeManagement.kendraIsSyncing();
        const isCurrentlySyncing = result !== "DONE SYNCING";
        const wasSyncing = previousSyncStatusRef.current;

        setSyncing(isCurrentlySyncing);

        if (wasSyncing && !isCurrentlySyncing) {
          try {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await props.statusRefreshFunction();
          } catch (error) {
            devError("Error calling statusRefreshFunction():", error);
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
        devError("Error checking sync status:", error);
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
    setSyncing(true);
    previousSyncStatusRef.current = true;
    try {
      // Use the orchestrator (admin/sync-now) instead of the KB-only sync
      // endpoint so this single click also moves staged files into the KB
      // bucket and backfills any missing metadata summaries -- not just the
      // Bedrock ingestion. Falls through to the same status polling below.
      const result = await apiClient.sync.triggerSyncNow();
      if (result?.status !== "SUCCESS") {
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
          const status = await apiClient.knowledgeManagement.kendraIsSyncing();
          const isCurrentlySyncing = status !== "DONE SYNCING";
          setSyncing(isCurrentlySyncing);
          previousSyncStatusRef.current = isCurrentlySyncing;
          if (!isCurrentlySyncing) {
            await props.statusRefreshFunction();
          }
        } catch (error) {
          devError("Error in immediate status check:", error);
        }
      }, 2000);
    } catch (error) {
      devError(error);
      addNotification(
        "error",
        "Error running sync, please try again later."
      );
      setSyncing(false);
      previousSyncStatusRef.current = false;
    }
  };

  const handleUploadComplete = () => {
    setShowUploadArea(false);
    refreshPage();
    props.setShowUnsyncedAlert(true);
  };

  const currentItems =
    pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Contents || [];

  const q = search.trim().toLowerCase();
  const filteredItems = useMemo(
    () =>
      !q
        ? currentItems
        : currentItems.filter((item) =>
            (item.Key ?? "").toLowerCase().includes(q)
          ),
    [currentItems, q]
  );

  const isSelected = (item: any) =>
    selectedItems.some((s) => s.Key === item.Key);

  const toggleSelection = (item: any) => {
    setSelectedItems((prev) =>
      isSelected(item)
        ? prev.filter((s) => s.Key !== item.Key)
        : [...prev, item]
    );
  };

  const allFilteredSelected =
    filteredItems.length > 0 &&
    filteredItems.every((item) => isSelected(item));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedItems((prev) =>
        prev.filter(
          (s) => !filteredItems.some((f) => f.Key === s.Key)
        )
      );
    } else {
      setSelectedItems((prev) => {
        const byKey = new Set(prev.map((p) => p.Key));
        const merged = [...prev];
        for (const f of filteredItems) {
          if (!byKey.has(f.Key)) {
            byKey.add(f.Key);
            merged.push(f);
          }
        }
        return merged;
      });
    }
  };

  return (
    <>
      <Dialog
        open={showModalDelete}
        onClose={() => setShowModalDelete(false)}
        aria-labelledby="delete-files-dialog-title"
      >
        <DialogTitle id="delete-files-dialog-title">
          {"Delete file" + (selectedItems.length > 1 ? "s" : "")}
        </DialogTitle>
        <DialogContent>
          <Typography>
            Do you want to delete{" "}
            {selectedItems.length === 1
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
        {/* Toolbar */}
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
        >
          <Box sx={{ minWidth: 0, flex: 1, pr: 2 }}>
            <Typography variant="h6" component="h2">Files</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Please expect a delay for your changes to be reflected. Press
              the refresh button to see the latest changes.
            </Typography>
            <TextField
              size="small"
              placeholder="Search by file name or path"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              fullWidth
              inputProps={{ "aria-label": "Search documents" }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" color="action" />
                  </InputAdornment>
                ),
              }}
              sx={{ maxWidth: 420 }}
            />
          </Box>
          <Stack direction="row" spacing={1}>
            <IconButton onClick={refreshPage} aria-label="Refresh">
              <RefreshIcon />
            </IconButton>
            <Button
              onClick={() => setShowUploadArea((v) => !v)}
              variant={showUploadArea ? "contained" : "outlined"}
              size="small"
              startIcon={showUploadArea ? <ExpandLessIcon /> : <AddIcon />}
            >
              {showUploadArea ? "Close" : "Add Files"}
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
                  <CircularProgress size={16} color="inherit" aria-hidden="true" />
                </Stack>
              ) : (
                "Sync data now"
              )}
            </Button>
          </Stack>
        </Stack>

        {/* Inline upload area */}
        <Collapse in={showUploadArea} unmountOnExit>
          <Paper sx={{ p: 2.5 }}>
            <DataFileUpload
              inline
              onUploadComplete={handleUploadComplete}
            />
          </Paper>
        </Collapse>

        {/* File table */}
        {loading ? (
          <Box
            role="status"
            aria-label="Loading files"
            sx={{ display: "flex", justifyContent: "center", p: 4 }}
          >
            <CircularProgress aria-hidden="true" />
          </Box>
        ) : currentItems.length === 0 ? (
          <Box sx={{ textAlign: "center", p: 4 }}>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              No files yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Add files to the knowledge base using the &ldquo;Add Files&rdquo; button above.
            </Typography>
          </Box>
        ) : filteredItems.length === 0 ? (
          <Box sx={{ textAlign: "center", p: 4 }}>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              No matching files
            </Typography>
            <Typography variant="body2" color="text.secondary">
              No files match your search.
            </Typography>
          </Box>
        ) : (
          <TableContainer component={Paper}>
            <Table size="small" aria-label="Documents">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      indeterminate={
                        !allFilteredSelected &&
                        filteredItems.some((item) => isSelected(item))
                      }
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      aria-label="Select all documents"
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
                {filteredItems.map((item: any, index: number) => (
                  <TableRow
                    key={item.Key || index}
                    hover
                    selected={isSelected(item)}
                  >
                    <TableCell padding="checkbox">
                      <Checkbox
                        checked={isSelected(item)}
                        onChange={() => toggleSelection(item)}
                        aria-label={`Select ${item.Key}`}
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
