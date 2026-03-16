import {
  Box,
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
import MonitorHeartOutlinedIcon from "@mui/icons-material/MonitorHeartOutlined";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import { MonitoringData, formatDate, label } from "./types";

interface MonitoringViewProps {
  monitoring: MonitoringData | null;
  loading: boolean;
}

function StatCard({
  label,
  value,
  subtitle,
  color,
}: {
  label: string;
  value: number | string;
  subtitle?: string;
  color?: string;
}) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2.5,
        height: "100%",
        borderLeft: color ? `3px solid ${color}` : undefined,
      }}
    >
      <Typography variant="caption" color="text.secondary" fontWeight={600} textTransform="uppercase" letterSpacing={0.5}>
        {label}
      </Typography>
      <Typography variant="h4" fontWeight={700} sx={{ mt: 0.5 }}>
        {value}
      </Typography>
      {subtitle && (
        <Typography variant="caption" color="text.secondary">
          {subtitle}
        </Typography>
      )}
    </Paper>
  );
}

function MonitoringSkeleton() {
  return (
    <Stack spacing={2}>
      <Grid container spacing={2}>
        {[1, 2, 3, 4].map((i) => (
          <Grid item xs={12} md={3} key={i}>
            <Skeleton variant="rounded" height={110} />
          </Grid>
        ))}
      </Grid>
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Skeleton variant="rounded" height={250} />
        </Grid>
        <Grid item xs={12} md={6}>
          <Skeleton variant="rounded" height={250} />
        </Grid>
      </Grid>
    </Stack>
  );
}

function EmptyMonitoring() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <MonitorHeartOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        No monitoring data yet
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Monitoring data will appear once feedback starts flowing in.
      </Typography>
    </Paper>
  );
}

function BarSegment({ value, total, color, label }: { value: number; total: number; color: string; label: string }) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  if (pct === 0) return null;
  return (
    <Box
      sx={{
        width: `${pct}%`,
        minWidth: pct > 5 ? 40 : 20,
        height: 28,
        bgcolor: color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 0.5,
      }}
      title={`${label}: ${value} (${Math.round(pct)}%)`}
    >
      {pct > 10 && (
        <Typography variant="caption" sx={{ color: "#fff", fontSize: "0.65rem", fontWeight: 600 }}>
          {value}
        </Typography>
      )}
    </Box>
  );
}

const DISPOSITION_COLORS: Record<string, string> = {
  pending: "#9e9e9e",
  "prompt update": "#1976d2",
  "KB/source fix": "#ed6c02",
  "retrieval/config issue": "#9c27b0",
  "product/UX bug": "#d32f2f",
};

const ROOT_CAUSE_COLORS: Record<string, string> = {
  retrieval_gap: "#ed6c02",
  grounding_error: "#d32f2f",
  prompt_issue: "#1976d2",
  answer_quality: "#ff9800",
  product_bug: "#d32f2f",
  needs_human_review: "#9e9e9e",
  positive_signal: "#2e7d32",
  unknown: "#bdbdbd",
};

export default function MonitoringView({ monitoring, loading }: MonitoringViewProps) {
  if (loading && !monitoring) return <MonitoringSkeleton />;
  if (!monitoring) return <EmptyMonitoring />;

  const overview = monitoring.feedbackOverview;
  const totalDisposition = Object.values(overview.dispositionCounts).reduce((a, b) => a + b, 0);
  const totalRootCause = Object.values(overview.rootCauseCounts).reduce((a, b) => a + b, 0);

  return (
    <Stack spacing={2.5}>
      {/* Top stats */}
      <Grid container spacing={2}>
        <Grid item xs={6} md={3}>
          <StatCard
            label="Total reports"
            value={overview.totalFeedback}
            color="#1976d2"
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            label="Watchlist"
            value={monitoring.coreMonitoringSet.count}
            subtitle="Admin curated"
            color="#2e7d32"
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            label="Suggested watches"
            value={monitoring.candidateSet.count}
            subtitle="From feedback"
            color="#ed6c02"
          />
        </Grid>
        <Grid item xs={6} md={3}>
          <StatCard
            label="Needs review"
            value={overview.dispositionCounts["pending"] || 0}
            subtitle="Awaiting action"
            color="#9e9e9e"
          />
        </Grid>
      </Grid>

      {/* Disposition & root cause breakdown */}
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              Actions Summary
            </Typography>
            <Stack direction="row" gap={0.5} sx={{ mb: 2, borderRadius: 1, overflow: "hidden" }}>
              {Object.entries(overview.dispositionCounts).map(([key, count]) => (
                <BarSegment
                  key={key}
                  value={count}
                  total={totalDisposition}
                  color={DISPOSITION_COLORS[key] || "#9e9e9e"}
                  label={label(key)}
                />
              ))}
            </Stack>
            <Table size="small">
              <TableBody>
                {Object.entries(overview.dispositionCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([key, count]) => (
                    <TableRow key={key}>
                      <TableCell sx={{ py: 0.5 }}>
                        <Stack direction="row" gap={1} alignItems="center">
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              bgcolor: DISPOSITION_COLORS[key] || "#9e9e9e",
                              flexShrink: 0,
                            }}
                          />
                          {label(key)}
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontWeight: 600 }}>
                        {count}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} md={6}>
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom>
              Issue Breakdown
            </Typography>
            <Stack direction="row" gap={0.5} sx={{ mb: 2, borderRadius: 1, overflow: "hidden" }}>
              {Object.entries(overview.rootCauseCounts).map(([key, count]) => (
                <BarSegment
                  key={key}
                  value={count}
                  total={totalRootCause}
                  color={ROOT_CAUSE_COLORS[key] || "#9e9e9e"}
                  label={label(key)}
                />
              ))}
            </Stack>
            <Table size="small">
              <TableBody>
                {Object.entries(overview.rootCauseCounts)
                  .sort(([, a], [, b]) => b - a)
                  .map(([key, count]) => (
                    <TableRow key={key}>
                      <TableCell sx={{ py: 0.5 }}>
                        <Stack direction="row" gap={1} alignItems="center">
                          <Box
                            sx={{
                              width: 10,
                              height: 10,
                              borderRadius: "50%",
                              bgcolor: ROOT_CAUSE_COLORS[key] || "#9e9e9e",
                              flexShrink: 0,
                            }}
                          />
                          {label(key)}
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ py: 0.5, fontWeight: 600 }}>
                        {count}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>

      {/* Prompt activity */}
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography variant="subtitle1" fontWeight={600} gutterBottom>
          Prompt Activity
        </Typography>
        {(monitoring.promptActivity || []).length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
            No prompt-level feedback data yet.
          </Typography>
        ) : (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Prompt Version</TableCell>
                <TableCell align="right">Feedback Count</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {monitoring.promptActivity.map((row) => (
                <TableRow key={row.promptVersionId}>
                  <TableCell>
                    <Stack direction="row" gap={1} alignItems="center">
                      {row.promptVersionId}
                      {row.promptVersionId === (monitoring.coreMonitoringSet.recentCases[0] as any)?.PromptVersionId && (
                        <Chip size="small" label="current" color="success" sx={{ height: 18, fontSize: "0.65rem" }} />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 600 }}>
                    {row.feedbackCount}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Paper>
    </Stack>
  );
}
