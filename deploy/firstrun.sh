#!/usr/bin/env bash
# MISOGYNY.EXE V6 — Pi first-run setup
#
# Run on a fresh Raspberry Pi OS Lite 64-bit (Bookworm) install.
# SSH in first (via Tailscale), then: bash firstrun.sh
# Per V6 spec §12.4.

set -euo pipefail

echo "=== MISOGYNY.EXE V6 — Pi Setup ==="
echo ""

# --- 0. Pre-flight ---
if [ "$(whoami)" != "pi" ]; then
  echo "WARNING: expected to run as user 'pi'. You are '$(whoami)'."
  echo "V6 spec mandates user 'pi'. Continue at your own risk."
  read -p "Continue? (y/N) " ans
  [ "$ans" = "y" ] || exit 1
fi

# --- 1. System update + apt deps ---
echo "[1/7] Updating system + installing apt deps..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y \
  curl git build-essential \
  chromium ffmpeg \
  logrotate

# --- 2. Node.js 20 (arm64) ---
echo ""
echo "[2/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
echo "  Node: $(node --version)"
echo "  npm:  $(npm --version)"

# --- 3. 2GB swap file (per spec §12.4) ---
echo ""
echo "[3/7] Creating 2GB swap file..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q "/swapfile" /etc/fstab; then
    echo "/swapfile none swap sw 0 0" | sudo tee -a /etc/fstab
  fi
  echo "  swap on"
else
  echo "  /swapfile already exists, skipping"
fi

# --- 4. Tailscale ---
echo ""
echo "[4/7] Installing Tailscale..."
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
  echo "  >>> Run 'sudo tailscale up' and log in with the ApocalypseTech00 burner account <<<"
  echo "  >>> After login, the Pi is reachable from anywhere on the tailnet <<<"
else
  echo "  Tailscale already installed"
fi

# --- 5. Clone project (SSH deploy key) ---
echo ""
echo "[5/7] Cloning project..."
cd ~
if [ -d "misogyny-exe" ]; then
  echo "  Project already exists, pulling latest..."
  cd misogyny-exe && git pull
else
  # V6 spec §12.4: use SSH deploy key, not HTTPS
  # Operator must have added the Pi's SSH public key to ApocalypseTech00/misogyny-exe deploy keys first.
  git clone git@github.com:ApocalypseTech00/misogyny-exe.git
  cd misogyny-exe
fi
npm install
echo "  dependencies installed"

# --- 6. .env setup ---
echo ""
echo "[6/7] .env setup..."
if [ ! -f .env ]; then
  echo "  No .env found. Copy it from your laptop over Tailscale:"
  echo "    scp .env pi@judie-2:~/misogyny-exe/.env"
  echo ""
  echo "  Required V6 env vars (see .env.example for full list):"
  echo "    PRIVATE_KEY + BOT_ADDRESS"
  echo "    DEPLOYER_A_ADDRESS + DEPLOYER_B_ADDRESS + TREASURY_ADDRESS"
  echo "    QUEUE_HMAC_SECRET (openssl rand -hex 32)"
  echo "    RARE_CONTRACT_ADDRESS, COLLECTION_ADMIN_ADDRESS, SPLIT_GUARD_ADDRESS,"
  echo "    QUOTE_REGISTRY_ADDRESS, PRIMARY_SPLITTER_ADDRESS, SECONDARY_SPLITTER_ADDRESS"
  echo "    CHARITY_ADDRESS, ARTIST_ADDRESS, PROJECT_ADDRESS"
  echo "    PINATA_JWT, ANTHROPIC_API_KEY"
  echo "    TELEGRAM_BOT_TOKEN + TELEGRAM_OPERATOR_CHAT_ID"
  echo "    BLUESKY_HANDLE + BLUESKY_APP_PASSWORD"
  echo "    HEALTHCHECK_URL"
else
  chmod 600 .env
  echo "  .env exists, permissions set to 600"
fi

# --- 7. Logrotate + cron ---
echo ""
echo "[7/7] Installing logrotate + cron jobs..."

# Logrotate config — daily, keep 14 days, compress older than 1 day
sudo tee /etc/logrotate.d/misogyny-exe > /dev/null <<'LOGROTATE'
/home/pi/misogyny-exe/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
LOGROTATE
echo "  /etc/logrotate.d/misogyny-exe installed"

# Cron jobs
sudo cp deploy/cron.d-misogyny /etc/cron.d/misogyny-exe
sudo chmod 644 /etc/cron.d/misogyny-exe
sudo systemctl restart cron
echo "  /etc/cron.d/misogyny-exe installed"

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. scp .env pi@judie-2:~/misogyny-exe/.env  (from laptop)"
echo "  2. sudo tailscale up (if not already running)"
echo "  3. (optional) AGENT_DRY_RUN=true npx ts-node scripts/rare-agent-v6.ts"
echo "  4. Check logs: tail -f logs/rare-agent-v6.log"
echo ""
echo "Cron jobs will fire automatically per /etc/cron.d/misogyny-exe."
echo "Access from anywhere via: ssh pi@judie-2"
