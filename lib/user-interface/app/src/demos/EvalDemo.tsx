/**
 * EvalDemo — Quality Monitoring flow: kick off a RAGAS evaluation run, watch it
 * progress, then snap to the detailed scorecard (roll-up SummaryCards + a
 * per-question results table with color-coded score chips).
 *
 * Same conventions as ChatDemo: single useSteps() counter, one editable TIMINGS
 * array, two views rendered one-at-a-time by phase. The url prop flips when the
 * run completes so the snap reads as a router navigation. Mirrors the real
 * pages/admin/llm-evaluation-page.tsx + detailed-evaluation-page.tsx.
 */
import { useEffect, useRef, useState } from "react";
import { AppShell } from "./app-shell";
import { DemoFrame, DemoStyle, useSteps, Spinner } from "./demo-kit";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Button from "@mui/material/Button";
import Table from "@mui/material/Table";
import TableHead from "@mui/material/TableHead";
import TableBody from "@mui/material/TableBody";
import TableRow from "@mui/material/TableRow";
import TableCell from "@mui/material/TableCell";
import TableContainer from "@mui/material/TableContainer";
import Grid from "@mui/material/Grid2";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";

/** ms per step — keep editable. */
export const TIMINGS = [1900, 1900, 1700, 1700, 3000];
/** card geometry → recorder viewport (computed in registry). */
export const CARD = { width: 1140, bodyHeight: 772 };

// Step map
const S = {
  GENERATING: 0, // running view, progress 35%, "Generating responses"
  SCORING: 1, // running view, progress 78%, "Scoring with RAGAS"
  CARDS: 2, // results view, roll-up SummaryCards count up
  TABLE: 3, // results view, per-question results table rises in
  HOLD: 4, // long hold before loop
};

/* ── score helpers (reproduced exactly from detailed-evaluation-page.tsx) ──── */
type ScoreColor = "success" | "warning" | "error";
const scoreColor = (pct: number): ScoreColor =>
  pct >= 75 ? "success" : pct >= 50 ? "warning" : "error";
const scoreBg = (pct: number): string =>
  pct >= 75 ? "success.light" : pct >= 50 ? "warning.light" : "error.light";
const tier = (pct: number): string =>
  pct >= 75 ? "Strong" : pct >= 50 ? "Moderate" : "Needs improvement";

/* ── roll-up summary cards ─────────────────────────────────────────────────── */
const SUMMARY: { title: string; pct: number }[] = [
  { title: "Answer Quality", pct: 88 },
  { title: "Retrieval Quality", pct: 71 },
  { title: "Response Quality", pct: 91 },
];

/* ── per-question results (question + [correctness, similarity, faithfulness, recall]) ── */
const ROWS: { q: string; v: [number, number, number, number] }[] = [
  {
    q: "How do I make a purchase under a Statewide Contract?",
    v: [0.92, 0.88, 0.95, 0.81],
  },
  { q: "When can I use a sole-source exception?", v: [0.78, 0.74, 0.69, 0.72] },
  { q: "Which vendors are on FAC107?", v: [0.95, 0.9, 0.93, 0.66] },
  { q: "What are the bid protest deadlines?", v: [0.71, 0.69, 0.58, 0.49] },
];

/* ── small count-up hook (rAF), runs once the cards mount ──────────────────── */
function useCountUp(target: number, run: boolean, ms = 700): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!run) {
      setVal(0);
      return undefined;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      // easeOutCubic for a snappy settle
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);
  return val;
}

const EVAL_CSS = `
.abe-eval-check svg { font-size:20px; }
.abe-eval-row { animation:abeRise 420ms cubic-bezier(0.4,0,0.2,1) both; }
.abe-eval-card { animation:abeRise 440ms cubic-bezier(0.4,0,0.2,1) both; }
`;

/* ── running checklist item ────────────────────────────────────────────────── */
type ItemState = "done" | "active" | "pending";
function ChecklistItem({ state, label }: { state: ItemState; label: string }) {
  return (
    <Stack direction="row" spacing={1.25} alignItems="center" className="abe-eval-check">
      {state === "done" && <CheckCircleIcon color="success" />}
      {state === "active" && (
        <Box sx={{ width: 20, display: "flex", justifyContent: "center" }}>
          <Spinner size={16} />
        </Box>
      )}
      {state === "pending" && (
        <RadioButtonUncheckedIcon sx={{ color: "text.disabled" }} />
      )}
      <Typography
        variant="body2"
        sx={{
          color: state === "pending" ? "text.disabled" : "text.primary",
          fontWeight: state === "active" ? 600 : 400,
        }}
      >
        {label}
      </Typography>
    </Stack>
  );
}

/* ── VIEW A: running evaluation ────────────────────────────────────────────── */
function RunningView({ step }: { step: number }) {
  const pct = step === S.GENERATING ? 35 : 78;
  const caption =
    step === S.GENERATING
      ? "Generating responses for 24 test cases…"
      : "Scoring with RAGAS metrics…";
  const states: ItemState[] =
    step === S.GENERATING
      ? ["active", "pending", "pending"]
      : ["done", "active", "pending"];

  return (
    <Box sx={{ pt: 6 }}>
      <Paper sx={{ p: 3, maxWidth: 560, mx: "auto" }}>
        <Typography variant="h6">Running evaluation</Typography>
        <LinearProgress
          variant="determinate"
          value={pct}
          sx={{ height: 8, borderRadius: 1, my: 2 }}
        />
        <Typography variant="body2" color="text.secondary">
          {caption}
        </Typography>
        <Stack spacing={1.5} sx={{ mt: 2.5 }}>
          <ChecklistItem state={states[0]} label="Generating responses" />
          <ChecklistItem state={states[1]} label="Scoring with RAGAS" />
          <ChecklistItem state={states[2]} label="Aggregating results" />
        </Stack>
      </Paper>
    </Box>
  );
}

/* ── one roll-up summary card ──────────────────────────────────────────────── */
function SummaryCard({
  title,
  pct,
  run,
  delay,
}: {
  title: string;
  pct: number;
  run: boolean;
  delay: number;
}) {
  const shown = useCountUp(pct, run);
  return (
    <Paper
      className="abe-eval-card"
      sx={{ p: 2, bgcolor: scoreBg(pct), textAlign: "center", animationDelay: `${delay}ms` }}
    >
      <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center">
        <Typography variant="subtitle2" color="text.secondary">
          {title}
        </Typography>
        <InfoOutlinedIcon sx={{ fontSize: 14, color: "text.secondary" }} />
      </Stack>
      <Typography variant="h4" fontWeight="bold" sx={{ my: 0.5 }}>
        {shown}%
      </Typography>
      <Chip label={tier(pct)} color={scoreColor(pct)} size="small" variant="outlined" />
    </Paper>
  );
}

/* ── VIEW B: results / scorecard ───────────────────────────────────────────── */
function ResultsView({ step }: { step: number }) {
  return (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Typography variant="h5">Evaluation Details</Typography>
        <Button variant="text">Back to History</Button>
      </Stack>

      <Grid container spacing={2}>
        {SUMMARY.map((c, i) => (
          <Grid key={c.title} size={{ xs: 12, md: 4 }}>
            <SummaryCard title={c.title} pct={c.pct} run={step >= S.CARDS} delay={i * 90} />
          </Grid>
        ))}
      </Grid>

      {step >= S.TABLE && (
        <Box sx={{ mt: 3 }}>
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ mb: 1.5 }}
          >
            <Typography variant="h6">Per-Question Results</Typography>
            <Button variant="outlined" size="small">
              Export CSV
            </Button>
          </Stack>
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Question</TableCell>
                  <TableCell align="center">Correctness</TableCell>
                  <TableCell align="center">Similarity</TableCell>
                  <TableCell align="center">Faithfulness</TableCell>
                  <TableCell align="center">Context Recall</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {ROWS.map((r, ri) => (
                  <TableRow
                    key={r.q}
                    className="abe-eval-row"
                    sx={{ animationDelay: `${ri * 80}ms` }}
                  >
                    <TableCell sx={{ maxWidth: 420 }}>{r.q}</TableCell>
                    {r.v.map((v, vi) => (
                      <TableCell key={vi} align="center">
                        <Chip
                          size="small"
                          label={v.toFixed(2)}
                          color={scoreColor(v * 100)}
                          variant="outlined"
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}
    </Box>
  );
}

export default function EvalDemo() {
  const step = useSteps(TIMINGS);
  const bodyRef = useRef<HTMLDivElement>(null);

  const isRunning = step <= S.SCORING;
  // tab 1 = "Run Evaluation" while running; tab 2 = "History" once we land on
  // the detail page (reached via the History list).
  const tabValue = isRunning ? 1 : 2;
  // URL flips at completion so the snap reads as a router navigation.
  const url = isRunning
    ? "/admin/llm-evaluation#run"
    : "/admin/llm-evaluation/eval-2026-06-03";

  return (
    <>
      <DemoStyle css={EVAL_CSS} />
      <DemoFrame url={url} width={CARD.width} bodyHeight={CARD.bodyHeight} bodyRef={bodyRef}>
        <AppShell active="quality">
          <Box sx={{ height: "100%", overflow: "hidden" }}>
            <Typography sx={{ fontSize: "0.8125rem", color: "text.secondary", mb: 0.5 }}>
              ABE - Assistive Buyer Engine&nbsp;&nbsp;›&nbsp;&nbsp;Quality Monitoring
            </Typography>
            <Typography variant="h2" component="h1">
              Quality Monitoring
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Monitor, test, and curate your chatbot's response quality.
            </Typography>

            <Tabs value={tabValue} sx={{ borderBottom: 1, borderColor: "divider", mt: 2, mb: 3 }}>
              <Tab label="Dashboard" />
              <Tab label="Run Evaluation" />
              <Tab label="History" />
              <Tab label="Test Library" />
            </Tabs>

            {isRunning ? <RunningView step={step} /> : <ResultsView step={step} />}
          </Box>
        </AppShell>
      </DemoFrame>
    </>
  );
}
