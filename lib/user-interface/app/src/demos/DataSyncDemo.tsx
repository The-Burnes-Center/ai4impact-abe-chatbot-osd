/**
 * DataSyncDemo — admin Data Dashboard flow: upload a new document → the KB
 * falls out of sync (warning) → click "Sync data now" → Bedrock KB ingestion
 * progresses (3/5 → 5/5) → everything lands "Synced".
 *
 * Mirrors ChatDemo.tsx: single useSteps() counter, one editable TIMINGS array,
 * one view rendered per phase, data-cursor targets. Real source mirrored:
 * pages/admin/data-view-page.tsx + documents-tab.tsx + status-chip.tsx.
 *
 * Unlike ChatDemo (custom chat-kit), the dashboard chrome is built from real
 * themed @mui/material components (sx + palette keys), matching the live app.
 */
import { useRef } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Paper,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Typography,
} from "@mui/material";
import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutline";
import RemoveCircleOutlineIcon from "@mui/icons-material/RemoveCircleOutline";
import CloudUploadIcon from "@mui/icons-material/CloudUpload";
import SyncIcon from "@mui/icons-material/Sync";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import { AppShell } from "./app-shell";
import {
  DemoFrame,
  DemoStyle,
  MouseCursor,
  Spinner,
  useSteps,
  useCursor,
} from "./demo-kit";

/** ms per step — keep editable. */
export const TIMINGS = [1700, 1900, 1400, 1600, 1400, 1600, 3000];
/** card geometry → recorder viewport (computed in registry). */
export const CARD = { width: 1120, bodyHeight: 800 };

// Step map
const STEP = {
  IDLE: 0, // 4 rows synced, KB "Synced", no alert
  UPLOAD: 1, // click Upload → new row rises in, warning alert, "1 file pending sync"
  AIM_SYNC: 2, // cursor glides to "Sync data now" (click)
  SYNCING_60: 3, // KB "Syncing", 3/5 (60%), new row "Syncing"
  SYNCING_100: 4, // 5/5 (100%)
  DONE: 5, // all "Synced", alert gone, "Last synced just now"
  HOLD: 6, // long hold before loop
};

// Aliases referenced by the cursor targets (per spec: STEP_UPLOAD / STEP_SYNC).
const STEP_UPLOAD = STEP.UPLOAD;
const STEP_SYNC = STEP.AIM_SYNC;

type RowStatus = "synced" | "syncing" | "pending";
type ChipKind = "ready" | "processing" | "empty";

type DocRow = {
  name: string;
  size: string;
  modified: string;
  /** when true this row is the freshly-uploaded file (animates in + tracks sync) */
  fresh?: boolean;
};

const BASE_ROWS: DocRow[] = [
  { name: "Statewide Contract User Guide.pdf", size: "2.4 MB", modified: "May 28, 2026" },
  { name: "OSD Procurement Handbook 2024.pdf", size: "5.1 MB", modified: "May 28, 2026" },
  { name: "COMMBUYS Buyer Reference.pdf", size: "1.8 MB", modified: "May 28, 2026" },
  { name: "Bid Protest Procedures.pdf", size: "0.9 MB", modified: "May 28, 2026" },
];

const NEW_ROW: DocRow = {
  name: "FY26 Procurement Bulletin.pdf",
  size: "1.2 MB",
  modified: "Just now",
  fresh: true,
};

/* ── StatusChip — reproduced from status-chip.tsx ──────────────────────────── */
function StatusChip({ kind, label }: { kind: ChipKind; label: string }) {
  const color: "success" | "warning" | "default" =
    kind === "ready" ? "success" : kind === "processing" ? "warning" : "default";
  const icon =
    kind === "ready" ? (
      <CheckCircleOutlineIcon fontSize="small" />
    ) : kind === "processing" ? (
      <Spinner size={14} color="currentColor" />
    ) : (
      <RemoveCircleOutlineIcon fontSize="small" />
    );
  return (
    <Chip
      size="small"
      variant="outlined"
      color={color}
      icon={icon}
      label={label}
      sx={{ fontWeight: 500 }}
    />
  );
}

const borderForKind = (kind: ChipKind) =>
  kind === "ready" ? "success.main" : kind === "processing" ? "warning.main" : "divider";

/* ── per-row status chip ───────────────────────────────────────────────────── */
function renderRowChip(status: RowStatus) {
  if (status === "syncing") return <StatusChip kind="processing" label="Syncing" />;
  if (status === "pending") return <StatusChip kind="empty" label="Not synced" />;
  return <StatusChip kind="ready" label="Synced" />;
}

export default function DataSyncDemo() {
  const step = useSteps(TIMINGS);
  const bodyRef = useRef<HTMLDivElement>(null);

  const { pos, clicking } = useCursor(
    step,
    bodyRef,
    {
      [STEP_UPLOAD]: '[data-cursor="upload"]',
      [STEP_SYNC]: '[data-cursor="syncnow"]',
    },
    [STEP_UPLOAD, STEP_SYNC]
  );

  // Has the new file landed in the table yet?
  const hasNewFile = step >= STEP.UPLOAD;
  // Out-of-sync warning shows only while a file is pending and not yet fully synced.
  const showWarning = step >= STEP.UPLOAD && step < STEP.DONE;
  // Sync sweep is in flight (drives processing chips + spinning button icon).
  const syncing = step === STEP.SYNCING_60 || step === STEP.SYNCING_100;

  // KB Documents summary card state per step.
  const kbKind: ChipKind = syncing ? "processing" : "ready";
  const kbLabel = kbKind === "processing" ? "Syncing" : "Synced";
  const kbDetail =
    step === STEP.IDLE
      ? "Last synced May 28, 2026 · 1:04 AM"
      : step === STEP.UPLOAD || step === STEP.AIM_SYNC
        ? "1 file pending sync"
        : step === STEP.SYNCING_60
          ? "Syncing 3/5 (60%)"
          : step === STEP.SYNCING_100
            ? "Syncing 5/5 (100%)"
            : "Last synced just now";

  // Per-row status. During the sweep every row reads "Syncing" so the 3/5 → 5/5
  // progress is truthful; the fresh row is "Not synced" until the sweep starts.
  const rowStatus = (row: DocRow): RowStatus => {
    if (step >= STEP.DONE) return "synced";
    if (syncing) return "syncing";
    // IDLE / UPLOAD / AIM_SYNC
    return row.fresh ? "pending" : "synced";
  };

  const rows: DocRow[] = hasNewFile ? [NEW_ROW, ...BASE_ROWS] : BASE_ROWS;

  return (
    <>
      <DemoStyle css={DATASYNC_CSS} />
      <DemoFrame url="/admin/data" width={CARD.width} bodyHeight={CARD.bodyHeight} bodyRef={bodyRef}>
        <AppShell active="data">
          <Box className="abe-ds-root">
            {/* Header block — mirrors AdminPageLayout */}
            <Box sx={{ mb: 2.5 }}>
              <Typography sx={{ fontSize: "0.8125rem", mb: 0.75 }}>
                <Box component="span" sx={{ color: "text.secondary" }}>
                  ABE - Assistive Buyer Engine
                </Box>
                <Box component="span" sx={{ color: "text.secondary", mx: 0.75 }}>
                  ›
                </Box>
                <Box component="span" sx={{ color: "text.primary" }}>
                  Data
                </Box>
              </Typography>
              <Typography variant="h2" component="h1" sx={{ mb: 0.5 }}>
                Data Dashboard
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Manage the chatbot's knowledge base and data indexes.
              </Typography>
            </Box>

            {/* Status overview bar — two cards */}
            <Stack direction="row" spacing={2} sx={{ mb: 2.5 }}>
              <Paper
                variant="outlined"
                sx={{ flex: 1, px: 2.5, py: 2, borderLeft: 4, borderLeftColor: borderForKind(kbKind) }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" color="text.secondary">
                      KB Documents
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.25 }}>
                      {kbDetail}
                    </Typography>
                  </Box>
                  <StatusChip kind={kbKind} label={kbLabel} />
                </Stack>
              </Paper>

              <Paper
                variant="outlined"
                sx={{ flex: 1, px: 2.5, py: 2, borderLeft: 4, borderLeftColor: "success.main" }}
              >
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle2" color="text.secondary">
                      Auto-Sync
                    </Typography>
                    <Typography variant="body2" sx={{ mt: 0.25 }}>
                      Sundays at 1:00 AM ET
                    </Typography>
                  </Box>
                  <StatusChip kind="ready" label="Scheduled" />
                </Stack>
              </Paper>
            </Stack>

            {/* Tabs */}
            <Tabs value={0} sx={{ borderBottom: 1, borderColor: "divider", mb: 2 }}>
              <Tab label="Documents" />
              <Tab label="Data Indexes" />
              <Tab label="Automation" />
            </Tabs>

            {/* Documents tab toolbar */}
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CloudUploadIcon />}
                data-cursor="upload"
              >
                Upload
              </Button>
              <Button
                variant="contained"
                size="small"
                startIcon={<SyncIcon className={syncing ? "abe-ds-spin" : undefined} />}
                data-cursor="syncnow"
              >
                Sync data now
              </Button>
            </Stack>

            {/* Out-of-sync warning (only after upload, before sync completes). The
                fixed-height slot keeps the table from reflowing when it toggles. */}
            <Box sx={{ height: 56, mb: 1 }}>
              {showWarning && (
                <Alert severity="warning" className="abe-ds-alert" sx={{ py: 0.5 }}>
                  Some files may have been added or modified since the last sync. Please sync with the
                  &apos;Sync data now&apos; button.
                </Alert>
              )}
            </Box>

            {/* Documents table */}
            <Paper variant="outlined" sx={{ overflow: "hidden" }}>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ "& th": { fontWeight: 600, bgcolor: "action.hover" } }}>
                    <TableCell>Name</TableCell>
                    <TableCell>Size</TableCell>
                    <TableCell>Last modified</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.name} className={row.fresh ? "abe-ds-newrow" : undefined} hover>
                      <TableCell>
                        <Stack direction="row" alignItems="center" spacing={1}>
                          <DescriptionOutlinedIcon fontSize="small" color="action" />
                          <Typography variant="body2">{row.name}</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {row.size}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {row.modified}
                        </Typography>
                      </TableCell>
                      <TableCell>{renderRowChip(rowStatus(row))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Paper>
          </Box>
        </AppShell>
        <MouseCursor pos={pos} clicking={clicking} />
      </DemoFrame>
    </>
  );
}

const DATASYNC_CSS = `
.abe-ds-root { height:100%; }
.abe-ds-newrow { animation:abeRise 420ms cubic-bezier(0.4,0,0.2,1) both; }
.abe-ds-newrow td { background:var(--abe-primaryLight); }
.abe-ds-alert { animation:slideUp 320ms cubic-bezier(0.4,0,0.2,1) both; }
.abe-ds-spin { animation:abeSpin 0.9s linear infinite; }
`;
