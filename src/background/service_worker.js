import { ALARM_NAMES, CALENDAR_SYNC, X_LIMIT } from "../shared/constants.js";
import { getSettings, getRuntimeState, setRuntimeState } from "../shared/storage.js";
import { buildBlockingRules, buildCurfewRule, buildXLimitRule, replaceDynamicRules } from "./dnr.js";
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
// the calendar and the x.com budget alone. Any `tempUnlock` left in storage from
// an older version is inert and gets purged on boot.
async function purgeLegacyUnlock() {
  try {
    await chrome.storage.local.remove("tempUnlock");
    await chrome.alarms.clear("tempUnlockExpiry");
    await chrome.alarms.clear("tempUnlockDelayActivate");
  } catch {}
}

// --- x.com usage metering ---
// Time counts while an x.com tab is the active tab of the focused window and the
// user isn't idle. An open viewing session is `xSession: { startedAt }`; elapsed
// time gets folded into `xUsage[date][period]` on every signal (tab/focus/idle
// change, heartbeat) and the session restarts — so a dead service worker can
// lose at most one heartbeat interval of accounting.

function periodFor(now = new Date()) {
  const h = now.getHours();
  return X_LIMIT.periods.find((p) => h >= p.startHour && h < p.endHour);
}

function currentPeriod(now = new Date()) {
  return periodFor(now).id;
}

// Local-time instant at which the period containing `cursor` ends. endHour 24
// resolves to next-day midnight via Date's overflow handling.
function periodEndMs(cursor) {
  const d = new Date(cursor);
  const { endHour } = periodFor(d);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), endHour).getTime();
}

const emptyDay = () => Object.fromEntries(X_LIMIT.periods.map((p) => [p.id, 0]));

function xRemainingMs(xUsage, period = currentPeriod(), now = new Date()) {
  const used = xUsage?.[localDateString(now)]?.[period] || 0;
  return Math.max(0, X_LIMIT.budgetMinutes * 60 * 1000 - used);
}

// Attribute [startMs, endMs) of viewing to date+period buckets, splitting at each
// period boundary so a session that crosses one charges each side correctly.
function foldIntoUsage(xUsage, startMs, endMs) {
  const usage = { ...(xUsage || {}) };
  let cursor = startMs;
  while (cursor < endMs) {
    const d = new Date(cursor);
    const chunkEnd = Math.min(endMs, periodEndMs(cursor));
    const key = localDateString(d);
    const day = { ...emptyDay(), ...(usage[key] || {}) };
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

// Same reasoning for the curfew, but for every site: a page loaded at 22:59 would
// otherwise stay usable all night. chrome:// and extension pages are left alone.
// Idempotent — once a tab is on about:blank there is nothing left to kick.
async function kickAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
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

async function updateBlockingBasedOnState() {
  const { blockedDomains, allowedDomains } = await getSettings();
  const { cachedClassWindows, xUsage } = await getRuntimeState();
  const inClass = isInClassAt(cachedClassWindows, Date.now());

  // The x.com cap rule rides along in every state: reachable while budget remains
  // in the current period (even if the lists block it), hard-blocked once it's
  // spent (even in class).
  const xRemaining = xRemainingMs(xUsage);
  const xRule = buildXLimitRule(X_LIMIT.domain, xRemaining > 0);

  // Checked before everything else, and applied as the only rule: the curfew
  // takes no exceptions, so class windows and the allowlist don't get a look in.
  if (isInCurfewAt()) {
    await replaceDynamicRules([buildCurfewRule()]);
    await kickAllTabs();
    return { inClass, curfew: true, rulesApplied: 1, unlockActive: false, xRemainingMs: xRemaining };
  }

  if (inClass) {
    await replaceDynamicRules([xRule]);
    return { inClass, curfew: false, rulesApplied: 1, unlockActive: false, xRemainingMs: xRemaining };
  }

  const rules = [...buildBlockingRules(blockedDomains, allowedDomains), xRule];
  await replaceDynamicRules(rules);
  return {
    inClass,
    curfew: false,
    rulesApplied: rules.length,
    unlockActive: false,
    xRemainingMs: xRemaining
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
    await scheduleXEval(); // checkpoint x.com viewing time every heartbeat
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
  if (msg?.type === "GET_X_STATUS") {
    void (async () => {
      await scheduleXEval(); // settle the open session so the numbers are current
      const { xUsage, xSession } = await getRuntimeState();
      sendResponse({
        ok: true,
        period: currentPeriod(),
        counting: Boolean(xSession),
        remaining: Object.fromEntries(
          X_LIMIT.periods.map((p) => [p.id, xRemainingMs(xUsage, p.id)])
        )
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

