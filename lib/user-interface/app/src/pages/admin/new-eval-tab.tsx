import {
  Box,
  Button,
  Paper,
  Stack,
  Typography,
  TextField,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  Radio,
  RadioGroup,
  FormControlLabel,
  CircularProgress,
  Alert,
  Stepper,
  Step,
  StepLabel,
  StepContent,
  LinearProgress,
  Chip,
  IconButton,
} from "@mui/material";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import RefreshIcon from "@mui/icons-material/Refresh";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import ErrorIcon from "@mui/icons-material/Error";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { Utils } from "../../common/utils";
import { useNotifications } from "../../components/notif-manager";

interface RunEvalTabProps {
  onComplete: () => void;
}

type SourceType = "upload" | "past" | "library";

interface EvalStep {
  name: string;
  status: string;
  chunksCompleted?: number;
  chunksTotal?: number;
}

export default function NewEvalTab({ onComplete }: RunEvalTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const { addNotification } = useNotifications();

  const [sourceType, setSourceType] = useState<SourceType>("upload");
  const [evalName, setEvalName] = useState("");
  const [globalError, setGlobalError] = useState<string | undefined>();

  const [pastFiles, setPastFiles] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<any>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);

  const [libraryCount, setLibraryCount] = useState<number | null>(null);

  const [uploading, setUploading] = useState(false);
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [running, setRunning] = useState(false);
  const [evaluationId, setEvaluationId] = useState<string | null>(() =>
    sessionStorage.getItem("runningEvalId")
  );
  const [evalStatus, setEvalStatus] = useState<string>("PENDING");
  const [evalSteps, setEvalSteps] = useState<EvalStep[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const loadPastFiles = useCallback(async () => {
    setLoadingFiles(true);
    try {
      const result = await apiClient.evaluations.getDocuments();
      setPastFiles(result?.Contents || []);
    } catch {
      setPastFiles([]);
    } finally {
      setLoadingFiles(false);
    }
  }, [apiClient]);

  const loadLibraryStats = useCallback(async () => {
    try {
      const stats = await apiClient.evaluations.getTestLibraryStats();
      setLibraryCount(stats.total ?? 0);
    } catch {
      setLibraryCount(0);
    }
  }, [apiClient]);

  useEffect(() => {
    loadPastFiles();
    loadLibraryStats();
  }, [loadPastFiles, loadLibraryStats]);

  useEffect(() => {
    if (evaluationId) {
      setRunning(true);
      startPolling(evaluationId);
    }
    return () => stopPolling();
  }, []);

  const startPolling = (id: string) => {
    stopPolling();
    let consecutiveErrors = 0;
    const poll = async () => {
      try {
        const status = await apiClient.evaluations.getEvalStatus(id);
        consecutiveErrors = 0;
        setEvalStatus(status.status);
        setEvalSteps(status.steps || []);
        setElapsed(status.elapsedSeconds || 0);

        if (status.status === "SUCCEEDED" || status.status === "FAILED" || status.status === "TIMED_OUT" || status.status === "ABORTED") {
          stopPolling();
          sessionStorage.removeItem("runningEvalId");
          if (status.status === "SUCCEEDED") {
            addNotification("success", "Evaluation completed successfully!");
          } else {
            addNotification("error", `Evaluation ${status.status.toLowerCase()}`);
          }
        }
      } catch (err) {
        consecutiveErrors++;
        if (consecutiveErrors >= 6) {
          stopPolling();
          setEvalStatus("FAILED");
          setGlobalError("Lost connection to evaluation status. Please check the History tab for results.");
          sessionStorage.removeItem("runningEvalId");
        }
      }
    };
    poll();
    pollRef.current = setInterval(poll, 3000);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase();
    if (ext !== "json" && ext !== "csv") {
      setGlobalError("Only .json and .csv files are supported");
      return;
    }
    setUploading(true);
    setGlobalError(undefined);
    try {
      const signedUrl = await apiClient.evaluations.getUploadURL(file.name, file.type);
      await fetch(signedUrl, { method: "PUT", body: file, headers: { "Content-Type": file.type } });
      setUploadedFile(`test-cases/${file.name}`);
      addNotification("success", `Uploaded ${file.name}`);
    } catch (err) {
      setGlobalError(`Upload failed: ${Utils.getErrorMessage(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const handleRun = async () => {
    setGlobalError(undefined);
    const name = evalName.trim() || `Eval - ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;

    try {
      setRunning(true);
      let result: any;

      if (sourceType === "upload") {
        if (!uploadedFile) {
          setGlobalError("Please upload a file first");
          setRunning(false);
          return;
        }
        result = await apiClient.evaluations.startNewEvaluation(name, uploadedFile);
      } else if (sourceType === "past") {
        if (!selectedFile) {
          setGlobalError("Please select a file");
          setRunning(false);
          return;
        }
        result = await apiClient.evaluations.startNewEvaluation(name, selectedFile.Key);
      } else {
        const exported = await apiClient.evaluations.exportTestLibrary();
        if (!exported.items || exported.items.length === 0) {
          setGlobalError("Test library is empty. Add Q&A pairs first.");
          setRunning(false);
          return;
        }
        result = await apiClient.evaluations.startNewEvaluation(name, undefined, exported.items);
      }

      const id = result.evaluationId;
      setEvaluationId(id);
      sessionStorage.setItem("runningEvalId", id);
      startPolling(id);
    } catch (err) {
      setGlobalError(`Failed to start: ${Utils.getErrorMessage(err)}`);
      setRunning(false);
    }
  };

  const canRun =
    (sourceType === "upload" && !!uploadedFile) ||
    (sourceType === "past" && !!selectedFile) ||
    (sourceType === "library" && (libraryCount ?? 0) > 0);

  if (running) {
    const overallPct = evalSteps.length > 0
      ? (evalSteps.filter((s) => s.status === "completed").length / evalSteps.length) * 100
      : 0;

    const isTerminal = ["SUCCEEDED", "FAILED", "TIMED_OUT", "ABORTED"].includes(evalStatus);

    return (
      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          {isTerminal ? `Evaluation ${evalStatus.toLowerCase()}` : "Evaluation in progress"}
        </Typography>

        <Stepper orientation="vertical" activeStep={evalSteps.findIndex((s) => s.status === "running")}>
          {evalSteps.map((step, i) => (
            <Step key={step.name} completed={step.status === "completed"}>
              <StepLabel
                error={step.status === "failed"}
                icon={
                  step.status === "completed" ? <CheckCircleIcon color="success" /> :
                  step.status === "failed" ? <ErrorIcon color="error" /> :
                  step.status === "running" ? <CircularProgress size={24} /> :
                  undefined
                }
              >
                <Stack direction="row" spacing={1} alignItems="center">
                  <Typography>{step.name}</Typography>
                  {step.status === "running" && step.chunksTotal ? (
                    <Chip size="small" label={`${step.chunksCompleted}/${step.chunksTotal} chunks`} />
                  ) : step.status === "completed" ? (
                    <Chip size="small" label="Done" color="success" variant="outlined" />
                  ) : null}
                </Stack>
              </StepLabel>
              {step.status === "running" && step.chunksTotal ? (
                <StepContent>
                  <LinearProgress
                    variant="determinate"
                    value={(step.chunksCompleted! / step.chunksTotal) * 100}
                    sx={{ height: 8, borderRadius: 4 }}
                  />
                </StepContent>
              ) : null}
            </Step>
          ))}
        </Stepper>

        <Box sx={{ mt: 3 }}>
          <LinearProgress variant="determinate" value={overallPct} sx={{ height: 10, borderRadius: 5, mb: 1 }} />
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">
              {overallPct.toFixed(0)}% complete
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {Math.floor(elapsed / 60)}m {elapsed % 60}s elapsed
            </Typography>
          </Stack>
        </Box>

        {isTerminal && (
          <Stack direction="row" spacing={2} sx={{ mt: 3 }}>
            <Button variant="contained" onClick={onComplete}>
              View Results
            </Button>
            <Button
              variant="outlined"
              onClick={() => {
                setRunning(false);
                setEvaluationId(null);
                setEvalSteps([]);
                setEvalStatus("PENDING");
              }}
            >
              Run Another
            </Button>
          </Stack>
        )}
      </Paper>
    );
  }

  return (
    <Stack spacing={3}>
      {globalError && <Alert severity="error">{globalError}</Alert>}

      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Step 1: Choose Test Case Source
        </Typography>
        <RadioGroup value={sourceType} onChange={(e) => setSourceType(e.target.value as SourceType)}>
          <FormControlLabel value="upload" control={<Radio />} label="Upload New File" />
          <FormControlLabel value="past" control={<Radio />} label="Select from Past Uploads" />
          <FormControlLabel
            value="library"
            control={<Radio />}
            label={`Use Master Library${libraryCount !== null ? ` (${libraryCount} Q&A pairs)` : ""}`}
          />
        </RadioGroup>
      </Paper>

      {sourceType === "upload" && (
        <Paper sx={{ p: 3 }}>
          <input
            type="file"
            ref={fileInputRef}
            accept=".json,.csv"
            onChange={handleFileUpload}
            style={{ display: "none" }}
            aria-label="Choose evaluation file"
          />
          <Stack direction="row" spacing={2} alignItems="center">
            <Button
              variant="outlined"
              startIcon={<CloudUploadIcon />}
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading..." : "Choose File"}
            </Button>
            {uploadedFile && (
              <Chip label={uploadedFile.split("/").pop()} color="success" variant="outlined" />
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
            Supported formats: JSON, CSV. File will be auto-added to the Test Library.
          </Typography>
        </Paper>
      )}

      {sourceType === "past" && (
        <Paper sx={{ p: 2 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1">Past Uploads</Typography>
            <IconButton onClick={loadPastFiles} size="small" aria-label="Refresh past files">
              <RefreshIcon />
            </IconButton>
          </Stack>
          {loadingFiles ? (
            <Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
              <CircularProgress size={28} />
            </Box>
          ) : pastFiles.length === 0 ? (
            <Typography color="text.secondary" align="center" sx={{ py: 3 }}>
              No test case files found. Upload one first.
            </Typography>
          ) : (
            <TableContainer sx={{ maxHeight: 300 }}>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell padding="checkbox" />
                    <TableCell>File</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell>Size</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {pastFiles.map((file) => (
                    <TableRow
                      key={file.Key}
                      hover
                      selected={selectedFile?.Key === file.Key}
                      onClick={() => setSelectedFile(selectedFile?.Key === file.Key ? null : file)}
                      onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedFile(selectedFile?.Key === file.Key ? null : file); } }}
                      tabIndex={0}
                      sx={{ cursor: "pointer" }}
                      aria-selected={selectedFile?.Key === file.Key}
                    >
                      <TableCell padding="checkbox">
                        <Radio checked={selectedFile?.Key === file.Key} size="small" />
                      </TableCell>
                      <TableCell>{file.Key}</TableCell>
                      <TableCell>
                        {new Date(file.LastModified).toLocaleDateString()}
                      </TableCell>
                      <TableCell>{Utils.bytesToSize(file.Size)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      )}

      {sourceType === "library" && (
        <Paper sx={{ p: 3 }}>
          <Typography>
            All {libraryCount ?? 0} Q&A pairs from the master library will be used for evaluation.
          </Typography>
        </Paper>
      )}

      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Step 2: Configure & Run
        </Typography>
        <Stack direction="row" spacing={2} alignItems="center">
          <TextField
            label="Evaluation Name"
            placeholder={`Eval - ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`}
            value={evalName}
            onChange={(e) => setEvalName(e.target.value)}
            size="small"
            sx={{ minWidth: 300 }}
          />
          <Button variant="contained" onClick={handleRun} disabled={!canRun} size="large">
            Run Evaluation
          </Button>
        </Stack>
        {canRun && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {sourceType === "upload" && uploadedFile
              ? `Selected: ${uploadedFile.split("/").pop()}`
              : sourceType === "past" && selectedFile
                ? `Selected: ${selectedFile.Key}`
                : sourceType === "library"
                  ? `Using all ${libraryCount} Q&A pairs from master library`
                  : ""}
          </Typography>
        )}
      </Paper>
    </Stack>
  );
}
