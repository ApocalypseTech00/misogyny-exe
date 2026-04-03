import fs from "fs";
import path from "path";

/**
 * Generate a self-contained animation HTML for a redeemed NFT.
 *
 * Two phases:
 *   1. GLITCH TRANSITION (plays once) — the original hate quote (dark bg,
 *      pink text) corrupts, tears, and dissolves. Background morphs from
 *      black to pink as the counter-quote resolves.
 *   2. REDEEMED LOOP — the positive counter-quote animated with its own
 *      style (inverted palette: pink bg, dark text).
 *
 * The HTML is fully standalone (no external deps) so it works on IPFS.
 */

const REDEEMED_ANIMATION_STYLES = [
  "scramble",
  "typewriter",
  "flicker",
  "corruption",
  "ascii",
] as const;

type RedeemedStyle = (typeof REDEEMED_ANIMATION_STYLES)[number];

const STYLE_WEIGHTS: Record<RedeemedStyle, number> = {
  scramble: 40,
  typewriter: 20,
  flicker: 15,
  corruption: 15,
  ascii: 10,
};

export function pickRedeemedStyle(tokenId: number): RedeemedStyle {
  const totalWeight = Object.values(STYLE_WEIGHTS).reduce((a, b) => a + b, 0);
  const hash = (tokenId * 2654435761) >>> 0;
  let pick = hash % totalWeight;
  for (const [style, weight] of Object.entries(STYLE_WEIGHTS)) {
    pick -= weight;
    if (pick < 0) return style as RedeemedStyle;
  }
  return "scramble";
}

// --- Colors (HATE_ must match generate-animation.ts exactly) ---
const HATE_BG = "#1a1a1a";
const HATE_TEXT = "#F918D0";
const REDEEMED_BG = "#F918D0";
const REDEEMED_TEXT = "#0a0a0a";

// --- Shared helpers injected into every HTML ---

const SHARED_JS = `
function getConfig(wc) {
  if (wc <= 5) return { wpl: 3, size: 8 };
  if (wc <= 10) return { wpl: 3, size: 6 };
  if (wc <= 18) return { wpl: 3, size: 5 };
  return { wpl: 3, size: 4 };
}
function breakIntoLines(text, wpl) {
  const words = text.split(/\\s+/);
  const total = Math.ceil(words.length / wpl);
  const base = Math.floor(words.length / total);
  const extra = words.length % total;
  const lines = []; let idx = 0;
  for (let i = 0; i < total; i++) {
    const take = base + (i < extra ? 1 : 0);
    lines.push(words.slice(idx, idx + take).join(' '));
    idx += take;
  }
  return lines;
}
function renderLines(container, text, config, color) {
  container.innerHTML = '';
  const lines = breakIntoLines(text, config.wpl);
  return lines.map(line => {
    const div = document.createElement('div');
    div.className = 'quote-line';
    div.style.fontSize = config.size + 'vmin';
    div.style.lineHeight = '1.3';
    div.style.color = color;
    div.style.textShadow = color === '${HATE_TEXT}'
      ? '0 0 8px ${HATE_TEXT}80, 0 0 20px ${HATE_TEXT}30'
      : '0 0 8px ${REDEEMED_TEXT}40';
    div.textContent = line;
    container.appendChild(div);
    return { el: div, text: line };
  });
}
`;

function escapeForJS(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/</g, "\\x3c")
    .replace(/\n/g, " ");
}

// --- Redeemed animation generators (per style) ---

function scrambleLoop(): string {
  return `
// --- SCRAMBLE (redeemed loop) ---
const CHARS = '!@#$%^&*()_+-=[]{}|;:,.<>?/~\`01\\u2588\\u2593\\u2592\\u2591';
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
function redeemedLoop(lineEls) {
  let frame = 0, loopPhase = 'scramble', resolveP = 0;
  function tick() {
    frame++;
    if (loopPhase === 'scramble') {
      const total = lineEls.reduce((s, l) => s + l.text.length, 0);
      resolveP = Math.min(1, frame / (total * 2));
      let resolved = Math.floor(resolveP * total), soFar = 0;
      for (const l of lineEls) {
        const lr = Math.max(0, Math.min(1, (resolved - soFar) / l.text.length));
        soFar += l.text.length;
        l.el.textContent = scrambleText(l.text, lr);
      }
      if (resolveP >= 1) { lineEls.forEach(l => l.el.textContent = l.text); loopPhase = 'hold'; frame = 0; }
    } else if (loopPhase === 'hold') {
      if (frame > 240) { loopPhase = 'fadeout'; frame = 0; }
    } else if (loopPhase === 'fadeout') {
      const p = frame / 60;
      lineEls.forEach(l => { l.el.textContent = scrambleText(l.text, 1 - p); l.el.style.opacity = String(1 - p); });
      if (p >= 1) { loopPhase = 'scramble'; frame = 0; lineEls.forEach(l => { l.el.textContent = ''; l.el.style.opacity = '1'; }); }
    }
    requestAnimationFrame(tick);
  }
  tick();
}`;
}

function typewriterLoop(): string {
  return `
// --- TYPEWRITER (redeemed loop) ---
function redeemedLoop(lineEls) {
  const fullText = lineEls.map(l => l.text).join('\\n');
  let charIdx = 0, frame = 0, loopPhase = 'type';
  function tick() {
    frame++;
    if (loopPhase === 'type') {
      if (frame % 3 === 0 && charIdx <= fullText.length) {
        let lineI = 0, pos = 0;
        for (let i = 0; i < charIdx; i++) {
          if (fullText[i] === '\\n') { lineI++; pos = 0; }
          else pos++;
        }
        for (let l = 0; l < lineEls.length; l++) {
          if (l < lineI) lineEls[l].el.textContent = lineEls[l].text;
          else if (l === lineI) lineEls[l].el.textContent = lineEls[l].text.slice(0, pos) + (frame % 6 < 3 ? '\\u2588' : '');
          else lineEls[l].el.textContent = '';
        }
        charIdx++;
      }
      if (charIdx > fullText.length) {
        lineEls.forEach(l => l.el.textContent = l.text);
        loopPhase = 'hold'; frame = 0;
      }
    } else if (loopPhase === 'hold') {
      if (frame > 300) { loopPhase = 'erase'; frame = 0; charIdx = fullText.length; }
    } else if (loopPhase === 'erase') {
      if (frame % 2 === 0 && charIdx >= 0) {
        let lineI = 0, pos = 0;
        for (let i = 0; i < charIdx; i++) {
          if (fullText[i] === '\\n') { lineI++; pos = 0; }
          else pos++;
        }
        for (let l = 0; l < lineEls.length; l++) {
          if (l < lineI) lineEls[l].el.textContent = lineEls[l].text;
          else if (l === lineI) lineEls[l].el.textContent = lineEls[l].text.slice(0, pos);
          else lineEls[l].el.textContent = '';
        }
        charIdx--;
      }
      if (charIdx < 0) { loopPhase = 'pause'; frame = 0; }
    } else if (loopPhase === 'pause') {
      if (frame > 60) { loopPhase = 'type'; frame = 0; charIdx = 0; }
    }
    requestAnimationFrame(tick);
  }
  tick();
}`;
}

function flickerLoop(): string {
  return `
// --- FLICKER (redeemed loop) ---
function redeemedLoop(lineEls) {
  let frame = 0;
  function tick() {
    frame++;
    for (const l of lineEls) {
      // Base glow
      let opacity = 0.85 + 0.15 * Math.sin(frame * 0.04);
      // Random flicker
      if (Math.random() < 0.03) opacity *= 0.2 + Math.random() * 0.3;
      // Occasional full blackout
      if (Math.random() < 0.005) opacity = 0;
      l.el.style.opacity = String(opacity);
      // Slight horizontal jitter on flicker
      if (opacity < 0.5) {
        l.el.style.transform = 'translateX(' + (Math.random() - 0.5) * 4 + 'px)';
      } else {
        l.el.style.transform = 'translateX(0)';
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
}`;
}

function corruptionLoop(): string {
  return `
// --- CORRUPTION (redeemed loop) ---
const HEX = '0123456789ABCDEF';
function redeemedLoop(lineEls) {
  let frame = 0, loopPhase = 'reveal';
  // Scramble chars pool
  const pool = lineEls.map(l => ({ el: l.el, text: l.text, display: '' }));
  function tick() {
    frame++;
    if (loopPhase === 'reveal') {
      const progress = Math.min(1, frame / 200);
      for (const p of pool) {
        let d = '';
        for (let i = 0; i < p.text.length; i++) {
          if (p.text[i] === ' ') d += ' ';
          else if (i / p.text.length < progress) d += p.text[i];
          else d += HEX[Math.floor(Math.random() * 16)];
        }
        p.el.textContent = d;
      }
      if (progress >= 1) { pool.forEach(p => p.el.textContent = p.text); loopPhase = 'hold'; frame = 0; }
    } else if (loopPhase === 'hold') {
      // Occasional char glitch
      if (Math.random() < 0.05) {
        const p = pool[Math.floor(Math.random() * pool.length)];
        const chars = p.text.split('');
        const i = Math.floor(Math.random() * chars.length);
        if (chars[i] !== ' ') chars[i] = HEX[Math.floor(Math.random() * 16)];
        p.el.textContent = chars.join('');
        setTimeout(() => { p.el.textContent = p.text; }, 100 + Math.random() * 200);
      }
      if (frame > 300) { loopPhase = 'dissolve'; frame = 0; }
    } else if (loopPhase === 'dissolve') {
      const progress = Math.min(1, frame / 120);
      for (const p of pool) {
        let d = '';
        for (let i = 0; i < p.text.length; i++) {
          if (p.text[i] === ' ') d += ' ';
          else if (Math.random() > progress) d += p.text[i];
          else d += HEX[Math.floor(Math.random() * 16)];
        }
        p.el.textContent = d;
        p.el.style.opacity = String(1 - progress * 0.8);
      }
      if (progress >= 1) { pool.forEach(p => { p.el.textContent = ''; p.el.style.opacity = '1'; }); loopPhase = 'reveal'; frame = 0; }
    }
    requestAnimationFrame(tick);
  }
  tick();
}`;
}

function asciiLoop(): string {
  return `
// --- ASCII (redeemed loop) ---
const FILL = ['\\u2588','\\u2593','\\u2592','\\u2591','#','@','%','&'];
function redeemedLoop(lineEls) {
  let frame = 0, loopPhase = 'build';
  const fullText = lineEls.map(l => l.text).join(' ');
  function tick() {
    frame++;
    if (loopPhase === 'build') {
      const progress = Math.min(1, frame / 180);
      for (const l of lineEls) {
        let d = '';
        for (let i = 0; i < l.text.length; i++) {
          if (l.text[i] === ' ') d += ' ';
          else if (i / l.text.length < progress) d += l.text[i];
          else d += FILL[Math.floor(Math.random() * FILL.length)];
        }
        l.el.textContent = d;
      }
      if (progress >= 1) { lineEls.forEach(l => l.el.textContent = l.text); loopPhase = 'hold'; frame = 0; }
    } else if (loopPhase === 'hold') {
      // Shimmer: occasionally replace a char with a block char then back
      if (Math.random() < 0.08) {
        const l = lineEls[Math.floor(Math.random() * lineEls.length)];
        const chars = l.text.split('');
        const i = Math.floor(Math.random() * chars.length);
        const original = chars[i];
        if (original !== ' ') {
          chars[i] = FILL[Math.floor(Math.random() * FILL.length)];
          l.el.textContent = chars.join('');
          setTimeout(() => { l.el.textContent = l.text; }, 80);
        }
      }
      if (frame > 300) { loopPhase = 'scatter'; frame = 0; }
    } else if (loopPhase === 'scatter') {
      const progress = Math.min(1, frame / 90);
      for (const l of lineEls) {
        let d = '';
        for (let i = 0; i < l.text.length; i++) {
          if (l.text[i] === ' ') d += ' ';
          else if (Math.random() > progress) d += l.text[i];
          else d += FILL[Math.floor(Math.random() * FILL.length)];
        }
        l.el.textContent = d;
        l.el.style.opacity = String(1 - progress);
      }
      if (progress >= 1) { lineEls.forEach(l => { l.el.textContent = ''; l.el.style.opacity = '1'; }); loopPhase = 'build'; frame = 0; }
    }
    requestAnimationFrame(tick);
  }
  tick();
}`;
}

function getLoopJS(style: RedeemedStyle): string {
  switch (style) {
    case "scramble": return scrambleLoop();
    case "typewriter": return typewriterLoop();
    case "flicker": return flickerLoop();
    case "corruption": return corruptionLoop();
    case "ascii": return asciiLoop();
  }
}

// --- Main HTML generator ---

function buildHTML(opts: {
  hateQuote: string;
  counterQuote: string;
  tokenId: number;
  style: RedeemedStyle;
}): string {
  const hate = escapeForJS(opts.hateQuote);
  const counter = escapeForJS(opts.counterQuote);
  const loopJS = getLoopJS(opts.style);

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: ${HATE_BG};
    height: 100vh;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: Georgia, 'Times New Roman', serif;
    font-style: italic;
    font-weight: 900;
    transition: background-color 0.8s ease;
  }
  canvas {
    position: fixed; inset: 0; z-index: 1;
    pointer-events: none;
  }
  .container {
    width: 100vmin; height: 100vmin;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    z-index: 2;
  }
  .container::after {
    content: '';
    position: absolute; inset: 0;
    background: repeating-linear-gradient(
      to bottom, transparent, transparent 1px,
      rgba(0,0,0,0.12) 1px, rgba(0,0,0,0.12) 2px
    );
    pointer-events: none; z-index: 10;
  }
  .quote-line {
    text-align: center;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    min-height: 1.2em;
    padding: 0 5vmin;
    position: relative;
  }
  .vignette {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.6) 100%);
    pointer-events: none; z-index: 9;
  }
  .label {
    position: absolute; bottom: 30px;
    font-size: 10px; color: ${REDEEMED_TEXT}40;
    letter-spacing: 0.3em; text-transform: uppercase;
    z-index: 5;
  }
</style></head>
<body>
<canvas id="glitchCanvas"></canvas>
<div class="container">
  <div id="quote"></div>
  <span class="label">REDEEMED — MISOGYNY.EXE #${opts.tokenId}</span>
</div>
<div class="vignette"></div>
<script>
${SHARED_JS}
${loopJS}

const HATE_QUOTE = "${hate}";
const COUNTER_QUOTE = "${counter}";
const quoteEl = document.getElementById('quote');
const canvas = document.getElementById('glitchCanvas');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// ========================================
// PHASE 1: GLITCH TRANSITION (plays once)
// ========================================

const hateConfig = getConfig(HATE_QUOTE.split(/\\s+/).length);
const counterConfig = getConfig(COUNTER_QUOTE.split(/\\s+/).length);

// Show hate quote first
let hateLines = renderLines(quoteEl, HATE_QUOTE, hateConfig, '${HATE_TEXT}');

let transitionFrame = 0;
const TRANSITION_DURATION = 300; // ~5 seconds at 60fps

function glitchTransition() {
  transitionFrame++;
  const progress = transitionFrame / TRANSITION_DURATION;

  // --- Screen tear / RGB split on canvas ---
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Increasing glitch intensity
  const intensity = Math.pow(progress, 2);

  // Random block displacement
  if (Math.random() < intensity * 0.4) {
    const blockH = 5 + Math.random() * 40;
    const y = Math.random() * canvas.height;
    const shift = (Math.random() - 0.5) * intensity * 100;
    ctx.fillStyle = 'rgba(249, 24, 208, ' + (intensity * 0.15) + ')';
    ctx.fillRect(shift, y, canvas.width, blockH);
  }

  // Horizontal scan lines
  if (Math.random() < intensity * 0.3) {
    for (let i = 0; i < 3; i++) {
      const y = Math.random() * canvas.height;
      ctx.fillStyle = 'rgba(249, 24, 208, ' + (0.05 + intensity * 0.1) + ')';
      ctx.fillRect(0, y, canvas.width, 1 + Math.random() * 2);
    }
  }

  // Text corruption — scramble the hate quote
  if (progress < 0.6) {
    // Phase A: hate text starts glitching
    const glitchChars = '\\u2588\\u2593\\u2592\\u2591!@#$%^&*';
    for (const l of hateLines) {
      let d = '';
      for (let i = 0; i < l.text.length; i++) {
        if (l.text[i] === ' ') d += ' ';
        else if (Math.random() < intensity * 1.5) d += glitchChars[Math.floor(Math.random() * glitchChars.length)];
        else d += l.text[i];
      }
      l.el.textContent = d;
      // RGB split effect via text-shadow
      if (Math.random() < intensity) {
        const dx = (Math.random() - 0.5) * intensity * 10;
        l.el.style.textShadow = dx + 'px 0 #ff0000, ' + (-dx) + 'px 0 #00ffff';
      }
    }
  } else if (progress < 0.75) {
    // Phase B: background transition — interpolate colors
    const bgProgress = (progress - 0.6) / 0.15;
    const r = Math.round(26 + bgProgress * (249 - 26));
    const g = Math.round(26 + bgProgress * (24 - 26));
    const b = Math.round(26 + bgProgress * (208 - 26));
    document.body.style.backgroundColor = 'rgb(' + r + ',' + g + ',' + b + ')';

    // Fade out hate text
    for (const l of hateLines) {
      l.el.style.opacity = String(1 - bgProgress);
    }

    // Heavy glitch
    if (Math.random() < 0.5) {
      ctx.fillStyle = 'rgba(26, 26, 26, 0.3)';
      const y = Math.random() * canvas.height;
      ctx.fillRect(0, y, canvas.width, 10 + Math.random() * 50);
    }
  } else {
    // Phase C: counter-quote resolves
    const resolveProgress = (progress - 0.75) / 0.25;
    document.body.style.backgroundColor = '${REDEEMED_BG}';

    if (resolveProgress < 0.1) {
      // Clear hate, render counter
      quoteEl.innerHTML = '';
      hateLines = renderLines(quoteEl, COUNTER_QUOTE, counterConfig, '${REDEEMED_TEXT}');
      for (const l of hateLines) l.el.style.opacity = '0';
    }

    // Fade in counter-quote
    const fadeIn = Math.min(1, (resolveProgress - 0.1) / 0.5);
    for (const l of hateLines) {
      l.el.style.opacity = String(fadeIn);
    }

    // Diminishing glitch
    if (Math.random() < (1 - resolveProgress) * 0.3) {
      ctx.fillStyle = 'rgba(26, 26, 26, 0.1)';
      const y = Math.random() * canvas.height;
      ctx.fillRect(0, y, canvas.width, 2 + Math.random() * 10);
    }
  }

  if (transitionFrame < TRANSITION_DURATION) {
    requestAnimationFrame(glitchTransition);
  } else {
    // Transition complete — clean up and start redeemed loop
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.style.display = 'none';
    document.body.style.backgroundColor = '${REDEEMED_BG}';
    quoteEl.innerHTML = '';
    const counterLines = renderLines(quoteEl, COUNTER_QUOTE, counterConfig, '${REDEEMED_TEXT}');
    redeemedLoop(counterLines);
  }
}

// Start: show hate quote briefly, then begin transition
setTimeout(() => {
  requestAnimationFrame(glitchTransition);
}, 2000);
</script>
</body></html>`;
}

// --- Public API ---

export function generateRedeemedAnimation(opts: {
  id: number;
  hateQuote: string;
  counterQuote: string;
  style?: RedeemedStyle;
  outputDir?: string;
}): { htmlPath: string; style: RedeemedStyle } {
  const style = opts.style || pickRedeemedStyle(opts.id);
  const dir = opts.outputDir || path.join(__dirname, "..", "data", "artworks", "animations", "redeemed");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const html = buildHTML({
    hateQuote: opts.hateQuote,
    counterQuote: opts.counterQuote,
    tokenId: opts.id,
    style,
  });

  const htmlPath = path.join(dir, `${opts.id}-redeemed-${style}.html`);
  fs.writeFileSync(htmlPath, html);

  return { htmlPath, style };
}

// --- CLI ---
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args[0] === "--preview") {
    // Generate all styles for preview
    const hate = args[1] || "WOMEN DON'T BELONG IN TECH";
    const counter = args[2] || "Ada Lovelace wrote the first computer algorithm in 1843.";
    console.log(`Generating all styles...\n  Hate: "${hate}"\n  Counter: "${counter}"\n`);
    for (const style of REDEEMED_ANIMATION_STYLES) {
      const result = generateRedeemedAnimation({
        id: 999,
        hateQuote: hate,
        counterQuote: counter,
        style,
      });
      console.log(`  ${style}: ${result.htmlPath}`);
    }
  } else {
    const id = parseInt(args[0]) || 1;
    const hate = args[1] || "SHE WAS ASKING FOR IT";
    const counter = args[2] || "Valentina Tereshkova flew to space in 1963, twenty years before Sally Ride.";
    const style = (args[3] as RedeemedStyle) || undefined;

    const result = generateRedeemedAnimation({ id, hateQuote: hate, counterQuote: counter, style });
    console.log(`Generated: ${result.htmlPath}`);
    console.log(`Style: ${result.style}`);
  }
}
