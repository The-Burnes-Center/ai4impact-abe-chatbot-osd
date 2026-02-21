import {
  Typography,
  Stack,
  Paper,
  Alert,
  LinearProgress,
  Box,
  Button,
  CircularProgress,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import { LineChart } from "@mui/x-charts/LineChart";
import { useState, useEffect, useMemo, useContext, useCallback } from "react";
import { useNotifications } from "../../components/notif-manager";
import { Auth } from "aws-amplify";
import { ApiClient } from "../../common/api-client/api-client";
import { AppContext } from "../../common/app-context";
import { Utils } from "../../common/utils";

export interface CurrentEvalTabProps {
  tabChangeFunction: () => void;
  addTestCasesHandler?: () => void;
  newEvalHandler?: () => void;
}

export default function CurrentEvalTab(props: CurrentEvalTabProps) {
  const appContext = useContext(AppContext);
  const [admin, setAdmin] = useState<boolean>(false);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const [evaluations, setEvaluations] = useState([]);
  const [loading, setLoading] = useState(true);
  const { addNotification } = useNotifications();
  const [error, setError] = useState<string | null>(null);

  const getEvaluations = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiClient.evaluations.getEvaluationSummaries();

      if (result.error) {
        console.error("Error from API:", result.error);
        setError(result.error);
        setEvaluations([]);
        setLoading(false);
        return;
      }

      if (result && result.Items) {
        const firstTenEvaluations = result.Items.slice(0, 10);

        const processedEvaluations = firstTenEvaluations.map(
          (evaluation) => ({
            ...evaluation,
            EvaluationId: evaluation.EvaluationId,
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
            total_questions: evaluation.total_questions || 0,
          })
        );

        setEvaluations(processedEvaluations);
        setError(null);
      } else {
        setEvaluations([]);
        setError(
          "No evaluation data available. This could be due to an empty database or a configuration issue."
        );
      }
    } catch (error) {
      console.error("Error fetching evaluations:", error);
      const errorMessage = Utils.getErrorMessage(error);
      console.error("Error details:", errorMessage);
      setError(`Failed to load evaluations: ${errorMessage}`);
      setEvaluations([]);
    } finally {
      setLoading(false);
    }
  }, [apiClient.evaluations]);

  useEffect(() => {
    getEvaluations();
  }, [getEvaluations]);

  useEffect(() => {
    (async () => {
      const result = await Auth.currentAuthenticatedUser();
      if (!result || Object.keys(result).length === 0) {
        console.log("Signed out!");
        Auth.signOut();
        return;
      }

      try {
        const result = await Auth.currentAuthenticatedUser();
        const admin =
          result?.signInUserSession?.idToken?.payload["custom:role"];
        if (admin) {
          const data = JSON.parse(admin);
          if (data.includes("Admin")) {
            setAdmin(true);
          }
        }
      } catch (e) {
        console.log(e);
      }
    })();
  }, []);

  if (!admin) {
    return (
      <Box
        sx={{
          height: "90vh",
          width: "100%",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Alert severity="error">
          You are not authorized to view this page!
        </Alert>
      </Box>
    );
  }

  if (loading) {
    return (
      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          Loading Evaluations
        </Typography>
        <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
          <CircularProgress />
        </Box>
        <Typography variant="body2" align="center" color="text.secondary">
          Fetching evaluation data...
        </Typography>
      </Paper>
    );
  }

  if (evaluations.length === 0) {
    return (
      <Paper sx={{ p: 3 }}>
        <Typography variant="h6" gutterBottom>
          No Evaluations Found
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          {error ? (
            <Typography variant="body2">{error}</Typography>
          ) : (
            <>
              <Typography variant="body2" gutterBottom>
                There are no LLM evaluations in the database yet. This is
                expected for new deployments. Follow these steps to get started:
              </Typography>
              <ol style={{ marginLeft: "20px", lineHeight: "1.5" }}>
                <li>
                  <strong>Ensure backend deployment</strong> - Make sure the
                  backend API and Lambda functions are properly deployed
                </li>
                <li>
                  <strong>Check CORS configuration</strong> - Ensure the API
                  Gateway has CORS enabled with appropriate origins
                </li>
                <li>
                  <strong>Upload test cases</strong> - Go to the "Add Test
                  Cases" tab to upload JSON files containing test questions and
                  expected answers
                </li>
                <li>
                  <strong>Run an evaluation</strong> - Navigate to the "New
                  Evaluation" tab to start a new evaluation run using your test
                  cases
                </li>
                <li>
                  <strong>View results</strong> - Once complete, return to this
                  tab to view performance metrics and trends
                </li>
              </ol>
              <Typography variant="body2" sx={{ mt: 1 }}>
                If you're seeing a "Cross-Origin Request Blocked" message, you
                need to update the CORS configuration in your API Gateway. Add
                your frontend origin to the allowed origins list.
              </Typography>
            </>
          )}
        </Alert>
        <Stack direction="row" justifyContent="space-between">
          <Button
            onClick={props.addTestCasesHandler || props.tabChangeFunction}
            variant="contained"
          >
            Upload Test Cases
          </Button>
          <Button
            onClick={props.newEvalHandler || props.tabChangeFunction}
            variant="contained"
          >
            Start New Evaluation
          </Button>
        </Stack>
      </Paper>
    );
  }

  const last_entry = evaluations[0];
  const acc_score = last_entry["average_correctness"] * 100;
  const rel_score = last_entry["average_relevance"] * 100;
  const sim_score = last_entry["average_similarity"] * 100;

  const sortedEvals = [...evaluations].sort(
    (a, b) =>
      new Date(a.Timestamp).getTime() - new Date(b.Timestamp).getTime()
  );

  const timestamps = sortedEvals.map((i) => new Date(i.Timestamp));
  const accuracyValues = sortedEvals.map(
    (i) => i["average_correctness"] * 100
  );
  const relevancyValues = sortedEvals.map(
    (i) => i["average_relevance"] * 100
  );
  const similarityValues = sortedEvals.map(
    (i) => i["average_similarity"] * 100
  );

  return (
    <Stack spacing={3}>
      <Grid container spacing={3}>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Accuracy
            </Typography>
            <LinearProgress
              variant="determinate"
              value={acc_score}
              sx={{ height: 8, borderRadius: 4, mb: 1 }}
            />
            <Typography variant="h5" fontWeight="bold">
              {acc_score.toFixed(1)}%
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Answer Correctness breaks down answers into different factual
              statements and looks at the overlap of statements in the expected
              answer given in a test case and the generated answer from the LLM
            </Typography>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Relevancy
            </Typography>
            <LinearProgress
              variant="determinate"
              value={rel_score}
              sx={{ height: 8, borderRadius: 4, mb: 1 }}
            />
            <Typography variant="h5" fontWeight="bold">
              {rel_score.toFixed(1)}%
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Answer Relevancy looks at the generated answer and uses an LLM to
              guess what questions it may be answering. The better the LLM
              guesses the original question, the more relevant the generated
              answer is
            </Typography>
          </Paper>
        </Grid>
        <Grid size={{ xs: 12, sm: 4 }}>
          <Paper sx={{ p: 2 }}>
            <Typography variant="h6" gutterBottom>
              Similarity
            </Typography>
            <LinearProgress
              variant="determinate"
              value={sim_score}
              sx={{ height: 8, borderRadius: 4, mb: 1 }}
            />
            <Typography variant="h5" fontWeight="bold">
              {sim_score.toFixed(1)}%
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Answer Similarity looks only at the semantic similarity of the
              expected answer and the LLM generated answer by finding the cosine
              similarity between the two answers and converting it into a score
            </Typography>
          </Paper>
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
                  valueFormatter: (date: Date) =>
                    date.toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "numeric",
                      hour12: false,
                    }),
                },
              ]}
              yAxis={[
                {
                  min: 50,
                  max: 100,
                  valueFormatter: (v) => `${v}%`,
                },
              ]}
              series={[
                {
                  data: accuracyValues,
                  label: "Accuracy",
                },
                {
                  data: relevancyValues,
                  label: "Relevancy",
                },
                {
                  data: similarityValues,
                  label: "Similarity",
                },
              ]}
              height={320}
            />
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" align="center">
            Need at least 2 evaluations to show trends
          </Typography>
        )}
      </Paper>
    </Stack>
  );
}
