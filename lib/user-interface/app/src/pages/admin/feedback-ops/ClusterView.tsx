import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  Grid,
  Paper,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import BubbleChartOutlinedIcon from "@mui/icons-material/BubbleChartOutlined";
import { ClusterSummary, formatDate, label } from "./types";

interface ClusterViewProps {
  clusters: ClusterSummary[];
  loading: boolean;
  onCreateDraftFromCluster?: (cluster: ClusterSummary) => void;
}

function ClusterSkeleton() {
  return (
    <Grid container spacing={2}>
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <Grid item xs={12} md={6} lg={4} key={i}>
          <Skeleton variant="rounded" height={200} />
        </Grid>
      ))}
    </Grid>
  );
}

function EmptyClusters() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <BubbleChartOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        No patterns yet
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Patterns form as feedback is analyzed. They group similar issues to help you prioritize.
      </Typography>
    </Paper>
  );
}

const ROOT_CAUSE_COLORS: Record<string, "error" | "warning" | "info" | "default"> = {
  retrieval_gap: "warning",
  grounding_error: "error",
  prompt_issue: "info",
  answer_quality: "warning",
  product_bug: "error",
};

export default function ClusterView({ clusters, loading, onCreateDraftFromCluster }: ClusterViewProps) {
  const navigate = useNavigate();

  if (loading && clusters.length === 0) return <ClusterSkeleton />;
  if (clusters.length === 0) return <EmptyClusters />;

  return (
    <Grid container spacing={2}>
      {clusters.map((cluster) => (
        <Grid item xs={12} md={6} lg={4} key={cluster.clusterId}>
          <Paper
            variant="outlined"
            onClick={() => navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`)}
            sx={{
              p: 2,
              height: "100%",
              display: "flex",
              flexDirection: "column",
              cursor: "pointer",
              transition: "box-shadow 0.15s, border-color 0.15s",
              "&:hover": { boxShadow: 3, borderColor: "primary.main" },
            }}
          >
            <Stack spacing={1.5} sx={{ flex: 1 }}>
              <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                <Typography variant="subtitle1" fontWeight={700}>
                  {label(cluster.rootCause || "Unclassified")}
                </Typography>
                <Chip
                  size="small"
                  label={`${cluster.count}`}
                  color={ROOT_CAUSE_COLORS[cluster.rootCause || ""] || "default"}
                />
              </Stack>
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
                {cluster.summary || "No AI summary available."}
              </Typography>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  Prompt {cluster.promptVersionId || "unknown"} · {formatDate(cluster.latestCreatedAt)}
                </Typography>
              </Box>
              <Stack direction="row" gap={0.5} flexWrap="wrap">
                {(cluster.sourceTitles || []).map((title) => (
                  <Chip key={title} label={title} size="small" variant="outlined" />
                ))}
              </Stack>
              <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={0.5}>
                <Chip
                  size="small"
                  label={label(cluster.recommendedAction || "pending")}
                  variant="outlined"
                  color={
                    cluster.recommendedAction === "prompt update"
                      ? "info"
                      : cluster.recommendedAction === "KB/source fix"
                        ? "warning"
                        : "default"
                  }
                />
                <Stack direction="row" gap={0.5}>
                  {onCreateDraftFromCluster && cluster.recommendedAction === "prompt update" && (
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCreateDraftFromCluster(cluster);
                      }}
                    >
                      Draft prompt
                    </Button>
                  )}
                  <Button
                    size="small"
                    onClick={(e) => {
                      e.stopPropagation();
                      navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`);
                    }}
                  >
                    Open sample
                  </Button>
                </Stack>
              </Stack>
            </Stack>
          </Paper>
        </Grid>
      ))}
    </Grid>
  );
}
