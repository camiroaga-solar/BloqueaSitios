import { DEFAULTS } from "./constants.js";

export async function getSettings() {
  const result = await chrome.storage.sync.get({
    blockedDomains: DEFAULTS.blockedDomains,
    allowedDomains: DEFAULTS.allowedDomains,
    selectedCalendarId: DEFAULTS.selectedCalendarId
  });
  return result;
}

export async function setBlockedDomains(blockedDomains) {
  await chrome.storage.sync.set({ blockedDomains });
}

export async function setAllowedDomains(allowedDomains) {
  await chrome.storage.sync.set({ allowedDomains });
}

export async function setSelectedCalendarId(selectedCalendarId) {
  await chrome.storage.sync.set({ selectedCalendarId });
}

export async function getRuntimeState() {
  const result = await chrome.storage.local.get({
    cachedClassWindows: DEFAULTS.cachedClassWindows,
    calendarTimeZone: DEFAULTS.calendarTimeZone,
    lastCalendarSyncAt: DEFAULTS.lastCalendarSyncAt,
    lastCalendarSyncError: DEFAULTS.lastCalendarSyncError
  });
  return result;
}

export async function setRuntimeState(patch) {
  await chrome.storage.local.set(patch);
}






