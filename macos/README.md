# macOS system-wide enforcement (Safari/Firefox/etc.)

This repo is primarily a Chrome extension. **Chrome extensions cannot reliably prevent being disabled**, and they only affect Chrome-based browsers.

If you want the same calendar-driven blocking to apply to **Safari / Firefox / any browser**, this folder includes a small macOS helper that:

- Reads “class time” from the **macOS Calendar app** (which can sync your Google Calendar)
- Writes the “block/unblock decision” to a state file as your logged-in user (so it can access Calendar)
- Adds/removes a managed section in **`/etc/hosts`** via a **root LaunchDaemon** (so it’s annoying to disable without admin access)

## What “in class” means (matches the extension)

- Any **timed** event in one chosen calendar counts as class time
- **All-day events are ignored**
- Default behavior is the same as the extension:
  - **In class** → unblocked
  - **Not in class** → blocked

## Limitations (important)

- Hosts-file blocking is **domain-only**:
  - It cannot block **paths** (e.g. `domain.com/path`)
  - It cannot truly block `*` (block-all) or `*.domain.com` wildcard patterns
  - It will block `domain.com` and also `www.domain.com` automatically, but it won’t catch every subdomain unless you list them explicitly
- If you know how to change DNS / use IP addresses / use another network, you can still bypass. The point here is **friction**, not “impossible.”

## Setup

### 1) Make sure macOS Calendar is syncing your Google Calendar

- Open the **Calendar** app
- Ensure your Google account is added and the target calendar is visible
- Note the **calendar name** exactly (you’ll put it in config)

### 2) Install the helper (requires sudo)

From the repo root:

```bash
sudo ./macos/install.sh
```

This copies files into:

- `/Library/Application Support/BloqueaSitios/`
- `/Library/LaunchDaemons/com.bloqueasitios.enforcer.plist`
- `/Library/LaunchAgents/com.bloqueasitios.probe.plist`

### 3) Edit the config

Edit:

- `/Library/Application Support/BloqueaSitios/config.json`

Fields:

- `calendarName`: must match the calendar name in the Calendar app
- `behavior`:
  - `block_when_not_in_class` (default, matches extension)
  - `block_when_in_class`
- `blockedDomains`: list of domains to block

### 4) Load the LaunchDaemon

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/com.bloqueasitios.enforcer.plist
sudo launchctl enable system/com.bloqueasitios.enforcer
sudo launchctl kickstart -k system/com.bloqueasitios.enforcer
```

### 5) Load the LaunchAgent (Calendar probe)

The Calendar app is per-user, so the probe runs as your logged-in user:

```bash
launchctl bootstrap gui/$(id -u) /Library/LaunchAgents/com.bloqueasitios.probe.plist
launchctl enable gui/$(id -u)/com.bloqueasitios.probe
launchctl kickstart -k gui/$(id -u)/com.bloqueasitios.probe
```

Logs:

- `/var/log/bloqueasitios-enforcer.log`
- `/var/log/bloqueasitios-enforcer.err.log`
- `/tmp/bloqueasitios-probe.log`
- `/tmp/bloqueasitios-probe.err.log`

### Verify it’s working

- Check the probe state:

```bash
cat "/Library/Application Support/BloqueaSitios/state.json"
```

- Check if `/etc/hosts` currently has the managed section:

```bash
grep -n "BloqueaSitios (managed)" /etc/hosts
```

### Uninstall

```bash
sudo ./macos/uninstall.sh
```


