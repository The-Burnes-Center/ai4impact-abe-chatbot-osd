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
  loading: boolean;
  onCreateDraftFromCluster?: (cluster: ClusterSummary) => void;
}

function StatCard({
  title,
  value,
  subtitle,
  accent,
}: {
  title: string;
  value: number | string;
  subtitle?: string;
  accent?: "primary" | "success" | "warning" | "error" | "default";
}) {
  const accentColor = {
    primary: "primary.main",
    success: "success.main",
    warning: "warning.main",
    error: "error.main",
    default: "grey.500",
  }[accent || "default"];

  return (
    <Paper
      variant="outlined"
      sx={{ p: 2.5, height: "100%", borderLeft: "3px solid", borderLeftColor: accentColor }}
    >
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5, fontSize: "0.75rem" }}
      >
        {title}
      </Typography>
      <Typography variant="h4" sx={{ fontWeight: 700, mt: 0.5, fontSize: "1.75rem" }}>
        {value}
      </Typography>
      {subtitle && (
        <Typography variant="caption" color="text.secondary" sx={{ fontSize: "0.75rem" }}>
          {subtitle}
        </Typography>
      )}
    </Paper>
  );
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
  positive_signal: "success.main",
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
      <Grid container spacing={2}>
        {[1, 2, 3, 4].map((i) => (
          <Grid item xs={12} sm={6} md={3} key={i}>
            <Skeleton variant="rounded" height={100} />
          </Grid>
        ))}
      </Grid>
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

export default function TrendsView({ monitoring, loading, onCreateDraftFromCluster }: TrendsViewProps) {
  const navigate = useNavigate();

  if (loading && !monitoring) return <TrendsSkeleton />;
  if (!monitoring) return <EmptyTrends />;

  const overview = monitoring.feedbackOverview;
  const clusters = monitoring.clusterSummaries || [];
  const sources = monitoring.sourceTriage || [];

  return (
    <Stack spacing={3}>
      {/* Summary cards */}
      <Grid container spacing={2}>
        <Grid item xs={6} md={3}>
          <StatCard title="Total reports" value={overview.totalFeedback} accent="primary" />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            title="Needs review"
            value={overview.dispositionCounts["pending"] || 0}
            subtitle="Awaiting action"
            accent={((overview.dispositionCounts["pending"] || 0) > 10) ? "error" : "warning"}
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            title="Watchlist"
            value={monitoring.coreMonitoringSet.count + monitoring.candidateSet.count}
            subtitle={`${monitoring.coreMonitoringSet.count} curated, ${monitoring.candidateSet.count} suggested`}
            accent="success"
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            title="Negative rate"
            value={monitoring.health ? `${Math.round(monitoring.health.negativeRate * 100)}%` : "N/A"}
            accent={monitoring.health && monitoring.health.negativeRate > 0.5 ? "error" : "default"}
          />
        </Grid>
      </Grid>

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
            {clusters.map((cluster) => (
              <Grid item xs={12} md={6} lg={4} key={cluster.clusterId}>
                <Paper
                  variant="outlined"
                  tabIndex={0}
                  role="button"
                  aria-label={`Pattern: ${label(cluster.rootCause || "Unclassified")} - ${cluster.count} reports`}
                  onClick={() => navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`);
                    }
                  }}
                  sx={{
                    p: 2,
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                    cursor: "pointer",
                    transition: "box-shadow 0.15s, border-color 0.15s",
                    "&:hover": { boxShadow: 3, borderColor: "primary.main" },
                    "&:focus-visible": { outline: "2px solid", outlineColor: "primary.main", outlineOffset: 2 },
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
                        )}
                        <Button
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate(`/admin/user-feedback/${cluster.sampleFeedbackId}`);
                          }}
                          sx={{ fontSize: "0.75rem", textTransform: "none" }}
                        >
                          View example
                        </Button>
                      </Stack>
                    </Stack>
                  </Stack>
                </Paper>
              </Grid>
            ))}
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
            data={overview.rootCauseCounts}
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
