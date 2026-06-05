// Reports the extension's liveness to the AppTrabajo work log so it can show a
// "blocker was disabled today" flag for accountability.
//
// SETUP: set these two to your real values before loading the extension.
//   - APP_BASE_URL  : your AppTrabajo deploy origin (also add it to manifest host_permissions)
//   - BLOCKER_TOKEN : must equal the BLOCKER_TOKEN env var configured in AppTrabajo/Vercel
export const APP_BASE_URL = "https://REPLACE_ME.vercel.app";
export const BLOCKER_TOKEN = "2f6fa6c5e6b647c884cd11dda928c7c3";

export const HEARTBEAT_MINUTES = 1;
// How long a silence must be before we treat it as "the extension was off".
export const GAP_THRESHOLD_MS = 5 * 60 * 1000;

// YYYY-MM-DD in the user's local time (matches how AppTrabajo computes "today").
export function localDateString(date = new Date()) {
  const tz = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tz).toISOString().slice(0, 10);
}

async function post(payload) {
  if (!APP_BASE_URL || APP_BASE_URL.includes("REPLACE_ME")) return; // not configured yet
  try {
    await fetch(`${APP_BASE_URL}/api/blocker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-blocker-token": BLOCKER_TOKEN
      },
      body: JSON.stringify(payload)
    });
  } catch {
    // Network errors are expected (offline, server down) — ignore.
  }
}

export async function sendHeartbeat(status) {
  await post({ type: "heartbeat", at: Date.now(), status: status || null });
}

export async function reportDisabled({ gapStart, gapEnd } = {}) {
  await post({
    type: "disabled",
    localDate: localDateString(),
    gapStart: gapStart ?? null,
    gapEnd: gapEnd ?? null,
    reason: "re-enabled"
  });
}
