import {
  Alert,
  Button,
  Collapse,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
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
}

interface IndexCardProps {
  title: string;
  description: string;
  api: IndexApiAdapter;
  onStatusChange?: (status: IndexStatus | null) => void;
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

  return (
    <Paper sx={{ p: 0, overflow: "hidden" }}>
      {/* Header */}
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ px: 2.5, py: 2 }}
      >
        <Stack spacing={0.25}>
          <Typography variant="subtitle1">{title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {statusError
              ? statusError
              : statusLabel(status)}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
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
      </Stack>

      {/* Upload section */}
      <Collapse in={showUpload}>
        <Stack spacing={1.5} sx={{ px: 2.5, pb: 2.5, pt: 0.5 }}>
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
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
            <TableContainer sx={{ maxHeight: 360 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    {preview.columns.slice(0, 8).map((col) => (
                      <TableCell key={col} sx={{ fontWeight: 600 }}>
                        {col.replace(/_/g, " ")}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.rows.map((row, i) => (
                    <TableRow key={i}>
                      {preview.columns.slice(0, 8).map((col) => (
                        <TableCell key={col}>
                          {String(row[col] ?? "").slice(0, 40)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
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
