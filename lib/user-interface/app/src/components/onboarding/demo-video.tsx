/**
 * DemoVideo — a short, muted, looping product walkthrough clip.
 *
 * Used in two places: the Help page (click to play) and the one-time
 * onboarding dialog (auto-plays). We ship the MP4 (~0.6 MB) instead of the
 * 3.7 MB GIF so it loads quickly and stays sharp, and we always render native
 * controls so the looping clip can be paused (WCAG 2.2.2).
 */
import { useEffect, useRef } from "react";
import Box from "@mui/material/Box";
import useMediaQuery from "@mui/material/useMediaQuery";

/** Served from lib/user-interface/app/public/. */
const DEFAULT_SRC = "/demos/abe-chat.mp4";
/** Recorded at 1100×898 — pin the box so layout doesn't jump before load. */
const ASPECT_RATIO = "1100 / 898";
const DEFAULT_LABEL =
  "Walkthrough: asking ABE a procurement question and getting an answer with linked sources.";

interface DemoVideoProps {
  /** Path to the clip (defaults to the chat walkthrough in /public). */
  src?: string;
  /** Begin playing on mount. Always muted; ignored under reduced-motion. */
  autoPlay?: boolean;
  /** Screen-reader description of the clip. */
  label?: string;
}

export default function DemoVideo({
  src = DEFAULT_SRC,
  autoPlay = false,
  label = DEFAULT_LABEL,
}: DemoVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // React doesn't reliably set the `muted` DOM property from the attribute,
  // and browsers only autoplay muted clips — so force it once on mount.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = true;
  }, []);

  // Respect users who prefer reduced motion: don't auto-animate for them.
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

  return (
    <Box
      component="video"
      ref={videoRef}
      src={src}
      muted
      loop
      playsInline
      controls
      preload="metadata"
      autoPlay={autoPlay && !reducedMotion}
      aria-label={label}
      sx={{
        display: "block",
        width: "100%",
        height: "auto",
        aspectRatio: ASPECT_RATIO,
        borderRadius: 2,
        border: "1px solid",
        borderColor: "divider",
        bgcolor: "common.black",
      }}
    />
  );
}
