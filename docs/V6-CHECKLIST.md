# MISOGYNY.EXE V6 — Master Checklist

**Authoritative ledger of what's done, what's in progress, what's blocked on the operator.**
Lives in git so it survives `.gitignore`'d session docs and terminal crashes.

**Last updated:** end of Session 11. User has funded 3 Sepolia wallets. Next task: collect addresses + deploy to Sepolia.

---

## 🗺️ How to read this

- ✅ = done and shipped
- 🟡 = in progress / waiting on something small
- 🔲 = not started
- ⚠️ = landmine — specific thing that's tripped up past work

Commands assume you're in `~/Projects/misogyny-exe`.

---

## ✅ Phase 1 — Dev (DONE)

### Spec & architecture
- ✅ V6 spec rewritten as canonical — `docs/v6-spec.md` (~600 lines)
- ✅ 4-wallet model locked: `DEPLOYER_A` / `DEPLOYER_B` / `BOT` / `TREASURY`
- ✅ Threat model scoped to 3 real threats only (see `docs/v6-spec.md` §4)
- ✅ Explicit rejections documented so they don't get re-proposed (multisig, Gnosis Safe, hardware wallet, signing daemon, GIF output, Hetzner rendering, paid audits, ZK privacy, "mega turbo security", observer Pi, nftables, systemd hardening flags, separate browser profiles)

### Smart contracts
- ✅ `contracts/QuoteRegistry.sol` — writer-role patch (owner = DEPLOYER_B, writer = BOT)
- ✅ `contracts/CollectionAdmin.sol` — owner = DEPLOYER_A, writer = BOT, hardcodes mint destination to SPLIT_GUARD
- ✅ `contracts/SplitGuard.sol` — immutable splits `[SPLITTER, 100]`, writer mapping gated by DEPLOYER_A, `emergencyWithdraw` hardcoded to TREASURY (no `to` param at ABI level), `cancelAuction` backup via DEPLOYER_A
- ✅ Test mocks: `contracts/test/MockRareCollection.sol`, `contracts/test/MockRareBazaar.sol`
- ✅ **Tests: 233/233 passing** (75 V6 unit + 10 integration + 148 V3/V5 legacy)

### Bot pipeline
- ✅ `scripts/rare-agent-v6.ts` — scrape + guard + 3 Sonnet roasts + Haiku picker + Telegram approval (1/2/3/regen/reject) + 48h nag + 72h expiry + Sunday digest
- ✅ `scripts/rare-mint-v6.ts` — CollectionAdmin + SplitGuard integration, Transfer-event tokenId parsing, idempotent retries
- ✅ `scripts/redemption-v6.ts` — pre-approved roast, glitch animation wired, MP4 for Bluesky
- ✅ `scripts/indexer-v6-eth.ts` — Rare Bazaar Sold/AuctionSettled watcher, RPC fallback
- ✅ `scripts/spend-cap.ts` — Anthropic daily USD accumulator (`gate()` + `record()`)
- ✅ `scripts/telegram.ts` — Bot API wrapper with `scrubTgSecrets()`
- ✅ `scripts/capture-mp4.ts` — Puppeteer + ffmpeg MP4 capture, V3's proven recipe
- ✅ `scripts/generate-artwork.ts` — palette parameter (`hate` / `redeemed`) + REDEEMED glyph
- ✅ HMAC on queue: MANDATORY `QUEUE_HMAC_SECRET` (≥32 chars), no fallback, covers `{id, quote, roast}`

### Deploy infra
- ✅ `scripts/deploy-v6.ts` — single-key deploy from laptop (NOT Pi), `--dry-run` preview, placeholder guard, strict network lookup
- ✅ `scripts/verify-deploy.ts` — reads on-chain state, asserts `.env` match, EIP-2981 royaltyInfo check, primary≠secondary splitter sanity
- ✅ `.env.example` — canonical V6 shape (spec §13)
- ✅ `deploy/firstrun.sh` — Pi bootstrap (user `pi`, 2GB swap, logrotate, `chromium` on Bookworm)
- ✅ `deploy/cron.d-misogyny` — 4 cron jobs, scoped pkill, staggered (indexer 0-59/5, redemption 2-59/5)
- ✅ `.gitleaks.toml` — pre-commit secret scan, library/docs allowlist
- ✅ `agent.json` — synced to V6
- ✅ `package.json` npm scripts — `deploy:v6:{testnet,mainnet}:{,:dry}`, `verify:v6:*`, `v6:*`, `lint:secrets`

### Security checks
- ✅ `gitleaks detect` on full history (33 commits, 53MB) → no leaks
- ✅ TypeScript clean on every V6 file
- ✅ All V3 contracts untouched (they're live on Base, frozen per hard rule)

### Git state
- ✅ Branch `feat/redemption-mechanic` on `ApocalypseTech00/misogyny-exe`, 8 commits ahead of main, all pushed

---

## 🟡 Phase 2 — Sepolia deploy (in progress)

### Wallets
- ✅ `DEPLOYER_A_SEPOLIA` created and funded with Sepolia ETH (done 2026-04-14 end of Session 11)
- ✅ `DEPLOYER_B_SEPOLIA` created and funded
- ✅ `TREASURY_SEPOLIA` created (no gas needed)
- 🔲 Addresses handed off to next Claude session (paste as plain text — NEVER private keys)
- 🔲 Paper seed phrases written + stored physically separate from laptop
- 🔲 Fresh `BOT` wallet generated (can do on Pi: `cast wallet new`, or a throwaway on laptop — just not the same wallet as DEPLOYER_A/B)

### External services
- 🔲 Burner Telegram bot created via @BotFather → `TELEGRAM_BOT_TOKEN`
- 🔲 Operator chat ID captured via `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` after sending `/start` → `TELEGRAM_OPERATOR_CHAT_ID`
- 🔲 Healthchecks.io free-tier account → single check → copy ping URL → `HEALTHCHECK_URL`
- 🔲 Pinata burner account → JWT → `PINATA_JWT` (may already exist from V3)
- 🔲 Sepolia RPC endpoint picked → `ETHEREUM_SEPOLIA_RPC_URL` (Alchemy burner or just `https://ethereum-sepolia-rpc.publicnode.com` for starters)
- 🔲 Charity / Artist / Project payee addresses finalized → `CHARITY_ADDRESS` / `ARTIST_ADDRESS` / `PROJECT_ADDRESS`

### Rare collection deploy (NOT our contracts — SuperRare's tooling)
- 🔲 `rare deploy erc721 "MISOGYNY.EXE" "MSGNX" --chain sepolia`
- 🔲 Record the deployed address → `RARE_CONTRACT_ADDRESS`
- 🔲 Note which wallet deployed it (needed later for `transferOwnership` step)

### .env population (on laptop, NOT Pi)
- 🔲 Copy `.env.example` → `.env` on laptop
- 🔲 Fill all wallet addresses (DEPLOYER_A/B, TREASURY, BOT, CHARITY, ARTIST, PROJECT)
- 🔲 `QUEUE_HMAC_SECRET=$(openssl rand -hex 32)` — generate fresh
- 🔲 `PRIVATE_KEY` = **DEPLOYER_A_SEPOLIA's private key, TEMPORARILY, for deploy only**
- 🔲 Other service creds (Pinata, Anthropic, TG, Bluesky, Healthchecks)
- 🔲 `chmod 600 .env`

### Deploy
- 🔲 `npm run deploy:v6:testnet:dry` — preview every constructor arg + role call before burning gas
  - Expected output: "DRY RUN — no contracts deployed" + list of 5 contracts + 5 role calls + "Re-run WITHOUT --dry-run to actually send transactions."
- 🔲 `npm run deploy:v6:testnet` — live
  - Expected output: 5 contracts deploy in order (primary splitter → secondary splitter → SplitGuard → CollectionAdmin → QuoteRegistry), then role-wiring txs, then Etherscan verification, then a paste-ready `.env` block with all 5 addresses
  - ⚠️ The `setRoyaltyReceiver` step will FAIL on first run with "skipped (expected if collection ownership not yet transferred)" — this is correct behavior, we fix it in step below
- 🔲 Paste the 5 new addresses into `.env`: `PRIMARY_SPLITTER_ADDRESS`, `SECONDARY_SPLITTER_ADDRESS`, `SPLIT_GUARD_ADDRESS`, `COLLECTION_ADMIN_ADDRESS`, `QUOTE_REGISTRY_ADDRESS`

### Wire ownership + royalties
- 🔲 From the wallet that deployed the Rare collection (step "Rare collection deploy"), call on Etherscan: `Rare.transferOwnership(<COLLECTION_ADMIN_ADDRESS>)`
- 🔲 From DEPLOYER_A (via Etherscan or hardhat console), call: `CollectionAdmin.setRoyaltyReceiver(<SECONDARY_SPLITTER_ADDRESS>)` (only if deploy script's attempt failed — which it will on first run)

### Verify
- 🔲 `npm run verify:v6:testnet`
  - Expected: every check ✓, final line "=== ALL CHECKS PASS ===" and "Safe to run the bot."
  - If ANY check fails: fix it before going further. Don't proceed to Pi.
  - ⚠️ Common failure: Rare collection owner != CollectionAdmin → means you forgot the `transferOwnership` step above
  - ⚠️ Common failure: royaltyInfo receiver != secondary splitter → means `setRoyaltyReceiver` step was skipped

### Key rotation (critical)
- 🔲 Replace `PRIVATE_KEY` in the laptop's `.env` with the BOT key (fresh wallet)
- 🔲 Wipe DEPLOYER_A_SEPOLIA's key from laptop's `.env` entirely — should only exist in MetaMask + paper seed

### Pi setup
- 🔲 `scp .env pi@judie-2:~/misogyny-exe/.env` (from laptop)
- 🔲 On Pi: `cd ~/misogyny-exe && git pull && npm ci`
- 🔲 On Pi: confirm `.env` has BOT key, NOT DEPLOYER_A key: `grep PRIVATE_KEY .env | head -c 20`
- 🔲 On Pi: `bash deploy/firstrun.sh` — installs chromium, ffmpeg, swap, logrotate, cron
- 🔲 On Pi: `chmod 600 .env` (firstrun does this, double-check)

### Sepolia E2E
- 🔲 Pi dry run: `npm run v6:agent:dry` — scrapes Reddit, runs guard, generates 3 Sonnet roasts, logs "would send TG" but doesn't actually hit TG. Confirms boot.
- 🔲 Enable cron (firstrun did this): `sudo systemctl status cron` should show active
- 🔲 Watch first real agent cycle: `tail -f ~/misogyny-exe/logs/rare-agent-v6.log`
- 🔲 First Telegram approval DM arrives — tap 1/2/3 for roast
- 🔲 Watch `tail -f ~/misogyny-exe/logs/rare-mint-v6.log` on next :05 — first mint tx confirmed on Etherscan Sepolia
- 🔲 Verify: token #1 owned by `SPLIT_GUARD_ADDRESS` (not BOT)
- 🔲 From a second Sepolia wallet, bid/buy the token via Rare Sepolia UI
- 🔲 Watch `tail -f ~/misogyny-exe/logs/redemption-v6.log` fire within ~5 min
- 🔲 Verify: token #1 tokenURI flipped to redeemed metadata, `QuoteRegistry.comebackOf(1)` returns the approved roast
- 🔲 Verify Bluesky post appeared with MP4

### Render gate (spec §10.6)
- 🔲 PNG renders in `<img>` — visual check
- 🔲 HTML renders standalone in a browser tab
- 🔲 HTML renders in iframe with `sandbox="allow-scripts"` (paste from chain via Etherscan → IPFS gateway)
- 🔲 HTML renders on SuperRare testnet token detail page
- 🔲 HTML renders on OpenSea testnet token detail page
- 🔲 **Font is embedded as `data:` URI** (not relative URL) — inspect generated SVG source
- 🔲 **HTML font renders correctly on iOS Safari** inside sandboxed iframe (the one that silently falls back to Georgia)
- 🔲 MP4 plays inline in a Bluesky test post
- 🔲 Metadata JSON validates against OpenSea schema
- 🔲 IPFS gateway returns correct `Content-Type` headers for PNG, HTML, JSON

---

## 🔲 Phase 3 — Ethereum mainnet

Only after Sepolia has run clean for a soak period.

- 🔲 Create 3 mainnet wallets (DEPLOYER_A, DEPLOYER_B, TREASURY — NEW wallets, not the Sepolia ones)
- 🔲 **Paper seed phrases for ALL 3 mainnet wallets before any deploy** (`docs/v6-spec.md` §15.4 recovery is impossible without these)
- 🔲 TREASURY seed stored in a DIFFERENT physical location from DEPLOYER_A/B seeds (TREASURY is hardcoded in SplitGuard bytecode — unrotatable)
- 🔲 Bookmark `etherscan.io` + `rare.xyz` in browser, delete all other bookmarks in that profile
- 🔲 Fund DEPLOYER_A + DEPLOYER_B via burner chain (Mullvad → no-KYC exchange → wallets)
- 🔲 Fund BOT mainnet wallet with ~0.05 ETH (2 weeks of gas)
- 🔲 `rare deploy erc721 "MISOGYNY.EXE" "MSGNX" --chain mainnet`
- 🔲 Populate mainnet `.env` fresh (NEVER copy-paste sepolia `.env`, too easy to leak a testnet key as mainnet)
- 🔲 `npm run deploy:v6:mainnet:dry` — preview
- 🔲 `npm run deploy:v6:mainnet` — live (gas will be real, ~$10-30 at current prices)
- 🔲 Transfer Rare collection ownership → CollectionAdmin
- 🔲 `npm run verify:v6:mainnet` — MUST pass all checks
- 🔲 First manual mint on mainnet as sanity check
- 🔲 Monitor first 24h closely

---

## 🔲 Phase 4 — Operate

- 🔲 First sale + redemption on mainnet confirmed end-to-end
- 🔲 30-day soak at Phase-4 defaults (`AGENT_MAX_PER_CYCLE=1`, `AGENT_DAILY_LIMIT=2`)
- 🔲 If stable, crank to `AGENT_MAX_PER_CYCLE=3`, `AGENT_DAILY_LIMIT=12`

---

## 🔲 Phase 5 — V3 retirement (future)

- 🔲 Drain V3 deployer wallet on Base to zero ETH (stops all V3 mints silently)
- 🔲 Announce V3 retirement on Bluesky
- 🔲 Old V3 contracts stay on-chain as immutable art archive, unmaintained

---

## ⚠️ Landmines from Session 11 (so next Claude doesn't repeat)

These are specific things the previous Claude (me) kept getting wrong. Documented here because memory rules + NEXT_SESSION_PROMPT got auto-truncated or ignored during long debates.

1. **Pi 4B 4GB handles MP4 capture fine.** V3's `scripts/capture-and-post-videos.ts` runs the SAME Puppeteer + ffmpeg pipeline on a 1GB Pi 3B+ and works. Do not panic and propose "offload to Hetzner" or "second render Pi." The spec says Pi-local MP4, it works.
2. **"Cold wallet" is not in the vocabulary.** The operator uses plain hot software wallets in MetaMask. DEPLOYER_A/B/TREASURY are three regular EOAs that live on the laptop, not hardware devices. Don't say "cold storage" or imply hardware.
3. **Multisig is permanently off the table.** An autonomous bot minting every 12h cannot be gated on 2-of-3 signatures. Don't re-propose Safe / Gnosis / anything multi-sig-shaped.
4. **Signing daemon is off the table.** Same reason — breaks autonomy. Don't re-propose Go/Rust/UDS-socket signing services.
5. **Hardware wallets off the table.** Same reason.
6. **"Separate browser profiles for MetaMask" is NOT a requirement.** It was added as security theater and explicitly removed. The operator stores wallets however they want.
7. **GIF output is banned.** No GIFs anywhere in the pipeline. PNG (static) + HTML (on-chain animation_url) + MP4 (Bluesky only, not IPFS). Don't re-propose GIF for any reason, including "Bluesky compatibility" — MP4 works.
8. **V3 and V5 are out of scope.** V3 is live on Base, frozen, untouchable. V5 is shelved, dead, don't reference it. V6 is the only pipeline. When spawning agents for review, scope them to V6-only explicitly, or they will drift into reviewing V3 as if it's a live concern.
9. **The panel tends toward security theater.** Multi-agent panels keep recommending nftables allowlists, systemd hardening, observer Pis, paid audits, Tailnet Lock. The operator has scoped defense to 3 threats only. Filter panel output against that scope before applying anything.
10. **"AI fact-checking" for power-quote comebacks doesn't work.** We discussed this at length. Roasts-only is the final answer; Sonnet generates + operator approves via TG. No fact-checking needed because roasts don't make factual claims. Don't re-propose power-quote mode or Haiku fact-check pass.
11. **TREASURY is hardcoded into SplitGuard bytecode and cannot be rotated.** If TREASURY's seed leaks, the only fix is redeploying SplitGuard (and likely re-minting). Paper seed for TREASURY is mandatory and must be stored separately.
12. **Deploy runs from the LAPTOP, not the Pi.** DEPLOYER_A's private key never touches the Pi. The Pi's `.env` only ever contains the BOT key. This is hammered into `deploy-v6.ts`'s header comment because it's the riskiest moment of the flow.

---

## 📬 Handoff tokens (what tomorrow's Claude needs from the operator)

Tomorrow you'll want to hand these to Claude as plain text (they're all public):

- `DEPLOYER_A_SEPOLIA` address: `0x...`
- `DEPLOYER_B_SEPOLIA` address: `0x...`
- `TREASURY_SEPOLIA` address: `0x...`
- `BOT` address (if generated yet): `0x...`
- `CHARITY_ADDRESS`: `0x...`
- `ARTIST_ADDRESS`: `0x...`
- `PROJECT_ADDRESS`: `0x...`
- Sepolia RPC URL preference (or "use the default publicnode one")
- Any addresses already reserved (V3 / legacy) that should be reused

**Never paste private keys or seed phrases into chat.** Conversations are retained. Keys go into `.env` on your own laptop, and Claude can see the placeholder positions but never needs the actual key value.

---

## 🧭 Quick reference

**Where does each file live and why:**
- `docs/v6-spec.md` — canonical architecture spec, supersedes `docs/v5-spec.md`
- `docs/V6-CHECKLIST.md` — this file, authoritative status ledger
- `SESSION-LOG.md` / `NEXT_SESSION_PROMPT.md` — local-only (`.gitignore`'d), session handoff notes
- `CLAUDE.md` — hard rules + session protocols, always read at session start
- `.env.example` — template for `.env`
- `.gitleaks.toml` — pre-commit secret scan config

**One-liners:**
```bash
npx hardhat test                                    # 233 passing
npm run lint:secrets                                # gitleaks full history
npm run deploy:v6:testnet:dry                       # preview deploy
npm run deploy:v6:testnet                           # live deploy
npm run verify:v6:testnet                           # post-deploy state check
npm run v6:agent:dry                                # agent boot sanity
```

**RPC sanity check (verify don't guess):**
```bash
curl -s https://ethereum-sepolia-rpc.publicnode.com \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_gasPrice","params":[],"id":1}'
```
