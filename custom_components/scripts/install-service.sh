#!/bin/bash
set -e

# ── apple-music-api service installer ────────────────────────────────────────
# Installs the server as a launchd agent so it starts automatically at login
# and restarts if it crashes. No global npm packages required.

PLIST_LABEL="com.apple-music-api"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
APP_PATH="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8181}"

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}apple-music-api installer${RESET}"
echo "──────────────────────────────────────────"

# ── 1. Check macOS ────────────────────────────────────────────────────────────
if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}✗ This server only runs on macOS.${RESET}"
  exit 1
fi
echo -e "${GREEN}✓${RESET} macOS detected"

# ── 2. Check Node.js ──────────────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js is not installed.${RESET}"
  echo ""
  echo "Install it with Homebrew:   brew install node"
  echo "Or download it from:        https://nodejs.org"
  exit 1
fi

NODE_VERSION=$(node -e "process.exit(parseInt(process.versions.node.split('.')[0]))" 2>/dev/null; echo $?)
# Re-read as integer properly
NODE_MAJOR=$(node -e "console.log(parseInt(process.versions.node.split('.')[0]))")
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo -e "${RED}✗ Node.js 18 or higher is required (found v$(node -v | tr -d v)).${RESET}"
  echo ""
  echo "Upgrade with Homebrew:   brew upgrade node"
  echo "Or use nvm:              nvm install 20 && nvm use 20"
  exit 1
fi
echo -e "${GREEN}✓${RESET} Node.js $(node -v) detected"

# ── 3. Find node binary path ──────────────────────────────────────────────────
NODE_BIN="$(which node)"

# ── 4. npm install ────────────────────────────────────────────────────────────
echo ""
echo "Installing dependencies..."
cd "$APP_PATH"
npm install --omit=dev --silent
echo -e "${GREEN}✓${RESET} Dependencies installed"

# ── 5. Create log directory ───────────────────────────────────────────────────
mkdir -p "$APP_PATH/log"
echo -e "${GREEN}✓${RESET} Log directory ready (log/)"

# ── 6. Unload any existing service ───────────────────────────────────────────
if launchctl list | grep -q "$PLIST_LABEL" 2>/dev/null; then
  echo "Unloading existing service..."
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# ── 7. Write the plist ────────────────────────────────────────────────────────
mkdir -p "$HOME/Library/LaunchAgents"
sed \
  -e "s#%APP_PATH%#$APP_PATH#g" \
  -e "s#%PORT%#$PORT#g" \
  -e "s#/usr/local/bin/node#$NODE_BIN#g" \
  "$APP_PATH/config/com.apple-music-api.plist" \
  > "$PLIST_DEST"
echo -e "${GREEN}✓${RESET} launchd plist written to $PLIST_DEST"

# ── 8. Load the service ───────────────────────────────────────────────────────
launchctl load -w "$PLIST_DEST"
echo -e "${GREEN}✓${RESET} Service loaded and set to start at login"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Installation complete!${RESET}"
echo ""
echo -e "  Server running at:  ${BOLD}http://localhost:${PORT}${RESET}"
echo -e "  Now playing:        http://localhost:${PORT}/now_playing"
echo -e "  Logs:               ${APP_PATH}/log/"
echo ""
echo "To stop the service:       npm run uninstall-service"
echo "To run in dev mode:        npm run dev"
echo ""
