import {
  Chip,
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
import SourceOutlinedIcon from "@mui/icons-material/SourceOutlined";
import { SourceTriageItem, formatDate } from "./types";

interface SourceTriageViewProps {
  sources: SourceTriageItem[];
  loading: boolean;
}

function SourceSkeleton() {
  return <Skeleton variant="rounded" height={300} />;
}

function EmptySources() {
  return (
    <Paper variant="outlined" sx={{ p: 6, textAlign: "center" }}>
      <SourceOutlinedIcon sx={{ fontSize: 48, color: "text.disabled", mb: 2 }} />
      <Typography variant="h6" color="text.secondary" gutterBottom>
        No source data yet
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Sources that appear in negative feedback will be listed here, ranked by frequency, to help you prioritize KB improvements.
      </Typography>
    </Paper>
  );
}

export default function SourceTriageView({ sources, loading }: SourceTriageViewProps) {
  if (loading && sources.length === 0) return <SourceSkeleton />;
  if (sources.length === 0) return <EmptySources />;

  return (
    <Paper variant="outlined" sx={{ overflow: "hidden" }}>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Source Document</TableCell>
            <TableCell align="right" sx={{ fontWeight: 600 }}>Negative Feedback</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Top Issues</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Prompt Versions</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Last Reported</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {sources.map((row, index) => (
            <TableRow
              key={row.sourceTitle}
              sx={{
                bgcolor: index < 3 ? "rgba(211, 47, 47, 0.04)" : undefined,
              }}
            >
              <TableCell>
                <Stack direction="row" gap={1} alignItems="center">
                  {index < 3 && (
                    <Chip
                      size="small"
                      label={`#${index + 1}`}
                      color="error"
                      variant="outlined"
                      sx={{ height: 20, fontSize: "0.65rem", minWidth: 30 }}
                    />
                  )}
                  <Typography variant="body2" fontWeight={index < 3 ? 600 : 400}>
                    {row.sourceTitle}
                  </Typography>
                </Stack>
              </TableCell>
              <TableCell align="right">
                <Typography variant="body2" fontWeight={600}>
                  {row.count}
                </Typography>
              </TableCell>
              <TableCell>
                <Stack direction="row" gap={0.5} flexWrap="wrap">
                  {(row.topIssueTags || []).map(([tag, count]) => (
                    <Chip
                      key={tag}
                      size="small"
                      label={`${tag} (${count})`}
                      variant="outlined"
                    />
                  ))}
                </Stack>
              </TableCell>
              <TableCell>
                <Stack direction="row" gap={0.5} flexWrap="wrap">
                  {(row.promptVersions || []).map((version) => (
                    <Chip key={version} size="small" label={version} variant="outlined" />
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
  );
}
