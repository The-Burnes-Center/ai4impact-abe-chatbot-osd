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
  CircularProgress,
  Alert,
  IconButton,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useCallback, useContext, useEffect, useState } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { Utils } from "../../common/utils";
import { useNotifications } from "../../components/notif-manager";
import { getColumnDefinition } from "./columns";
import { AdminDataType } from "../../common/types";
import { useNavigate } from "react-router-dom";

export interface FileUploadTabProps {
  tabChangeFunction: () => void;
  documentType: AdminDataType;
}

export default function NewEvalTab(props: FileUploadTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const { addNotification } = useNotifications();
  const navigate = useNavigate();

  const [evalName, setEvalName] = useState<string>("SampleEvalName");
  const [globalError, setGlobalError] = useState<string | undefined>(undefined);

  const [loading, setLoading] = useState(true);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState<any[]>([]);
  const [selectedFile, setSelectedFile] = useState<any | null>(null);

  const onProblemClick = (newEvaluationItem) => {
    console.log("New Evaluation item: ", newEvaluationItem);
    if (newEvaluationItem && newEvaluationItem.EvaluationId) {
      navigate(`/admin/llm-evaluation/${newEvaluationItem.EvaluationId}`, {
        replace: true,
      });
    }
  };

  const onNewEvaluation = async () => {
    setGlobalError(undefined);

    if (evalName === "SampleEvalName" || evalName.trim() === "") {
      setGlobalError("Please enter a name for the evaluation");
      return;
    }

    if (!selectedFile) {
      setGlobalError("Please select a file for evaluation");
      return;
    }

    console.log("Selected file:", selectedFile);
    const fileExtension = selectedFile.Key.toLowerCase().split(".").pop();
    console.log("Detected file extension:", fileExtension);

    if (fileExtension !== "json" && fileExtension !== "csv") {
      console.log("Invalid file extension:", fileExtension);
      setGlobalError(
        `Please select a valid test case file (.json or .csv). Got: ${fileExtension}`
      );
      return;
    }

    try {
      setLoading(true);

      console.log("Starting evaluation with file:", selectedFile.Key);
      const result = await apiClient.evaluations.startNewEvaluation(
        evalName,
        selectedFile.Key
      );
      console.log("Evaluation result:", result);

      addNotification(
        "success",
        "Evaluation started successfully. It may take a few minutes to complete."
      );

      props.tabChangeFunction();
    } catch (error) {
      console.error("Error starting evaluation:", error);
      const errorMessage = Utils.getErrorMessage(error);

      if (
        errorMessage.includes("NetworkError") ||
        errorMessage.includes("Failed to fetch")
      ) {
        setGlobalError(
          "Network error: Unable to connect to the evaluation service"
        );
        addNotification(
          "error",
          "Network error: Unable to connect to the evaluation service"
        );
      } else if (
        errorMessage.includes("Unauthorized") ||
        errorMessage.includes("403")
      ) {
        setGlobalError(
          "Authorization error: You don't have permission to start evaluations"
        );
        addNotification(
          "error",
          "Authorization error: You don't have permission to start evaluations"
        );
      } else {
        setGlobalError(`Error starting evaluation: ${errorMessage}`);
        addNotification(
          "error",
          `Error starting evaluation: ${errorMessage}`
        );
      }
    } finally {
      setLoading(false);
    }
  };

  /** Function to get documents */
  const getDocuments = useCallback(
    async (params: { continuationToken?: string; pageIndex?: number }) => {
      setLoading(true);
      try {
        const result = await apiClient.evaluations.getDocuments(
          params?.continuationToken,
          params?.pageIndex
        );
        setPages((current) => {
          if (typeof params.pageIndex !== "undefined") {
            current[params.pageIndex - 1] = result;
            return [...current];
          } else {
            return [...current, result];
          }
        });
      } catch (error) {
        console.error(Utils.getErrorMessage(error));
      }

      console.log(pages);
      setLoading(false);
    },
    [appContext, props.documentType]
  );

  useEffect(() => {
    getDocuments({});
  }, [getDocuments]);

  const onNextPageClick = async () => {
    const continuationToken =
      pages[currentPageIndex - 1]?.NextContinuationToken;

    if (continuationToken) {
      if (pages.length <= currentPageIndex) {
        await getDocuments({ continuationToken });
      }
      setCurrentPageIndex((current) =>
        Math.min(pages.length + 1, current + 1)
      );
    }
  };

  const onPreviousPageClick = async () => {
    setCurrentPageIndex((current) =>
      Math.max(1, Math.min(pages.length - 1, current - 1))
    );
  };

  const refreshPage = async () => {
    if (currentPageIndex <= 1) {
      await getDocuments({ pageIndex: currentPageIndex });
    } else {
      const continuationToken =
        pages[currentPageIndex - 2]?.NextContinuationToken!;
      await getDocuments({ continuationToken });
    }
  };

  const columnDefinitions = getColumnDefinition(
    props.documentType,
    onProblemClick
  );

  const currentItems =
    pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Contents || [];

  return (
    <Stack spacing={2}>
      {globalError && <Alert severity="error">{globalError}</Alert>}

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Typography variant="body1">Evaluation Name:</Typography>
          <TextField
            value={evalName}
            placeholder="SampleEvalName"
            onChange={(e) => setEvalName(e.target.value)}
            size="small"
          />
          <Button
            variant="contained"
            onClick={onNewEvaluation}
            disabled={!selectedFile}
          >
            Create New Evaluation
          </Button>
        </Stack>
      </Paper>

      <Stack spacing={1}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
        >
          <Box>
            <Typography variant="h6">Files</Typography>
            <Typography variant="body2" color="text.secondary">
              Please select a test case file for your next evaluation. Press the
              refresh button to see the latest test case files.
            </Typography>
          </Box>
          <IconButton
            onClick={refreshPage}
            aria-label="Refresh test case documents"
          >
            <RefreshIcon />
          </IconButton>
        </Stack>

        {loading ? (
          <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
            <CircularProgress />
          </Box>
        ) : currentItems.length === 0 ? (
          <Box sx={{ textAlign: "center", p: 4 }}>
            <Typography color="text.secondary">
              No test case files uploaded. Please upload a test case file before
              running an evaluation.
            </Typography>
          </Box>
        ) : (
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" sx={{ fontWeight: "bold" }}>
                    Select
                  </TableCell>
                  {columnDefinitions.map((col) => (
                    <TableCell key={col.id} sx={{ fontWeight: "bold" }}>
                      {col.header}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {currentItems.map((item, index) => (
                  <TableRow
                    key={item.Key || index}
                    hover
                    selected={selectedFile?.Key === item.Key}
                    onClick={() =>
                      setSelectedFile((prev) =>
                        prev?.Key === item.Key ? null : item
                      )
                    }
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell padding="checkbox">
                      <Radio
                        checked={selectedFile?.Key === item.Key}
                        onChange={() =>
                          setSelectedFile((prev) =>
                            prev?.Key === item.Key ? null : item
                          )
                        }
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

        {pages.length > 0 && (
          <Stack
            direction="row"
            justifyContent="center"
            spacing={2}
            sx={{ py: 1 }}
          >
            <Button
              size="small"
              disabled={currentPageIndex <= 1}
              onClick={onPreviousPageClick}
            >
              Previous
            </Button>
            <Typography variant="body2" sx={{ alignSelf: "center" }}>
              Page {currentPageIndex}
            </Typography>
            <Button
              size="small"
              disabled={
                !pages[currentPageIndex - 1]?.NextContinuationToken
              }
              onClick={onNextPageClick}
            >
              Next
            </Button>
          </Stack>
        )}
      </Stack>
    </Stack>
  );
}
