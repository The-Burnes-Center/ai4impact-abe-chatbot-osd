import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
  Box,
  LinearProgress,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { useContext, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import type { IndexInfo } from "../../common/api-client/excel-index-client";
import { FileUploader } from "../../common/file-uploader";
import { Utils } from "../../common/utils";
import IndexCard, { type IndexApiAdapter } from "./index-card";

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export default function DataIndexesTab() {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);

  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newFile, setNewFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [justCreatedId, setJustCreatedId] = useState<string | null>(null);

  const loadIndexes = useCallback(async () => {
    setError(null);
    try {
      const list = await apiClient.excelIndex.listIndexes();
      setIndexes(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

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

      await apiClient.excelIndex.createIndex(
        indexName,
        newDisplayName.trim(),
        newDescription.trim() || undefined
      );

      const signedUrl = await apiClient.excelIndex.getUploadUrl(indexName);
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

  const handleDelete = async (indexId: string) => {
    try {
      await apiClient.excelIndex.deleteIndex(indexId);
      await loadIndexes();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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

  const buildAdapter = useCallback(
    (indexId: string): IndexApiAdapter => ({
      getStatus: () => apiClient.excelIndex.getStatus(indexId),
      getUploadUrl: () => apiClient.excelIndex.getUploadUrl(indexId),
      getPreview: () => apiClient.excelIndex.getPreview(indexId),
      updateIndex: (fields) => apiClient.excelIndex.updateIndex(indexId, fields),
    }),
    [apiClient]
  );

  if (loading) {
    return (
      <Stack alignItems="center" py={6}>
        <CircularProgress />
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
          description={idx.description || `Upload a .xlsx file to replace the current data for this index. Columns will be auto-detected.`}
          api={buildAdapter(idx.index_name)}
          onDelete={() => handleDelete(idx.index_name)}
          onUpdated={() => loadIndexes()}
          pollUntilReady={idx.index_name === justCreatedId}
          onStatusChange={(status) => {
            if (
              idx.index_name === justCreatedId &&
              status &&
              (status.status === "COMPLETE" || status.status === "ERROR")
            ) {
              setJustCreatedId(null);
            }
          }}
        />
      ))}

      {indexes.length === 0 && !error && (
        <Typography variant="body2" color="text.secondary" textAlign="center">
          No indexes registered yet. Click "Add New Index" to get started.
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
      >
        <DialogTitle>Add New Index</DialogTitle>
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
              label="Description (optional — AI will generate if left blank)"
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
                <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
                  {Utils.bytesToSize(newFile.size)}
                </Typography>
              )}
            </Box>
            {creating && uploadProgress > 0 && (
              <LinearProgress variant="determinate" value={uploadProgress} />
            )}
            {creating && uploadProgress === 0 && (
              <LinearProgress />
            )}
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
            {creating ? "Creating..." : "Create & Upload"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
