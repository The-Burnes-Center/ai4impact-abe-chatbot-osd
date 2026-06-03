#!/usr/bin/env node
/**
 * record-demo.mjs — capture the ABE demo animations as MP4 + GIF + WebM.
 *
 * Dev-only tooling. Never invoked by CI/CDK; touches nothing in the backend.
 *
 *   1. Start the frontend dev server:  cd lib/user-interface/app && npm run dev
 *   2. From the repo root:             npm run record-demo            (all demos)
 *                                      npm run record-demo -- chat    (one/more ids)
 *
 * Reads loopMs + viewport per demo off window.__DEMO__ (set by DemoGallery), so
 * this script never duplicates the TIMINGS/geometry that live in the registry.
 *
 * Env:
 *   BASE_URL        default http://localhost:3000
 *   GIF_MAX_WIDTH   cap GIF width (downscale only; never upscale). default 1200
 *   FPS             GIF/MP4 fps. default 24
 */
import { chromium } from "playwright";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const FPS = Number(process.env.FPS || 24);
const GIF_MAX_WIDTH = Number(process.env.GIF_MAX_WIDTH || 1200);
const LOOP_BUFFER_MS = 700;

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const OUT_DIR = path.join(ROOT, "demo-recordings");
const TMP_DIR = path.join(OUT_DIR, ".tmp");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const requested = process.argv.slice(2).map((s) => s.trim()).filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the demo's step counter wraps back to 0 (a fresh loop boundary),
 * and return the wall-clock at that moment. Lets us trim the clip so it STARTS
 * at step 0 (DemoGallery/useSteps publishes window.__STEP__). null = not found.
 */
async function waitForStep0(page) {
  const deadline = Date.now() + 25000;
  let sawNonZero = false;
  while (Date.now() < deadline) {
    let s = 0;
    try {
      s = await page.evaluate(() => /** @type {any} */ (window).__STEP__ ?? 0);
    } catch {
      /* navigation in flight */
    }
    if (s !== 0) sawNonZero = true;
    else if (sawNonZero) return Date.now();
    await sleep(60);
  }
  return null;
}

async function waitForServer() {
  const url = `${BASE_URL}/demo-animation`;
  process.stdout.write(`Waiting for dev server at ${url} `);
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        process.stdout.write(" up.\n");
        return;
      }
    } catch {
      /* not up yet */
    }
    process.stdout.write(".");
    await sleep(1000);
  }
  console.error(
    `\n\nERROR: dev server not reachable at ${BASE_URL}.\n` +
      `Start it first:  cd lib/user-interface/app && npm run dev\n`
  );
  process.exit(1);
}

function ff(args) {
  execFileSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    stdio: "inherit",
  });
}

function probeDuration(file) {
  const out = spawnSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  return parseFloat(String(out.stdout || "").trim()) || 0;
}

/**
 * webm → MP4 + GIF, trimmed to the LAST `loopMs` (= exactly one seamless,
 * steady-state loop). Dropping the front removes the app-load lead-in and the
 * one-time card mount fade, so the GIF loops cleanly with no dead air.
 */
function buildOutputs(webm, mp4, gif, vpWidth, loopMs, startSec) {
  const loopSec = loopMs / 1000;
  // 1) full transcode (accurate timestamps for trimming) — even dims for yuv420p
  const full = path.join(TMP_DIR, "full.mp4");
  ff([
    "-i", webm, "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", full,
  ]);
  // 2) final MP4 = one loop. Prefer the measured step-0 boundary; otherwise fall
  //    back to the last loopSec. Clamp so we never read past the end.
  const dur = probeDuration(full);
  const maxStart = Math.max(0, dur - loopSec);
  const start = startSec != null ? Math.min(Math.max(0, startSec), maxStart) : maxStart;
  ff([
    "-ss", start.toFixed(3), "-i", full, "-t", loopSec.toFixed(3),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
    "-movflags", "+faststart", mp4,
  ]);
  rmSync(full, { force: true });
  // 3) GIF from the trimmed MP4. Never upscale: clamp width to capture (or cap).
  //    sierra2_4a (NOT bayer): keeps text edges crisp on solid backgrounds.
  const w = Math.min(vpWidth, GIF_MAX_WIDTH);
  const palette = path.join(TMP_DIR, "palette.png");
  const scale = `fps=${FPS},scale=${w}:-1:flags=lanczos`;
  ff(["-i", mp4, "-vf", `${scale},palettegen=stats_mode=diff:max_colors=256`, palette]);
  ff([
    "-i", mp4, "-i", palette,
    "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a`,
    gif,
  ]);
  rmSync(palette, { force: true });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  if (!hasFfmpeg) {
    console.warn("\n⚠  ffmpeg not found on PATH — will keep WebM only (no MP4/GIF).\n");
  }

  await waitForServer();

  const browser = await chromium.launch();

  // Discover demo set from the running app (registry is the source of truth).
  const probe = await browser.newPage();
  await probe.goto(`${BASE_URL}/demo-animation`, { waitUntil: "networkidle" });
  await probe.waitForFunction(() => Array.isArray(window.__DEMOS__), { timeout: 15000 });
  const all = await probe.evaluate(() => window.__DEMOS__);
  await probe.close();

  const todo = requested.length
    ? all.filter((d) => requested.includes(d.id))
    : all;
  if (requested.length && todo.length !== requested.length) {
    const found = todo.map((d) => d.id);
    const missing = requested.filter((id) => !found.includes(id));
    console.error(`Unknown demo id(s): ${missing.join(", ")}. Available: ${all.map((d) => d.id).join(", ")}`);
    process.exit(1);
  }

  // Warm the browser font cache once so recordings have no FOUT on the first frame.
  if (todo[0]) {
    const warm = await browser.newPage();
    await warm.goto(`${BASE_URL}/demo-animation/${todo[0].id}`, { waitUntil: "networkidle" });
    await warm.evaluate(() => (document.fonts ? document.fonts.ready : null));
    await sleep(800);
    await warm.close();
  }

  const made = [];
  for (const demo of todo) {
    const vp = demo.viewport;
    const recordMs = demo.loopMs + LOOP_BUFFER_MS;
    console.log(`\n▶ ${demo.id}  (${vp.width}×${vp.height}, loop ${demo.loopMs}ms)`);

    const context = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: 2,
      recordVideo: { dir: TMP_DIR, size: vp },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => console.error(`   page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && console.error(`   console: ${m.text()}`));

    const t0 = Date.now(); // ≈ video start (Playwright records from page load)
    await page.goto(`${BASE_URL}/demo-animation/${demo.id}`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => !!window.__DEMO__, { timeout: 10000 });
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));
    // Trim point: the next step-0 boundary, so the clip starts at the beginning.
    const tWrap = await waitForStep0(page);
    const startSec = tWrap != null ? (tWrap - t0) / 1000 : null;
    await sleep(recordMs); // capture one full loop past the boundary + buffer

    const video = page.video();
    await context.close(); // flushes the WebM
    const webm = path.join(OUT_DIR, `${demo.file}-${stamp}.webm`);
    await video.saveAs(webm);
    await video.delete().catch(() => {});

    const out = { id: demo.id, webm };
    if (hasFfmpeg) {
      const mp4 = path.join(OUT_DIR, `${demo.file}-${stamp}.mp4`);
      const gif = path.join(OUT_DIR, `${demo.file}-${stamp}.gif`);
      buildOutputs(webm, mp4, gif, vp.width, demo.loopMs, startSec);
      out.mp4 = mp4;
      out.gif = gif;
    }
    made.push(out);
    console.log(`   ✓ ${path.basename(out.gif || out.webm)}`);
  }

  await browser.close();
  rmSync(TMP_DIR, { recursive: true, force: true });

  console.log(`\n${"─".repeat(56)}\nDone. ${made.length} demo(s) → ${path.relative(ROOT, OUT_DIR)}/`);
  for (const m of made) {
    console.log(`  • ${m.id}: ${[m.mp4, m.gif, m.webm].filter(Boolean).map((p) => path.basename(p)).join(", ")}`);
  }
  console.log(
    `\nRe-record:  (1) cd lib/user-interface/app && npm run dev` +
      `\n            (2) npm run record-demo            # all` +
      `\n            (3) npm run record-demo -- chat    # one or more ids\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
