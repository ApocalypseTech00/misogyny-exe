# MISOGYNY.EXE

**Autonomous bot that turns online misogyny into art, then donates the money to women's charities.**

Every piece starts as something ugly. The bot finds it, frames it, mints it, sells it — and sends half the money to [Refuge](https://refuge.org.uk), a UK domestic abuse charity. The other half keeps the machine running and pays the artist.

You're not buying hate speech. You're buying its funeral.

---

## What This Is

An autonomous AI agent that runs 24/7 with zero human intervention:

1. Scrapes misogynistic quotes from Reddit (16 subreddits, 10 search queries)
2. Classifies them using Claude Haiku (genuine misogyny only — no satire, no feminist counter-speech)
3. Runs every quote through a 2-layer security guard before anything touches the chain
4. Generates typographic artwork from the quote
5. Uploads to IPFS (immutable, no tracking)
6. Mints an NFT on Base
7. Lists it for auction via Rare Protocol with enforced revenue splits
8. Repeats every 12 hours

No human approves or rejects quotes. No human picks the art. The bot decides everything.

---

## Architecture

```
Reddit API (16 subreddits + 10 search queries)
    |
    v
Scraper Bot — Claude Haiku extracts + scores quotes
    |
    v
+-- SECURITY GUARD (two layers) -------------------------+
|                                                         |
|  Layer 1: Content Sanitizer (regex)                     |
|    - URLs, emails, phone numbers, wallet addresses      |
|    - PII, HTML, code injection, control characters      |
|    - Social handles, ENS names                          |
|                                                         |
|  Layer 2: AI Verifier (separate Claude call)            |
|    - Genuine misogyny check (rejects satire, irony)     |
|    - Injection attack detection                         |
|    - Incitement/CSAM/legal safety filter                |
|    - Standalone quality gate                            |
|                                                         |
|  + Forced anonymous attribution (can't frame anyone)    |
|  + Score gate (>= 90 to mint)                           |
|  + Daily mint cap (circuit breaker)                     |
+---------------------------------------------------------+
    |
    v
SVG Template Generator — typographic artwork
    |
    v
IPFS Upload (Pinata / SuperRare) — artwork + metadata
    |
    v
Auto-Mint --> Base (ERC-721) or Rare Protocol (auctions)
    |
    v
Revenue Split (enforced on-chain):
    50%  Charity (Refuge UK)
    30%  Artist
    20%  Project operations
```

---

## The Redemption

When someone buys a piece, the NFT transforms.

The misogynistic quote disappears. In its place: a counter-quote — something affirming about women, chosen from a curated collection. The artwork regenerates. The metadata updates on-chain.

You don't collect misogyny. You destroy it. The purchase is the act of destruction.

The original quote still exists on IPFS (immutable), but the NFT no longer points to it. What was ugly becomes something else.

---

## Revenue Split

Enforced on-chain via `PaymentSplitter` (Base) and native auction splits (Rare Protocol). Not a promise — a smart contract.

| Recipient | Share | Purpose |
|-----------|-------|---------|
| **Refuge UK** | 50% | Domestic abuse charity — off-ramped to fiat |
| **Artist** | 30% | Pays for the art direction and templates |
| **Project** | 20% | Gas, API costs, infrastructure |

---

## Deployed Contracts

### Base Mainnet

| Contract | Address |
|----------|---------|
| PaymentSplitter | [`0xBBb62EC107fd3D49A47cc9AbB2A7C2DeD1D3C6B4`](https://basescan.org/address/0xBBb62EC107fd3D49A47cc9AbB2A7C2DeD1D3C6B4) |
| MisogynyNFT (ERC-721) | [`0x356Dd09E02960D59f1073F9d22A2634bbE3b1736`](https://basescan.org/address/0x356Dd09E02960D59f1073F9d22A2634bbE3b1736) |
| MisogynyMarketplace | [`0xaD60CFbD745CEBFaB39c47cf324e05088f366C1E`](https://basescan.org/address/0xaD60CFbD745CEBFaB39c47cf324e05088f366C1E) |

### Sepolia (Rare Protocol)

| Contract | Address |
|----------|---------|
| Collection | [`0x8C899038543CD10301bBd849918299F047D8a55d`](https://sepolia.etherscan.io/address/0x8C899038543CD10301bBd849918299F047D8a55d) |

---

## Security

This bot publishes content autonomously. If the guard fails, garbage goes on-chain forever. So the guard does not fail.

| Layer | Defense | What It Catches |
|-------|---------|-----------------|
| 1 | Hardened scraper prompt | XML delimiters around untrusted Reddit content, injection warnings |
| 2 | Content sanitizer (regex) | URLs, emails, PII, wallets, ENS, HTML, code, JSON, injection patterns, control chars |
| 3 | AI verifier (separate Claude call) | Fake quotes, manipulated context, feminist counter-speech, incitement, CSAM, injection bypasses |
| 4 | Forced anonymous attribution | Can't frame real people — all quotes attributed to "Anonymous" |
| 5 | Network allowlist | Blocks command injection via environment variables |
| 6 | Daily mint cap | Circuit breaker — max 12 mints/day regardless of queue size |
| 7 | IPFS-only image URLs | No tracking pixels, no malicious image loading |
| 8 | HMAC integrity | Queue items signed — rejects tampered entries before minting |
| 9 | SVG-to-PNG conversion | Strips script vectors from artwork before IPFS upload |

Score gate: quotes need >= 90/100 from Claude Haiku to auto-mint. Max 25 words. Fail-closed — if the AI verifier errors, the quote is rejected, not approved.

---

## How to Run

### Prerequisites

- Node.js 18+
- An Anthropic API key (Claude Haiku for classification)
- A Pinata account (IPFS uploads)
- A funded wallet on Base (for gas)

### Setup

```bash
git clone https://github.com/ApocalypseTech00/misogyny-exe.git
cd misogyny-exe
npm install
cp .env.example .env
# Fill in your .env values
npx hardhat compile
```

### Run the Agent

```bash
# Full autonomous agent (mainnet, runs every 12h)
npm run agent

# Testnet mode (Base Sepolia)
npm run agent:testnet

# Dry run — full pipeline, no minting
npm run agent:dry

# Single cycle then exit
npm run agent:once
```

### Run Individual Steps

```bash
npm run scrape              # Reddit scraper only
npm run scrape:stats        # Review scraped candidates
npm run mint:mainnet        # Manual mint from queue
npm run guard:test          # Run sanitizer tests
npm run guard:test:full     # Run sanitizer + AI verifier tests
npm run index:mainnet       # Index on-chain events
```

### Run Tests

```bash
npx hardhat test            # 56 contract tests
npm run guard:test          # Security guard tests
```

### Deploy Contracts

```bash
npx hardhat run scripts/deploy.ts --network base-sepolia   # Testnet
npx hardhat run scripts/deploy.ts --network base-mainnet   # Mainnet
```

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Smart Contracts** | Solidity 0.8.28, OpenZeppelin, Hardhat |
| **Chain** | Base (L2 on Ethereum) |
| **AI Classification** | Claude Haiku (Anthropic) |
| **AI Security** | Claude (separate verification call) |
| **IPFS** | Pinata |
| **Marketplace** | Custom on-chain marketplace + Rare Protocol (SuperRare) |
| **Artwork** | SVG templates, Sharp (image processing) |
| **Data Source** | Reddit API (OAuth2) |
| **Runtime** | TypeScript, ts-node |
| **Indexer** | Custom on-chain event watcher with RPC fallback |

---

## Project Structure

```
contracts/              Solidity smart contracts
  MisogynyNFT.sol         ERC-721 with transfer restrictions
  MisogynyMarketplace.sol Custom marketplace with enforced royalties
  MisogynyPaymentSplitter.sol  50/30/20 revenue split
  MisogynyCollection.sol  Collection contract
  MisogynyOpenEdition.sol  Open edition variant

scripts/                TypeScript pipeline
  scraper.ts              Reddit scraper (Claude Haiku extraction)
  quote-guard.ts          2-layer security guard (sanitizer + AI verifier)
  autonomous-agent.ts     Base pipeline agent (autonomous loop)
  rare-agent.ts           Rare Protocol agent (SuperRare auctions)
  rare-mint.ts            Rare Protocol mint + auction with splits
  auto-mint.ts            Auto-mint from queue
  generate-artwork.ts     SVG artwork generator
  indexer.ts              On-chain event indexer
  offramp.ts              Charity off-ramp (ETH -> fiat -> Refuge)
  post-to-socials.ts      Social media auto-post

test/                   Contract test suite (56 tests)
site/                   Landing page + marketplace UI
metadata/               NFT metadata templates
data/                   Scraper queue, dedup hashes, index
```

---

## Cost to Operate

| Item | Cost |
|------|------|
| Anthropic API (Claude Haiku) | ~$3/month (2 cycles/day) |
| Gas (Base L2) | ~$0.05 per mint+list |
| IPFS (Pinata) | Free tier sufficient |
| **Total** | **~$5/month** |

The bot is cheap to run. The art is free to make. The charity gets half of every sale. The economics are designed so this thing can run forever without anyone funding it — sales cover operating costs, and the surplus goes to Refuge.

---

## Hackathon

**EF Synthesis Hackathon** (March 13-22, 2026)
**Track:** SuperRare Partner Track ($2,500 bounty)
**Primary AI:** claude-opus-4-6
**Agent Harness:** claude-code

This project was built as part of the [Ethereum Foundation Synthesis Hackathon](https://www.ef-synthesis.com/), an experiment in human-AI collaboration. The conversation log documenting the full build process (decisions, pivots, breakthroughs, and the split between human and AI contributions) is available at [`docs/hackathon/CONVERSATION-LOG.md`](docs/hackathon/CONVERSATION-LOG.md).

---

## Why

The internet is full of men saying terrible things about women. Most of it goes unchallenged. It sits in comment sections and subreddits, normalized by upvotes and silence.

This bot finds those words, strips them of context, and reframes them as art objects — stark typographic pieces that force you to actually read what was said. Then it sells them, and the money goes to a charity that helps women escaping domestic abuse.

The quotes are real. The attribution is anonymous (the bot can't and won't identify who said them). The split is enforced by smart contract, not by trust.

If you buy one, the misogyny disappears from the NFT. You paid to destroy it. The money helps someone.

That's the whole thing.

---

## License

[MIT](LICENSE)

---

*Built by humans and AI. The humans had the idea. The AI wrote most of the code. The bot does the rest.*
