import { uploadFileArray } from "pinata";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const jwt = process.env.PINATA_JWT;
  if (!jwt) {
    console.error("Set PINATA_JWT env var");
    process.exit(1);
  }

  const config = { pinataJwt: jwt };
  const siteDir = path.join(__dirname, "..", "site");

  if (!fs.existsSync(siteDir)) {
    console.error("site/ directory not found");
    process.exit(1);
  }

  const files: File[] = [];
  function walkDir(dir: string, prefix: string = "") {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkDir(fullPath, relativePath);
      } else {
        const content = fs.readFileSync(fullPath);
        const file = new File([content], relativePath, {
          type: getMimeType(entry.name),
        });
        files.push(file);
      }
    }
  }

  walkDir(siteDir);
  console.log(`Uploading ${files.length} file(s) to IPFS via Pinata...`);

  const upload = await uploadFileArray(
    config,
    files,
    undefined, // network
    { metadata: { name: "misogyny-exe-site" } }
  );

  const cid = (upload as any).IpfsHash || (upload as any).cid || upload;
  console.log(`\nUploaded! CID: ${cid}`);
  console.log(`\nAccess via gateways:`);
  console.log(`  https://gateway.pinata.cloud/ipfs/${cid}`);
  console.log(`  https://ipfs.io/ipfs/${cid}`);
  console.log(`\nFor custom domain, add a TXT record in GoDaddy:`);
  console.log(`  Name: _dnslink`);
  console.log(`  Value: dnslink=/ipfs/${cid}`);
}

function getMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const types: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain",
  };
  return types[ext] || "application/octet-stream";
}

main().catch(console.error);
