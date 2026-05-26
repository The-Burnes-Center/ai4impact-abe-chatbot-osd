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
  Skeleton,
  Alert,
  Tooltip,
} from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import RefreshIcon from "@mui/icons-material/Refresh";
import AddIcon from "@mui/icons-material/Add";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ClearIcon from "@mui/icons-material/Clear";
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
type SyncChipStatus = "synced" | "syncing" | "failed" | "not_yet_synced";

type DocItem = {
  Key?: string;
  LastModified?: string;
  Size?: number;
  HasMetadata?: boolean;
  // Per-document Bedrock KB ingestion state -- hydrated from a separate
  // /s3-bucket-data?mode=syncStatus call so the file table can render
  // before Bedrock's slow paginated list returns. Undefined means we
  // haven't heard back from Bedrock yet for this file.
  SyncStatus?: SyncChipStatus;
};

export default function DocumentsTab(props: DocumentsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext!), [appContext]);
  const [filesLoading, setFilesLoading] = useState(true);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStats, setSyncStats] = useState<SyncStatistics | undefined>(undefined);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [allItems, setAllItems] = useState<DocItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<DocItem[]>([]);
  const [showModalDelete, setShowModalDelete] = useState(false);
  const [showUploadArea, setShowUploadArea] = useState(false);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const { addNotification } = useNotifications();
  const previousSyncStatusRef = useRef<boolean>(false);
  // Stash the parent's status-refresh callback in a ref so loadDocuments and
  // the sync-poll effect don't depend on its identity. If the parent passes
  // a non-memoized callback (which previously caused this tab to spam the
  // backend with /still-syncing calls on every render), the ref absorbs the
  // identity churn without retriggering the effects.
  const statusRefreshRef = useRef(props.statusRefreshFunction);
  useEffect(() => {
    statusRefreshRef.current = props.statusRefreshFunction;
  });

  // Debounce search input so each keystroke doesn't re-run the filter +
  // reset pagination. 200ms is short enough to feel instant but lets a
  // typist complete a word before re-rendering 500 rows.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim().toLowerCase()), 200);
    return () => clearTimeout(t);
  }, [search]);

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

  // Load the file list (fast path -- S3 list + metadata flags only). The
  // sync-status column is hydrated separately by loadSyncStatuses() so the
  // table appears in ~300-500ms instead of blocking on Bedrock.
  const loadDocuments = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!silent) setFilesLoading(true);
    try {
      const result = await apiClient.knowledgeManagement.getDocuments();
      const contents: DocItem[] = Array.isArray(result?.Contents) ? result.Contents : [];
      setAllItems((prev) => {
        // Preserve already-hydrated SyncStatus values so the chips don't
        // flicker back to "Loading…" on every silent refresh.
        const prevByKey = new Map(prev.map((p) => [p.Key, p.SyncStatus]));
        return contents.map((c) => ({ ...c, SyncStatus: prevByKey.get(c.Key) }));
      });
      statusRefreshRef.current();
    } catch (error) {
      const reason = Utils.getErrorMessage(error);
      devError("Failed to load documents:", reason);
      // The skeleton state can't tell admins *why* their list is empty;
      // surface the reason once so they know whether to retry, fix perms,
      // or escalate.
      if (!silent) addNotification("error", `Could not load files: ${reason}`);
    } finally {
      if (!silent) setFilesLoading(false);
    }
  }, [apiClient, addNotification]);

  const loadSyncStatuses = useCallback(
    async ({ silent = false, refresh = false }: { silent?: boolean; refresh?: boolean } = {}) => {
      if (!silent) setStatusLoading(true);
      setStatusError(null);
      try {
        const { syncStatus } = await apiClient.knowledgeManagement.getSyncStatusMap(refresh);
        setAllItems((prev) =>
          prev.map((item) =>
            item.Key ? { ...item, SyncStatus: syncStatus[item.Key] || "not_yet_synced" } : item,
          ),
        );
      } catch (e) {
        devError("Error loading sync statuses:", e);
        if (!silent) setStatusError("Could not load sync status — chips may be out of date.");
      } finally {
        if (!silent) setStatusLoading(false);
      }
    },
    [apiClient],
  );

  useEffect(() => {
    loadDocuments();
    loadSyncStatuses();
  }, [loadDocuments, loadSyncStatuses]);

  const refreshPage = async () => {
    await Promise.all([loadDocuments(), loadSyncStatuses({ refresh: true })]);
  };

  const columnDefinitions = useMemo(
    () => getColumnDefinition(props.documentType, () => {}, { syncStatusLoading: statusLoading }),
    [props.documentType, statusLoading],
  );

  const deleteSelectedFiles = async () => {
    if (!appContext) return;
    setFilesLoading(true);
    setShowModalDelete(false);

    const results = await Promise.allSettled(
      selectedItems.map((s) => apiClient.knowledgeManagement.deleteFile(s.Key!)),
    );
    // Pair each rejection with its file key + the server-supplied reason
    // (e.g. "User is not authorized..." or "Failed to remove document from
    // knowledge base..."). Without the reason, the admin can't tell whether
    // it's a permissions issue, a KB cleanup failure, or transient network.
    const failures = results
      .map((r, i) => {
        if (r.status !== "rejected") return null;
        return {
          key: selectedItems[i].Key ?? "(unknown)",
          reason: Utils.getErrorMessage(r.reason),
        };
      })
      .filter((f): f is { key: string; reason: string } => !!f);

    // Most batch deletes share a root cause (e.g. all 403s). Showing the
    // *common* reason once is more useful than 50 truncated rows.
    const uniqueReasons = Array.from(new Set(failures.map((f) => f.reason).filter(Boolean)));

    if (failures.length === 0) {
      addNotification("success", `Deleted ${selectedItems.length} file${selectedItems.length === 1 ? "" : "s"}.`);
    } else if (failures.length === selectedItems.length) {
      const reasonLine =
        uniqueReasons.length === 1
          ? uniqueReasons[0]
          : uniqueReasons.length > 1
            ? uniqueReasons.join("; ")
            : "Please try again.";
      addNotification(
        "error",
        `Could not delete ${failures.length === 1 ? "file" : `${failures.length} files`}: ${reasonLine}`,
      );
    } else {
      const deleted = selectedItems.length - failures.length;
      const filesPreview = failures.slice(0, 3).map((f) => f.key).join(", ");
      const reasonHint =
        uniqueReasons.length === 1 ? ` (${uniqueReasons[0]})` : "";
      addNotification(
        "warning",
        `Deleted ${deleted} file${deleted === 1 ? "" : "s"}. ${failures.length} failed${reasonHint}: ${filesPreview}${failures.length > 3 ? "…" : ""}`,
      );
    }

    setSelectedItems([]);
    await loadDocuments();
    loadSyncStatuses({ silent: true, refresh: true });
    setFilesLoading(false);
  };

  // Mirror loadSyncStatuses in a ref so the polling effect below doesn't
  // need it in its dependency array -- otherwise every loadSyncStatuses
  // identity change tears down + restarts the interval (and immediately
  // re-fires kendraIsSyncing), causing the chip flicker users were seeing.
  const loadSyncStatusesRef = useRef(loadSyncStatuses);
  useEffect(() => {
    loadSyncStatusesRef.current = loadSyncStatuses;
  }, [loadSyncStatuses]);

  // Sync status polling. When syncing is in progress we poll Bedrock
  // ingestion stats every 5s and refresh per-doc sync chips every 15s
  // (without re-listing the full bucket). When idle we poll every 10s
  // mainly to detect background scheduled syncs starting.
  useEffect(() => {
    if (!appContext) return undefined;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let pollCount = 0;

    const tick = async () => {
      try {
        const result = await apiClient.knowledgeManagement.kendraIsSyncing();
        if (cancelled) return;

        const isCurrentlySyncing = result.status === "STILL_SYNCING";
        const wasSyncing = previousSyncStatusRef.current;

        setSyncing(isCurrentlySyncing);
        setSyncStats(isCurrentlySyncing ? result.statistics : undefined);

        if (wasSyncing && !isCurrentlySyncing) {
          // Sync just finished. Wait briefly for Bedrock to commit per-doc
          // status, then refresh chips (bypassing the 30s cache) without
          // re-listing the full bucket.
          pollCount = 0;
          setTimeout(() => {
            if (!cancelled) {
              loadSyncStatusesRef.current({ silent: true, refresh: true });
              statusRefreshRef.current();
            }
          }, 1200);
        } else if (isCurrentlySyncing) {
          // Roughly every 15s (every 3rd 5s poll), refresh the sync chips
          // so admins see "Not synced" → "Synced" flip live. We DON'T
          // re-list the bucket -- that's expensive and rarely useful
          // mid-sync.
          pollCount += 1;
          if (pollCount >= 3) {
            pollCount = 0;
            loadSyncStatusesRef.current({ silent: true, refresh: true });
          }
        }

        previousSyncStatusRef.current = isCurrentlySyncing;
      } catch (error) {
        devError("Error checking sync status:", error);
      } finally {
        if (!cancelled) {
          if (intervalId) clearInterval(intervalId);
          intervalId = setInterval(tick, previousSyncStatusRef.current ? 5000 : 10000);
        }
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [appContext, apiClient]);

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
      // status is polled separately above via kendraIsSyncing().
      await apiClient.sync.triggerSyncNow();
      addNotification("info", "Sync started. The status will update automatically.");
    } catch (error) {
      devError(error);
      // Show the backend's specific error (e.g. model-access / Marketplace
      // subscription problems) rather than a generic "try again later" that
      // leaves admins guessing whether it's transient or actually broken.
      const reason = Utils.getErrorMessage(error);
      addNotification(
        "error",
        reason ? `Sync failed: ${reason}` : "Sync failed. Please try again later.",
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

  // Filter the FULL inventory by debounced search query. Previously search
  // only saw the current S3 page, so most matches were invisible until the
  // user paginated to them.
  const filteredItems = useMemo(
    () =>
      !debouncedSearch
        ? allItems
        : allItems.filter((item) =>
            (item.Key ?? "").toLowerCase().includes(debouncedSearch),
          ),
    [allItems, debouncedSearch],
  );

  // Reset to page 1 whenever the (debounced) search query changes so the
  // user always sees their results from the top.
  useEffect(() => {
    setCurrentPageIndex(1);
  }, [debouncedSearch]);

  const totalPages = Math.max(1, Math.ceil(filteredItems.length / PAGE_SIZE));
  const safePageIndex = Math.min(currentPageIndex, totalPages);
  const pageStart = (safePageIndex - 1) * PAGE_SIZE;
  const pageItems = filteredItems.slice(pageStart, pageStart + PAGE_SIZE);

  const isSelected = (item: DocItem) =>
    selectedItems.some((s) => s.Key === item.Key);

  const toggleSelection = (item: DocItem) => {
    setSelectedItems((prev) =>
      isSelected(item) ? prev.filter((s) => s.Key !== item.Key) : [...prev, item],
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
        prev.filter((s) => !pageItems.some((f) => f.Key === s.Key)),
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

  const totalSelectedSize = useMemo(
    () => selectedItems.reduce((sum, s) => sum + (s.Size ?? 0), 0),
    [selectedItems],
  );

  const showSkeletonRows = filesLoading && allItems.length === 0;
  const skeletonRowCount = 6;

  return (
    <>
      <Dialog
        open={showModalDelete}
        onClose={() => setShowModalDelete(false)}
        aria-labelledby="delete-files-dialog-title"
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle id="delete-files-dialog-title">
          {selectedItems.length === 1
            ? "Delete file?"
            : `Delete ${selectedItems.length} files?`}
        </DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 1.5 }}>
            This permanently removes the file
            {selectedItems.length === 1 ? "" : "s"} from the knowledge bucket.
            The chatbot will stop citing
            {selectedItems.length === 1 ? " it" : " them"} on the next sync.
          </Typography>
          <Paper
            variant="outlined"
            sx={{ maxHeight: 200, overflowY: "auto", p: 1.25 }}
          >
            <Stack spacing={0.5}>
              {selectedItems.slice(0, 50).map((item) => (
                <Stack
                  key={item.Key}
                  direction="row"
                  justifyContent="space-between"
                  spacing={2}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {item.Key}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {Utils.bytesToSize(item.Size ?? 0)}
                  </Typography>
                </Stack>
              ))}
              {selectedItems.length > 50 && (
                <Typography variant="caption" color="text.secondary">
                  …and {selectedItems.length - 50} more
                </Typography>
              )}
            </Stack>
          </Paper>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            Total: {Utils.bytesToSize(totalSelectedSize)}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowModalDelete(false)}>Cancel</Button>
          <Button onClick={deleteSelectedFiles} variant="contained" color="error">
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      <Stack spacing={2}>
        {/* Toolbar */}
        <Stack
          direction={{ xs: "column", md: "row" }}
          justifyContent="space-between"
          alignItems={{ xs: "stretch", md: "flex-end" }}
          spacing={2}
        >
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" component="h2">Files</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Files in the knowledge bucket. After uploading or deleting, run a
              sync so the chatbot reflects the changes.
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
                endAdornment: search ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => setSearch("")}
                      aria-label="Clear search"
                      edge="end"
                    >
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              }}
              sx={{ maxWidth: 420 }}
            />
          </Box>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Tooltip title="Refresh file list and sync status">
              <span>
                <IconButton
                  onClick={refreshPage}
                  aria-label="Refresh"
                  disabled={filesLoading}
                >
                  <RefreshIcon />
                </IconButton>
              </span>
            </Tooltip>
            <Button
              onClick={() => setShowUploadArea((v) => !v)}
              variant={showUploadArea ? "contained" : "outlined"}
              size="small"
              startIcon={showUploadArea ? <ExpandLessIcon /> : <AddIcon />}
            >
              {showUploadArea ? "Close" : "Add Files"}
            </Button>
            <Button
              variant="outlined"
              color="error"
              size="small"
              disabled={selectedItems.length === 0}
              onClick={() => {
                if (selectedItems.length > 0) setShowModalDelete(true);
              }}
            >
              {selectedItems.length > 0
                ? `Delete (${selectedItems.length})`
                : "Delete"}
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

        {statusError && <Alert severity="warning" onClose={() => setStatusError(null)}>{statusError}</Alert>}

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
        {showSkeletonRows ? (
          <TableContainer component={Paper}>
            <Table size="small" aria-label="Loading documents">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox disabled />
                  </TableCell>
                  {columnDefinitions.map((col) => (
                    <TableCell key={col.id} sx={{ fontWeight: "bold" }}>
                      {col.header}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {Array.from({ length: skeletonRowCount }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell padding="checkbox">
                      <Checkbox disabled />
                    </TableCell>
                    {columnDefinitions.map((col) => (
                      <TableCell key={col.id}>
                        <Skeleton variant="text" width={col.id === "name" ? "60%" : "70%"} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : allItems.length === 0 ? (
          <Paper sx={{ textAlign: "center", p: 5 }}>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              No files yet
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Add files to the knowledge base using the &ldquo;Add Files&rdquo; button above.
            </Typography>
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={() => setShowUploadArea(true)}
            >
              Add Files
            </Button>
          </Paper>
        ) : filteredItems.length === 0 ? (
          <Paper sx={{ textAlign: "center", p: 5 }}>
            <Typography variant="subtitle1" component="h3" gutterBottom>
              No matching files
            </Typography>
            <Typography variant="body2" color="text.secondary">
              No files match &ldquo;{debouncedSearch}&rdquo;.
            </Typography>
            <Button
              size="small"
              onClick={() => setSearch("")}
              sx={{ mt: 1 }}
            >
              Clear search
            </Button>
          </Paper>
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
              {debouncedSearch
                ? `${filteredItems.length} of ${allItems.length} file${allItems.length === 1 ? "" : "s"}`
                : `${allItems.length} file${allItems.length === 1 ? "" : "s"}`}
              {filteredItems.length > 0 &&
                ` — showing ${pageStart + 1}–${Math.min(
                  pageStart + PAGE_SIZE,
                  filteredItems.length,
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
