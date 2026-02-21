import React, { useState, useEffect, useContext, useRef, useMemo } from "react";
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  TableSortLabel,
  Paper,
  Typography,
  Button,
  Box,
  Breadcrumbs,
  Link,
  CircularProgress,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Stack,
} from "@mui/material";
import { useParams, useNavigate } from "react-router-dom";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { Utils } from "../../common/utils";
import { getColumnDefinition } from "./columns";
import { useNotifications } from "../../components/notif-manager";
import { AdminDataType } from "../../common/types";

export interface DetailedEvalProps {
  documentType: AdminDataType;
}

const findFirstSortableColumn = (columns) => {
  return columns.find((col) => col.sortingField) || columns[0];
};

function DetailedEvaluationPage(props: DetailedEvalProps) {
  const { evaluationId } = useParams();
  const navigate = useNavigate();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [loading, setLoading] = useState(true);
  const { addNotification } = useNotifications();
  const [evaluationName, setEvaluationName] = useState("");
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState([]);
  const needsRefresh = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isContextModalVisible, setContextModalVisible] = useState(false);
  const [selectedContext, setSelectedContext] = useState("");
  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    setCurrentPageIndex(1);
    fetchEvaluationDetails({ pageIndex: 1 });
  }, [evaluationId]);

  const onProblemClick = (ProblemItem): void => {
    console.log("ProblemItem: ", ProblemItem);
    navigate(
      `/admin/llm-evaluation/${evaluationId}/problem/${ProblemItem.question_id}`
    );
  };

  const handleContextClick = (item) => {
    setSelectedContext(item.retrieved_context || "No context available");
    setSelectedQuestion(item.question || "Unknown question");
    setContextModalVisible(true);
  };

  const fetchEvaluationDetails = async (params: {
    pageIndex?: number;
    nextPageToken?;
  }) => {
    setLoading(true);
    try {
      const result = await apiClient.evaluations.getEvaluationResults(
        evaluationId,
        params.nextPageToken
      );

      if (result.error) {
        console.error("Error from API:", result.error);
        setError(result.error);
        addNotification("error", result.error);
        setLoading(false);
        return;
      }

      setError(null);

      setPages((current) => {
        if (needsRefresh.current) {
          needsRefresh.current = false;
          return [result];
        }
        if (typeof params.pageIndex !== "undefined") {
          current[params.pageIndex - 1] = result;
          return [...current];
        } else {
          return [...current, result];
        }
      });
      if (result.Items && result.Items.length > 0) {
        const name = result.Items[0].evaluation_name || "Unnamed Evaluation";
        setEvaluationName(name);
      } else {
        console.warn("No evaluation details found");
        setError("No details found for this evaluation.");
        addNotification("warning", "No details found for this evaluation.");
      }
    } catch (error) {
      console.error("Error fetching evaluation details:", error);
      const errorMessage = Utils.getErrorMessage(error);
      console.error("Error details:", errorMessage);
      const errorMsg = `Error fetching evaluation details: ${errorMessage}`;
      setError(errorMsg);
      addNotification("error", errorMsg);
    } finally {
      setLoading(false);
    }
  };

  const onNextPageClick = async () => {
    const continuationToken = pages[currentPageIndex - 1]?.NextPageToken;
    if (continuationToken) {
      if (pages.length <= currentPageIndex || needsRefresh.current) {
        await fetchEvaluationDetails({
          nextPageToken: continuationToken,
        });
      }
      setCurrentPageIndex((current) =>
        Math.min(pages.length + 1, current + 1)
      );
    }
  };

  const onPreviousPageClick = () => {
    setCurrentPageIndex((current) => Math.max(1, current - 1));
  };

  const getCustomColumnDefinitions = () => {
    const baseColumns = getColumnDefinition(
      props.documentType,
      onProblemClick
    );

    const updatedColumns = baseColumns.map((column) => {
      if (column.id === "retrievedContext") {
        return {
          ...column,
          cell: (item) => (
            <Button
              onClick={() => handleContextClick(item)}
              variant="text"
              size="small"
            >
              View Context
            </Button>
          ),
        };
      }
      return column;
    });

    return updatedColumns;
  };

  const columnDefinitions = getCustomColumnDefinitions();
  const currentPageItems =
    pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Items || [];

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  };

  const sortedItems = useMemo(() => {
    if (!sortField || !currentPageItems.length) return currentPageItems;
    const col = columnDefinitions.find((c) => c.sortingField === sortField);
    if (!col || !col.sortingComparator) {
      return [...currentPageItems].sort((a, b) => {
        const aVal = a[sortField] ?? "";
        const bVal = b[sortField] ?? "";
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return sortDirection === "asc" ? cmp : -cmp;
      });
    }
    const sorted = [...currentPageItems].sort(col.sortingComparator);
    return sortDirection === "desc" ? sorted.reverse() : sorted;
  }, [currentPageItems, sortField, sortDirection, columnDefinitions]);

  const handleDownload = () => {
    const csvContent = convertToCSV(sortedItems);
    const BOM = "\uFEFF";
    const csvContentWithBOM = BOM + csvContent;
    const blob = new Blob([csvContentWithBOM], {
      type: "text/csv;charset=utf-8;",
    });
    const link = document.createElement("a");
    if (link.download !== undefined) {
      const url = URL.createObjectURL(blob);
      link.setAttribute("href", url);
      link.setAttribute("download", "table_data.csv");
      link.style.visibility = "hidden";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  const convertToCSV = (data: readonly unknown[]): string => {
    if (data.length === 0) {
      return "";
    }
    const headers = Object.keys(data[0] as object).join(",");
    const rows = data.map((item) =>
      Object.values(item as object)
        .map((value) =>
          typeof value === "string"
            ? `"${value.replace(/"/g, '""')}"`
            : String(value)
        )
        .join(",")
    );
    return [headers, ...rows].join("\n");
  };

  return (
    <Stack spacing={2}>
      <Breadcrumbs>
        <Link
          component="button"
          underline="hover"
          onClick={() => navigate("/admin/llm-evaluation")}
        >
          LLM Evaluation
        </Link>
        <Typography color="text.primary">
          Evaluation {evaluationName || evaluationId}
        </Typography>
      </Breadcrumbs>

      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <Typography variant="h4">Evaluation Details</Typography>
        <Button onClick={() => navigate(-1)} variant="text">
          Back to Evaluations
        </Button>
      </Stack>

      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <Typography variant="h5">Detailed Results</Typography>
        <Button onClick={handleDownload} variant="outlined" size="small">
          Download Table
        </Button>
      </Stack>

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : sortedItems.length === 0 ? (
        <Box sx={{ textAlign: "center", p: 4 }}>
          <Chip
            label={error || "No details found for this evaluation."}
            color={error ? "error" : "warning"}
            variant="outlined"
          />
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {columnDefinitions.map((col) => (
                  <TableCell
                    key={col.id}
                    sx={{ fontWeight: "bold", ...(col.width ? { width: col.width } : {}) }}
                  >
                    {col.sortingField ? (
                      <TableSortLabel
                        active={sortField === col.sortingField}
                        direction={
                          sortField === col.sortingField
                            ? sortDirection
                            : "asc"
                        }
                        onClick={() => handleSort(col.sortingField)}
                      >
                        {col.header}
                      </TableSortLabel>
                    ) : (
                      col.header
                    )}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {sortedItems.map((item, index) => (
                <TableRow key={item.question_id || index} hover>
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
        <Stack direction="row" justifyContent="center" spacing={2} sx={{ py: 1 }}>
          <Button
            size="small"
            disabled={currentPageIndex <= 1}
            onClick={onPreviousPageClick}
          >
            Previous
          </Button>
          <Typography variant="body2" sx={{ alignSelf: "center" }}>
            Page {currentPageIndex} of {pages.length}
          </Typography>
          <Button
            size="small"
            disabled={!pages[currentPageIndex - 1]?.NextPageToken}
            onClick={onNextPageClick}
          >
            Next
          </Button>
        </Stack>
      )}

      <Dialog
        open={isContextModalVisible}
        onClose={() => setContextModalVisible(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Retrieved Context</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Box>
              <Typography variant="subtitle2">Question:</Typography>
              <Typography variant="body2">{selectedQuestion}</Typography>
            </Box>
            <Box>
              <Typography variant="subtitle2">Context:</Typography>
              <Box
                sx={{
                  maxHeight: 400,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  border: "1px solid #eee",
                  p: 1.5,
                  bgcolor: "#f9f9f9",
                  borderRadius: 1,
                }}
              >
                {selectedContext}
              </Box>
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setContextModalVisible(false)} variant="contained">
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

export default DetailedEvaluationPage;
