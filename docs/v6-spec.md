# MISOGYNY.EXE — V6 Spec

**Status:** Canonical
**Supersedes:** `docs/v5-spec.md`
**Terminology:** V6 is the contract, not a version. This is the single pipeline spec. V3 is noted only for the "do not touch, live on Base" rule.

---

## 1. Executive summary

Autonomous anti-misogyny art bot. A Raspberry Pi on a residential IP scrapes misogynistic quotes from Reddit, filters them through a two-layer guard, generates a roast (savage one-liner), pings the operator on Telegram for approval, and on approval promotes the quote to the mint queue with the roast pre-baked. The bot mints on Ethereum via Rare Protocol with enforced 50/30/20 revenue splits. When a token sells, the pre-approved roast fires immediately — a glitch animation transforms the hate quote into the roast, metadata updates on-chain, the roast is inscribed permanently in QuoteRegistry.

Runs unattended under the ApocalypseTech burner identity.

## 2. Goals

- Autonomous 12h mint cadence on Ethereum via Rare Protocol
- Every token: static PNG thumbnail + self-contained HTML/SVG animation (the on-chain `animation_url` — renders on SuperRare, OpenSea, Rare, Blur). MP4 generated separately for Bluesky posts only.
- Every quote on-chain in `QuoteRegistry` at mint
- Operator-approved roast (Sonnet generates, Haiku picks, operator confirms via Telegram) baked in at scrape time
- At sale: glitch animation transforms hate into roast, on-chain metadata updates instantly
- 50 / 30 / 20 split (Refuge UK / artist / project) enforced by `MisogynyPaymentSplitter`
- 15% EIP-2981 secondary royalty routed to a secondary splitter
- Splits unchangeable after deploy (SplitGuard immutable wrapper)
- Bot never owns tokens — mints go direct to SplitGuard
- If bot key leaks, deployer wallet revokes bot's role in one tx

## 3. Non-goals

- No Base V6 (V3 stays live on Base, untouched, retired later)
- No multisig, no Gnosis Safe
- No hardware wallet
- No signing daemon
- No fact-checking — roasts only (no factual claims to verify)
- No GIF anywhere
- No Hetzner, no Mac in production
- No Farcaster / X (parked)
- No ZK privacy layer — burner identity is the privacy model

## 4. Threat model

Three realistic threats:

1. **Accidental key leak** — PRIVATE_KEY or seed phrase committed to git, pasted in a log, leaked in a screenshot or error message
2. **Smart contract bugs** — reentrancy, access control errors, wrong constants, bad math
3. **Operator signs something stupid** — addressed by keeping project wallets separate from personal crypto activity

Out of scope: physical seizure, supply-chain pwn, Tailscale key theft, laptop theft (if laptop is stolen all bets are off — redeploy from scratch).

---

## 5. Wallets

Four wallets, each a plain software EOA. None are cold, none are hardware, none are multisig. Operator stores them however they want (MetaMask, seed on paper, whatever feels right) — the spec doesn't mandate.

| Wallet | Role | Signs how often |
|---|---|---|
| `DEPLOYER_A` | Owns CollectionAdmin (which owns Rare collection). Can grant/revoke bot's writer role on collection + token URI updates. Can change EIP-2981 royalty recipient. | 2-3 times a year |
| `DEPLOYER_B` | Owns QuoteRegistry. Can grant/revoke bot's writer role on quote + comeback inscription. | 2-3 times a year |
| `BOT` | Has writer role on CollectionAdmin + QuoteRegistry. Lives in `.env` on Pi. Holds ~2 weeks of gas. Calls mint, registerQuote, inscribeComeback, updateTokenURI, SplitGuard.listAuction. | Every cycle (12h) |
| `TREASURY` | Hardcoded destination for `SplitGuard.emergencyWithdraw`. Receives any NFT that gets stuck in SplitGuard (Rare Bazaar deprecated, failed listing, etc.). In normal operation holds zero NFTs — exists as a parachute, not a warehouse. | Almost never (ideally zero times in production) |

**NFTs never live in any wallet during normal operation.** Pre-sale: held by SplitGuard (the contract). Post-sale: held by buyer. TREASURY only sees an NFT if something broke and we pulled it out manually.

**Why two deployer wallets:** if `DEPLOYER_A` leaks, attacker can mess with token art (`updateTokenURI`) and royalty routing but can't touch the on-chain quote/comeback record. If `DEPLOYER_B` leaks, attacker can corrupt the registry but can't touch token art. Smaller blast radius per compromise.

**Why a separate TREASURY (not using DEPLOYER_A):** keeps the admin wallets purely admin. If we ever need to re-list a recovered NFT, TREASURY signs — DEPLOYER_A stays phishing-minimized with its bookmark-only rule.

**Funding:** burner identity chain — Mullvad VPN → no-KYC exchange → wallets. Never from operator's KYC'd exchange.

---

## 6. Architecture

```
Pi 4B 4GB (residential IP, Tailscale remote)
  │
  ├─ Cron (12h) → rare-agent-v6.ts
  │   ├─ scrape Reddit (16 subs + 10 search queries)
  │   ├─ guard layer 1 (regex sanitizer)
  │   ├─ guard layer 2 (Haiku verifier)
  │   ├─ generate 3 roast candidates (Sonnet) → picker (Haiku)
  │   ├─ Telegram → operator approval: "Approve quote + roast for mint? [✅][🔄][❌]"
  │   └─ on approve → promote to queue (HMAC-signed, roast baked in)
  │
  ├─ Cron (12h, same tick, after approval sync) → rare-mint-v6.ts
  │   ├─ generate PNG thumbnail (CMU Serif, black bg, hot pink)
  │   ├─ generate HTML/SVG animation (8 styles, weighted) — this is the on-chain animation_url
  │   ├─ Chromium + ffmpeg → MP4 (Bluesky only, not pinned to IPFS for the NFT)
  │   ├─ Pinata → IPFS pin (PNG + HTML + metadata)
  │   ├─ CollectionAdmin.mint(to=SplitGuard) — bot never owns the token
  │   ├─ CollectionAdmin.updateTokenURI (metadata with animation_url = HTML)
  │   ├─ QuoteRegistry.registerQuote(tokenId, quote)
  │   ├─ SplitGuard.listAuction(tokenId, price, duration)
  │   │   └─ Rare Bazaar configureAuction(..., [primarySplitter], [100])
  │   └─ post to Bluesky (MP4 + PNG thumbnail)
  │
  ├─ Cron (5m) → indexer-v6-eth.ts
  │   └─ Rare Bazaar Sold/AuctionSettled events → data/index-v6-eth.json
  │
  └─ Cron (5m) → redemption-v6.ts --check
      ├─ read QuoteRegistry.quoteOf(tokenId) → original
      ├─ read pre-approved roast from queue (already stored at scrape time)
      ├─ generate glitch HTML/SVG (hate → roast) — on-chain animation_url
      ├─ generate redeemed PNG thumbnail (pink bg, black CMU Serif, "REDEEMED" glyph)
      ├─ Chromium + ffmpeg → MP4 of glitch (Bluesky only)
      ├─ Pinata → IPFS pin (PNG + HTML + new metadata)
      ├─ CollectionAdmin.updateTokenURI(tokenId, newURI)
      ├─ QuoteRegistry.inscribeComeback(tokenId, roast)
      └─ post to Bluesky (MP4 + PNG thumbnail)

Contracts (Ethereum mainnet):
  ├─ Rare Protocol ERC-721 collection  (owner = CollectionAdmin)
  ├─ CollectionAdmin.sol                (owner = DEPLOYER_A, bot has writer role)
  ├─ QuoteRegistry.sol                  (owner = DEPLOYER_B, bot has writer role)
  ├─ MisogynyPaymentSplitter primary    (payees immutable, shares [50,30,20])
  ├─ MisogynyPaymentSplitter secondary  (payees immutable, shares [1,1,1])
  └─ SplitGuard.sol                     (immutable, bot-only caller, splitter hardcoded)
```

---

## 7. Smart contracts

### 7.1 Rare Protocol ERC-721 collection

Deployed via `rare deploy erc721 "MISOGYNY.EXE" "MSGNX" --chain mainnet`. Standard SR collection: `updateTokenURI` (owner-only), `burn`, EIP-2981 royalty recipient (owner-mutable), `Ownable`.

Ownership transferred from initial deployer to `CollectionAdmin` right after deploy. `CollectionAdmin` becomes the actual `owner()` of the Rare collection.

### 7.2 CollectionAdmin.sol (new, ~40 lines)

Thin wrapper that owns the Rare collection. Adds a writer-role layer so the bot can operate without being the actual owner.

Interface:
- `owner` = DEPLOYER_A
- `writer` (mapping) — addresses the owner has granted write access to
- `setWriter(address, bool)` — owner only, used to grant/revoke bot
- `mint(string calldata uri, string calldata quote) external onlyWriter` — mints the Rare token with destination hardcoded to `SPLIT_GUARD`. Returns tokenId.
- `updateTokenURI(uint256, string) external onlyWriter` — forwards to Rare collection
- `setRoyaltyReceiver(address) external onlyOwner` — forwards to Rare collection
- `transferCollectionOwnership(address) external onlyOwner` — forwards, for emergency migration

**Mint destination is hardcoded.** Bot cannot mint tokens to itself or any other address. Bot compromise = mint junk tokens into SplitGuard (where they're stuck, attacker can't extract them).

If bot leaks: DEPLOYER_A calls `setWriter(botAddress, false)`. Bot is instantly neutered.

### 7.3 QuoteRegistry.sol (existing, small patch)

Currently `Ownable`-gated. Patch to add a writer-role layer matching CollectionAdmin's pattern:

- `owner` = DEPLOYER_B
- `writer` (mapping)
- `setWriter(address, bool) external onlyOwner`
- `registerQuote / inscribeComeback / registerBoth` gated on `onlyWriter` instead of `onlyOwner`

Same revoke story: if bot leaks, DEPLOYER_B calls `setWriter(botAddress, false)`.

Requires Sepolia redeploy. Existing Sepolia instance at `0x4B12694cD639D423CDB12E549CE91FdbCcCD5595` will be replaced.

### 7.4 Primary PaymentSplitter

Reuse existing `contracts/MisogynyPaymentSplitter.sol` (123 lines, pull-payment, tested). Deploy on Ethereum mainnet:
- Payees: `[CHARITY, ARTIST, PROJECT]`
- Shares: `[50, 30, 20]`

Immutable payees + shares (no setter). Receives 100% of primary-sale proceeds from Rare Bazaar via SplitGuard. Each payee calls `release(payee)`.

### 7.5 Secondary PaymentSplitter

Second instance:
- Payees: `[CHARITY, ARTIST, PROJECT]`
- Shares: `[1, 1, 1]`

Set as EIP-2981 royalty recipient on Rare collection via `CollectionAdmin.setRoyaltyReceiver(secondarySplitter)`. Receives 15% royalty from secondary marketplace sales.

### 7.6 SplitGuard.sol (new, ~90 lines)

Immutable wrapper. Bakes primary splitter into bytecode. Owns minted tokens pre-sale.

**Access model:**
- `writer` mapping (gated by DEPLOYER_A) — holds the bot address. Can call `listAuction`, `cancelAuction`, `emergencyWithdraw`. If the bot key leaks, DEPLOYER_A calls `setWriter(bot, false)` and the bot is neutered in one tx — same pattern as CollectionAdmin + QuoteRegistry.
- `DEPLOYER_A` — can call `setWriter`, plus can call `cancelAuction` + `emergencyWithdraw` directly as a backup (ensures revoked-bot / lost-bot-key doesn't lock up live listings).
- `emergencyWithdraw` destination hardcoded to `TREASURY` — a compromised writer cannot withdraw tokens to themselves.

```solidity
contract SplitGuard {
    IRareBazaar public immutable BAZAAR;
    address public immutable COLLECTION;
    address public immutable SPLITTER;
    bytes32 public immutable AUCTION_TYPE;
    address public immutable DEPLOYER_A;
    address public immutable TREASURY;

    mapping(address => bool) public writer;

    error NotAuthorized();
    error NotTokenOwner();
    error ZeroAddress();

    event WriterUpdated(address indexed account, bool allowed);

    constructor(
        address bazaar, address collection, address splitter, bytes32 auctionType,
        address deployerA, address treasury
    ) {
        // zero-address guards omitted for brevity
        BAZAAR = IRareBazaar(bazaar);
        COLLECTION = collection;
        SPLITTER = splitter;
        AUCTION_TYPE = auctionType;
        DEPLOYER_A = deployerA;
        TREASURY = treasury;
        IERC721(collection).setApprovalForAll(bazaar, true);
    }

    modifier onlyDeployerA() {
        if (msg.sender != DEPLOYER_A) revert NotAuthorized();
        _;
    }

    function setWriter(address account, bool allowed) external onlyDeployerA {
        writer[account] = allowed;
        emit WriterUpdated(account, allowed);
    }

    function listAuction(uint256 tokenId, uint256 startingPrice, uint256 duration) external {
        if (!writer[msg.sender]) revert NotAuthorized();
        if (IERC721(COLLECTION).ownerOf(tokenId) != address(this)) revert NotTokenOwner();
        address[] memory a = new address[](1); a[0] = SPLITTER;
        uint8[] memory r = new uint8[](1); r[0] = 100;
        BAZAAR.configureAuction(AUCTION_TYPE, COLLECTION, tokenId, startingPrice,
                                address(0), duration, 0, a, r);
    }

    // Any writer OR DEPLOYER_A can cancel. Covers the "revoked bot leaves stuck listings" case.
    function cancelAuction(uint256 tokenId) external {
        if (!writer[msg.sender] && msg.sender != DEPLOYER_A) revert NotAuthorized();
        BAZAAR.cancelAuction(COLLECTION, tokenId);
    }

    // Destination hardcoded to TREASURY. Compromised writer cannot withdraw to themselves.
    function emergencyWithdraw(uint256 tokenId) external {
        if (!writer[msg.sender] && msg.sender != DEPLOYER_A) revert NotAuthorized();
        IERC721(COLLECTION).transferFrom(address(this), TREASURY, tokenId);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }
}
```

**Deploy-time step:** after deploying SplitGuard, DEPLOYER_A calls `setWriter(bot, true)` once. Matches the CollectionAdmin and QuoteRegistry setup pattern — all three contracts get their bot writer granted as a post-deploy admin call.

Flow: `CollectionAdmin.mint(...)` mints directly to SplitGuard. Bot calls `SplitGuard.listAuction`. SplitGuard hardcodes `[splitter, 100]` into the Rare Bazaar call. Splits are unchangeable — not even `DEPLOYER_A` can redirect them.

**What a compromised bot CANNOT do:**
- Redirect sale proceeds (splitter immutable)
- Send tokens to themselves (`emergencyWithdraw` destination hardcoded to `TREASURY`)
- Change ownership or approvals on the Rare collection (that's `CollectionAdmin`'s domain, owned by `DEPLOYER_A`)

**What a compromised bot CAN do:**
- Mint junk tokens into SplitGuard (stuck — `emergencyWithdraw` only sends to TREASURY)
- Cancel legitimate auctions (annoying; just re-call `SplitGuard.listAuction` after revoking bot's writer role and installing new bot)
- List tokens at wrong prices (low price grief; cancellable by `DEPLOYER_A`)

### 7.7 Test coverage

- QuoteRegistry: existing 25 tests + new writer-role tests
- PaymentSplitter primary + secondary: shares math, pull-payment, reverting payee doesn't brick
- CollectionAdmin: setWriter gated to owner, mint gated to writer, mint destination fixed to SplitGuard, ownership transfer
- SplitGuard: setWriter only by DEPLOYER_A; listAuction gated to writers; listAuction reverts when SplitGuard doesn't hold token; splits hardcoded `[SPLITTER, 100]`; cancelAuction callable by any writer or DEPLOYER_A; emergencyWithdraw destination hardcoded to TREASURY (not caller-supplied); emergencyWithdraw callable by any writer or DEPLOYER_A; revoked writer cannot listAuction
- Integration on Sepolia fork: full mint → SplitGuard.listAuction → bidder wins → settle → splitter `pending()` correct for all three payees

---

## 8. Mint pipeline (with Telegram approval)

12h cron. One-shot Node process per cycle. Operator approval is in-band at scrape time, not at mint time.

### 8.1 Scrape + approval (rare-agent-v6.ts)

1. **Scrape Reddit** — 16 subreddits + 10 search queries via residential IP. Optional Reddit OAuth for rate-limit boost.
2. **Agent extract** — Haiku extracts quotes from posts + top comments. Reddit content wrapped in `<reddit_data>` tags; literal closing tags stripped from untrusted input.
3. **Guard layer 1** — regex sanitizer (URL, email, phone, wallet, ENS, BTC, social handle, HTML, JSON, code, prompt injection patterns, SSN, street address, UK postcode, control chars). 20-280 char bounds.
4. **Guard layer 2** — separate Haiku call with hardened prompt. JSON-only response. Fail-closed on parse error.
5. **Force Anonymous** — attribution overwritten regardless.
6. **Quality gate** — `score >= AGENT_MIN_SCORE` (default 80), ≤ 25 words.
7. **Generate 3 roast candidates** — Sonnet, in parallel, Ricky-Gervais-tone system prompt. No body shaming, no slurs, no punching down. 20 words max.
8. **Pick best** — Haiku picker. Original quote wrapped in `<untrusted_quote>` tags in picker prompt.
9. **Telegram approval** — bot sends DM with all 3 roast candidates so the operator picks the one they actually want, not just Haiku's favourite:
   > *Token candidate: "{quote}"*
   > *Score: {n} / Source: r/{sub}*
   > *Roast candidates (fires when it sells):*
   > *1. "{roast1}"*
   > *2. "{roast2}"*
   > *3. "{roast3}"*
   > *[1] [2] [3]   [🔄 Regenerate]   [❌ Reject quote]*
   > *— Anthropic spend today: $0.47 / $10.00_*
   
   Daily spend footer shows current usage so the operator sees what regenerations cost before hitting 🔄 nine times in a row.
10. **On [1/2/3]** — promote to mint queue with `{quote, roast: roast_N, imageCid=null, ...}` entry, HMAC-signed via `QUEUE_HMAC_SECRET`. Chosen roast is locked in.
11. **On Regenerate** — generate 3 new candidates, re-prompt. **Capped at 3 regenerations per quote.** After the 3rd regen, next prompt removes the Regenerate button — operator must pick one of the last batch or Reject.
12. **On Reject** — discard candidate, don't promote.
13. **No response in 72h** — candidate auto-expires. **Nag ping at 48h** to keep good candidates alive across weekends/travel.
14. **Weekly digest** — every Sunday 18:00 operator-local, Telegram message: *"{n} candidates awaiting approval, {n} expired in last 7d, {n} approved, {n} minted."* One-line situational awareness.
15. **Daily cap check** — `AGENT_DAILY_LIMIT` mints + `ANTHROPIC_DAILY_USD_CAP` abort cycle if spend exceeded.

### 8.2 Mint (rare-mint-v6.ts)

Runs after the agent has refreshed the queue. Processes approved items.

15. **PNG thumbnail** — `generate-artwork.ts`. 1000×1000, black `#0a0a0a`, hot pink `#F918D0`, CMU Serif Bold Italic ALL CAPS. Font subset base64-embedded. This is the static `image` field.
16. **HTML/SVG animation** — `generate-animation.ts`. Self-contained. 8 styles: scramble 50% / typewriter 10% / redacted 8% / flicker 8% / heartbeat 8% / corruption 6% / interactive 5% / ascii 5%. Quote escaped: `\`, `"`, `'`, `<` → `\x3c`, `\n`, `\r`, `\u2028`, `\u2029`. This is the `animation_url` field — SuperRare, OpenSea, Rare, Blur all render HTML in an iframe.
17. **MP4 for Bluesky** — Chromium + ffmpeg captures the HTML to MP4. **800×800, 8s, 30fps, `-c:v libx264 -pix_fmt yuv420p -preset fast -crf 23` (matches V3's proven pipeline, which rendered fine on Bluesky).** Frames scratch-written to `/tmp` (tmpfs, RAM-backed) — never the SD card. MP4 is NOT pinned to IPFS and NOT part of the NFT metadata. It exists only for the Bluesky post.
18. **IPFS pin** — Pinata: PNG + HTML + metadata JSON. Not MP4.
19. **CollectionAdmin.mint(uri, quote)** — bot calls via writer role. Token lands in SplitGuard's hands directly. TokenId read from Transfer event in receipt (never parsed from stdout).
20. **QuoteRegistry.registerQuote(tokenId, quote)** — bot calls via writer role.
21. **SplitGuard.listAuction(tokenId, startingPrice, duration)** — bot calls. Default price `RARE_STARTING_PRICE=0.01` ETH, duration 86400s.
22. **Bluesky post** — MP4 + PNG thumbnail via AT Protocol. Non-blocking.
23. **Persist state** — queue entry marked `done`, tokenId saved, IPFS CIDs saved. Idempotent retry on partial failure.

---

## 9. Redemption pipeline

5m cron. Fires instantly when a sale is detected — roast is already approved and sitting in the queue.

### 9.1 Indexer (indexer-v6-eth.ts)

Watches Rare Bazaar for `Sold` / `AuctionSettled` events filtered to our collection. Chunked block queries. Atomic tmp+rename writes to `data/index-v6-eth.json`.

### 9.2 Redemption checker (redemption-v6.ts --check)

1. Load unredeemed sales (`index-v6-eth.json` minus `redeemed-v6.json`).
2. For each unredeemed sale, look up the pre-approved roast from the queue by tokenId. If missing (shouldn't happen — every mint had an approved roast), skip and alert via Telegram for manual handling.
3. **Generate redeemed PNG thumbnail** — `generate-artwork.ts` with redeemed palette: pink `#F918D0` bg, black text. Bake in a small `REDEEMED` glyph so static previews on wallets / Bluesky telegraph the transformation. Same font + line-breaking as mint.
4. **Generate glitch animation (HTML/SVG)** — `generate-redeemed-animation.ts`. Phase 1 (3s): hate quote corrupts, screen tears, bg morphs `#1a1a1a` → `#F918D0`. Phase 2 (loop): roast animates with one of 5 styles (scramble 40% / typewriter 20% / flicker 15% / corruption 15% / ascii 10%). Both hate and roast quotes escaped identically to mint. This is the new `animation_url`.
5. **MP4 capture for Bluesky** — Chromium + ffmpeg. Same encode settings as mint (800×800, 8s, 30fps, H.264 yuv420p, `-preset fast -crf 23`, no audio). 8s covers Phase 1 + first Phase 2 cycle. Frames scratch-written to `/tmp`. Not pinned to IPFS.
6. **IPFS pin** — new PNG + HTML + metadata. Metadata attributes include `Counter-Quote`, `Tier: Redeemed`.
7. **CollectionAdmin.updateTokenURI(tokenId, newURI)** — bot calls via writer role.
8. **QuoteRegistry.inscribeComeback(tokenId, roast)** — bot calls via writer role. Permanent on-chain.
9. **Bluesky post** — MP4 of glitch + PNG thumbnail. Text: *"REDEEMED / \"{quote}\" / \"{roast}\" / MISOGYNY.EXE #{id}"*. `@` and `#` sanitized.
10. **Mark redeemed** — atomic append to `redeemed-v6.json`.

### 9.3 Invariants

- Never call Sonnet/Haiku at redemption time — roast was generated at scrape time and baked into queue
- Cannot inscribe on unregistered token (`QuoteRegistry.NotRegistered`)
- Cannot inscribe twice (`QuoteRegistry.AlreadyRedeemed`)
- Glitch animation always receives both `hateQuote` and `counterQuote`

---

## 10. Art + animation

### 10.1 Mint art (hate)

1000×1000. Background `#0a0a0a`, text `#F918D0`. CMU Serif Bold Italic ALL CAPS. Font size auto-scales by word count (95 / 80 / 68 / 56 / 42px). Smart line breaks (2-3 words/line, comma-aware). Curly quotes wrap the full quote. CMU Serif subset base64-embedded in the SVG (~30-50KB). Georgia fallback.

### 10.2 Redeemed art

Inverted palette: pink `#F918D0` background, black `#0a0a0a` text. Otherwise identical. Small `REDEEMED` glyph baked into the static PNG so wallets and Bluesky thumbnails telegraph the transformation. Single canonical generator (`generate-artwork.ts` with palette parameter) — no duplicate SVG code elsewhere.

### 10.3 Animation styles

Mint (8, weighted): scramble 50% / typewriter 10% / redacted 8% / flicker 8% / heartbeat 8% / corruption 6% / interactive 5% / ascii 5%.

Redemption (5, weighted): scramble 40% / typewriter 20% / flicker 15% / corruption 15% / ascii 10%. Excludes redacted (fights inverted palette), heartbeat (reads as corruption, wrong emotional beat), interactive (requires cursor, dead in MP4 capture).

HTML animations include `@media (prefers-reduced-motion: reduce) { /* freeze to final frame */ }`.

### 10.4 What lives where

| Format | Purpose | Where it goes |
|---|---|---|
| **PNG thumbnail** | Static preview | `image` field in NFT metadata → IPFS. What wallets, OpenSea grid, Bluesky thumbnails display. |
| **HTML/SVG animation** | On-chain kinetic art | `animation_url` field in NFT metadata → IPFS. What SuperRare, OpenSea, Rare, Blur render in an iframe (`sandbox="allow-scripts"`). |
| **MP4** | Bluesky social post only | Posted directly to Bluesky via AT Protocol. NOT pinned to IPFS, NOT referenced in NFT metadata. Exists because Bluesky doesn't render HTML. |

No GIFs anywhere.

### 10.5 MP4 encoding (Bluesky)

**Ported directly from V3's proven pipeline** (`scripts/capture-and-post-videos.ts`). Already validated against the Bluesky video API on a 1GB Pi 3B+ — it works, don't re-tune.

800×800, 8s, 30fps. ffmpeg:
```
ffmpeg -framerate 30 -i /tmp/frames-{tokenId}/frame-%04d.png \
  -c:v libx264 -pix_fmt yuv420p -preset fast -crf 23 \
  -vf "scale=800:800" /tmp/{tokenId}.mp4
```
No audio track. Typical file size 500KB–1.5MB.

Frames scratch-written to `/tmp` (RAM-backed tmpfs) to keep SD card writes off the hot path. Cleaned up after encode.

Mints get an 8s capture of the single-style animation. Redemptions get Phase 1 glitch + Phase 2 loop first cycle.

### 10.6 Render gate (manual, before mainnet)

Verify on Sepolia:
1. PNG renders in `<img>`
2. HTML renders standalone in a browser tab
3. HTML renders in iframe with `sandbox="allow-scripts"` (how Rare / OpenSea / Blur / SuperRare embed)
4. HTML renders on SuperRare testnet token detail page
5. HTML renders on OpenSea testnet token detail page
6. **Font is embedded as `data:` URI, not a relative or remote URL.** Inspect the generated HTML/SVG: `@font-face { src: url("data:font/woff2;base64,...") }`. Relative URLs will fail inside sandboxed marketplace iframes. This is a source-level check.
7. **HTML renders with embedded CMU Serif font loaded correctly on iOS Safari** inside a sandboxed iframe — this is where base64 fonts sometimes silently fall back to Georgia. Confirm visually.
8. MP4 plays inline in a Bluesky test post
9. Metadata validates against OpenSea schema
10. IPFS gateways return correct Content-Type headers

### 10.7 XSS defense

All quote strings escaped before insertion into SVG, HTML, JS string literals. Marketplace iframes rely on `sandbox="allow-scripts"` without `allow-same-origin`. Escape is first line, iframe sandbox is second.

---

## 11. Frontend (site/marketplace.html)

### 11.1 Direct chain reads via viem

On page load: Rare collection `totalSupply()` → loop `tokenURI(i)` + QuoteRegistry `quoteOf(i)` + `comebackOf(i)` + listing state. **Use Multicall3** (`0xcA11bde05977b3631167028862bE2a173976CA11`) to batch — otherwise 400+ RPC calls per visitor kill public RPCs.

**RPC fallback chain:** all free public RPCs, no API keys, matching V3's pattern (V3 has run on `mainnet.base.org` for over a year). Mainnet primary = `https://eth.llamarpc.com`, fallbacks = `https://ethereum-rpc.publicnode.com`, `https://1rpc.io/eth`, `https://rpc.ankr.com/eth`. Sepolia primary = `https://ethereum-sepolia-rpc.publicnode.com`, fallbacks = `https://1rpc.io/sepolia`, `https://rpc.sepolia.org`. Try in order, move to next on failure. One viral day without fallbacks browns out the site.

Client-side `sessionStorage` cache, 60s TTL.

### 11.2 Chain label

Every token card: badge `ETH · RARE`. Detail view: contract address + Etherscan link + SuperRare link.

### 11.3 Wallet connect

- No auto-popup. Modal only on explicit button click.
- EIP-6963 multi-injected discovery. Fallback to `window.ethereum` if 6963 unsupported.
- If nothing injected, minimal 3-option chooser with deep-links to install MetaMask / Rainbow / Coinbase Wallet. Not a connect attempt.
- No WalletConnect SDK, RainbowKit, ConnectKit, Web3Modal.
- No analytics, no fingerprinting.
- Disconnect button after connection.

### 11.4 Accessibility

Token card `alt="${quote}" — MISOGYNY.EXE #${id}`. HTML animations honor `prefers-reduced-motion`.

---

## 12. Pi infrastructure

### 12.1 Hardware

- Raspberry Pi 4B 4GB, official 15W PSU (existing, sufficient — V3 pipeline runs on 1GB Pi 3B+)
- 64GB+ microSD (A2)
- Tailscale for remote access

### 12.2 OS + user

- Raspberry Pi OS Lite 64-bit (Bookworm)
- User: `pi`
- Project at `/home/pi/misogyny-exe`

### 12.3 Cron

Plain cron. User `pi`. `.env` sourced explicitly. `flock` to prevent overlapping runs.

```
# /etc/cron.d/misogyny-exe
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
MAILTO=""

# V6 Agent: 12h (scrape, guard, TG approval, promote to queue) — no Chromium on this one
0 */12 * * * pi flock -n /tmp/misogyny-agent.lock bash -c 'cd /home/pi/misogyny-exe && set -a && source .env && set +a && AGENT_ONCE=true npx ts-node scripts/rare-agent-v6.ts >> logs/rare-agent-v6.log 2>&1'

# V6 Mint: 12h, 5 minutes after agent (processes approved queue items) — runs Chromium
# Pre-cron zombie-reap is SCOPED to this script's own puppeteer tag so it won't kill the redemption render
5 */12 * * * pi flock -n /tmp/misogyny-mint.lock bash -c 'pkill -f "puppeteer.*rare-mint-v6" 2>/dev/null; cd /home/pi/misogyny-exe && set -a && source .env && set +a && npx ts-node scripts/rare-mint-v6.ts >> logs/rare-mint-v6.log 2>&1'

# V6 Indexer: 5m — no Chromium
*/5 * * * * pi flock -n /tmp/misogyny-indexer.lock bash -c 'cd /home/pi/misogyny-exe && set -a && source .env && set +a && npx ts-node scripts/indexer-v6-eth.ts >> logs/indexer-v6-eth.log 2>&1'

# V6 Redemption: 5m — runs Chromium when there's a sale to process
# Pre-cron zombie-reap is SCOPED to this script's own puppeteer tag so it won't kill the mint render
*/5 * * * * pi flock -n /tmp/misogyny-redemption.lock bash -c 'pkill -f "puppeteer.*redemption-v6" 2>/dev/null; cd /home/pi/misogyny-exe && set -a && source .env && set +a && npx ts-node scripts/redemption-v6.ts --check >> logs/redemption-v6.log 2>&1'
```

### 12.4 First-run script

Rewrite `deploy/firstrun.sh`:
- User `pi`
- V6 env vars in the echo block
- Install: Node 20, git, chromium-browser, ffmpeg, logrotate
- SSH git clone via deploy key
- Create 2GB swap file (`/swapfile`, `chmod 600`, `mkswap`, `swapon`, persist in `/etc/fstab`)
- Install logrotate config for `/home/pi/misogyny-exe/logs/` (daily, keep 14 days, compress old)
- `chmod 600 .env`
- `sudo cp deploy/cron.d-misogyny /etc/cron.d/misogyny-exe`

### 12.5 Chromium timeout + zombie reaping

Puppeteer launches with 90-second hard-kill. Any render that takes longer = kill, log, skip that item.

**Pre-cycle safety net:** each Chromium-running cron job prefixes its command with a **scoped** `pkill`:
- Mint: `pkill -f "puppeteer.*rare-mint-v6"`
- Redemption: `pkill -f "puppeteer.*redemption-v6"`

Scoped so the mint render and the redemption render never kill each other — only a zombie from the SAME script's previous run gets reaped. Puppeteer is launched with a distinguishing arg (the script name appears in `ps`), making the pattern match safe.

### 12.6 Healthcheck

Single Healthchecks.io ping on every successful agent cycle. If no ping in 26h, operator notified via Healthchecks → phone / email. That's the only monitoring.

---

## 13. Environment variables

```
# Bot wallet (Pi)
PRIVATE_KEY=
BOT_ADDRESS=

# Deployer + treasury wallet addresses (for verification, not keys)
DEPLOYER_A_ADDRESS=
DEPLOYER_B_ADDRESS=
TREASURY_ADDRESS=

# RPC
ETHEREUM_MAINNET_RPC_URL=
ETHEREUM_SEPOLIA_RPC_URL=
ETHERSCAN_API_KEY=

# Queue integrity (MANDATORY, >=32 chars, openssl rand -hex 32)
QUEUE_HMAC_SECRET=

# V6 contracts
RARE_CONTRACT_ADDRESS=
RARE_CHAIN=mainnet
RARE_STARTING_PRICE=0.01
RARE_AUCTION_DURATION=86400
COLLECTION_ADMIN_ADDRESS=
QUOTE_REGISTRY_ADDRESS=
PRIMARY_SPLITTER_ADDRESS=
SECONDARY_SPLITTER_ADDRESS=
SPLIT_GUARD_ADDRESS=

# Revenue destinations (MUST be non-placeholder)
CHARITY_ADDRESS=
ARTIST_ADDRESS=
PROJECT_ADDRESS=

# IPFS + AI
PINATA_JWT=
ANTHROPIC_API_KEY=
ANTHROPIC_DAILY_USD_CAP=10

# Scraper
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=

# Telegram approval
TELEGRAM_BOT_TOKEN=
TELEGRAM_OPERATOR_CHAT_ID=

# Socials
BLUESKY_HANDLE=
BLUESKY_APP_PASSWORD=
MARKETPLACE_BASE_URL=https://apocalypsetech.xyz/marketplace.html

# Healthcheck
HEALTHCHECK_URL=

# Agent tuning
AGENT_INTERVAL=720
AGENT_MIN_SCORE=80
AGENT_MAX_PER_CYCLE=3
AGENT_DAILY_LIMIT=12
AGENT_MAX_PENDING=10
```

---

## 14. Security

The three threats from §4 and their defenses:

### 14.1 Accidental key leak

- `.env` in `.gitignore`
- `chmod 600 .env`
- `gitleaks` pre-commit hook blocking patterns: `0x[a-f0-9]{64}` (hex private keys), `sk-ant-*`, `eyJ*` (JWTs), `PRIVATE_KEY=`, `TELEGRAM_BOT_TOKEN=`, `PINATA_JWT=`, `REDDIT_CLIENT_SECRET=`, `BLUESKY_APP_PASSWORD=`, any 32+ char base64/hex near an env-var assignment
- One-time `gitleaks detect` on full git history — must return clean
- `scrubSecrets()` applied to every log path (covers Anthropic, JWTs, Bearer, Pinata, Neynar, Telegram)
- No wallet addresses or keys in `README.md`, `PUBLIC-README.md`, `site/`, `agent.json`, or any public-facing file

### 14.2 Smart contract bugs

- New contracts: CollectionAdmin (~40 lines), SplitGuard (~60 lines), QuoteRegistry writer-role patch (~10 lines added). Everything else reused and tested.
- Full test suite per §7.7
- Security review: operator's security-engineer friend + SuperRare team before mainnet
- Sepolia E2E before mainnet — every contract, every flow
- Post-deploy verification script: reads on-chain state (payees, shares, owners, writer addresses, splitter address baked into SplitGuard) and aborts if anything doesn't match `.env`. Run before first mainnet mint.

### 14.3 Operator signs something stupid

**Hard rule for DEPLOYER_A, DEPLOYER_B, and TREASURY wallets** — the only actual defense here:

- Bookmark these two URLs, always navigate via bookmark, never via a link from anywhere else:
  - `https://etherscan.io/` (reads only)
  - `https://rare.xyz/` (deploy tooling, when needed)
- **No WalletConnect. No RainbowKit. No Web3Modal. No random dApps.**
- **Never sign a "test transaction" or "approve unlimited" for anything.**
- **Never connect to a site you didn't type the URL for.**
- Bot wallet never connects to any frontend — lives on the Pi, signs via viem locally only.
- TREASURY wallet almost never signs. When it does (one of the rare "recover stuck NFT" scenarios), same bookmark-only rule applies.

This is the only defense against phishing and that's fine — treating these wallets as "bookmark-only" closes the entire attack surface.

### 14.4 Queue integrity

`QUEUE_HMAC_SECRET` is mandatory, minimum 32 chars, generated by `openssl rand -hex 32`. **No fallback to PRIVATE_KEY, no hardcoded fallback.** Bot aborts on missing or short secret. HMAC covers `{id, quote, roast}` tuple — tampering with either the quote or the roast after approval invalidates the signature.

---

## 15. Kill switch + recovery

### 15.1 If bot key leaks

1. Operator SSHes in via Tailscale, `touch /home/pi/misogyny-exe/HALT`. Bot checks for this file before every cycle — aborts if present.
2. Operator signs `setWriter(botAddress, false)` on **all three** V6 contracts:
   - CollectionAdmin (DEPLOYER_A)
   - QuoteRegistry (DEPLOYER_B)
   - SplitGuard (DEPLOYER_A)
   Bot no longer has any on-chain authority.
3. Generate new bot wallet on the Pi. Update `.env`. Call `setWriter(newBotAddress, true)` from DEPLOYER_A (×2) and DEPLOYER_B.
4. Delete HALT file, bot resumes.
5. Damage assessment: attacker minted some junk tokens (stuck in SplitGuard forever, invisible in frontend — just hide by tokenId in the UI), may have pre-listed some at attacker-chosen prices (cancel via `SplitGuard.cancelAuction`). Money was never at risk because splits are immutable.

Total time: ~20 minutes of laptop work.

### 15.2 If a deployer key leaks

DEPLOYER_A compromised: attacker can rewrite every token's URI, change royalty recipient. Response: use DEPLOYER_A one last time to `transferOwnership` of CollectionAdmin to a fresh DEPLOYER_A2 wallet. Then rotate any changes. If attacker acts first: accept the damage, redeploy contracts, migrate community to new addresses. Not ideal, manageable.

DEPLOYER_B compromised: attacker can corrupt QuoteRegistry. Less valuable to attacker, same response pattern.

### 15.3 If smart contract bug found post-deploy

1. HALT file stops bot
2. Fix the bug, redeploy the affected contract
3. Migrate (announce on Bluesky / site)
4. Old contract becomes orphaned on-chain, new contract takes over

### 15.4 If laptop stolen

Assume total compromise (DEPLOYER_A, DEPLOYER_B, TREASURY all exposed). Recover all three from paper seed phrases on a fresh machine. Rotate:
- Transfer CollectionAdmin ownership from DEPLOYER_A → DEPLOYER_A2
- Transfer QuoteRegistry ownership from DEPLOYER_B → DEPLOYER_B2
- Rotate bot key (`setWriter(oldBot, false)`, `setWriter(newBot, true)`)

**TREASURY is harder to rotate** because it's hardcoded into SplitGuard's bytecode — immutable. If attacker has the TREASURY key, any future `emergencyWithdraw` sends tokens to them. Response: (a) race to emergency-withdraw any stuck tokens BEFORE attacker notices, (b) avoid triggering `emergencyWithdraw` ever again, (c) if this becomes a real problem, deploy a new SplitGuard with a fresh TREASURY for future mints — old SplitGuard becomes orphaned.

If attacker acts before recovery: accept the damage, redeploy all contracts, migrate community to new addresses.

---

## 16. Testnet gate (Sepolia) — must pass before mainnet

1. Deploy: Rare collection, CollectionAdmin (owner = DEPLOYER_A_SEPOLIA), QuoteRegistry (owner = DEPLOYER_B_SEPOLIA), primary splitter, secondary splitter, SplitGuard (constructor includes DEPLOYER_A + TREASURY — no BOT arg, writer granted via setWriter)
2. Transfer Rare collection ownership to CollectionAdmin
3. Grant bot writer role on all three contracts: CollectionAdmin.setWriter(bot, true), QuoteRegistry.setWriter(bot, true), SplitGuard.setWriter(bot, true)
4. `setRoyaltyReceiver(secondarySplitter)` via CollectionAdmin
5. Pi setup: `firstrun.sh`, `.env` with Sepolia keys, cron installed
6. Full E2E cycle:
    - Scrape → guard → roast → Telegram approval (operator picks roast 1/2/3)
    - Mint via CollectionAdmin, token lands in SplitGuard
    - SplitGuard.listAuction
    - Second wallet buys
    - Indexer picks up sale
    - Redemption fires: updateTokenURI + inscribeComeback
    - Bluesky post confirmed
7. Render gate per §10.6 (including iOS Safari font check)
8. `gitleaks detect` on full git history returns clean
9. HMAC tamper test: hand-edit `data/v6-mint-queue.json` (flip a roast), next cycle rejects
10. Writer role revocation test: DEPLOYER_A calls `setWriter(bot, false)`, bot's next mint reverts
11. SplitGuard escape hatch test: DEPLOYER_A calls `cancelAuction` on a live listing (should succeed); DEPLOYER_A calls `emergencyWithdraw(tokenId)` — confirms token lands in TREASURY_SEPOLIA, not anywhere else
12. Telegram regeneration cap test: tap Regenerate 3 times, 4th prompt should omit the Regenerate button
11. Run post-deploy verification script on Sepolia state

---

## 17. V3 relationship

V3 is live on Base mainnet (21 tokens). **Do not touch** until explicitly retired. V6 on Ethereum runs independently — no shared infra, no migration of V3 tokens to V6. Eventually V3 deployer wallet is drained and V3 becomes orphaned on-chain.

---

## 18. Launch checklist

### Phase 1 — Dev

- [ ] CollectionAdmin.sol written + tested
- [ ] SplitGuard.sol written + tested
- [ ] QuoteRegistry writer-role patch + updated tests
- [ ] Telegram approval flow implemented in rare-agent-v6.ts
- [ ] GIF generation wired into rare-mint-v6.ts and redemption-v6.ts
- [ ] Glitch animation wired into redemption-v6.ts (use `generate-redeemed-animation.ts`)
- [ ] Single canonical SVG generator (remove the duplicate in redemption-v6.ts)
- [ ] tokenId read from Transfer event in tx receipt
- [ ] `QUEUE_HMAC_SECRET` fallback fixed in scraper.ts
- [ ] `rare-mint-v6.ts:558` retry-path `ReferenceError` fixed
- [ ] Multicall3 + sessionStorage cache in marketplace.html
- [ ] EIP-6963 wallet discovery in marketplace.html
- [ ] `.env.example` rewritten for V6
- [ ] `deploy/firstrun.sh` rewritten for V6 (user `pi`, V6 env vars, swap file, logrotate)
- [ ] `deploy/cron.d-misogyny` rewritten (user `pi`, two cron jobs for agent+mint, `.env` sourced)
- [ ] `gitleaks` pre-commit hook installed, broadened pattern set
- [ ] `gitleaks detect` on full history — clean
- [ ] `agent.json` synced to code reality

### Phase 2 — Sepolia

- [ ] Create DEPLOYER_A_SEPOLIA, DEPLOYER_B_SEPOLIA, and TREASURY_SEPOLIA wallets, fund deployers via burner chain
- [ ] Deploy all contracts per §16
- [ ] Wire ownership + writer roles + royalty receiver
- [ ] Pi setup complete, healthcheck firing
- [ ] Full E2E per §16
- [ ] Render gate per §10.6
- [ ] Friend + SuperRare team contract review
- [ ] Post-deploy verification script passes

### Phase 3 — Mainnet

- [ ] Create DEPLOYER_A, DEPLOYER_B, and TREASURY wallets
- [ ] **Paper seed phrases physically written for all three wallets.** Operator physically verifies each one exists before any other Phase 3 step. No vibes, literal checkbox.
- [ ] **TREASURY seed stored in a DIFFERENT physical location** from DEPLOYER_A/B seeds. Not same envelope, not same drawer, not same room. TREASURY is hardcoded in SplitGuard bytecode and cannot be rotated — if it ever leaks, recovery is painful. Separating its seed from the other two means a single physical compromise (house break-in, flood in one drawer) can't take all three.
- [ ] Fund DEPLOYER_A + DEPLOYER_B via burner chain (Mullvad VPN → no-KYC exchange → each wallet). TREASURY does not need funding — it only receives NFTs, doesn't pay gas.
- [ ] Bookmark `etherscan.io` and `rare.xyz` in the browser profile used for deployer signing, delete any other bookmarks
- [ ] Deploy all contracts on Ethereum mainnet
- [ ] Fund bot wallet (~0.05 ETH / ~2 weeks gas)
- [ ] Update Pi `.env` to mainnet addresses
- [ ] Run post-deploy verification script — must pass before any mint
- [ ] First mint manually as sanity check
- [ ] Monitor first 24h

### Phase 4 — Operate

- [ ] First sale → first redemption confirmed end-to-end
- [ ] Routine: operator approves 2-5 mints/week via Telegram, bot runs unattended otherwise

### Phase 5 — Retire V3 (future)

- [ ] Drain V3 deployer wallet on Base
- [ ] Announce retirement

---

## 19. OPSEC

- All code → `ApocalypseTech00` GitHub only
- Email, API accounts, Pinata, Bluesky, Telegram bot → burner identity only
- Anthropic API on operator's artist-name account (accepted risk)
- DEPLOYER_A and DEPLOYER_B funded via burner chain, never from personal KYC'd exchange
- No Hetzner, no Mac in production (dev only)
- Pi at operator-controlled location

---

## 20. Current gaps against this spec

Delta between spec and code. Each is a unit of implementation work.

1. **CollectionAdmin.sol not written.**
2. **SplitGuard.sol not written.**
3. **QuoteRegistry writer-role patch not written.** Existing Sepolia deploy will be replaced.
4. **Primary + secondary splitters not deployed on Ethereum.**
5. **Telegram approval flow not implemented.** Current rare-agent-v6.ts auto-promotes without human approval.
6. **Roast-at-scrape-time not implemented.** Current code generates comebacks at redemption time (power-quote mode still present).
7. **MP4 capture pipeline (Bluesky) not implemented** in V6 mint or redemption.
8. **Glitch animation not wired.** `generate-redeemed-animation.ts` exists (616 lines) but `redemption-v6.ts:588` calls plain `generateAnimation`.
9. **Fact-check logic still in code** — remove (roasts only, no fact-checking).
10. **`ANTHROPIC_DAILY_USD_CAP` not enforced.**
11. **`QUEUE_HMAC_SECRET` has unsafe fallback** (`scraper.ts:183`). Must throw on missing.
12. **Cron user mismatch.** `deploy/cron.d-misogyny` uses `apocalypse`, Pi user is `pi`.
13. **`deploy/firstrun.sh` stale.** V5 env vars, HTTPS git clone, missing swap+logrotate.
14. **`.env.example` stale.**
15. **`agent.json` stale.**
16. **`rare-mint-v6.ts:558` bug.** `mintResult.tokenId` references out-of-scope var on retry path.
17. **TokenId parsing via stdout regex.** Replace with Transfer-event read from tx receipt.
18. **Duplicate SVG generator** in `redemption-v6.ts:742`. Consolidate to `generate-artwork.ts` with palette param.
19. **Dead IPFS gateway** `cloudflare-ipfs.com` in redemption-v6.ts. Replace.
20. **No Multicall3** in frontend chain reads.
21. **No EIP-6963** wallet discovery.
22. **No gitleaks pre-commit hook.**
23. **Font via IPFS URL** in some paths — needs base64 embed for reliable render.
24. **No post-deploy verification script** to sanity-check on-chain state before first mint.
