import { getRuntimeState } from "../shared/storage.js";
import { isInClassAt, nextBoundaryAfter } from "../background/calendar_api.js";

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
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

  // Line 2: temp unlock state (if active)
  let unlockLine = "";
  if (unlockActive) {
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
    unlockSpan.className = "status-line ok";
    statusEl.appendChild(unlockSpan);
    bannerText.textContent = "Temporary unlock is active.";
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }

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
  const durationSelect = document.getElementById("unlockDuration");
  const submitBtn = document.getElementById("submitUnlock");
  const cancelBtn = document.getElementById("cancelUnlock");

  typeSelect.addEventListener("change", () => {
    siteGroup.classList.toggle("hidden", typeSelect.value !== "site");
  });

  function validateForm() {
    const hasSite = typeSelect.value !== "site" || siteInput.value.trim().length > 0;
    submitBtn.disabled = !hasSite;
  }

  siteInput.addEventListener("input", validateForm);
  typeSelect.addEventListener("change", validateForm);
  validateForm();

  submitBtn.addEventListener("click", async () => {
    submitBtn.disabled = true;
    submitBtn.textContent = "Unlocking…";
    try {
      await chrome.runtime.sendMessage({
        type: "TEMP_UNLOCK",
        unlockType: typeSelect.value,
        site: siteInput.value.trim(),
        durationMinutes: Number(durationSelect.value)
      });
      // Reset form
      typeSelect.value = "all";
      siteGroup.classList.add("hidden");
      siteInput.value = "";
      durationSelect.value = "1";
      validateForm();
      await refresh();
    } catch (e) {
      submitBtn.textContent = "Error";
    } finally {
      submitBtn.textContent = "Unlock";
      submitBtn.disabled = false;
    }
  });

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
  document.getElementById("unlockDuration").value = "1";
  await refresh();
  syncNow();
}

init();
