import { generateArtwork, convertToPng } from "./generate-artwork";
import { generateAnimation } from "./generate-animation";
import path from "path";
import fs from "fs";

/**
 * Showcase: render every animation style at 3 quote lengths
 *   - punchy  (3 words)
 *   - medium  (9 words)
 *   - long    (20 words)
 * Hate palette only (palette swap on templates is a separate fix).
 *
 * SKIP_LENGTHS — per-style length kills, applied from operator feedback.
 */
async function main() {
  const dir = path.join(__dirname, "..", "data", "samples");
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const lengths: Record<"punchy" | "medium" | "long", string> = {
    punchy: "women aren't human",
    medium: "modern dating is impossible because women have unrealistic standards",
    long: "women are inherently inferior because they let their feelings make decisions instead of using logic and reason like real adults",
  };
  const LABELS: Array<"punchy" | "medium" | "long"> = ["punchy", "medium", "long"];

  const styles = [
    "scramble", "typewriter", "redacted", "flicker", "corruption",
    "stamp", "echo", "morse", "interactive", "ripple",
    "liquid", "kinetic", "scan", "magnetism", "heat",
    "chromatic", "goo", "moire", "halftone", "voronoi",
    "vhs", "erosion", "slot",
    "shatter", "cathode", "burn", "pixelate", "xerox", "shake",
    "terminal", "3dflip",
  ] as const;

  const SKIP_LENGTHS: Record<string, Array<"punchy" | "medium" | "long">> = {
    corruption: ["long"],
    moire: ["long"],
    chromatic: ["medium", "long"],
    magnetism: ["medium", "long"],
    kinetic: ["long"],
    vhs: ["medium", "long"],
    xerox: ["long"],
    burn: ["long"],
  };

  // First pass: render everything kept, tracking per-style which labels we rendered.
  let id = 1;
  const rendered: Record<string, Array<{ label: string; id: number }>> = {};
  for (const style of styles) {
    rendered[style] = [];
    for (const label of LABELS) {
      if (SKIP_LENGTHS[style]?.includes(label)) continue;
      const quote = lengths[label];
      const sampleId = id++;
      console.log(`[${sampleId}] ${style.padEnd(11)} ${label.padEnd(6)} — "${quote.slice(0, 50)}${quote.length > 50 ? '...' : ''}"`);
      const svgPath = generateArtwork({
        id: sampleId,
        quote,
        attribution: "u/sample",
        palette: "hate",
        outputDir: dir,
      });
      await convertToPng(svgPath);
      generateAnimation({
        id: sampleId,
        quote,
        style,
        palette: "hate",
        outputDir: dir,
      });
      rendered[style].push({ label, id: sampleId });
    }
  }

  // Second pass: build index.html that only references rendered cells.
  let html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>MISOGYNY.EXE — animation showcase</title>
<style>
  body { background: #0a0a0a; color: #F918D0; font-family: monospace; padding: 24px; margin: 0; }
  h1 { font-size: 18px; letter-spacing: 0.2em; text-transform: uppercase; margin-bottom: 8px; }
  h2 { font-size: 13px; letter-spacing: 0.3em; text-transform: uppercase; margin: 32px 0 12px; opacity: 0.6; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .cell { display: flex; flex-direction: column; gap: 4px; }
  .cell .meta { font-size: 11px; opacity: 0.5; text-transform: uppercase; letter-spacing: 0.15em; }
  iframe { width: 100%; aspect-ratio: 1; border: 1px solid #F918D040; background: #1a1a1a; display: block; }
  .header-meta { opacity: 0.5; font-size: 11px; }
</style></head><body>
<h1>MISOGYNY.EXE — animation showcase</h1>
<div class="header-meta">${styles.length} styles, operator-kill-list applied. Hate palette only.</div>
`;
  for (const style of styles) {
    const cells = rendered[style];
    if (!cells.length) continue;
    html += `<h2>${style}</h2>\n<div class="row">\n`;
    for (const { label, id: cellId } of cells) {
      html += `  <div class="cell"><div class="meta">${cellId} — ${label}</div><iframe src="${cellId}-${style}.html"></iframe></div>\n`;
    }
    html += `</div>\n\n`;
  }
  html += `</body></html>\n`;
  fs.writeFileSync(path.join(dir, "index.html"), html);

  console.log(`\nDone. ${id - 1} samples → ${dir}`);
  console.log(`Open: ${path.join(dir, "index.html")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
