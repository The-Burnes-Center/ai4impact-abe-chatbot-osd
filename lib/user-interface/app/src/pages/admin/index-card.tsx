import {
  Alert,
  Button,
  Collapse,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import EditIcon from "@mui/icons-material/Edit";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import { useState, useRef, useEffect, useCallback } from "react";
import { Utils } from "../../common/utils";
import { FileUploader } from "../../common/file-uploader";
import StatusChip, { type StatusVariant } from "./status-chip";

export interface IndexStatus {
  status: "NO_DATA" | "PROCESSING" | "COMPLETE" | "ERROR";
  has_data: boolean;
  row_count: number;
  last_updated: string | null;
  error_message: string | null;
}

export interface IndexPreview {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface IndexApiAdapter {
  getStatus: () => Promise<IndexStatus>;
  getUploadUrl: () => Promise<string>;
  getPreview: () => Promise<IndexPreview>;
  updateIndex: (fields: { display_name?: string; description?: string }) => Promise<unknown>;
}

interface IndexCardProps {
  title: string;
  description: string;
  api: IndexApiAdapter;
  onStatusChange?: (status: IndexStatus | null) => void;
  onDelete?: () => void;
  onUpdated?: () => void;
  /** When true, poll even while status is NO_DATA (for newly created indexes). */
  pollUntilReady?: boolean;
}

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function toChipVariant(s: IndexStatus | null): StatusVariant {
  if (!s) return "empty";
  if (s.status === "PROCESSING") return "processing";
  if (s.status === "ERROR" || s.error_message) return "error";
  if (s.status === "COMPLETE" || s.has_data) return "ready";
  return "empty";
}

function statusLabel(s: IndexStatus | null): string {
  if (!s) return "Loading...";
  if (s.status === "PROCESSING") return "Processing";
  if (s.status === "ERROR" || s.error_message)
    return s.error_message ?? "Error";
  if (s.status === "COMPLETE" || s.has_data) {
    const updated = s.last_updated
      ? ` (updated ${Utils.formatToEasternTime(s.last_updated)})`
      : "";
    return `${s.row_count.toLocaleString()} rows${updated}`;
  }
  return "No data";
}

export default function IndexCard({
  title,
  description,
  api,
  onStatusChange,
  onDelete,
  onUpdated,
  pollUntilReady,
}: IndexCardProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadResult, setUploadResult] = useState<
    "idle" | "success" | "error"
  >("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<IndexPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [editDesc, setEditDesc] = useState(description);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const data = await api.getStatus();
      setStatus(data);
      onStatusChange?.(data);
    } catch (e) {
      setStatusError(Utils.getErrorMessage(e));
      setStatus(null);
      onStatusChange?.(null);
    }
  }, [api, onStatusChange]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (!status) return undefined;
    const shouldPoll =
      status.status === "PROCESSING" ||
      (pollUntilReady && status.status === "NO_DATA");
    if (!shouldPoll) return undefined;

    const interval = setInterval(async () => {
      try {
        const data = await api.getStatus();
        setStatus(data);
        onStatusChange?.(data);
      } catch {
        /* ignore polling errors */
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [status?.status, pollUntilReady, api, onStatusChange]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setUploadFile(null);
      return;
    }
    setUploadFile(file);
    setUploadResult("idle");
  };

  const onUpload = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadResult("idle");
    setUploadError(null);
    const uploader = new FileUploader();
    try {
      const signedUrl = await api.getUploadUrl();
      await uploader.upload(uploadFile, signedUrl, XLSX_MIME, (uploaded) =>
        setUploadProgress(Math.round((uploaded / uploadFile.size) * 100))
      );
      setUploadResult("success");
      setUploadFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadStatus();

      const pollMs = 3000;
      const timeoutMs = 60000;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollMs));
        try {
          const data = await api.getStatus();
          setStatus(data);
          onStatusChange?.(data);
          if (data.status === "COMPLETE" || data.status === "ERROR") break;
        } catch {
          break;
        }
      }
    } catch (e) {
      setUploadResult("error");
      setUploadError(Utils.getErrorMessage(e));
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const loadPreview = async () => {
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const data = await api.getPreview();
      setPreview(data);
    } catch (e) {
      setPreviewError(Utils.getErrorMessage(e));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const togglePreview = () => {
    const next = !showPreview;
    setShowPreview(next);
    if (next && !preview && !previewLoading) loadPreview();
  };

  const startEditing = () => {
    setEditTitle(title);
    setEditDesc(description);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEditing = () => {
    setEditing(false);
    setSaveError(null);
  };

  const saveEdits = async () => {
    if (!editTitle.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.updateIndex({
        display_name: editTitle.trim(),
        description: editDesc.trim(),
      });
      setEditing(false);
      onUpdated?.();
    } catch (e) {
      setSaveError(Utils.getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper sx={{ p: 0, overflow: "hidden" }}>
      {/* Header */}
      <Stack
        direction="row"
        alignItems="flex-start"
        justifyContent="space-between"
        sx={{ px: 2.5, py: 2 }}
      >
        {editing ? (
          <Stack spacing={1.5} sx={{ flex: 1, mr: 2 }}>
            <TextField
              label="Title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              size="small"
              fullWidth
              disabled={saving}
              autoFocus
            />
            <TextField
              label="Description"
              value={editDesc}
              onChange={(e) => setEditDesc(e.target.value)}
              size="small"
              fullWidth
              disabled={saving}
              multiline
              minRows={2}
              maxRows={4}
            />
            {saveError && <Alert severity="error" sx={{ py: 0 }}>{saveError}</Alert>}
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="contained"
                startIcon={<CheckIcon />}
                onClick={saveEdits}
                disabled={saving || !editTitle.trim()}
              >
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button
                size="small"
                variant="outlined"
                startIcon={<CloseIcon />}
                onClick={cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack spacing={0.25} sx={{ flex: 1, mr: 1 }}>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <Typography variant="subtitle1">{title}</Typography>
              <Tooltip title="Edit title & description">
                <IconButton size="small" onClick={startEditing}>
                  <EditIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Stack>
            {description && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
                {description}
              </Typography>
            )}
            <Typography variant="body2" color="text.secondary">
              {statusError ? statusError : statusLabel(status)}
            </Typography>
          </Stack>
        )}
        <Stack direction="row" spacing={1} alignItems="center" sx={{ pt: 0.5 }}>
          <StatusChip
            status={toChipVariant(status)}
            label={toChipVariant(status) === "ready" ? "Ready" : toChipVariant(status) === "processing" ? "Processing" : toChipVariant(status) === "error" ? "Error" : "No data"}
          />
        </Stack>
      </Stack>

      {/* Action buttons */}
      <Stack
        direction="row"
        spacing={1}
        sx={{ px: 2.5, pb: 2 }}
      >
        <Button
          size="small"
          variant={showUpload ? "contained" : "outlined"}
          startIcon={showUpload ? <ExpandLessIcon /> : <CloudUploadIcon />}
          onClick={() => setShowUpload((v) => !v)}
        >
          {showUpload ? "Close" : "Replace Index"}
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={!status?.has_data}
          endIcon={showPreview ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          onClick={togglePreview}
        >
          {showPreview ? "Hide Preview" : "Preview Data"}
        </Button>
        {onDelete && (
          <Button
            size="small"
            variant="outlined"
            color="error"
            startIcon={<DeleteOutlineIcon />}
            onClick={onDelete}
          >
            Delete
          </Button>
        )}
      </Stack>

      {/* Upload section */}
      <Collapse in={showUpload}>
        <Stack spacing={1.5} sx={{ px: 2.5, pb: 2.5, pt: 0.5 }}>
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: "none" }}
            accept=".xlsx"
          />
          <Stack direction="row" alignItems="center" spacing={2}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<CloudUploadIcon />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              Choose file
            </Button>
            {uploadFile && (
              <Typography variant="body2">
                {uploadFile.name} ({Utils.bytesToSize(uploadFile.size)})
              </Typography>
            )}
            <Button
              variant="contained"
              size="small"
              disabled={!uploadFile || uploading}
              onClick={onUpload}
            >
              Upload
            </Button>
          </Stack>
          {uploading && (
            <LinearProgress
              variant="determinate"
              value={uploadProgress}
              sx={{ maxWidth: 400 }}
            />
          )}
          {uploadResult === "success" && (
            <Alert severity="success">
              Upload complete. The index will update shortly.
            </Alert>
          )}
          {uploadResult === "error" && (
            <Alert severity="error">
              {uploadError ?? "Upload failed. Please try again."}
            </Alert>
          )}
        </Stack>
      </Collapse>

      {/* Preview section */}
      <Collapse in={showPreview}>
        <Stack spacing={1} sx={{ px: 2.5, pb: 2.5 }}>
          {previewLoading && (
            <Typography variant="body2" color="text.secondary">
              Loading preview...
            </Typography>
          )}
          {previewError && (
            <Alert severity="error">{previewError}</Alert>
          )}
          {preview && preview.rows.length > 0 && (
            <>
              <Typography variant="body2" color="text.secondary">
                {preview.columns.length} column{preview.columns.length !== 1 ? "s" : ""}
                {" \u00b7 "}
                showing {preview.rows.length} sample row{preview.rows.length !== 1 ? "s" : ""}
              </Typography>
              <TableContainer sx={{ maxHeight: 400 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {preview.columns.map((col) => (
                        <TableCell key={col} sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                          {col.replace(/_/g, " ")}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {preview.rows.map((row, i) => (
                      <TableRow key={i}>
                        {preview.columns.map((col) => (
                          <TableCell key={col} sx={{ whiteSpace: "nowrap", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis" }}>
                            {String(row[col] ?? "")}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
          {preview && preview.rows.length === 0 && (
            <Typography variant="body2" color="text.secondary">
              No rows in index.
            </Typography>
          )}
        </Stack>
      </Collapse>
    </Paper>
  );
}
