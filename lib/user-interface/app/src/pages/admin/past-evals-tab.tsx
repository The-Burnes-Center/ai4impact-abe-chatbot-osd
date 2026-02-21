import React, {
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import {
  Box,
  Stack,
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
  TableContainer,
  TableSortLabel,
  Paper,
  Button,
  Typography,
  Chip,
  CircularProgress,
  IconButton,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { Utils } from "../../common/utils";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { useNotifications } from "../../components/notif-manager";
import { getColumnDefinition } from "./columns";
import { useNavigate } from "react-router-dom";
import { AdminDataType } from "../../common/types";

export interface PastEvalsTabProps {
  tabChangeFunction: () => void;
  documentType: AdminDataType;
}

export default function PastEvalsTab(props: PastEvalsTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const [loading, setLoading] = useState(true);
  const { addNotification } = useNotifications();
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState([]);
  const needsRefresh = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  const onProblemClick = useCallback(
    (evaluationItem) => {
      const evaluationId =
        evaluationItem.EvaluationId || evaluationItem.evaluationId;
      if (evaluationId) {
        navigate(`/admin/llm-evaluation/details/${evaluationId}`);
      }
    },
    [navigate]
  );

  const columnDefinitions = getColumnDefinition(
    props.documentType,
    onProblemClick
  );

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
    if (!col) return currentPageItems;
    const sorted = col.sortingComparator
      ? [...currentPageItems].sort(col.sortingComparator)
      : [...currentPageItems].sort((a, b) => {
          const aVal = a[sortField] ?? "";
          const bVal = b[sortField] ?? "";
          return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        });
    return sortDirection === "desc" ? sorted.reverse() : sorted;
  }, [currentPageItems, sortField, sortDirection, columnDefinitions]);

  const getEvaluations = useCallback(
    async (params: { pageIndex?: number; nextPageToken? }) => {
      setLoading(true);
      try {
        const result = await apiClient.evaluations.getEvaluationSummaries(
          params.nextPageToken
        );

        if (result.error) {
          setError(result.error);
          setPages([]);
          setLoading(false);
          return;
        }

        if (!result || !result.Items) {
          setError(
            "No evaluation data available. This could be due to an empty database or a configuration issue."
          );
          setPages([]);
          setLoading(false);
          return;
        }

        const processedResult = {
          ...result,
          Items: result.Items.map((evaluation) => ({
            ...evaluation,
            EvaluationId: evaluation.EvaluationId,
            evaluationId: evaluation.EvaluationId,
            evaluation_name:
              evaluation.evaluation_name || "Unnamed Evaluation",
            Timestamp: evaluation.Timestamp,
            average_similarity:
              typeof evaluation.average_similarity === "number"
                ? evaluation.average_similarity
                : 0,
            average_relevance:
              typeof evaluation.average_relevance === "number"
                ? evaluation.average_relevance
                : 0,
            average_correctness:
              typeof evaluation.average_correctness === "number"
                ? evaluation.average_correctness
                : 0,
            average_context_precision:
              typeof evaluation.average_context_precision === "number"
                ? evaluation.average_context_precision
                : 0,
            average_context_recall:
              typeof evaluation.average_context_recall === "number"
                ? evaluation.average_context_recall
                : 0,
            average_response_relevancy:
              typeof evaluation.average_response_relevancy === "number"
                ? evaluation.average_response_relevancy
                : 0,
            average_faithfulness:
              typeof evaluation.average_faithfulness === "number"
                ? evaluation.average_faithfulness
                : 0,
            total_questions: evaluation.total_questions || 0,
          })),
        };

        setError(null);

        setPages((current) => {
          if (needsRefresh.current) {
            needsRefresh.current = false;
            return [processedResult];
          }
          if (typeof params.pageIndex !== "undefined") {
            const newPages = [...current];
            newPages[params.pageIndex - 1] = processedResult;
            return newPages;
          } else {
            return [...current, processedResult];
          }
        });
      } catch (error) {
        const errorMessage = Utils.getErrorMessage(error);
        setError(`Failed to load evaluations: ${errorMessage}`);
        setPages([]);
      } finally {
        setLoading(false);
      }
    },
    [apiClient]
  );

  useEffect(() => {
    needsRefresh.current = true;
    setCurrentPageIndex(1);
    getEvaluations({ pageIndex: 1 });
  }, [getEvaluations]);

  const onNextPageClick = async () => {
    const continuationToken = pages[currentPageIndex - 1]?.NextPageToken;
    if (continuationToken) {
      if (pages.length <= currentPageIndex || needsRefresh.current) {
        await getEvaluations({ nextPageToken: continuationToken });
      }
      setCurrentPageIndex((current) =>
        Math.min(pages.length + 1, current + 1)
      );
    }
  };

  const onPreviousPageClick = () => {
    setCurrentPageIndex((current) => Math.max(1, current - 1));
  };

  return (
    <Stack spacing={2}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
      >
        <Typography variant="h6">Past Evaluations</Typography>
        <IconButton
          onClick={() => getEvaluations({ pageIndex: currentPageIndex })}
          aria-label="Refresh past evaluations"
        >
          <RefreshIcon />
        </IconButton>
      </Stack>

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : sortedItems.length === 0 ? (
        <Box sx={{ textAlign: "center", p: 4 }}>
          {error ? (
            <Chip label={error} color="error" variant="outlined" />
          ) : (
            <Chip
              label="No evaluations found"
              color="warning"
              variant="outlined"
            />
          )}
        </Box>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                {columnDefinitions.map((col) => (
                  <TableCell
                    key={col.id}
                    sx={{
                      fontWeight: "bold",
                      ...(col.width ? { width: col.width } : {}),
                    }}
                  >
                    {col.sortingField && !col.disableSort ? (
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
                <TableRow key={item.EvaluationId || index} hover>
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
    </Stack>
  );
}
