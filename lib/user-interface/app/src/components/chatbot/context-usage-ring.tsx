/**
 * ContextUsageRing -- compact circular indicator of how full the model's
 * context window is for the current conversation. Mirrors the live "memory"
 * indicators used in Cursor / Codex / ChatGPT to give users an at-a-glance
 * sense of when the conversation is approaching its limits.
 *
 * Hidden until the first response of the session arrives (`usage` is null).
 * Color:
 *   - <70%   : success.main (green)   -- plenty of room
 *   - 70-85% : warning.main (yellow)  -- background compaction may kick in
 *   - >85%   : error.main   (red)     -- final compaction round ahead
 *
 * Tooltip on hover shows the raw token counts and the compaction-round
 * counter (the latter is a useful debug breadcrumb if a user reports the
 * conversation feeling "shorter" -- the backend has been summarizing).
 */
import Box from "@mui/material/Box";
import CircularProgress from "@mui/material/CircularProgress";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { ContextUsage } from "./types";

interface Props {
  usage: ContextUsage | null;
}

/** Threshold (%) above which the ring turns yellow. */
const WARN_THRESHOLD = 70;
/** Threshold (%) above which the ring turns red. */
const DANGER_THRESHOLD = 85;
/** Outer diameter (px) of the ring. */
const RING_SIZE = 26;
/** Stroke thickness of the ring. */
const RING_THICKNESS = 3.5;

function colorFor(percent: number): "success" | "warning" | "error" {
  if (percent >= DANGER_THRESHOLD) return "error";
  if (percent >= WARN_THRESHOLD) return "warning";
  return "success";
}

export default function ContextUsageRing({ usage }: Props) {
  if (!usage || typeof usage.percent !== "number") return null;

  const percent = Math.max(0, Math.min(100, usage.percent));
  const color = colorFor(percent);
  const tokensLabel = usage.estimatedTokens.toLocaleString();
  const maxLabel = usage.maxTokens.toLocaleString();
  const compactionLabel =
    usage.compactionRounds > 0
      ? ` (${usage.compactionRounds} compaction round${usage.compactionRounds === 1 ? "" : "s"} applied)`
      : "";

  return (
    <Tooltip
      title={`Conversation memory: ~${tokensLabel} / ${maxLabel} tokens used (${percent}%)${compactionLabel}`}
      arrow
    >
      <Box
        role="progressbar"
        aria-label={`Conversation memory ${percent}% full`}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        sx={{
          position: "relative",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: RING_SIZE,
          height: RING_SIZE,
        }}
      >
        {/* Track */}
        <CircularProgress
          variant="determinate"
          value={100}
          size={RING_SIZE}
          thickness={RING_THICKNESS}
          aria-hidden="true"
          sx={{ color: "action.disabledBackground", position: "absolute" }}
        />
        {/* Filled portion */}
        <CircularProgress
          variant="determinate"
          value={percent}
          size={RING_SIZE}
          thickness={RING_THICKNESS}
          color={color}
          aria-hidden="true"
        />
        {/* Centered percentage */}
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Typography
            sx={{
              fontSize: 9,
              fontWeight: 600,
              color: `${color}.main`,
              lineHeight: 1,
            }}
          >
            {percent}
          </Typography>
        </Box>
      </Box>
    </Tooltip>
  );
}
