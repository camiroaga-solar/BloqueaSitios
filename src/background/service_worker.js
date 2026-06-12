import { ALARM_NAMES, CALENDAR_SYNC, UNLOCK_TIERS, X_LIMIT } from "../shared/constants.js";
import { getSettings, getRuntimeState, setRuntimeState } from "../shared/storage.js";
import { buildBlockingRules, buildXLimitRule, replaceDynamicRules } from "./dnr.js";
import { sendHeartbeat, reportDisabled, HEARTBEAT_MINUTES, localDateString } from "../shared/report.js";
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

// --- x.com usage metering ---
// Time counts while an x.com tab is the active tab of the focused window and the
// user isn't idle. An open viewing session is `xSession: { startedAt }`; elapsed
// time gets folded into `xUsage[date][am|pm]` on every signal (tab/focus/idle
// change, heartbeat) and the session restarts — so a dead service worker can
// lose at most one heartbeat interval of accounting.

function currentPeriod(now = new Date()) {
  return now.getHours() < 12 ? "am" : "pm";
}

function xRemainingMs(xUsage, period = currentPeriod(), now = new Date()) {
  const used = xUsage?.[localDateString(now)]?.[period] || 0;
  return Math.max(0, X_LIMIT.budgetMinutes * 60 * 1000 - used);
}

// Attribute [startMs, endMs) of viewing to date+period buckets, splitting at noon
// and midnight so a session that crosses a boundary charges each side correctly.
function foldIntoUsage(xUsage, startMs, endMs) {
  const usage = { ...(xUsage || {}) };
  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const noon = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).getTime();
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const boundary = cursor < noon ? noon : midnight;
    const chunkEnd = Math.min(endMs, boundary);
    const key = localDateString(d);
    const day = { am: 0, pm: 0, ...(usage[key] || {}) };
    day[currentPeriod(d)] += chunkEnd - cursor;
    usage[key] = day;
    cursor = chunkEnd;
  }
  // Only today's buckets matter for the budget; drop the rest.
  const today = localDateString();
  return usage[today] ? { [today]: usage[today] } : {};
}

// Fold the open viewing session (if any) into the usage buckets. If we're waking
// from a gap with no heartbeats (system sleep, browser closed), only count up to
// the last time the extension was known alive — the user wasn't viewing then.
async function reconcileXUsage(now = Date.now()) {
  const { xSession, xUsage } = await getRuntimeState();
  if (!xSession) return;
  const { lastAliveAt } = await chrome.storage.local.get("lastAliveAt");
  let end = now;
  if (lastAliveAt) {
    end = Math.min(end, Math.max(xSession.startedAt, lastAliveAt + X_LIMIT.aliveSlackMs));
  }
  const usage = foldIntoUsage(xUsage, xSession.startedAt, Math.max(xSession.startedAt, end));
  await setRuntimeState({ xUsage: usage, xSession: null });
}

function isXUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === X_LIMIT.domain || host.endsWith("." + X_LIMIT.domain);
  } catch {
    return false;
  }
}

async function isViewingX() {
  try {
    const idleState = await chrome.idle.queryState(X_LIMIT.idleDetectionSeconds);
    if (idleState !== "active") return false;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url || !isXUrl(tab.url)) return false;
    const win = await chrome.windows.get(tab.windowId);
    return Boolean(win.focused);
  } catch {
    return false;
  }
}

// DNR only stops navigations — an already-loaded SPA would keep working through
// its XHRs — so bounce any open x.com tabs once the budget is spent.
async function kickXTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: [`*://${X_LIMIT.domain}/*`, `*://*.${X_LIMIT.domain}/*`]
    });
    await Promise.all(tabs.map((t) => chrome.tabs.update(t.id, { url: "about:blank" })));
  } catch {}
}

// Recompute metering after any signal: settle the open session, then either start
// a new one (still viewing, budget left) with an alarm at the exhaustion moment,
// or enforce the block (budget spent).
async function evaluateXSession() {
  const now = Date.now();
  await reconcileXUsage(now);
  const { xUsage } = await getRuntimeState();
  const remaining = xRemainingMs(xUsage);
  const viewing = await isViewingX();

  if (viewing && remaining > 0) {
    await setRuntimeState({ xSession: { startedAt: now } });
    await chrome.alarms.create(ALARM_NAMES.xBudgetExhausted, { when: now + remaining + 250 });
  } else {
    await chrome.alarms.clear(ALARM_NAMES.xBudgetExhausted);
  }

  if (remaining <= 0) {
    await updateBlockingBasedOnState();
    await kickXTabs();
  }
}

// Serialize evaluations: concurrent signals (tab switch + focus change) could
// otherwise read the same open session and fold it twice.
let xEvalChain = Promise.resolve();
function scheduleXEval() {
  xEvalChain = xEvalChain.then(() => evaluateXSession()).catch(() => {});
  return xEvalChain;
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
  const { cachedClassWindows, tempUnlock, xUsage } = await getRuntimeState();
  const inClass = isInClassAt(cachedClassWindows, Date.now());
  const unlock = isUnlockActive(tempUnlock) ? tempUnlock : null;

  // Clear expired unlock (but not pending/delayed ones)
  const isPending = tempUnlock?.activatesAt && Date.now() < tempUnlock.activatesAt;
  if (tempUnlock && !unlock && !isPending) {
    await setRuntimeState({ tempUnlock: null });
  }

  // The x.com cap rule rides along in every state: reachable while budget remains
  // in the current half-day (even if the lists block it), hard-blocked once it's
  // spent (even in class or during an unlock).
  const xRemaining = xRemainingMs(xUsage);
  const xRule = buildXLimitRule(X_LIMIT.domain, xRemaining > 0);

  if (inClass) {
    await replaceDynamicRules([xRule]);
    return { inClass, rulesApplied: 1, unlockActive: !!unlock, xRemainingMs: xRemaining };
  }

  if (unlock && unlock.type === "all") {
    // Full unlock — remove all blocking rules (except the x.com cap)
    await replaceDynamicRules([xRule]);
    return { inClass, rulesApplied: 1, unlockActive: true, xRemainingMs: xRemaining };
  }

  if (unlock && unlock.type === "site") {
    // Unblock a specific site by adding it to the allowed list temporarily
    const tempAllowed = [...allowedDomains, unlock.site];
    const rules = [...buildBlockingRules(blockedDomains, tempAllowed), xRule];
    await replaceDynamicRules(rules);
    return { inClass, rulesApplied: rules.length, unlockActive: true, xRemainingMs: xRemaining };
  }

  const rules = [...buildBlockingRules(blockedDomains, allowedDomains), xRule];
  await replaceDynamicRules(rules);
  return { inClass, rulesApplied: rules.length, unlockActive: false, xRemainingMs: xRemaining };
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
  // Always (re)create so a changed period takes effect on reload (create replaces
  // any existing alarm with the same name).
  await chrome.alarms.create(ALARM_NAMES.heartbeat, {
    periodInMinutes: HEARTBEAT_MINUTES
  });
}

// Ping the work log that the blocker is alive, and record the timestamp locally so
// the server has a "last seen" even between reports.
async function heartbeatTick() {
  let status = null;
  try {
    await scheduleXEval(); // checkpoint x.com viewing time every heartbeat
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
    return;
  }
  if (alarm.name === ALARM_NAMES.xBudgetExhausted) {
    void scheduleXEval();
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
  if (msg?.type === "GET_X_STATUS") {
    void (async () => {
      await scheduleXEval(); // settle the open session so the numbers are current
      const { xUsage, xSession } = await getRuntimeState();
      sendResponse({
        ok: true,
        period: currentPeriod(),
        counting: Boolean(xSession),
        remaining: {
          am: xRemainingMs(xUsage, "am"),
          pm: xRemainingMs(xUsage, "pm")
        }
      });
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

// Signals that x.com viewing may have started or stopped.
chrome.tabs.onActivated.addListener(() => void scheduleXEval());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) void scheduleXEval();
});
chrome.windows.onFocusChanged.addListener(() => void scheduleXEval());
chrome.idle.setDetectionInterval(X_LIMIT.idleDetectionSeconds);
chrome.idle.onStateChanged.addListener(() => void scheduleXEval());

// Runs on every service-worker start (install, browser launch, alarm wake, or a manual
// re-enable). Make sure the alarms exist, flag a manual re-enable, and report liveness.
void (async () => {
  await ensurePeriodicAlarm();
  await checkDisabledOnBoot();
  await heartbeatTick();
})();

