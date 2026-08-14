import { DEFAULTS, WILDCARD_BLOCK } from "./constants.js";

/**
 * The wildcard is pinned to the front of the blocklist on both the read and the
 * write path, so a blocklist that lost it — hand-edited storage, a sync from an
 * older install, a save from the options page — still blocks everything.
 */
export function withWildcardBlock(blockedDomains) {
  const rest = (blockedDomains || []).filter((d) => String(d).trim() !== WILDCARD_BLOCK);
  return [WILDCARD_BLOCK, ...rest];
}

export async function getSettings() {
  const result = await chrome.storage.sync.get({
    blockedDomains: DEFAULTS.blockedDomains,
    allowedDomains: DEFAULTS.allowedDomains,
    selectedCalendarId: DEFAULTS.selectedCalendarId
  });
  result.blockedDomains = withWildcardBlock(result.blockedDomains);
  return result;
}

export async function setBlockedDomains(blockedDomains) {
  await chrome.storage.sync.set({ blockedDomains: withWildcardBlock(blockedDomains) });
}

export async function setAllowedDomains(allowedDomains) {
  // Magnet URIs can be very long and are not domain allowlist entries. They are
  // already covered by the built-in DNR rule, so never waste sync storage on
  // them (or feed their tracker query strings into the domain parser).
  const savedDomains = [];
  let ignoredMagnetLinks = 0;
  for (const entry of allowedDomains || []) {
    const value = String(entry || "").trim();
    if (!value) continue;
    if (/^magnet:/i.test(value)) {
      ignoredMagnetLinks += 1;
      continue;
    }
    savedDomains.push(value);
  }

  await chrome.storage.sync.set({ allowedDomains: savedDomains });
  return { savedDomains, ignoredMagnetLinks };
}

export async function setSelectedCalendarId(selectedCalendarId) {
  await chrome.storage.sync.set({ selectedCalendarId });
}

export async function getRuntimeState() {
  const result = await chrome.storage.local.get({
    cachedClassWindows: DEFAULTS.cachedClassWindows,
    calendarTimeZone: DEFAULTS.calendarTimeZone,
    lastCalendarSyncAt: DEFAULTS.lastCalendarSyncAt,
    lastCalendarSyncError: DEFAULTS.lastCalendarSyncError,
    unlockLog: DEFAULTS.unlockLog,
    meterSessions: DEFAULTS.meterSessions,
    meterUsage: DEFAULTS.meterUsage
  });
  return result;
}

export async function setRuntimeState(patch) {
  await chrome.storage.local.set(patch);
}





