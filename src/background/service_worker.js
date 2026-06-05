import { ALARM_NAMES, CALENDAR_SYNC, UNLOCK_TIERS } from "../shared/constants.js";
import { getSettings, getRuntimeState, setRuntimeState } from "../shared/storage.js";
import { buildBlockingRules, replaceDynamicRules } from "./dnr.js";
import { sendHeartbeat, reportDisabled, HEARTBEAT_MINUTES } from "../shared/report.js";
import {
  computeClassWindowsFromEvents,
  fetchEventsForCalendar,
  listCalendars,
  isInClassAt,
  nextBoundaryAfter
} from "./calendar_api.js";

// Set when these events fire so the boot check can tell *why* the worker (re)started:
// a real browser launch / install / update is benign; a bare re-enable is not.
let sawStartup = false;
let sawInstallOrUpdate = false;

function isUnlockActive(tempUnlock) {
  if (!tempUnlock) return false;
  // Not yet activated (waiting for delay)
  if (tempUnlock.activatesAt && Date.now() < tempUnlock.activatesAt) return false;
  return Date.now() < tempUnlock.until;
}

function tiersUsedToday(unlockLog) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const used = new Set();
  for (const e of unlockLog || []) {
    if (new Date(e.grantedAt).getTime() >= startOfDay && e.tier) {
      used.add(e.tier);
    }
  }
  return used;
}

async function updateBlockingBasedOnState() {
  const { blockedDomains, allowedDomains } = await getSettings();
  const { cachedClassWindows, tempUnlock } = await getRuntimeState();
  const inClass = isInClassAt(cachedClassWindows, Date.now());
  const unlock = isUnlockActive(tempUnlock) ? tempUnlock : null;

  // Clear expired unlock (but not pending/delayed ones)
  const isPending = tempUnlock?.activatesAt && Date.now() < tempUnlock.activatesAt;
  if (tempUnlock && !unlock && !isPending) {
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
  const hasHeartbeat = alarms.some((a) => a.name === ALARM_NAMES.heartbeat);
  if (!hasHeartbeat) {
    await chrome.alarms.create(ALARM_NAMES.heartbeat, {
      periodInMinutes: HEARTBEAT_MINUTES
    });
  }
}

// Ping the work log that the blocker is alive, and record the timestamp locally so
// the server has a "last seen" even between reports.
async function heartbeatTick() {
  let status = null;
  try {
    status = await updateBlockingBasedOnState();
  } catch {
    // Reporting liveness matters even if a rule refresh failed.
  }
  await chrome.storage.local.set({ lastAliveAt: Date.now() });
  await sendHeartbeat(status);
}

// Detect "the user disabled the extension and re-enabled it" without false-positiving on
// routine service-worker teardown or laptop sleep. chrome.storage.session is wiped when
// the extension is reloaded/disabled/updated or the browser restarts, but it survives the
// worker being torn down and the machine sleeping. So: session marker present => the
// extension never left; absent => it was reloaded — and if that wasn't a browser launch
// or an install/update, the only remaining cause is a manual disable→enable.
async function checkDisabledOnBoot() {
  const { swAlive } = await chrome.storage.session.get("swAlive");
  await chrome.storage.session.set({ swAlive: true });
  if (swAlive) return; // routine wake or sleep/resume — extension stayed enabled

  // Give the startup/installed events a moment to fire so we can rule them out.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  if (sawStartup || sawInstallOrUpdate) return; // browser launch / install / update

  const { lastAliveAt } = await chrome.storage.local.get("lastAliveAt");
  await reportDisabled({ gapStart: lastAliveAt || null, gapEnd: Date.now() });
}

async function reevalAll({ interactive }) {
  await ensurePeriodicAlarm();
  await syncCalendar({ interactive });
  await updateBlockingBasedOnState();
  await scheduleBoundaryRecheck();
}

chrome.runtime.onInstalled.addListener(() => {
  sawInstallOrUpdate = true;
  void reevalAll({ interactive: false });
});

chrome.runtime.onStartup.addListener(() => {
  sawStartup = true;
  void reevalAll({ interactive: false });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAMES.heartbeat) {
    void heartbeatTick();
    return;
  }
  if (alarm.name === ALARM_NAMES.periodicSync) {
    void reevalAll({ interactive: false });
    return;
  }
  if (alarm.name === ALARM_NAMES.boundaryRecheck) {
    void updateBlockingBasedOnState().then(() => scheduleBoundaryRecheck());
    return;
  }
  if (alarm.name === ALARM_NAMES.tempUnlockDelayActivate) {
    // Delay period over — apply the unlock now
    void updateBlockingBasedOnState();
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
        const { unlockType, site, tier } = msg;
        const tierDef = UNLOCK_TIERS.find((t) => t.id === tier);
        if (!tierDef) {
          sendResponse({ ok: false, error: "INVALID_TIER" });
          return;
        }
        const { unlockLog } = await getRuntimeState();
        const used = tiersUsedToday(unlockLog);
        if (used.has(tier)) {
          sendResponse({ ok: false, error: "TIER_USED" });
          return;
        }
        const now = Date.now();
        const delayMs = tierDef.delayMinutes * 60 * 1000;
        const durationMinutes = tierDef.durationMinutes;
        const activatesAt = delayMs > 0 ? now + delayMs : now;
        const until = activatesAt + durationMinutes * 60 * 1000;
        const unlock = {
          type: unlockType, // "site" or "all"
          site: unlockType === "site" ? site : null,
          tier,
          grantedAt: now,
          activatesAt: delayMs > 0 ? activatesAt : null,
          until
        };
        await setRuntimeState({ tempUnlock: unlock });
        const logEntry = {
          type: unlockType,
          site: unlock.site,
          tier,
          grantedAt: new Date(now).toISOString(),
          durationMinutes,
          expiresAt: new Date(until).toISOString()
        };
        await setRuntimeState({ unlockLog: [...unlockLog, logEntry] });
        if (delayMs > 0) {
          await chrome.alarms.create(ALARM_NAMES.tempUnlockDelayActivate, { when: activatesAt });
        }
        await chrome.alarms.create(ALARM_NAMES.tempUnlockExpiry, { when: until });
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
      await chrome.alarms.clear(ALARM_NAMES.tempUnlockDelayActivate);
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
  if (msg?.type === "GET_UNLOCKS_TODAY") {
    void (async () => {
      const { unlockLog } = await getRuntimeState();
      const used = tiersUsedToday(unlockLog);
      // Return which tier ids have been used today
      sendResponse({ ok: true, usedTiers: [...used] });
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

// Runs on every service-worker start (install, browser launch, alarm wake, or a manual
// re-enable). Make sure the alarms exist, flag a manual re-enable, and report liveness.
void (async () => {
  await ensurePeriodicAlarm();
  await checkDisabledOnBoot();
  await heartbeatTick();
})();

