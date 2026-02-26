import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  Typography,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { useContext, useState, useRef, useEffect } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { Utils } from "../../common/utils";
import { FileUploader } from "../../common/file-uploader";
import type { TradeIndexStatus, TradeIndexPreview } from "../../common/api-client/trade-index-client";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export default function TradeIndexTab() {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<TradeIndexStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadResult, setUploadResult] = useState<"idle" | "success" | "error">("idle");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TradeIndexPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const loadStatus = async () => {
    setStatusError(null);
    try {
      const data = await apiClient.tradeIndex.getStatus();
      setStatus(data);
    } catch (e) {
      setStatusError(Utils.getErrorMessage(e));
      setStatus(null);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "xlsx") {
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
      const signedUrl = await apiClient.tradeIndex.getUploadUrl();
      await uploader.upload(
        uploadFile,
        signedUrl,
        XLSX_MIME,
        (uploaded) => setUploadProgress(Math.round((uploaded / uploadFile.size) * 100))
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
          const data = await apiClient.tradeIndex.getStatus();
          setStatus(data);
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
      const data = await apiClient.tradeIndex.getPreview();
      setPreview(data);
    } catch (e) {
      setPreviewError(Utils.getErrorMessage(e));
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const lastUpdatedStr =
    status?.last_updated != null
      ? Utils.formatToEasternTime(status.last_updated)
      : null;

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Status
        </Typography>
        {statusError && (
          <Alert severity="error" sx={{ mb: 1 }}>
            {statusError}
          </Alert>
        )}
        {status != null && (
          <Typography variant="body2">
            {status.status === "PROCESSING" ? (
              <>Processing… (parsing uploaded file). Refresh in a moment.</>
            ) : status.status === "ERROR" || status.error_message ? (
              <>Error: {status.error_message ?? "Processing failed."}</>
            ) : status.status === "COMPLETE" || status.has_data ? (
              <>
                Ready — {status.row_count.toLocaleString()} rows
                {lastUpdatedStr != null ? ` (updated ${lastUpdatedStr})` : ""}
              </>
            ) : (
              <>No data. Upload a Trade Contract Index Excel file (.xlsx) below.</>
            )}
          </Typography>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Upload Trade Index (Excel)
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Upload a single .xlsx file. It will replace the current Trade index.
          This is separate from the Statewide Contract Index.
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
            sx={{ mt: 2, maxWidth: 400 }}
          />
        )}
        {uploadResult === "success" && (
          <Alert severity="success" sx={{ mt: 2 }}>
            Upload complete. The index will update shortly. Refresh status to see the new row count.
          </Alert>
        )}
        {uploadResult === "error" && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {uploadError ?? "Upload failed. Please try again."}
          </Alert>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" gutterBottom>
          Preview
        </Typography>
        <Button
          variant="outlined"
          size="small"
          onClick={loadPreview}
          disabled={previewLoading || (status != null && !status.has_data)}
        >
          {previewLoading ? "Loading…" : "Show first 10 rows"}
        </Button>
        {previewError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {previewError}
          </Alert>
        )}
        {preview != null && preview.rows.length > 0 && (
          <TableContainer sx={{ mt: 2, maxHeight: 400 }}>
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
                        {String((row as Record<string, unknown>)[col] ?? "").slice(0, 40)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
        {preview != null && preview.rows.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            No rows in index.
          </Typography>
        )}
      </Paper>
    </Stack>
  );
}
