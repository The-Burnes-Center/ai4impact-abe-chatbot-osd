import { useState, useEffect, useContext, useRef, useMemo } from "react";
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
  Tooltip,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import { Utils } from "../../common/utils";
import { getColumnDefinition, METRIC_DESCRIPTIONS } from "./columns";
import { useNotifications } from "../../components/notif-manager";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { useDocumentTitle } from "../../common/hooks/use-document-title";

function scoreColor(pct: number): "success" | "warning" | "error" {
  if (pct >= 75) return "success";
  if (pct >= 50) return "warning";
  return "error";
}

function scoreBgKey(pct: number) {
  if (pct >= 75) return "success.light";
  if (pct >= 50) return "warning.light";
  return "error.light";
}

function SummaryCard({ title, pct, description }: { title: string; pct: number; description: string }) {
  return (
    <Tooltip
      title={<Typography variant="body2" sx={{ p: 0.5 }}>{description}</Typography>}
      placement="top"
      arrow
      enterDelay={200}
    >
      <Paper sx={{ p: 2, bgcolor: scoreBgKey(pct), textAlign: "center", cursor: "help" }}>
        <Stack direction="row" justifyContent="center" alignItems="center" spacing={0.5}>
          <Typography variant="subtitle2" color="text.secondary">
            {title}
          </Typography>
          <InfoOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />
        </Stack>
        <Typography variant="h4" fontWeight="bold">
          {pct.toFixed(0)}%
        </Typography>
        <Chip label={scoreColor(pct)} color={scoreColor(pct)} size="small" />
      </Paper>
    </Tooltip>
  );
}

function escapeCSVValue(val: any): string {
  const str = typeof val === "string" ? val : String(val ?? "");
  const escaped = str.replace(/"/g, '""');
  if (/^[=+\-@\t\r]/.test(escaped)) {
    return `"'${escaped}"`;
  }
  return `"${escaped}"`;
}

function DetailedEvaluationPage() {
  useDocumentTitle("Evaluation Details");
  const { evaluationId } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const appContext = useContext(AppContext);
  const apiClient = new ApiClient(appContext);
  const [loading, setLoading] = useState(true);
  const { addNotification } = useNotifications();
  const [evaluationName, setEvaluationName] = useState(searchParams.get("name") || "");
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const [pages, setPages] = useState<any[]>([]);
  const needsRefresh = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [isContextModalVisible, setContextModalVisible] = useState(false);
  const [selectedContext, setSelectedContext] = useState("");
  const [selectedQuestion, setSelectedQuestion] = useState("");
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [allItems, setAllItems] = useState<any[]>([]);

  useEffect(() => {
    setCurrentPageIndex(1);
    fetchEvaluationDetails({ pageIndex: 1 });
  }, [evaluationId]);

  const handleContextClick = (item: any) => {
    setSelectedContext(item.retrieved_context || "No context available");
    setSelectedQuestion(item.question || "Unknown question");
    setContextModalVisible(true);
  };

  const fetchEvaluationDetails = async (params: { pageIndex?: number; nextPageToken?: any }) => {
    setLoading(true);
    try {
      const result = await apiClient.evaluations.getEvaluationResults(
        evaluationId!,
        params.nextPageToken,
        100
      );

      if (result.error) {
        setError(result.error);
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
        }
        return [...current, result];
      });
      if (result.Items?.length > 0) {
        if (!evaluationName && result.Items[0].evaluation_name) {
          setEvaluationName(result.Items[0].evaluation_name);
        }
        setAllItems(result.Items);
      }
    } catch (error) {
      setError(`Error: ${Utils.getErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  };

  const columnDefinitions = useMemo(() => {
    const base = getColumnDefinition("detailedEvaluation", () => {});
    return base.map((col) =>
      col.id === "retrievedContext"
        ? {
            ...col,
            cell: (item: any) => (
              <Button onClick={() => handleContextClick(item)} variant="text" size="small">
                View
              </Button>
            ),
          }
        : col
    );
  }, []);

  const currentPageItems = pages[Math.min(pages.length - 1, currentPageIndex - 1)]?.Items || [];

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
    const sorted = [...currentPageItems].sort((a: any, b: any) => {
      const aVal = a[sortField] ?? "";
      const bVal = b[sortField] ?? "";
      return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
    });
    return sortDirection === "desc" ? sorted.reverse() : sorted;
  }, [currentPageItems, sortField, sortDirection]);

  const summaryMetrics = useMemo(() => {
    if (allItems.length === 0) return null;
    const avg = (field: string) => {
      const vals = allItems.map((i) => parseFloat(i[field]) || 0);
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    };
    return {
      answer: ((avg("correctness") + avg("similarity")) / 2) * 100,
      retrieval: ((avg("context_precision") + avg("context_recall")) / 2) * 100,
      response: ((avg("response_relevancy") + avg("faithfulness")) / 2) * 100,
    };
  }, [allItems]);

  const handleDownload = () => {
    if (sortedItems.length === 0) return;
    const headers = Object.keys(sortedItems[0] as object);
    const rows = sortedItems.map((item: any) =>
      headers.map((h) => escapeCSVValue(item[h])).join(",")
    );
    const csv = "\uFEFF" + headers.join(",") + "\n" + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `evaluation-${evaluationId}.csv`;
    link.click();
  };

  return (
    <Stack spacing={2}>
      <Breadcrumbs>
        <Link
          component="button"
          underline="hover"
          onClick={() => navigate("/admin/llm-evaluation#history")}
        >
          Quality Monitoring
        </Link>
        <Typography color="text.primary">
          {evaluationName || evaluationId}
        </Typography>
      </Breadcrumbs>

      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h5">Evaluation Details</Typography>
        <Button
          onClick={() => navigate("/admin/llm-evaluation#history")}
          variant="text"
        >
          Back to History
        </Button>
      </Stack>

      {summaryMetrics && (
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, md: 4 }}>
            <SummaryCard title="Answer Quality" pct={summaryMetrics.answer} description={METRIC_DESCRIPTIONS.answerQuality.detail} />
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <SummaryCard title="Retrieval Quality" pct={summaryMetrics.retrieval} description={METRIC_DESCRIPTIONS.retrievalQuality.detail} />
          </Grid>
          <Grid size={{ xs: 12, md: 4 }}>
            <SummaryCard title="Response Quality" pct={summaryMetrics.response} description={METRIC_DESCRIPTIONS.responseQuality.detail} />
          </Grid>
        </Grid>
      )}

      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="h6">Per-Question Results</Typography>
        <Button onClick={handleDownload} variant="outlined" size="small">
          Export CSV
        </Button>
      </Stack>

      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : sortedItems.length === 0 ? (
        <Box sx={{ textAlign: "center", p: 4 }}>
          <Chip
            label={error || "No details found"}
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
                        direction={sortField === col.sortingField ? sortDirection : "asc"}
                        onClick={() => handleSort(col.sortingField!)}
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
              {sortedItems.map((item: any, index: number) => (
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
            onClick={() => setCurrentPageIndex((c) => Math.max(1, c - 1))}
          >
            Previous
          </Button>
          <Typography variant="body2" sx={{ alignSelf: "center" }}>
            Page {currentPageIndex} of {pages.length}
          </Typography>
          <Button
            size="small"
            disabled={!pages[currentPageIndex - 1]?.NextPageToken}
            onClick={async () => {
              const token = pages[currentPageIndex - 1]?.NextPageToken;
              if (token) {
                await fetchEvaluationDetails({ nextPageToken: token });
                setCurrentPageIndex((c) => c + 1);
              }
            }}
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
        <DialogTitle>
          <Typography variant="h6">Retrieved Context</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, fontWeight: 400 }}>
            Chunks returned by the knowledge base for this question, with source and relevance score.
          </Typography>
        </DialogTitle>
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
                  border: "1px solid",
                  borderColor: "divider",
                  p: 1.5,
                  bgcolor: "action.hover",
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
