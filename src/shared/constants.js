export const STORAGE_KEYS = {
  blockedDomains: "blockedDomains",
  allowedDomains: "allowedDomains",
  selectedCalendarId: "selectedCalendarId",
  calendarTimeZone: "calendarTimeZone",
  cachedClassWindows: "cachedClassWindows",
  lastCalendarSyncAt: "lastCalendarSyncAt",
  lastCalendarSyncError: "lastCalendarSyncError",
  tempUnlock: "tempUnlock",
  unlockLog: "unlockLog"
};

export const DEFAULTS = {
  blockedDomains: ["youtube.com", "reddit.com", "x.com"],
  allowedDomains: [],
  selectedCalendarId: null,
  calendarTimeZone: null,
  cachedClassWindows: [],
  lastCalendarSyncAt: null,
  lastCalendarSyncError: null,
  tempUnlock: null,
  unlockLog: []
};

export const ALARM_NAMES = {
  periodicSync: "periodicCalendarSync",
  boundaryRecheck: "boundaryRecheck",
  tempUnlockExpiry: "tempUnlockExpiry"
};

export const CALENDAR_SYNC = {
  lookaheadDays: 7,
  lookbehindMinutes: 10,
  periodicSyncMinutes: 5, // Sync every 5 minutes for faster calendar updates
  boundarySlackSeconds: 5
};






