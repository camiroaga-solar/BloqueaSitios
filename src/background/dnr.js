import {
  EMBED_EXCEPTIONS,
  GOOGLE_SERVICE_ALLOW,
  HARD_BLOCK_URL_FILTERS,
  WILDCARD_BLOCK
} from "../shared/constants.js";

const BLOCK_RULE_ID_BASE = 1000;
const ALLOW_RULE_ID_BASE = 2000;
const X_LIMIT_RULE_ID = 3000;
const EMBED_ALLOW_RULE_ID_BASE = 4000;
const GOOGLE_ALLOW_RULE_ID_BASE = 5000;
const HARD_BLOCK_RULE_ID_BASE = 6000;
const CURFEW_RULE_ID = 7000;
const MAGNET_ALLOW_RULE_ID = 8000;

/**
 * The nightly curfew, as a single block-everything rule. Priority 5 sits above
 * the allow rules (2), the x.com cap (3) and the hard blocks (4), so nothing can
 * carve an exception out of it. During curfew this is the *only* rule applied.
 */
export function buildCurfewRule() {
  return {
    id: CURFEW_RULE_ID,
    priority: 5,
    action: { type: "block" },
    condition: {
      urlFilter: "*",
      resourceTypes: ["main_frame", "sub_frame"]
    }
  };
}

/**
 * Allow rules for embed exceptions: a blocked domain may still load as an iframe
 * (sub_frame) when the embedding page is one of the listed sites. Direct visits
 * (main_frame) and embeds initiated by any other site are untouched, so the
 * block rules still apply to them.
 */
function buildEmbedExceptionRules() {
  return EMBED_EXCEPTIONS.map((ex, idx) => ({
    id: EMBED_ALLOW_RULE_ID_BASE + idx,
    priority: 2,
    action: { type: "allow" },
    condition: {
      requestDomains: ex.frameDomains,
      initiatorDomains: ex.fromDomains,
      resourceTypes: ["sub_frame"]
    }
  }));
}

/**
 * The x.com usage cap outranks both list directions: priority 3 beats the
 * allow-list rules (2) and the block-list rules (1), so x.com is reachable
 * while budget remains even if blocked, and blocked once it's spent even if
 * allowed/unlocked.
 */
export function buildXLimitRule(domain, hasBudget) {
  return {
    id: X_LIMIT_RULE_ID,
    priority: 3,
    action: { type: hasBudget ? "allow" : "block" },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: ["main_frame", "sub_frame"]
    }
  };
}

/**
 * Parse a domain entry into its components.
 * Supports:
 *   - Simple domains: google.com
 *   - Subdomain wildcards: *.firebaseapp.com
 *   - Paths: google.com/maps
 *   - Full URLs: https://google.com/maps
 *   - Local dev hosts: localhost, localhost:3000, 127.0.0.1, 127.0.0.1:5173
 */
function isValidPort(portStr) {
  if (!portStr) return false;
  if (!/^\d+$/.test(portStr)) return false;
  const n = Number(portStr);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function isValidIPv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isLocalhostOrIp(domainMaybeWithPort) {
  const d = String(domainMaybeWithPort || "").trim().toLowerCase();
  if (!d) return false;

  // Bracketed IPv6, optionally with port: [::1] or [::1]:3000
  if (d.startsWith("[")) {
    const close = d.indexOf("]");
    if (close === -1) return false;
    const host = d.slice(1, close);
    const rest = d.slice(close + 1);
    if (!host) return false;
    if (!rest) return true;
    if (!rest.startsWith(":")) return false;
    return isValidPort(rest.slice(1));
  }

  // localhost (optionally with port)
  if (d === "localhost") return true;
  if (d.startsWith("localhost:")) return isValidPort(d.slice("localhost:".length));

  // IPv4 (optionally with port)
  const idx = d.lastIndexOf(":");
  if (idx !== -1 && d.indexOf(":") === idx) {
    const host = d.slice(0, idx);
    const port = d.slice(idx + 1);
    return isValidIPv4(host) && isValidPort(port);
  }
  if (isValidIPv4(d)) return true;

  // Bare IPv6 (best-effort): accept anything with ':' so users can allow ::1
  if (d.includes(":")) return true;

  return false;
}

function parseEntry(input) {
  const trimmed = String(input || "").trim().toLowerCase();
  if (!trimmed) return null;

  // Strip scheme if present
  const withoutScheme = trimmed.replace(/^https?:\/\//, "");

  // Check for wildcard subdomain pattern (*.domain.com)
  const isWildcardSubdomain = withoutScheme.startsWith("*.");
  let rest = isWildcardSubdomain ? withoutScheme.slice(2) : withoutScheme;

  // Remove leading dot if present
  rest = rest.replace(/^\./, "");

  // Split domain and path
  const slashIndex = rest.indexOf("/");
  let domain, path;
  if (slashIndex !== -1) {
    domain = rest.slice(0, slashIndex);
    path = rest.slice(slashIndex); // includes the leading /
  } else {
    domain = rest;
    path = null;
  }

  // Validate:
  // - Most domains must have at least one dot (e.g. google.com)
  // - But we also allow local dev hosts (localhost, IPs), optionally with ports
  // Skip invalid entries like "*.pdf"
  if (!domain) return null;
  if (!domain.includes(".") && !isLocalhostOrIp(domain)) return null;

  return { domain, path, isWildcardSubdomain };
}

/**
 * Build a urlFilter pattern from parsed entry.
 * - With path: ||domain.com/path (matches that specific path and below)
 * - Without path: ||domain.com^ (matches domain and all subdomains)
 */
function buildUrlFilter(parsed) {
  if (!parsed) return null;
  const { domain, path } = parsed;

  if (path) {
    // With path: don't use ^ so it matches the path prefix
    return `||${domain}${path}`;
  } else {
    // Without path: use ^ to match domain and subdomains
    return `||${domain}^`;
  }
}

/**
 * Parse and deduplicate a list of domain entries.
 */
function parseEntries(domains) {
  const out = [];
  const seen = new Set();
  for (const d of domains || []) {
    const parsed = parseEntry(d);
    if (!parsed) continue;
    const key = `${parsed.domain}${parsed.path || ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(parsed);
    }
  }
  return out;
}

// Keep for backwards compatibility
export function normalizeDomains(domains) {
  return parseEntries(domains).map((p) => p.domain);
}

/**
 * Google services, allowed at the same priority as the user's own allowlist so
 * they survive the `*` block. Nothing here covers the search surface — see
 * GOOGLE_SERVICE_ALLOW — and buildHardBlockRules outranks these anyway.
 */
function buildGoogleServiceRules() {
  return parseEntries(GOOGLE_SERVICE_ALLOW)
    .map((parsed, idx) => ({
      id: GOOGLE_ALLOW_RULE_ID_BASE + idx,
      priority: 2,
      action: { type: "allow" },
      condition: {
        urlFilter: buildUrlFilter(parsed),
        resourceTypes: ["main_frame", "sub_frame"]
      }
    }))
    .filter((r) => r.condition.urlFilter);
}

/**
 * Let magnet links reach the user's registered torrent client instead of being
 * swallowed by the block-everything rule. The left anchor keeps this exception
 * scoped to the magnet scheme; it does not allow any HTTP(S) site.
 */
function buildMagnetAllowRule() {
  return {
    id: MAGNET_ALLOW_RULE_ID,
    priority: 2,
    action: { type: "allow" },
    condition: {
      urlFilter: "|magnet:",
      resourceTypes: ["main_frame"]
    }
  };
}

/**
 * Never-allow rules. Priority 4 beats the allow rules (2) and the x.com cap (3),
 * so these hold even if the domain is hand-added to the allowlist.
 */
function buildHardBlockRules() {
  return HARD_BLOCK_URL_FILTERS.map((urlFilter, idx) => ({
    id: HARD_BLOCK_RULE_ID_BASE + idx,
    priority: 4,
    action: { type: "block" },
    condition: {
      urlFilter,
      resourceTypes: ["main_frame", "sub_frame"]
    }
  }));
}

export function hasWildcardBlock(domains) {
  return (domains || []).some((d) => String(d).trim() === WILDCARD_BLOCK);
}

export function buildBlockingRules(blockedDomains, allowedDomains = []) {
  const rules = [];
  const parsedAllowed = parseEntries(allowedDomains);
  const isWildcard = hasWildcardBlock(blockedDomains);

  // Allow rules have higher priority so they override block rules
  parsedAllowed.forEach((parsed, idx) => {
    const urlFilter = buildUrlFilter(parsed);
    if (urlFilter) {
      rules.push({
        id: ALLOW_RULE_ID_BASE + idx,
        priority: 2, // Higher priority than block rules
        action: { type: "allow" },
        condition: {
          urlFilter,
          resourceTypes: ["main_frame", "sub_frame"]
        }
      });
    }
  });

  if (isWildcard) {
    // Block everything with a single rule
    rules.push({
      id: BLOCK_RULE_ID_BASE,
      priority: 1,
      action: { type: "block" },
      condition: {
        urlFilter: "*",
        resourceTypes: ["main_frame", "sub_frame"]
      }
    });
  } else {
    // Block only specific domains
    const parsedBlocked = parseEntries(blockedDomains);
    parsedBlocked.forEach((parsed, idx) => {
      const urlFilter = buildUrlFilter(parsed);
      if (urlFilter) {
        rules.push({
          id: BLOCK_RULE_ID_BASE + idx,
    priority: 1,
    action: { type: "block" },
    condition: {
            urlFilter,
      resourceTypes: ["main_frame", "sub_frame"]
    }
        });
      }
    });
  }

  rules.push(...buildEmbedExceptionRules());
  rules.push(...buildGoogleServiceRules());
  rules.push(buildMagnetAllowRule());
  rules.push(...buildHardBlockRules());

  return rules;
}

export async function replaceDynamicRules(rules) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = rules || [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules
  });
}





