import React, { useState, useEffect, useContext, useMemo, useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiClient } from "../../common/api-client/api-client";
import { MetricsFilters } from "../../common/api-client/metrics-client";
import { AppContext } from "../../common/app-context";
import {
  Box,
  Button,
  Card,
  CardContent,
  Typography,
  Tabs,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Alert,
  IconButton,
  Chip,
  Collapse,
  Stack,
  Skeleton,
  Tooltip,
  TextField,
  MenuItem,
  InputAdornment,
  FormControlLabel,
  Switch,
  Paper,
} from "@mui/material";
import Grid from "@mui/material/Grid2";
import { alpha, useTheme } from "@mui/material/styles";
import RefreshIcon from "@mui/icons-material/Refresh";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import TrendingUpIcon from "@mui/icons-material/TrendingUp";
import TrendingDownIcon from "@mui/icons-material/TrendingDown";
import TrendingFlatIcon from "@mui/icons-material/TrendingFlat";
import PeopleIcon from "@mui/icons-material/People";
import ChatIcon from "@mui/icons-material/Chat";
import ForumIcon from "@mui/icons-material/Forum";
import AccessTimeIcon from "@mui/icons-material/AccessTime";
import PersonIcon from "@mui/icons-material/Person";
import SearchIcon from "@mui/icons-material/Search";
import DownloadIcon from "@mui/icons-material/Download";
import { LineChart } from "@mui/x-charts/LineChart";
import { BarChart } from "@mui/x-charts/BarChart";
import AdminPageLayout from "../../components/admin-page-layout";
import { useDocumentTitle } from "../../common/hooks/use-document-title";

interface RangeMeta {
  from: string;
  to: string;
  days: number;
  hour_from: number | null;
  hour_to: number | null;
  timezone: string;
}

interface MetricsData {
  unique_users: number;
  total_sessions: number;
  total_messages: number;
  avg_messages_per_session: number;
  peak_hour: string;
  hourly_distribution?: Array<{ hour: string; sessions: number }>;
  /** 24 rows × 7 cols (Mon..Sun); from the backend. */
  hour_by_weekday?: number[][];
  daily_breakdown: Array<{
    date: string;
    sessions: number;
    messages: number;
    unique_users: number;
    users?: Array<{
      user_id: string;
      display_name: string;
      agency: string;
      sessions: number;
      messages: number;
    }>;
  }>;
  range?: RangeMeta;
}

interface FAQSample {
  question: string;
  display_name?: string;
  agency?: string;
}

interface FAQData {
  topics: Array<{
    topic: string;
    count: number;
    sample_questions: FAQSample[];
  }>;
  total_classified: number;
  range?: RangeMeta;
}

interface UserData {
  users: Array<{
    user_id: string;
    display_name: string;
    agency: string;
    messages: number;
    top_topics: Array<{ topic: string; count: number }>;
    recent_questions: Array<{ question: string; topic: string; timestamp: string }>;
  }>;
  total_messages: number;
  range?: RangeMeta;
}

interface AgencyData {
  agencies: Array<{
    agency: string;
    messages: number;
    unique_users: number;
    top_topics: Array<{ topic: string; count: number }>;
    daily_breakdown: Array<{ date: string; messages: number }>;
  }>;
  total_messages: number;
  range?: RangeMeta;
}

// ---------- Date / filter helpers ----------

type PresetKey = "7d" | "30d" | "90d" | "6mo" | "12mo" | "custom";

const PRESETS: Array<{ key: PresetKey; label: string; days?: number }> = [
  { key: "7d", label: "Last 7 days", days: 7 },
  { key: "30d", label: "Last 30 days", days: 30 },
  { key: "90d", label: "Last 90 days", days: 90 },
  { key: "6mo", label: "Last 6 months", days: 182 },
  { key: "12mo", label: "Last 12 months", days: 365 },
  { key: "custom", label: "Custom" },
];

function todayISO(): string {
  // Use local-time date components (admins are in ET; the small UTC-vs-ET drift here is acceptable
  // for the picker default — server normalizes anyway).
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDaysISO(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + delta);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function daysBetween(fromISO: string, toISO: string): number {
  const a = new Date(`${fromISO}T00:00:00`).getTime();
  const b = new Date(`${toISO}T00:00:00`).getTime();
  return Math.round((b - a) / 86400000) + 1;
}

function formatRangeLabel(fromISO: string, toISO: string): string {
  const fmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${fmt.format(new Date(`${fromISO}T00:00:00`))} – ${fmt.format(new Date(`${toISO}T00:00:00`))}`;
}

interface FilterState {
  preset: PresetKey;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  agency: string; // "" = all
  compare: boolean;
}

function defaultFilters(): FilterState {
  const to = todayISO();
  const from = addDaysISO(to, -29);
  return { preset: "30d", from, to, agency: "", compare: false };
}

function presetToRange(key: PresetKey, currentFrom: string, currentTo: string): { from: string; to: string } {
  const preset = PRESETS.find((p) => p.key === key);
  if (!preset || !preset.days) return { from: currentFrom, to: currentTo };
  const to = todayISO();
  const from = addDaysISO(to, -(preset.days - 1));
  return { from, to };
}

function filtersFromSearchParams(params: URLSearchParams): FilterState {
  const base = defaultFilters();
  const preset = (params.get("preset") as PresetKey) || base.preset;
  const fromParam = params.get("from");
  const toParam = params.get("to");
  const agency = params.get("agency") || "";
  const compare = params.get("compare") === "1";

  let from = base.from;
  let to = base.to;
  if (preset === "custom" && fromParam && toParam) {
    from = fromParam;
    to = toParam;
  } else {
    const r = presetToRange(preset, base.from, base.to);
    from = r.from;
    to = r.to;
  }

  return { preset, from, to, agency, compare };
}

function filtersToSearchParams(state: FilterState): URLSearchParams {
  const params = new URLSearchParams();
  params.set("preset", state.preset);
  if (state.preset === "custom") {
    params.set("from", state.from);
    params.set("to", state.to);
  }
  if (state.agency) params.set("agency", state.agency);
  if (state.compare) params.set("compare", "1");
  return params;
}

function filterStateToApiFilters(state: FilterState): MetricsFilters {
  const filters: MetricsFilters = { from: state.from, to: state.to };
  if (state.agency) filters.agency = state.agency;
  return filters;
}

function previousPeriodFilters(state: FilterState): MetricsFilters {
  const span = daysBetween(state.from, state.to);
  const to = addDaysISO(state.from, -1);
  const from = addDaysISO(to, -(span - 1));
  const filters: MetricsFilters = { from, to };
  if (state.agency) filters.agency = state.agency;
  return filters;
}

// ---------- CSV export ----------

function downloadCSV(filename: string, rows: Array<Array<string | number>>) {
  const escape = (v: string | number) => {
    const s = String(v ?? "");
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const csv = rows.map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------- KPI card with optional delta ----------

interface KPICardProps {
  title: string;
  value: string | number;
  previous?: number;
  icon: React.ReactNode;
  invertDelta?: boolean;
}

function KPICard({ title, value, previous, icon, invertDelta }: KPICardProps) {
  let delta: { pct: number; up: boolean | null } | null = null;
  if (typeof value === "number" && typeof previous === "number") {
    if (previous === 0 && value === 0) {
      delta = { pct: 0, up: null };
    } else if (previous === 0) {
      delta = { pct: 100, up: true };
    } else {
      const pct = ((value - previous) / previous) * 100;
      delta = { pct, up: pct === 0 ? null : pct > 0 };
    }
  }

  const positive = delta?.up === true;
  const negative = delta?.up === false;
  const good = invertDelta ? negative : positive;
  const bad = invertDelta ? positive : negative;

  return (
    <Card sx={{ height: "100%" }}>
      <CardContent sx={{ p: 2.5 }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 500 }}>
              {title}
            </Typography>
            <Typography variant="h3" sx={{ mt: 0.5 }}>
              {typeof value === "number" ? value.toLocaleString() : value}
            </Typography>
            {delta && (
              <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mt: 0.5 }}>
                {delta.up === null ? (
                  <TrendingFlatIcon fontSize="small" color="action" />
                ) : good ? (
                  <TrendingUpIcon fontSize="small" color="success" />
                ) : bad ? (
                  <TrendingDownIcon fontSize="small" color="error" />
                ) : (
                  <TrendingFlatIcon fontSize="small" color="action" />
                )}
                <Typography
                  variant="caption"
                  color={good ? "success.main" : bad ? "error.main" : "text.secondary"}
                >
                  {delta.up === null ? "no change" : `${Math.abs(delta.pct).toFixed(1)}%`}
                  <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 0.5 }}>
                    vs. prior period
                  </Typography>
                </Typography>
              </Stack>
            )}
          </Box>
          <Box
            sx={{
              bgcolor: "primary.light",
              borderRadius: 2,
              p: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "primary.main",
            }}
          >
            {icon}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ---------- Filter bar ----------

interface FilterBarProps {
  state: FilterState;
  onChange: (next: FilterState) => void;
  agencies: string[];
}

function FilterBar({ state, onChange, agencies }: FilterBarProps) {
  const todayMax = todayISO();

  const setPreset = (key: PresetKey) => {
    if (key === "custom") {
      onChange({ ...state, preset: "custom" });
      return;
    }
    const { from, to } = presetToRange(key, state.from, state.to);
    onChange({ ...state, preset: key, from, to });
  };

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        mb: 2,
        position: "sticky",
        top: 0,
        zIndex: 2,
        bgcolor: "background.paper",
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 60 }}>
            Range
          </Typography>
          {PRESETS.map((p) => (
            <Chip
              key={p.key}
              label={p.label}
              size="small"
              color={state.preset === p.key ? "primary" : "default"}
              variant={state.preset === p.key ? "filled" : "outlined"}
              onClick={() => setPreset(p.key)}
            />
          ))}
          <Box sx={{ flex: 1 }} />
          <Typography variant="caption" color="text.secondary">
            {formatRangeLabel(state.from, state.to)} · {daysBetween(state.from, state.to)} days · All times ET
          </Typography>
        </Stack>

        {state.preset === "custom" && (
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField
              type="date"
              size="small"
              label="From"
              value={state.from}
              onChange={(e) => onChange({ ...state, from: e.target.value })}
              inputProps={{ max: state.to || todayMax }}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              type="date"
              size="small"
              label="To"
              value={state.to}
              onChange={(e) => onChange({ ...state, to: e.target.value })}
              inputProps={{ min: state.from, max: todayMax }}
              InputLabelProps={{ shrink: true }}
            />
            {state.from > state.to && (
              <Typography variant="caption" color="error">
                "From" must be on or before "To"
              </Typography>
            )}
          </Stack>
        )}

        <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField
            select
            size="small"
            label="Agency"
            value={state.agency}
            onChange={(e) => onChange({ ...state, agency: e.target.value })}
            sx={{ minWidth: 200 }}
          >
            <MenuItem value="">All agencies</MenuItem>
            {agencies.map((a) => (
              <MenuItem key={a} value={a}>
                {a}
              </MenuItem>
            ))}
          </TextField>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={state.compare}
                onChange={(e) => onChange({ ...state, compare: e.target.checked })}
              />
            }
            label="Compare to prior period"
          />
        </Stack>
      </Stack>
    </Paper>
  );
}

// ---------- Overview tab ----------

type OverviewSortKey = "date" | "sessions" | "messages" | "unique_users";

function DailyRow({ day }: { day: MetricsData["daily_breakdown"][0] }) {
  const [open, setOpen] = useState(false);
  const hasUsers = !!day.users && day.users.length > 0;

  return (
    <React.Fragment>
      <TableRow
        hover
        sx={{ cursor: hasUsers ? "pointer" : "default" }}
        onClick={() => hasUsers && setOpen((v) => !v)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (hasUsers && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        tabIndex={hasUsers ? 0 : undefined}
        aria-expanded={hasUsers ? open : undefined}
        aria-controls={hasUsers ? `daily-users-${day.date}` : undefined}
      >
        <TableCell width={50}>
          {hasUsers && (
            <IconButton size="small" aria-label={open ? "Collapse" : "Expand"}>
              {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell>{day.date}</TableCell>
        <TableCell align="right">{day.sessions.toLocaleString()}</TableCell>
        <TableCell align="right">{day.messages.toLocaleString()}</TableCell>
        <TableCell align="right">{day.unique_users.toLocaleString()}</TableCell>
      </TableRow>
      {hasUsers && (
        <TableRow>
          <TableCell colSpan={5} sx={{ py: 0, borderBottom: open ? undefined : "none" }}>
            <Collapse in={open} timeout={200} unmountOnExit id={`daily-users-${day.date}`}>
              <Box sx={{ py: 1, pl: 7, pr: 2, pb: 1.5 }}>
                <Table size="small" aria-label={`Users for ${day.date}`}>
                  <TableHead>
                    <TableRow>
                      <TableCell>User (Email)</TableCell>
                      <TableCell>Agency</TableCell>
                      <TableCell align="right">Sessions</TableCell>
                      <TableCell align="right">Messages</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {day.users!.map((u) => (
                      <TableRow key={u.user_id}>
                        <TableCell>
                          <Stack direction="row" alignItems="center" spacing={1}>
                            <PersonIcon fontSize="small" color="action" />
                            <Typography variant="body2">{u.display_name}</Typography>
                          </Stack>
                        </TableCell>
                        <TableCell>
                          <Chip label={u.agency} size="small" variant="outlined" />
                        </TableCell>
                        <TableCell align="right">{u.sessions}</TableCell>
                        <TableCell align="right">{u.messages}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </React.Fragment>
  );
}

function OverviewTab({
  metrics,
  prior,
  rangeLabel,
}: {
  metrics: MetricsData;
  prior: MetricsData | null;
  rangeLabel: string;
}) {
  const [sortKey, setSortKey] = useState<OverviewSortKey>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const daily = useMemo(
    () => [...metrics.daily_breakdown].sort((a, b) => a.date.localeCompare(b.date)),
    [metrics.daily_breakdown]
  );
  const dates = daily.map((d) => d.date);
  const sessions = daily.map((d) => d.sessions);
  const messages = daily.map((d) => d.messages);
  const users = daily.map((d) => d.unique_users);

  const sortedDaily = useMemo(() => {
    const copy = [...metrics.daily_breakdown];
    copy.sort((a, b) => {
      const av = a[sortKey] as string | number;
      const bv = b[sortKey] as string | number;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [metrics.daily_breakdown, sortKey, sortDir]);

  const toggleSort = (key: OverviewSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "date" ? "desc" : "desc");
    }
  };

  const exportCSV = () => {
    const rows: Array<Array<string | number>> = [
      ["Date", "Sessions", "Messages", "Unique Users"],
      ...sortedDaily.map((d) => [d.date, d.sessions, d.messages, d.unique_users]),
    ];
    downloadCSV(`overview-${metrics.range?.from ?? "from"}_to_${metrics.range?.to ?? "to"}.csv`, rows);
  };

  return (
    <Box sx={{ mt: 3 }}>
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Total Users" value={metrics.unique_users} previous={prior?.unique_users} icon={<PeopleIcon />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Total Sessions" value={metrics.total_sessions} previous={prior?.total_sessions} icon={<ChatIcon />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Total Messages" value={metrics.total_messages} previous={prior?.total_messages} icon={<ForumIcon />} />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard title="Avg Msgs/Session" value={metrics.avg_messages_per_session} previous={prior?.avg_messages_per_session} icon={<TrendingUpIcon />} />
        </Grid>
      </Grid>

      {metrics.peak_hour && metrics.peak_hour !== "N/A" && (
        <Alert icon={<AccessTimeIcon />} severity="info" sx={{ mb: 3 }}>
          Peak usage hour: <strong>{metrics.peak_hour}</strong>
        </Alert>
      )}

      {daily.length > 1 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h4" component="h2" gutterBottom>
              Activity Over Time
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {rangeLabel}
            </Typography>
            <Typography
              id="chart-activity-desc"
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Line chart: sessions, messages, and unique users per day. Each series uses a distinct color
              in the legend; the same numbers appear in the daily breakdown table below.
            </Typography>
            <Box role="group" aria-labelledby="chart-activity-desc" sx={{ width: "100%", height: 350 }}>
              <LineChart
                xAxis={[
                  {
                    data: dates.map((_, i) => i),
                    valueFormatter: (v: number) => dates[v] ?? "",
                    scaleType: "point",
                  },
                ]}
                series={[
                  { data: sessions, label: "Sessions" },
                  { data: messages, label: "Messages" },
                  { data: users, label: "Unique Users" },
                ]}
                height={320}
              />
            </Box>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h4" component="h2">
              Daily Breakdown
            </Typography>
            <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={sortedDaily.length === 0}>
              Export CSV
            </Button>
          </Stack>
          {sortedDaily.length === 0 ? (
            <EmptyHint message="No activity in this range or hour window." />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Daily breakdown">
                <TableHead>
                  <TableRow>
                    <TableCell width={50} />
                    <TableCell sortDirection={sortKey === "date" ? sortDir : false}>
                      <TableSortLabel
                        active={sortKey === "date"}
                        direction={sortKey === "date" ? sortDir : "asc"}
                        onClick={() => toggleSort("date")}
                      >
                        Date
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "sessions" ? sortDir : false}>
                      <TableSortLabel
                        active={sortKey === "sessions"}
                        direction={sortKey === "sessions" ? sortDir : "asc"}
                        onClick={() => toggleSort("sessions")}
                      >
                        Sessions
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "messages" ? sortDir : false}>
                      <TableSortLabel
                        active={sortKey === "messages"}
                        direction={sortKey === "messages" ? sortDir : "asc"}
                        onClick={() => toggleSort("messages")}
                      >
                        Messages
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "unique_users" ? sortDir : false}>
                      <TableSortLabel
                        active={sortKey === "unique_users"}
                        direction={sortKey === "unique_users" ? sortDir : "asc"}
                        onClick={() => toggleSort("unique_users")}
                      >
                        Unique Users
                      </TableSortLabel>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {sortedDaily.map((day) => (
                    <DailyRow key={day.date} day={day} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

// ---------- FAQ tab ----------

function FAQRow({ topic }: { topic: FAQData["topics"][0] }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <TableRow
        hover
        sx={{ cursor: "pointer" }}
        onClick={() => setOpen(!open)}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }}
        tabIndex={0}
        aria-expanded={open}
        aria-controls={`faq-details-${topic.topic}`}
      >
        <TableCell>
          <IconButton size="small" aria-label={open ? "Collapse" : "Expand"}>
            {open ? <ExpandLessIcon /> : <ExpandMoreIcon />}
          </IconButton>
        </TableCell>
        <TableCell>
          <Chip label={topic.topic} size="small" variant="outlined" />
        </TableCell>
        <TableCell align="right">
          <Typography fontWeight="bold">{topic.count}</Typography>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={3} sx={{ py: 0, borderBottom: open ? undefined : "none" }}>
          <Collapse in={open} timeout={200} unmountOnExit id={`faq-details-${topic.topic}`}>
            <Box sx={{ py: 1.5, pl: 6 }}>
              <Typography variant="body2" color="text.secondary" gutterBottom>
                Sample questions:
              </Typography>
              {topic.sample_questions.map((q, i) => {
                const sample = typeof q === "string" ? { question: q } : q;
                const badge = [sample.display_name, sample.agency].filter(Boolean).join(" · ");
                return (
                  <Box key={i} sx={{ py: 0.3 }}>
                    <Typography variant="body2" component="span">
                      &bull; {sample.question}
                    </Typography>
                    {badge && (
                      <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                        — {badge}
                      </Typography>
                    )}
                  </Box>
                );
              })}
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

function FAQTab({
  faqData,
  rangeLabel,
}: {
  faqData: FAQData | null;
  rangeLabel: string;
}) {
  const [search, setSearch] = useState("");
  const [minCount, setMinCount] = useState(0);

  const filtered = useMemo(() => {
    if (!faqData) return [];
    const q = search.trim().toLowerCase();
    return faqData.topics.filter((t) => {
      if (t.count < minCount) return false;
      if (!q) return true;
      if (t.topic.toLowerCase().includes(q)) return true;
      return t.sample_questions.some((s) => s.question.toLowerCase().includes(q));
    });
  }, [faqData, search, minCount]);

  const exportCSV = () => {
    if (!faqData) return;
    const rows: Array<Array<string | number>> = [
      ["Topic", "Count", "Sample Questions"],
      ...filtered.map((t) => [t.topic, t.count, t.sample_questions.map((s) => s.question).join(" | ")]),
    ];
    downloadCSV(`faq-${faqData.range?.from ?? "from"}_to_${faqData.range?.to ?? "to"}.csv`, rows);
  };

  if (!faqData || faqData.topics.length === 0) {
    return (
      <Box sx={{ mt: 3, textAlign: "center", py: 8 }}>
        <Typography variant="h4" component="h2" color="text.secondary">
          No FAQ data yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400, mx: "auto" }}>
          FAQ insights will appear here once users start chatting. Questions are
          automatically classified by topic.
        </Typography>
      </Box>
    );
  }

  const chartTopics = filtered.slice(0, 10);

  return (
    <Box sx={{ mt: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>{faqData.total_classified}</strong> questions classified in <strong>{rangeLabel}</strong> across{" "}
        <strong>{faqData.topics.length}</strong> topics
      </Alert>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          placeholder="Search topics or questions"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ minWidth: 280 }}
        />
        <TextField
          size="small"
          type="number"
          label="Min count"
          value={minCount}
          onChange={(e) => setMinCount(Math.max(0, Number.parseInt(e.target.value || "0", 10)))}
          inputProps={{ min: 0 }}
          sx={{ width: 120 }}
        />
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={filtered.length === 0}>
          Export CSV
        </Button>
      </Stack>

      {chartTopics.length > 0 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h4" component="h2" gutterBottom>
              Top Topics
            </Typography>
            <Typography
              id="chart-faq-topics-desc"
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Horizontal bar chart: question count per topic. Bar color shows magnitude; exact counts are
              in the All Topics table below.
            </Typography>
            <Box role="group" aria-labelledby="chart-faq-topics-desc" sx={{ width: "100%", height: 350 }}>
              <BarChart
                yAxis={[{ data: chartTopics.map((t) => t.topic), scaleType: "band" }]}
                xAxis={[{ label: "Questions" }]}
                series={[{ data: chartTopics.map((t) => t.count), label: "Questions" }]}
                layout="horizontal"
                height={320}
                margin={{ left: 160 }}
              />
            </Box>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h4" component="h2" gutterBottom>
            All Topics
          </Typography>
          {filtered.length === 0 ? (
            <EmptyHint message="No topics match the current search / threshold." />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="FAQ topics">
                <TableHead>
                  <TableRow>
                    <TableCell width={50} />
                    <TableCell>Topic</TableCell>
                    <TableCell align="right">Count</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((topic) => (
                    <FAQRow key={topic.topic} topic={topic} />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

// ---------- Agency tab ----------

type AgencySortKey = "agency" | "messages" | "unique_users" | "share";

function AgencyTab({
  agencyData,
  rangeLabel,
  prior,
}: {
  agencyData: AgencyData | null;
  rangeLabel: string;
  prior: AgencyData | null;
}) {
  const [expandedAgency, setExpandedAgency] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<AgencySortKey>("messages");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    if (!agencyData) return [];
    const q = search.trim().toLowerCase();
    const total = agencyData.total_messages;
    const rows = agencyData.agencies
      .filter((a) => (q ? a.agency.toLowerCase().includes(q) : true))
      .map((a) => ({ ...a, share: total > 0 ? (a.messages / total) * 100 : 0 }));
    rows.sort((a, b) => {
      const av = a[sortKey] as string | number;
      const bv = b[sortKey] as string | number;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [agencyData, search, sortKey, sortDir]);

  const toggleSort = (key: AgencySortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const exportCSV = () => {
    if (!agencyData) return;
    const rows: Array<Array<string | number>> = [
      ["Agency", "Messages", "Unique Users", "Share %", "Top Topics"],
      ...filtered.map((a) => [
        a.agency,
        a.messages,
        a.unique_users,
        a.share.toFixed(1),
        a.top_topics.map((t) => `${t.topic} (${t.count})`).join(" | "),
      ]),
    ];
    downloadCSV(`agencies-${agencyData.range?.from ?? "from"}_to_${agencyData.range?.to ?? "to"}.csv`, rows);
  };

  if (!agencyData || agencyData.agencies.length === 0) {
    return (
      <Box sx={{ mt: 3, textAlign: "center", py: 8 }}>
        <Typography variant="h4" component="h2" color="text.secondary">
          No agency data yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400, mx: "auto" }}>
          Agency analytics will appear here once users start chatting. User names
          containing an agency identifier (e.g. "A&F") are automatically parsed.
        </Typography>
      </Box>
    );
  }

  const chartAgencies = filtered.slice(0, 10);

  return (
    <Box sx={{ mt: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>{agencyData.total_messages}</strong> messages from{" "}
        <strong>{agencyData.agencies.length}</strong> agencies in <strong>{rangeLabel}</strong>
      </Alert>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Agencies Active"
            value={agencyData.agencies.length}
            previous={prior?.agencies.length}
            icon={<PeopleIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Total Messages"
            value={agencyData.total_messages}
            previous={prior?.total_messages}
            icon={<ForumIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Top Agency"
            value={agencyData.agencies[0]?.agency ?? "N/A"}
            icon={<TrendingUpIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 3 }}>
          <KPICard
            title="Top Agency Messages"
            value={agencyData.agencies[0]?.messages ?? 0}
            previous={prior?.agencies[0]?.messages}
            icon={<ChatIcon />}
          />
        </Grid>
      </Grid>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          placeholder="Search agencies"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ minWidth: 280 }}
        />
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={filtered.length === 0}>
          Export CSV
        </Button>
      </Stack>

      {chartAgencies.length > 0 && (
        <Card sx={{ mb: 3 }}>
          <CardContent>
            <Typography variant="h4" component="h2" gutterBottom>
              Messages by Agency
            </Typography>
            <Typography
              id="chart-agency-desc"
              component="p"
              variant="body2"
              color="text.secondary"
              sx={{ mb: 1 }}
            >
              Horizontal bar chart: message volume by agency. Values are also listed in the All Agencies
              table below.
            </Typography>
            <Box role="group" aria-labelledby="chart-agency-desc" sx={{ width: "100%", height: 350 }}>
              <BarChart
                yAxis={[{ data: chartAgencies.map((a) => a.agency), scaleType: "band" }]}
                xAxis={[{ label: "Messages" }]}
                series={[{ data: chartAgencies.map((a) => a.messages), label: "Messages" }]}
                layout="horizontal"
                height={320}
                margin={{ left: 160 }}
              />
            </Box>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          <Typography variant="h4" component="h2" gutterBottom>
            All Agencies
          </Typography>
          {filtered.length === 0 ? (
            <EmptyHint message="No agencies match the current search." />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Agencies">
                <TableHead>
                  <TableRow>
                    <TableCell width={50} />
                    <TableCell sortDirection={sortKey === "agency" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "agency"} direction={sortKey === "agency" ? sortDir : "asc"} onClick={() => toggleSort("agency")}>
                        Agency
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "messages" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "messages"} direction={sortKey === "messages" ? sortDir : "asc"} onClick={() => toggleSort("messages")}>
                        Messages
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "unique_users" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "unique_users"} direction={sortKey === "unique_users" ? sortDir : "asc"} onClick={() => toggleSort("unique_users")}>
                        Unique Users
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "share" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "share"} direction={sortKey === "share" ? sortDir : "asc"} onClick={() => toggleSort("share")}>
                        Share
                      </TableSortLabel>
                    </TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((ag) => {
                    const isOpen = expandedAgency === ag.agency;
                    return (
                      <React.Fragment key={ag.agency}>
                        <TableRow
                          hover
                          sx={{ cursor: "pointer" }}
                          onClick={() => setExpandedAgency(isOpen ? null : ag.agency)}
                          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedAgency(isOpen ? null : ag.agency); } }}
                          tabIndex={0}
                          aria-expanded={isOpen}
                          aria-controls={`agency-details-${ag.agency}`}
                        >
                          <TableCell>
                            <IconButton size="small" aria-label={isOpen ? "Collapse" : "Expand"}>
                              {isOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                            </IconButton>
                          </TableCell>
                          <TableCell>
                            <Chip label={ag.agency} size="small" variant="outlined" />
                          </TableCell>
                          <TableCell align="right">
                            <Typography fontWeight="bold">{ag.messages}</Typography>
                          </TableCell>
                          <TableCell align="right">{ag.unique_users}</TableCell>
                          <TableCell align="right">{ag.share.toFixed(1)}%</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell colSpan={5} sx={{ py: 0, borderBottom: isOpen ? undefined : "none" }}>
                            <Collapse in={isOpen} timeout={200} unmountOnExit id={`agency-details-${ag.agency}`}>
                              <Box sx={{ py: 1.5, pl: 6 }}>
                                <Typography variant="body2" color="text.secondary" gutterBottom>
                                  Top topics:
                                </Typography>
                                {ag.top_topics.map((t, i) => (
                                  <Typography key={i} variant="body2" sx={{ py: 0.3 }}>
                                    &bull; {t.topic} ({t.count})
                                  </Typography>
                                ))}
                              </Box>
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

// ---------- Users tab ----------

type UserSortKey = "display_name" | "agency" | "messages";

function UsersTab({
  userData,
  rangeLabel,
}: {
  userData: UserData | null;
  rangeLabel: string;
}) {
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [minMessages, setMinMessages] = useState(0);
  const [sortKey, setSortKey] = useState<UserSortKey>("messages");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    if (!userData) return [];
    const q = search.trim().toLowerCase();
    const rows = userData.users.filter((u) => {
      if (u.messages < minMessages) return false;
      if (!q) return true;
      return (
        u.display_name.toLowerCase().includes(q) ||
        u.agency.toLowerCase().includes(q) ||
        u.user_id.toLowerCase().includes(q)
      );
    });
    rows.sort((a, b) => {
      const av = a[sortKey] as string | number;
      const bv = b[sortKey] as string | number;
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [userData, search, minMessages, sortKey, sortDir]);

  const toggleSort = (key: UserSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const exportCSV = () => {
    if (!userData) return;
    const rows: Array<Array<string | number>> = [
      ["User", "Agency", "Messages", "Top Topics"],
      ...filtered.map((u) => [
        u.display_name,
        u.agency,
        u.messages,
        u.top_topics.map((t) => `${t.topic} (${t.count})`).join(" | "),
      ]),
    ];
    downloadCSV(`users-${userData.range?.from ?? "from"}_to_${userData.range?.to ?? "to"}.csv`, rows);
  };

  if (!userData || userData.users.length === 0) {
    return (
      <Box sx={{ mt: 3, textAlign: "center", py: 8 }}>
        <Typography variant="h4" component="h2" color="text.secondary">
          No user data yet
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, maxWidth: 400, mx: "auto" }}>
          User-level analytics will appear here once users start chatting.
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 3 }}>
      <Alert severity="info" sx={{ mb: 3 }}>
        <strong>{userData.total_messages}</strong> messages from{" "}
        <strong>{userData.users.length}</strong> users in <strong>{rangeLabel}</strong>
      </Alert>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
        <TextField
          size="small"
          placeholder="Search users or agencies"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          sx={{ minWidth: 280 }}
        />
        <TextField
          size="small"
          type="number"
          label="Min messages"
          value={minMessages}
          onChange={(e) => setMinMessages(Math.max(0, Number.parseInt(e.target.value || "0", 10)))}
          inputProps={{ min: 0 }}
          sx={{ width: 140 }}
        />
        <Box sx={{ flex: 1 }} />
        <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV} disabled={filtered.length === 0}>
          Export CSV
        </Button>
      </Stack>

      <Card>
        <CardContent>
          <Typography variant="h4" component="h2" gutterBottom>
            All Users
          </Typography>
          {filtered.length === 0 ? (
            <EmptyHint message="No users match the current search / threshold." />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Users">
                <TableHead>
                  <TableRow>
                    <TableCell width={50} />
                    <TableCell sortDirection={sortKey === "display_name" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "display_name"} direction={sortKey === "display_name" ? sortDir : "asc"} onClick={() => toggleSort("display_name")}>
                        User
                      </TableSortLabel>
                    </TableCell>
                    <TableCell sortDirection={sortKey === "agency" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "agency"} direction={sortKey === "agency" ? sortDir : "asc"} onClick={() => toggleSort("agency")}>
                        Agency
                      </TableSortLabel>
                    </TableCell>
                    <TableCell align="right" sortDirection={sortKey === "messages" ? sortDir : false}>
                      <TableSortLabel active={sortKey === "messages"} direction={sortKey === "messages" ? sortDir : "asc"} onClick={() => toggleSort("messages")}>
                        Messages
                      </TableSortLabel>
                    </TableCell>
                    <TableCell>Top Topics</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filtered.map((u) => {
                    const isOpen = expandedUser === u.user_id;
                    return (
                      <React.Fragment key={u.user_id}>
                        <TableRow
                          hover
                          sx={{ cursor: "pointer" }}
                          onClick={() => setExpandedUser(isOpen ? null : u.user_id)}
                          onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedUser(isOpen ? null : u.user_id); } }}
                          tabIndex={0}
                          aria-expanded={isOpen}
                          aria-controls={`user-details-${u.user_id}`}
                        >
                          <TableCell>
                            <IconButton size="small" aria-label={isOpen ? "Collapse" : "Expand"}>
                              {isOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                            </IconButton>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" alignItems="center" spacing={1}>
                              <PersonIcon fontSize="small" color="action" />
                              <Typography variant="body2" fontWeight="bold">{u.display_name}</Typography>
                            </Stack>
                          </TableCell>
                          <TableCell>
                            <Chip label={u.agency} size="small" variant="outlined" />
                          </TableCell>
                          <TableCell align="right">
                            <Typography fontWeight="bold">{u.messages}</Typography>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                              {u.top_topics.slice(0, 3).map((t) => (
                                <Chip key={t.topic} label={`${t.topic} (${t.count})`} size="small" variant="outlined" />
                              ))}
                            </Stack>
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell colSpan={5} sx={{ py: 0, borderBottom: isOpen ? undefined : "none" }}>
                            <Collapse in={isOpen} timeout={200} unmountOnExit id={`user-details-${u.user_id}`}>
                              <Box sx={{ py: 1.5, pl: 6 }}>
                                <Typography variant="body2" color="text.secondary" gutterBottom>
                                  Recent questions:
                                </Typography>
                                {u.recent_questions.map((q, i) => (
                                  <Box key={i} sx={{ py: 0.3 }}>
                                    <Typography variant="body2" component="span">
                                      &bull; {q.question}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                                      — {q.topic}
                                    </Typography>
                                  </Box>
                                ))}
                              </Box>
                            </Collapse>
                          </TableCell>
                        </TableRow>
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>
    </Box>
  );
}

// ---------- Time of Day tab ----------

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function TimeOfDayTab({ metrics }: { metrics: MetricsData }) {
  const theme = useTheme();
  const matrix = metrics.hour_by_weekday ?? [];

  const max = useMemo(() => {
    let m = 0;
    for (const row of matrix) for (const v of row) if (v > m) m = v;
    return m;
  }, [matrix]);

  const hourly = metrics.hourly_distribution ?? [];
  const peakHour = hourly.reduce((best, cur) => (cur.sessions > (best?.sessions ?? -1) ? cur : best), null as null | { hour: string; sessions: number });
  const businessHours = hourly.reduce(
    (acc, h) => {
      const hour = Number.parseInt(h.hour.slice(0, 2), 10);
      if (hour >= 9 && hour <= 17) acc.business += h.sessions;
      else acc.off += h.sessions;
      return acc;
    },
    { business: 0, off: 0 }
  );
  const total = businessHours.business + businessHours.off;
  const offHoursPct = total > 0 ? (businessHours.off / total) * 100 : 0;

  const exportCSV = () => {
    const header = ["Hour", ...DAY_LABELS];
    const rows: Array<Array<string | number>> = [header];
    for (let h = 0; h < 24; h++) {
      const row: Array<string | number> = [`${String(h).padStart(2, "0")}:00`];
      for (let d = 0; d < 7; d++) row.push(matrix[h]?.[d] ?? 0);
      rows.push(row);
    }
    downloadCSV(`time-of-day-${metrics.range?.from ?? "from"}_to_${metrics.range?.to ?? "to"}.csv`, rows);
  };

  if (max === 0) {
    return (
      <Box sx={{ mt: 3 }}>
        <EmptyHint message="No activity in the selected range — try a wider date range or removing the hour filter." />
      </Box>
    );
  }

  const cellColor = (v: number) => {
    if (v === 0) return alpha(theme.palette.action.disabledBackground, 0.4);
    const intensity = Math.min(1, v / max);
    return alpha(theme.palette.primary.main, 0.15 + intensity * 0.7);
  };

  return (
    <Box sx={{ mt: 3 }}>
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <KPICard
            title="Peak Hour (ET)"
            value={peakHour ? `${peakHour.hour} ET` : "N/A"}
            icon={<AccessTimeIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <KPICard
            title="Business-Hours Messages"
            value={businessHours.business}
            icon={<ForumIcon />}
          />
        </Grid>
        <Grid size={{ xs: 12, sm: 6, md: 4 }}>
          <KPICard
            title="Off-Hours %"
            value={`${offHoursPct.toFixed(1)}%`}
            icon={<TrendingUpIcon />}
          />
        </Grid>
      </Grid>

      <Card>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="h4" component="h2">
              Hour × Day-of-Week Heatmap
            </Typography>
            <Button size="small" startIcon={<DownloadIcon />} onClick={exportCSV}>
              Export CSV
            </Button>
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Message volume by hour of day (rows) and day of week (columns). All times in America/New_York.
            Darker = more activity.
          </Typography>

          <Box sx={{ overflowX: "auto" }}>
            <Box sx={{ display: "grid", gridTemplateColumns: "60px repeat(7, 1fr)", gap: 0.5, minWidth: 560 }}>
              <Box />
              {DAY_LABELS.map((d) => (
                <Box key={d} sx={{ textAlign: "center" }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={600}>
                    {d}
                  </Typography>
                </Box>
              ))}
              {Array.from({ length: 24 }, (_, h) => (
                <React.Fragment key={h}>
                  <Box sx={{ textAlign: "right", pr: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {String(h).padStart(2, "0")}:00
                    </Typography>
                  </Box>
                  {DAY_LABELS.map((_, d) => {
                    const v = matrix[h]?.[d] ?? 0;
                    return (
                      <Tooltip key={d} title={`${DAY_LABELS[d]} ${String(h).padStart(2, "0")}:00 — ${v} messages`}>
                        <Box
                          sx={{
                            bgcolor: cellColor(v),
                            borderRadius: 0.5,
                            height: 22,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            cursor: "default",
                          }}
                          aria-label={`${DAY_LABELS[d]} ${h}:00 ${v} messages`}
                        >
                          {v > 0 && max > 0 && v / max > 0.5 && (
                            <Typography variant="caption" sx={{ fontSize: 10, color: "primary.contrastText" }}>
                              {v}
                            </Typography>
                          )}
                        </Box>
                      </Tooltip>
                    );
                  })}
                </React.Fragment>
              ))}
            </Box>
          </Box>

          <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 2 }}>
            <Typography variant="caption" color="text.secondary">
              Less
            </Typography>
            <Stack direction="row" spacing={0.5}>
              {[0.15, 0.3, 0.5, 0.7, 0.85].map((p) => (
                <Box
                  key={p}
                  sx={{
                    width: 18,
                    height: 18,
                    borderRadius: 0.5,
                    bgcolor: alpha(theme.palette.primary.main, p),
                  }}
                />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              More
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <Box sx={{ textAlign: "center", py: 6 }}>
      <Typography variant="body2" color="text.secondary">
        {message}
      </Typography>
    </Box>
  );
}

// ---------- Main page ----------

export default function MetricsPage() {
  useDocumentTitle("Admin · Metrics");
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState<FilterState>(() => filtersFromSearchParams(searchParams));

  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [faqData, setFaqData] = useState<FAQData | null>(null);
  const [agencyData, setAgencyData] = useState<AgencyData | null>(null);
  const [userData, setUserData] = useState<UserData | null>(null);
  const [priorMetrics, setPriorMetrics] = useState<MetricsData | null>(null);
  const [priorAgency, setPriorAgency] = useState<AgencyData | null>(null);
  // Separate, unfiltered agency list so the dropdown doesn't collapse to one entry
  // once the user picks an agency.
  const [knownAgencies, setKnownAgencies] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tabIndex, setTabIndex] = useState(0);
  const appContext = useContext(AppContext);
  const apiClient = useMemo(() => new ApiClient(appContext!), [appContext]);

  // Sync filter state -> URL
  useEffect(() => {
    const next = filtersToSearchParams(filters);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const rangeValid = filters.from <= filters.to;
  const rangeLabel = formatRangeLabel(filters.from, filters.to);

  const loadAllData = useCallback(async () => {
    if (!rangeValid) return;
    try {
      setLoading(true);
      setError(null);
      const apiFilters = filterStateToApiFilters(filters);
      const [metricsRes, faqRes, agencyRes, userRes] = await Promise.all([
        apiClient.metrics.getMetrics(apiFilters),
        apiClient.metrics.getFAQInsights(apiFilters).catch(() => null),
        apiClient.metrics.getAgencyBreakdown(apiFilters).catch(() => null),
        apiClient.metrics.getUserBreakdown(apiFilters).catch(() => null),
      ]);
      setMetrics(metricsRes);
      setFaqData(faqRes);
      setAgencyData(agencyRes);
      setUserData(userRes);
      // Refresh the dropdown's option list only when we have a complete view.
      if (!filters.agency && agencyRes?.agencies) {
        setKnownAgencies(agencyRes.agencies.map((a: { agency: string }) => a.agency));
      }

      if (filters.compare) {
        const priorFilters = previousPeriodFilters(filters);
        const [priorMetricsRes, priorAgencyRes] = await Promise.all([
          apiClient.metrics.getMetrics(priorFilters).catch(() => null),
          apiClient.metrics.getAgencyBreakdown(priorFilters).catch(() => null),
        ]);
        setPriorMetrics(priorMetricsRes);
        setPriorAgency(priorAgencyRes);
      } else {
        setPriorMetrics(null);
        setPriorAgency(null);
      }
    } catch (e: any) {
      setError(e.message || "Failed to load metrics");
    } finally {
      setLoading(false);
    }
  }, [apiClient, filters, rangeValid]);

  useEffect(() => {
    loadAllData();
  }, [loadAllData]);

  const agencyOptions = useMemo(() => {
    const set = new Set<string>();
    knownAgencies.forEach((a) => set.add(a));
    agencyData?.agencies.forEach((a) => set.add(a.agency));
    if (filters.agency) set.add(filters.agency);
    return Array.from(set).sort();
  }, [knownAgencies, agencyData, filters.agency]);

  return (
    <AdminPageLayout
      title="Analytics"
      description="Usage metrics and FAQ insights for the chatbot."
      breadcrumbLabel="Analytics"
      actions={
        <Tooltip title="Refresh data">
          <IconButton onClick={loadAllData} disabled={loading || !rangeValid} aria-label="Refresh analytics">
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      }
    >
      <FilterBar state={filters} onChange={setFilters} agencies={agencyOptions} />

      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {!rangeValid && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The "From" date must be on or before the "To" date.
        </Alert>
      )}

      {loading ? (
        <Stack spacing={2}>
          <Grid container spacing={2}>
            {[1, 2, 3, 4].map((i) => (
              <Grid key={i} size={{ xs: 12, sm: 6, md: 3 }}>
                <Skeleton variant="rounded" height={100} />
              </Grid>
            ))}
          </Grid>
          <Skeleton variant="rounded" height={350} />
        </Stack>
      ) : (
        <>
          <Tabs
            value={tabIndex}
            onChange={(_, v) => setTabIndex(v)}
            aria-label="Metrics sections"
            sx={{ borderBottom: 1, borderColor: "divider" }}
            variant="scrollable"
            scrollButtons="auto"
          >
            <Tab label="Overview" id="metrics-tab-0" aria-controls="metrics-tabpanel-0" />
            <Tab label="FAQ Insights" id="metrics-tab-1" aria-controls="metrics-tabpanel-1" />
            <Tab label="By Agency" id="metrics-tab-2" aria-controls="metrics-tabpanel-2" />
            <Tab label="By User" id="metrics-tab-3" aria-controls="metrics-tabpanel-3" />
            <Tab label="Time of Day" id="metrics-tab-4" aria-controls="metrics-tabpanel-4" />
          </Tabs>
          {tabIndex === 0 && metrics && (
            <Box role="tabpanel" id="metrics-tabpanel-0" aria-labelledby="metrics-tab-0">
              <OverviewTab metrics={metrics} prior={priorMetrics} rangeLabel={rangeLabel} />
            </Box>
          )}
          {tabIndex === 1 && (
            <Box role="tabpanel" id="metrics-tabpanel-1" aria-labelledby="metrics-tab-1">
              <FAQTab faqData={faqData} rangeLabel={rangeLabel} />
            </Box>
          )}
          {tabIndex === 2 && (
            <Box role="tabpanel" id="metrics-tabpanel-2" aria-labelledby="metrics-tab-2">
              <AgencyTab agencyData={agencyData} rangeLabel={rangeLabel} prior={priorAgency} />
            </Box>
          )}
          {tabIndex === 3 && (
            <Box role="tabpanel" id="metrics-tabpanel-3" aria-labelledby="metrics-tab-3">
              <UsersTab userData={userData} rangeLabel={rangeLabel} />
            </Box>
          )}
          {tabIndex === 4 && metrics && (
            <Box role="tabpanel" id="metrics-tabpanel-4" aria-labelledby="metrics-tab-4">
              <TimeOfDayTab metrics={metrics} />
            </Box>
          )}
        </>
      )}
    </AdminPageLayout>
  );
}
