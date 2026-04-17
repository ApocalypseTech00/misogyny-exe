# Next Session Prompt — Session 14

> **Mode:** crunch to ship by Saturday 2026-04-18.
> **Start here:** read this file fully, then `docs/V6-CHECKLIST.md`. Session 13 ran long (2 days, Apr 16–17) — mostly roast calibration + animation QA, no infra.

---

## Session 13 TL;DR

- **Mint corpus locked:** 26 quotes (9 punchy / 9 medium / 8 long) in `data/mint-corpus.json`. All roasts operator-approved. 15 are manual overrides, 11 are Sonnet-generated AUTO. Do NOT regenerate confirmed roasts — they're locked.
- **ROAST_PROMPT fully rewritten** with Gervais × Regina George × turbo-intellect DNA (11 principles in `scripts/rare-agent-v6.ts` lines 57–120, mirrored in `scripts/generate-roasts-batch.ts`). Calibration examples are operator-approved bangers.
- **Roast validator built** (`scripts/roast-validator.ts`) — quality gate between generation + picking. Checks: `targets_typer`, `no_loneliness_mock`, `no_sermon`, `no_refusal`, `earns_its_mean`, `stays_on_scope`. Tested + confirmed working. NOT yet wired into `rare-agent-v6.ts` or `generate-roasts-batch.ts` — needs porting.
- **All 31 animation templates stripped** of vignette + text-shadow (operator decision from prior session, enforced this session).
- **VHS template fixed** — chromatic ghost overflow on punchy quotes (pseudo-elements now use `white-space: pre-line` + `\n` join).
- **Tunnel template killed** — removed from scripts, templates, data, gallery, KINETIC-TYPOGRAPHY.md.
- **SKIP_LENGTHS updated:** `corruption` now punchy-only (was punchy+medium).
- **V3 tokens pulled from IPFS** — 5 of 22 resolved (1,2,5,6,7). Tokens 3,4,8–22 revert (burned or non-contiguous). Token #1 = Napoleon Bonaparte contamination (kill in any migration plan). Dump at `data/v3-tokens.json`.
- **4 permanent memory entries saved** (in `~/.claude/projects/-Users-elastipicic/memory/`):
  1. No real-person quotes for mint content (anonymous Reddit only)
  2. No vignette / no text-shadow glow on templates
  3. Dedupe mint corpus (no near-identical scraper variants)
  4. Roast tone calibration (target THIS guy, not all men; approved bangers list; never regenerate confirmed roasts)

## What was NOT done from the Thursday plan

- **Redemption animations** — none built. The kinetic typography templates (`~/Projects/animation-library/redemption-templates/`) are still empty. The user postponed this to focus on roast calibration.
- **`generate-redeemed-animation.ts`** — not wired to pick from redemption pool yet.
- **Animation render of the 26 confirmed quotes** — gallery was built with the old dummy-quote + redeemed-palette layout, but needs final one-quote-per-animation render with confirmed mint-corpus + roasts.

## Crunch plan (revised for remaining time)

### Session 14 — finish animation render + port validator + commit

1. **Port roast validator** into `rare-agent-v6.ts` and `generate-roasts-batch.ts`:
   - Import from `scripts/roast-validator.ts`
   - Insert between `generateRoasts()` and `pickBestRoastIndex()`
   - Filter out failed candidates before picker runs
   - If zero pass → mark pending (don't retry)

2. **One-animation-per-quote render:**
   - 26 confirmed quotes → 26 cells, each with a deterministic animation style
   - 31 styles total, so reuse 5 quotes to cover all styles
   - Stacked layout: hate row (pink on dark) + roast row (dark on pink) per style section
   - Open gallery for final user tweaks

3. **Redemption animations** (if time):
   - Build 8–10 kinetic typography templates per `KINETIC-TYPOGRAPHY.md`
   - Wire `generate-redeemed-animation.ts` to pick from the pool

4. **Commit everything:**
   - All template changes (vignette/shadow strip, VHS fix, tunnel removal)
   - `data/mint-corpus.json` + `data/roasts.json`
   - New scripts: `dump-v3-quotes.ts`, `generate-roasts-batch.ts`, `roast-validator.ts`, `test-roast-prompt.ts`
   - Updated `render-samples.ts`
   - Updated ROAST_PROMPT in `rare-agent-v6.ts` + `generate-roasts-batch.ts`
   - Session docs

### Friday — infra day (unchanged from Session 12 plan)

1. **External service accounts** (ApocalypseTech burner identity):
   - Telegram bot → `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OPERATOR_CHAT_ID`
   - Healthchecks.io → `HEALTHCHECK_URL`
   - Pinata → `PINATA_JWT`
   - Bluesky → `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`
2. **Pi onboarding:** `scp .env`, `git pull && npm ci && bash deploy/firstrun.sh`
3. **Sepolia E2E shakedown:** agent boots → scrape → TG approval → mint → verify
4. **Key rotation:** wipe DEPLOYER_A from laptop, fresh bot wallet on Pi
5. **Mainnet deploy** (only after Sepolia clean)

### Saturday — front-end + launch (unchanged)

1. V6 front-end update
2. Render gate (SuperRare mainnet, OpenSea mainnet, Bluesky test post)
3. First real mainnet mint
4. Launch post on Bluesky
5. Deploy site to all 3 domains

## Current state

- **Branch:** `feat/redemption-mechanic`
- **Latest commit:** `6d66d19` (animations). 58 files modified/untracked since — all from Session 13 work (template strips, new scripts, data files). Nothing committed yet this session.
- **Pi:** `judie-2` online via Tailscale `100.70.212.104`, repo cloned, deps installed. `.env` NOT YET created.
- **Sepolia contracts:** all deployed + verified (commit `60f5f61`).
- **Tests:** 233/233 passing as of Session 11. Not re-run this session — template-only + data changes shouldn't affect contracts.

## Key files created/modified this session

| File | Status | Purpose |
|---|---|---|
| `data/mint-corpus.json` | NEW | 26 confirmed quotes for minting (9/9/8 punchy/medium/long) |
| `data/roasts.json` | MODIFIED | 200+ roasts including 15 operator-approved manual overrides |
| `data/v3-tokens.json` | NEW | V3 Base mainnet token dump (5 of 22 resolved) |
| `scripts/roast-validator.ts` | NEW | Quality gate for roasts (Haiku-based, 6 criteria) |
| `scripts/generate-roasts-batch.ts` | NEW | Batch roast generation with new prompt |
| `scripts/test-roast-prompt.ts` | NEW | Dry-test harness for prompt + validator |
| `scripts/dump-v3-quotes.ts` | NEW | V3 token → IPFS metadata extractor |
| `scripts/render-samples.ts` | MODIFIED | Now loads from mint-corpus.json, stacked hate+roast layout |
| `scripts/rare-agent-v6.ts` | MODIFIED | ROAST_PROMPT rewritten (11 DNA principles + 7 calibration bangers) |
| `data/artworks/anim-*.html` (31 files) | MODIFIED | Vignette + text-shadow stripped, VHS ghost fix |

## Confirmed bangers (tone calibrators — LOCKED, never regenerate)

These are the roasts the operator loved and built the ROAST_PROMPT calibration around:

| Scrape | Roast |
|---|---|
| Beautiful people shall inherit the world... | The man who built his entire philosophy around not being invited to prom. |
| Women are property and therefore loot | A Viking fantasy from a man who has never, once in his life, been anyone's prize. |
| She's on her cycle, ignore her | A clinical diagnosis offered by the demographic most represented on anger-management waitlists. |
| wives should obey husbands | A coverture fantasy from a man who's spent his entire adult life being ignored by his own dog. |
| Women have ruined the country... | Men ran the country alone into slavery, two world wars, and a Great Depression. She arrived five minutes ago and it's her fault. |
| you are still not safe, I can still exert power... | A power fantasy from a man whose last genuine victory was over a self-checkout machine. |
| All I said was women are inferior and now they won't date me | The entire mystery solved in one sentence, by the detective and the crime. |

## Hard rules (re-stated)

1. No Reddit OAuth — ever. Pi residential IP is the scraping strategy.
2. On-chain art must be real, not a display hack.
3. OPSEC: zero overlap with operator real identity.
4. Mac never in production pipeline. Dev only.
5. Don't touch V3 files.
6. V6 only — don't reference V5 or propose consolidating it.
7. No multisig, no hardware wallet, no signing daemon.
8. No GIF output anywhere. PNG + HTML + MP4 only.
9. **Mint content must be anonymous scraped Reddit ONLY.** No named figures (living or historical). `archive/quotes.md` = research reference, not mint source.
10. **No vignette, no text-shadow glow** on mint-tier animation templates.
11. **Dedupe mint corpus** before presenting to operator. No near-identical scraper variants.
12. **Roast tone:** target THIS specific guy, not "all men." Never mock loneliness/physical traits/dick size. Incel ideology = fair game. Male suffering ≠ fair game. Never assume biography (age, job, relationship status). Operator-confirmed roasts are LOCKED — do not regenerate.
13. **No "Fascinating" overuse** — vary sentence openings, don't start 3/3 candidates with "A [noun]..."

## Commands cheatsheet

```bash
cd ~/Projects/misogyny-exe

# Tests
npx hardhat test                          # 233 passing expected

# Render gallery (mint-corpus quotes + roasts, stacked layout)
npx ts-node scripts/render-samples.ts
open data/samples/index.html

# Test roast prompt (dry run, no writes)
npx ts-node scripts/test-roast-prompt.ts

# Batch-generate roasts (writes to data/roasts.json, resumable)
npx ts-node scripts/generate-roasts-batch.ts
LIMIT=5 npx ts-node scripts/generate-roasts-batch.ts   # smoke test

# Sepolia
npm run deploy:v6:testnet:dry
npm run deploy:v6:testnet
npm run verify:v6:testnet

# Pi access
ssh pi@judie-2                            # via Tailscale
```
