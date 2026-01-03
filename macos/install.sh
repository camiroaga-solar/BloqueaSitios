#!/bin/bash
set -euo pipefail

APP_DIR="/Library/Application Support/BloqueaSitios"
PLIST_DST="/Library/LaunchDaemons/com.bloqueasitios.enforcer.plist"
AGENT_DST="/Library/LaunchAgents/com.bloqueasitios.probe.plist"
CHROME_POLICY_DIR="/Library/Managed Preferences"
CHROME_POLICY_FILE="$CHROME_POLICY_DIR/com.google.Chrome.plist"
EXTENSION_ID="ocgmkfefpiimlpbgngbcbnehadhecbfk"
UPDATE_URL="https://raw.githubusercontent.com/camiroaga-solar/BloqueaSitios/main/update.xml"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo): $0"
  exit 1
fi

# Determine the interactive (console) user for LaunchAgent commands.
CONSOLE_USER="$(/usr/bin/stat -f%Su /dev/console 2>/dev/null || true)"
CONSOLE_UID="$(/usr/bin/stat -f%u /dev/console 2>/dev/null || true)"
if [[ -z "${CONSOLE_UID}" || "${CONSOLE_UID}" == "0" ]]; then
  CONSOLE_UID=""
fi

mkdir -p "$APP_DIR"

# Copy files into a root-owned location.
cp -f "$(dirname "$0")/bloqueasitios_enforcer.py" "$APP_DIR/bloqueasitios_enforcer.py"
chmod 755 "$APP_DIR/bloqueasitios_enforcer.py"

cp -f "$(dirname "$0")/bloqueasitios_probe.py" "$APP_DIR/bloqueasitios_probe.py"
chmod 755 "$APP_DIR/bloqueasitios_probe.py"

cp -f "$(dirname "$0")/bloqueasitios_ctl.py" "$APP_DIR/bloqueasitios_ctl.py"
chmod 755 "$APP_DIR/bloqueasitios_ctl.py"

# Create symlink in /usr/local/bin for easy CLI access
mkdir -p /usr/local/bin
ln -sf "$APP_DIR/bloqueasitios_ctl.py" /usr/local/bin/bloqueasitios
echo "Created /usr/local/bin/bloqueasitios symlink"

if [[ ! -f "$APP_DIR/config.json" ]]; then
  cp -f "$(dirname "$0")/config.example.json" "$APP_DIR/config.json"
  chmod 644 "$APP_DIR/config.json"
  echo "Created $APP_DIR/config.json (edit this file to match your calendar + domain list)."
else
  echo "Keeping existing $APP_DIR/config.json"
fi

# State file written by the user LaunchAgent and read by the root LaunchDaemon.
# Make it writable so the agent can update it, but keep the directory root-owned so it can't be removed without sudo.
if [[ ! -f "$APP_DIR/state.json" ]]; then
  echo '{}' > "$APP_DIR/state.json"
fi
chown root:wheel "$APP_DIR/state.json"
chmod 666 "$APP_DIR/state.json"

cp -f "$(dirname "$0")/com.bloqueasitios.enforcer.plist" "$PLIST_DST"
chmod 644 "$PLIST_DST"
chown root:wheel "$PLIST_DST"

cp -f "$(dirname "$0")/com.bloqueasitios.probe.plist" "$AGENT_DST"
chmod 644 "$AGENT_DST"
chown root:wheel "$AGENT_DST"

# Copy update.xml for Chrome extension auto-updates
cp -f "$(dirname "$0")/../update.xml" "$APP_DIR/update.xml"
chmod 644 "$APP_DIR/update.xml"

# Install Chrome managed policy to force-install the extension
mkdir -p "$CHROME_POLICY_DIR"

cat > "$CHROME_POLICY_FILE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>ExtensionInstallForcelist</key>
    <array>
        <string>${EXTENSION_ID};${UPDATE_URL}</string>
    </array>
    <key>ExtensionSettings</key>
    <dict>
        <key>${EXTENSION_ID}</key>
        <dict>
            <key>installation_mode</key>
            <string>force_installed</string>
            <key>update_url</key>
            <string>${UPDATE_URL}</string>
            <key>toolbar_pin</key>
            <string>force_pinned</string>
        </dict>
    </dict>
</dict>
</plist>
EOF

chmod 644 "$CHROME_POLICY_FILE"
chown root:wheel "$CHROME_POLICY_FILE"

echo "Installed Chrome policy at $CHROME_POLICY_FILE"
echo "  -> Restart Chrome for policy to take effect"
echo "  -> Extension will be force-installed and cannot be removed by user"

echo "Installed LaunchDaemon plist at $PLIST_DST"
echo "Installed LaunchAgent plist at $AGENT_DST"
echo
echo "To load it:"
echo "  launchctl bootstrap system \"$PLIST_DST\""
echo "  launchctl enable system/com.bloqueasitios.enforcer"
echo "  launchctl kickstart -k system/com.bloqueasitios.enforcer"
echo
echo "To load the Calendar probe (runs as your logged-in user):"
if [[ -n "${CONSOLE_UID}" ]]; then
  echo "  launchctl bootstrap gui/${CONSOLE_UID} \"$AGENT_DST\"   # user: ${CONSOLE_USER}"
  echo "  launchctl enable gui/${CONSOLE_UID}/com.bloqueasitios.probe"
  echo "  launchctl kickstart -k gui/${CONSOLE_UID}/com.bloqueasitios.probe"
else
  echo "  launchctl bootstrap gui/$(id -u) \"$AGENT_DST\""
  echo "  launchctl enable gui/$(id -u)/com.bloqueasitios.probe"
  echo "  launchctl kickstart -k gui/$(id -u)/com.bloqueasitios.probe"
fi
echo
echo "Logs:"
echo "  /var/log/bloqueasitios-enforcer.log"
echo "  /var/log/bloqueasitios-enforcer.err.log"
echo "  /tmp/bloqueasitios-probe.log"
echo "  /tmp/bloqueasitios-probe.err.log"


