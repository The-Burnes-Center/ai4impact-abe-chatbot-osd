import { useNavigate } from "react-router-dom";
import {
  Box,
  Button,
  Chip,
  Grid,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import BubbleChartOutlinedIcon from "@mui/icons-material/BubbleChartOutlined";
import SourceOutlinedIcon from "@mui/icons-material/SourceOutlined";
import {
  MonitoringData,
  ClusterSummary,
  formatDate,
  label,
} from "./types";

interface TrendsViewProps {
  monitoring: MonitoringData | null;
  loadingMeta: boolean;
  onCreateDraftFromCluster?: (cluster: ClusterSummary) => void;
}

const DISPOSITION_COLORS: Record<string, string> = {
  pending: "grey.500",
  "prompt update": "primary.main",
  "KB/source fix": "warning.main",
  "retrieval/config issue": "secondary.main",
  "product/UX bug": "error.main",
};

const ROOT_CAUSE_COLORS: Record<string, string> = {
  retrieval_gap: "warning.main",
  grounding_error: "error.main",
  prompt_issue: "primary.main",
  answer_quality: "warning.dark",
  product_bug: "error.dark",
  needs_human_review: "grey.500",
  unknown: "grey.400",
};

const ROOT_CAUSE_CHIP_COLOR: Record<string, "error" | "warning" | "info" | "default"> = {
  retrieval_gap: "warning",
  grounding_error: "error",
  prompt_issue: "info",
  answer_quality: "warning",
  product_bug: "error",
};

function TrendsSkeleton() {
  return (
    <Stack spacing={2}>
      <Skeleton variant="rounded" height={300} />
      <Skeleton variant="rounded" height={250} />
    </Stack>
  );
}

function EmptyTrends() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <TrendingUpIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        No trend data yet
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Trends will appear once feedback starts flowing in. Check back after users have submitted some feedback.
      </Typography>
    </Paper>
  );
}

function BreakdownTable({
  title,
  data,
  colorMap,
}: {
  title: string;
  data: Record<string, number>;
  colorMap: Record<string, string>;
}) {
  const entries = Object.entries(data).sort(([, a], [, b]) => b - a);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);

  if (entries.length === 0) return null;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5, fontSize: "0.9375rem" }}>
        {title}
      </Typography>
      {/* Accessible stacked bar */}
      <Stack
        direction="row"
        sx={{ mb: 2, borderRadius: 1, overflow: "hidden", height: 32 }}
        role="img"
        aria-label={`${title}: ${entries.map(([k, v]) => `${label(k)} ${v}`).join(", ")}`}
      >
        {entries.map(([key, count]) => {
          const pct = total > 0 ? (count / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <Box
              key={key}
              sx={{
                width: `${pct}%`,
                minWidth: pct > 5 ? 40 : 20,
                height: "100%",
                bgcolor: colorMap[key] || "grey.400",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {pct > 12 && (
                <Typography variant="caption" sx={{ color: "#fff", fontSize: "0.75rem", fontWeight: 600 }}>
                  {count}
                </Typography>
              )}
            </Box>
          );
        })}
      </Stack>
      <Table size="small" aria-label={`${title} breakdown`}>
        <TableHead>
          <TableRow>
            <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Category</TableCell>
            <TableCell scope="col" align="right" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Count</TableCell>
            <TableCell scope="col" align="right" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>%</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {entries.map(([key, count]) => (
            <TableRow key={key}>
              <TableCell sx={{ py: 0.75, fontSize: "0.8125rem" }}>
                <Stack direction="row" gap={1} alignItems="center">
                  <Box
                    sx={{ width: 10, height: 10, borderRadius: "50%", bgcolor: colorMap[key] || "grey.400", flexShrink: 0 }}
                    aria-hidden="true"
                  />
                  {label(key)}
                </Stack>
              </TableCell>
              <TableCell align="right" sx={{ py: 0.75, fontWeight: 600, fontSize: "0.8125rem" }}>
                {count}
              </TableCell>
              <TableCell align="right" sx={{ py: 0.75, fontSize: "0.8125rem", color: "text.secondary" }}>
                {total > 0 ? Math.round((count / total) * 100) : 0}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Paper>
  );
}

export default function TrendsView({ monitoring, loadingMeta, onCreateDraftFromCluster }: TrendsViewProps) {
  const navigate = useNavigate();

  if (loadingMeta && !monitoring) return <TrendsSkeleton />;
  if (!monitoring) return <EmptyTrends />;

  const overview = monitoring.feedbackOverview;
  const clusters = (monitoring.clusterSummaries || []).filter(
    (c) => c.rootCause !== "positive_signal"
  );
  const sources = monitoring.sourceTriage || [];

  return (
    <Stack spacing={3}>
      {/* Issue patterns */}
      {clusters.length > 0 && (
        <Box>
          <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1.5 }}>
            <BubbleChartOutlinedIcon sx={{ fontSize: 20, color: "text.secondary" }} />
            <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
              Issue Patterns
            </Typography>
            <Chip size="small" label={clusters.length} variant="outlined" sx={{ height: 22, fontSize: "0.75rem" }} />
          </Stack>
          <Grid container spacing={2}>
            {clusters.map((cluster) => {
              const canOpenExample = Boolean(cluster.sampleFeedbackId);
              return (
              <Grid item xs={12} md={6} lg={4} key={cluster.clusterId}>
                <Paper
                  variant="outlined"
                  tabIndex={canOpenExample ? 0 : -1}
                  role={canOpenExample ? "button" : "group"}
                  aria-label={`Pattern: ${label(cluster.rootCause || "Unclassified")} - ${cluster.count} reports`}
                  aria-disabled={!canOpenExample}
                  onClick={() => {
                    if (cluster.sampleFeedbackId) {
                      navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`);
                    }
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && cluster.sampleFeedbackId) {
                      e.preventDefault();
                      navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`);
                    }
                  }}
                  sx={{
                    p: 2,
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    cursor: canOpenExample ? "pointer" : "default",
                    transition: "box-shadow 0.15s, border-color 0.15s",
                    ...(canOpenExample && {
                      "&:hover": { boxShadow: 3, borderColor: "primary.main" },
                      "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
                    }),
                  }}
                >
                  <Stack spacing={1.5} sx={{ flex: 1 }}>
                    <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap={1}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 700, fontSize: "0.9375rem" }}>
                        {label(cluster.rootCause || "Unclassified")}
                      </Typography>
                      <Chip
                        size="small"
                        label={`${cluster.count} reports`}
                        color={ROOT_CAUSE_CHIP_COLOR[cluster.rootCause || ""] || "default"}
                        sx={{ height: 22, fontSize: "0.75rem" }}
                      />
                    </Stack>
                    <Typography variant="body2" color="text.secondary" sx={{ flex: 1, fontSize: "0.8125rem" }}>
                      {cluster.summary || "No AI summary available."}
                    </Typography>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {(cluster.sourceTitles || []).map((title) => (
                        <Chip key={title} label={title} size="small" variant="outlined" sx={{ height: 22, fontSize: "0.75rem" }} />
                      ))}
                    </Stack>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" gap={0.5}>
                      <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
                        {formatDate(cluster.latestCreatedAt)}
                      </Typography>
                      <Stack direction="row" gap={0.5}>
                        {onCreateDraftFromCluster && cluster.recommendedAction === "prompt update" && (
                          <Tooltip title="Opens Prompts and links this pattern’s sample feedback for AI Draft.">
                            <Button
                              size="small"
                              variant="outlined"
                              onClick={(e) => {
                                e.stopPropagation();
                                onCreateDraftFromCluster(cluster);
                              }}
                              sx={{ fontSize: "0.75rem", textTransform: "none" }}
                            >
                              Fix prompt
                            </Button>
                          </Tooltip>
                        )}
                        <Button
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (cluster.sampleFeedbackId) {
                              navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`);
                            }
                          }}
                          disabled={!cluster.sampleFeedbackId}
                          sx={{ fontSize: "0.75rem", textTransform: "none" }}
                        >
                          View example
                        </Button>
                      </Stack>
                    </Stack>
                  </Stack>
                </Paper>
              </Grid>
            );
            })}
          </Grid>
        </Box>
      )}

      {/* Breakdowns side by side */}
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <BreakdownTable
            title="Actions Summary"
            data={overview.dispositionCounts}
            colorMap={DISPOSITION_COLORS}
          />
        </Grid>
        <Grid item xs={12} md={6}>
          <BreakdownTable
            title="Issue Breakdown"
            data={Object.fromEntries(
              Object.entries(overview.rootCauseCounts).filter(([k]) => k !== "positive_signal")
            )}
            colorMap={ROOT_CAUSE_COLORS}
          />
        </Grid>
      </Grid>

      {/* Prompt activity */}
      {(monitoring.promptActivity || []).length > 0 && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1, fontSize: "0.9375rem" }}>
            Prompt Activity
          </Typography>
          <Table size="small" aria-label="Feedback count per prompt version">
            <TableHead>
              <TableRow>
                <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Prompt Version</TableCell>
                <TableCell scope="col" align="right" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Feedback Count</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {monitoring.promptActivity.map((row) => (
                <TableRow key={row.promptVersionId}>
                  <TableCell sx={{ fontSize: "0.8125rem" }}>
                    <Stack direction="row" gap={1} alignItems="center">
                      {row.promptVersionId}
                      {row.promptVersionId === monitoring.health?.livePromptVersionId && (
                        <Chip size="small" label="current" color="success" sx={{ height: 20, fontSize: "0.75rem" }} />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>
                    {row.feedbackCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}

      {/* Problem documents */}
      {sources.length > 0 && (
        <Box>
          <Stack direction="row" gap={1} alignItems="center" sx={{ mb: 1.5 }}>
            <SourceOutlinedIcon sx={{ fontSize: 20, color: "text.secondary" }} />
            <Typography variant="h6" sx={{ fontSize: "1rem", fontWeight: 600 }}>
              Problem Documents
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
              Documents most often cited in negative feedback
            </Typography>
          </Stack>
          <Paper variant="outlined" sx={{ overflow: "hidden" }}>
            <Table size="small" aria-label="Documents ranked by negative feedback frequency">
              <TableHead>
                <TableRow>
                  <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Document</TableCell>
                  <TableCell scope="col" align="right" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Reports</TableCell>
                  <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Top Issues</TableCell>
                  <TableCell scope="col" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>Last Reported</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sources.map((row, index) => (
                  <TableRow
                    key={row.sourceTitle}
                    sx={{ bgcolor: index < 3 ? "error.50" : undefined }}
                  >
                    <TableCell sx={{ fontSize: "0.8125rem" }}>
                      <Stack direction="row" gap={1} alignItems="center">
                        {index < 3 && (
                          <Chip
                            size="small"
                            label={`#${index + 1}`}
                            color="error"
                            variant="outlined"
                            sx={{ height: 22, fontSize: "0.75rem", minWidth: 30 }}
                          />
                        )}
                        <Typography variant="body2" sx={{ fontWeight: index < 3 ? 600 : 400, fontSize: "0.8125rem" }}>
                          {row.sourceTitle}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600, fontSize: "0.8125rem" }}>
                      {row.count}
                    </TableCell>
                    <TableCell>
                      <Stack direction="row" gap={0.5} flexWrap="wrap">
                        {(row.topIssueTags || []).map(([tag, count]) => (
                          <Chip
                            key={tag}
                            size="small"
                            label={`${tag} (${count})`}
                            variant="outlined"
                            sx={{ height: 22, fontSize: "0.75rem" }}
                          />
                        ))}
                      </Stack>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: "nowrap", fontSize: "0.8125rem" }}>
                      {formatDate(row.latestCreatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Box>
      )}
    </Stack>
  );
}
