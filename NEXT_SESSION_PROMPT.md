# Next Session Prompt — Session 15

> **Mode:** crunch to ship. Pi is physically online — infra setup can proceed remotely.
> **Start here:** read this file fully, then last entry in `SESSION-LOG.md`.

---

## Session 14 TL;DR

- **Roast agent pipeline fully wired:** 5-candidate generation → Haiku validator (8 criteria) → Haiku picker → TG approval → self-improving calibration library. All in `scripts/rare-agent-v6.ts`.
- **Self-improving calibration:** `scripts/roast-calibration.ts` + `data/approved-roasts.json`. TG approvals accumulate as few-shot examples; ROAST_PROMPT dynamically loads best 12. Seeded with 12 confirmed bangers.
- **Validator tuned through 4 dry runs:** `no_assumed_biography` + `universal_reference` added. `earns_its_mean` + `stays_on_scope` loosened (was over-blocking clean metaphors). `no_loneliness_mock` loosened (fear of female agency = PASS).
- **ROAST_PROMPT has 11 DNA principles** from Gervais × Regina George research. Key: "let audience complete the logic", "economy is power", "never assume biography", "walk away."
- **Hit rate ~60-70%** with 5 candidates. NOT airtight yet — more dry runs needed before shipping autonomously.
- **Education stat footnote** added: NCES Table 318.10, U.S. data, women outperforming since 1982.

## CRITICAL: More testing needed

The roast agent is NOT ready to ship autonomously. ~30% of outputs are mid-tier or fail validator. The operator explicitly asked for more dry runs before trusting it:

> "we need to do a few more tests and dry runs to make the quotes and redemptions air tight"

Run `npx ts-node scripts/test-roast-prompt.ts` with fresh scrapes, evaluate with operator, iterate on prompt/validator until hit rate is consistently banger-tier. The 26 confirmed mint-corpus roasts are LOCKED and banger-tier — this is about the autonomous pipeline for NEW scrapes.

## Current state

- **Branch:** `feat/redemption-mechanic`
- **Commits:** `10f3e6a` (calibration + validator), `ec079c6` (templates + prompt), `4f498a2` (session docs)
- **Pi:** `judie-2` online via Tailscale `100.70.212.104`. Physically plugged in. `.env` NOT YET created. All setup is remote via SSH.
- **Sepolia contracts:** deployed + verified.
- **Tests:** 233/233 passing as of Session 11. Not re-run recently.

## Mint corpus: 26 quotes LOCKED

`data/mint-corpus.json` — 9 punchy / 9 medium / 8 long. All roasts operator-approved in `data/roasts.json`. **Do NOT regenerate these.** Entries with `override: true` are operator-handwritten or manually approved.

## Confirmed bangers (tone calibrators)

| Scrape | Roast |
|---|---|
| Beautiful people shall inherit... | The man who built his entire philosophy around not being invited to prom. |
| Women are property and therefore loot | A Viking fantasy from a man who has never, once in his life, been anyone's prize. |
| She's on her cycle, ignore her | A clinical diagnosis offered by the demographic most represented on anger-management waitlists. |
| wives should obey husbands | A coverture fantasy from a man who's spent his entire adult life being ignored by his own dog. |
| Women have ruined the country... | Men ran the country alone into slavery, two world wars, and a Great Depression. She arrived five minutes ago and it's her fault. |
| you are still not safe, I can still exert power... | A power fantasy from a man whose last genuine victory was over a self-checkout machine. |
| All I said was women are inferior and now they won't date me | The entire mystery solved in one sentence, by the detective and the crime. |
| Women should not be allowed to vote | The last time men decided everything alone, they started two world wars. They appear to be working on the third. |
| Women are desperate to be sexually harassed | Projected the fantasy so hard he filed it under "research." |

## Remaining work (priority order)

### 1. More roast dry runs (BLOCKING)
Test the autonomous pipeline with fresh scrapes. Iterate prompt/validator until operator is satisfied. Use `scripts/test-roast-prompt.ts` — edit `TEST_IDS` to pick new scrapes from `data/scraper-candidates.json`.

### 2. Pi infra setup (remote via SSH)
- Burner Telegram bot → `TELEGRAM_BOT_TOKEN` + `TELEGRAM_OPERATOR_CHAT_ID`
- Healthchecks.io → `HEALTHCHECK_URL`
- Pinata → `PINATA_JWT`
- Bluesky → `BLUESKY_HANDLE` + `BLUESKY_APP_PASSWORD`
- `scp .env pi@judie-2:~/misogyny-exe/.env`
- On Pi: `git pull && npm ci && bash deploy/firstrun.sh`
- Sepolia E2E: `npm run v6:agent:dry` → scrape → TG approval → mint → verify

### 3. One-animation-per-quote render
26 confirmed quotes → 26 cells, each with deterministic animation. Stacked hate + roast redeemed-palette rows. Gallery for final operator tweaks.

### 4. Redemption kinetic typography templates
Build 8-10 templates per `~/Projects/animation-library/KINETIC-TYPOGRAPHY.md`. Wire `generate-redeemed-animation.ts`.

### 5. Front-end + mainnet deploy + launch
V6 site update, render gate, first mainnet mint, Bluesky launch post, deploy to all 3 domains.

### 6. Post-launch: Gemma fine-tuning
Pi 4B can run Gemma 3B quantized via llama.cpp. Fine-tune on cloud GPU with synthetic dataset from approved roasts. Hybrid: Gemma drafts (free, on-device) → Sonnet validates (1 cheap API call). Post-launch exploration.

## Key files

| File | Purpose |
|---|---|
| `scripts/rare-agent-v6.ts` | Live agent — ROAST_PROMPT (11 principles) + 5-candidate gen + validator + TG approval + calibration feedback |
| `scripts/roast-calibration.ts` | Self-improving few-shot library — addApproved/addRejected/buildCalibrationBlock |
| `scripts/roast-validator.ts` | Haiku quality gate — 8 criteria (targets_typer, no_loneliness_mock, no_sermon, no_refusal, earns_its_mean, stays_on_scope, no_assumed_biography, universal_reference) |
| `scripts/generate-roasts-batch.ts` | Batch roast gen (validator NOT yet integrated — only rare-agent-v6 has it) |
| `scripts/test-roast-prompt.ts` | Dry-test harness — edit TEST_IDS, run, evaluate |
| `data/mint-corpus.json` | 26 LOCKED quotes |
| `data/roasts.json` | All roasts (15 manual overrides + auto) |
| `data/approved-roasts.json` | Self-improving calibration library (12 seed bangers) |

## Hard rules (all 13)

1. No Reddit OAuth — Pi residential IP is the scraping strategy.
2. On-chain art must be real, not a display hack.
3. OPSEC: zero overlap with operator real identity.
4. Mac never in production pipeline. Dev only.
5. Don't touch V3 files.
6. V6 only.
7. No multisig, no hardware wallet, no signing daemon.
8. No GIF output. PNG + HTML + MP4 only.
9. Mint content = anonymous scraped Reddit ONLY. No named figures.
10. No vignette, no text-shadow glow on mint templates.
11. Dedupe mint corpus before presenting to operator.
12. Roast tone: target THIS specific guy, not "all men." Incels (ideology) = fair game. Loneliness/physical traits = off limits. Never assume biography. Confirmed roasts are LOCKED.
13. Vary sentence openings. No 3/3 starting with "A [noun]..."

## Commands

```bash
cd ~/Projects/misogyny-exe

# Dry-test roast pipeline (edit TEST_IDS first)
npx ts-node scripts/test-roast-prompt.ts

# Batch roasts (writes to data/roasts.json)
npx ts-node scripts/generate-roasts-batch.ts

# Render gallery
npx ts-node scripts/render-samples.ts
open data/samples/index.html

# Tests
npx hardhat test

# Pi access
ssh pi@judie-2
```
