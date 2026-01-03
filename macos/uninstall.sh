#!/bin/bash
set -euo pipefail

APP_DIR="/Library/Application Support/BloqueaSitios"
PLIST_DST="/Library/LaunchDaemons/com.bloqueasitios.enforcer.plist"
AGENT_DST="/Library/LaunchAgents/com.bloqueasitios.probe.plist"
CHROME_POLICY_FILE="/Library/Managed Preferences/com.google.Chrome.plist"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo): $0"
  exit 1
fi

echo "Attempting to unload LaunchDaemon (ignore errors if not loaded)..."
/bin/launchctl bootout system "$PLIST_DST" 2>/dev/null || true

echo "Attempting to unload LaunchAgent (ignore errors if not loaded)..."
CONSOLE_UID="$(/usr/bin/stat -f%u /dev/console 2>/dev/null || true)"
if [[ -n "${CONSOLE_UID}" && "${CONSOLE_UID}" != "0" ]]; then
  /bin/launchctl bootout "gui/${CONSOLE_UID}" "$AGENT_DST" 2>/dev/null || true
fi

rm -f "$PLIST_DST"
rm -f "$AGENT_DST"

echo "Removing Chrome managed policy..."
rm -f "$CHROME_POLICY_FILE"
echo "  -> Restart Chrome after uninstall to allow extension removal"

echo "Removing helper files..."
rm -rf "$APP_DIR"
rm -f /usr/local/bin/bloqueasitios

echo "Note: if /etc/hosts still contains a BloqueaSitios section, remove it manually:"
echo "  # BEGIN BloqueaSitios (managed) ... # END BloqueaSitios (managed)"


