import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Skeleton,
  Stack,
  TextField,
  Typography,
  Box,
  LinearProgress,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import {
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import type { IndexInfo } from "../../common/api-client/excel-index-client";
import { FileUploader } from "../../common/file-uploader";
import { Utils } from "../../common/utils";
import IndexCard, { type IndexApiAdapter } from "./index-card";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function IndexCardSkeleton() {
  return (
    <Paper sx={{ p: 2.5 }}>
      <Stack spacing={1.5}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
        >
          <Stack spacing={0.75} flex={1}>
            <Skeleton variant="text" width="35%" height={24} />
            <Skeleton variant="text" width="55%" height={18} />
          </Stack>
          <Skeleton variant="rounded" width={80} height={24} />
        </Stack>
        <Stack direction="row" spacing={1}>
          <Skeleton variant="rounded" width={120} height={32} />
          <Skeleton variant="rounded" width={120} height={32} />
        </Stack>
      </Stack>
    </Paper>
  );
}

export default function DataIndexesTab() {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);

  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  // ── stable refs to prevent re-render cascades ──
  const apiClientRef = useRef(apiClient);
  apiClientRef.current = apiClient;
  const adapterCache = useRef(new Map<string, IndexApiAdapter>());
  const justCreatedIdRef = useRef<string | null>(null);
  justCreatedIdRef.current = justCreatedId;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── stable loadIndexes (uses ref, no deps) ──
  const loadIndexes = useCallback(async () => {
    setError(null);
    try {
      const list = await apiClientRef.current.excelIndex.listIndexes();
      setIndexes(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const debouncedRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => loadIndexes(), 400);
  }, [loadIndexes]);

  useEffect(() => {
    loadIndexes();
  }, [loadIndexes]);

  const resetCreateDialog = () => {
    setShowCreate(false);
    setNewDisplayName("");
    setNewDescription("");
    setNewFile(null);
    setCreateError(null);
    setUploadProgress(0);
  };

  const handleCreate = async () => {
    if (!newDisplayName.trim() || !newFile) return;
    setCreating(true);
    setCreateError(null);
    setUploadProgress(0);

    try {
      const indexName = newDisplayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

      await apiClientRef.current.excelIndex.createIndex(
        indexName,
        newDisplayName.trim(),
        newDescription.trim() || undefined
      );

      const signedUrl =
        await apiClientRef.current.excelIndex.getUploadUrl(indexName);
      const uploader = new FileUploader();
      await uploader.upload(newFile, signedUrl, XLSX_MIME, (uploaded) =>
        setUploadProgress(Math.round((uploaded / newFile.size) * 100))
      );

      resetCreateDialog();
      setJustCreatedId(indexName);
      await loadIndexes();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  // ── optimistic delete — remove card immediately ──
  const handleDelete = useCallback(
    async (indexId: string) => {
      setIndexes((prev) => prev.filter((i) => i.index_name !== indexId));
      adapterCache.current.delete(indexId);
      try {
        await apiClientRef.current.excelIndex.deleteIndex(indexId);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        loadIndexes();
      }
    },
    [loadIndexes]
  );

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setCreateError("Only .xlsx files are supported.");
      setNewFile(null);
      return;
    }
    setCreateError(null);
    setNewFile(file);
  };

  // ── stable adapter cache — same object reference per indexId ──
  const getAdapter = useCallback((indexId: string): IndexApiAdapter => {
    let adapter = adapterCache.current.get(indexId);
    if (!adapter) {
      adapter = {
        getStatus: () =>
          apiClientRef.current.excelIndex.getStatus(indexId),
        getUploadUrl: () =>
          apiClientRef.current.excelIndex.getUploadUrl(indexId),
        getPreview: () =>
          apiClientRef.current.excelIndex.getPreview(indexId),
        updateIndex: (fields) =>
          apiClientRef.current.excelIndex.updateIndex(indexId, fields),
      };
      adapterCache.current.set(indexId, adapter);
    }
    return adapter;
  }, []);

  // ── skeleton loading ──
  if (loading) {
    return (
      <Stack spacing={2.5}>
        <IndexCardSkeleton />
        <IndexCardSkeleton />
      </Stack>
    );
  }

  return (
    <Stack spacing={2.5}>
      {error && <Alert severity="error">{error}</Alert>}

      {indexes.map((idx) => (
        <IndexCard
          key={idx.index_name}
          title={idx.display_name || idx.index_name}
          description={idx.description || ""}
          api={getAdapter(idx.index_name)}
          onDelete={() => handleDelete(idx.index_name)}
          onUpdated={() => loadIndexes()}
          pollUntilReady={idx.index_name === justCreatedId}
          onStatusChange={(status) => {
            if (
              status &&
              (status.status === "COMPLETE" || status.status === "ERROR")
            ) {
              if (justCreatedIdRef.current === idx.index_name) {
                setJustCreatedId(null);
              }
              debouncedRefresh();
            }
          }}
        />
      ))}

      {indexes.length === 0 && !error && (
        <Typography variant="body2" color="text.secondary" textAlign="center">
          No indexes registered yet. Click &ldquo;Add New Index&rdquo; to get
          started.
        </Typography>
      )}

      <Button
        variant="outlined"
        startIcon={<AddIcon />}
        onClick={() => setShowCreate(true)}
        sx={{ alignSelf: "flex-start" }}
      >
        Add New Index
      </Button>

      <Dialog
        open={showCreate}
        onClose={creating ? undefined : resetCreateDialog}
        maxWidth="sm"
        fullWidth
        aria-labelledby="create-index-dialog-title"
      >
        <DialogTitle id="create-index-dialog-title">Add New Index</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} pt={1}>
            <TextField
              label="Index Name"
              placeholder="e.g. Vehicle Fleet Index"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              fullWidth
              autoFocus
              disabled={creating}
              required
            />
            <TextField
              label="Description (optional - AI will generate if left blank)"
              placeholder="e.g. Contains vendor contract data for statewide procurement"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              fullWidth
              disabled={creating}
              multiline
              minRows={2}
              maxRows={4}
            />
            <Box>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                style={{ display: "none" }}
                accept=".xlsx"
                aria-label="Choose .xlsx file"
              />
              <Button
                variant="outlined"
                startIcon={<CloudUploadIcon />}
                onClick={() => fileInputRef.current?.click()}
                disabled={creating}
              >
                {newFile ? newFile.name : "Choose .xlsx file"}
              </Button>
              {newFile && (
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ ml: 1.5 }}
                >
                  {Utils.bytesToSize(newFile.size)}
                </Typography>
              )}
            </Box>
            {creating && uploadProgress > 0 && (
              <LinearProgress variant="determinate" value={uploadProgress} />
            )}
            {creating && uploadProgress === 0 && <LinearProgress />}
            {createError && <Alert severity="error">{createError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={resetCreateDialog} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!newDisplayName.trim() || !newFile || creating}
          >
            {creating ? "Creating\u2026" : "Create & Upload"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
