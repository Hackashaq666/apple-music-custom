#!/bin/bash
set -e

PLIST_LABEL="com.apple-music-api"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}apple-music-api — uninstall service${RESET}"
echo "──────────────────────────────────────────"

if [ ! -f "$PLIST_DEST" ]; then
  echo -e "${RED}✗ No installed service found at $PLIST_DEST${RESET}"
  exit 1
fi

launchctl unload -w "$PLIST_DEST" 2>/dev/null || true
rm -f "$PLIST_DEST"

echo -e "${GREEN}✓${RESET} Service stopped and unloaded"
echo -e "${GREEN}✓${RESET} Plist removed"
echo ""
echo -e "${BOLD}Done.${RESET} The server will no longer start at login."
echo "To reinstall, run:  npm run install-service"
echo ""
