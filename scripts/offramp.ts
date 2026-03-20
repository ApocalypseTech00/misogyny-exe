import dotenv from "dotenv";
import crypto from "crypto";

dotenv.config({ path: [".env.local", ".env"] });

/**
 * Off-ramp script: monitors the charity wallet on Base,
 * sells ETH/USDC for GBP via Kraken, and triggers bank transfer to Refuge.
 *
 * Flow:
 *   1. Check charity wallet balance on Base
 *   2. If above threshold, send ETH to Kraken deposit address
 *   3. Sell ETH for GBP on Kraken
 *   4. Withdraw GBP to Refuge bank account via Faster Payments
 *
 * Designed to run as a cron job.
 *
 * Environment variables:
 *   KRAKEN_API_KEY       — Kraken API key
 *   KRAKEN_PRIVATE_KEY   — Kraken API private key (secret)
 *   CHARITY_ADDRESS      — Wallet receiving 50% from PaymentSplitter
 *   MIN_OFFRAMP_ETH      — Minimum ETH balance to trigger off-ramp (default: 0.01)
 *
 * Usage:
 *   npx ts-node scripts/offramp.ts              # Check balance + off-ramp
 *   npx ts-node scripts/offramp.ts --status     # Check Kraken balance
 *   npx ts-node scripts/offramp.ts --deposit    # Get Kraken deposit address
 *
 * Cron (every 6 hours):
 *   0 star-slash-6 * * * npx ts-node scripts/offramp.ts
 */

const KRAKEN_API_KEY = process.env.KRAKEN_API_KEY || "";
const KRAKEN_PRIVATE_KEY = process.env.KRAKEN_PRIVATE_KEY || "";
const CHARITY_ADDRESS = process.env.CHARITY_ADDRESS;
const MIN_OFFRAMP_ETH = parseFloat(process.env.MIN_OFFRAMP_ETH || "0.01");
const KRAKEN_API_URL = "https://api.kraken.com";

// --- Kraken API auth ---

function getKrakenSignature(
  urlPath: string,
  data: string,
  nonce: number
): string {
  const message = nonce + data;
  const secret = Buffer.from(KRAKEN_PRIVATE_KEY, "base64");
  const hash = crypto.createHash("sha256").update(message).digest();
  const hmac = crypto
    .createHmac("sha512", secret)
    .update(Buffer.concat([Buffer.from(urlPath), hash]))
    .digest("base64");
  return hmac;
}

async function krakenRequest(
  endpoint: string,
  params: Record<string, string> = {}
): Promise<any> {
  const urlPath = `/0/private/${endpoint}`;
  const nonce = Date.now() * 1000;
  const data = new URLSearchParams({ nonce: String(nonce), ...params }).toString();

  const signature = getKrakenSignature(urlPath, data, nonce);

  const res = await fetch(`${KRAKEN_API_URL}${urlPath}`, {
    method: "POST",
    headers: {
      "API-Key": KRAKEN_API_KEY,
      "API-Sign": signature,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: data,
  });

  const json = await res.json();
  if (json.error && json.error.length > 0) {
    throw new Error(`Kraken API error: ${json.error.join(", ")}`);
  }
  return json.result;
}

// --- Charity wallet balance ---

async function getCharityBalance(): Promise<number> {
  const res = await fetch(
    `https://base.blockscout.com/api/v2/addresses/${CHARITY_ADDRESS}`
  );
  const data = await res.json();
  const bal = data.coin_balance || "0";
  return parseInt(bal) / 1e18;
}

// --- Kraken operations ---

async function getKrakenBalance(): Promise<Record<string, string>> {
  return krakenRequest("Balance");
}

async function getDepositAddress(asset: string): Promise<string> {
  const result = await krakenRequest("DepositAddresses", {
    asset,
    method: "Ethereum (ERC20)",
  });
  if (result && result.length > 0) {
    return result[0].address;
  }
  throw new Error("No deposit address found");
}

async function sellForGBP(volume: string): Promise<any> {
  return krakenRequest("AddOrder", {
    pair: "ETHGBP",
    type: "sell",
    ordertype: "market",
    volume,
  });
}

async function withdrawGBP(amount: string, key: string): Promise<any> {
  return krakenRequest("Withdraw", {
    asset: "GBP",
    key, // withdrawal destination name (set up in Kraken account)
    amount,
  });
}

// --- Main ---

async function checkStatus() {
  console.log("Kraken account balance:");
  const balance = await getKrakenBalance();
  for (const [asset, amount] of Object.entries(balance)) {
    if (parseFloat(amount as string) > 0) {
      console.log(`  ${asset}: ${amount}`);
    }
  }
}

async function getDeposit() {
  console.log("Kraken ETH deposit address:");
  const addr = await getDepositAddress("XETH");
  console.log(`  ${addr}`);
  console.log("  Send ETH from charity wallet to this address");
}

async function main() {
  const args = process.argv.slice(2);

  if (!KRAKEN_API_KEY || !KRAKEN_PRIVATE_KEY) {
    console.error("Set KRAKEN_API_KEY and KRAKEN_PRIVATE_KEY in .env");
    process.exit(1);
  }

  if (args.includes("--status")) {
    await checkStatus();
    return;
  }

  if (args.includes("--deposit")) {
    await getDeposit();
    return;
  }

  // Default: check charity wallet and off-ramp if above threshold
  if (!CHARITY_ADDRESS) {
    console.error("Set CHARITY_ADDRESS env var");
    process.exit(1);
  }

  console.log(`[${new Date().toISOString()}] Off-ramp check`);
  console.log(`  Charity wallet: ${CHARITY_ADDRESS}`);

  const balance = await getCharityBalance();
  console.log(`  On-chain balance: ${balance.toFixed(6)} ETH`);
  console.log(`  Threshold: ${MIN_OFFRAMP_ETH} ETH`);

  if (balance < MIN_OFFRAMP_ETH) {
    console.log("  Below threshold — skipping");
    return;
  }

  console.log(`  Above threshold — ready for off-ramp`);

  // Check Kraken balance
  const krakenBal = await getKrakenBalance();
  console.log("  Kraken balances:", krakenBal);

  // TODO: Automate the full flow:
  // 1. Send ETH from charity wallet to Kraken deposit address (needs private key)
  // 2. Wait for deposit confirmation
  // 3. Sell ETH for GBP: sellForGBP(amount)
  // 4. Withdraw GBP to Refuge: withdrawGBP(amount, "refuge-bank")
  //
  // For now, show the manual steps:
  console.log("\n  Manual off-ramp steps:");
  console.log("  1. Run: npx ts-node scripts/offramp.ts --deposit");
  console.log("  2. Send ETH from charity wallet to the deposit address");
  console.log("  3. Wait for Kraken to credit the deposit (~12 confirmations)");
  console.log("  4. Sell ETH for GBP on Kraken (or run --sell)");
  console.log('  5. Withdraw GBP to Refuge bank (set up "refuge-bank" withdrawal in Kraken)');
}

main().catch(console.error);
