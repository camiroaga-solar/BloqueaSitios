import { getSettings, getRuntimeState, setBlockedDomains, setAllowedDomains, setSelectedCalendarId } from "../shared/storage.js";
import { WILDCARD_BLOCK } from "../shared/constants.js";

async function sendMessage(type, payload) {
  return await chrome.runtime.sendMessage({ type, ...payload });
}

function parseDomainsFromTextarea(value) {
  return String(value || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function fmtTs(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

function setStatus(el, msg) {
  el.textContent = msg || "";
}

function saveErrorMessage(error) {
  const message = String(error?.message || error || "Unknown error");
  if (message.toLowerCase().includes("quotabytesperitem")) {
    return "Too many entries to sync. Remove some entries and try again.";
  }
  return message;
}

async function loadIntoUI() {
  const settings = await getSettings();
  const state = await getRuntimeState();

  // The wildcard lives in the pinned row above the textarea, not inside it, so
  // there is nothing to select-and-delete. setBlockedDomains re-adds it anyway.
  const extraBlocked = (settings.blockedDomains || []).filter((d) => String(d).trim() !== WILDCARD_BLOCK);
  document.getElementById("blockedDomains").value = extraBlocked.join("\n");
  document.getElementById("allowedDomains").value = (settings.allowedDomains || []).join("\n");
  document.getElementById("lastSync").textContent = fmtTs(state.lastCalendarSyncAt);
  document.getElementById("lastError").textContent = state.lastCalendarSyncError || "—";

  // calendar select is loaded separately
  const calendarSelect = document.getElementById("calendarSelect");
  calendarSelect.dataset.selected = settings.selectedCalendarId || "";
}

function setCalendars(calendars) {
  const select = document.getElementById("calendarSelect");
  const selectedId = select.dataset.selected || "";
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select a calendar…";
  select.appendChild(placeholder);

  for (const c of calendars || []) {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.primary ? `${c.summary} (primary)` : c.summary;
    select.appendChild(opt);
  }
  select.value = selectedId || "";
}

async function refreshCalendars({ interactive, forceReauth }) {
  const authStatus = document.getElementById("authStatus");
  setStatus(authStatus, "Loading calendars…");
  try {
    const calendars = await sendMessage("LIST_CALENDARS", { interactive, forceReauth });
    if (!calendars?.ok) throw new Error(calendars?.error || "Failed to list calendars");
    setCalendars(calendars.items);
    setStatus(authStatus, "Calendars loaded.");
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.toLowerCase().includes("not signed in")) {
      setStatus(authStatus, "Not connected. Click “Connect Google”.");
    } else {
      setStatus(authStatus, `Failed: ${msg}`);
    }
  }
}

async function wireHandlers() {
  const saveBlockedStatus = document.getElementById("saveBlockedStatus");
  const saveAllowedStatus = document.getElementById("saveAllowedStatus");
  const syncStatus = document.getElementById("syncStatus");

  document.getElementById("saveBlocked").addEventListener("click", async () => {
    setStatus(saveBlockedStatus, "Saving…");
    try {
      const domains = parseDomainsFromTextarea(document.getElementById("blockedDomains").value);
      await setBlockedDomains(domains);
      await sendMessage("APPLY_BLOCKING", {});
      setStatus(saveBlockedStatus, "Saved.");
    } catch (error) {
      setStatus(saveBlockedStatus, `Failed: ${saveErrorMessage(error)}`);
    }
  });

  document.getElementById("saveAllowed").addEventListener("click", async () => {
    setStatus(saveAllowedStatus, "Saving…");
    try {
      const textarea = document.getElementById("allowedDomains");
      const domains = parseDomainsFromTextarea(textarea.value);
      const { savedDomains, ignoredMagnetLinks } = await setAllowedDomains(domains);
      textarea.value = savedDomains.join("\n");
      await sendMessage("APPLY_BLOCKING", {});
      setStatus(
        saveAllowedStatus,
        ignoredMagnetLinks
          ? "Saved. Magnet links are already allowed automatically; pasted magnet URI removed."
          : "Saved."
      );
    } catch (error) {
      setStatus(saveAllowedStatus, `Failed: ${saveErrorMessage(error)}`);
    }
  });

  document.getElementById("connectGoogle").addEventListener("click", async () => {
    await refreshCalendars({ interactive: true, forceReauth: true });
  });

  document.getElementById("refreshCalendars").addEventListener("click", async () => {
    await refreshCalendars({ interactive: false, forceReauth: false });
  });

  document.getElementById("saveCalendar").addEventListener("click", async () => {
    const id = document.getElementById("calendarSelect").value || null;
    await setSelectedCalendarId(id);
    setStatus(syncStatus, "Saved calendar.");
  });

  document.getElementById("syncNow").addEventListener("click", async () => {
    setStatus(syncStatus, "Syncing…");
    await sendMessage("SYNC_NOW", {});
    await loadIntoUI();
    setStatus(syncStatus, "Synced.");
  });
}

async function main() {
  await loadIntoUI();
  await wireHandlers();
  await refreshCalendars({ interactive: false, forceReauth: false });
}

main();
