import {
  Typography,
  Stack,
  Paper,
  Alert,
  LinearProgress,
  Box,
  Button,
  CircularProgress,
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Chip,
  Tooltip,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import { LineChart } from "@mui/x-charts/LineChart";
import { useState, useEffect, useMemo, useContext, useCallback } from "react";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { METRIC_DESCRIPTIONS } from "./columns";

interface DashboardProps {
  onRunEval: () => void;
  onViewLibrary: () => void;
}

function scoreColor(pct: number) {
  if (pct >= 75) return "success";
  if (pct >= 50) return "warning";
  return "error";
}

function scoreBgKey(pct: number) {
  if (pct >= 75) return "success.light";
  if (pct >= 50) return "warning.light";
  return "error.light";
}

function ScoreCard({
  title,
  pct,
  metrics,
  description,
}: {
  title: string;
  pct: number;
  metrics: { label: string; value: number; tooltip: string }[];
  description: string;
}) {
  return (
    <Paper sx={{ p: 2.5, bgcolor: scoreBgKey(pct), height: "100%" }}>
      <Tooltip
        title={<Typography variant="body2" sx={{ p: 0.5 }}>{description}</Typography>}
        placement="top"
        arrow
        enterDelay={200}
      >
        <Stack direction="row" alignItems="center" spacing={0.5} sx={{ cursor: "help", mb: 0.5 }}>
          <Typography variant="subtitle2" color="text.secondary">
            {title}
          </Typography>
          <InfoOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />
        </Stack>
      </Tooltip>
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="h4" fontWeight="bold">
          {pct.toFixed(0)}%
        </Typography>
        <Chip label={scoreColor(pct)} color={scoreColor(pct)} size="small" />
      </Stack>
      <LinearProgress
        variant="determinate"
        value={Math.min(pct, 100)}
        color={scoreColor(pct)}
        sx={{ height: 6, borderRadius: 3, my: 1.5 }}
      />
      {metrics.map((m) => (
        <Tooltip key={m.label} title={m.tooltip} placement="right" arrow>
          <Typography variant="body2" color="text.secondary" sx={{ cursor: "help" }}>
            {m.label}: {m.value.toFixed(0)}%
          </Typography>
        </Tooltip>
      ))}
    </Paper>
  );
}

export default function CurrentEvalTab({ onRunEval, onViewLibrary }: DashboardProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const [evaluations, setEvaluations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningEval, setRunningEval] = useState<any>(null);

  const getEvaluations = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiClient.evaluations.getEvaluationSummaries(undefined, 50);
      if (result?.Items) {
        const running = result.Items.find((e: any) => e.status === "RUNNING" || e.executionArn && !e.average_correctness);
        setRunningEval(running || null);
        setEvaluations(
          result.Items.filter((e: any) => e.average_correctness != null).map((e: any) => ({
            ...e,
            average_similarity: typeof e.average_similarity === "number" ? e.average_similarity : 0,
            average_relevance: typeof e.average_relevance === "number" ? e.average_relevance : 0,
            average_correctness: typeof e.average_correctness === "number" ? e.average_correctness : 0,
            average_context_precision: typeof e.average_context_precision === "number" ? e.average_context_precision : 0,
            average_context_recall: typeof e.average_context_recall === "number" ? e.average_context_recall : 0,
            average_response_relevancy: typeof e.average_response_relevancy === "number" ? e.average_response_relevancy : 0,
            average_faithfulness: typeof e.average_faithfulness === "number" ? e.average_faithfulness : 0,
          }))
        );
      }
    } catch {
      setEvaluations([]);
    } finally {
      setLoading(false);
    }
  }, [apiClient.evaluations]);

  useEffect(() => {
    getEvaluations();
  }, [getEvaluations]);

  if (loading) {
    return (
      <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (evaluations.length === 0) {
    return (
      <Paper sx={{ p: 4, textAlign: "center" }}>
        <Typography variant="h6" gutterBottom>
          No evaluations yet
        </Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>
          Run your first evaluation to see performance metrics and trends.
        </Typography>
        <Button variant="contained" onClick={onRunEval}>
          Run Evaluation
        </Button>
      </Paper>
    );
  }

  const latest = evaluations[0];
  const answerQuality = ((latest.average_correctness + latest.average_similarity) / 2) * 100;
  const retrievalQuality = ((latest.average_context_precision + latest.average_context_recall) / 2) * 100;
  const responseQuality = ((latest.average_response_relevancy + latest.average_faithfulness) / 2) * 100;

  const sorted = [...evaluations].sort(
    (a, b) => new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime()
  );
  const timestamps = sorted.map((e) => new Date(e.Timestamp));
  const answerTrend = sorted.map((e) => ((e.average_correctness + e.average_similarity) / 2) * 100);
  const retrievalTrend = sorted.map((e) => ((e.average_context_precision + e.average_context_recall) / 2) * 100);
  const responseTrend = sorted.map((e) => ((e.average_response_relevancy + e.average_faithfulness) / 2) * 100);

  return (
    <Stack spacing={3}>
      {runningEval && (
        <Alert severity="info" action={<Button size="small" onClick={onRunEval}>View Progress</Button>}>
          Evaluation "{runningEval.evaluation_name || "Unnamed"}" is in progress.
        </Alert>
      )}

      <Paper sx={{ p: 2 }}>
        <Typography variant="subtitle2" color="text.secondary">
          Latest: {latest.evaluation_name || "Unnamed"} &mdash;{" "}
          {new Date(latest.Timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        </Typography>
      </Paper>

      <Grid container spacing={2}>
        <Grid size={{ xs: 12, md: 4 }}>
          <ScoreCard
            title="Answer Quality"
            pct={answerQuality}
            description={METRIC_DESCRIPTIONS.answerQuality.detail}
            metrics={[
              { label: "Correctness", value: latest.average_correctness * 100, tooltip: METRIC_DESCRIPTIONS.correctness },
              { label: "Similarity", value: latest.average_similarity * 100, tooltip: METRIC_DESCRIPTIONS.similarity },
            ]}
          />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <ScoreCard
            title="Retrieval Quality"
            pct={retrievalQuality}
            description={METRIC_DESCRIPTIONS.retrievalQuality.detail}
            metrics={[
              { label: "Context Precision", value: latest.average_context_precision * 100, tooltip: METRIC_DESCRIPTIONS.contextPrecision },
              { label: "Context Recall", value: latest.average_context_recall * 100, tooltip: METRIC_DESCRIPTIONS.contextRecall },
            ]}
          />
        </Grid>
        <Grid size={{ xs: 12, md: 4 }}>
          <ScoreCard
            title="Response Quality"
            pct={responseQuality}
            description={METRIC_DESCRIPTIONS.responseQuality.detail}
            metrics={[
              { label: "Relevancy", value: latest.average_response_relevancy * 100, tooltip: METRIC_DESCRIPTIONS.responseRelevancy },
              { label: "Faithfulness", value: latest.average_faithfulness * 100, tooltip: METRIC_DESCRIPTIONS.faithfulness },
            ]}
          />
        </Grid>
      </Grid>

      <Paper sx={{ p: 2 }}>
        <Typography variant="h6" gutterBottom>
          Performance Trends
        </Typography>
        {timestamps.length > 1 ? (
          <Box sx={{ width: "100%", height: 350 }}>
            <LineChart
              xAxis={[
                {
                  data: timestamps,
                  scaleType: "time",
                  valueFormatter: (d: Date) =>
                    d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                },
              ]}
              yAxis={[{ min: 0, max: 100, valueFormatter: (v: number) => `${v}%` }]}
              series={[
                { data: answerTrend, label: "Answer Quality", color: "#4caf50" },
                { data: retrievalTrend, label: "Retrieval Quality", color: "#ff9800" },
                { data: responseTrend, label: "Response Quality", color: "#2196f3" },
              ]}
              height={320}
            />
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 4 }}>
            Need at least 2 evaluations to show trends
          </Typography>
        )}
      </Paper>

      {timestamps.length > 1 && (
        <Accordion>
          <AccordionSummary expandIcon={<ExpandMoreIcon />}>
            <Typography variant="subtitle1">Individual Metrics</Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Box sx={{ width: "100%", height: 350 }}>
              <LineChart
                xAxis={[
                  {
                    data: timestamps,
                    scaleType: "time",
                    valueFormatter: (d: Date) =>
                      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
                  },
                ]}
                yAxis={[{ min: 0, max: 100, valueFormatter: (v: number) => `${v}%` }]}
                series={[
                  { data: sorted.map((e) => e.average_correctness * 100), label: "Correctness" },
                  { data: sorted.map((e) => e.average_similarity * 100), label: "Similarity" },
                  { data: sorted.map((e) => e.average_context_precision * 100), label: "Context Precision" },
                  { data: sorted.map((e) => e.average_context_recall * 100), label: "Context Recall" },
                  { data: sorted.map((e) => e.average_response_relevancy * 100), label: "Relevancy" },
                  { data: sorted.map((e) => e.average_faithfulness * 100), label: "Faithfulness" },
                ]}
                height={320}
              />
            </Box>
          </AccordionDetails>
        </Accordion>
      )}

      <Stack direction="row" spacing={2}>
        <Button variant="contained" onClick={onRunEval}>
          Run New Evaluation
        </Button>
        <Button variant="outlined" onClick={onViewLibrary}>
          View Test Library
        </Button>
      </Stack>
    </Stack>
  );
}
