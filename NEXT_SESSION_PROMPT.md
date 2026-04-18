# Next Session Prompt — Session 16

> **Start here:** read this file fully, then last entry in `SESSION-LOG.md`.
> **Pi is LIVE** — cron running, agent scraping every 12h, accessible via Tailscale browser SSH at `https://login.tailscale.com` (ApocalypseTech00 account, device `judie-2`).

---

## Session 15 TL;DR

- **Pi infrastructure live.** WiFi reconnected (power save permanently off), `.env` deployed (35 keys, no deployer), code synced to `feat/redemption-mechanic`, cron installed (4 jobs: agent/mint/indexer/redemption). First live scrape: 67 quotes, guard caught 2 bad ones, 0 promoted. Residential IP confirmed working.
- **Telegram NOT configured yet** — agent scrapes + logs but can't send approval requests. This is the #1 blocker.
- **Roast quality not yet airtight** — operator wants more dry runs before trusting autonomous pipeline.

## Immediate priorities

### 1. Telegram bot (BLOCKING — no mints possible without this)
Operator needs to:
1. Create a Telegram bot via `@BotFather` on a burner Telegram account (ApocalypseTech identity)
2. Start a chat with the bot, send `/start`
3. Get chat ID: `curl "https://api.telegram.org/bot<TOKEN>/getUpdates"` → copy `message.chat.id`
4. On Pi (via Tailscale browser SSH): edit `~/misogyny-exe/.env`, set `TELEGRAM_BOT_TOKEN=` and `TELEGRAM_OPERATOR_CHAT_ID=`
5. Test: `cd ~/misogyny-exe && npx ts-node scripts/rare-agent-v6.ts --once`

### 2. More roast dry runs (operator request)
Run `npx ts-node scripts/test-roast-prompt.ts` locally (Mac). Edit `TEST_IDS` in the script to pick fresh scrapes from `data/scraper-candidates.json`. Operator wants to keep iterating until quality is consistently banger-tier. Current hit rate ~60-70%.

Key constraints (from operator feedback across Sessions 13-15):
- Target THIS SPECIFIC GUY, not "all men"
- Never assume biography (age, job, appearance)
- References must be universally understood
- Incels (ideology) = fair game; loneliness = off limits
- Vary sentence structure (no 3/3 starting with "A [noun]...")
- Tone: Ricky Gervais × Regina George × turbo-intellect

### 3. Sepolia E2E shakedown (after TG works)
On Pi: `npx ts-node scripts/rare-agent-v6.ts --once` → should scrape, promote, generate roasts, send TG approval → operator approves → mint fires on next cycle.

### 4. One-animation-per-quote render
26 confirmed quotes in `data/mint-corpus.json` → 26 cells, each with deterministic animation. Stacked hate (pink on dark) + roast (dark on pink) rows per style. All 31 styles covered (reuse 5 quotes). Run: `npx ts-node scripts/render-samples.ts`

### 5. Redemption kinetic typography
Build 8-10 templates per `~/Projects/animation-library/KINETIC-TYPOGRAPHY.md`. Wire `generate-redeemed-animation.ts`.

### 6. Front-end + mainnet deploy + launch

## Current state

- **Branch:** `feat/redemption-mechanic` at `9d45c07`
- **Pi:** `judie-2` on Tailscale, cron active, `.env` configured (minus TG). WiFi power save off. Agent ran successfully.
- **Mac:** local `.env` has all keys. Dev only.
- **Sepolia contracts:** deployed + verified.
- **Mint corpus:** 26 quotes LOCKED in `data/mint-corpus.json`. All roasts operator-approved. **Do NOT regenerate.**
- **Tests:** 233/233 passing as of Session 11.

## Key files

| File | Purpose |
|---|---|
| `scripts/rare-agent-v6.ts` | Live agent — 11 DNA principles, 5-candidate gen, validator, TG approval, calibration feedback |
| `scripts/roast-calibration.ts` | Self-improving few-shot library (12 seed bangers, grows on TG approve) |
| `scripts/roast-validator.ts` | Haiku quality gate — 8 criteria |
| `scripts/test-roast-prompt.ts` | Dry-test harness |
| `data/mint-corpus.json` | 26 LOCKED quotes |
| `data/roasts.json` | All roasts (15 manual overrides + auto) |
| `data/approved-roasts.json` | Calibration library |
| `deploy/cron.d-misogyny` | Cron config (installed to `/etc/cron.d/misogyny` on Pi) |

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

## Pi access

```bash
# Browser SSH (works from anywhere):
# https://login.tailscale.com → judie-2 → SSH

# Or from Mac terminal:
ssh pi@100.70.212.104

# Check agent logs:
tail -50 ~/misogyny-exe/logs/rare-agent-v6.log

# Manual agent run:
cd ~/misogyny-exe && npx ts-node scripts/rare-agent-v6.ts --once
```
