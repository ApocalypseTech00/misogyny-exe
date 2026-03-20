import QRCode from "qrcode";
import sharp from "sharp";
import path from "path";
import fs from "fs";

/**
 * Generate print-ready QR codes pointing to the marketplace.
 *
 * Usage:
 *   COLLECTION_URL="https://apocalypsetech.xyz/marketplace.html" npx ts-node scripts/generate-qr.ts
 */
async function main() {
  const TARGET_URL = process.env.COLLECTION_URL || process.env.MARKETPLACE_BASE_URL;
  if (!TARGET_URL) {
    console.error("Set COLLECTION_URL or MARKETPLACE_BASE_URL env var");
    process.exit(1);
  }

  const outDir = path.join(__dirname, "..", "assets", "qr-codes");
  fs.mkdirSync(outDir, { recursive: true });

  const sizes = [
    { name: "qr-small", px: 500, dpi: 300, desc: "sticker (~4cm)" },
    { name: "qr-medium", px: 1000, dpi: 300, desc: "poster (~8cm)" },
    { name: "qr-large", px: 2000, dpi: 300, desc: "A3 poster (~17cm)" },
  ];

  for (const size of sizes) {
    // Generate QR as PNG buffer
    const qrBuffer = await QRCode.toBuffer(TARGET_URL, {
      type: "png",
      width: size.px,
      margin: 2,
      color: {
        dark: "#000000",
        light: "#FFFFFF",
      },
      errorCorrectionLevel: "H", // high error correction for street art
    });

    // Set DPI metadata with sharp
    const outputPath = path.join(outDir, `${size.name}-${size.px}px.png`);
    await sharp(qrBuffer)
      .withMetadata({ density: size.dpi })
      .toFile(outputPath);

    console.log(`Generated ${size.name} (${size.desc}): ${outputPath}`);
  }

  // Also generate an SVG (infinite resolution)
  const svgString = await QRCode.toString(TARGET_URL, {
    type: "svg",
    margin: 2,
    color: {
      dark: "#000000",
      light: "#FFFFFF",
    },
    errorCorrectionLevel: "H",
  });

  const svgPath = path.join(outDir, "qr-vector.svg");
  fs.writeFileSync(svgPath, svgString);
  console.log(`Generated vector SVG: ${svgPath}`);

  console.log(`\nAll QR codes point to: ${TARGET_URL}`);
  console.log("Ready for print!");
}

main().catch(console.error);
