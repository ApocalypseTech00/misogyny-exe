import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_API = "https://api.pinata.cloud";

/**
 * Upload a file to IPFS via Pinata.
 * Returns the IPFS CID (content identifier).
 */
export async function uploadFile(
  filePath: string,
  name?: string
): Promise<string> {
  if (!PINATA_JWT) throw new Error("PINATA_JWT not set in .env");

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = name || path.basename(filePath);

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);
  formData.append(
    "pinataMetadata",
    JSON.stringify({ name: fileName })
  );

  const res = await fetch(`${PINATA_API}/pinning/pinFileToIPFS`, {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pinata upload failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.IpfsHash;
}

/**
 * Upload a JSON object to IPFS via Pinata.
 * Returns the IPFS CID.
 */
export async function uploadJSON(
  json: object,
  name: string
): Promise<string> {
  if (!PINATA_JWT) throw new Error("PINATA_JWT not set in .env");

  const res = await fetch(`${PINATA_API}/pinning/pinJSONToIPFS`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PINATA_JWT}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      pinataContent: json,
      pinataMetadata: { name },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pinata JSON upload failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  return data.IpfsHash;
}

/**
 * Build ERC-721 metadata JSON for a quote artwork.
 */
export function buildMetadata(opts: {
  name: string;
  description: string;
  imageCid: string;
  quote: string;
  attribution: string;
  source?: string;
  animationCid?: string;
  animationStyle?: string;
}): object {
  return {
    name: opts.name,
    description: opts.description,
    image: `ipfs://${opts.imageCid}`,
    ...(opts.animationCid ? { animation_url: `ipfs://${opts.animationCid}` } : {}),
    external_url: "https://apocalypsetech.xyz",
    attributes: [
      { trait_type: "Quote", value: opts.quote },
      { trait_type: "Attribution", value: opts.attribution },
      ...(opts.source
        ? [{ trait_type: "Source", value: opts.source }]
        : []),
      ...(opts.animationStyle
        ? [{ trait_type: "Animation", value: opts.animationStyle }]
        : []),
      { trait_type: "Project", value: "MISOGYNY.EXE" },
    ],
  };
}

// --- CLI mode ---
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log("Usage:");
    console.log("  npx ts-node scripts/upload-to-ipfs.ts <file-path>");
    console.log('  npx ts-node scripts/upload-to-ipfs.ts --json \'{"key":"value"}\' <name>');
    process.exit(0);
  }

  (async () => {
    if (args[0] === "--json") {
      const json = JSON.parse(args[1]);
      const name = args[2] || "metadata.json";
      const cid = await uploadJSON(json, name);
      console.log(`CID: ${cid}`);
      console.log(`URI: ipfs://${cid}`);
      console.log(`Gateway: https://gateway.pinata.cloud/ipfs/${cid}`);
    } else {
      const filePath = args[0];
      if (!fs.existsSync(filePath)) {
        console.error(`File not found: ${filePath}`);
        process.exit(1);
      }
      const cid = await uploadFile(filePath);
      console.log(`CID: ${cid}`);
      console.log(`URI: ipfs://${cid}`);
      console.log(`Gateway: https://gateway.pinata.cloud/ipfs/${cid}`);
    }
  })().catch(console.error);
}
