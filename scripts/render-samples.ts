import { generateAnimation } from "./generate-animation";
import path from "path";
import fs from "fs";

/**
 * Single gallery page. Per animation style, stacks TWO rows:
 *   Row 1 — hate    : original scraper quote, pink on dark
 *   Row 2 — roast   : comeback text, dark on pink (palette swap via post-process)
 *
 * Cells without a roast show a "roast pending" placeholder so the grid stays aligned.
 */

type Bucket = "punchy" | "medium" | "long";
interface CorpusQuote { id: string; quote: string; }
interface RoastEntry { quoteId: string; roast?: string; error?: string; }

const STYLES = [
  "scramble", "typewriter", "redacted", "flicker", "corruption",
  "stamp", "echo", "morse", "interactive", "ripple",
  "liquid", "kinetic", "scan", "magnetism", "heat",
  "chromatic", "goo", "moire", "halftone", "voronoi",
  "vhs", "erosion", "slot",
  "shatter", "cathode", "burn", "pixelate", "xerox", "shake",
  "terminal", "3dflip",
] as const;

const SKIP_LENGTHS: Record<string, Bucket[]> = {
  corruption: ["medium", "long"],
  moire: ["long"],
  chromatic: ["medium", "long"],
  magnetism: ["medium", "long"],
  kinetic: ["long"],
  vhs: ["medium", "long"],
  xerox: ["long"],
  burn: ["long"],
};

const BUCKETS: Bucket[] = ["punchy", "medium", "long"];

function bucketFor(q: string): Bucket {
  const w = q.trim().split(/\s+/).length;
  if (w <= 6) return "punchy";
  if (w <= 15) return "medium";
  return "long";
}

function toRedeemedPalette(html: string): string {
  return html
    .replace(/#F918D0/gi, "__PINK__")
    .replace(/#0a0a0a/gi, "#F918D0")
    .replace(/#1a1a1a/gi, "#F918D0")
    .replace(/__PINK__/g, "#0a0a0a");
}

async function main() {
  const dir = path.join(__dirname, "..", "data", "samples");
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const { quotes } = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data", "mint-corpus.json"), "utf-8")
  ) as { quotes: CorpusQuote[] };

  const roastsPath = path.join(__dirname, "..", "data", "roasts.json");
  const roasts: Record<string, string> = {};
  if (fs.existsSync(roastsPath)) {
    const file = JSON.parse(fs.readFileSync(roastsPath, "utf-8")) as { entries: RoastEntry[] };
    for (const e of file.entries) if (e.roast) roasts[e.quoteId] = e.roast;
  }

  const pool: Record<Bucket, CorpusQuote[]> = { punchy: [], medium: [], long: [] };
  for (const q of quotes) pool[bucketFor(q.quote)].push(q);
  for (const b of BUCKETS) pool[b].sort((a, b) => a.quote.length - b.quote.length);

  let id = 1;
  const rendered: Record<string, Array<{
    id: number; bucket: Bucket; q: CorpusQuote; roast?: string;
  }>> = {};

  for (let si = 0; si < STYLES.length; si++) {
    const style = STYLES[si];
    rendered[style] = [];
    for (const bucket of BUCKETS) {
      if (SKIP_LENGTHS[style]?.includes(bucket)) continue;
      const bp = pool[bucket];
      if (!bp.length) continue;
      const q = bp[si % bp.length];
      const sampleId = id++;
      const roast = roasts[q.id];
      console.log(`[${sampleId}] ${style.padEnd(11)} ${bucket.padEnd(6)} ${roast ? "✓roast" : "–roast"} — "${q.quote.slice(0, 50)}…"`);

      generateAnimation({
        id: sampleId,
        quote: q.quote,
        style: style as any,
        palette: "hate",
        outputDir: dir,
      });

      if (roast) {
        const tmpId = `${sampleId}-roast-tmp`;
        generateAnimation({
          id: tmpId as any,
          quote: roast,
          style: style as any,
          palette: "redeemed",
          outputDir: dir,
        });
        const src = path.join(dir, `${tmpId}-${style}.html`);
        const dst = path.join(dir, `${sampleId}-roast-${style}.html`);
        const html = fs.readFileSync(src, "utf-8");
        fs.writeFileSync(dst, toRedeemedPalette(html));
        fs.unlinkSync(src);
      }

      rendered[style].push({ id: sampleId, bucket, q, roast });
    }
  }

  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const totalCells = Object.values(rendered).reduce((n, a) => n + a.length, 0);
  const hasRoastCount = Object.values(rendered).reduce((n, a) => n + a.filter(c => c.roast).length, 0);

  let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>MISOGYNY.EXE — animation showcase</title>
<style>
  body { background: #0a0a0a; color: #F918D0; font-family: monospace; padding: 24px; margin: 0; }
  h1 { font-size: 18px; letter-spacing: 0.2em; text-transform: uppercase; margin-bottom: 8px; }
  h2 { font-size: 13px; letter-spacing: 0.3em; text-transform: uppercase; margin: 36px 0 12px; opacity: 0.6; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 8px; }
  .row.roast { margin-top: 0; }
  .cell { display: flex; flex-direction: column; gap: 4px; }
  .cell .meta { font-size: 11px; opacity: 0.55; text-transform: uppercase; letter-spacing: 0.12em; }
  .cell .meta .tag { display: inline-block; margin-left: 6px; padding: 0 4px; font-size: 9px; border: 1px solid currentColor; opacity: 0.8; }
  .cell .quote { font-size: 10px; opacity: 0.5; line-height: 1.35; font-style: italic; }
  iframe { width: 100%; aspect-ratio: 1; border: 1px solid #F918D040; background: #1a1a1a; display: block; }
  .pending { width: 100%; aspect-ratio: 1; border: 1px dashed #F918D040; display: flex; align-items: center; justify-content: center; font-size: 10px; opacity: 0.5; letter-spacing: 0.15em; text-transform: uppercase; }
  .header-meta { opacity: 0.5; font-size: 11px; }
</style></head><body>
<h1>MISOGYNY.EXE — animation showcase</h1>
<div class="header-meta">${STYLES.length} styles · ${quotes.length} mint-corpus quotes · ${totalCells} hate cells · ${hasRoastCount} with roast · two rows per style (top=hate, bottom=roast redeemed)</div>
`;
  for (const style of STYLES) {
    const cells = rendered[style];
    if (!cells.length) continue;
    html += `<h2>${style}</h2>\n`;

    // Row 1 — hate
    html += `<div class="row">\n`;
    for (const c of cells) {
      html += `  <div class="cell">
    <div class="meta">${c.id} — ${c.bucket} <span class="tag">hate</span></div>
    <iframe src="${c.id}-${style}.html" loading="lazy"></iframe>
    <div class="quote">"${esc(c.q.quote)}"</div>
  </div>\n`;
    }
    html += `</div>\n`;

    // Row 2 — roast
    html += `<div class="row roast">\n`;
    for (const c of cells) {
      if (c.roast) {
        html += `  <div class="cell">
    <div class="meta">${c.id} — ${c.bucket} <span class="tag">roast</span></div>
    <iframe src="${c.id}-roast-${style}.html" loading="lazy"></iframe>
    <div class="quote">"${esc(c.roast)}"</div>
  </div>\n`;
      } else {
        html += `  <div class="cell">
    <div class="meta">${c.id} — ${c.bucket} <span class="tag">roast</span></div>
    <div class="pending">roast pending</div>
    <div class="quote">&nbsp;</div>
  </div>\n`;
      }
    }
    html += `</div>\n\n`;
  }
  html += `</body></html>\n`;
  fs.writeFileSync(path.join(dir, "index.html"), html);

  console.log(`\nDone. ${totalCells} hate + ${hasRoastCount} roast cells → ${dir}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
