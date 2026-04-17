import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Read all V3 tokenURIs from Base mainnet, resolve each via IPFS gateway,
 * extract the quote attribute + attribution, write to data/v3-tokens.json.
 * One-shot. No minting. No write calls.
 */

const V3_ADDRESS = "0x356Dd09E02960D59f1073F9d22A2634bbE3b1736";
const RPC = process.env.BASE_MAINNET_RPC_URL || "https://mainnet.base.org";
const OUT = path.join(__dirname, "..", "data", "v3-tokens.json");

const ABI = [
  "function totalSupply() view returns (uint256)",
  "function tokenURI(uint256) view returns (string)",
  "function ownerOf(uint256) view returns (address)",
];

const GATEWAYS = [
  (cid: string) => `https://ipfs.io/ipfs/${cid}`,
  (cid: string) => `https://cloudflare-ipfs.com/ipfs/${cid}`,
  (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`,
];

function toGatewayUrls(uri: string): string[] {
  if (uri.startsWith("ipfs://")) {
    const cid = uri.replace("ipfs://", "").replace(/^ipfs\//, "");
    return GATEWAYS.map(g => g(cid));
  }
  return [uri];
}

async function fetchMetadata(uri: string): Promise<any | null> {
  for (const url of toGatewayUrls(uri)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (res.ok) return await res.json();
    } catch { /* try next */ }
  }
  return null;
}

function pickAttr(meta: any, keys: string[]): string | undefined {
  const attr = (meta?.attributes || []).find((a: any) =>
    keys.some(k => (a.trait_type || "").toLowerCase() === k.toLowerCase())
  );
  return attr?.value;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(V3_ADDRESS, ABI, provider);

  let total = 22;
  try {
    total = Number(await c.totalSupply());
    console.log(`totalSupply() = ${total}`);
  } catch {
    console.log(`totalSupply() not exposed, defaulting to ${total}`);
  }

  const rows: Array<{
    tokenId: number;
    owner?: string;
    tokenURI: string;
    quote?: string;
    attribution?: string;
    name?: string;
    raw?: any;
    error?: string;
  }> = [];

  for (let id = 1; id <= total; id++) {
    process.stdout.write(`[${id}/${total}] `);
    try {
      const uri: string = await c.tokenURI(id);
      let owner: string | undefined;
      try { owner = await c.ownerOf(id); } catch { /* may not exist */ }
      const meta = await fetchMetadata(uri);
      if (!meta) {
        console.log(`URI=${uri} — metadata fetch failed`);
        rows.push({ tokenId: id, tokenURI: uri, owner, error: "metadata fetch failed" });
        continue;
      }
      const quote = pickAttr(meta, ["quote"]) ?? meta.description;
      const attribution = pickAttr(meta, ["attribution", "author", "source"]);
      console.log(`"${(quote || "").slice(0, 60)}${(quote || "").length > 60 ? "…" : ""}" — ${attribution || "?"}`);
      rows.push({
        tokenId: id,
        owner,
        tokenURI: uri,
        quote,
        attribution,
        name: meta.name,
        raw: meta,
      });
    } catch (err: any) {
      console.log(`ERROR ${err?.message || err}`);
      rows.push({ tokenId: id, tokenURI: "", error: String(err?.message || err) });
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({
    contract: V3_ADDRESS,
    network: "base-mainnet",
    fetchedAt: new Date().toISOString(),
    tokens: rows,
  }, null, 2));
  console.log(`\nWrote ${rows.length} tokens → ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
