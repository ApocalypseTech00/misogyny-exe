import fs from "fs";
import path from "path";

/**
 * Generate a self-contained animation HTML for a specific quote.
 * The HTML is fully standalone (no external dependencies) so it
 * works on IPFS as an animation_url for NFT metadata.
 *
 * Styles:
 *   - scramble (default/most common) — random chars resolve into text
 *   - typewriter — typed out with typos and corrections
 *   - redacted — pink bars lift to reveal text
 *   - flicker — dying neon sign with glitch offsets
 *   - heartbeat — pulses with RGB split and shockwaves
 *   - corruption — hex data infected by the quote
 *   - interactive — chars flee from cursor (gravity well)
 *   - ascii — giant letters made of fill chars
 */

const ANIMATION_STYLES = [
  "scramble",
  "typewriter",
  "redacted",
  "flicker",
  "corruption",
  "interactive",
  "stamp",
  "echo",
  "morse",
  "ripple",
  "liquid",
  "kinetic",
  "scan",
  "magnetism",
  "heat",
  "chromatic",
  "goo",
  "moire",
  "halftone",
  "feedback",
  "voronoi",
] as const;

type AnimationStyle = (typeof ANIMATION_STYLES)[number];

// Weighted distribution — scramble is the hero (50%), rest split the remainder
const STYLE_WEIGHTS: Record<AnimationStyle, number> = {
  scramble: 30,
  typewriter: 10,
  redacted: 10,
  flicker: 8,
  corruption: 8,
  interactive: 5,
  stamp: 8,
  echo: 7,
  morse: 5,
  ripple: 6,
  liquid: 6,
  kinetic: 8,
  scan: 6,
  magnetism: 4,
  heat: 5,
  chromatic: 6,
  goo: 5,
  moire: 5,
  halftone: 5,
  feedback: 5,
  voronoi: 5,
};

/**
 * Pick a random animation style using weighted distribution.
 * Uses tokenId as seed for determinism.
 */
export function pickAnimationStyle(tokenId: number): AnimationStyle {
  const totalWeight = Object.values(STYLE_WEIGHTS).reduce((a, b) => a + b, 0);
  // Simple deterministic hash from tokenId
  const hash = (tokenId * 2654435761) >>> 0; // Knuth multiplicative hash
  let pick = hash % totalWeight;

  for (const [style, weight] of Object.entries(STYLE_WEIGHTS)) {
    pick -= weight;
    if (pick < 0) return style as AnimationStyle;
  }
  return "scramble";
}

// --- Shared CSS/HTML parts ---

type AnimationPalette = "hate" | "redeemed";

function getSharedCss(palette: AnimationPalette): string {
  const isHate = palette === "hate";
  const bg = isHate ? "#1a1a1a" : "#F918D0";
  const text = isHate ? "#F918D0" : "#0a0a0a";
  const glow = isHate
    ? "0 0 8px #F918D080, 0 0 20px #F918D030"
    : "0 0 8px #0a0a0a40, 0 0 20px #0a0a0a20";
  const labelColor = isHate ? "#F918D030" : "#0a0a0a60";
  return `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: ${bg};
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: hidden;
    font-family: Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 900;
  }
  .container {
    width: 100vmin; height: 100vmin;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
  }
  .container::after {
    content: '';
    position: absolute; inset: 0;
    background: ${isHate ? `repeating-linear-gradient(
      to bottom, transparent, transparent 1px,
      rgba(0,0,0,0.12) 1px, rgba(0,0,0,0.12) 2px
    )` : "none"};
    pointer-events: none; z-index: 10;
  }
  .vignette {
    position: absolute; inset: 0;
    background: ${isHate ? "radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.6) 100%)" : "none"};
    pointer-events: none; z-index: 9;
  }
  .quote-line {
    text-align: center; text-transform: uppercase;
    color: ${text}; letter-spacing: 0.05em;
    min-height: 1.2em; padding: 0 5vmin;
    text-shadow: ${glow};
  }
  .label {
    position: absolute; bottom: 30px;
    font-size: 10px; color: ${labelColor};
    letter-spacing: 0.3em; text-transform: uppercase;
  }
`;
}

const SHARED_CSS = getSharedCss("hate");

const SHARED_JS_UTILS = `
const LINES_CONFIG = {
  4:  { wpl: 1, size: 12 },
  10: { wpl: 3, size: 6 },
  15: { wpl: 3, size: 5 },
  25: { wpl: 3, size: 4 },
};
function getConfig(wc) {
  if (wc <= 4)  return LINES_CONFIG[4];
  if (wc <= 10) return LINES_CONFIG[10];
  if (wc <= 18) return LINES_CONFIG[15];
  return LINES_CONFIG[25];
}
function breakIntoLines(text, wpl) {
  const words = text.split(/\\s+/);
  const totalLines = Math.ceil(words.length / wpl);
  const base = Math.floor(words.length / totalLines);
  const extra = words.length % totalLines;
  const lines = []; let idx = 0;
  for (let i = 0; i < totalLines; i++) {
    const take = base + (i < extra ? 1 : 0);
    lines.push(words.slice(idx, idx + take).join(' '));
    idx += take;
  }
  return lines;
}
`;

/**
 * Generate a self-contained animation HTML file for a quote.
 * Returns the path to the generated HTML file.
 */
export function generateAnimation(opts: {
  id: number;
  quote: string;
  style?: AnimationStyle;
  outputDir?: string;
  palette?: AnimationPalette;
}): { htmlPath: string; style: AnimationStyle } {
  const style = opts.style || pickAnimationStyle(opts.id);
  const palette: AnimationPalette = opts.palette || "hate";
  const dir = opts.outputDir || path.join(__dirname, "..", "data", "artworks", "animations");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const quoteEscaped = opts.quote
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/</g, "\\x3c");

  // Read the template HTML file for this style
  const templatePath = path.join(__dirname, "..", "data", "artworks",
    style === "scramble" ? "ascii-prototype.html" : `anim-${style}.html`
  );

  let html: string;

  if (fs.existsSync(templatePath)) {
    // Read the template and inject the specific quote
    html = fs.readFileSync(templatePath, "utf-8");

    // Replace the QUOTES array with just this one quote
    // Match various patterns of quote arrays in the templates
    html = html.replace(
      /const QUOTES = \[[\s\S]*?\];/,
      `const QUOTES = ["${quoteEscaped}"];`
    );
    // Also replace single QUOTE constant (scramble prototype)
    html = html.replace(
      /const QUOTE = ".*?";/,
      `const QUOTE = "${quoteEscaped}";`
    );
    // Replace PALETTE constant in palette-aware templates
    html = html.replace(
      /const PALETTE = "[^"]*";/,
      `const PALETTE = "${palette}";`
    );

    // Remove font-face that references local files — use system fonts on IPFS
    html = html.replace(
      /@font-face\s*\{[\s\S]*?\}/g,
      ""
    );
    // Update font references to use fallbacks
    html = html.replace(
      /font-family:\s*'CMU Serif',/g,
      "font-family:"
    );
  } else {
    // Fallback: generate a simple scramble animation inline
    html = generateFallbackScramble(quoteEscaped, palette);
  }

  const htmlPath = path.join(dir, `${opts.id}-${style}.html`);
  fs.writeFileSync(htmlPath, html);

  return { htmlPath, style };
}

function generateFallbackScramble(quoteEscaped: string, palette: AnimationPalette = "hate"): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>${getSharedCss(palette)}</style></head>
<body>
<div class="container">
  <div class="vignette"></div>
  <div id="quote"></div>
</div>
<script>
${SHARED_JS_UTILS}
const QUOTE = "${quoteEscaped}";
const CHARS = '!@#\$%^&*()_+-=[]{}|;:,.<>?/~\`01\\u2588\\u2593\\u2592\\u2591\\u2584\\u2580\\u25A0\\u25A1\\u25AA\\u25AB';
const quoteEl = document.getElementById('quote');
const words = QUOTE.split(/\\s+/);
const config = getConfig(words.length);
const lines = breakIntoLines(QUOTE, config.wpl);
const lineEls = lines.map(line => {
  const div = document.createElement('div');
  div.className = 'quote-line';
  div.style.fontSize = config.size + 'vmin';
  div.style.lineHeight = '1.3';
  quoteEl.appendChild(div);
  return { el: div, text: line, chars: line.length };
});
function randomChar() { return CHARS[Math.floor(Math.random() * CHARS.length)]; }
function scrambleText(original, progress) {
  let r = '';
  for (let i = 0; i < original.length; i++) {
    if (original[i] === ' ') r += ' ';
    else if (i / original.length < progress) r += original[i];
    else r += randomChar();
  }
  return r;
}
let phase = 'wait', frame = 0, resolveProgress = 0;
function animate() {
  frame++;
  if (phase === 'wait') {
    if (frame > 60) { phase = 'scramble'; frame = 0; }
  } else if (phase === 'scramble') {
    const total = lineEls.reduce((s, l) => s + l.chars, 0);
    resolveProgress = Math.min(1, frame / (total * 2));
    let resolved = Math.floor(resolveProgress * total), soFar = 0;
    for (const line of lineEls) {
      const lr = Math.max(0, Math.min(1, (resolved - soFar) / line.chars));
      soFar += line.chars;
      line.el.textContent = scrambleText(line.text, lr);
    }
    if (resolveProgress >= 1) { lineEls.forEach(l => l.el.textContent = l.text); phase = 'hold'; frame = 0; }
  } else if (phase === 'hold') {
    if (frame > 180) { phase = 'fadeout'; frame = 0; }
  } else if (phase === 'fadeout') {
    const p = frame / 60;
    quoteEl.style.opacity = String(1 - p);
    lineEls.forEach(l => l.el.textContent = scrambleText(l.text, 1 - p));
    if (p >= 1) { phase = 'wait'; frame = 0; quoteEl.style.opacity = '1'; lineEls.forEach(l => l.el.textContent = ''); }
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
</script></body></html>`;
}

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);
  const id = parseInt(args[0]) || 1;
  const quote = args[1] || "SHE WAS ASKING FOR IT";
  const style = (args[2] as AnimationStyle) || undefined;

  const result = generateAnimation({ id, quote, style });
  console.log(`Generated: ${result.htmlPath}`);
  console.log(`Style: ${result.style}`);
}
