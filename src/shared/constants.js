export const STORAGE_KEYS = {
  blockedDomains: "blockedDomains",
  allowedDomains: "allowedDomains",
  selectedCalendarId: "selectedCalendarId",
  calendarTimeZone: "calendarTimeZone",
  cachedClassWindows: "cachedClassWindows",
  lastCalendarSyncAt: "lastCalendarSyncAt",
  lastCalendarSyncError: "lastCalendarSyncError",
  tempUnlock: "tempUnlock",
  unlockLog: "unlockLog",
  xSession: "xSession",
  xUsage: "xUsage"
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
  unlockLog: [],
  xSession: null,
  xUsage: {}
};

// Special-case cap: x.com is usable for 15 minutes total in the AM and 15 in the
// PM, independent of the block/allow lists, unlock tiers, and class windows.
// Usage is metered automatically — time only counts while an x.com tab is the
// active tab of the focused window and the user isn't idle — and once the budget
// is spent, x.com is hard-blocked until the next half-day.
export const X_LIMIT = {
  domain: "x.com",
  budgetMinutes: 15,
  idleDetectionSeconds: 60,
  // When reconciling after a gap with no heartbeats (system sleep, browser
  // closed), only count viewing time up to lastAliveAt plus this slack.
  aliveSlackMs: 45 * 1000
};

export const UNLOCK_TIERS = [
  { id: "m5a", label: "5 min", delayMinutes: 0, durationMinutes: 5 },
  { id: "m5b", label: "5 min", delayMinutes: 0, durationMinutes: 5 },
  { id: "m15a", label: "15 min", delayMinutes: 0, durationMinutes: 15 },
  { id: "m15b", label: "15 min", delayMinutes: 0, durationMinutes: 15 },
  { id: "h1a", label: "1 hour", delayMinutes: 0, durationMinutes: 60 },
  { id: "h1b", label: "1 hour", delayMinutes: 0, durationMinutes: 60 }
];

// Embed exceptions: these sites may load the listed domains inside iframes
// (sub_frames) even while those domains are blocked. Direct visits and embeds
// anywhere else stay blocked. youtube-nocookie.com is YouTube's privacy-enhanced
// embed host — many sites use it instead of youtube.com.
export const EMBED_EXCEPTIONS = [
  {
    frameDomains: ["youtube.com", "youtube-nocookie.com"],
    fromDomains: ["videoele.com", "drawabox.com"]
  }
];

export const ALARM_NAMES = {
  periodicSync: "periodicCalendarSync",
  boundaryRecheck: "boundaryRecheck",
  tempUnlockExpiry: "tempUnlockExpiry",
  tempUnlockDelayActivate: "tempUnlockDelayActivate",
  xBudgetExhausted: "xBudgetExhausted",
  heartbeat: "blockerHeartbeat"
};

export const CALENDAR_SYNC = {
  lookaheadDays: 7,
  lookbehindMinutes: 10,
  periodicSyncMinutes: 5, // Sync every 5 minutes for faster calendar updates
  boundarySlackSeconds: 5,
  graceMinutes: 3 // Keep sites unblocked for this long after a lesson ends
};






