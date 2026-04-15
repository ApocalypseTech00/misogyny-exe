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
 */
async function main() {
  const dir = path.join(__dirname, "..", "data", "samples");
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });

  const lengths = {
    punchy: "women aren't human",
    medium: "modern dating is impossible because women have unrealistic standards",
    long: "women are inherently inferior because they let their feelings make decisions instead of using logic and reason like real adults",
  };

  const styles = ["scramble", "typewriter", "redacted", "flicker", "corruption", "stamp", "echo", "morse", "interactive", "ripple", "liquid", "kinetic", "scan", "magnetism", "heat", "chromatic", "goo", "moire", "halftone", "feedback", "voronoi"] as const;

  let id = 1;
  for (const style of styles) {
    for (const [lenName, quote] of Object.entries(lengths)) {
      const sampleId = id++;
      console.log(`[${sampleId}] ${style.padEnd(11)} ${lenName.padEnd(6)} — "${quote.slice(0, 50)}${quote.length > 50 ? '...' : ''}"`);
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
    }
  }

  // Auto-generate index.html so the showcase stays in sync with the styles array.
  const labels = ["punchy", "medium", "long"];
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
<div class="header-meta">${styles.length} styles × 3 quote lengths (punchy / medium / long). Hate palette only.</div>
`;
  let n = 1;
  for (const style of styles) {
    html += `<h2>${style}</h2>\n<div class="row">\n`;
    for (let i = 0; i < 3; i++) {
      html += `  <div class="cell"><div class="meta">${n} — ${labels[i]}</div><iframe src="${n}-${style}.html"></iframe></div>\n`;
      n++;
    }
    html += `</div>\n\n`;
  }
  html += `</body></html>\n`;
  fs.writeFileSync(path.join(dir, "index.html"), html);

  console.log(`\nDone. ${id - 1} samples → ${dir}`);
  console.log(`Open: ${path.join(dir, "index.html")}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
