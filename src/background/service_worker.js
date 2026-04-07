import { ALARM_NAMES, CALENDAR_SYNC } from "../shared/constants.js";
import { getSettings, getRuntimeState, setRuntimeState } from "../shared/storage.js";
import { buildBlockingRules, replaceDynamicRules } from "./dnr.js";
import {
  computeClassWindowsFromEvents,
  fetchEventsForCalendar,
  listCalendars,
  isInClassAt,
  nextBoundaryAfter
} from "./calendar_api.js";

function isUnlockActive(tempUnlock) {
  if (!tempUnlock) return false;
  return Date.now() < tempUnlock.until;
}

async function updateBlockingBasedOnState() {
  const { blockedDomains, allowedDomains } = await getSettings();
  const { cachedClassWindows, tempUnlock } = await getRuntimeState();
  const inClass = isInClassAt(cachedClassWindows, Date.now());
  const unlock = isUnlockActive(tempUnlock) ? tempUnlock : null;

  // Clear expired unlock
  if (tempUnlock && !unlock) {
    await setRuntimeState({ tempUnlock: null });
  }

  if (inClass) {
    await replaceDynamicRules([]);
    return { inClass, rulesApplied: 0, unlockActive: !!unlock };
  }

  if (unlock && unlock.type === "all") {
    // Full unlock — remove all blocking rules
    await replaceDynamicRules([]);
    return { inClass, rulesApplied: 0, unlockActive: true };
  }

  if (unlock && unlock.type === "site") {
    // Unblock a specific site by adding it to the allowed list temporarily
    const tempAllowed = [...allowedDomains, unlock.site];
    const rules = buildBlockingRules(blockedDomains, tempAllowed);
    await replaceDynamicRules(rules);
    return { inClass, rulesApplied: rules.length, unlockActive: true };
  }

  const rules = buildBlockingRules(blockedDomains, allowedDomains);
  await replaceDynamicRules(rules);
  return { inClass, rulesApplied: rules.length, unlockActive: false };
}

async function scheduleBoundaryRecheck() {
  const { cachedClassWindows } = await getRuntimeState();
  const nextMs = nextBoundaryAfter(cachedClassWindows, Date.now());
  await chrome.alarms.clear(ALARM_NAMES.boundaryRecheck);
  if (!nextMs) return;
  const when = nextMs + CALENDAR_SYNC.boundarySlackSeconds * 1000;
  await chrome.alarms.create(ALARM_NAMES.boundaryRecheck, { when });
}

async function syncCalendar({ interactive }) {
  const { selectedCalendarId } = await getSettings();
  if (!selectedCalendarId) {
    await setRuntimeState({
      cachedClassWindows: [],
      calendarTimeZone: null,
      lastCalendarSyncAt: Date.now(),
      lastCalendarSyncError: "No calendar selected"
    });
    return;
  }

  try {
    const { timeZone, items } = await fetchEventsForCalendar(selectedCalendarId, {
      interactive
    });
    const windows = computeClassWindowsFromEvents(items);
    await setRuntimeState({
      cachedClassWindows: windows,
      calendarTimeZone: timeZone,
      lastCalendarSyncAt: Date.now(),
      lastCalendarSyncError: null
    });
  } catch (err) {
    await setRuntimeState({
      lastCalendarSyncAt: Date.now(),
      lastCalendarSyncError: String(err?.message || err)
    });
  }
}

async function ensurePeriodicAlarm() {
  const alarms = await chrome.alarms.getAll();
  const hasPeriodic = alarms.some((a) => a.name === ALARM_NAMES.periodicSync);
  if (!hasPeriodic) {
    await chrome.alarms.create(ALARM_NAMES.periodicSync, {
      periodInMinutes: CALENDAR_SYNC.periodicSyncMinutes
    });
  }
}

async function reevalAll({ interactive }) {
  await ensurePeriodicAlarm();
  await syncCalendar({ interactive });
  await updateBlockingBasedOnState();
  await scheduleBoundaryRecheck();
}

chrome.runtime.onInstalled.addListener(() => {
  void reevalAll({ interactive: false });
});

chrome.runtime.onStartup.addListener(() => {
  void reevalAll({ interactive: false });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAMES.periodicSync) {
    void reevalAll({ interactive: false });
    return;
  }
  if (alarm.name === ALARM_NAMES.boundaryRecheck) {
    void updateBlockingBasedOnState().then(() => scheduleBoundaryRecheck());
    return;
  }
  if (alarm.name === ALARM_NAMES.tempUnlockExpiry) {
    void (async () => {
      await setRuntimeState({ tempUnlock: null });
      await updateBlockingBasedOnState();
    })();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "sync") return;
  if (changes.blockedDomains || changes.allowedDomains || changes.selectedCalendarId) {
    void reevalAll({ interactive: false });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "SYNC_NOW") {
    void reevalAll({ interactive: true }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === "LIST_CALENDARS") {
    void listCalendars({ interactive: Boolean(msg?.interactive), forceReauth: Boolean(msg?.forceReauth) })
      .then((items) => sendResponse({ ok: true, items }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg?.type === "APPLY_BLOCKING") {
    void updateBlockingBasedOnState().then((r) => sendResponse({ ok: true, ...r }));
    return true;
  }
  if (msg?.type === "TEMP_UNLOCK") {
    void (async () => {
      try {
        const { unlockType, site, durationMinutes } = msg;
        const now = Date.now();
        const until = now + durationMinutes * 60 * 1000;
        const unlock = {
          type: unlockType, // "site" or "all"
          site: unlockType === "site" ? site : null,
          grantedAt: now,
          until
        };
        // Save unlock state
        await setRuntimeState({ tempUnlock: unlock });
        // Add to log
        const { unlockLog } = await getRuntimeState();
        const logEntry = {
          type: unlockType,
          site: unlock.site,
          grantedAt: new Date(now).toISOString(),
          durationMinutes,
          expiresAt: new Date(until).toISOString()
        };
        await setRuntimeState({ unlockLog: [...unlockLog, logEntry] });
        // Set alarm to re-lock
        await chrome.alarms.create(ALARM_NAMES.tempUnlockExpiry, { when: until });
        // Apply immediately
        await updateBlockingBasedOnState();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "CANCEL_UNLOCK") {
    void (async () => {
      await chrome.alarms.clear(ALARM_NAMES.tempUnlockExpiry);
      await setRuntimeState({ tempUnlock: null });
      await updateBlockingBasedOnState();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg?.type === "GET_UNLOCK_LOG") {
    void (async () => {
      const { unlockLog } = await getRuntimeState();
      sendResponse({ ok: true, log: unlockLog });
    })();
    return true;
  }
  if (msg?.type === "CLEAR_UNLOCK_LOG") {
    void (async () => {
      await setRuntimeState({ unlockLog: [] });
      sendResponse({ ok: true });
    })();
    return true;
  }
  return false;
});

