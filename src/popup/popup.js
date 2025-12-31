import { getRuntimeState } from "../shared/storage.js";
import { isInClassAt, nextBoundaryAfter } from "../background/calendar_api.js";

function fmtTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function refresh() {
  const state = await getRuntimeState();
  const windows = state.cachedClassWindows || [];
  const inClass = isInClassAt(windows, Date.now());
  const next = nextBoundaryAfter(windows, Date.now());

  const statusEl = document.getElementById("status");
  const detailEl = document.getElementById("detail");

  if (inClass) {
    statusEl.textContent = "In class — sites are unblocked";
    statusEl.classList.remove("blocked");
    statusEl.classList.add("ok");
  } else {
    statusEl.textContent = "Not in class — sites are blocked";
    statusEl.classList.remove("ok");
    statusEl.classList.add("blocked");
  }

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

document.getElementById("syncNow").addEventListener("click", syncNow);

document.getElementById("openOptions").addEventListener("click", async (e) => {
  e.preventDefault();
  await chrome.runtime.openOptionsPage();
});

// Auto-sync when popup opens, then refresh UI
async function init() {
  await refresh(); // Show current state immediately
  // Auto-sync in background when popup opens
  syncNow();
}

init();






