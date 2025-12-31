export const STORAGE_KEYS = {
  blockedDomains: "blockedDomains",
  allowedDomains: "allowedDomains",
  selectedCalendarId: "selectedCalendarId",
  calendarTimeZone: "calendarTimeZone",
  cachedClassWindows: "cachedClassWindows",
  lastCalendarSyncAt: "lastCalendarSyncAt",
  lastCalendarSyncError: "lastCalendarSyncError"
};

export const DEFAULTS = {
  blockedDomains: ["youtube.com", "reddit.com", "x.com"],
  allowedDomains: [],
  selectedCalendarId: null,
  calendarTimeZone: null,
  cachedClassWindows: [],
  lastCalendarSyncAt: null,
  lastCalendarSyncError: null
};

export const ALARM_NAMES = {
  periodicSync: "periodicCalendarSync",
  boundaryRecheck: "boundaryRecheck"
};

export const CALENDAR_SYNC = {
  lookaheadDays: 7,
  lookbehindMinutes: 10,
  periodicSyncMinutes: 5, // Sync every 5 minutes for faster calendar updates
  boundarySlackSeconds: 5
};






