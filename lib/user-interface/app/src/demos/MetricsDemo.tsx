/**
 * MetricsDemo — the Analytics admin dashboard: 4 KPI stat cards that count up,
 * then a "questions per day" line chart and a "top FAQ categories" bar chart
 * reveal in sequence, then a long settled hold.
 *
 * Mirrors ChatDemo.tsx conventions: a single useSteps() counter drives one
 * editable TIMINGS array, one view is rendered, and the charts mount into
 * fixed-height containers so nothing reflows as they appear. Faithful to the
 * real pages/admin/metrics-page.tsx (Grid2 KPI cards + @mui/x-charts).
 *
 * Passive dashboard view — no click interaction, so no MouseCursor.
 */
import { useEffect, useRef, useState } from "react";
import { Paper, Typography, Box } from "@mui/material";
import Grid from "@mui/material/Grid2";
import { LineChart } from "@mui/x-charts/LineChart";
import { BarChart } from "@mui/x-charts/BarChart";
import { AppShell } from "./app-shell";
import { DemoFrame, DemoStyle, useSteps } from "./demo-kit";

/** ms per step — keep editable. */
export const TIMINGS = [1900, 1600, 1600, 1400, 3000];
/** card geometry → recorder viewport (computed in registry). */
export const CARD = { width: 1180, bodyHeight: 720 };

// Step map
const S = {
  KPIS: 0, // header + 4 KPI cards counting up
  LINE: 1, // questions-per-day line chart appears
  BARS: 2, // top FAQ categories bar chart appears
  SETTLED: 3, // everything settled
  HOLD: 4, // long hold before loop
};

const ABE_BLUE = "#14558F";

/* ── demo-only styles ──────────────────────────────────────────────────────── */
const METRICS_CSS = `
.abe-metrics-head { animation:fadeIn 360ms ease both; }
.abe-crumb {
  font-size:0.8125rem; color:var(--abe-textTertiary); font-weight:500;
  display:flex; align-items:center; gap:7px; margin-bottom:6px;
}
.abe-crumb .sep { opacity:0.55; }
.abe-crumb .leaf { color:var(--abe-textSecondary); }
.abe-kpi { animation:abeRise 480ms cubic-bezier(0.4,0,0.2,1) both; }
.abe-kpi-1 { animation-delay:40ms; }
.abe-kpi-2 { animation-delay:110ms; }
.abe-kpi-3 { animation-delay:180ms; }
.abe-kpi-4 { animation-delay:250ms; }
.abe-chartcard { animation:abeRise 520ms cubic-bezier(0.4,0,0.2,1) both; }
.abe-chartfill { animation:fadeIn 460ms ease both; }
`;

/* ── count-up hook: ramps 0 → target via requestAnimationFrame when active ──── */
function useCountUp(target: number, active: boolean, ms = 900): number {
  const [value, setValue] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      setValue(0);
      return undefined;
    }
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const elapsed = t - start;
      const p = Math.min(1, elapsed / ms);
      // easeOutCubic for a settling feel
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(target * eased);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, active, ms]);

  return value;
}

type KpiFormat = "int" | "seconds" | "percent";

function formatKpi(value: number, format: KpiFormat): string {
  switch (format) {
    case "seconds":
      return `${value.toFixed(1)}s`;
    case "percent":
      return `${Math.round(value)}%`;
    case "int":
    default:
      return Math.round(value).toLocaleString("en-US");
  }
}

function StatCard({
  label,
  target,
  format,
  active,
  cls,
}: {
  label: string;
  target: number;
  format: KpiFormat;
  active: boolean;
  cls: string;
}) {
  const value = useCountUp(target, active);
  return (
    <Paper className={`abe-kpi ${cls}`} sx={{ p: 2 }}>
      <Typography variant="subtitle2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h4" fontWeight="bold" sx={{ mt: 0.5 }}>
        {formatKpi(value, format)}
      </Typography>
    </Paper>
  );
}

const KPI_CARDS: { label: string; target: number; format: KpiFormat }[] = [
  { label: "Questions (30d)", target: 3482, format: "int" },
  { label: "Active users", target: 214, format: "int" },
  { label: "Avg. response", target: 8.4, format: "seconds" },
  { label: "Helpful rate", target: 92, format: "percent" },
];

const LINE_DATA = [42, 55, 61, 48, 73, 69, 88, 79, 94, 102, 96, 118, 124, 131];
const LINE_X = [
  "5/21", "5/22", "5/23", "5/24", "5/25", "5/26", "5/27",
  "5/28", "5/29", "5/30", "5/31", "6/1", "6/2", "6/3",
];

const BAR_CATEGORIES = [
  "Statewide Contracts",
  "Bidding",
  "Exceptions",
  "Vendors",
  "Compliance",
  "Other",
];
const BAR_DATA = [1240, 720, 560, 430, 380, 210];

export default function MetricsDemo() {
  const step = useSteps(TIMINGS);
  const countingActive = step >= S.LINE; // count up once KPI cards have mounted

  return (
    <>
      <DemoStyle css={METRICS_CSS} />
      <DemoFrame url="/admin/metrics" width={CARD.width} bodyHeight={CARD.bodyHeight}>
        <AppShell active="metrics">
          <Box sx={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* Header */}
            <Box className="abe-metrics-head">
              <Box className="abe-crumb">
                <span>ABE - Assistive Buyer Engine</span>
                <span className="sep">›</span>
                <span className="leaf">Analytics</span>
              </Box>
              <Typography variant="h2" component="h1">
                Analytics
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Usage, traffic, and FAQ insights for ABE.
              </Typography>
            </Box>

            {/* KPI stat cards */}
            <Grid container spacing={2} sx={{ mt: 2 }}>
              {KPI_CARDS.map((k, i) => (
                <Grid key={k.label} size={{ xs: 6, md: 3 }}>
                  <StatCard
                    label={k.label}
                    target={k.target}
                    format={k.format}
                    active={countingActive}
                    cls={`abe-kpi-${i + 1}`}
                  />
                </Grid>
              ))}
            </Grid>

            {/* Charts */}
            <Grid container spacing={2} sx={{ mt: 2 }}>
              <Grid size={{ xs: 12, md: 7 }}>
                <Paper sx={{ p: 2 }} className={step >= S.LINE ? "abe-chartcard" : undefined}>
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                    Questions per day · last 14 days
                  </Typography>
                  {/* Fixed-height container, always present, so nothing reflows */}
                  <Box sx={{ height: 260 }}>
                    {step >= S.LINE && (
                      <Box className="abe-chartfill" sx={{ height: "100%" }}>
                        <LineChart
                          height={250}
                          margin={{ left: 40, right: 16, top: 16, bottom: 24 }}
                          series={[
                            {
                              data: LINE_DATA,
                              label: "Questions",
                              color: ABE_BLUE,
                              area: true,
                              showMark: false,
                              curve: "monotoneX",
                            },
                          ]}
                          xAxis={[{ data: LINE_X, scaleType: "point" }]}
                        />
                      </Box>
                    )}
                  </Box>
                </Paper>
              </Grid>

              <Grid size={{ xs: 12, md: 5 }}>
                <Paper sx={{ p: 2 }} className={step >= S.BARS ? "abe-chartcard" : undefined}>
                  <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                    Top FAQ categories
                  </Typography>
                  {/* Fixed-height container, always present, so nothing reflows */}
                  <Box sx={{ height: 260 }}>
                    {step >= S.BARS && (
                      <Box className="abe-chartfill" sx={{ height: "100%" }}>
                        <BarChart
                          height={250}
                          layout="horizontal"
                          margin={{ left: 140, right: 16, top: 16, bottom: 24 }}
                          yAxis={[{ data: BAR_CATEGORIES, scaleType: "band" }]}
                          series={[{ data: BAR_DATA, color: ABE_BLUE }]}
                        />
                      </Box>
                    )}
                  </Box>
                </Paper>
              </Grid>
            </Grid>
          </Box>
        </AppShell>
      </DemoFrame>
    </>
  );
}
