#!/bin/bash

# ── apple-music-api service uninstaller ──────────────────────────────────────

PLIST_LABEL="com.apple-music-api"
NOTIFY_LABEL="com.apple-music-notify"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
NOTIFY_DEST="$HOME/Library/LaunchAgents/${NOTIFY_LABEL}.plist"
APP_PATH="$(cd "$(dirname "$0")/.." && pwd)"

BOLD="\033[1m"
GREEN="\033[0;32m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}apple-music-api uninstaller${RESET}"
echo "──────────────────────────────────────────"

# Unload and remove API server service
if launchctl list | grep -q "$PLIST_LABEL" 2>/dev/null; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  echo -e "${GREEN}✓${RESET} API server service stopped"
else
  echo "  API server service was not running"
fi
rm -f "$PLIST_DEST"

# Unload and remove notify service
if launchctl list | grep -q "$NOTIFY_LABEL" 2>/dev/null; then
  launchctl unload "$NOTIFY_DEST" 2>/dev/null || true
  echo -e "${GREEN}✓${RESET} Notification listener stopped"
else
  echo "  Notification listener was not running"
fi
rm -f "$NOTIFY_DEST"

# Remove Python venv
if [[ -d "$APP_PATH/.venv" ]]; then
  rm -rf "$APP_PATH/.venv"
  echo -e "${GREEN}✓${RESET} Python environment removed"
elif [[ -d "$APP_PATH/venv" ]]; then
  rm -rf "$APP_PATH/venv"
  echo -e "${GREEN}✓${RESET} Python environment removed"
fi

echo ""
echo -e "${BOLD}${GREEN}Uninstall complete.${RESET}"
echo ""
echo "Note: The apple-music-api folder itself was not removed."
echo "To fully remove: rm -rf $APP_PATH"
echo ""