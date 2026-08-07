import { CURFEW } from "./constants.js";

/**
 * True when `at` falls inside the nightly curfew. The window wraps midnight
 * (23:00 → 06:00), so that case is an OR of two half-open spans rather than a
 * single range.
 */
export function isInCurfewAt(at = Date.now()) {
  const h = new Date(at).getHours();
  const { startHour, endHour } = CURFEW;
  return startHour > endHour ? h >= startHour || h < endHour : h >= startHour && h < endHour;
}

/**
 * The next local instant the curfew switches on or off, strictly after `at`.
 * Built from local date components so DST shifts land on the right wall-clock
 * hour. There is always a next boundary, so this never returns null.
 */
export function nextCurfewBoundaryAfter(at = Date.now()) {
  const d = new Date(at);
  const candidates = [];
  for (const dayOffset of [0, 1]) {
    for (const hour of [CURFEW.startHour, CURFEW.endHour]) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour).getTime();
      if (t > at) candidates.push(t);
    }
  }
  return Math.min(...candidates);
}

/** "11:00pm" / "6:00am", for UI copy. */
export function fmtHour(hour) {
  const suffix = hour < 12 ? "am" : "pm";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00${suffix}`;
}
