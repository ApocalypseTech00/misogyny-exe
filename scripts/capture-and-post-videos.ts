import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * MISOGYNY.EXE — Capture animations as video + post to Bluesky
 *
 * Uses Puppeteer to record HTML animations as MP4 via screencast,
 * then uploads to Bluesky as video posts.
 *
 * Usage:
 *   npx ts-node scripts/capture-and-post-videos.ts              # Capture + post all
 *   npx ts-node scripts/capture-and-post-videos.ts --capture     # Capture only (no posting)
 *   npx ts-node scripts/capture-and-post-videos.ts --post        # Post existing videos only
 *   npx ts-node scripts/capture-and-post-videos.ts --token 8     # Single token
 */

const SITE_DIR = path.join(__dirname, "..", "site");
const ANIMATIONS_DIR = path.join(SITE_DIR, "animations");
const VIDEOS_DIR = path.join(SITE_DIR, "videos");
const ARTWORKS_DIR = path.join(__dirname, "..", "data", "artworks");
const TOKENS_PATH = path.join(SITE_DIR, "tokens.json");
const MARKETPLACE_URL = "https://apocalypsetech.xyz/marketplace.html";

const CAPTURE_WIDTH = 800;
const CAPTURE_HEIGHT = 800;
const CAPTURE_DURATION_MS = 8000; // 8 seconds per animation
const CAPTURE_FPS = 30;

interface Token {
  tokenId: number;
  name: string;
  quote: string;
  attribution: string;
  price: string;
  animStyle: string;
}

function sanitizeForPost(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .replace(/#/g, "")
    .replace(/@/g, "")
    .trim();
}

function buildPostText(quote: string, tokenId: number): string {
  const clean = sanitizeForPost(quote);
  const maxLen = 220;
  const truncated = clean.length > maxLen ? clean.slice(0, maxLen - 1) + "\u2026" : clean;
  return [
    `\u201C${truncated}\u201D`,
    "",
    `MISOGYNY.EXE #${tokenId}`,
    `${MARKETPLACE_URL}#token-${tokenId}`,
  ].join("\n");
}

// --- Video Capture ---

async function captureAnimation(tokenId: number, animFile: string): Promise<string> {
  const puppeteer = await import("puppeteer");
  const { execSync } = await import("child_process");

  const outPath = path.join(VIDEOS_DIR, `${tokenId}.mp4`);
  const framesDir = path.join(VIDEOS_DIR, `frames-${tokenId}`);

  if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });
  if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

  console.log(`  Capturing token #${tokenId} (${path.basename(animFile)})...`);

  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
  await page.goto(`file://${animFile}`, { waitUntil: "domcontentloaded" });

  // Wait a moment for animation to initialize
  await new Promise((r) => setTimeout(r, 1000));

  // Capture frames
  const totalFrames = Math.floor((CAPTURE_DURATION_MS / 1000) * CAPTURE_FPS);
  const frameInterval = 1000 / CAPTURE_FPS;

  for (let i = 0; i < totalFrames; i++) {
    const framePath = path.join(framesDir, `frame-${String(i).padStart(4, "0")}.png`);
    await page.screenshot({ path: framePath, type: "png" });
    await new Promise((r) => setTimeout(r, frameInterval));
  }

  await browser.close();

  // Encode to MP4 with ffmpeg
  console.log(`  Encoding ${totalFrames} frames to MP4...`);
  execSync(
    `ffmpeg -y -framerate ${CAPTURE_FPS} -i "${framesDir}/frame-%04d.png" ` +
    `-c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 ` +
    `-vf "scale=${CAPTURE_WIDTH}:${CAPTURE_HEIGHT}" "${outPath}"`,
    { stdio: "pipe" }
  );

  // Clean up frames
  fs.rmSync(framesDir, { recursive: true, force: true });

  const size = fs.statSync(outPath).size;
  console.log(`  Saved: ${outPath} (${(size / 1024).toFixed(0)}KB)`);
  return outPath;
}

// --- Bluesky Video Upload ---

async function resolvePdsEndpoint(did: string): Promise<string> {
  const plcRes = await fetch(`https://plc.directory/${did}`);
  if (!plcRes.ok) throw new Error(`Failed to resolve DID: ${plcRes.status}`);
  const plcDoc = (await plcRes.json()) as any;
  const pds = plcDoc.service?.find((s: any) => s.id === "#atproto_pds")?.serviceEndpoint;
  if (!pds) throw new Error("No PDS endpoint found in DID document");
  return pds;
}

async function uploadVideoToBluesky(
  videoPath: string,
  accessJwt: string,
  did: string
): Promise<any> {
  // Step 1: Resolve PDS endpoint and get service auth token
  const pdsEndpoint = await resolvePdsEndpoint(did);
  const pdsDid = `did:web:${new URL(pdsEndpoint).hostname}`;

  const serviceAuthRes = await fetch(
    `${pdsEndpoint}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(pdsDid)}&lxm=com.atproto.repo.uploadBlob`,
    {
      headers: { Authorization: `Bearer ${accessJwt}` },
    }
  );

  if (!serviceAuthRes.ok) {
    throw new Error(`Service auth failed: ${serviceAuthRes.status} ${await serviceAuthRes.text()}`);
  }

  const { token: serviceToken } = (await serviceAuthRes.json()) as any;

  // Step 2: Upload video
  const videoData = fs.readFileSync(videoPath);
  const fileName = path.basename(videoPath);

  console.log(`  Uploading video (${(videoData.length / 1024).toFixed(0)}KB)...`);

  const uploadRes = await fetch(
    `https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(did)}&name=${encodeURIComponent(fileName)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "video/mp4",
      },
      body: videoData,
    }
  );

  if (!uploadRes.ok) {
    throw new Error(`Video upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  const jobStatus = (await uploadRes.json()) as any;
  console.log(`  Upload accepted, job: ${jobStatus.jobId}`);

  // Step 3: Poll for processing completion
  let blob: any = null;
  const maxWaitMs = 120_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const statusRes = await fetch(
      `https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${jobStatus.jobId}`,
      {
        headers: { Authorization: `Bearer ${serviceToken}` },
      }
    );

    if (!statusRes.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const status = (await statusRes.json()) as any;
    const state = status.jobStatus?.state;

    if (state === "JOB_STATE_COMPLETED") {
      blob = status.jobStatus.blob;
      console.log(`  Video processed successfully`);
      break;
    } else if (state === "JOB_STATE_FAILED") {
      throw new Error(`Video processing failed: ${JSON.stringify(status.jobStatus.error)}`);
    }

    // Still processing
    await new Promise((r) => setTimeout(r, 2000));
  }

  if (!blob) {
    throw new Error("Video processing timed out");
  }

  return blob;
}

// --- Bluesky Post with Video ---

async function postWithVideo(
  token: Token,
  videoBlob: any,
  accessJwt: string,
  did: string,
  handle: string
): Promise<string> {
  const text = buildPostText(token.quote, token.tokenId);

  const record: any = {
    $type: "app.bsky.feed.post",
    text,
    createdAt: new Date().toISOString(),
    embed: {
      $type: "app.bsky.embed.video",
      video: videoBlob,
      alt: `MISOGYNY.EXE #${token.tokenId} — animated typographic artwork (${token.animStyle})`,
    },
  };

  // Upload thumbnail (static artwork PNG)
  const thumbPath = path.join(ARTWORKS_DIR, `${token.tokenId}.png`);
  if (fs.existsSync(thumbPath)) {
    const thumbData = fs.readFileSync(thumbPath);
    if (thumbData.length <= 1_000_000) {
      try {
        const thumbRes = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
          method: "POST",
          headers: {
            "Content-Type": "image/png",
            Authorization: `Bearer ${accessJwt}`,
          },
          body: new Uint8Array(thumbData),
        });
        if (thumbRes.ok) {
          record.embed.thumb = ((await thumbRes.json()) as any).blob;
        }
      } catch {}
    }
  }

  const postRes = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessJwt}`,
    },
    body: JSON.stringify({
      repo: did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });

  if (!postRes.ok) {
    throw new Error(`Post failed: ${postRes.status} ${await postRes.text()}`);
  }

  const postData = (await postRes.json()) as any;
  const rkey = postData.uri?.split("/").pop();
  return `https://bsky.app/profile/${handle}/post/${rkey}`;
}

// --- Delete existing posts ---

async function deleteAllPosts(accessJwt: string, did: string): Promise<number> {
  console.log("Fetching existing posts to delete...");

  const listRes = await fetch(
    `https://bsky.social/xrpc/com.atproto.repo.listRecords?repo=${encodeURIComponent(did)}&collection=app.bsky.feed.post&limit=100`,
    {
      headers: { Authorization: `Bearer ${accessJwt}` },
    }
  );

  if (!listRes.ok) return 0;

  const { records } = (await listRes.json()) as any;
  if (!records || records.length === 0) return 0;

  // Filter to only MISOGYNY.EXE posts
  const misogynyPosts = records.filter((r: any) =>
    r.value?.text?.includes("MISOGYNY.EXE")
  );

  console.log(`  Found ${misogynyPosts.length} MISOGYNY.EXE posts to delete`);

  for (const record of misogynyPosts) {
    const rkey = record.uri.split("/").pop();
    await fetch("https://bsky.social/xrpc/com.atproto.repo.deleteRecord", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessJwt}`,
      },
      body: JSON.stringify({
        repo: did,
        collection: "app.bsky.feed.post",
        rkey,
      }),
    });
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`  Deleted ${misogynyPosts.length} posts`);
  return misogynyPosts.length;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const captureOnly = args.includes("--capture");
  const postOnly = args.includes("--post");
  const singleToken = args.includes("--token")
    ? parseInt(args[args.indexOf("--token") + 1])
    : null;

  const tokens: Token[] = JSON.parse(fs.readFileSync(TOKENS_PATH, "utf-8"));
  const targets = singleToken
    ? tokens.filter((t) => t.tokenId === singleToken)
    : tokens;

  if (targets.length === 0) {
    console.log("No matching tokens found");
    return;
  }

  console.log(`\n=== MISOGYNY.EXE — Animation Video Pipeline ===\n`);
  console.log(`Tokens: ${targets.map((t) => `#${t.tokenId}`).join(", ")}`);

  // Step 1: Capture animations as MP4
  if (!postOnly) {
    console.log(`\n--- Capturing animations ---\n`);
    for (const token of targets) {
      const animFile = path.join(ANIMATIONS_DIR, `${token.tokenId}-${token.animStyle}.html`);
      if (!fs.existsSync(animFile)) {
        console.log(`  Skipping #${token.tokenId}: no animation file (${path.basename(animFile)})`);
        continue;
      }
      try {
        await captureAnimation(token.tokenId, animFile);
      } catch (err: any) {
        console.log(`  ERROR capturing #${token.tokenId}: ${err.message}`);
      }
    }
  }

  if (captureOnly) {
    console.log("\nCapture complete (--capture mode, skipping post)");
    return;
  }

  // Step 2: Auth to Bluesky
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;
  if (!handle || !password) {
    console.log("ERROR: Set BLUESKY_HANDLE and BLUESKY_APP_PASSWORD in .env");
    return;
  }

  console.log(`\n--- Authenticating to Bluesky ---\n`);
  const authRes = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: handle, password }),
  });

  if (!authRes.ok) {
    console.log(`Auth failed: ${await authRes.text()}`);
    return;
  }

  const { accessJwt, did } = (await authRes.json()) as any;
  console.log(`Authenticated as ${did}`);

  // Step 3: Delete existing image-only posts (replace with video posts)
  if (!singleToken) {
    await deleteAllPosts(accessJwt, did);
  }

  // Step 4: Post videos
  console.log(`\n--- Posting videos to Bluesky ---\n`);

  for (const token of targets) {
    const videoPath = path.join(VIDEOS_DIR, `${token.tokenId}.mp4`);
    if (!fs.existsSync(videoPath)) {
      console.log(`  Skipping #${token.tokenId}: no video file`);
      continue;
    }

    try {
      console.log(`\nToken #${token.tokenId}:`);
      const videoBlob = await uploadVideoToBluesky(videoPath, accessJwt, did);
      const postUrl = await postWithVideo(token, videoBlob, accessJwt, did, handle);
      console.log(`  Posted: ${postUrl}`);

      // Rate limit between posts
      await new Promise((r) => setTimeout(r, 3000));
    } catch (err: any) {
      console.log(`  ERROR posting #${token.tokenId}: ${err.message}`);
    }
  }

  console.log(`\nDone! Check https://bsky.app/profile/${handle}`);
}

main().catch((err) => {
  console.error("FATAL:", err.message);
  process.exitCode = 1;
});
