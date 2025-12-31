# BloqueaSitios (Class-aware) — Chrome Extension (MV3)

Blocks a configurable list of websites **except during class times**, where “class time” is defined as **any timed event in a single chosen Google Calendar**.

## What it does

- **Not in class**: blocked domains are blocked (main frame + iframes)
- **In class**: those domains are unblocked automatically
- **No manual override**
- **Incognito supported** (requires enabling it in Chrome for the extension)

## Setup (Google Calendar OAuth)

This extension uses `chrome.identity` + the Google Calendar API. You must create an OAuth client and paste the client ID into `manifest.json`.

### 1) Create a Google Cloud project

- In Google Cloud Console, create (or select) a project.
- Enable **Google Calendar API**.

### 2) Configure OAuth consent screen

- Add yourself as a **test user** if the app is in testing.

### 3) Create OAuth Client ID (Chrome Extension)

- Create an OAuth client of type **Chrome Extension**.
- You’ll need your extension ID:
  - Load the extension once (see “Load unpacked”), then copy its ID from `chrome://extensions`.
  - Update the OAuth client to use that extension ID if Google requires it.

### 4) Put your client ID into the manifest

Edit `manifest.json`:

- Replace:
  - `REPLACE_ME.apps.googleusercontent.com`

with your real OAuth client ID.

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this repository folder

## Enable incognito blocking

1. Go to `chrome://extensions`
2. Open details for this extension
3. Enable **Allow in incognito**

## Configure

1. Open extension **Settings** (Options page)
2. Click **Connect Google**
3. Choose your **class calendar** (all timed events count as class)
4. Click **Sync now**
5. Add blocked domains and click **Save blocklist**

## Notes / limitations

- All-day events are **ignored** (only events with `start.dateTime` / `end.dateTime` count).
- The extension caches upcoming class windows and refreshes periodically.






