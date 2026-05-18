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

export const UNLOCK_TIERS = [
  { id: "instant1", label: "Instant 1", delayMinutes: 0 },
  { id: "instant2", label: "Instant 2", delayMinutes: 0 },
  { id: "instant3", label: "Instant 3", delayMinutes: 0 },
  { id: "instant4", label: "Instant 4", delayMinutes: 0 }
];

export const ALARM_NAMES = {
  periodicSync: "periodicCalendarSync",
  boundaryRecheck: "boundaryRecheck",
  tempUnlockExpiry: "tempUnlockExpiry",
  tempUnlockDelayActivate: "tempUnlockDelayActivate"
};

export const CALENDAR_SYNC = {
  lookaheadDays: 7,
  lookbehindMinutes: 10,
  periodicSyncMinutes: 5, // Sync every 5 minutes for faster calendar updates
  boundarySlackSeconds: 5,
  graceMinutes: 3 // Keep sites unblocked for this long after a lesson ends
};






