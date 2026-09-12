import { getRuntimeState } from "../shared/storage.js";
import { isInClassAt, nextBoundaryAfter } from "../background/calendar_api.js";
import { CURFEW, METERED_LIMITS } from "../shared/constants.js";
import { isInCurfewAt, fmtHour } from "../shared/curfew.js";

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtBudget(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

async function refresh() {
  const state = await getRuntimeState();
  const windows = state.cachedClassWindows || [];
  const next = nextBoundaryAfter(windows, Date.now());

  const statusEl = document.getElementById("status");
  const detailEl = document.getElementById("detail");

  // Ask the worker what it actually enforced rather than recomputing it here —
  // otherwise this line reports the schedule, not reality, and says "blocked"
  // even when no rules are applied. Falls back to local time if it can't answer.
  let applied = null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (resp?.ok) applied = resp;
  } catch {}

  const inCurfew = applied ? applied.curfew : isInCurfewAt();
  const inClass = applied ? applied.inClass : isInClassAt(windows, Date.now());

  statusEl.innerHTML = "";
  const classSpan = document.createElement("div");
  classSpan.textContent = inCurfew
    ? `Curfew — everything blocked until ${fmtHour(CURFEW.endHour)}`
    : inClass
      ? "In class — sites unblocked"
      : "Not in class — sites blocked";
  classSpan.className = inCurfew || !inClass ? "status-line blocked" : "status-line ok";
  statusEl.appendChild(classSpan);

  // A live claim of "blocked" is only true if rules are really loaded. If the
  // worker is unreachable or holding no rules, say so instead of implying safety.
  if (!applied) {
    const warn = document.createElement("div");
    warn.textContent = "⚠ Blocker not responding — reload the extension";
    warn.className = "status-line blocked";
    statusEl.appendChild(warn);
  } else if (applied.activeRules === 0) {
    const warn = document.createElement("div");
    warn.textContent = "⚠ No rules active — nothing is being blocked";
    warn.className = "status-line blocked";
    statusEl.appendChild(warn);
  }

  // Metered sites (x.com, TikTok, Instagram, Reddit, Facebook)
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_METER_STATUS" });
    if (resp?.ok) {
      const meterEl = document.getElementById("meterStatus");
      meterEl.innerHTML = "";
      const slot = (ms) => (ms < 1000 ? "used up" : `${fmtBudget(ms)} left`);

      for (const limit of METERED_LIMITS) {
        const state = resp.limits.find((l) => l.id === limit.id);
        if (!state) continue;
        // A single period means one budget for the whole day, so drop the label.
        const perDay = limit.periods.length === 1;
        const remaining = perDay
          ? slot(state.remaining[limit.periods[0].id])
          : limit.periods.map((p) => `${p.label}: ${slot(state.remaining[p.id])}`).join(" · ");

        const row = document.createElement("div");
        row.className = "meter-row";
        const name = document.createElement("div");
        name.className = "meter-name";
        name.textContent = `${limit.label} — ${limit.budgetMinutes} min${
          perDay ? "/day" : " per period"
        }`;
        const detail = document.createElement("div");
        detail.className = "meter-remaining";
        detail.textContent = remaining;
        row.append(name, detail);
        meterEl.appendChild(row);

        if (state.counting) {
          const period = limit.periods.find((p) => p.id === state.period);
          const label = period ? period.label : state.period;
          const line = document.createElement("div");
          line.textContent = `${limit.label} open — ${fmtBudget(
            state.remaining[state.period]
          )} left ${perDay ? label : `this ${label}`}`;
          line.className = "status-line ok";
          statusEl.appendChild(line);
        }
      }
    }
  } catch {}

  // Remove top-level color classes (lines handle their own)
  statusEl.classList.remove("ok", "blocked");

  if (next) {
    detailEl.textContent = `Next change at ${fmtTime(next)}.`;
  } else {
    detailEl.textContent = state.lastCalendarSyncError
      ? `Calendar: ${state.lastCalendarSyncError}`
      : "Calendar: no upcoming class windows cached yet.";
  }
}

async function syncNow() {
  const btn = document.getElementById("syncNow");
  const originalText = btn.textContent;
  btn.textContent = "Syncing…";
  btn.disabled = true;

  try {
    await chrome.runtime.sendMessage({ type: "SYNC_NOW" });
    await refresh();
    btn.textContent = "Synced ✓";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  } catch (e) {
    btn.textContent = "Error";
    setTimeout(() => {
      btn.textContent = originalText;
      btn.disabled = false;
    }, 1500);
  }
}

// --- Unlock log ---

function setupLog() {
  const toggleBtn = document.getElementById("toggleLog");
  const section = document.getElementById("logSection");
  const entriesEl = document.getElementById("logEntries");
  const downloadBtn = document.getElementById("downloadLog");
  const clearBtn = document.getElementById("clearLog");

  toggleBtn.addEventListener("click", async () => {
    const isHidden = section.classList.toggle("hidden");
    if (!isHidden) {
      await renderLog();
    }
  });

  async function renderLog() {
    const resp = await chrome.runtime.sendMessage({ type: "GET_UNLOCK_LOG" });
    const log = resp?.log || [];
    if (log.length === 0) {
      entriesEl.innerHTML = '<div class="log-empty">No unlock history.</div>';
      return;
    }
    // Show most recent first, limit to 20
    const recent = log.slice(-20).reverse();
    entriesEl.innerHTML = recent
      .map((e) => {
        const date = new Date(e.grantedAt).toLocaleString([], {
          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
        });
        const target = e.type === "all" ? "All sites" : e.site;
        return `<div class="log-entry">
          <span class="log-date">${date}</span>
          <span class="log-target">${escapeHtml(target)}</span>
          <span class="log-duration">${e.durationMinutes}m</span>
        </div>`;
      })
      .join("");
  }

  downloadBtn.addEventListener("click", async () => {
    const resp = await chrome.runtime.sendMessage({ type: "GET_UNLOCK_LOG" });
    const log = resp?.log || [];
    const header = "Date,Type,Site,Duration (min),Expires At\n";
    const rows = log.map((e) => {
      return `${e.grantedAt},${e.type},${e.site || "all"},${e.durationMinutes},${e.expiresAt}`;
    });
    const csv = header + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bloqueasitios-unlock-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  clearBtn.addEventListener("click", async () => {
    if (!confirm("Clear entire unlock log?")) return;
    await chrome.runtime.sendMessage({ type: "CLEAR_UNLOCK_LOG" });
    await renderLog();
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---

document.getElementById("syncNow").addEventListener("click", syncNow);

document.getElementById("openOptions").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.openOptionsPage();
});

async function init() {
  setupLog();
  await refresh();
  syncNow();
}

init();
