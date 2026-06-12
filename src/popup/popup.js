import { getRuntimeState } from "../shared/storage.js";
import { isInClassAt, nextBoundaryAfter } from "../background/calendar_api.js";
import { UNLOCK_TIERS } from "../shared/constants.js";

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

function fmtDuration(ms) {
  const mins = Math.max(0, Math.ceil(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function refresh() {
  const state = await getRuntimeState();
  const windows = state.cachedClassWindows || [];
  const inClass = isInClassAt(windows, Date.now());
  const next = nextBoundaryAfter(windows, Date.now());
  const tempUnlock = state.tempUnlock;
  const unlockActive = tempUnlock && Date.now() < tempUnlock.until;

  const statusEl = document.getElementById("status");
  const detailEl = document.getElementById("detail");
  const banner = document.getElementById("unlockBanner");
  const bannerText = document.getElementById("unlockBannerText");

  // Line 1: class state
  const classLine = inClass
    ? "In class — sites unblocked"
    : "Not in class — sites blocked";

  // Line 2: temp unlock state
  const unlockPending = tempUnlock && tempUnlock.activatesAt && Date.now() < tempUnlock.activatesAt;
  let unlockLine = "";
  if (unlockPending) {
    const waitLeft = tempUnlock.activatesAt - Date.now();
    const target = tempUnlock.type === "all" ? "all sites" : tempUnlock.site;
    unlockLine = `Unlock pending: ${target} — activates in ${fmtDuration(waitLeft)}`;
  } else if (unlockActive) {
    const remaining = tempUnlock.until - Date.now();
    const target = tempUnlock.type === "all" ? "all sites" : tempUnlock.site;
    unlockLine = `Temp unlock: ${target} — ${fmtDuration(remaining)} left`;
  }

  // Build status with both lines
  statusEl.innerHTML = "";
  const classSpan = document.createElement("div");
  classSpan.textContent = classLine;
  classSpan.className = inClass ? "status-line ok" : "status-line blocked";
  statusEl.appendChild(classSpan);

  if (unlockLine) {
    const unlockSpan = document.createElement("div");
    unlockSpan.textContent = unlockLine;
    unlockSpan.className = unlockPending ? "status-line pending" : "status-line ok";
    statusEl.appendChild(unlockSpan);
    bannerText.textContent = unlockPending
      ? "Unlock requested — waiting for delay."
      : "Temporary unlock is active.";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

  // X usage state
  try {
    const xResp = await chrome.runtime.sendMessage({ type: "GET_X_STATUS" });
    if (xResp?.ok) {
      const xStatusEl = document.getElementById("xStatus");
      const slot = (ms) => (ms < 1000 ? "used up" : `${fmtBudget(ms)} left`);
      xStatusEl.textContent = `AM: ${slot(xResp.remaining.am)} · PM: ${slot(xResp.remaining.pm)}`;

      if (xResp.counting) {
        const xLine = document.createElement("div");
        xLine.textContent = `x.com open — ${fmtBudget(xResp.remaining[xResp.period])} left this ${
          xResp.period === "am" ? "morning" : "afternoon"
        }`;
        xLine.className = "status-line ok";
        statusEl.appendChild(xLine);
      }
    }
  } catch {}

  // Update tier button states
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_UNLOCKS_TODAY" });
    const usedSet = new Set(resp?.ok ? resp.usedTiers : []);
    for (const btn of document.querySelectorAll(".tier-btn")) {
      const tier = btn.dataset.tier;
      const tierDef = UNLOCK_TIERS.find((t) => t.id === tier);
      const label = tierDef ? tierDef.label : tier;
      const isUsed = usedSet.has(tier);
      btn.disabled = isUsed;
      btn.textContent = isUsed ? `${label} ✓` : label;
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

// --- Unlock form ---

function setupUnlockForm() {
  const typeSelect = document.getElementById("unlockType");
  const siteGroup = document.getElementById("siteGroup");
  const siteInput = document.getElementById("unlockSite");
  const tierBtns = document.querySelectorAll(".tier-btn");
  const cancelBtn = document.getElementById("cancelUnlock");

  typeSelect.addEventListener("change", () => {
    siteGroup.classList.toggle("hidden", typeSelect.value !== "site");
  });

  for (const btn of tierBtns) {
    btn.addEventListener("click", async () => {
      const tier = btn.dataset.tier;
      const tierDef = UNLOCK_TIERS.find((t) => t.id === tier);
      if (!tierDef) return;
      // Validate site field if needed
      if (typeSelect.value === "site" && !siteInput.value.trim()) return;

      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = "Unlocking…";
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "TEMP_UNLOCK",
          unlockType: typeSelect.value,
          site: siteInput.value.trim(),
          durationMinutes: tierDef.durationMinutes,
          tier
        });
        if (resp?.error === "TIER_USED") {
          btn.textContent = "Already used today";
          setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
          return;
        }
        // Reset form
        typeSelect.value = "all";
        siteGroup.classList.add("hidden");
        siteInput.value = "";
        await refresh();
      } catch {
        btn.textContent = "Error";
        setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 2000);
      }
    });
  }

  cancelBtn.addEventListener("click", async () => {
    cancelBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: "CANCEL_UNLOCK" });
      await refresh();
    } finally {
      cancelBtn.disabled = false;
    }
  });
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
      entriesEl.innerHTML = '<div class="log-empty">No unlock history yet.</div>';
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
  setupUnlockForm();
  setupLog();
  await refresh();
  syncNow();
}

init();
