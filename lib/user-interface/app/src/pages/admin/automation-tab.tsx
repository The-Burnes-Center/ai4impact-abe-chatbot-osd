import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  InputLabel,
  MenuItem,
  Paper,
  Select,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import EditIcon from "@mui/icons-material/Edit";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { AppContext } from "../../common/app-context";
import { ApiClient } from "../../common/api-client/api-client";
import type {
  SyncSchedule,
  SyncDestination,
  SyncRun,
} from "../../common/api-client/sync-client";
import { useNotifications } from "../../components/notif-manager";
import { Utils } from "../../common/utils";

const DAYS = [
  { value: "SUN", label: "Sunday" },
  { value: "MON", label: "Monday" },
  { value: "TUE", label: "Tuesday" },
  { value: "WED", label: "Wednesday" },
  { value: "THU", label: "Thursday" },
  { value: "FRI", label: "Friday" },
  { value: "SAT", label: "Saturday" },
];

const HOURS_ET = Array.from({ length: 24 }, (_, i) => {
  const ampm = i < 12 ? "AM" : "PM";
  const h12 = i % 12 || 12;
  return { value: i, label: `${h12}:00 ${ampm} ET` };
});

function etToUtc(hourEt: number): number {
  return (hourEt + 5) % 24;
}

function utcToEt(hourUtc: number): number {
  return (hourUtc - 5 + 24) % 24;
}

function statusChipColor(
  status: string
): "success" | "error" | "warning" | "default" {
  if (status === "SUCCESS") return "success";
  if (status === "FAILED") return "error";
  if (status === "RUNNING") return "warning";
  return "default";
}

interface AutomationTabProps {
  onScheduleChange?: (schedule: SyncSchedule) => void;
}

export default function AutomationTab({ onScheduleChange }: AutomationTabProps) {
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext), [appContext]);
  const { addNotification } = useNotifications();

  const [schedule, setSchedule] = useState<SyncSchedule | null>(null);
  const [destinations, setDestinations] = useState<SyncDestination | null>(
    null
  );
  const [history, setHistory] = useState<SyncRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editDay, setEditDay] = useState("SUN");
  const [editHourEt, setEditHourEt] = useState(2);
  const [saving, setSaving] = useState(false);

  const [confirmSyncOpen, setConfirmSyncOpen] = useState(false);
  const [triggering, setTriggering] = useState(false);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [sched, dest, hist] = await Promise.all([
        apiClient.sync.getSyncSchedule(),
        apiClient.sync.getSyncDestinations(),
        apiClient.sync.getSyncHistory(),
      ]);
      setSchedule(sched);
      setDestinations(dest);
      setHistory(hist.runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [apiClient]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const openEditDialog = () => {
    if (schedule?.dayOfWeek) setEditDay(schedule.dayOfWeek);
    if (schedule?.hourUtc !== undefined)
      setEditHourEt(utcToEt(schedule.hourUtc));
    setEditOpen(true);
  };

  const handleSaveSchedule = async () => {
    setSaving(true);
    try {
      const hourUtc = etToUtc(editHourEt);
      const updated = await apiClient.sync.updateSyncSchedule(
        editDay,
        hourUtc,
        0,
        true
      );
      setSchedule(updated);
      onScheduleChange?.(updated);
      setEditOpen(false);
      addNotification("success", "Sync schedule updated");
    } catch (e) {
      addNotification("error", "Failed to update schedule");
    } finally {
      setSaving(false);
    }
  };

  const handleTriggerSync = async () => {
    setTriggering(true);
    setConfirmSyncOpen(false);
    try {
      await apiClient.sync.triggerSyncNow();
      addNotification("success", "Sync started — check history for progress");
      setTimeout(() => loadAll(), 3000);
    } catch (e) {
      addNotification("error", "Failed to trigger sync");
    } finally {
      setTriggering(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    addNotification("info", "Copied to clipboard");
  };

  if (loading) {
    return (
      <Stack spacing={2.5}>
        <Skeleton variant="rounded" height={100} />
        <Skeleton variant="rounded" height={140} />
        <Skeleton variant="rounded" height={200} />
      </Stack>
    );
  }

  return (
    <Stack spacing={3}>
      {error && <Alert severity="error">{error}</Alert>}

      {/* ── Sync Schedule Card ── */}
      <Paper sx={{ px: 3, py: 2.5 }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
        >
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Weekly Auto-Sync Schedule
            </Typography>
            <Typography variant="h6" sx={{ mt: 0.5 }}>
              {schedule?.humanReadable ?? "Not configured"}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {schedule?.enabled
                ? "Enabled — files in staging will be synced automatically"
                : "Disabled"}
            </Typography>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              variant="outlined"
              startIcon={<EditIcon />}
              onClick={openEditDialog}
            >
              Edit
            </Button>
            <Button
              size="small"
              variant="contained"
              startIcon={<PlayArrowIcon />}
              disabled={triggering}
              onClick={() => setConfirmSyncOpen(true)}
            >
              {triggering ? "Starting\u2026" : "Run Now"}
            </Button>
          </Stack>
        </Stack>
      </Paper>

      {/* ── Upload Destinations ── */}
      <Paper sx={{ px: 3, py: 2.5 }}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" color="text.secondary">
              Upload Destinations
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Configure your automation tool to upload files to these S3 paths.
              Files will be synced at the scheduled time.
            </Typography>
          </Box>

          {/* KB Documents */}
          <DestinationRow
            label="Knowledge Base Documents"
            path={destinations?.kbDocuments.path ?? ""}
            stagedCount={destinations?.kbDocuments.stagedCount ?? 0}
            onCopy={copyToClipboard}
          />

          {/* Excel Indexes */}
          {destinations?.indexes.map((idx) => (
            <DestinationRow
              key={idx.indexName}
              label={idx.displayName}
              path={idx.path}
              onCopy={copyToClipboard}
            />
          ))}

          {destinations?.indexes.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ pl: 1 }}>
              No Excel indexes registered. Create one in the Data Indexes tab
              first.
            </Typography>
          )}
        </Stack>
      </Paper>

      {/* ── Sync History ── */}
      <Paper sx={{ px: 3, py: 2.5 }}>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="center"
          sx={{ mb: 1.5 }}
        >
          <Typography variant="subtitle2" color="text.secondary">
            Sync History
          </Typography>
          <IconButton size="small" onClick={loadAll} aria-label="Refresh history">
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Stack>

        {history.length === 0 ? (
          <Typography variant="body2" color="text.secondary" textAlign="center">
            No sync runs yet.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" aria-label="Sync history">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: "bold" }}>Date / Time</TableCell>
                  <TableCell sx={{ fontWeight: "bold" }}>Status</TableCell>
                  <TableCell sx={{ fontWeight: "bold" }} align="right">
                    KB Docs
                  </TableCell>
                  <TableCell sx={{ fontWeight: "bold" }} align="right">
                    Index Files
                  </TableCell>
                  <TableCell sx={{ fontWeight: "bold" }} align="right">
                    Duration
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {history.map((run) => (
                  <TableRow key={run.sk}>
                    <TableCell>
                      {Utils.formatToEasternTime(run.sk)}
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={statusChipColor(run.status)}
                        label={run.status}
                      />
                    </TableCell>
                    <TableCell align="right">{run.kbDocsCount}</TableCell>
                    <TableCell align="right">{run.indexFilesCount}</TableCell>
                    <TableCell align="right">
                      {run.durationMs < 1000
                        ? `${run.durationMs}ms`
                        : `${(run.durationMs / 1000).toFixed(1)}s`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>

      {/* ── Edit Schedule Dialog ── */}
      <Dialog
        open={editOpen}
        onClose={saving ? undefined : () => setEditOpen(false)}
        maxWidth="xs"
        fullWidth
        aria-labelledby="edit-schedule-dialog-title"
      >
        <DialogTitle id="edit-schedule-dialog-title">
          Edit Sync Schedule
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} pt={1}>
            <FormControl fullWidth>
              <InputLabel id="day-select-label">Day of Week</InputLabel>
              <Select
                labelId="day-select-label"
                value={editDay}
                label="Day of Week"
                onChange={(e) => setEditDay(e.target.value)}
                disabled={saving}
              >
                {DAYS.map((d) => (
                  <MenuItem key={d.value} value={d.value}>
                    {d.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl fullWidth>
              <InputLabel id="time-select-label">Time (Eastern)</InputLabel>
              <Select
                labelId="time-select-label"
                value={editHourEt}
                label="Time (Eastern)"
                onChange={(e) => setEditHourEt(Number(e.target.value))}
                disabled={saving}
              >
                {HOURS_ET.map((h) => (
                  <MenuItem key={h.value} value={h.value}>
                    {h.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleSaveSchedule} disabled={saving}>
            {saving ? "Saving\u2026" : "Save"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* ── Confirm Run Now Dialog ── */}
      <Dialog
        open={confirmSyncOpen}
        onClose={() => setConfirmSyncOpen(false)}
        aria-labelledby="confirm-sync-dialog-title"
      >
        <DialogTitle id="confirm-sync-dialog-title">
          Run Sync Now?
        </DialogTitle>
        <DialogContent>
          <Typography>
            This will move all staged files to the permanent buckets and trigger
            a knowledge base ingestion. Continue?
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmSyncOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleTriggerSync}>
            Run Sync
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

/* ── Destination row sub-component ── */

interface DestinationRowProps {
  label: string;
  path: string;
  stagedCount?: number;
  onCopy: (text: string) => void;
}

function DestinationRow({
  label,
  path,
  stagedCount,
  onCopy,
}: DestinationRowProps) {
  return (
    <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        spacing={1}
      >
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography variant="body2" fontWeight={600} noWrap>
              {label}
            </Typography>
            {stagedCount !== undefined && (
              <Chip
                size="small"
                label={
                  stagedCount === 0
                    ? "Empty"
                    : `${stagedCount} file${stagedCount > 1 ? "s" : ""} staged`
                }
                color={stagedCount > 0 ? "info" : "default"}
                variant="outlined"
              />
            )}
          </Stack>
          <Typography
            variant="caption"
            color="text.secondary"
            noWrap
            sx={{ display: "block", mt: 0.25, fontFamily: "monospace" }}
          >
            {path}
          </Typography>
        </Box>
        <Tooltip title="Copy S3 path">
          <IconButton size="small" onClick={() => onCopy(path)} aria-label="Copy path">
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
    </Paper>
  );
}
