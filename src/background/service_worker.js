import { ALARM_NAMES, CALENDAR_SYNC, METER, METERED_LIMITS } from "../shared/constants.js";
import { getSettings, getRuntimeState, setRuntimeState } from "../shared/storage.js";
import { buildBlockingRules, buildCurfewRule, buildMeterRules, replaceDynamicRules } from "./dnr.js";
import { isInCurfewAt, nextCurfewBoundaryAfter } from "../shared/curfew.js";
import { sendHeartbeat, reportDisabled, getActivePomodoro, sendPomodoroSample, HEARTBEAT_MINUTES, localDateString } from "../shared/report.js";
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

// There is deliberately no way to grant a temporary unlock: no UI, no message
// handler, and no code path that reads a stored unlock. Blocking is decided by
// the calendar and the metered budgets alone. Any `tempUnlock` left in storage
// from an older version is inert and gets purged on boot.
async function purgeLegacyUnlock() {
  try {
    await chrome.storage.local.remove("tempUnlock");
    await chrome.alarms.clear("tempUnlockExpiry");
    await chrome.alarms.clear("tempUnlockDelayActivate");
  } catch {}
}

// The meters used to be x.com-only, keyed `xUsage`/`xSession`. Carry today's
// spent time over on first boot after the update so the budget isn't handed back.
async function migrateLegacyXMeter() {
  try {
    const { xUsage, xSession } = await chrome.storage.local.get(["xUsage", "xSession"]);
    if (xUsage === undefined && xSession === undefined) return;
    const { meterUsage, meterSessions } = await getRuntimeState();
    await setRuntimeState({
      meterUsage: { ...(meterUsage || {}), x: xUsage || {} },
      meterSessions: xSession ? { ...(meterSessions || {}), x: xSession } : meterSessions || {}
    });
    await chrome.storage.local.remove(["xUsage", "xSession"]);
    await chrome.alarms.clear("xBudgetExhausted");
  } catch {}
}

// --- Metered usage ---
// Time counts while a tab on a metered domain is the active tab of the focused
// window and the user isn't idle. An open viewing session is
// `meterSessions[limitId]: { startedAt }`; elapsed time gets folded into
// `meterUsage[limitId][date][period]` on every signal (tab/focus/idle change,
// heartbeat) and the session restarts — so a dead service worker can lose at
// most one heartbeat interval of accounting.

function periodFor(limit, now = new Date()) {
  const h = now.getHours();
  return limit.periods.find((p) => h >= p.startHour && h < p.endHour);
}

function currentPeriod(limit, now = new Date()) {
  return periodFor(limit, now).id;
}

// Local-time instant at which the period containing `cursor` ends. endHour 24
// resolves to next-day midnight via Date's overflow handling.
function periodEndMs(limit, cursor) {
  const d = new Date(cursor);
  const { endHour } = periodFor(limit, d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), endHour).getTime();
}

const emptyDay = (limit) => Object.fromEntries(limit.periods.map((p) => [p.id, 0]));

function remainingMs(limit, meterUsage, period = currentPeriod(limit), now = new Date()) {
  const used = meterUsage?.[limit.id]?.[localDateString(now)]?.[period] || 0;
  return Math.max(0, limit.budgetMinutes * 60 * 1000 - used);
}

// Attribute [startMs, endMs) of viewing to date+period buckets for one limit,
// splitting at each period boundary so a session that crosses one charges each
// side correctly.
function foldIntoUsage(meterUsage, limit, startMs, endMs) {
  const all = { ...(meterUsage || {}) };
  const forLimit = { ...(all[limit.id] || {}) };
  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const chunkEnd = Math.min(endMs, periodEndMs(limit, cursor));
    const key = localDateString(d);
    const day = { ...emptyDay(limit), ...(forLimit[key] || {}) };
    day[currentPeriod(limit, d)] += chunkEnd - cursor;
    forLimit[key] = day;
    cursor = chunkEnd;
  }
  // Only today's buckets matter for the budget; drop the rest.
  const today = localDateString();
  all[limit.id] = forLimit[today] ? { [today]: forLimit[today] } : {};
  return all;
}

// Fold the open viewing sessions (if any) into the usage buckets. If we're waking
// from a gap with no heartbeats (system sleep, browser closed), only count up to
// the last time the extension was known alive — the user wasn't viewing then.
async function reconcileUsage(now = Date.now()) {
  const { meterSessions, meterUsage } = await getRuntimeState();
  const sessions = meterSessions || {};
  const open = METERED_LIMITS.filter((limit) => sessions[limit.id]?.startedAt);
  if (!open.length) return;
  const { lastAliveAt } = await chrome.storage.local.get("lastAliveAt");
  let usage = meterUsage || {};
  for (const limit of open) {
    const { startedAt } = sessions[limit.id];
    let end = now;
    if (lastAliveAt) {
      end = Math.min(end, Math.max(startedAt, lastAliveAt + METER.aliveSlackMs));
    }
    usage = foldIntoUsage(usage, limit, startedAt, Math.max(startedAt, end));
  }
  await setRuntimeState({ meterUsage: usage, meterSessions: {} });
}

function limitForUrl(url) {
  try {
    const host = new URL(url).hostname;
    return (
      METERED_LIMITS.find((l) => host === l.domain || host.endsWith("." + l.domain)) || null
    );
  } catch {
    return null;
  }
}

// The metered limit the user is actually looking at right now, if any.
async function limitBeingViewed() {
  try {
    const idleState = await chrome.idle.queryState(METER.idleDetectionSeconds);
    if (idleState !== "active") return null;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.url) return null;
    const limit = limitForUrl(tab.url);
    if (!limit) return null;
    const win = await chrome.windows.get(tab.windowId);
    return win.focused ? limit : null;
  } catch {
    return null;
  }
}

// DNR only stops navigations — an already-loaded SPA would keep working through
// its XHRs — so bounce any open tabs on that domain once the budget is spent.
async function kickTabsFor(domain) {
  try {
    const tabs = await chrome.tabs.query({
      url: [`*://${domain}/*`, `*://*.${domain}/*`]
    });
    await Promise.all(tabs.map((t) => chrome.tabs.update(t.id, { url: "about:blank" })));
  } catch {}
}

// Same reasoning for the curfew, but for every site: a page loaded at 22:59 would
// otherwise stay usable all night. chrome:// and extension pages are left alone.
// Idempotent — once a tab is on about:blank there is nothing left to kick.
async function kickAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.all(tabs.map((t) => chrome.tabs.update(t.id, { url: "about:blank" })));
  } catch {}
}

const exhaustedAlarmName = (limit) => `${ALARM_NAMES.meterExhaustedPrefix}${limit.id}`;

// Recompute metering after any signal: settle the open sessions, then either
// start a new one (still viewing, budget left) with an alarm at the exhaustion
// moment, or enforce the block (budget spent). At most one limit can be viewed
// at a time, so the others simply stay closed.
async function evaluateMeters() {
  const now = Date.now();
  await reconcileUsage(now);
  const { meterUsage } = await getRuntimeState();
  const viewing = await limitBeingViewed();

  const sessions = {};
  const spent = [];
  for (const limit of METERED_LIMITS) {
    const remaining = remainingMs(limit, meterUsage);
    if (viewing?.id === limit.id && remaining > 0) {
      sessions[limit.id] = { startedAt: now };
      await chrome.alarms.create(exhaustedAlarmName(limit), { when: now + remaining + 250 });
    } else {
      await chrome.alarms.clear(exhaustedAlarmName(limit));
    }
    if (remaining <= 0) spent.push(limit);
  }
  await setRuntimeState({ meterSessions: sessions });

  if (spent.length) {
    await updateBlockingBasedOnState();
    await Promise.all(spent.map((limit) => kickTabsFor(limit.domain)));
  }
}

// Serialize evaluations: concurrent signals (tab switch + focus change) could
// otherwise read the same open session and fold it twice.
let meterEvalChain = Promise.resolve();
function scheduleMeterEval() {
  meterEvalChain = meterEvalChain.then(() => evaluateMeters()).catch(() => {});
  return meterEvalChain;
}

async function updateBlockingBasedOnState() {
  const { blockedDomains, allowedDomains } = await getSettings();
  const { cachedClassWindows, meterUsage } = await getRuntimeState();
  const inClass = isInClassAt(cachedClassWindows, Date.now());

  // The cap rules ride along in every state: each metered domain is reachable
  // while budget remains in its current period (even if the lists block it), and
  // hard-blocked once that budget is spent (even in class).
  const remainingByLimit = Object.fromEntries(
    METERED_LIMITS.map((limit) => [limit.id, remainingMs(limit, meterUsage)])
  );
  const meterRules = buildMeterRules(
    METERED_LIMITS.map((limit) => ({
      domain: limit.domain,
      hasBudget: remainingByLimit[limit.id] > 0
    }))
  );
  const meterState = {
    unlockActive: false,
    meterRemainingMs: remainingByLimit,
    xRemainingMs: remainingByLimit.x // kept for the work log's existing field
  };

  // Checked before everything else, and applied as the only rule: the curfew
  // takes no exceptions, so class windows and the allowlist don't get a look in.
  if (isInCurfewAt()) {
    await replaceDynamicRules([buildCurfewRule()]);
    await kickAllTabs();
    return { inClass, curfew: true, rulesApplied: 1, ...meterState };
  }

  if (inClass) {
    await replaceDynamicRules(meterRules);
    return { inClass, curfew: false, rulesApplied: meterRules.length, ...meterState };
  }

  const rules = [...buildBlockingRules(blockedDomains, allowedDomains), ...meterRules];
  await replaceDynamicRules(rules);
  return {
    inClass,
    curfew: false,
    rulesApplied: rules.length,
    ...meterState
  };
}

// Wake at whichever comes first: a class window starting/ending, or the curfew
// switching on/off. The curfew always has a next boundary, so unlike before
// there is always an alarm pending.
async function scheduleBoundaryRecheck() {
  const { cachedClassWindows } = await getRuntimeState();
  const now = Date.now();
  const classNext = nextBoundaryAfter(cachedClassWindows, now);
  const curfewNext = nextCurfewBoundaryAfter(now);
  const nextMs = classNext ? Math.min(classNext, curfewNext) : curfewNext;
  await chrome.alarms.clear(ALARM_NAMES.boundaryRecheck);
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
    await scheduleMeterEval(); // checkpoint metered viewing time every heartbeat
    status = await updateBlockingBasedOnState();
  } catch {
    // Reporting liveness matters even if a rule refresh failed.
  }
  await chrome.storage.local.set({ lastAliveAt: Date.now() });
  await sendHeartbeat(status);
  await samplePomodoroTab();
}

// If a pomodoro is running, report the active tab's domain + title — but only
// when the user is actually at the keyboard, so AFK time doesn't count as work.
async function samplePomodoroTab() {
  try {
    const pomo = await getActivePomodoro();
    if (!pomo) return;
    const idleState = await chrome.idle.queryState(60);
    if (idleState !== "active") return;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) return; // skip chrome:// and extension pages
    let host = "";
    try { host = new URL(tab.url).hostname; } catch { return; }
    await sendPomodoroSample({ sessionId: pomo.sessionId, host, title: tab.title || "" });
  } catch {
    // Sampling is best-effort; never let it break the heartbeat.
  }
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
  await purgeLegacyUnlock();
  await migrateLegacyXMeter();
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
  if (alarm.name.startsWith(ALARM_NAMES.meterExhaustedPrefix)) {
    void scheduleMeterEval();
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
  // Read-only: the log keeps the history of unlocks granted before the feature
  // was removed. Nothing can add to it.
  if (msg?.type === "GET_UNLOCK_LOG") {
    void (async () => {
      const { unlockLog } = await getRuntimeState();
      sendResponse({ ok: true, log: unlockLog });
    })();
    return true;
  }
  // Ground truth for the popup: re-apply the rules, then read back what Chrome
  // actually holds. Computing the state in the popup instead would let it claim
  // "blocked" while the worker was running stale code with stale rules.
  if (msg?.type === "GET_STATUS") {
    void (async () => {
      try {
        const state = await updateBlockingBasedOnState();
        const active = await chrome.declarativeNetRequest.getDynamicRules();
        sendResponse({ ok: true, ...state, activeRules: active.length });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }
  if (msg?.type === "GET_METER_STATUS") {
    void (async () => {
      await scheduleMeterEval(); // settle the open session so the numbers are current
      const { meterUsage, meterSessions } = await getRuntimeState();
      sendResponse({
        ok: true,
        limits: METERED_LIMITS.map((limit) => ({
          id: limit.id,
          period: currentPeriod(limit),
          counting: Boolean(meterSessions?.[limit.id]),
          remaining: Object.fromEntries(
            limit.periods.map((p) => [p.id, remainingMs(limit, meterUsage, p.id)])
          )
        }))
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

// Signals that viewing of a metered domain may have started or stopped.
chrome.tabs.onActivated.addListener(() => void scheduleMeterEval());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url && tab.active) void scheduleMeterEval();
});
chrome.windows.onFocusChanged.addListener(() => void scheduleMeterEval());
chrome.idle.setDetectionInterval(METER.idleDetectionSeconds);
chrome.idle.onStateChanged.addListener(() => void scheduleMeterEval());

// Runs on every service-worker start (install, browser launch, alarm wake, or a manual
// re-enable). Make sure the alarms exist, flag a manual re-enable, and report liveness.
void (async () => {
  await ensurePeriodicAlarm();
  // Before the first heartbeat, so the meter checkpoint sees today's carried-over usage.
  await migrateLegacyXMeter();
  await checkDisabledOnBoot();
  await heartbeatTick();
})();

