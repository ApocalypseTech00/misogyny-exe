import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";

/**
 * MISOGYNY.EXE V6 — MP4 capture (Bluesky only)
 *
 * Ported directly from V3's `scripts/capture-and-post-videos.ts` — known to work on
 * a 1GB Pi 3B+ against Bluesky's video API. 800×800, 8s, 30fps, H.264 yuv420p,
 * preset fast, crf 23, no audio.
 *
 * Frames are scratch-written to a tmpfs-backed directory under `/tmp/misogyny-frames-*`
 * so we don't grind the SD card (V6 spec §10.5, §12.5).
 *
 * Usage:
 *   import { captureHtmlToMp4 } from "./capture-mp4";
 *   const mp4 = await captureHtmlToMp4({ htmlPath, tokenId });
 */

const CAPTURE_WIDTH = 800;
const CAPTURE_HEIGHT = 800;
const CAPTURE_DURATION_MS = 8000;
const CAPTURE_FPS = 30;

export interface CaptureOptions {
  htmlPath: string;
  tokenId: number | string;
  outPath?: string; // defaults to tmpfs
  kind?: "mint" | "redemption"; // used in puppeteer launch args for scoped pkill
}

export async function captureHtmlToMp4(opts: CaptureOptions): Promise<string> {
  const kind = opts.kind ?? "mint";
  const tmpRoot = process.env.MISOGYNY_TMPFS || "/tmp";
  const framesDir = fs.mkdtempSync(path.join(tmpRoot, `misogyny-frames-${kind}-${opts.tokenId}-`));
  const outPath = opts.outPath || path.join(tmpRoot, `misogyny-${kind}-${opts.tokenId}.mp4`);

  const puppeteer = await import("puppeteer");

  // Launch with a distinguishing script-name arg so `pkill -f "puppeteer.*rare-mint-v6"`
  // / `pkill -f "puppeteer.*redemption-v6"` reaps only its own zombies (V6 spec §12.5).
  const taggedArg = kind === "redemption" ? "--tag=redemption-v6" : "--tag=rare-mint-v6";
  let browser: any;
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", taggedArg],
    });

    // Hard 90s kill per spec §12.5 — Chromium can hang on odd pages
    timeoutHandle = setTimeout(() => {
      try {
        browser?.close();
      } catch {}
    }, 90_000);

    const page = await browser.newPage();
    await page.setViewport({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
    await page.goto(`file://${path.resolve(opts.htmlPath)}`, { waitUntil: "domcontentloaded" });
    // Let the animation initialise
    await new Promise((r) => setTimeout(r, 1000));

    const totalFrames = Math.floor((CAPTURE_DURATION_MS / 1000) * CAPTURE_FPS);
    const frameInterval = 1000 / CAPTURE_FPS;

    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(framesDir, `frame-${String(i).padStart(4, "0")}.png`);
      await page.screenshot({ path: framePath, type: "png" });
      await new Promise((r) => setTimeout(r, frameInterval));
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (browser) await browser.close().catch(() => undefined);
  }

  // V3-proven ffmpeg recipe — validated on Bluesky video API
  execSync(
    [
      "ffmpeg",
      "-y",
      "-framerate", String(CAPTURE_FPS),
      "-i", `"${framesDir}/frame-%04d.png"`,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-preset", "fast",
      "-crf", "23",
      "-vf", `"scale=${CAPTURE_WIDTH}:${CAPTURE_HEIGHT}"`,
      "-an",
      `"${outPath}"`,
    ].join(" "),
    { stdio: "pipe" }
  );

  // Clean up frames (they were on tmpfs, but still)
  fs.rmSync(framesDir, { recursive: true, force: true });

  return outPath;
}
