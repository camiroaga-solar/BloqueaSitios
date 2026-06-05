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
  { id: "m5a", label: "5 min", delayMinutes: 0, durationMinutes: 5 },
  { id: "m5b", label: "5 min", delayMinutes: 0, durationMinutes: 5 },
  { id: "m15a", label: "15 min", delayMinutes: 0, durationMinutes: 15 },
  { id: "m15b", label: "15 min", delayMinutes: 0, durationMinutes: 15 },
  { id: "h1a", label: "1 hour", delayMinutes: 0, durationMinutes: 60 },
  { id: "h1b", label: "1 hour", delayMinutes: 0, durationMinutes: 60 }
];

export const ALARM_NAMES = {
  periodicSync: "periodicCalendarSync",
  boundaryRecheck: "boundaryRecheck",
  tempUnlockExpiry: "tempUnlockExpiry",
  tempUnlockDelayActivate: "tempUnlockDelayActivate",
  heartbeat: "blockerHeartbeat"
};

export const CALENDAR_SYNC = {
  lookaheadDays: 7,
  lookbehindMinutes: 10,
  periodicSyncMinutes: 5, // Sync every 5 minutes for faster calendar updates
  boundarySlackSeconds: 5,
  graceMinutes: 3 // Keep sites unblocked for this long after a lesson ends
};






