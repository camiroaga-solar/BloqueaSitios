import { CALENDAR_SYNC } from "../shared/constants.js";

function isoNowMinus(minutes) {
  const d = new Date(Date.now() - minutes * 60_000);
  return d.toISOString();
}

function isoNowPlusDays(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60_000);
  return d.toISOString();
}

async function getAuthToken({ interactive }) {
  return await new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || "Failed to get auth token"));
        return;
      }
      if (!token) {
        reject(new Error("Not signed in. Click “Connect Google” to authorize."));
        return;
      }
      resolve(token);
    });
  });
}

async function googleApiFetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const message =
      (json && (json.error?.message || json.error_description)) ||
      `Google API request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function tokenInfoSummary(token) {
  try {
    const url = `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(
      token
    )}`;
    const res = await fetch(url);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, body: json };
    }
    return {
      ok: true,
      audience: json.aud || null,
      scope: json.scope || null,
      expires_in: json.expires_in || null
    };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

async function googleApiFetchJsonAuthed(url, { interactive }) {
  // Retry once on 401 by clearing cached token (common after scope/client changes).
  let token = await getAuthToken({ interactive });
  try {
    return await googleApiFetchJson(url, token);
  } catch (err) {
    if (err?.status !== 401) throw err;
    const info = await tokenInfoSummary(token);
    await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    token = await getAuthToken({ interactive: true });
    try {
      return await googleApiFetchJson(url, token);
    } catch (err2) {
      if (err2?.status === 401) {
        const info2 = await tokenInfoSummary(token);
        const hint =
          "Auth token rejected by Google APIs. This is usually caused by an OAuth client/extension-id mismatch or a stale cached token.";
        const details = JSON.stringify(
          {
            firstToken: info,
            secondToken: info2
          },
          null,
          2
        );
        const e = new Error(`${hint}\n\nDiagnostics:\n${details}`);
        e.status = 401;
        throw e;
      }
      throw err2;
    }
  }
}

export async function listCalendars({ interactive, forceReauth }) {
  const url =
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader";
  if (forceReauth) {
    // Force re-consent by clearing cached token first.
    const token = await getAuthToken({ interactive: false }).catch(() => null);
    if (token) {
      await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
    }
  }
  const json = await googleApiFetchJsonAuthed(url, { interactive });
  const items = json.items || [];
  return items.map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: Boolean(c.primary),
    accessRole: c.accessRole,
    timeZone: c.timeZone || null
  }));
}

export async function fetchEventsForCalendar(calendarId, { interactive }) {
  const timeMin = isoNowMinus(CALENDAR_SYNC.lookbehindMinutes);
  const timeMax = isoNowPlusDays(CALENDAR_SYNC.lookaheadDays);
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "2500"
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(
    calendarId
  )}/events?${params.toString()}`;
  const json = await googleApiFetchJsonAuthed(url, { interactive });
  return {
    timeZone: json.timeZone || null,
    items: json.items || []
  };
}

export function computeClassWindowsFromEvents(events) {
  // We only count timed events (start.dateTime/end.dateTime). Ignore all-day events.
  const windows = [];
  for (const ev of events || []) {
    const start = ev?.start?.dateTime;
    const end = ev?.end?.dateTime;
    if (!start || !end) continue;
    const startMs = Date.parse(start);
    const endMs = Date.parse(end);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (endMs <= startMs) continue;
    windows.push({ startMs, endMs });
  }
  windows.sort((a, b) => a.startMs - b.startMs);

  // Merge overlaps
  const merged = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (!last || w.startMs > last.endMs) merged.push({ ...w });
    else last.endMs = Math.max(last.endMs, w.endMs);
  }
  return merged;
}

export function isInClassAt(windows, nowMs = Date.now()) {
  for (const w of windows || []) {
    if (nowMs >= w.startMs && nowMs < w.endMs) return true;
  }
  return false;
}

export function nextBoundaryAfter(windows, nowMs = Date.now()) {
  let next = null;
  for (const w of windows || []) {
    if (w.startMs > nowMs) next = next === null ? w.startMs : Math.min(next, w.startMs);
    if (w.endMs > nowMs) next = next === null ? w.endMs : Math.min(next, w.endMs);
  }
  return next;
}


