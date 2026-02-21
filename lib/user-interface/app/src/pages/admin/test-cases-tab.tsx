import {
  Button,
  Paper,
  Stack,
  Typography,
  Box,
  Alert,
  LinearProgress,
  IconButton,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import { useContext, useState, useRef } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { Utils } from "../../common/utils";
import { FileUploader } from "../../common/file-uploader";
import { useNavigate } from "react-router-dom";

const fileExtensions = new Set([".csv", ".json"]);

const mimeTypes = {
  ".csv": "text/csv",
  ".json": "application/json",
};

export interface FileUploadTabProps {
  tabChangeFunction: () => void;
}

type UploadStatus = "idle" | "in-progress" | "success" | "error";

export default function DataFileUpload(props: FileUploadTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [filesToUpload, setFilesToUpload] = useState<File[]>([]);
  const [fileErrors, setFileErrors] = useState<string[]>([]);
  const [globalError, setGlobalError] = useState<string | undefined>(undefined);
  const [uploadError, setUploadError] = useState<string | undefined>(undefined);
  const [uploadingStatus, setUploadingStatus] = useState<UploadStatus>("idle");
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [uploadingIndex, setUploadingIndex] = useState<number>(0);
  const [currentFileName, setCurrentFileName] = useState<string>("");
  const [uploadPanelDismissed, setUploadPanelDismissed] = useState<boolean>(false);

  const onSetFiles = (newFiles: File[]) => {
    const errors: string[] = [];
    const validFiles: File[] = [];
    setUploadError(undefined);

    if (newFiles.length > 100) {
      setUploadError("Max 100 files allowed");
      newFiles = newFiles.slice(0, 100);
    }

    for (let i = 0; i < newFiles.length; i++) {
      const file = newFiles[i];
      const fileExtension = file.name.split(".").pop()?.toLowerCase();

      if (!fileExtensions.has(`.${fileExtension}`)) {
        errors[i] = "Format not supported";
      } else if (file.size > 1000 * 1000 * 100) {
        errors[i] = "File size is too large, max 100MB";
      } else {
        validFiles.push(file);
      }
    }

    setFiles(newFiles);
    setFileErrors(errors);
    setFilesToUpload(validFiles);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const newFiles = [...files, ...Array.from(e.target.files)];
      onSetFiles(newFiles);
      e.target.value = "";
    }
  };

  const removeFile = (index: number) => {
    const newFiles = files.filter((_, i) => i !== index);
    onSetFiles(newFiles);
  };

  const onUpload = async () => {
    if (!appContext) return;
    setUploadingStatus("in-progress");
    setUploadProgress(0);
    setUploadingIndex(1);
    setUploadPanelDismissed(false);

    const uploader = new FileUploader();
    const totalSize = filesToUpload.reduce((acc, file) => acc + file.size, 0);
    let accumulator = 0;
    let hasError = false;

    for (let i = 0; i < filesToUpload.length; i++) {
      const file = filesToUpload[i];
      setCurrentFileName(file.name);
      let fileUploaded = 0;

      try {
        const fileExtension = file.name
          .slice(file.name.lastIndexOf("."))
          .toLowerCase();
        const fileType = mimeTypes[fileExtension];
        const result = await apiClient.evaluations.getUploadURL(
          file.name,
          fileType
        );
        try {
          await uploader.upload(
            file,
            result,
            fileType,
            (uploaded: number) => {
              fileUploaded = uploaded;
              const totalUploaded = fileUploaded + accumulator;
              const percent = Math.round((totalUploaded / totalSize) * 100);
              setUploadProgress(percent);
            }
          );

          accumulator += file.size;
          setUploadingIndex(Math.min(filesToUpload.length, i + 2));
        } catch (error) {
          console.error(error);
          setUploadingStatus("error");
          hasError = true;
          break;
        }
      } catch (error: any) {
        setGlobalError(Utils.getErrorMessage(error));
        console.error(Utils.getErrorMessage(error));
        setUploadingStatus("error");
        hasError = true;
        break;
      }
    }

    if (!hasError) {
      setUploadingStatus("success");
      setFilesToUpload([]);
      setFiles([]);
    }
  };

  const getProgressColor = (): "primary" | "success" | "error" => {
    if (uploadingStatus === "error") return "error";
    if (uploadingStatus === "success") return "success";
    return "primary";
  };

  return (
    <Stack spacing={2}>
      {globalError && <Alert severity="error">{globalError}</Alert>}

      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Test Case File Format Requirements
        </Typography>
        <Stack spacing={1}>
          <Typography variant="body2">
            Please ensure that your test case files follow one of the formats below:
          </Typography>
          <Typography variant="subtitle2">JSON Format (Recommended)</Typography>
          <ul>
            <li>
              <Typography variant="body2">
                File must be in JSON format with a .json extension.
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                File must contain an array of test case objects.
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                Each test case object must have <strong>question</strong> and{" "}
                <strong>expectedResponse</strong> fields.
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                File size should not exceed 100MB.
              </Typography>
            </li>
          </ul>
          <Typography variant="subtitle2">CSV Format</Typography>
          <ul>
            <li>
              <Typography variant="body2">
                File must be in CSV format with a .csv extension.
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                File must include a header in the first row with the columns{" "}
                <strong>question</strong>, <strong>expectedResponse</strong>
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                Each subsequent row should represent a single test case, with
                appropriate values in each column.
              </Typography>
            </li>
            <li>
              <Typography variant="body2">
                File size should not exceed 100MB.
              </Typography>
            </li>
          </ul>
        </Stack>
      </Paper>

      <Paper sx={{ p: 3 }}>
        <Stack spacing={2}>
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileChange}
            style={{ display: "none" }}
            accept={Array.from(fileExtensions).join(",")}
          />
          <Box
            sx={{
              border: "2px dashed",
              borderColor: "grey.400",
              borderRadius: 2,
              p: 4,
              textAlign: "center",
              cursor: "pointer",
              "&:hover": {
                borderColor: "primary.main",
                bgcolor: "action.hover",
              },
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <CloudUploadIcon
              sx={{ fontSize: 48, color: "grey.500", mb: 1 }}
            />
            <Typography variant="body1">
              Click to choose files or drag and drop
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {`Text documents up to 100MB supported (${Array.from(
                fileExtensions.values()
              ).join(", ")})`}
            </Typography>
          </Box>

          {uploadError && <Alert severity="error">{uploadError}</Alert>}

          {files.length > 0 && (
            <Stack spacing={0.5}>
              {files.map((file, i) => (
                <Stack
                  key={i}
                  direction="row"
                  alignItems="center"
                  spacing={1}
                  sx={{
                    py: 0.5,
                    px: 1,
                    bgcolor: "grey.50",
                    borderRadius: 1,
                  }}
                >
                  <Typography variant="body2" sx={{ flex: 1 }}>
                    {file.name} ({Utils.bytesToSize(file.size)})
                  </Typography>
                  {fileErrors[i] && (
                    <Typography variant="body2" color="error">
                      {fileErrors[i]}
                    </Typography>
                  )}
                  <IconButton size="small" onClick={() => removeFile(i)}>
                    <CloseIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      </Paper>

      {uploadingStatus !== "idle" && !uploadPanelDismissed && (
        <Alert
          severity={
            uploadingStatus === "error"
              ? "error"
              : uploadingStatus === "success"
              ? "success"
              : "info"
          }
          onClose={
            uploadingStatus === "success" || uploadingStatus === "error"
              ? () => setUploadPanelDismissed(true)
              : undefined
          }
          action={
            uploadingStatus === "success" ? (
              <Button
                color="inherit"
                size="small"
                onClick={props.tabChangeFunction}
              >
                View files
              </Button>
            ) : undefined
          }
        >
          <Typography variant="body2" gutterBottom>
            {uploadingStatus === "success" || uploadingStatus === "error"
              ? "Uploading files"
              : `Uploading files ${uploadingIndex} of ${filesToUpload.length}`}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={uploadProgress}
            color={getProgressColor()}
            sx={{ my: 1 }}
          />
          <Typography variant="caption">
            {uploadingStatus === "success"
              ? "Upload complete"
              : uploadingStatus === "error"
              ? "Upload failed"
              : currentFileName}
          </Typography>
        </Alert>
      )}

      <Stack direction="row" justifyContent="flex-end">
        <Button
          variant="contained"
          disabled={
            filesToUpload.length === 0 || uploadingStatus === "in-progress"
          }
          onClick={onUpload}
        >
          Upload files
        </Button>
      </Stack>
    </Stack>
  );
}
