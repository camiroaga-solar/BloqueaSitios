export const STORAGE_KEYS = {
  blockedDomains: "blockedDomains",
  allowedDomains: "allowedDomains",
  selectedCalendarId: "selectedCalendarId",
  calendarTimeZone: "calendarTimeZone",
  cachedClassWindows: "cachedClassWindows",
  lastCalendarSyncAt: "lastCalendarSyncAt",
  lastCalendarSyncError: "lastCalendarSyncError",
  unlockLog: "unlockLog",
  meterSessions: "meterSessions",
  meterUsage: "meterUsage"
};

// The blocklist entry that blocks every site. It is pinned: storage always reads
// and writes it back, so the only way through is the allowlist (or a class
// window). Removing it from the options textarea does nothing.
export const WILDCARD_BLOCK = "*";

export const DEFAULTS = {
  blockedDomains: [
    WILDCARD_BLOCK,
    "youtube.com",
    "reddit.com",
    "x.com",
    "tiktok.com",
    "instagram.com",
    "facebook.com"
  ],
  allowedDomains: [],
  selectedCalendarId: null,
  calendarTimeZone: null,
  cachedClassWindows: [],
  lastCalendarSyncAt: null,
  lastCalendarSyncError: null,
  unlockLog: [],
  meterSessions: {},
  meterUsage: {}
};

// Periods partition the local day by hour into half-open [startHour, endHour)
// spans; the last one ends at 24 (next midnight). They must be contiguous and
// cover 0–24 so every moment maps to exactly one period.
const THIRDS_OF_DAY = [
  { id: "morning", label: "morning", startHour: 0, endHour: 12 },
  { id: "afternoon", label: "afternoon", startHour: 12, endHour: 20 },
  { id: "evening", label: "evening", startHour: 20, endHour: 24 }
];

// One bucket for the whole day: the budget is spent once, not per half-day.
const WHOLE_DAY = [{ id: "day", label: "today", startHour: 0, endHour: 24 }];

// Special-case caps: each domain here is usable for budgetMinutes total in each
// of its periods, independent of the block/allow lists, unlock tiers, and class
// windows. Usage is metered automatically — time only counts while a tab on that
// domain is the active tab of the focused window and the user isn't idle — and
// once a period's budget is spent the domain is hard-blocked until the next one.
//
// `id` keys the stored usage buckets, so renaming one resets its budget.
export const METERED_LIMITS = [
  { id: "x", domain: "x.com", label: "x.com", budgetMinutes: 12, periods: THIRDS_OF_DAY },
  { id: "tiktok", domain: "tiktok.com", label: "TikTok", budgetMinutes: 3, periods: WHOLE_DAY },
  {
    id: "instagram",
    domain: "instagram.com",
    label: "Instagram",
    budgetMinutes: 3,
    periods: WHOLE_DAY
  },
  { id: "reddit", domain: "reddit.com", label: "Reddit", budgetMinutes: 5, periods: WHOLE_DAY },
  {
    id: "facebook",
    domain: "facebook.com",
    label: "Facebook",
    budgetMinutes: 5,
    periods: WHOLE_DAY
  }
];

export const METER = {
  idleDetectionSeconds: 60,
  // When reconciling after a gap with no heartbeats (system sleep, browser
  // closed), only count viewing time up to lastAliveAt plus this slack.
  aliveSlackMs: 45 * 1000
};

// Nightly curfew. Between these local hours every site is blocked with no
// exceptions at all — not the allowlist, not the built-in Google services, not
// class windows. The window wraps midnight whenever startHour > endHour.
export const CURFEW = {
  startHour: 23, // 11:00pm
  endHour: 6 // 6:00am
};

// Google services that stay reachable even though `*` blocks everything, without
// having to trust the allowlist. Deliberately host-scoped: `www.google.com` is
// NOT here, so Search and Images have no allow rule covering them and stay
// caught by the wildcard block. Entries match subdomains too, so
// `cloud.google.com` covers `console.cloud.google.com`.
export const GOOGLE_SERVICE_ALLOW = [
  "accounts.google.com", // sign-in — every other service depends on it
  "myaccount.google.com",
  "mail.google.com", // Gmail
  "drive.google.com", // Drive
  "docs.google.com", // Docs / Sheets / Slides / Forms
  "calendar.google.com",
  "meet.google.com",
  "chat.google.com",
  "contacts.google.com",
  "keep.google.com",
  "photos.google.com",
  "groups.google.com",
  "script.google.com", // Apps Script
  "takeout.google.com",
  "translate.google.com",
  "cloud.google.com", // Cloud docs + console.cloud.google.com
  "firebase.google.com", // + console.firebase.google.com
  "developers.google.com",
  "console.developers.google.com",
  "analytics.google.com",
  "search.google.com", // Search Console — not web search
  "research.google.com", // + colab.research.google.com
  "aistudio.google.com",
  "gemini.google.com",
  "maps.google.com",
  "google.com/maps", // path-scoped: Maps without opening the rest of www
  "googleusercontent.com", // Drive downloads / Gmail attachments
  "usercontent.google.com", // Current Drive download host (drive.usercontent.google.com)
  "googleapis.com",
  "gstatic.com"
];

// Google's search surfaces, blocked unconditionally at a priority that outranks
// every allow rule — so they stay blocked even if google.com or *.google.com
// ends up on the allowlist. Add ccTLDs here as needed.
const GOOGLE_SEARCH_DOMAINS = ["google.com", "google.cl"];

// Path prefixes on those domains. The `^` pins the end of the path segment, so
// `search.google.com/search-console` (Search Console) and
// `drive.google.com/drive/search` (Drive's own search) are NOT caught — only a
// path that begins right after the host, e.g. `www.google.com/search?q=…`.
// Image results live at `/search?tbm=isch`, so `/search` covers them too.
const GOOGLE_SEARCH_PATHS = [
  "/search", // web, image, news and video results
  "/imghp", // Images home
  "/imgres", // image result viewer
  "/webhp" // search home with the query box
];

// Hosts that are search surfaces in their own right.
const GOOGLE_SEARCH_HOSTS = ["images.google.com", "lens.google.com"];

export const HARD_BLOCK_URL_FILTERS = [
  ...GOOGLE_SEARCH_DOMAINS.flatMap((d) => GOOGLE_SEARCH_PATHS.map((p) => `||${d}${p}^`)),
  ...GOOGLE_SEARCH_HOSTS.map((h) => `||${h}^`)
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
  // One alarm per metered limit: `${meterExhaustedPrefix}${limit.id}`.
  meterExhaustedPrefix: "meterExhausted:",
  heartbeat: "blockerHeartbeat"
};

export const CALENDAR_SYNC = {
  lookaheadDays: 7,
  lookbehindMinutes: 10,
  periodicSyncMinutes: 5, // Sync every 5 minutes for faster calendar updates
  boundarySlackSeconds: 5,
  graceMinutes: 3 // Keep sites unblocked for this long after a lesson ends
};





