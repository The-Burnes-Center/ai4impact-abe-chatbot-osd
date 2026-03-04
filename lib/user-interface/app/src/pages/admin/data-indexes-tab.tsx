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
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import { useContext, useEffect, useMemo, useState, useCallback } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import type { IndexInfo } from "../../common/api-client/excel-index-client";
import IndexCard, { type IndexApiAdapter } from "./index-card";

export default function DataIndexesTab() {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);

  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newDisplayName, setNewDisplayName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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

  const handleCreate = async () => {
    if (!newDisplayName.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      const indexName = newDisplayName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
      await apiClient.excelIndex.createIndex(indexName, newDisplayName.trim());
      setShowCreate(false);
      setNewDisplayName("");
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

  const buildAdapter = useCallback(
    (indexId: string): IndexApiAdapter => ({
      getStatus: () => apiClient.excelIndex.getStatus(indexId),
      getUploadUrl: () => apiClient.excelIndex.getUploadUrl(indexId),
      getPreview: () => apiClient.excelIndex.getPreview(indexId),
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
          description={`Upload a .xlsx file to replace the current data for this index. Columns will be auto-detected.`}
          api={buildAdapter(idx.index_name)}
          onDelete={() => handleDelete(idx.index_name)}
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
        onClose={() => setShowCreate(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Add New Index</DialogTitle>
        <DialogContent>
          <Stack spacing={2} pt={1}>
            <TextField
              label="Display Name"
              placeholder="e.g. Vehicle Fleet Index"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              fullWidth
              autoFocus
              disabled={creating}
            />
            {createError && <Alert severity="error">{createError}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowCreate(false)} disabled={creating}>
            Cancel
          </Button>
          <Button
            variant="contained"
            onClick={handleCreate}
            disabled={!newDisplayName.trim() || creating}
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
