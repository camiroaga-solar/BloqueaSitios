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

async function updateBlockingBasedOnState() {
  const { blockedDomains, allowedDomains } = await getSettings();
  const { cachedClassWindows } = await getRuntimeState();
  const inClass = isInClassAt(cachedClassWindows, Date.now());

  if (inClass) {
    await replaceDynamicRules([]);
    return { inClass, rulesApplied: 0 };
  }

  const rules = buildBlockingRules(blockedDomains, allowedDomains);
  await replaceDynamicRules(rules);
  return { inClass, rulesApplied: rules.length };
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
  return false;
});


