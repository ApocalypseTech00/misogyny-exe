import crypto from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

/**
 * MISOGYNY.EXE — Social Media Auto-Post
 *
 * Posts minted NFTs to Bluesky, X (Twitter), and Farcaster.
 * Non-blocking: failures here never affect the mint pipeline.
 *
 * Platforms:
 *   - Bluesky:   AT Protocol (text + image)
 *   - X/Twitter: API v2 + OAuth 1.0a (text only)
 *   - Farcaster: Neynar API (text + IPFS embed)
 *
 * Env vars:
 *   BLUESKY_HANDLE          — e.g. misogyny-exe.bsky.social
 *   BLUESKY_APP_PASSWORD    — App password (Settings → App Passwords)
 *   X_API_KEY               — Consumer key
 *   X_API_SECRET            — Consumer secret
 *   X_ACCESS_TOKEN          — Access token
 *   X_ACCESS_SECRET         — Access token secret
 *   NEYNAR_API_KEY          — Neynar API key
 *   NEYNAR_SIGNER_UUID      — Neynar signer UUID
 *   MARKETPLACE_BASE_URL    — Base URL for collect links
 *   SOCIAL_DRY_RUN          — "true" to log without posting
 *
 * Usage:
 *   import { postToSocials } from "./post-to-socials";
 *   const results = await postToSocials({ quote, tokenId, imageCid });
 *
 * CLI test:
 *   npx ts-node scripts/post-to-socials.ts              # preview post text
 *   npx ts-node scripts/post-to-socials.ts --send       # actually post
 *   SOCIAL_DRY_RUN=true npx ts-node scripts/post-to-socials.ts --send
 */

// --- Types ---

export interface PostPayload {
  quote: string;
  tokenId: number;
  imageCid?: string;
  artworkPath?: string;
  /** V6: MP4 file for Bluesky video post. If set, Bluesky posts as video instead of image. */
  mp4Path?: string;
  /** V6: optional custom text (e.g. redemption "ROAST: ..." format). Falls back to default mint text. */
  customText?: string;
}

export interface PostResult {
  platform: string;
  success: boolean;
  url?: string;
  error?: string;
}

// --- Config ---

// SECURITY: Only allow marketplace links to known domains (prevents phishing via env var)
const ALLOWED_MARKETPLACE_DOMAINS = [
  "https://apocalypsetech.xyz/",
  "https://apocalypsetech.surge.sh/",
];
const rawMarketplaceUrl =
  process.env.MARKETPLACE_BASE_URL || "https://apocalypsetech.xyz/marketplace.html";
const MARKETPLACE_BASE_URL = ALLOWED_MARKETPLACE_DOMAINS.some((d) =>
  rawMarketplaceUrl.startsWith(d)
)
  ? rawMarketplaceUrl
  : "https://apocalypsetech.xyz/marketplace.html";

const SOCIAL_DRY_RUN = process.env.SOCIAL_DRY_RUN === "true";
const IPFS_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_IMAGE_BYTES = 1_000_000; // 1MB — Bluesky limit
const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1 = /^bafy[a-z2-7]{50,60}$/;

// SECURITY: Allowed directory for local artwork reads (defense-in-depth)
const ALLOWED_ARTWORK_DIR = path.resolve(__dirname, "..", "data", "artworks");

// --- Helpers ---

/** Strip control chars, zero-width, normalize whitespace, neutralize platform markup */
function sanitizeForPost(text: string): string {
  return text
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028-\u202F\u2060\uFEFF]/g,
      ""
    )
    .replace(/\s+/g, " ")
    // SECURITY: Strip # and @ to prevent hashtag/mention injection on social platforms
    // The quote-guard blocks @handles but # could slip through in scraped quotes
    .replace(/#/g, "")
    .replace(/@/g, "")
    .trim();
}

function isValidCid(cid: string): boolean {
  return CID_V0.test(cid) || CID_V1.test(cid);
}

/** Build the post text shared across all platforms */
export function buildPostText(payload: PostPayload): string {
  if (payload.customText) {
    // Caller supplied full text (e.g. redemption flow with ROAST: prefix). Sanitize + pass through.
    return sanitizeForPost(payload.customText).slice(0, 300);
  }
  const quote = sanitizeForPost(payload.quote);
  // Bluesky limit is 300 graphemes. Reserve ~80 chars for metadata lines.
  const maxQuoteLen = 220;
  const truncated =
    quote.length > maxQuoteLen ? quote.slice(0, maxQuoteLen - 1) + "\u2026" : quote;

  return [
    `\u201C${truncated}\u201D`,
    "",
    `MISOGYNY.EXE #${payload.tokenId}`,
    `${MARKETPLACE_BASE_URL}#token-${payload.tokenId}`,
  ].join("\n");
}

// ============================================================
// Bluesky video upload (AT Protocol) — ported from V3 capture-and-post-videos.ts
// ============================================================

async function resolvePdsEndpoint(did: string): Promise<string> {
  const res = await fetchWithTimeout(`https://plc.directory/${did}`, { method: "GET" });
  if (!res.ok) throw new Error(`Failed to resolve DID: ${res.status}`);
  const plcDoc = (await res.json()) as any;
  const pds = plcDoc.service?.find((s: any) => s.id === "#atproto_pds")?.serviceEndpoint;
  if (!pds) throw new Error("No PDS endpoint found in DID document");
  return pds;
}

async function uploadVideoToBluesky(
  videoPath: string,
  accessJwt: string,
  did: string
): Promise<any> {
  const pdsEndpoint = await resolvePdsEndpoint(did);
  const pdsDid = `did:web:${new URL(pdsEndpoint).hostname}`;

  const serviceAuthRes = await fetchWithTimeout(
    `${pdsEndpoint}/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(pdsDid)}&lxm=com.atproto.repo.uploadBlob`,
    { headers: { Authorization: `Bearer ${accessJwt}` } }
  );
  if (!serviceAuthRes.ok) {
    throw new Error(`Service auth failed: ${serviceAuthRes.status}`);
  }
  const { token: serviceToken } = (await serviceAuthRes.json()) as any;

  const videoData = fs.readFileSync(videoPath);
  const fileName = path.basename(videoPath);

  const uploadRes = await fetchWithTimeout(
    `https://video.bsky.app/xrpc/app.bsky.video.uploadVideo?did=${encodeURIComponent(did)}&name=${encodeURIComponent(fileName)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "video/mp4",
      },
      body: new Uint8Array(videoData),
    }
  );
  if (!uploadRes.ok) {
    throw new Error(`Video upload failed: ${uploadRes.status}`);
  }
  const jobStatus = (await uploadRes.json()) as any;

  // Poll for processing completion (max ~2 min)
  const maxWaitMs = 120_000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const statusRes = await fetchWithTimeout(
      `https://video.bsky.app/xrpc/app.bsky.video.getJobStatus?jobId=${jobStatus.jobId}`,
      { headers: { Authorization: `Bearer ${serviceToken}` } }
    );
    if (!statusRes.ok) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const status = (await statusRes.json()) as any;
    const state = status.jobStatus?.state;
    if (state === "JOB_STATE_COMPLETED") return status.jobStatus.blob;
    if (state === "JOB_STATE_FAILED") {
      throw new Error(`Video processing failed: ${JSON.stringify(status.jobStatus.error)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Video processing timed out");
}

/** Fetch with AbortController timeout */
async function fetchWithTimeout(
  url: string,
  opts: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Scrub anything that looks like a token/key from error strings */
function scrubSecrets(msg: string): string {
  return msg
    .replace(/Bearer\s+[\w.-]+/gi, "Bearer [REDACTED]")
    .replace(/sk-ant-[^\s"]+/g, "[REDACTED]")           // Anthropic keys
    .replace(/eyJ[\w.-]{20,}/g, "[REDACTED]")            // JWTs
    .replace(/NEYNAR_[A-Z_]+=\S+/g, "[REDACTED]")       // Neynar keys in errors
    .replace(/x-api-key:\s*\S+/gi, "x-api-key: [REDACTED]")
    .replace(/oauth_consumer_key="[^"]+"/g, 'oauth_consumer_key="[REDACTED]"')
    .replace(/oauth_token="[^"]+"/g, 'oauth_token="[REDACTED]"')
    .replace(/password"?\s*[:=]\s*"?[^\s",}]+/gi, 'password: [REDACTED]')
    .slice(0, 200);
}

/** Safely download image from IPFS gateway (validates CID + enforces size limit) */
async function downloadIpfsImage(cid: string): Promise<Buffer | null> {
  if (!isValidCid(cid)) return null;
  try {
    const res = await fetchWithTimeout(`${IPFS_GATEWAY}${cid}`, {
      method: "GET",
    });
    if (!res.ok) return null;

    // Check Content-Length before reading body (prevents memory bomb)
    const cl = res.headers.get("content-length");
    if (cl && parseInt(cl) > MAX_IMAGE_BYTES) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

// ============================================================
// BLUESKY — AT Protocol
// ============================================================

async function postToBluesky(payload: PostPayload): Promise<PostResult> {
  const handle = process.env.BLUESKY_HANDLE;
  const password = process.env.BLUESKY_APP_PASSWORD;

  if (!handle || !password) {
    return {
      platform: "bluesky",
      success: false,
      error: "Missing BLUESKY_HANDLE or BLUESKY_APP_PASSWORD",
    };
  }

  // SECURITY: Validate handle format (prevents URL injection in constructed post URLs)
  if (!/^[\w.-]+$/.test(handle)) {
    return {
      platform: "bluesky",
      success: false,
      error: "BLUESKY_HANDLE contains invalid characters",
    };
  }

  try {
    // 1. Authenticate
    const authRes = await fetchWithTimeout(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password }),
      }
    );

    if (!authRes.ok) {
      const err = await authRes.text();
      return {
        platform: "bluesky",
        success: false,
        error: `Auth failed (${authRes.status}): ${scrubSecrets(err)}`,
      };
    }

    const { accessJwt, did } = (await authRes.json()) as any;

    // 2a. Upload MP4 if provided — V6 redemption / mint flow posts video (not image)
    let videoBlob: any = null;
    if (payload.mp4Path && fs.existsSync(payload.mp4Path)) {
      try {
        videoBlob = await uploadVideoToBluesky(payload.mp4Path, accessJwt, did);
      } catch (err: any) {
        // fall through — post as image
      }
    }

    // 2b. Upload image (best-effort — post succeeds without it)
    let imageBlob: any = null;

    if (payload.imageCid) {
      const imgBuf = await downloadIpfsImage(payload.imageCid);
      if (imgBuf) {
        try {
          const upRes = await fetchWithTimeout(
            "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
            {
              method: "POST",
              headers: {
                "Content-Type": "image/png",
                Authorization: `Bearer ${accessJwt}`,
              },
              body: new Uint8Array(imgBuf),
            }
          );
          if (upRes.ok) {
            imageBlob = ((await upRes.json()) as any).blob;
          }
        } catch {
          /* image upload failed — continue without */
        }
      }
    } else if (
      payload.artworkPath &&
      path.resolve(payload.artworkPath).startsWith(ALLOWED_ARTWORK_DIR) &&
      fs.existsSync(payload.artworkPath)
    ) {
      try {
        const imgBuf = fs.readFileSync(payload.artworkPath);
        if (imgBuf.length <= MAX_IMAGE_BYTES) {
          const upRes = await fetchWithTimeout(
            "https://bsky.social/xrpc/com.atproto.repo.uploadBlob",
            {
              method: "POST",
              headers: {
                "Content-Type": "image/png",
                Authorization: `Bearer ${accessJwt}`,
              },
              body: new Uint8Array(imgBuf),
            }
          );
          if (upRes.ok) {
            imageBlob = ((await upRes.json()) as any).blob;
          }
        }
      } catch {
        /* continue without image */
      }
    }

    // 3. Create post
    const text = buildPostText(payload);
    const record: any = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
    };

    if (videoBlob) {
      // V6: video post with PNG thumbnail
      record.embed = {
        $type: "app.bsky.embed.video",
        video: videoBlob,
        alt: `MISOGYNY.EXE #${payload.tokenId} — animated typographic artwork`,
      };
      if (imageBlob) {
        record.embed.thumb = imageBlob;
      }
    } else if (imageBlob) {
      record.embed = {
        $type: "app.bsky.embed.images",
        images: [
          {
            alt: `MISOGYNY.EXE #${payload.tokenId} — typographic artwork`,
            image: imageBlob,
          },
        ],
      };
    }

    const postRes = await fetchWithTimeout(
      "https://bsky.social/xrpc/com.atproto.repo.createRecord",
      {
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
      }
    );

    if (!postRes.ok) {
      const err = await postRes.text();
      return {
        platform: "bluesky",
        success: false,
        error: `Post failed (${postRes.status}): ${scrubSecrets(err)}`,
      };
    }

    const postData = (await postRes.json()) as any;
    const rkey = postData.uri?.split("/").pop();
    const postUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;

    return { platform: "bluesky", success: true, url: postUrl };
  } catch (err: any) {
    return {
      platform: "bluesky",
      success: false,
      error: scrubSecrets(err.message),
    };
  }
}

// ============================================================
// X / TWITTER — API v2 + OAuth 1.0a
// ============================================================

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function oauthSign(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sorted),
  ].join("&");

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto
    .createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");
}

function buildOAuthHeader(params: Record<string, string>): string {
  return (
    "OAuth " +
    Object.keys(params)
      .filter((k) => k.startsWith("oauth_"))
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(params[k])}"`)
      .join(", ")
  );
}

async function postToX(payload: PostPayload): Promise<PostResult> {
  const apiKey = process.env.X_API_KEY;
  const apiSecret = process.env.X_API_SECRET;
  const accessToken = process.env.X_ACCESS_TOKEN;
  const accessSecret = process.env.X_ACCESS_SECRET;

  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    return {
      platform: "x",
      success: false,
      error: "Missing X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, or X_ACCESS_SECRET",
    };
  }

  try {
    const url = "https://api.twitter.com/2/tweets";
    const text = buildPostText(payload);

    // Build OAuth 1.0a params
    // For JSON body requests, only OAuth params go into the signature base string
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: apiKey,
      oauth_nonce: crypto.randomBytes(16).toString("hex"),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_token: accessToken,
      oauth_version: "1.0",
    };

    oauthParams.oauth_signature = oauthSign(
      "POST",
      url,
      oauthParams,
      apiSecret,
      accessSecret
    );

    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildOAuthHeader(oauthParams),
      },
      body: JSON.stringify({ text }),
    });

    if (!res.ok) {
      const err = await res.text();
      return {
        platform: "x",
        success: false,
        error: `Tweet failed (${res.status}): ${scrubSecrets(err)}`,
      };
    }

    const data = (await res.json()) as any;
    const tweetId = data.data?.id;
    const tweetUrl = tweetId
      ? `https://x.com/i/status/${tweetId}`
      : undefined;

    return { platform: "x", success: true, url: tweetUrl };
  } catch (err: any) {
    return {
      platform: "x",
      success: false,
      error: scrubSecrets(err.message),
    };
  }
}

// ============================================================
// FARCASTER — Neynar API
// ============================================================

async function postToFarcaster(payload: PostPayload): Promise<PostResult> {
  const apiKey = process.env.NEYNAR_API_KEY;
  const signerUuid = process.env.NEYNAR_SIGNER_UUID;

  if (!apiKey || !signerUuid) {
    return {
      platform: "farcaster",
      success: false,
      error: "Missing NEYNAR_API_KEY or NEYNAR_SIGNER_UUID",
    };
  }

  try {
    const text = buildPostText(payload);
    const embeds: { url: string }[] = [];

    // Embed IPFS image link (Warpcast will render the preview)
    if (payload.imageCid && isValidCid(payload.imageCid)) {
      embeds.push({ url: `${IPFS_GATEWAY}${payload.imageCid}` });
    }

    const res = await fetchWithTimeout(
      "https://api.neynar.com/v2/farcaster/cast",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          signer_uuid: signerUuid,
          text,
          embeds: embeds.length > 0 ? embeds : undefined,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      return {
        platform: "farcaster",
        success: false,
        error: `Cast failed (${res.status}): ${scrubSecrets(err)}`,
      };
    }

    const data = (await res.json()) as any;
    const castHash = data.cast?.hash;
    const castUrl = castHash
      ? `https://warpcast.com/~/conversations/${castHash}`
      : undefined;

    return { platform: "farcaster", success: true, url: castUrl };
  } catch (err: any) {
    return {
      platform: "farcaster",
      success: false,
      error: scrubSecrets(err.message),
    };
  }
}

// ============================================================
// MAIN EXPORT
// ============================================================

/**
 * Post a minted NFT to all configured social platforms.
 * Returns results for each platform. Never throws — all errors are captured per-platform.
 */
export async function postToSocials(
  payload: PostPayload
): Promise<PostResult[]> {
  // Validate payload
  if (!payload.quote || typeof payload.tokenId !== "number" || !Number.isFinite(payload.tokenId)) {
    return [
      {
        platform: "all",
        success: false,
        error: "Invalid payload: quote and tokenId required",
      },
    ];
  }

  if (SOCIAL_DRY_RUN) {
    const text = buildPostText(payload);
    console.log(`[SOCIAL DRY RUN] Would post:\n${text}\n`);
    return [
      { platform: "bluesky", success: true, url: "(dry run)" },
      { platform: "x", success: true, url: "(dry run)" },
      { platform: "farcaster", success: true, url: "(dry run)" },
    ];
  }

  // Post to all platforms concurrently — each is independent
  const settled = await Promise.allSettled([
    postToBluesky(payload),
    postToX(payload),
    postToFarcaster(payload),
  ]);

  return settled.map((r, i) => {
    const platform = ["bluesky", "x", "farcaster"][i];
    if (r.status === "fulfilled") return r.value;
    return {
      platform,
      success: false,
      error: scrubSecrets(r.reason?.message || "Unknown error"),
    };
  });
}

// ============================================================
// CLI TEST MODE
// ============================================================

if (require.main === module) {
  (async () => {
    console.log("\n=== MISOGYNY.EXE — Social Post Test ===\n");

    const testPayload: PostPayload = {
      quote: "Women belong in the kitchen, not in the boardroom",
      tokenId: 999,
      imageCid: process.argv.find((a) => a.startsWith("Qm") || a.startsWith("bafy")),
    };

    console.log("Post text preview:");
    console.log("---");
    console.log(buildPostText(testPayload));
    console.log("---\n");

    console.log("Platform config:");
    console.log(
      `  Bluesky:   ${process.env.BLUESKY_HANDLE ? "\x1b[32m\u2713\x1b[0m " + process.env.BLUESKY_HANDLE : "\x1b[31m\u2717\x1b[0m not configured"}`
    );
    console.log(
      `  X:         ${process.env.X_API_KEY ? "\x1b[32m\u2713\x1b[0m configured" : "\x1b[31m\u2717\x1b[0m not configured"}`
    );
    console.log(
      `  Farcaster: ${process.env.NEYNAR_API_KEY ? "\x1b[32m\u2713\x1b[0m configured" : "\x1b[31m\u2717\x1b[0m not configured"}`
    );
    console.log(`  Dry run:   ${SOCIAL_DRY_RUN ? "ON" : "OFF"}\n`);

    if (process.argv.includes("--send")) {
      console.log("Posting...\n");
      const results = await postToSocials(testPayload);
      for (const r of results) {
        const icon = r.success ? "\x1b[32m\u2713\x1b[0m" : "\x1b[31m\u2717\x1b[0m";
        console.log(`${icon} ${r.platform}: ${r.url || r.error}`);
      }
      console.log();
    } else {
      console.log(
        "Run with --send to post. Set SOCIAL_DRY_RUN=true for safe testing.\n"
      );
    }
  })();
}
