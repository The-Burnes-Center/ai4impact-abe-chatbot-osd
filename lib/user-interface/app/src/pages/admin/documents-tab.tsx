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
import type { SyncStatistics } from "../../common/api-client/knowledge-management-client";

function devError(...args: unknown[]) {
  if (import.meta.env.DEV) console.error(...args);
}

// `total` comes from the S3 listing (excluding metadata.txt) and may drift
// against Bedrock's count -- Bedrock can include the metadata.txt summary
// file or briefly count docs flagged for delete, so scanned > total is
// possible. Clamp both the count and the percent so we never display
// nonsense like "200/199 (100%)".
function formatSyncLabel(stats: SyncStatistics | undefined, total: number): string {
  if (!stats) return "Syncing data...";
  const scanned = stats.scanned ?? 0;
  if (total > 0) {
    const display = Math.min(scanned, total);
    const pct = Math.min(100, Math.round((scanned / total) * 100));
    return `Syncing ${display}/${total} (${pct}%)`;
  }
  if (scanned > 0) return `Syncing ${scanned} docs...`;
  return "Syncing data...";
}

export interface DocumentsTabProps {
  documentType: AdminDataType;
  statusRefreshFunction: () => void;
  lastSyncTime: string | null;
  setShowUnsyncedAlert: React.Dispatch<React.SetStateAction<boolean>>;
}

const PAGE_SIZE = 25;

type DocItem = {
  Key?: string;
  LastModified?: string;
  Size?: number;
  HasMetadata?: boolean;
  // Per-document Bedrock KB ingestion state -- determined entirely on the
  // backend (get-s3 Lambda calls ListKnowledgeBaseDocuments and maps
  // Bedrock's wider status vocabulary into one of these four values).
  SyncStatus?: "synced" | "syncing" | "failed" | "not_yet_synced";
};

export default function DocumentsTab(props: DocumentsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext!);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStatistics | undefined>(undefined);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [allItems, setAllItems] = useState<DocItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<DocItem[]>([]);
  const [showModalDelete, setShowModalDelete] = useState(false);
  const [showUploadArea, setShowUploadArea] = useState(false);
  const [search, setSearch] = useState("");
  const { addNotification } = useNotifications();
  const previousSyncStatusRef = useRef<boolean>(false);
  const syncPollCountRef = useRef(0);

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
      const hasUnsyncedFiles = allItems.some((file) => {
        if (file.HasMetadata) return false;
        if (!file.LastModified) return false;
        return new Date(file.LastModified) > lastSyncDate;
      });

      props.setShowUnsyncedAlert(hasUnsyncedFiles);
    } catch (error) {
      devError("Error comparing sync time:", error);
      props.setShowUnsyncedAlert(false);
    }
  }, [allItems, props.lastSyncTime, props.setShowUnsyncedAlert]);

  // Load the entire bucket inventory in one call. The KB has at most a few
  // hundred files, the backend already pages internally through
  // ContinuationToken, and search needs to match across everything -- so
  // there's no benefit to per-click server-side pagination, and big downside
  // (search was scoped to the current page only). Pagination is purely
  // client-side over the filtered set below.
  const loadDocuments = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const result = await apiClient.knowledgeManagement.getDocuments();
      const contents: DocItem[] = Array.isArray(result?.Contents) ? result.Contents : [];
      setAllItems(contents);
      await props.statusRefreshFunction();
    } catch (error) {
      devError(Utils.getErrorMessage(error));
    }
    if (!silent) setLoading(false);
  }, [appContext, props.documentType]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const refreshPage = async () => {
    await loadDocuments();
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
    await loadDocuments();

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
        const isCurrentlySyncing = result.status === "STILL_SYNCING";
        const wasSyncing = previousSyncStatusRef.current;

        setSyncing(isCurrentlySyncing);
        setSyncStats(isCurrentlySyncing ? result.statistics : undefined);

        if (wasSyncing && !isCurrentlySyncing) {
          // Sync just transitioned to done -- without this, the SYNC column
          // keeps showing 'Syncing' / 'Not synced' until the user manually
          // refreshes, even though the work is finished. Wait a beat for
          // Bedrock to commit per-doc status, then re-pull the doc list
          // silently so the table updates in place.
          syncPollCountRef.current = 0;
          try {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            await Promise.all([
              props.statusRefreshFunction(),
              loadDocuments({ silent: true }),
            ]);
          } catch (error) {
            devError("Error refreshing after sync completion:", error);
          }
        } else if (isCurrentlySyncing) {
          // Roughly every 15s (every 3rd 5s poll), silently re-pull the doc
          // list so users see the SYNC column flip from 'Not synced' to
          // 'Synced' progressively, instead of having to refresh manually.
          syncPollCountRef.current += 1;
          if (syncPollCountRef.current >= 3) {
            syncPollCountRef.current = 0;
            loadDocuments({ silent: true }).catch((e) =>
              devError("Error silently refreshing docs during sync:", e),
            );
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
  }, [appContext, props, loadDocuments]);

  const syncKendra = async () => {
    if (syncing) return;
    setSyncing(true);
    previousSyncStatusRef.current = true;
    try {
      // Use the orchestrator (admin/sync-now) instead of the KB-only sync
      // endpoint so this single click also moves staged files into the KB
      // bucket and backfills any missing metadata summaries -- not just the
      // Bedrock ingestion. The endpoint kicks the orchestrator off
      // asynchronously and returns immediately; if the HTTP call resolves
      // without throwing, the dispatch succeeded. The Bedrock ingestion
      // status is polled separately below via kendraIsSyncing().
      await apiClient.sync.triggerSyncNow();
      setTimeout(async () => {
        try {
          const status = await apiClient.knowledgeManagement.kendraIsSyncing();
          const isCurrentlySyncing = status.status === "STILL_SYNCING";
          setSyncing(isCurrentlySyncing);
          setSyncStats(isCurrentlySyncing ? status.statistics : undefined);
          previousSyncStatusRef.current = isCurrentlySyncing;
          if (!isCurrentlySyncing) {
            await Promise.all([
              props.statusRefreshFunction(),
              loadDocuments({ silent: true }),
            ]);
          }
        } catch (error) {
          devError("Error in immediate status check:", error);
        }
      }, 2000);
    } catch (error) {
      devError(error);
      // Show the backend's specific error (e.g. model-access / Marketplace
      // subscription problems) rather than a generic "try again later" that
      // leaves admins guessing whether it's transient or actually broken.
      const reason = Utils.getErrorMessage(error);
      addNotification(
        "error",
        reason ? `Sync failed: ${reason}` : "Sync failed. Please try again later."
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

  const q = search.trim().toLowerCase();

  // Filter the FULL inventory by search query. Previously search only saw
  // the current S3 page, so most matches were invisible until the user
  // paginated to them -- defeating the point of a search box.
  const filteredItems = useMemo(
    () =>
      !q
        ? allItems
        : allItems.filter((item) =>
            (item.Key ?? "").toLowerCase().includes(q)
          ),
    [allItems, q]
  );

  // Reset to page 1 whenever the search query changes so the user always
  // sees their results from the top, not page 4 of stale pagination.
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [q]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePageIndex = Math.min(currentPageIndex, totalPages);
  const pageStart = (safePageIndex - 1) * PAGE_SIZE;
  const pageItems = filteredItems.slice(pageStart, pageStart + PAGE_SIZE);

  const isSelected = (item: DocItem) =>
    selectedItems.some((s) => s.Key === item.Key);

  const toggleSelection = (item: DocItem) => {
    setSelectedItems((prev) =>
      isSelected(item)
        ? prev.filter((s) => s.Key !== item.Key)
        : [...prev, item]
    );
  };

  // Header checkbox acts on the CURRENT page's rows only -- selecting
  // hundreds of files across all pages from a single click is rarely what
  // the user wants and is too easy to misclick into mass-delete.
  const allPageSelected =
    pageItems.length > 0 && pageItems.every((item) => isSelected(item));

  const togglePageSelectAll = () => {
    if (allPageSelected) {
      setSelectedItems((prev) =>
        prev.filter((s) => !pageItems.some((f) => f.Key === s.Key))
      );
    } else {
      setSelectedItems((prev) => {
        const byKey = new Set(prev.map((p) => p.Key));
        const merged = [...prev];
        for (const f of pageItems) {
          if (f.Key && !byKey.has(f.Key)) {
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
                  <span>{formatSyncLabel(syncStats, allItems.length)}</span>
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
        ) : allItems.length === 0 ? (
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
                        !allPageSelected &&
                        pageItems.some((item) => isSelected(item))
                      }
                      checked={allPageSelected}
                      onChange={togglePageSelectAll}
                      aria-label="Select all documents on this page"
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
                {pageItems.map((item, index) => (
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

        {filteredItems.length > 0 && (
          <Stack
            direction="row"
            justifyContent="space-between"
            alignItems="center"
            sx={{ py: 1 }}
          >
            <Typography variant="body2" color="text.secondary">
              {q
                ? `${filteredItems.length} of ${allItems.length} file${allItems.length === 1 ? "" : "s"}`
                : `${allItems.length} file${allItems.length === 1 ? "" : "s"}`}
              {filteredItems.length > 0 &&
                ` — showing ${pageStart + 1}–${Math.min(
                  pageStart + PAGE_SIZE,
                  filteredItems.length
                )}`}
            </Typography>
            <Stack direction="row" spacing={2} alignItems="center">
              <Button
                size="small"
                disabled={safePageIndex <= 1}
                onClick={() => setCurrentPageIndex((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Typography variant="body2">
                Page {safePageIndex} of {totalPages}
              </Typography>
              <Button
                size="small"
                disabled={safePageIndex >= totalPages}
                onClick={() =>
                  setCurrentPageIndex((p) => Math.min(totalPages, p + 1))
                }
              >
                Next
              </Button>
            </Stack>
          </Stack>
        )}
      </Stack>
    </>
  );
}
