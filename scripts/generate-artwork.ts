import fs from "fs";
import path from "path";
import sharp from "sharp";

/**
 * Generate MISOGYNY.EXE typographic artwork.
 *
 * Black background, hot pink (#F918D0) CMU Serif Bold Italic text, ALL CAPS.
 * Transforms to pink bg / black text on purchase (redemption).
 * Font size auto-scales based on word count. Line breaks are meaning-aware
 * (1-3 words per line, phrases kept together).
 *
 * Converts to PNG via sharp (eliminates SVG script injection vector).
 *
 * Usage:
 *   import { generateArtwork } from "./generate-artwork";
 *   const pngPath = await generateArtwork({ id: 1, quote: "...", attribution: "..." });
 */

const SIZE = 1000;
const BG_COLOR = "#0a0a0a";      // Black background — the hate
const TEXT_COLOR = "#F918D0";    // Hot pink text
const PADDING = 60; // px from edges
const MAX_TEXT_WIDTH = SIZE - PADDING * 2;

interface ArtworkOpts {
  id: number;
  quote: string;
  attribution: string;
  outputDir?: string;
  lineBreaks?: string[]; // pre-computed line breaks from Claude
}

// Font size tiers based on word count
function getFontSize(wordCount: number): number {
  if (wordCount <= 5) return 95;
  if (wordCount <= 8) return 80;
  if (wordCount <= 12) return 68;
  if (wordCount <= 18) return 56;
  return 42; // 19-25 words
}

// Line height as proportion of font size
function getLineHeight(fontSize: number): number {
  return fontSize * 1.15;
}

/**
 * Smart line breaking: 1-3 words per line, keeping short phrases together.
 * Aims to match the visual style in the reference templates.
 */
function smartLineBreak(text: string, fontSize: number): string[] {
  const words = text.split(/\s+/);
  const wordCount = words.length;

  // For very short quotes (1-5 words), 1-2 words per line
  if (wordCount <= 5) {
    return breakByWordsPerLine(words, 2);
  }

  // For short quotes (6-10 words), 1-2 words per line
  if (wordCount <= 10) {
    return breakByWordsPerLine(words, 2);
  }

  // For medium quotes (11-18 words), 2-3 words per line
  if (wordCount <= 18) {
    return breakByWordsPerLine(words, 3);
  }

  // For longer quotes (19-25 words), 3 words per line
  return breakByWordsPerLine(words, 3);
}

/**
 * Break words into lines with target words per line.
 * Keeps lines visually even — no single fat/thin lines.
 * Prefers breaking after commas and natural pauses.
 */
function breakByWordsPerLine(words: string[], targetWpl: number): string[] {
  const totalWords = words.length;

  // Calculate ideal number of lines for even distribution
  const idealLines = Math.ceil(totalWords / targetWpl);

  // Distribute words as evenly as possible across lines
  const baseWordsPerLine = Math.floor(totalWords / idealLines);
  const extraWords = totalWords % idealLines;

  const lines: string[] = [];
  let i = 0;

  for (let lineNum = 0; lineNum < idealLines; lineNum++) {
    // Give extra words to earlier lines (wider at top, narrower at bottom)
    let take = baseWordsPerLine + (lineNum < extraWords ? 1 : 0);
    take = Math.min(take, totalWords - i);

    if (take <= 0) break;

    // Check if breaking after a comma nearby makes more sense
    for (let j = Math.max(1, take - 1); j <= Math.min(take + 1, totalWords - i); j++) {
      const word = words[i + j - 1];
      if (word && (word.endsWith(",") || word.endsWith(";"))) {
        take = j;
        break;
      }
    }

    const line = words.slice(i, i + take).join(" ");
    lines.push(line);
    i += take;
  }

  // Pick up any remaining words
  if (i < totalWords) {
    lines.push(words.slice(i).join(" "));
  }

  return lines;
}

/**
 * Read font file and encode as base64 data URI for SVG embedding.
 */
function getFontBase64(): string {
  const fontPath = path.join(__dirname, "..", "site", "fonts", "cmunbl.ttf");
  if (!fs.existsSync(fontPath)) {
    console.warn(`Font not found at ${fontPath}, falling back to system serif`);
    return "";
  }
  const fontBuffer = fs.readFileSync(fontPath);
  return fontBuffer.toString("base64");
}

/**
 * Generate the artwork SVG string.
 */
function buildSvg(opts: ArtworkOpts): string {
  const quote = opts.quote.toUpperCase();
  const words = quote.split(/\s+/);
  const wordCount = words.length;
  const fontSize = getFontSize(wordCount);
  const lineHeight = getLineHeight(fontSize);

  // Use pre-computed line breaks or smart break
  const lines = opts.lineBreaks
    ? opts.lineBreaks.map((l) => l.toUpperCase())
    : smartLineBreak(quote, fontSize);

  // Calculate vertical position (centre the text block)
  const totalTextHeight = lines.length * lineHeight;
  const startY = (SIZE - totalTextHeight) / 2 + fontSize * 0.75; // baseline offset

  // Build text elements with curly quotes
  const textElements: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let lineText = escapeXml(lines[i]);

    // Add opening curly quote to first line
    if (i === 0) {
      lineText = "\u201C" + lineText;
    }
    // Add closing curly quote to last line
    if (i === lines.length - 1) {
      // Add period if not already ending with punctuation
      if (!/[.!?]$/.test(lines[i])) {
        lineText = lineText + ".\u201D";
      } else {
        lineText = lineText + "\u201D";
      }
    }

    const y = startY + i * lineHeight;
    textElements.push(
      `  <text x="500" y="${y}" text-anchor="middle" font-family="CMU Serif, Georgia, serif" font-size="${fontSize}" font-weight="900" font-style="italic" fill="${TEXT_COLOR}">${lineText}</text>`
    );
  }

  // Embed font as base64
  const fontBase64 = getFontBase64();
  const fontFace = fontBase64
    ? `
    <style type="text/css">
      @font-face {
        font-family: 'CMU Serif';
        src: url('data:font/truetype;base64,${fontBase64}') format('truetype');
        font-weight: 900;
        font-style: italic;
      }
    </style>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>${fontFace}
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="${BG_COLOR}"/>
${textElements.join("\n")}
</svg>`;
}

/**
 * Main entry: generate artwork and convert to PNG.
 */
export function generateArtwork(opts: ArtworkOpts): string {
  const dir = opts.outputDir || path.join(__dirname, "..", "data", "artworks");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const svgPath = path.join(dir, `${opts.id}.svg`);
  const pngPath = path.join(dir, `${opts.id}.png`);

  const svg = buildSvg(opts);
  fs.writeFileSync(svgPath, svg);

  // Schedule async PNG conversion
  convertToPng(svgPath, pngPath).catch((err) => {
    console.error(`PNG conversion failed for ${opts.id}:`, err);
  });

  return svgPath;
}

// Keep old name as alias for backwards compatibility
export const generatePlaceholder = generateArtwork;

/**
 * Convert SVG to PNG asynchronously.
 */
export async function convertToPng(
  svgPath: string,
  pngPath?: string
): Promise<string> {
  const out = pngPath || svgPath.replace(/\.svg$/, ".png");
  await sharp(svgPath).resize(SIZE, SIZE).png({ quality: 90 }).toFile(out);
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --- CLI mode ---
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(
      'Usage: npx ts-node scripts/generate-artwork.ts "quote" ["attribution"] [id]'
    );
    console.log(
      '\nExamples:\n  npx ts-node scripts/generate-artwork.ts "She was asking for it"'
    );
    console.log(
      '  npx ts-node scripts/generate-artwork.ts "Women belong in the kitchen, not in the boardroom" "Anonymous" 42'
    );
    process.exit(0);
  }
  const quote = args[0];
  const attribution = args[1] || "Anonymous";
  const id = parseInt(args[2] || "0") || Date.now();

  console.log(`Quote: "${quote}" (${quote.split(/\s+/).length} words)`);
  console.log(`Font size: ${getFontSize(quote.split(/\s+/).length)}px`);
  console.log(`Lines: ${smartLineBreak(quote.toUpperCase(), getFontSize(quote.split(/\s+/).length)).join(" | ")}`);

  const svgPath = generateArtwork({ id, quote, attribution });
  console.log(`Generated SVG: ${svgPath}`);

  convertToPng(svgPath).then((pngPath) => {
    console.log(`Converted PNG: ${pngPath}`);
  });
}
