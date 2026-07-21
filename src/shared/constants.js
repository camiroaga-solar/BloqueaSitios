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

// Special-case cap: x.com is usable for budgetMinutes total in each of the daily
// periods below, independent of the block/allow lists, unlock tiers, and class
// windows. Usage is metered automatically — time only counts while an x.com tab
// is the active tab of the focused window and the user isn't idle — and once a
// period's budget is spent, x.com is hard-blocked until the next period.
//
// Periods partition the local day by hour into half-open [startHour, endHour)
// spans; the last one ends at 24 (next midnight). They must be contiguous and
// cover 0–24 so every moment maps to exactly one period.
export const X_LIMIT = {
  domain: "x.com",
  budgetMinutes: 12,
  periods: [
    { id: "morning", label: "morning", startHour: 0, endHour: 12 },
    { id: "afternoon", label: "afternoon", startHour: 12, endHour: 20 },
    { id: "evening", label: "evening", startHour: 20, endHour: 24 }
  ],
  idleDetectionSeconds: 60,
  // When reconciling after a gap with no heartbeats (system sleep, browser
  // closed), only count viewing time up to lastAliveAt plus this slack.
  aliveSlackMs: 45 * 1000
};

export const UNLOCK_TIERS = [
  { id: "m5", label: "5 min", delayMinutes: 0, durationMinutes: 5 },
  { id: "m15", label: "15 min", delayMinutes: 0, durationMinutes: 15 },
  { id: "h1", label: "1 hour", delayMinutes: 0, durationMinutes: 60 }
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






