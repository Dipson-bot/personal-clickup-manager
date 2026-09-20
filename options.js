// options.js - manage accounts + settings. Talks to background via messages.
// Secrets are only ever sent TO the background; they are never read back into
// this page (the background returns a "hasPassword/hasTotp" flag instead).

const $ = (id) => document.getElementById(id);

// Matches the auto-detected "Extra(s) Task(s)" name pattern (mirrors
// lib-clickup.js EXTRA_TASK_NAME_RE) for de-duplicating weekly rows.
const EXTRA_TASK_NAME_RE = /extra\s*\(?\s*s?\s*\)?\s*-?\s*tasks?/i;
// Given a task list, keep at most ONE "Extra(s) Task(s)" row (drop the rest).
function dedupeExtraRows(rows) {
  if (!Array.isArray(rows)) return rows;
  let seen = false;
  return rows.filter((t) => {
    if (!EXTRA_TASK_NAME_RE.test(t.name || "")) return true;
    if (seen) return false;
    seen = true;
    return true;
  });
}

// ---------- Drive Sync card (mirrors the popup's sign in / out + Sync now) ----------
// Formats a sync timestamp as "12:10 PM · Sep 6" for the "Last synced" line and
// the transient "Synced ✓" confirmation.
function fmtSyncStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return time + " · " + date;
}
// Live busy phase ("" | "signin" | "sync"), the last GET_STATE we rendered from
// (so a busy-phase message can repaint the card without a full reload), and a
// short-lived "Synced ✓ …" confirmation after a sign-in or manual sync.
let optDriveBusy = "";
let optLastState = null;
let optSyncTransientText = "";
let optSyncTransientUntil = 0;

// Paint the Drive Sync card from the current public state. Mirrors popup.js's
// render(): a busy phase shows a pulsing dot + "Signing in…"/"Syncing…"; idle
// shows on/off with the sign in / out + Sync now buttons and a "Last synced" line.
function renderDriveSync(state) {
  const dot = $("optSyncDot");
  const label = $("optSyncLabel");
  const btn = $("optGoogleBtn");
  const syncNow = $("optSyncNow");
  const lastLine = $("optLastSyncLine");
  if (!dot || !label || !btn || !syncNow) return;
  const on = !!(state && state.signedIn);
  const busy = optDriveBusy || (state && state.driveBusy) || "";
  const setGoogleBtn = (text, danger) => {
    btn.textContent = text;
    btn.classList.toggle("danger", !!danger);
    btn.classList.toggle("primary", !danger);
  };
  if (busy === "signin") {
    dot.className = "drivesync-dot running";
    label.textContent = "Signing in…";
    setGoogleBtn("Working…", on);
    btn.disabled = true;
    syncNow.style.display = "none";
  } else if (busy === "sync") {
    dot.className = "drivesync-dot running";
    label.textContent = "Syncing…";
    setGoogleBtn(on ? "Sign out" : "Sign in", on);
    btn.disabled = true;
    syncNow.style.display = on ? "" : "none";
  } else {
    dot.className = "drivesync-dot" + (on ? " on" : "");
    label.textContent = (optSyncTransientText && Date.now() < optSyncTransientUntil)
      ? optSyncTransientText
      : (on ? "Drive sync on" : "Drive sync off");
    setGoogleBtn(on ? "Sign out" : "Sign in", on);
    btn.disabled = false;
    syncNow.style.display = on ? "" : "none";
  }
  if (lastLine) {
    if (on) {
      lastLine.style.display = "";
      lastLine.textContent = (state && state.driveLastSync)
        ? "Last synced: " + fmtSyncStamp(state.driveLastSync)
        : "Not synced yet.";
    } else {
      lastLine.style.display = "none";
    }
  }
}

// Messaging with the background service worker - this version FAILS LOUDLY.
// If the background never answers (its service worker errored, or this options
// tab's extension context went stale after the extension was reloaded), we
// reject with a clear message instead of hanging on "Loading…" forever.
const send = (msg, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("No response from the extension. Reload the extension at chrome://extensions, then close and reopen this page."));
    }, timeoutMs == null ? 8000 : timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message || "Message to the extension failed."));
        else resolve(resp);
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });

function showErr(text) {
  const box = $("err");
  if (!box) return;
  if (!text) {
    box.style.display = "none";
    box.textContent = "";
    return;
  }
  box.style.display = "block";
  box.textContent = text;
}

// Reset window (hours) comes from the background; used for the countdown text.
let resetHours = 24;

function pad2(n) {
  return String(n).padStart(2, "0");
}
function fmtClock(ts) {
  const d = new Date(ts);
  let h = d.getHours();
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return h + ":" + pad2(d.getMinutes()) + " " + ap;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtDayTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(d, now)) return "today " + fmtClock(ts);
  if (sameDay(d, tomorrow)) return "tomorrow " + fmtClock(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + fmtClock(ts);
}
function doneAtOf(st) {
  if (!st) return 0;
  if (st.lastDoneAt) return st.lastDoneAt;
  if (st.lastDone && st.lastRunAt) return st.lastRunAt;
  return 0;
}

let editingId = null;
let labelTouched = false; // true once the user edits Label manually (stops auto-mirror)
let defaultMode = "auto"; // global "default mode for new accounts" (from settings)
let cuTeams = []; // ClickUp workspaces, cached from the last token verify / get-teams
let cuTeamName = ""; // display name of the saved workspace when cuTeams is stale

function resetForm() {
  editingId = null;
  labelTouched = false;
  $("accId").value = "";
  $("label").value = "";
  $("username").value = "";
  $("password").value = "";
  $("totp").value = "";
  if ($("arToken")) { $("arToken").value = ""; $("arToken").placeholder = "paste the access token"; $("arToken").type = "password"; }
  if ($("arId")) $("arId").value = "";
  if ($("arTokenHint")) $("arTokenHint").textContent = "";
  $("accMode").value = defaultMode || "auto";
  $("accAuth").value = "password";
  $("formTitle").textContent = "Add an account";
  $("saveBtn").textContent = "Save account";
  $("cancelBtn").style.display = "none";
  $("pwHint").textContent = "";
  $("totpHint").textContent = "";
  $("password").placeholder = "";
  $("totp").placeholder = "e.g. JBSWY3DPEHPK3PXP";
  // re-hide any revealed secret fields
  $("password").type = "password";
  $("totp").type = "password";
  document.querySelectorAll(".pw-toggle").forEach((b) => (b.textContent = "👁"));
  stopTotpPreview();
}

function startEdit(acc) {
  stopTotpPreview();
  editingId = acc.id;
  $("accId").value = acc.id;
  $("label").value = acc.label || "";
  $("username").value = acc.username || "";
  $("password").value = "";
  $("totp").value = "";
  if ($("arToken")) {
    $("arToken").value = "";
    $("arToken").placeholder = acc.hasArToken ? "•••••••• (unchanged - type - to remove)" : "paste the access token";
  }
  if ($("arId")) $("arId").value = acc.arId != null ? String(acc.arId) : "";
  if ($("arTokenHint")) $("arTokenHint").textContent = acc.hasArToken ? "- saved; background checks on" : "- not set";
  if ($("arBgWrap") && !acc.hasArToken) $("arBgWrap").open = true;
  $("accMode").value = acc.mode || defaultMode || "auto";
  $("accAuth").value = acc.authMethod === "google" || acc.authMethod === "google-passkey" ? acc.authMethod : "password";
  $("formTitle").textContent = "Edit account";
  $("saveBtn").textContent = "Update account";
  $("cancelBtn").style.display = "inline-block";
  $("pwHint").textContent = acc.authMethod === "google" || acc.authMethod === "google-passkey"
    ? "- not needed (Sign in with Google)"
    : acc.hasPassword ? "- leave blank to keep current" : "";
  $("password").placeholder = acc.hasPassword ? "•••••••• (unchanged)" : "";
  $("totpHint").textContent = acc.hasTotp ? "Leave blank to keep current." : "";
  $("totp").placeholder = acc.hasTotp ? "•••••••• (unchanged)" : "e.g. JBSWY3DPEHPK3PXP";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderList(accounts, status, today, running) {
  const list = $("list");
  if (!accounts.length) {
    list.innerHTML = '<div class="empty">No accounts yet. Add one above.</div>';
    return;
  }
  list.innerHTML = "";
  for (const a of accounts) {
    const st = status[a.id] || {};
    const el = document.createElement("div");
    el.className = "acct";

    const meta = document.createElement("div");
    meta.className = "meta";
    const name = document.createElement("div");
    name.className = "name";
    const labelSpan = document.createElement("span");
    labelSpan.textContent = a.label; // user data -> textContent, never innerHTML
    name.appendChild(labelSpan);
    // Informative state badges (whether auto-login can actually succeed). The
    // on/off status is now the clickable mode toggle built below.
    const twofaPill = a.hasTotp ? '<span class="pill on">2FA</span>' : '<span class="pill warn2">no 2FA key</span>';
    const pwPill = a.authMethod === "google-passkey"
      ? '<span class="pill warn">Google · passkey</span>'
      : a.authMethod === "google"
        ? '<span class="pill warn">Google</span>'
        : a.hasPassword ? "" : '<span class="pill warn2">no password</span>';
    // pills are static markup (no user data) -> safe to insert as HTML
    name.insertAdjacentHTML("beforeend", " " + twofaPill + " " + pwPill);
    const det = document.createElement("div");
    det.className = "det";
    const dAt = doneAtOf(st);
    const resetMs = resetHours * 3600 * 1000;
    let statusText;
    if (dAt && Date.now() < dAt + resetMs) {
      statusText = "credited " + fmtDayTime(dAt) + (st.creditSource === "login" ? " (at login)" : "") + " · resets " + fmtDayTime(dAt + resetMs);
    } else if (dAt) {
      const ranLater = st.lastRunAt && st.lastRunAt > dAt + 60000;
      statusText = "ready to run · " + (ranLater ? "last run " + fmtDayTime(st.lastRunAt) + " · " : "") + "last credit " + fmtDayTime(dAt);
    } else if (!dAt && st.lastResult === "success" && st.lastRunAt) {
      // Login landed but the balance poll hasn't confirmed the daily credit yet;
      // the row flips to "logged in … resets …" the moment the batch is detected.
      statusText = "Logged in · awaiting credit (run " + fmtDayTime(st.lastRunAt) + ")";
    } else if (st.lastResult && st.lastResult !== "success") {
      statusText = "last: " + st.lastResult + (st.lastRunAt ? " (" + fmtDayTime(st.lastRunAt) + ")" : "");
    } else {
      statusText = "not run yet";
    }
    det.textContent = (a.username || "(no username)") + "  ·  " + statusText;
    meta.appendChild(name);
    meta.appendChild(det);

    // Identity actually captured on the last successful login (best-effort).
    const idBits = [];
    if (a.detectedLogin && a.detectedLogin !== a.username) idBits.push("@" + a.detectedLogin);
    if (a.detectedEmail && a.detectedEmail !== a.username) idBits.push(a.detectedEmail);
    if (idBits.length) {
      const idLine = document.createElement("div");
      idLine.className = "det";
      idLine.textContent = "signed in as " + idBits.join(" · ");
      idLine.title = idLine.textContent;
      meta.appendChild(idLine);
    }

    // Clickable 3-way mode toggle. `a.mode` is the RESOLVED mode from the
    // background (already falls back to the global default for legacy accounts),
    // so exactly one segment is active. Clicking persists via SET_ACCOUNT_MODE.
    const curMode = a.mode === "reminder" || a.mode === "off" ? a.mode : "auto";
    const toggle = document.createElement("div");
    toggle.className = "modeToggle";
    const MODES = [
      { key: "auto", label: "Auto login" },
      { key: "reminder", label: "Reminder" },
      { key: "off", label: "Off" },
    ];
    for (const m of MODES) {
      const seg = document.createElement("button");
      seg.type = "button";
      seg.textContent = m.label;
      if (m.key === curMode) seg.className = "active " + m.key;
      seg.onclick = async () => {
        if (m.key === curMode) return;
        try {
          showErr("");
          const res = await send({ type: "SET_ACCOUNT_MODE", id: a.id, mode: m.key });
          if (res && res.ok === false) {
            showErr("Couldn't change mode: " + (res.reason || res.error || "unknown"));
            return;
          }
          load();
        } catch (e) {
          showErr("Couldn't change mode: " + (e && e.message ? e.message : e));
        }
      };
      toggle.appendChild(seg);
    }
    meta.appendChild(toggle);

    // Run this one account now (same as the popup's per-account Run). Disabled
    // while any run is in flight, since the background serializes logins.
    const runBtn = document.createElement("button");
    runBtn.className = "primary runBtn";
    runBtn.textContent = "Run";
    runBtn.disabled = !!running;
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      try {
        showErr("");
        const res = await send({ type: "RUN_ONE", id: a.id });
        if (res && res.ok === false) {
          showErr(res.reason === "already running" ? "Already running" : ("Couldn't run: " + (res.reason || res.error || "unknown")));
          runBtn.disabled = false;
          return;
        }
        load(); // picks up running=true and repaints the controls
      } catch (e) {
        showErr("Couldn't run: " + (e && e.message ? e.message : e));
        runBtn.disabled = false;
      }
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => startEdit(a);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Delete";
    delBtn.onclick = async () => {
      if (!confirm(`Delete "${a.label}"? This removes its stored credentials.`)) return;
      try {
        await send({ type: "DELETE_ACCOUNT", id: a.id });
        if (editingId === a.id) resetForm();
        load();
      } catch (e) {
        showErr("Couldn't delete: " + (e && e.message ? e.message : e));
      }
    };

    el.appendChild(meta);
    el.appendChild(runBtn);
    el.appendChild(editBtn);
    el.appendChild(delBtn);
    list.appendChild(el);
  }
}

async function load() {
  try {
    showErr("");
    const state = await send({ type: "GET_STATE" });
    if (!state) {
      showErr("The extension returned no data. Reload the extension and reopen this page.");
      return;
    }
    resetHours = state.resetHours || 24;
    defaultMode = (state.settings && state.settings.mode) || "auto";
    // Keep the (pristine) Add form's Mode default in step with the global setting.
    if (!editingId) $("accMode").value = defaultMode;
    renderList(state.accounts || [], state.status || {}, state.today, !!state.running);
    applyArVisibility(state);
    if ($("showAgentRouter")) $("showAgentRouter").checked = arVisible(state);
    applyAdminVisibility(state);
    if ($("showAdmin")) $("showAdmin").checked = adminVisible(state);
    // Drive Sync card: cache the state so a live busy-phase message can repaint
    // the card without a full reload, then paint it.
    optLastState = state;
    renderDriveSync(state);
    // The Agent Router cards default to collapsed until there are accounts (a
    // remembered manual toggle still wins). Drive this off the authoritative
    // count from GET_STATE, not just the mirrored acctCount.
    applyAcctCardDefaults((state.accounts || []).length > 0);
    renderRunControls(!!state.running, (state.accounts || []).length);
    renderDebugAccounts(state.accounts || []);
    $("mode").value = (state.settings && state.settings.mode) || "auto";
    $("targetUrl").value = (state.settings && state.settings.targetUrl) || "";
    $("notify").checked = !(state.settings && state.settings.notify === false);
    $("notifySound").checked = !(state.settings && state.settings.notifySound === false);
    $("slowNetwork").checked = !!(state.settings && state.settings.slowNetwork);
    $("arCloseTabs").checked = !(state.settings && state.settings.arCloseTabs === false);
    $("cuClientLevel") && ($("cuClientLevel").value = (state.settings && state.settings.cuClientLevel) || "auto");
    {
      const arTimes = (state.settings && Array.isArray(state.settings.arQuotaTimes) && state.settings.arQuotaTimes.length)
        ? state.settings.arQuotaTimes : ["10:00", "19:00"];
      $("arQuotaNotify").checked = !(state.settings && state.settings.arQuotaNotify === false);
      $("arQuotaTime1").value = arTimes[0] || "";
      $("arQuotaTime2").value = arTimes[1] || "";
      $("arQuotaTime3").value = arTimes[2] || "";
      const updateNepalTimes = () => {
        const beijingToNepal = (hhmm) => {
          if (!/^([01]?\d|2[0-3]):([0-5]\d)$/.test(String(hhmm || "").trim())) return "-";
          const [h, m] = hhmm.split(':').map(Number);
          let totalMinutes = h * 60 + m - 135; // subtract 2h 15m (Nepal is UTC+5:45, Beijing is UTC+8)
          while (totalMinutes < 0) totalMinutes += 1440;
          const nh = Math.floor(totalMinutes / 60) % 24;
          const nm = totalMinutes % 60;
          return String(nh).padStart(2, '0') + ":" + String(nm).padStart(2, '0');
        };
        $("arQuotaNepalTime1").textContent = "(Nepal: " + beijingToNepal($("arQuotaTime1").value) + ")";
        $("arQuotaNepalTime2").textContent = "(Nepal: " + beijingToNepal($("arQuotaTime2").value) + ")";
        $("arQuotaNepalTime3").textContent = "(Nepal: " + beijingToNepal($("arQuotaTime3").value) + ")";
      };
      updateNepalTimes();
      ["arQuotaTime1", "arQuotaTime2", "arQuotaTime3"].forEach(id => $(id).oninput = updateNepalTimes);
    }
    optClickup = state.clickup || {};
    renderClickupSettings(optClickup);
    if (optClickup && optClickup.configured && !cuTeams.length) refreshCuTeams().catch(() => {});
    // Department Creator + the filter's Department/User pickers.
    if (optClickup && optClickup.configured) {
      $("deptCard").style.display = "";
      loadDeptData().catch(() => {});
    } else {
      $("deptCard").style.display = "none";
      optDeptMembers = [];
      optDeptList = [];
    }
  } catch (e) {
    showErr("Couldn't load accounts: " + (e && e.message ? e.message : e));
    $("list").innerHTML = '<div class="empty">Couldn\'t reach the extension background - see the message above.</div>';
  }
}

// Reflect the current run state on the Accounts card's Run all / Stop buttons.
// While a run is in flight we show Stop (which sends RUN_CANCEL); otherwise
// Run all now. Mirrors the popup so a login can be started/stopped from either.
function renderRunControls(running, count) {
  const run = $("optRunAll");
  const stop = $("optStopAll");
  if (!run || !stop) return;
  run.style.display = running ? "none" : "";
  run.disabled = !count;
  run.textContent = count ? "Run all now" : "Add an account first";
  stop.style.display = running ? "" : "none";
  stop.disabled = false;
  stop.textContent = "Stop";
}

$("optRunAll").onclick = async () => {
  const msg = $("optRunMsg");
  try {
    const res = await send({ type: "RUN_ALL" });
    if (res && res.ok) {
      renderRunControls(true, 1);
    } else if (res && res.reason) {
      msg.style.display = "inline";
      msg.textContent = res.reason === "no accounts" ? "Add an account first" : res.reason === "already running" ? "Already running" : res.reason;
      setTimeout(() => (msg.style.display = "none"), 2500);
    }
  } catch (e) {
    showErr("Couldn't start the run: " + (e && e.message ? e.message : e));
  }
};

$("optStopAll").onclick = async () => {
  const stop = $("optStopAll");
  stop.disabled = true;
  stop.textContent = "Stopping…";
  try {
    await send({ type: "RUN_CANCEL" });
  } catch (e) {}
  // The loop bails within an iteration; refresh shortly to pick up running=false.
  setTimeout(() => load(), 900);
};

$("saveBtn").onclick = async () => {
  const authMethod = $("accAuth").value;
  const account = {
    id: editingId || undefined,
    label: $("label").value.trim(),
    username: $("username").value.trim(),
    password: $("password").value, // blank => keep existing (handled in bg)
    totpSecret: $("totp").value.trim(),
    mode: $("accMode").value,
    authMethod,
    arToken: $("arToken") ? $("arToken").value.trim() : "", // blank => keep existing
    arId: $("arId") ? $("arId").value.trim() : undefined,
  };
  if (account.arId !== undefined && account.arId !== "" && !/^\d+$/.test(account.arId)) {
    alert("Agent Router user ID must be a number.");
    return;
  }
  if (!account.username) {
    alert("Please enter the GitHub username or email.");
    return;
  }
  if (!editingId && authMethod !== "google" && authMethod !== "google-passkey" && !account.password) {
    alert("Please enter the GitHub password for a new account (or choose 'Sign in with Google').");
    return;
  }
  try {
    showErr("");
    const res = await send({ type: "SAVE_ACCOUNT", account });
    if (res && res.ok === false) {
      showErr("The extension couldn't save this account: " + (res.error || res.reason || "unknown error"));
      return;
    }
    const msg = $("savedMsg");
    msg.style.display = "inline";
    setTimeout(() => (msg.style.display = "none"), 1500);
    resetForm();
    load();
  } catch (e) {
    showErr("Couldn't save the account: " + (e && e.message ? e.message : e));
  }
};

$("cancelBtn").onclick = resetForm;

// Preview the notification chime (plays even if the sound toggle is off).
{
  const btn = $("notifySoundTest");
  if (btn) btn.onclick = () => send({ type: "PLAY_TEST_SOUND" }).catch(() => {});
  const dbtn = $("notifyDangerTest");
  if (dbtn) dbtn.onclick = () => send({ type: "PLAY_TEST_SOUND", sound: "danger" }).catch(() => {});
}

$("saveSettings").onclick = async () => {
  try {
    showErr("");
    const hhmmRe = /^([01]?\d|2[0-3]):([0-5]\d)$/;
    // Blank batch fields = no batch (Agent Router currently runs 2 batches/day).
    const arTimes = ["arQuotaTime1", "arQuotaTime2", "arQuotaTime3"]
      .map((id) => $(id).value.trim())
      .filter(Boolean);
    if (!arTimes.length || !arTimes.every((t) => hhmmRe.test(t))) {
      showErr("Agent Router batch times must be 24-hour HH:MM (e.g. 10:00); leave unused batches blank.");
      return;
    }
    await send({
      type: "SET_SETTINGS",
      patch: {
        mode: $("mode").value,
        targetUrl: $("targetUrl").value.trim(),
        notify: $("notify").checked,
        notifySound: $("notifySound").checked,
        slowNetwork: $("slowNetwork").checked,
        arCloseTabs: $("arCloseTabs").checked,
        arQuotaNotify: $("arQuotaNotify").checked,
        arQuotaTimes: arTimes,
      },
    });
    const msg = $("settingsSaved");
    msg.style.display = "inline";
    setTimeout(() => (msg.style.display = "none"), 1500);
  } catch (e) {
    showErr("Couldn't save settings: " + (e && e.message ? e.message : e));
  }
};

// Client hierarchy level (ClickUp Advanced Settings). Saved immediately on
// change — background relabels every cached task's client tag right away, so
// the popup + this page update without a manual ClickUp refresh.
if ($("cuClientLevel")) {
  $("cuClientLevel").addEventListener("change", async (e) => {
    try {
      await send({ type: "SET_SETTINGS", patch: { cuClientLevel: (e.target && e.target.value) || "auto" } });
    } catch (err) {}
  });
}

// --- whole-card show/hide (persisted across visits) ---
// Adds a ▾/▸ toggle into each card's <h2> so any section can be folded away.
// The collapsed state is remembered per card by its heading text. The ClickUp
// card is the densest, so it defaults to collapsed the first time; everything
// else defaults to open.
//
// The Agent Router cards (Add an account / Your accounts / Debug / Settings)
// default to COLLAPSED until the user actually has accounts - a ClickUp-only user
// isn't shown the Agent Router machinery (including its Settings card) until they
// opt in by adding an account. applyAcctCardDefaults() re-applies this once the
// real account count is known (from load() or a live acctCount change); a
// remembered manual toggle wins.
const ACCT_CARD_KEYS = ["accountFormCard", "accountsCard", "debugCard", "settingsCard"];
let _cardCollapseState = {}; // the remembered per-card collapse map (shared w/ save)
const _cardCollapseApply = {}; // card key -> apply(collapsed) fn, set by initCardCollapse
let _cardCollapseReady = false;
let _pendingAcctHasAccounts = null; // last known hasAccounts, applied when ready

function applyAcctCardDefaults(hasAccounts) {
  _pendingAcctHasAccounts = hasAccounts;
  if (!_cardCollapseReady) return; // initCardCollapse will apply this when it finishes
  for (const key of ACCT_CARD_KEYS) {
    if (key in _cardCollapseState) continue; // a remembered manual choice always wins
    const fn = _cardCollapseApply[key];
    if (fn) fn(!hasAccounts); // no accounts -> collapsed; has accounts -> expanded
  }
}

async function initCardCollapse() {
  // Sidebar layout: each section is its own page, so cards don't fold.
  if (document.body.classList.contains("tabbed")) { _cardCollapseReady = true; return; }
  const cards = Array.from(document.querySelectorAll(".card"));
  const KEY = "optCardCollapse";
  let state = {};
  let clickupConfigured = false;
  let hasAccounts = false;
  try {
    const stored = await chrome.storage.local.get([KEY, "clickupEnc", "acctCount"]);
    if (stored && stored[KEY] && typeof stored[KEY] === "object") state = stored[KEY];
    // Proxy for "ClickUp is set up": a token blob is stored. Cheap + no decrypt.
    clickupConfigured = !!(stored && stored.clickupEnc);
    // Plaintext count mirrored by background.setAccounts (can't decrypt here).
    hasAccounts = !!(stored && Number(stored.acctCount) > 0);
  } catch (e) {}
  _cardCollapseState = state;
  const save = () => chrome.storage.local.set({ [KEY]: state }).catch(() => {});
  // One-time migration: Debug used to default-collapse and some installs may
  // have that saved as collapsed=true from before. Drop it once so it follows
  // the account-based default; a manual re-collapse afterward is still respected.
  if ("debugCard" in state) {
    delete state.debugCard;
    save();
  }
  cards.forEach((card) => {
    const h2 = card.querySelector("h2");
    if (!h2) return;
    // Stable key: prefer the card id (survives dynamic heading changes like
    // "Add an account" ↔ "Edit account"), else fall back to the heading text.
    const key = card.id || (h2.textContent || "").trim().slice(0, 40) || "card";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "card-coll";
    btn.title = "Show / hide this section";
    btn.setAttribute("aria-label", "Show or hide this section");
    // Defaults (a remembered choice always wins):
    //   • ClickUp card: collapsed once a token is stored (new users see the token
    //     field); expanded before that.
    //   • Agent Router cards: collapsed until the user has accounts.
    //   • Everything else: expanded.
    let defaultCollapsed = card.id === "clickupCard" && clickupConfigured;
    if (ACCT_CARD_KEYS.includes(card.id)) defaultCollapsed = !hasAccounts;
    let collapsed = key in state ? !!state[key] : defaultCollapsed;
    const apply = (col) => {
      card.classList.toggle("collapsed", col);
      btn.textContent = col ? "▸ Show" : "▾ Hide";
      btn.setAttribute("aria-expanded", String(!col));
    };
    apply(collapsed);
    _cardCollapseApply[key] = apply;
    btn.onclick = () => {
      collapsed = !card.classList.contains("collapsed");
      apply(collapsed);
      state[key] = collapsed;
      save();
    };
    h2.appendChild(btn);
  });
  _cardCollapseReady = true;
  // If load() already learned the account count while we were building, honour it.
  if (_pendingAcctHasAccounts !== null) applyAcctCardDefaults(_pendingAcctHasAccounts);
}

// --- theme (persisted, shared with the popup) ---
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $("themeToggle");
  if (btn) btn.textContent = t === "dark" ? "☀️ Light" : "🌙 Dark";
}
async function initTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  applyTheme(theme === "dark" ? "dark" : "light");
  const btn = $("themeToggle");
  if (btn)
    btn.onclick = async () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      await chrome.storage.local.set({ theme: next });
    };
}

// --- Label auto-mirrors the username while ADDING, until the user edits Label ---
$("label").addEventListener("input", () => {
  labelTouched = true;
});
$("username").addEventListener("input", () => {
  if (!editingId && !labelTouched) $("label").value = $("username").value.trim();
});

// --- show/hide toggles for the password + TOTP fields ---
document.querySelectorAll(".pw-toggle").forEach((b) => {
  b.addEventListener("click", () => {
    const inp = document.getElementById(b.dataset.target);
    if (!inp) return;
    const reveal = inp.type === "password";
    inp.type = reveal ? "text" : "password";
    b.textContent = reveal ? "🙈" : "👁";
    b.setAttribute("aria-label", reveal ? "Hide" : "Show");
  });
});

// --- live authenticator-code preview -----------------------------------------
// Lets you verify a TOTP secret without a full login: it shows the code the
// extension WOULD submit right now, so you can eyeball it against your phone's
// authenticator. The code is computed in the background (which holds the secret)
// and only the 6 digits + countdown come back - the secret never enters this page.
let totpTimer = null;
let totpLeft = 0;
let totpLastCode = "";

// Prefer a freshly-typed secret in the field; else the account being edited.
function totpSource() {
  const typed = $("totp").value.trim();
  if (typed) return { secret: typed };
  if (editingId) return { id: editingId };
  return null;
}
function setTotpReadout(nodeOrText) {
  const out = $("totpPreviewOut");
  if (!out) return;
  out.style.display = "inline";
  out.textContent = "";
  if (typeof nodeOrText === "string") out.textContent = nodeOrText;
  else if (nodeOrText) out.appendChild(nodeOrText);
}
function paintTotp() {
  const wrap = document.createElement("span");
  const code = document.createElement("span");
  code.className = "code";
  // Space the 6 digits (123 456) for easier comparison with a phone screen.
  code.textContent = totpLastCode ? totpLastCode.slice(0, 3) + " " + totpLastCode.slice(3) : "--- ---";
  wrap.appendChild(code);
  const tail = document.createElement("span");
  tail.textContent = "  ·  expires in " + totpLeft + "s";
  wrap.appendChild(tail);
  setTotpReadout(wrap);
}
async function refreshTotpPreview() {
  const src = totpSource();
  if (!src) {
    setTotpReadout("Type a TOTP secret above, or edit a saved account, first.");
    return;
  }
  try {
    const res = await send({ type: "PREVIEW_TOTP", ...src });
    if (!res || res.ok === false) {
      const span = document.createElement("span");
      span.className = "bad";
      span.textContent =
        res && res.reason === "invalid"
          ? "That secret isn't valid base32 - check for typos."
          : res && res.reason === "no-secret"
          ? "No TOTP secret saved for this account."
          : "Couldn't compute a code.";
      totpLastCode = "";
      setTotpReadout(span);
      return;
    }
    totpLastCode = res.code || "";
    totpLeft = Number.isFinite(res.secondsRemaining) ? res.secondsRemaining : 30;
    paintTotp();
  } catch (e) {
    totpLastCode = "";
    setTotpReadout("Couldn't compute a code: " + (e && e.message ? e.message : e));
  }
}
function stopTotpPreview() {
  if (totpTimer) {
    clearInterval(totpTimer);
    totpTimer = null;
  }
  totpLastCode = "";
  const out = $("totpPreviewOut");
  if (out) {
    out.style.display = "none";
    out.textContent = "";
  }
  const btn = $("totpPreviewBtn");
  if (btn) btn.textContent = "Show current code";
}
async function startTotpPreview() {
  await refreshTotpPreview();
  const btn = $("totpPreviewBtn");
  if (btn) btn.textContent = "Hide code";
  if (totpTimer) clearInterval(totpTimer);
  totpTimer = setInterval(() => {
    totpLeft -= 1;
    if (totpLeft <= 0) {
      totpLeft = 30; // optimistic; the refresh corrects it and stops a retry burst
      refreshTotpPreview();
    } else if (totpLastCode) {
      paintTotp();
    }
  }, 1000);
}
{
  const btn = $("totpPreviewBtn");
  if (btn) btn.onclick = () => (totpTimer ? stopTotpPreview() : startTotpPreview());
}

// --- Backup & restore (passphrase-encrypted export / import) ---
// If the background service worker is an OLD build (extension not reloaded after
// an update), it won't know these new message types and replies "unknown
// message". Turn that into a clear, actionable hint instead of a cryptic error.
const RELOAD_HINT =
  "The extension needs a reload to finish updating. Open chrome://extensions, click the reload ↻ icon on this extension, then reopen this page and try again.";

function backupMsg(text, ok) {
  const el = $("backupMsg");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "inline" : "none";
  el.style.color = ok === false ? "var(--red)" : "var(--green)";
}

// ---------- Drive Sync card wiring (sign in / out + Sync now) ----------
// Sign in / out. Sign-out clears the accounts saved on THIS device (so a
// different Google account can sign in and show its own accounts) - the same
// destructive local behavior as the popup, so confirm first and reassure that
// Drive keeps a backup. Sign-in runs the interactive Google flow (a few seconds).
$("optGoogleBtn").onclick = async () => {
  const on = !!(optLastState && optLastState.signedIn);
  if (on) {
    const ok = confirm(
      "Sign out of Google Drive?\n\n" +
      "This removes the Agent Router accounts saved on this device. " +
      "They're backed up to Drive first and come back when you sign in again."
    );
    if (!ok) return;
    // Sign-out pushes a final backup to Drive before wiping, which can take a
    // moment on a cold connection - show the "Syncing…" phase meanwhile.
    optDriveBusy = "sync";
    renderDriveSync(optLastState || {});
    try { await send({ type: "GOOGLE_SIGN_OUT" }, 30000); } catch (e) {}
    optDriveBusy = "";
    optSyncTransientText = "";
    await load();
    return;
  }
  // Sign-in: interactive Google flow. Show "Signing in…" so it's clear the page
  // is working (the background also broadcasts DRIVE_BUSY, which repaints the
  // card even if the sign-in was triggered from the popup).
  optDriveBusy = "signin";
  renderDriveSync(optLastState || {});
  let res = null;
  try { res = await send({ type: "GOOGLE_SIGN_IN" }, 60000); } catch (e) {}
  optDriveBusy = "";
  if (res && res.ok) {
    optSyncTransientText = "Synced ✓ " + fmtSyncStamp(res.syncedAt || Date.now());
    optSyncTransientUntil = Date.now() + 3500;
    setTimeout(() => { optSyncTransientText = ""; renderDriveSync(optLastState || {}); }, 3600);
  }
  await load();
};

$("optSyncNow").onclick = async () => {
  optDriveBusy = "sync";
  renderDriveSync(optLastState || {});
  let res = null;
  try { res = await send({ type: "SYNC_NOW" }, 30000); } catch (e) {}
  optDriveBusy = "";
  if (res && res.ok) {
    optSyncTransientText = "Synced ✓ " + fmtSyncStamp(res.syncedAt || Date.now());
    optSyncTransientUntil = Date.now() + 3500;
    setTimeout(() => { optSyncTransientText = ""; renderDriveSync(optLastState || {}); }, 3600);
  }
  await load();
};

$("exportBtn").onclick = async () => {
  const passphrase = $("backupPass").value;
  if (!passphrase || passphrase.length < 6) {
    backupMsg("Enter a passphrase of at least 6 characters first.", false);
    return;
  }
  try {
    backupMsg("");
    showErr("");
    const res = await send({ type: "EXPORT_ACCOUNTS", passphrase });
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      if (reason === "unknown message") backupMsg(RELOAD_HINT, false);
      else if (reason === "no accounts") backupMsg("No accounts to export yet.", false);
      else backupMsg("Export failed: " + ((res && (res.error || res.reason)) || "unknown"), false);
      return;
    }
    const json = JSON.stringify(res.backup, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = "daily-login-backup-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    backupMsg("Exported " + (res.count || "") + " account(s). Keep the file and passphrase safe.", true);
  } catch (e) {
    backupMsg("Export failed: " + (e && e.message ? e.message : e), false);
  }
};

$("importBtn").onclick = async () => {
  const file = $("importFile").files && $("importFile").files[0];
  const passphrase = $("backupPass").value;
  if (!file) {
    backupMsg("Choose a backup file to restore.", false);
    return;
  }
  if (!passphrase) {
    backupMsg("Enter the passphrase used when the backup was created.", false);
    return;
  }
  let backup;
  try {
    const text = await file.text();
    backup = JSON.parse(text);
  } catch (e) {
    backupMsg("That file isn't valid JSON - pick a Daily Login backup file.", false);
    return;
  }
  try {
    backupMsg("");
    showErr("");
    const mode = $("importReplace").checked ? "replace" : "merge";
    const res = await send({ type: "IMPORT_ACCOUNTS", backup, passphrase, mode });
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      if (reason === "unknown message") backupMsg(RELOAD_HINT, false);
      else backupMsg("Restore failed: " + ((res && (res.error || res.reason)) || "unknown"), false);
      return;
    }
    let extra = "";
    if (res.settingsRestored && res.clickupRestored) extra = " Settings and ClickUp config restored too.";
    else if (res.settingsRestored) extra = " Settings restored too.";
    else if (res.clickupRestored) extra = " ClickUp config restored too.";
    backupMsg("Restored - " + res.added + " added, " + res.updated + " updated (" + res.total + " total)." + extra, true);
    $("importFile").value = "";
    load();
  } catch (e) {
    backupMsg("Restore failed: " + (e && e.message ? e.message : e), false);
  }
};

// ===========================================================================
// ClickUp - daily time-estimate setup. All API calls happen in the background;
// this page only sends the token/prefs and renders the "public" view it gets
// back (which never contains the token - just a `configured` flag + state).
// ===========================================================================

// Small green/red status line under a ClickUp action (mirrors backupMsg()).
function cuMsg(elId, text, ok) {
  const el = $(elId);
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "inline" : "none";
  el.className = "saved" + (ok === false ? " bad" : "");
}

// Duration formatter (ms -> "2h 30m"). Kept local so options.js is standalone.
function fmtDurOpt(ms) {
  const totalMin = Math.round((Number(ms) || 0) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return h + "h " + m + "m";
  if (h > 0) return h + "h";
  return m + "m";
}

// Flexible estimate strings for the options page, mirroring the popup's editor:
// "20m", "20min", "1h 30m", "1.5" (bare number = hours). Null when unparseable.
function parseFlexDurationOpt(s) {
  const raw = String(s || "").trim().toLowerCase();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(parseFloat(raw) * 3600000); // bare number = hours
  const re = /(\d+(?:\.\d+)?)\s*((?:h|hr|hrs|hours?)|(?:m|min|mins|minutes?)|(?:s|secs?|seconds?))\b/g;
  let ms = 0, matched = false, m;
  while ((m = re.exec(raw)) !== null) {
    const n = parseFloat(m[1]);
    const u = m[2];
    if (/^h/.test(u)) ms += n * 3600000;
    else if (/^m/.test(u)) ms += n * 60000;
    else if (/^s/.test(u)) ms += n * 1000;
    matched = true;
  }
  return matched ? Math.round(ms) : null;
}
function fmtFlexDurOpt(ms) {
  if (!(Number(ms) > 0)) return "no est";
  const totalMin = Math.round(Number(ms) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return (h > 0 ? h + (m > 0 ? "h " + m + "m" : "h") : m + "m");
}

// While an estimate input is open, background repaints (storage listener, filter
// toggles, timers) are deferred - a repaint would destroy the input mid-typing.
let cuEstEditingOpt = false;
let cuRenderPendingOpt = false;
function flushDeferredRenderOpt() {
  if (cuEstEditingOpt || !cuRenderPendingOpt) return;
  cuRenderPendingOpt = false;
  scheduleClickupUiRefresh(0);
}

// A row's estimate may be a per-day SHARE (task spread over several days, the
// Extra task, configured tasks). Editing always sets the task's FULL ClickUp
// estimate, so prefill from the full value (null = total not known here).
function taskFullEstimateOpt(t) {
  if (t.totalEstimateMs != null) return Number(t.totalEstimateMs) || 0;
  if ("dayEstimateMs" in t || t.type === "cfg" || t.extended) return null;
  return Number(t.estimateMs) || 0;
}

// Inline estimate editor on the options page (same UX as the popup). Clicking
// the est text swaps it for a flexible duration input; Enter/blur saves through
// the background's SET_CLICKUP_ESTIMATE (single decrypt + PUT), Escape cancels.
function startEditEstimateOpt(estSpan, t) {
  if (estSpan._editing) return;
  const taskId = t.id || t.taskId || parseTaskIdFromUrl(t.url || "");
  if (!taskId) return;
  estSpan._editing = true;
  cuEstEditingOpt = true;
  const prevText = estSpan.textContent;
  const prevClass = estSpan.className;
  const fullMs = taskFullEstimateOpt(t);
  const isShare = fullMs == null || "dayEstimateMs" in t || fullMs !== (Number(t.estimateMs) || 0);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "est-input";
  input.value = fullMs > 0 ? fmtFlexDurOpt(fullMs) : "";
  input.placeholder = isShare ? "total, e.g. 5h" : "e.g. 20m, 1h 30m";
  input.title = isShare
    ? "Sets the task's TOTAL ClickUp estimate (this row shows only its share for the day). Enter = save, Esc = cancel."
    : "Enter = save, Esc = cancel. Accepts 20m, 1h 30m, 1.5 (hours).";
  estSpan.textContent = "";
  estSpan.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  let saving = false; // Enter and the blur that follows must not send two PUTs
  const finish = (text, cls, title) => {
    if (done) return;
    done = true;
    estSpan.textContent = text;
    estSpan.className = cls;
    estSpan.title = title || "Click to edit estimate";
    estSpan._editing = false;
    cuEstEditingOpt = false;
    flushDeferredRenderOpt();
  };
  const cancel = () => finish(prevText, prevClass);
  const save = async () => {
    if (done || saving) return;
    saving = true;
    const raw = input.value.trim();
    const newMs = parseFlexDurationOpt(raw);
    if (!raw || newMs == null || newMs === fullMs) { cancel(); return; }
    input.disabled = true;
    estSpan.classList.add("syncing"); // spinner while the PUT is in flight
    try {
      const resp = await send({ type: "SET_CLICKUP_ESTIMATE", taskId: String(taskId), estimateMs: newMs }, 15000);
      if (!resp || !resp.ok) throw new Error("save failed" + (resp && resp.status ? " (HTTP " + resp.status + ")" : ""));
      t.totalEstimateMs = newMs;
      if (!isShare) { t.estimateMs = newMs; t.hasEstimate = newMs > 0; }
      // Share rows show their new day share once the background recompute lands.
      markEstPendingOpt(taskId, newMs, isShare);
      cuRenderPendingOpt = true;
      finish(isShare ? prevText : (newMs > 0 ? fmtDurOpt(newMs) : "no est"),
        "est syncing" + (isShare || newMs > 0 ? "" : " zero"), "Saved to ClickUp - syncing totals…");
    } catch (e) {
      finish("save failed", "est zero", "Couldn't save estimate: " + (e && e.message ? e.message : e));
      setTimeout(() => { if (estSpan.textContent === "save failed") { estSpan.textContent = prevText; estSpan.className = prevClass; } }, 2500);
    }
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    // Enter saves directly (not via blur - blur never fires if the page lost focus).
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", save); cancel(); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
}
function parseTaskIdFromUrl(url) {
  const m = String(url || "").match(/\/t\/(?:\d+\/)?([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Saved-but-not-yet-synced estimates: taskId -> { ms, isShare, timer }. The row
// shows the new value with a spinner until the background's recompute lands
// (CLICKUP_EST_SYNCED) - so it never looks like the edit was lost. Re-applied
// after every repaint via a MutationObserver, whichever renderer drew the row.
const cuEstPendingOpt = new Map();
function markEstPendingOpt(taskId, ms, isShare) {
  const id = String(taskId);
  const prev = cuEstPendingOpt.get(id);
  if (prev) clearTimeout(prev.timer);
  // Safety net: never spin forever if the sync message is missed.
  const timer = setTimeout(() => { cuEstPendingOpt.delete(id); scheduleClickupUiRefresh(0); }, 120000);
  cuEstPendingOpt.set(id, { ms, isShare, timer });
  applyEstPendingOpt();
}
function applyEstPendingOpt() {
  if (!cuEstPendingOpt.size) return;
  document.querySelectorAll(".cu-task").forEach((row) => {
    const t = row._cuTask;
    if (!t) return;
    const p = cuEstPendingOpt.get(String(t.id || t.taskId || ""));
    if (!p) return;
    const el = row.querySelector(".est");
    if (!el || el.querySelector("input")) return;
    if (!p.isShare) {
      const txt = p.ms > 0 ? fmtDurOpt(p.ms) : "no est";
      if (el.textContent !== txt) el.textContent = txt;
      const cls = "est syncing" + (p.ms > 0 ? "" : " zero");
      if (el.className !== cls) el.className = cls;
    } else if (!el.classList.contains("syncing")) {
      el.classList.add("syncing");
    }
    el.title = "Saved to ClickUp - syncing totals…";
  });
}
let cuEstApplyQueuedOpt = false;
if (document.body) {
  new MutationObserver(() => {
    if (!cuEstPendingOpt.size || cuEstApplyQueuedOpt) return;
    cuEstApplyQueuedOpt = true;
    requestAnimationFrame(() => { cuEstApplyQueuedOpt = false; applyEstPendingOpt(); });
  }).observe(document.body, { childList: true, subtree: true });
}
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "CLICKUP_EST_SYNCED") return;
  const id = String(msg.taskId || "");
  const p = cuEstPendingOpt.get(id);
  if (p) { clearTimeout(p.timer); cuEstPendingOpt.delete(id); }
  scheduleClickupUiRefresh(0);
});

// ONE delegated handler for every estimate in every task list on this page
// (today preview, filter results, weekly per-day lists...). Capture phase on
// document, so it replaces any per-row listener and no renderer can miss it.
// The row's task comes from row._cuTask, stamped by appendNameCellOpt.
document.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest(".cu-task .est") : null;
  if (!el || el.querySelector("input")) return;
  const row = el.closest(".cu-task");
  const t = row && row._cuTask;
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  startEditEstimateOpt(el, t);
}, true);

// Last-clickup public state (set on every load()), used by the weekly + filter
// sections so they don't refetch anything on the ToToday/ToFriday toggle.
let optClickup = null;

// ---- Department Creator (module-local) ----
// Member directory + saved departments, refreshed from CLICKUP_DEPT_DATA.
let optDeptMembers = []; // [{ id, name }]
let optDeptList = [];    // [{ id, name, users:[{id,name}] }]
let optDeptEditing = null; // id of the department currently in the editor (null = new)
let optDeptDraft = [];   // { id, name } pairs chosen for the department being edited

function dayStartOpt(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function dayEndOpt(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}
function mondayOfOpt(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const d2 = new Date(d);
  d2.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d2;
}
function weekdayNameOpt(dow) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
}
function makeLinkOpt(url, label) {
  const a = document.createElement("a");
  a.className = "nm";
  a.textContent = label;
  a.title = label || url || ""; // full name on hover (the .nm column ellipsis-truncates)
  if (url) {
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.href = "#";
    a.style.cursor = "default";
    a.addEventListener("click", (e) => e.preventDefault());
  }
  return a;
}

// Wrap a task-name node with a small client pill (when the task carries a
// resolved client). Mirrors the popup's appendNameCell. The wrapper keeps the
// name ellipsis-truncating while the pill stays a fixed, non-shrinking tag so
// long names never push it off-row.

// ---------- Priority order + badge ----------
// Default task order everywhere: Urgent -> High -> Normal -> Low -> no priority,
// then the bigger estimate first. Subtasks stay directly under their parent.
const CU_PRIO_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function cuPrioRank(t) {
  const r = CU_PRIO_RANK[String((t && t.priority) || "").toLowerCase()];
  return r == null ? 4 : r;
}
function cuPrioCmp(a, b) {
  return cuPrioRank(a) - cuPrioRank(b) ||
    (Number(b.estimateMs != null ? b.estimateMs : b.dayEstimateMs) || 0) - (Number(a.estimateMs != null ? a.estimateMs : a.dayEstimateMs) || 0);
}
function sortByPriority(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const idOf = (t) => String(t && (t.id != null ? t.id : t.taskId));
  const present = new Set(list.map(idOf));
  const subs = new Map();
  const top = [];
  for (const t of list) {
    if (t && t.isSubtask && t.parentId != null && present.has(String(t.parentId))) {
      const k = String(t.parentId);
      if (!subs.has(k)) subs.set(k, []);
      subs.get(k).push(t);
    } else top.push(t);
  }
  top.sort(cuPrioCmp);
  const out = [];
  for (const p of top) {
    out.push(p);
    const s = subs.get(idOf(p));
    if (s) out.push(...s.slice().sort(cuPrioCmp));
  }
  return out;
}
// Small coloured letter before the task name: U red, H orange, N yellow, L grey.
// No priority -> an invisible spacer so every row's name starts at the same x.
function prioBadge(t) {
  const p = String((t && t.priority) || "").toLowerCase();
  const map = { urgent: "U", high: "H", normal: "N", low: "L" };
  const b = document.createElement("span");
  b.className = "cu-prio " + (map[p] ? "p-" + p : "p-none");
  b.textContent = map[p] || "";
  if (map[p]) b.title = "Priority: " + p.charAt(0).toUpperCase() + p.slice(1);
  else b.setAttribute("aria-hidden", "true");
  return b;
}


// ---------- "Waiting on others" chip ----------
// One compact slot per row; it only takes space when some row in the list has a
// chip (CSS :has). Amber = waiting on someone else's open subtask; red = that
// subtask is overdue. Hover lists the blockers; click opens the first in ClickUp.
function cuWaitMap() { const st = (optClickup && optClickup.state) || null; return (st && st.waiting) || {}; }
function cuWaitFor(t) {
  const id = t && (t.id != null ? t.id : t.taskId);
  return id != null ? cuWaitMap()[String(id)] || null : null;
}
function waitSlot(t) {
  const span = document.createElement("span");
  span.className = "cu-wait";
  const w = cuWaitFor(t);
  if (!w || !Array.isArray(w.blockers) || !w.blockers.length) return span;
  const b = w.blockers;
  const late = b.some((x) => x.overdue);
  const people = Array.from(new Set(b.map((x) => String(x.who || "someone").split(/\s+/)[0])));
  span.classList.add("on", late ? "late" : "waiting");
  const icon = document.createElement("span");
  icon.className = "wi";
  icon.textContent = "\u23F3";
  const label = document.createElement("span");
  label.className = "wl";
  label.textContent = (late ? "Blocked: " : "Waiting: ") + people[0] + (people.length > 1 ? " +" + (people.length - 1) : "") + (late ? " late" : "");
  span.appendChild(icon);
  span.appendChild(label);
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  span.title = (late ? "Blocked by someone else's overdue subtask" : "Your part is done - waiting on someone else") + ":\n" +
    b.map((x) => "\u2022 " + x.name + " \u00B7 " + x.who + (x.due ? " \u00B7 due " + fmt(x.due) : "") + (x.overdue ? " (overdue)" : "")).join("\n") +
    "\nClick to open it in ClickUp.";
  span.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.open(b[0].url, "_blank", "noopener"); });
  return span;
}
// Time cell: "tracked / est". Tracked turns red past the estimate; a running
// timer gets a dot. Called right after the tracked text is set.
function markTrk(trk, t) {
  const spent = Number(t && t.spentMs) || 0;
  const est = Number(t && (t.estimateMs != null ? t.estimateMs : t.dayEstimateMs)) || 0;
  if (est > 0 && spent > est) trk.classList.add("over");
  const st = (optClickup && optClickup.state) || null;
  const run = st && st.running;
  const id = t && (t.id != null ? t.id : t.taskId);
  if (run && id != null && String(run.taskId) === String(id)) trk.classList.add("running");
}

// Small floating message used by the due-date editor (both pages).
function cuDueToastOpt(text) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1200;max-width:90%;padding:8px 12px;border-radius:8px;background:var(--red);color:#fff;font-size:12px;box-shadow:0 8px 20px rgba(0,0,0,.25)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
// ---------- export: remember what the list is showing right now ----------
let cuExportDataOpt = { rows: [], title: "tasks" };
function cuExportRowsOpt(tasks, deadlineTasks, trackedTasks, scope) {
  const all = [].concat(tasks || [], deadlineTasks || [], trackedTasks || []);
  const seen = new Set();
  const rows = [];
  for (const t of all) {
    if (!t || t.id == null || t.error) continue;
    const id = String(t.id);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      name: t.name || "(untitled task)",
      isSubtask: !!t.isSubtask,
      client: t.client || "",
      dueDateMs: Number(t.dueDateMs) || null,
      estimateMs: Number(t.totalEstimateMs || t.estimateMs || t.dayEstimateMs) || 0,
      spentMs: Number(t.spentMs) || 0,
      status: t.status || "",
      done: !!t.done,
      url: t.url || "",
    });
  }
  cuExportDataOpt = { rows, title: scope || "tasks" };
}

// ---------- due date: click the chip to set / change / clear it ----------
function startEditDueOpt(chip, task) {
  if (chip._editing) return;
  const taskId = task.id || task.taskId;
  if (!taskId) return;
  chip._editing = true;
  const prevText = chip.textContent;
  const prevClass = chip.className;
  const prevTitle = chip.title;
  const ms = Number(task.dueDateMs) || 0;
  const input = document.createElement("input");
  input.type = "date";
  input.className = "due-input";
  input.title = "Enter = save, Esc = cancel. Empty = no due date.";
  if (ms) {
    const d = new Date(ms);
    input.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  chip.textContent = "";
  chip.appendChild(input);
  input.focus();
  let done = false;
  let saving = false;
  const finish = (text, cls, title) => {
    if (done) return;
    done = true;
    chip.textContent = text;
    chip.className = cls;
    chip.title = title;
    chip._editing = false;
  };
  const cancel = () => finish(prevText, prevClass, prevTitle);
  const save = async () => {
    if (done || saving) return;
    saving = true;
    const v = input.value;
    let newMs = null;
    if (v) {
      const [y, m, d] = v.split("-").map(Number);
      const keep = ms ? new Date(ms) : null;
      newMs = new Date(y, m - 1, d, keep ? keep.getHours() : 12, keep ? keep.getMinutes() : 0, 0, 0).getTime();
    }
    if ((newMs || 0) === ms) { cancel(); return; }
    input.disabled = true;
    try {
      const r = await send({ type: "CLICKUP_SET_DUE", taskId: String(taskId), dueMs: newMs }, 15000);
      if (!r || !r.ok) throw new Error((r && (r.error || r.reason)) || "save failed");
      task.dueDateMs = newMs;
      finish(newMs ? new Date(newMs).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) : "+ due",
        "cu-due" + (newMs ? " syncing" : " nodue"), "Saved to ClickUp - syncing…");
    } catch (e) {
      cancel();
      cuDueToastOpt("Couldn't save the due date: " + (e && e.message ? e.message : e));
    }
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", save); cancel(); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
}
function makeDueEditableOpt(chip, t) {
  if (!chip || !t || (t.id == null && t.taskId == null)) return chip;
  chip.style.cursor = "pointer";
  chip.title = (chip.title ? chip.title + " · " : "") + "Click to edit the due date";
  chip.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); startEditDueOpt(chip, t); });
  return chip;
}

function appendNameCellOpt(row, nm, t) {
  row.appendChild(prioBadge(t));
  // Every task row passes through here, so it's also where the row learns its
  // task object - the delegated estimate editor reads it back (row._cuTask).
  row._cuTask = t;
  const client = t && t.client ? String(t.client) : "";
  const due = dueChipOpt(t);
  const wrap = document.createElement("span");
  wrap.className = "nmwrap";
  wrap.appendChild(nm);
  if (client) {
    const pill = document.createElement("span");
    pill.className = "cu-client";
    pill.textContent = client;
    pill.title = "Client: " + client;
    wrap.appendChild(pill);
  }
  if (due) wrap.appendChild(due);
  wrap.appendChild(waitSlot(t));
  row.appendChild(wrap);
}

// Small due-date chip: "Today" / "Tmrw" / "Sep 20", red when past due (and not
// done). Returns null when the task has no due date.
function dueChipOpt(t) {
  const ms = Number(t && t.dueDateMs) || 0;
  if (!ms) {
    const add = document.createElement("span");
    add.className = "cu-due nodue";
    add.textContent = "+ due";
    add.title = "No due date";
    return makeDueEditableOpt(add, t);
  }
  const day = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const overdue = diff < 0 && !(t && t.done);
  const chip = document.createElement("span");
  chip.className = "cu-due" + (diff === 0 ? " today" : "") + (overdue ? " overdue" : "");
  chip.textContent = diff === 0 ? "Today" : diff === 1 ? "Tmrw" : diff === -1 ? "Yday"
    : new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  chip.title = "Due " + new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) +
    (overdue ? " - overdue" : "");
  return makeDueEditableOpt(chip, t);
}
function appendDoneTickOpt(anchor, t) {
  if (t && t.done) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    anchor.appendChild(tick);
  }
}
// when we only know the saved teamId (e.g. after a reload, before re-verify).
function populateTeams(teams, selectedId, fallbackName) {
  const sel = $("cuTeam");
  if (!sel) return;
  sel.innerHTML = "";
  const list = teams && teams.length ? teams : selectedId ? [{ id: String(selectedId), name: fallbackName || "Current workspace" }] : [];
  if (!list.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(reconnect to load workspaces)";
    sel.appendChild(opt);
    return;
  }
  for (const t of list) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = t.name;
    if (String(t.id) === String(selectedId)) opt.selected = true;
    sel.appendChild(opt);
  }
}

// Resolve the real workspace names with the saved token so the Workspace dropdown
// shows e.g. "Acme Corp" instead of the "Current workspace" stub after a reload.
// The background caches this for 10 minutes, so this is effectively free on
// repeated options opens.
async function refreshCuTeams() {
  const res = await send({ type: "CLICKUP_GET_TEAMS" }).catch(() => null);
  if (!res || res.ok !== true || !Array.isArray(res.teams)) return;
  cuTeams = res.teams;
  cuTeamName = res.teamName || "";
  populateTeams(cuTeams, (optClickup && optClickup.teamId) || res.teamId || "", cuTeamName);
}

// Show/hide the connected section and mirror the saved prefs into the form.
// Start/Stop Extra Task timer (options page): in-flight guard + a transient
// message shown next to the button that survives re-renders until the next action.
let cuTimerBusy = false;
let cuTimerMsg = "";

// Per-task Start/Stop/Complete controls (options mirror of the popup). Per-row
// in-flight guard + a transient inline message keyed by task id, so one busy row
// doesn't disable the rest and a refusal reason survives the repaint.
const cuRowBusyOpt = new Set();
const cuRowMsgOpt = {};
// task-id -> { activeTaskName, tracking } while a Start awaits switch confirmation.
const cuRowConfirmOpt = {};

// Render the Start/Stop toggle next to the auto-detected Extra Task. The label
// and action come from the live running entry (cu.state.running) vs the detected
// task; re-wired each render so the closure always sees fresh state.

// ---------- Extra Task mode: Custom (optional note) / Meeting ----------
// The choice becomes the time entry's description in ClickUp. The controls are
// hidden while the Extra Task itself is being tracked.
function extraModeDescription() {
  const m = document.querySelector('input[name="cuXModeRadio"]:checked');
  if (m && m.value === "meeting") return "Meeting";
  const n = document.getElementById("cuXNote");
  return n ? n.value.trim() : "";
}
function showExtraMode(on) {
  const box = document.getElementById("cuXMode");
  if (box) box.style.display = on ? "" : "none";
}
// Shared with the other page (popup <-> options) via storage "cuXDraft".
function applyExtraDraft(d) {
  const mode = d && d.mode === "meeting" ? "meeting" : "custom";
  const r = document.querySelector('input[name="cuXModeRadio"][value="' + mode + '"]');
  if (r) r.checked = true;
  const n = document.getElementById("cuXNote");
  if (n) {
    if (document.activeElement !== n) n.value = (d && typeof d.note === "string") ? d.note : "";
    n.disabled = mode === "meeting";
  }
}
function saveExtraDraft() {
  const m = document.querySelector('input[name="cuXModeRadio"]:checked');
  const n = document.getElementById("cuXNote");
  const d = { mode: m && m.value === "meeting" ? "meeting" : "custom", note: n ? n.value : "" };
  try { chrome.storage.local.set({ cuXDraft: d }); } catch (e) {}
}
function resetExtraMode() {
  const d = { mode: "custom", note: "" };
  const n = document.getElementById("cuXNote");
  if (n) n.value = "";
  applyExtraDraft(d);
  try { chrome.storage.local.set({ cuXDraft: d }); } catch (e) {}
}
document.addEventListener("change", (e) => {
  if (!e.target || e.target.name !== "cuXModeRadio") return;
  const n = document.getElementById("cuXNote");
  if (n) n.disabled = e.target.value === "meeting";
  saveExtraDraft();
});
document.addEventListener("input", (e) => {
  if (e.target && e.target.id === "cuXNote") saveExtraDraft();
});
try {
  chrome.storage.local.get("cuXDraft").then(({ cuXDraft }) => applyExtraDraft(cuXDraft));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.cuXDraft) applyExtraDraft(ch.cuXDraft.newValue);
  });
} catch (e) {}

function renderExtraTimerButton(extra, running) {
  const btn = $("cuTimerBtn");
  const hint = $("cuTimerHint");
  if (!btn || !hint) return;
  const onExtra = running && running.taskId && String(running.taskId) === String(extra.id);
  showExtraMode(!onExtra);
  btn.disabled = cuTimerBusy;
  if (onExtra) {
    btn.textContent = cuTimerBusy ? "…" : "⏸ Stop tracking";
    btn.className = "danger";
    btn.onclick = () => toggleExtraTimer("stop");
    const since = running.startMs ? " · since " + new Date(running.startMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    hint.textContent = cuTimerMsg || ("Tracking now" + since);
  } else {
    btn.textContent = cuTimerBusy ? "…" : "▶ Start tracking";
    btn.className = "primary";
    btn.onclick = () => toggleExtraTimer("start");
    if (cuTimerMsg) hint.textContent = cuTimerMsg;
    else if (running && running.taskId) hint.textContent = "Another task is running — click to switch tracking here.";
    else hint.textContent = "Starts a ClickUp timer on this task.";
  }
}

async function toggleExtraTimer(action) {
  if (cuTimerBusy) return;
  cuTimerBusy = true;
  cuTimerMsg = "";
  const btn = $("cuTimerBtn");
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const type = action === "stop" ? "CLICKUP_STOP_TIMER" : "CLICKUP_START_TIMER";
    // The background does start/stop THEN a today+tasks refresh before replying,
    // which routinely exceeds the default 8s (the timer had already started, so
    // the popup - which waits 20s - succeeded while options wrongly showed "No
    // response"). Wait as long as the popup does.
    const description = action === "stop" ? undefined : extraModeDescription();
    const res = await send({ type, description }, 20000);
    if (res && res.ok !== false && action !== "stop") resetExtraMode();
    cuTimerBusy = false;
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      const map = { "not-configured": "connect ClickUp first", "incomplete-setup": "pick a workspace first", "no-task": "no Extra Tasks task detected" };
      cuTimerMsg = "Couldn't " + (action === "stop" ? "stop" : "start") + ": " + ((res && res.error) || map[reason] || reason || "unknown error");
    }
  } catch (e) {
    cuTimerBusy = false;
    cuTimerMsg = "Couldn't update timer: " + (e && e.message ? e.message : e);
  }
  await load(); // repaint with fresh running state (and the error hint if any)
}

// Append the per-task action controls (Start/Stop + Complete) to an options task
// row. Mirrors the popup's appendTaskControls: done tasks show nothing (the static
// ✓ already marks them); the Start/Stop label comes from the live running timer
// (optClickup.state.running); a per-row busy guard + inline message key off the
// task id.
function appendTaskControlsOpt(row, t) {
  if (!t || !t.id) return;
  if (t.done) return; // completed - no live controls
  const cu = optClickup || {};
  if (!cu.configured) return;
  const tid = String(t.id);
  const running = cu.state && cu.state.running ? cu.state.running : null;
  const isRunning = running && String(running.taskId) === tid;
  const busy = cuRowBusyOpt.has(tid);

  const actions = document.createElement("span");
  actions.className = "cu-actions";

  if (isRunning) {
    const stop = document.createElement("button");
    stop.className = "cu-iconbtn stop";
    stop.title = "Stop tracking · set to “to do”";
    stop.textContent = busy ? "…" : "⏸";
    stop.disabled = busy;
    stop.onclick = () => sendTaskActionOpt(tid, "stop");
    actions.appendChild(stop);
  } else {
    const start = document.createElement("button");
    start.className = "cu-iconbtn start";
    start.title = "Start · set to “in progress” and start the timer";
    start.textContent = busy ? "…" : "▶";
    start.disabled = busy;
    start.onclick = () => sendTaskActionOpt(tid, "start");
    actions.appendChild(start);
  }

  const done = document.createElement("button");
  done.className = "cu-iconbtn done";
  done.title = "Mark complete · stops the timer";
  done.textContent = "✓";
  done.disabled = busy;
  done.onclick = () => sendTaskActionOpt(tid, "complete");
  actions.appendChild(done);

  row.appendChild(actions);

  // Switch confirmation: another task is in progress. Warn, then let the user
  // confirm the switch (start this one, stop + revert the other) or cancel.
  const cf = cuRowConfirmOpt[tid];
  if (cf) {
    const warn = document.createElement("div");
    warn.className = "cu-rowmsg cu-rowconfirm";
    const txt = document.createElement("span");
    // Name is a clickable link so the user can open the blocking task in ClickUp.
    if (cf.activeTaskName) {
      if (cf.activeTaskUrl) {
        const a = document.createElement("a");
        a.href = cf.activeTaskUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "“" + cf.activeTaskName + "”";
        txt.appendChild(a);
      } else {
        txt.appendChild(document.createTextNode("“" + cf.activeTaskName + "”"));
      }
    } else {
      txt.appendChild(document.createTextNode("Another task"));
    }
    // Precise state: in progress + tracking / in progress only / tracking only.
    let stateWord;
    if (cf.activeInProgress && cf.tracking) stateWord = " is in progress and actively tracking";
    else if (cf.activeInProgress) stateWord = " is in progress";
    else if (cf.tracking) stateWord = " is actively tracking";
    else stateWord = " is already active";
    txt.appendChild(document.createTextNode(
      stateWord + ". Start this task instead? The other stops and returns to “to do”."));
    warn.appendChild(txt);
    const btns = document.createElement("span");
    btns.className = "cu-confirm-btns";
    const yes = document.createElement("button");
    yes.className = "cu-iconbtn start";
    yes.textContent = "Start anyway";
    yes.onclick = () => { delete cuRowConfirmOpt[tid]; sendTaskActionOpt(tid, "start", true); };
    const no = document.createElement("button");
    no.className = "cu-iconbtn";
    no.textContent = "Cancel";
    no.onclick = () => { delete cuRowConfirmOpt[tid]; repaintCuTaskRows(); };
    btns.appendChild(yes);
    btns.appendChild(no);
    warn.appendChild(btns);
    row.appendChild(warn);
  } else if (cuRowMsgOpt[tid]) {
    const msg = document.createElement("div");
    msg.className = "cu-rowmsg";
    msg.textContent = cuRowMsgOpt[tid];
    row.appendChild(msg);
  }
}

// Fire a per-task Start/Stop/Complete action from the options page, then repaint.
// 20s timeout (the background does the ClickUp write THEN a today+tasks refresh
// before replying). Errors surface inline on the row via cuRowMsgOpt.
async function sendTaskActionOpt(taskId, action, force) {
  const tid = String(taskId);
  if (cuRowBusyOpt.has(tid)) return;
  cuRowBusyOpt.add(tid);
  delete cuRowMsgOpt[tid];
  delete cuRowConfirmOpt[tid];
  repaintCuTaskRows(); // repaint so the clicked row shows its busy "…" state
  const typeMap = { start: "CLICKUP_TASK_START", stop: "CLICKUP_TASK_STOP", complete: "CLICKUP_TASK_COMPLETE" };
  try {
    const res = await send({ type: typeMap[action], taskId: tid, force: !!force }, 20000);
    cuRowBusyOpt.delete(tid);
    if (!res || res.ok === false) {
      if (res && res.reason === "needs-confirm") {
        cuRowConfirmOpt[tid] = {
          activeTaskName: res.activeTaskName || "",
          activeTaskUrl: res.activeTaskUrl || "",
          activeInProgress: !!res.activeInProgress,
          tracking: !!res.tracking,
        };
        repaintCuTaskRows();
        return;
      }
      if (res && res.reason === "multi-assignee") {
        const names = Array.isArray(res.assignees) && res.assignees.length
          ? res.assignees.map(a => a.username || a.id).filter(Boolean).join(", ")
          : null;
        cuRowMsgOpt[tid] = "Can't start — assigned to multiple users" + (names ? " (" + names + ")" : "") + ". Only single-assignee tasks can be started via the extension.";
      } else {
        const reason = res && res.reason;
        const map = { "not-configured": "connect ClickUp first", "incomplete-setup": "pick a workspace first", "no-task": "task id missing" };
        const verb = action === "complete" ? "complete" : action;
        cuRowMsgOpt[tid] = "Couldn't " + verb + ": " + ((res && res.error) || map[reason] || reason || "unknown error");
      }
      repaintCuTaskRows();
      return;
    }
  } catch (e) {
    cuRowBusyOpt.delete(tid);
    cuRowMsgOpt[tid] = "Couldn't update task: " + (e && e.message ? e.message : e);
    repaintCuTaskRows();
    return;
  }
  // Success: background updated clickupState; a full load() repaints with fresh
  // running/status everywhere (and the storage listener also fires).
  await load();
}

// Repaint both the Today preview and the Filter card so a per-task control's busy
// "…" state and any inline (e.g. multi-assignee) message land on whichever list the
// clicked row lives in - the same task can appear in either.
function repaintCuTaskRows() {
  if (optClickup && optClickup.state) renderClickupPreview(optClickup.state);
  renderOptionsFilter();
}

function renderClickupSettings(cu) {
  cu = cu || {};
  const configured = !!cu.configured;
  $("cuClear").style.display = configured ? "inline-block" : "none";
  $("cuConnected").style.display = configured ? "block" : "none";
  $("cuSettingsBody").style.display = configured ? "block" : "none";
  $("cuTodayWrap").style.display = configured ? "block" : "none";
  document.querySelectorAll(".cu-needs-config").forEach((el) => { el.style.display = configured ? "" : "none"; });
  if ($("cuDashEmpty")) $("cuDashEmpty").style.display = configured ? "none" : "";
  $("cuSaveToken").textContent = configured ? "Update token" : "Save & connect";
  // The "Connection settings" sub-section (API token + workspace) defaults to
  // collapsed once connected - nothing to set up there day-to-day. But before
  // a token is saved there's nothing to hide yet, so force it open and hide the
  // toggle itself; once configured, the toggle reappears and initOptCollapse()'s
  // remembered preference (or its own default-collapsed) takes back over.
  const connBody = $("cuConnBody");
  const connBtn = document.querySelector('[data-optcollapse="connection"]');
  if (connBody && connBtn) {
    if (!configured) {
      connBody.classList.remove("collapsed");
      connBtn.style.display = "none";
    } else {
      connBtn.style.display = "";
    }
  }
  const admEl = $("cuSaveAdminToken");
  if (admEl) {
    admEl.textContent = cu.adminConfigured ? "Update admin token" : "Save admin token";
  }
  // First-run discoverability: while unconfigured keep the whole ClickUp card
  // expanded so the token field is visible immediately (mirrors the
  // collapsed-only-when-configured default in initCardCollapse). Once
  // configured we leave the card's remembered/default collapse alone. Guarded
  // because initCardCollapse creates the .card-coll button asynchronously, so
  // it may not exist yet on the first render.
  const cuCard = $("clickupCard");
  if (cuCard && !configured) {
    cuCard.classList.remove("collapsed");
    const cardBtn = cuCard.querySelector(".card-coll");
    if (cardBtn) {
      cardBtn.textContent = "▾ Hide";
      cardBtn.setAttribute("aria-expanded", "true");
    }
  }
  // Prominent account bar (visible once connected) - shows who's signed in plus
  // Manage connection / Sign out, so the token + admin fields aren't buried in
  // the collapsed "Connection settings" section.
  const bar = $("cuAccountBar");
  if (bar) {
    bar.style.display = configured ? "flex" : "none";
    if (configured) {
      const u = cu.user || {};
      $("cuAccountName").textContent = u.username || u.email || "your ClickUp account";
      $("cuAccountTeam").textContent = cu.teamName ? " · " + cu.teamName : "";
      const adm = $("cuAccountAdmin");
      if (cu.adminConfigured) {
        const au = cu.adminUser || {};
        adm.textContent = "Admin token: " + ((au.username || au.email) || "connected") + " ✓";
        adm.style.display = "";
      } else {
        adm.style.display = "none";
      }
    }
  }
  $("cuTarget").value = cu.targetHours != null ? String(cu.targetHours) : "7";
  $("cuNudge").value = cu.nudgeHour != null ? String(cu.nudgeHour) : "15";
  $("cuWorkdayEnd").value = cu.workdayEndHour != null ? String(cu.workdayEndHour) : "16";
  $("cuDeadlineUrls").value = Array.isArray(cu.deadlineTaskUrls) ? cu.deadlineTaskUrls.join("\n") : "";
  $("cuExtendedMode") && ($("cuExtendedMode").value = cu.extendedMode === "excl0" ? "excl0" : "days");
  $("cuWeeklyTo") && ($("cuWeeklyTo").value = cu.weeklyTo === "friday" ? "friday" : "today");
  const extra = (cu.state && cu.state.extraTask) || null;
  const running = (cu.state && cu.state.running) || null;
  const autoExtra = $("cuAutoExtra");
  const autoNote = $("cuAutoExtraNote");
  if (autoExtra && autoNote) {
    if (extra && extra.name) {
      autoExtra.style.display = "";
      autoNote.style.display = "none";
      const link = $("cuAutoExtraName");
      link.textContent = extra.name + (extra.status ? " [" + extra.status + "]" : "");
      if (extra.url) {
        link.href = extra.url;
        link.title = extra.url;
      } else {
        link.removeAttribute("href");
      }
      renderExtraTimerButton(extra, running);
    } else {
      autoExtra.style.display = "none";
      autoNote.style.display = "";
    }
  }
  $("cuBadge").checked = cu.badge !== false;
  $("cuNotify").checked = cu.notify !== false;
  $("cuHalfway").checked = cu.halfwayNotify !== false;
  $("cuAlmostThere").checked = cu.almostThereNotify !== false;
  $("cuRunningNotify").checked = cu.runningNotify !== false;
  $("cuRunningThreshold").value = cu.runningThresholdMin != null ? String(cu.runningThresholdMin) : "10";
  $("cuIdleNotify").checked = cu.idleNotify !== false;
  $("cuIdleStart").value = cu.idleStartHour != null ? String(cu.idleStartHour) : "8";
  $("cuIdleEnd").value = cu.idleEndHour != null ? String(cu.idleEndHour) : "17";
  $("cuIdleRepeat").value = cu.idleRepeatMin != null ? String(cu.idleRepeatMin) : "60";
  if ($("cuSyncMin")) $("cuSyncMin").value = String(cu.syncMin || 5);
  if ($("cuWeekMode")) $("cuWeekMode").value = cu.weekMode || "sun-sat";
  $("cuAwayNotify").checked = cu.awayNotify !== false;
  $("cuAwayMin").value = cu.awayMin != null ? String(cu.awayMin) : "15";
  $("cuWrapUp").checked = cu.wrapUp !== false;
  $("cuWrapUpTime").value = cu.wrapUpTime || "16:45";
  if (configured) {
    populateTeams(cuTeams, cu.teamId, cu.teamName || cuTeamName || "");
    // Configured but the first refresh hasn't landed yet -> show a spinner so the
    // card visibly reads "loading", not "stuck", until the numbers arrive.
    if (cu.state) renderClickupPreview(cu.state);
    else renderCuPreviewLoading();
  } else {
    $("cuPreview").style.display = "none";
  }
  renderOptionsWeekly(cu);
  renderOptionsFilter();
}

// Weekly totals section in the options page. Reuses the background's cached
// aggregates (Mon→today + Mon→Friday) - the toggle is instant, no network.
// ts -> open? for the per-day groups (unset = default: only today open).
const optWeekDayOpen = new Map();
function renderOptionsWeekly(cu) {
  if (cuEstEditingOpt) { cuRenderPendingOpt = true; return; }
  cu = cu || {};
  const w = cu.state && cu.state.weekly;
  if (!cu.configured || !w || !w.today || !w.friday) {
    $("optWeekEst").textContent = "-";
    $("optWeekTrk").textContent = "-";
    ["optWeekEstFill", "optWeekTrkFill"].forEach((id) => { if ($(id)) $(id).style.width = "0%"; });
    $("optWeekSub").textContent = "";
    const listBox0 = $("optWeekList");
    if (listBox0) { listBox0.style.display = "none"; listBox0.innerHTML = ""; }
    document.querySelectorAll("#optWeekToggle button").forEach((b) => (b.className = ""));
    return;
  }
  const to = cu.weeklyTo === "friday" ? "friday" : "today";
  const agg = to === "friday" ? w.friday : w.today;
  $("optWeekEst").textContent = fmtDurOpt(agg.estimateMs);
  $("optWeekTrk").textContent = fmtDurOpt(agg.spentMs);
  {
    const wTarget = (Number(cu.state && cu.state.targetMs) || 0) * (Number(agg.count) || 0);
    const setBar = (fillId, ofId, v) => {
      const f = $(fillId), o = $(ofId);
      if (o) o.textContent = wTarget > 0 ? "/ " + fmtDurOpt(wTarget) : "";
      if (f) {
        f.style.width = (wTarget > 0 ? Math.min(100, Math.round((v / wTarget) * 100)) : 0) + "%";
        f.classList.toggle("met", wTarget > 0 && v >= wTarget);
      }
    };
    setBar("optWeekEstFill", "optWeekEstOf", Number(agg.estimateMs) || 0);
    setBar("optWeekTrkFill", "optWeekTrkOf", Number(agg.spentMs) || 0);
  }
  const fromD = new Date(agg.fromTs);
  const toD = new Date(agg.toTs);
  const n = agg.count || 0;
  $("optWeekSub").textContent =
    "Accumulated " + fromD.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " → " + toD.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + n + (n === 1 ? " weekday" : " weekdays");
  document.querySelectorAll("#optWeekToggle button").forEach((b) => {
    const on = b.dataset.to === to;
    b.className = on ? "on" : "";
    b.onclick = async () => {
      if (on) return;
      try {
        await send({ type: "CLICKUP_SET", patch: { clickupWeeklyTo: b.dataset.to } });
        $("cuWeeklyTo").value = b.dataset.to;
        await load();
      } catch (e) {}
    };
  });

  // Per-weekday task list under the weekly numbers (options-only; the popup
  // keeps just the total + tracked). Reuses the cached perDay breakdown.
  const listBox = $("optWeekList");
  const days = Array.isArray(w.perDay) ? w.perDay : [];
  const showDays = days.filter((d) => d.ts <= agg.toTs);
  if (listBox) {
    listBox.innerHTML = "";
    if (!showDays.length) {
      listBox.style.display = "none";
    } else {
      listBox.style.display = "block";
      for (let di = 0; di < showDays.length; di++) {
        const d = showDays[di];
        const head = document.createElement("div");
        head.className = "flt-tot";
        if (di > 0) head.style.marginTop = "14px"; // small gap to separate days
        const dateTxt = new Date(d.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
        head.innerHTML = "<b>" + weekdayNameOpt(new Date(d.ts).getDay()) + " · " + dateTxt + "</b>" +
          " - est <b>" + fmtDurOpt(d.estimateMs) + "</b> · tracked <b>" + fmtDurOpt(d.spentMs) + "</b>";
        listBox.appendChild(head);
        const tlist = document.createElement("div");
        tlist.className = "cu-tasklist";
        const rows = dedupeExtraRows(Array.isArray(d.tasks) ? d.tasks : []);
        const trackedRows = Array.isArray(d.trackedTasks) ? d.trackedTasks : [];
        if (!rows.length && !trackedRows.length) {
          const e = document.createElement("div");
          e.className = "empty";
          e.textContent = "(no tasks this day)";
          tlist.appendChild(e);
        } else {
          for (const t of sortByPriority(rows)) {
            const row = document.createElement("div");
            row.className = "cu-task";
            const nm = makeLinkOpt(t.url, t.name || "(untitled task)");
            appendDoneTickOpt(nm, t);
            appendNameCellOpt(row, nm, t);
            const spans = document.createElement("span");
            spans.className = "estpairs";
            const est = document.createElement("span");
            est.className = "est" + (t.estimateMs ? "" : " zero");
            est.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
            spans.appendChild(est);
            if (Number(t.spentMs) > 0) {
              const trk = document.createElement("span");
              trk.className = "trk";
              trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t);
              spans.appendChild(trk);
            }
            row.appendChild(spans);
            tlist.appendChild(row);
          }
          if (trackedRows.length) {
            const sec = document.createElement("div");
            sec.className = "flt-tot";
            sec.style.margin = "8px 0 2px";
            sec.style.fontSize = "11.5px";
            sec.innerHTML = "<b>Tracked · no dates</b>";
            tlist.appendChild(sec);
            for (const t of sortByPriority(trackedRows)) {
              const row = document.createElement("div");
              row.className = "cu-task";
              const nm = makeLinkOpt(t.url, t.name || "(untitled task)");
              appendDoneTickOpt(nm, t);
              appendNameCellOpt(row, nm, t);
              const spans = document.createElement("span");
              spans.className = "estpairs";
              const est = document.createElement("span");
              est.className = "est zero";
              est.textContent = "no est";
              spans.appendChild(est);
              if (Number(t.spentMs) > 0) {
                const trk = document.createElement("span");
                trk.className = "trk";
                trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t);
                spans.appendChild(trk);
              }
              row.appendChild(spans);
              tlist.appendChild(row);
            }
          }
        }
        listBox.appendChild(tlist);
        {
          const key = String(d.ts);
          const isToday = new Date(d.ts).setHours(0, 0, 0, 0) === new Date().setHours(0, 0, 0, 0);
          const open = optWeekDayOpen.has(key) ? optWeekDayOpen.get(key) : isToday;
          head.classList.add("wk-day");
          head.classList.toggle("open", open);
          head.title = "Show / hide this day's tasks";
          tlist.style.display = open ? "" : "none";
          head.onclick = () => {
            const nowOpen = tlist.style.display === "none";
            tlist.style.display = nowOpen ? "" : "none";
            head.classList.toggle("open", nowOpen);
            optWeekDayOpen.set(key, nowOpen);
          };
        }
      }
    }
  }
}

// Filter Tasks section in the options page. Same CLICKUP_FILTER call as the
// popup uses; here it's driven by the options form controls.
let optFltSeq = 0; // bumped per renderOptionsFilter() so a superseded load never overwrites a newer one
// Rows currently shown in Explore tasks, for its Export button.
let optFltExport = { rows: [], title: "tasks" };
async function renderOptionsFilter() {
  if (cuEstEditingOpt) { cuRenderPendingOpt = true; return; }
  const box = $("optFltResult");
  if (!box || !optClickup || !optClickup.configured) {
    if (box) box.style.display = "none";
    return;
  }
  const seq = ++optFltSeq;
  const type = $("optFltType").value;
  const now = new Date();
  let fromTs, toTs, label;
  if (type === "week") {
    // Follows the "A week runs" setting (Options > ClickUp setup > Tracking settings).
    const modes = { "sun-sat": [0, 7], "mon-sun": [1, 7], "mon-fri": [1, 5], "sun-thu": [0, 5] };
    const mode = (optClickup && optClickup.weekMode) || "sun-sat";
    const conf = modes[mode] || modes["sun-sat"];
    const startDay = conf[0];
    const days = conf[1];
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() - startDay + 7) % 7));
    if ($("optFltWeekMode").value === "day") {
      const dow = Number($("optFltWeekDay").value || "1");
      const day = new Date(start);
      day.setDate(start.getDate() + ((dow - startDay + 7) % 7));
      fromTs = dayStartOpt(day);
      toTs = dayEndOpt(day);
      label = weekdayNameOpt(dow) + " · " + day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } else {
      const end = new Date(start);
      end.setDate(start.getDate() + days - 1);
      fromTs = dayStartOpt(start);
      toTs = dayEndOpt(end);
      const f = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      label = "This week · " + f(start) + " – " + f(end);
    }
    const showSub = $("optFltWeekMode").value === "day";
    $("optFltWeekDayWrap").style.display = showSub ? "" : "none";
  } else if (type === "custom") {
    const s = $("optFltFrom").value;
    const d = $("optFltTo").value;
    const startD = s ? new Date(s + "T00:00:00") : new Date(now);
    const dueD = d ? new Date(d + "T00:00:00") : new Date(now);
    fromTs = dayStartOpt(startD);
    toTs = dayEndOpt(dueD);
    label = (s || "today") + " → " + (d || "today");
  } else {
    fromTs = dayStartOpt(now);
    toTs = dayEndOpt(now);
    label = "Today";
  }

  box.style.display = "block";
  box.innerHTML = '<div class="flt-tot">Loading ' + label + "…</div>";
  try {
    // Department scope: resolve the checked Department/User selects into the list
    // of ClickUp member ids to query. Empty => background queries own tasks only.
    let scopeTag = "";
    let assigneeIds = [];
    const deptId = $("optFltDept") ? $("optFltDept").value : "";
    const selUser = $("optFltDeptUser") ? $("optFltDeptUser").value : "";
    if (deptId === "__all__") {
      assigneeIds = (optDeptMembers || []).map((m) => m.id).filter(Boolean);
      scopeTag = " · All users";
    } else if (deptId) {
      const dept = optDeptList.find((d) => String(d.id) === String(deptId));
      if (selUser) {
        assigneeIds = [selUser];
        const u = dept && dept.users.find((x) => String(x.id) === String(selUser));
        scopeTag = " · " + dept.name + " ▸ " + (u ? u.name : "user");
      } else {
        assigneeIds = dept ? (dept.users || []).map((u) => u.id).filter(Boolean) : [];
        scopeTag = dept ? " · " + dept.name : "";
      }
    }
    // Live Start/Stop/Complete controls only when viewing your OWN tasks (no
    // department / other-member scope - those are read-only reports).
    const withControls = assigneeIds.length === 0;
    const res = await send({ type: "CLICKUP_FILTER", fromTs, toTs, assigneeIds: assigneeIds.length ? assigneeIds : [] });
    if (seq !== optFltSeq) return;
    // The background computes a fresh scope in the background and replies with
    // { building: true } until the result is cached - poll patiently instead of
    // surfacing "No response" (first loads can legitimately take a while).
    let fltRes = res;
    let waitTries = 0;
    if (fltRes && fltRes.ok && fltRes.building && !fltRes.data) {
      while (waitTries < 45) {
        await new Promise((r) => setTimeout(r, 2000));
        waitTries++;
        if (seq !== optFltSeq) return;
        fltRes = await send({ type: "CLICKUP_FILTER", fromTs, toTs, assigneeIds: assigneeIds.length ? assigneeIds : [] })
          .catch((e) => ({ ok: false, reason: "send-failed", error: (e && e.message) || String(e) }));
        if (seq !== optFltSeq) return;
        if (!fltRes || !fltRes.ok || fltRes.data) break;
      }
    }
    if (seq !== optFltSeq) return;
    if (!fltRes || !fltRes.ok || !fltRes.data) {
      const why = (fltRes && (fltRes.error || fltRes.reason)) || (fltRes && fltRes.building ? "is still computing - try again in a moment." : "");
      box.innerHTML = '<div class="flt-tot" style="color:var(--red)">Couldn\x27t load: ' + (why || "unknown") + "</div>";
      return;
    }
    label = label + scopeTag;
    const d = fltRes.data;
    const est = Number(d.estimateMs) || 0;
    const spent = Number(d.spentMs) || 0;
    const tasks = d.tasks || [];
    const deadline = d.deadlineTasks || [];
// Active filter flags - every checked one must be satisfied (AND gate).
    const flt = {
      estimate: !!($("optFltOnlyMissing") && $("optFltOnlyMissing").checked),
      start: !!($("optFltMissingStart") && $("optFltMissingStart").checked),
      due: !!($("optFltMissingDue") && $("optFltMissingDue").checked),
      incomplete: !!($("optFltIncomplete") && $("optFltIncomplete").checked),
      overdue: !!($("optFltOverdue") && $("optFltOverdue").checked),
      span: !!($("optFltSpan") && $("optFltSpan").checked),
    };
    const active = Object.keys(flt).filter((k) => flt[k]);
    // "Deadline crossed" = the due date is on a day BEFORE today (day-floor
    // compare), so a task due today never counts; only genuinely past-due tasks
    // do. Matches the ClickUp card's refine filter (cuRefinePredicate).
    const todayStart = new Date().setHours(0, 0, 0, 0);
    const isOverdue = (t) => {
      if (t.done) return false;
      const d = Number(t.dueDateMs) || 0;
      if (!d) return false;
      return new Date(d).setHours(0, 0, 0, 0) < todayStart;
    };
    const passTask = (t) =>
      active.every((k) => {
        switch (k) {
          case "estimate": return !Number(t.estimateMs);
          case "start": return !Number(t.startDateMs);
          case "due": return !Number(t.dueDateMs);
          case "incomplete": return !t.done;
          case "overdue": return isOverdue(t);
          case "span": {
            const a = Number(t.startDateMs) || 0;
            const b = Number(t.dueDateMs) || 0;
            if (!a || !b) return false;
            return new Date(a).setHours(0, 0, 0, 0) !== new Date(b).setHours(0, 0, 0, 0);
          }
        }
        return true;
      });
    let shownTasks = tasks.filter(passTask);
    let shownTracked = (Array.isArray(d.trackedTasks) ? d.trackedTasks : []).filter(passTask);
    let shownDeadline = deadline.filter((dt) => {
      if (dt.error) return false;
      const t = { estimateMs: dt.dayEstimateMs, startDateMs: dt.startDateMs, dueDateMs: dt.dueDateMs, done: dt.done };
      return passTask(t);
    });
    // Client dropdown: options come from the tasks this query returned, and the
    // chosen client narrows every section (tasks, configured tasks, tracked).
    let estShown = null, spentShown = null;
    const clientSel = $("optFltClient");
    let clientPick = "";
    if (clientSel) {
      clientPick = clientSel.value;
      const names = [...new Set([].concat(shownTasks, shownDeadline, shownTracked)
        .map((t) => String((t && t.client) || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      if (clientPick && !names.includes(clientPick)) clientPick = "";
      clientSel.innerHTML = '<option value="">All clients</option>' +
        names.map((n) => '<option value="' + escapeHtml(n) + '"' + (n === clientPick ? " selected" : "") + ">" + escapeHtml(n) + "</option>").join("");
      clientSel.value = clientPick;
      if (clientPick) {
        const keep = (t) => String((t && t.client) || "").trim() === clientPick;
        shownTasks = shownTasks.filter(keep);
        shownDeadline = shownDeadline.filter(keep);
        shownTracked = shownTracked.filter(keep);
        // Headline totals follow the chosen client too.
        estShown = shownTasks.reduce((x, t) => x + (Number(t.estimateMs) || 0), 0)
          + shownDeadline.reduce((x, t) => x + (Number(t.dayEstimateMs) || 0), 0);
        spentShown = [].concat(shownTasks, shownDeadline, shownTracked).reduce((x, t) => x + (Number(t.spentMs) || 0), 0);
      }
    }
    cuExportRowsOpt(shownTasks, shownDeadline, shownTracked, label + (clientPick ? " - " + clientPick : ""));
    optFltExport = { rows: cuExportDataOpt.rows, title: cuExportDataOpt.title };
    const total = shownTasks.length + shownDeadline.length + shownTracked.length;
    const filterTags = active.map((k) => ({
      estimate: "missing estimates",
      start: "missing start date",
      due: "missing due date",
      incomplete: "incomplete",
      overdue: "deadline crossed",
      span: "start ≠ due",
    }[k] || k)).join(" · ");
    box.innerHTML =
      '<div class="flt-tot"><b>' + label + "</b> · est <b>" + fmtDurOpt(estShown == null ? est : estShown) +
      "</b> · tracked <b>" + fmtDurOpt(spentShown == null ? spent : spentShown) + "</b>" +
      " · " + total + " task" + (total === 1 ? "" : "s") +
      (clientPick ? " <span class=\"hint\">· client: " + escapeHtml(clientPick) + "</span>" : "") +
      (active.length ? " <span class=\"hint\">(filter: " + filterTags + ")</span>" : "") + "</div>";
    const list = document.createElement("div");
    list.className = "cu-tasklist";
    for (const t of sortByPriority(shownTasks)) {
      const row = document.createElement("div");
      row.className = "cu-task";
      const nm = makeLinkOpt(t.url, t.name || "(untitled task)");
      appendDoneTickOpt(nm, t);
      appendNameCellOpt(row, nm, t);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const estSpan = document.createElement("span");
      estSpan.className = "est" + (t.estimateMs ? "" : " zero");
      estSpan.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
      estSpan.title = "Click to edit estimate";
      estSpan.style.cursor = "pointer";
      estSpan.addEventListener("click", (e) => { e.stopPropagation(); startEditEstimateOpt(estSpan, t); });
      spans.appendChild(estSpan);
      if (Number(t.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t);
        spans.appendChild(trk);
      }
      row.appendChild(spans);
      if (withControls) appendTaskControlsOpt(row, t);
      list.appendChild(row);
    }
    for (const dt of sortByPriority(shownDeadline)) {
      if (dt.error) continue;
      const row = document.createElement("div");
      row.className = "cu-task";
      const nm = makeLinkOpt(dt.url, dt.name || "(configured task)");
      appendDoneTickOpt(nm, dt);
      appendNameCellOpt(row, nm, dt);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const estSpan = document.createElement("span");
      estSpan.className = "est" + (dt.dayEstimateMs ? "" : " zero");
      estSpan.textContent = dt.accumulated ? "est " + fmtDurOpt(dt.dayEstimateMs) : fmtDurOpt(dt.dayEstimateMs) + "/day";
      spans.appendChild(estSpan);
      if (Number(dt.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDurOpt(dt.spentMs); markTrk(trk, dt);
        spans.appendChild(trk);
      }
      row.appendChild(spans);
      if (withControls) appendTaskControlsOpt(row, dt);
      list.appendChild(row);
    }
    if (shownTracked.length) {
      const sec = document.createElement("div");
      sec.className = "flt-tot";
      sec.style.margin = "8px 0 2px";
      sec.style.fontSize = "11.5px";
      sec.innerHTML = type === "today" ? "<b>Tracked · not due today</b>" : "<b>Tracked · no dates</b>";
      list.appendChild(sec);
      for (const t of sortByPriority(shownTracked)) {
        const row = document.createElement("div");
        row.className = "cu-task";
        const nm = makeLinkOpt(t.url, t.name || "(untitled task)");
        appendDoneTickOpt(nm, t);
        appendNameCellOpt(row, nm, t);
        const spans = document.createElement("span");
        spans.className = "estpairs";
        const estSpan = document.createElement("span");
        estSpan.className = "est zero";
        estSpan.textContent = "no est";
        spans.appendChild(estSpan);
        if (Number(t.spentMs) > 0) {
          const trk = document.createElement("span");
          trk.className = "trk";
          trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t);
          spans.appendChild(trk);
        }
        row.appendChild(spans);
        if (withControls) appendTaskControlsOpt(row, t);
        list.appendChild(row);
      }
    }
    box.appendChild(list);
  } catch (e) {
    box.innerHTML = '<div class="flt-tot" style="color:var(--red)">Couldn\x27t load: ' + (e && e.message ? e.message : e) + "</div>";
  }
}

// Show/hide the week-mode / day / custom-date controls based on the filter type.
function initOptionsFilterControls() {
  const type = $("optFltType");
  const weekMode = $("optFltWeekMode");
  const show = () => {
    const t = type.value;
    $("optFltWeekModeWrap").style.display = t === "week" ? "" : "none";
    $("optFltWeekDayWrap").style.display = t === "week" && weekMode.value === "day" ? "" : "none";
    $("optFltFromWrap").style.display = t === "custom" ? "" : "none";
    $("optFltToWrap").style.display = t === "custom" ? "" : "none";
  };
  type.onchange = () => { show(); renderOptionsFilter(); };
  weekMode.onchange = () => { show(); renderOptionsFilter(); };
  $("optFltWeekDay").onchange = renderOptionsFilter;
  $("optFltFrom").onchange = renderOptionsFilter;
  $("optFltTo").onchange = renderOptionsFilter;
  ["optFltOnlyMissing", "optFltMissingStart", "optFltMissingDue", "optFltIncomplete", "optFltOverdue", "optFltSpan"].forEach((id) => {
    const el = $(id);
    if (el) el.onchange = renderOptionsFilter;
  });
  const deptSel = $("optFltDept");
  if (deptSel) deptSel.onchange = () => { syncDeptUserSelect(); renderOptionsFilter(); };
  const deptUserSel = $("optFltDeptUser");
  if (deptUserSel) deptUserSel.onchange = renderOptionsFilter;
  show();

  // The older Weekly Totals select should stay in sync with the toggle buttons.
  const sel = $("cuWeeklyTo");
  if (sel) {
    sel.onchange = async () => {
      try {
        await send({ type: "CLICKUP_SET", patch: { clickupWeeklyTo: sel.value } });
        await load();
      } catch (e) {}
    };
  }
}

// ---------------------------------------------------------------------------
// Department Creator - build departments of ClickUp users, then filter tasks by
// department (full) or by a single user from the "Filter tasks" card above.
// ---------------------------------------------------------------------------
function deptMsg(txt, ok) {
  const el = $("deptMsg");
  if (!el) return;
  el.style.display = txt ? "inline" : "none";
  el.textContent = txt || "";
  el.style.color = ok === false ? "var(--red)" : "var(--green)";
}

async function loadDeptData(force, triesLeft) {
  if (!$("deptSelect") || !optClickup || !optClickup.configured) return null;
  if (triesLeft == null) triesLeft = 8;
  const depCard = $("deptCard");
  if (depCard) depCard.style.display = "";
  const res = await send({ type: "CLICKUP_DEPT_DATA", force: !!force });
  // The background replies instantly with the CACHED roster and starts (or has
  // started) a background build flagged with `building`. Wait for it to land
  // before rendering, so "Refresh user list" shows results the first time.
  if (res && res.ok && !(res.members || []).length && res.building && triesLeft > 0) {
    await new Promise((r) => setTimeout(r, 2500));
    return loadDeptData(false, triesLeft - 1);
  }
  if (res && res.ok) {
    optDeptMembers = res.members || [];
    optDeptList = res.departments || [];
    if (!optDeptMembers.length && res.note) console.warn("Department Creator:", res.note);
  } else {
    optDeptMembers = [];
    optDeptList = [];
  }
  renderDeptSelects();
  if (!force) {
    loadDeptIntoEditor(optDeptEditing && optDeptList.some((d) => d.id === optDeptEditing) ? optDeptEditing : null);
    // Keep the editor in sync with the freshly-loaded roster names.
  } else {
    loadDeptIntoEditor(optDeptEditing);
  }
  renderOptionsFilter();
  return res || null;
}

function renderDeptSelects() {
  const sel = $("deptSelect");
  if (sel) {
    const prev = sel.value || "";
    sel.innerHTML = '<option value="">＋ Create a new department…</option>';
    for (const d of optDeptList) {
      const o = document.createElement("option");
      o.value = d.id;
      const n = (d.users || []).length;
      o.textContent = d.name + " (" + n + " user" + (n === 1 ? "" : "s") + ")";
      sel.appendChild(o);
    }
    if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else sel.value = "";
  }
  const fsel = $("optFltDept");
  if (fsel) {
    const prev = fsel.value;
    fsel.innerHTML = '<option value="">My tasks (default)</option><option value="__all__">All users (workspace)</option>';
    for (const d of optDeptList) {
      const o = document.createElement("option");
      o.value = d.id;
      o.textContent = d.name;
      fsel.appendChild(o);
    }
    if (prev && [...fsel.options].some((o) => o.value === prev)) fsel.value = prev;
  }
  syncDeptUserSelect();
}

// Toggle the "User" picker for the selected department in the Filter card.
function syncDeptUserSelect() {
  const fsel = $("optFltDept");
  const usel = $("optFltDeptUser");
  const uWrap = $("optFltDeptUserWrap");
  if (!fsel || !usel || !uWrap) return;
  const deptId = fsel.value;
  const dept = optDeptList.find((d) => String(d.id) === String(deptId));
  const users = dept && Array.isArray(dept.users) ? dept.users : [];
  if (!dept || !users.length) {
    uWrap.style.display = "none";
    usel.value = "";
    return;
  }
  uWrap.style.display = "";
  const prev = usel.value;
  usel.innerHTML = '<option value="">Full department</option>';
  for (const u of users) {
    const o = document.createElement("option");
    o.value = u.id;
    o.textContent = u.name;
    usel.appendChild(o);
  }
  if (prev && [...usel.options].some((o) => o.value === prev)) usel.value = prev;
  else usel.value = "";
}

function loadDeptIntoEditor(id) {
  const dept = id ? optDeptList.find((d) => String(d.id) === String(id)) : null;
  optDeptEditing = dept ? dept.id : null;
  optDeptDraft = dept ? (dept.users || []).map((u) => ({ id: String(u.id), name: u.name })) : [];
  $("deptName").value = dept ? dept.name : "";
  const del = $("deptDelete");
  if (del) del.style.display = dept ? "" : "none";
  const search = $("deptUserSearch");
  if (search) search.value = "";
  renderDeptChips();
  hideDeptSuggest();
}

function renderDeptChips() {
  const box = $("deptUsersChips");
  if (!box) return;
  box.innerHTML = "";
  for (const u of optDeptDraft) {
    const chip = document.createElement("span");
    chip.className = "chip";
    const nm = document.createElement("span");
    nm.textContent = u.name;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.title = "Remove " + u.name;
    rm.textContent = "×";
    rm.onclick = () => { optDeptDraft = optDeptDraft.filter((x) => x.id !== u.id); renderDeptChips(); };
    chip.appendChild(nm);
    chip.appendChild(rm);
    box.appendChild(chip);
  }
  const n = optDeptDraft.length;
  $("deptCount").textContent = n
    ? n + " user" + (n === 1 ? "" : "s") + " in this department."
    : "No users yet - search above and pick from the suggestions.";
}

// ---- autocomplete search box ----
let deptSuggestions = []; // current filtered member list for the suggestions box
// Prefer a real name; fall back to the email when the API only gave {id, role}.
function rosterLabel(m) {
  const n = String(m && m.name || "").trim();
  if (n && !/^User \d+$/.test(n)) return n;
  return String(m && m.email || "").trim() || n || "User";
}
function hideDeptSuggest() {
  const s = $("deptUserSuggest");
  if (s) s.style.display = "none";
}
function populateDeptSuggest() {
  const s = $("deptUserSuggest");
  if (!s) return;
  const q = $("deptUserSearch").value.trim().toLowerCase();
  const taken = new Set(optDeptDraft.map((u) => u.id));
  const matches = optDeptMembers.filter((m) => {
    if (taken.has(m.id)) return false;
    if (!q) return true;
    const hay = (String(m.name || "") + " " + String(m.email || "")).toLowerCase();
    return hay.includes(q);
  });
  deptSuggestions = matches.slice(0, 12);
  if (!deptSuggestions.length) {
    s.innerHTML = '<div class="au-empty">No matching user' + (q ? ' for "' + q + '"' : "") + "</div>";
    s.style.display = "block";
    return;
  }
  s.innerHTML = "";
  for (const m of deptSuggestions) {
    const item = document.createElement("div");
    item.className = "au-item";
    item.textContent = rosterLabel(m);
    item.onclick = () => addDeptUser(m);
    s.appendChild(item);
  }
  s.style.display = "block";
}
function addDeptUser(m) {
  if (!m || !m.id || optDeptDraft.some((u) => u.id === String(m.id))) return;
  optDeptDraft.push({ id: String(m.id), name: rosterLabel(m) });
  $("deptUserSearch").value = "";
  renderDeptChips();
  hideDeptSuggest();
}

async function saveDept() {
  const name = $("deptName").value.trim();
  if (!name) { deptMsg("Give the department a name first.", false); return; }
  if (!optDeptDraft.length) { deptMsg("Add at least one user to this department.", false); return; }
  const existing = optDeptEditing ? optDeptList.find((d) => d.id === optDeptEditing) : null;
  const updated = optDeptList
    .filter((d) => !existing || d.id !== existing.id)
    .concat([{
      id: existing ? existing.id : ("dept_" + Date.now().toString(36)),
      name,
      users: optDeptDraft.map((u) => ({ id: u.id, name: u.name })),
    }]);
  const res = await send({ type: "CLICKUP_DEPARTMENTS_SAVE", departments: updated });
  if (res && res.ok) {
    optDeptList = res.departments || [];
    renderDeptSelects();
    if (existing) {
      loadDeptIntoEditor(existing.id);
    } else {
      const saved = optDeptList.find((d) => d.name === name);
      loadDeptIntoEditor(saved ? saved.id : null);
    }
    deptMsg("Saved ✓", true);
    setTimeout(() => deptMsg("", true), 2000);
    renderOptionsFilter();
  } else {
    deptMsg((res && res.reason) || "Couldn't save.", false);
  }
}

async function deleteDept() {
  if (!optDeptEditing) return;
  const remaining = optDeptList.filter((d) => d.id !== optDeptEditing);
  const res = await send({ type: "CLICKUP_DEPARTMENTS_SAVE", departments: remaining });
  if (res && res.ok) {
    optDeptList = res.departments || [];
    optDeptEditing = null;
    optDeptDraft = [];
    renderDeptSelects();
    loadDeptIntoEditor(null);
    deptMsg("Deleted.", true);
    setTimeout(() => deptMsg("", true), 2000);
    renderOptionsFilter();
  } else {
    deptMsg((res && res.reason) || "Couldn't delete.", false);
  }
}

function initDeptCreator() {
  const sel = $("deptSelect");
  if (!sel) return;
  sel.onchange = () => { loadDeptIntoEditor(sel.value || null); deptMsg("", true); };
  const search = $("deptUserSearch");
  search.addEventListener("input", populateDeptSuggest);
  search.addEventListener("focus", populateDeptSuggest);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (deptSuggestions.length) addDeptUser(deptSuggestions[0]);
    } else if (e.key === "Escape") {
      hideDeptSuggest();
    }
  });
  document.addEventListener("click", (e) => {
    if (e.target.closest && !e.target.closest(".au-wrap")) hideDeptSuggest();
  });
  $("deptSave").onclick = saveDept;
  $("deptDelete").onclick = deleteDept;
  $("deptRefreshUsers").onclick = async () => {
    const res = await loadDeptData(true).catch(() => null);
    const n = res && res.ok && Array.isArray(res.members) ? res.members.length : 0;
    if (res && res.ok && n) {
      deptMsg("Member list refreshed: " + n + " user" + (n === 1 ? "" : "s") + ".", true);
    } else if (res && res.ok && res.building) {
      deptMsg("Still building the member list - wait a few seconds and click Refresh again.", false);
    } else {
      deptMsg((res && res.note) || "Member list empty - see the extension console (chrome://extensions → service worker).", false);
    }
    setTimeout(() => deptMsg("", true), 5000);
  };
  // Seed with "new department" empty editor.
  loadDeptIntoEditor(null);
}

// Render the live total / target / progress bar / per-task list. `st` is the
// background's ClickUp state object (or an { error } stub on a failed refresh).
// ---- ClickUp quick-filter (shared model; mirrors popup.js + the badge in
// background.js) ------------------------------------------------------------
// Date scopes are nested (today ⊂ this-week ⊂ till-Friday), so the headline
// estimate/tracked bars follow the WIDEST checked scope. Nothing checked keeps
// the previous default: the extended "active today" view (state.todayFilter).
// The refine boxes (missingEst / hasTracked / deadlineCrossed) and the Status /
// Priority sections narrow the visible task LIST only; they never change the
// headline totals or the toolbar badge.
// "Due today" is ticked by default (a saved choice always wins).
let cuFilter = { dueToday: true, dueTomorrow: false, dueWeek: false, dueNextWeek: false, dueCustom: false, missingDue: false, customFrom: "", customTo: "", missingEst: false, hasTracked: false, deadlineCrossed: false, waitingOthers: false, statuses: [], priorities: [], clients: [] };
const CU_FILTER_KEYS = ["dueToday", "dueTomorrow", "dueWeek", "dueNextWeek", "dueCustom", "missingEst", "missingDue", "hasTracked", "deadlineCrossed", "waitingOthers"];
const CU_PRIORITY_ORDER = ["urgent", "high", "normal", "low", "none"];
const CU_SCOPE_LABEL = { today: "due today", tomorrow: "due tomorrow", week: "this week", nextweek: "due next week", extended: "active today" };

function cuTodayEndMs() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
function cuActiveFilterCount(f) {
  return CU_FILTER_KEYS.reduce((n, k) => n + (f[k] ? 1 : 0), 0)
    + (Array.isArray(f.statuses) ? f.statuses.length : 0)
    + (Array.isArray(f.priorities) ? f.priorities.length : 0)
    + (Array.isArray(f.clients) ? f.clients.length : 0);
}

// Collapse the weekly per-day breakdown into one deduped task list for a range.
// Per-day rows are already daily shares, so summing them per task id yields a
// total that matches the weekly headline. (These rows carry no due/start date.)
function flattenWeekTasks(perDay, maxTs) {
  const byId = new Map();
  const tracked = new Map();
  for (const day of (Array.isArray(perDay) ? perDay : [])) {
    if (maxTs != null && Number(day.ts) > maxTs) continue;
    for (const t of (Array.isArray(day.tasks) ? day.tasks : [])) {
      if (!t || !t.id) continue;
      const p = byId.get(t.id);
      if (p) { p.estimateMs += Number(t.estimateMs) || 0; p.spentMs += Number(t.spentMs) || 0; p.done = p.done && !!t.done; }
      else byId.set(t.id, { id: t.id, name: t.name, url: t.url, estimateMs: Number(t.estimateMs) || 0, spentMs: Number(t.spentMs) || 0, done: !!t.done, client: t.client || "", type: t.type, status: t.status || "", priority: t.priority || "" });
    }
    for (const t of (Array.isArray(day.trackedTasks) ? day.trackedTasks : [])) {
      if (!t || !t.id) continue;
      const p = tracked.get(t.id);
      if (p) p.spentMs += Number(t.spentMs) || 0;
      else tracked.set(t.id, { id: t.id, name: t.name, url: t.url, estimateMs: 0, spentMs: Number(t.spentMs) || 0, done: !!t.done, client: t.client || "", type: "tracked", status: t.status || "", priority: t.priority || "" });
    }
  }
  return { tasks: Array.from(byId.values()), trackedTasks: Array.from(tracked.values()) };
}

// Resolve the active date scope -> { estimateMs, spentMs, tasks, deadlineTasks,
// trackedTasks, scope }. Widest checked wins; graceful fallback to the extended
// view when a chosen weekly slice isn't in state yet.
function cuWeekRangeLabel(base, b) {
  const from = Number(b && b.fromTs) || 0;
  const to = Number(b && b.toTs) || 0;
  if (!from || !to) return base;
  const f = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return base + " · " + f(from) + " – " + f(to);
}
function resolveCuFilterView(st, f) {
  st = st || {};
  // Deadline crossed looks at ALL dates, so it takes over the date scope.
  if (f.deadlineCrossed) return cuOverdueView();
  if (f.dueCustom) { const cv = cuCustomView(f); if (cv) return cv; }
  const wk = st.weekly || null;
  if (f.dueNextWeek && st.nextWeek) {
    const nw = st.nextWeek;
    return { estimateMs: nw.estimateMs, spentMs: nw.spentMs, tasks: Array.isArray(nw.tasks) ? nw.tasks : [], deadlineTasks: Array.isArray(nw.deadlineTasks) ? nw.deadlineTasks : [], trackedTasks: Array.isArray(nw.trackedTasks) ? nw.trackedTasks : [], scope: "nextweek", label: cuWeekRangeLabel("due next week", nw) };
  }
  if (f.dueWeek && st.thisWeek) {
    const tw = st.thisWeek;
    return { estimateMs: tw.estimateMs, spentMs: tw.spentMs, tasks: Array.isArray(tw.tasks) ? tw.tasks : [], deadlineTasks: Array.isArray(tw.deadlineTasks) ? tw.deadlineTasks : [], trackedTasks: Array.isArray(tw.trackedTasks) ? tw.trackedTasks : [], scope: "week", label: cuWeekRangeLabel("this week", tw) };
  }
  if (f.dueTomorrow) {
    // Tomorrow's tasks live in the WEEK bundles - today's bundle only ever holds
    // tasks due today, so filtering that one always came back empty. Pull from
    // this week AND next week (tomorrow crosses the week boundary on Saturday),
    // then keep the rows whose due date falls on tomorrow.
    const tomorrowStart = new Date(); tomorrowStart.setDate(tomorrowStart.getDate() + 1); tomorrowStart.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart); tomorrowEnd.setHours(23, 59, 59, 999);
    const tStart = tomorrowStart.getTime();
    const tEnd = tomorrowEnd.getTime();
    const inRange = (t) => { const d = Number(t && t.dueDateMs) || 0; return d >= tStart && d <= tEnd; };
    const pick = (key) => {
      const out = [];
      const seen = new Set();
      for (const b of [st.thisWeek, st.nextWeek, st.todayFilter, st]) {
        if (!b || !Array.isArray(b[key])) continue;
        for (const t of b[key]) {
          if (!inRange(t)) continue;
          const id = String((t && (t.id != null ? t.id : t.taskId)) || "");
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(t);
        }
      }
      return out;
    };
    const tasks = pick("tasks");
    const deadlineTasks = pick("deadlineTasks");
    const trackedTasks = pick("trackedTasks");
    const sum = (arr, key) => arr.reduce((n, t) => n + (Number(t && t[key]) || 0), 0);
    return {
      estimateMs: sum(tasks, "estimateMs") + sum(deadlineTasks, "dayEstimateMs"),
      spentMs: sum(tasks, "spentMs") + sum(deadlineTasks, "spentMs") + sum(trackedTasks, "spentMs"),
      tasks, deadlineTasks, trackedTasks, scope: "tomorrow"
    };
  }
  if (f.dueToday) {
    return { estimateMs: st.estimateMs, spentMs: st.spentMs, tasks: Array.isArray(st.tasks) ? st.tasks : [], deadlineTasks: Array.isArray(st.deadlineTasks) ? st.deadlineTasks : [], trackedTasks: Array.isArray(st.trackedTasks) ? st.trackedTasks : [], scope: "today" };
  }
  const tf = st.todayFilter || st;
  return { estimateMs: tf.estimateMs, spentMs: tf.spentMs, tasks: Array.isArray(tf.tasks) ? tf.tasks : [], deadlineTasks: Array.isArray(tf.deadlineTasks) ? tf.deadlineTasks : [], trackedTasks: Array.isArray(tf.trackedTasks) ? tf.trackedTasks : [], scope: "extended" };
}

// List-only refine predicate. "Deadline crossed" = not done AND due date on a
// day BEFORE today (day-floor compare, matching the Filter-tasks card's
// isOverdue) so tasks due today never count. Status/Priority are OR within a
// group, AND across groups. `t.priority` is a lower-case name (""→"none").
function cuRefinePredicate(f) {
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const statuses = Array.isArray(f.statuses) ? f.statuses : [];
  const priorities = Array.isArray(f.priorities) ? f.priorities : [];
  return (t) => {
    if (f.missingEst && Number(t.estimateMs)) return false;
    if (f.missingDue && Number(t.dueDateMs)) return false;
    if (f.waitingOthers && !cuWaitFor(t)) return false;
    if (f.hasTracked && !(Number(t.spentMs) > 0)) return false;
    if (f.deadlineCrossed) {
      if (t.done) return false;
      const d = Number(t.dueDateMs) || 0;
      if (!d || new Date(d).setHours(0, 0, 0, 0) >= todayStart) return false;
    }
    if (statuses.length && !statuses.includes(String(t.status || "").toLowerCase())) return false;
    if (priorities.length && !priorities.includes(String(t.priority || "").toLowerCase() || "none")) return false;
    return true;
  };
}

// Union the Status + Priority values present across every scope's row lists, so
// the dropdown offers exactly what the fetched tasks actually carry (custom
// statuses included). Status names are lower-cased; a blank priority → "none".


// ---------- "Deadline crossed" data ----------
// Overdue tasks are never inside the Due selection (a task due today can't be
// overdue), so this filter has its own source: CLICKUP_OVERDUE = every task
// assigned to you, due before today, not complete - across all dates.
let cuOverdueCache = { status: "", data: null, at: 0 };
function cuOverdueView() {
  const c = cuOverdueCache;
  if (!c.status || (c.status !== "loading" && Date.now() - c.at > 5 * 60000)) cuFetchOverdue();
  if (c.data) return { ...c.data, scope: "overdue", label: "overdue · all dates" };
  return { estimateMs: 0, spentMs: 0, tasks: [], deadlineTasks: [], trackedTasks: [], scope: "overdue",
    label: "overdue" + (c.status === "error" ? " (couldn't load)" : " (loading…)"), loading: c.status !== "error" };
}
async function cuFetchOverdue() {
  if (cuOverdueCache.status === "loading") return;
  cuOverdueCache = { ...cuOverdueCache, status: "loading" };
  let res = null;
  try { res = await send({ type: "CLICKUP_OVERDUE" }, 30000); } catch (e) { res = null; }
  cuOverdueCache = res && res.ok && res.data
    ? { status: "ready", data: res.data, at: Date.now() }
    : { status: "error", data: cuOverdueCache.data, at: Date.now() };
  optRepaintCuPreview(); optRenderCuFilterMenu();
}
// ---------- Custom due date / date range ----------
// "Custom date / range" in the Due group: one day (From only) or From..To. The
// tasks come from the background's cached CLICKUP_FILTER range fetch (same as
// the options Explore card) and are kept only when their DUE date is inside.
function cuParseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
}
function cuCustomRange(f) {
  let a = cuParseDay(f.customFrom);
  if (!a) return null;
  let b = cuParseDay(f.customTo) || a;
  if (b < a) { const t = a; a = b; b = t; }
  const end = new Date(b); end.setHours(23, 59, 59, 999);
  return { fromTs: a, toTs: end.getTime() };
}
function cuCustomLabel(r) {
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const same = new Date(r.fromTs).toDateString() === new Date(r.toTs).toDateString();
  return "due " + (same ? fmt(r.fromTs) : fmt(r.fromTs) + " – " + fmt(r.toTs));
}
let cuCustomCache = { key: "", status: "", data: null, at: 0 }; // status: loading | ready | error
function cuOverdueInvalidate() { if (cuOverdueCache.status !== "loading") cuOverdueCache.at = 0; }
function cuCustomOnReady() { optRepaintCuPreview(); optRenderCuFilterMenu(); }
function cuCustomView(f) {
  const r = cuCustomRange(f);
  if (!r) return null;
  const key = r.fromTs + "-" + r.toTs;
  const label = cuCustomLabel(r);
  const c = cuCustomCache;
  const stale = c.key === key && c.status === "ready" && Date.now() - c.at > 5 * 60000;
  if (c.key !== key || stale) cuFetchCustom(r, key); // refresh in the background
  if (c.key === key && c.data) return { ...c.data, scope: "custom", label };
  const st = cuCustomCache.status;
  return { estimateMs: 0, spentMs: 0, tasks: [], deadlineTasks: [], trackedTasks: [], scope: "custom",
    label: label + (st === "error" ? " (couldn't load)" : " (loading…)"), loading: st !== "error" };
}
async function cuFetchCustom(r, key) {
  const keep = cuCustomCache.key === key ? cuCustomCache.data : null;
  cuCustomCache = { key, status: "loading", data: keep, at: cuCustomCache.at };
  let res = null;
  for (let i = 0; i < 45; i++) {
    try { res = await send({ type: "CLICKUP_FILTER", fromTs: r.fromTs, toTs: r.toTs, assigneeIds: [] }, 20000); } catch (e) { res = null; }
    if (cuCustomCache.key !== key) return; // a newer range was picked
    if (!res || !res.ok || res.data) break;
    await new Promise((z) => setTimeout(z, 2000));
  }
  if (cuCustomCache.key !== key) return;
  if (!res || !res.ok || !res.data) {
    cuCustomCache = { key, status: "error", data: keep, at: Date.now() };
    cuCustomOnReady();
    return;
  }
  const d = res.data;
  // Strictly due-bounded: a task counts only when its DUE date is in the range.
  const inRange = (t) => { const x = Number(t && t.dueDateMs) || 0; return x >= r.fromTs && x <= r.toTs; };
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).filter(inRange);
  const deadlineTasks = (Array.isArray(d.deadlineTasks) ? d.deadlineTasks : []).filter(inRange);
  const sum = (a, k) => a.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
  cuCustomCache = { key, status: "ready", at: Date.now(), data: {
    estimateMs: sum(tasks, "estimateMs") + sum(deadlineTasks, "dayEstimateMs"),
    spentMs: sum(tasks, "spentMs") + sum(deadlineTasks, "spentMs"),
    tasks, deadlineTasks, trackedTasks: [],
  } };
  cuCustomOnReady();
}
function cuAvailableFacets(st) {
  st = st || {};
  const statuses = new Set();
  const priorities = new Set();
  const clients = new Set();
  const scan = (arr) => {
    for (const t of (Array.isArray(arr) ? arr : [])) {
      if (!t) continue;
      const s = String(t.status || "").toLowerCase().trim();
      if (s) statuses.add(s);
      if ("priority" in t) priorities.add(String(t.priority || "").toLowerCase().trim() || "none");
      const c = String(t.client || "").trim();
      if (c) clients.add(c);
    }
  };
  scan(st.tasks); scan(st.deadlineTasks); scan(st.trackedTasks);
  const tf = st.todayFilter || {};
  scan(tf.tasks); scan(tf.deadlineTasks); scan(tf.trackedTasks);
  const wk = st.weekly || {};
  for (const d of (Array.isArray(wk.perDay) ? wk.perDay : [])) { scan(d.tasks); scan(d.trackedTasks); }
  const nw = st.nextWeek || {};
  scan(nw.tasks); scan(nw.deadlineTasks); scan(nw.trackedTasks);
  const tw = st.thisWeek || {};
  scan(tw.tasks); scan(tw.deadlineTasks); scan(tw.trackedTasks);
  if (cuCustomCache.data) { scan(cuCustomCache.data.tasks); scan(cuCustomCache.data.deadlineTasks); }
  if (cuOverdueCache.data) scan(cuOverdueCache.data.tasks);
  return { statuses: Array.from(statuses).sort(), priorities: CU_PRIORITY_ORDER.filter((p) => priorities.has(p)), clients: Array.from(clients).sort((a, b) => a.localeCompare(b)) };
}

// Visible "working" indicator for the today card while the first ClickUp refresh
// is still in flight (right after connecting a token, or a cold service worker).
// Without it the card sits blank after "Connected ✓" - the connection-settings
// section (with that message) auto-collapses - leaving the user unsure whether
// it's loading or stuck. Shown from renderClickupSettings (configured but no
// state yet) and explicitly during the first-connect refresh.
function renderCuPreviewLoading(msg) {
  const box = $("cuPreview");
  if (!box) return;
  box.style.display = "block";
  box.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "cu-loading";
  const sp = document.createElement("span");
  sp.className = "cu-spinner";
  const txt = document.createElement("span");
  txt.textContent = msg || "Loading your ClickUp tracking…";
  wrap.appendChild(sp);
  wrap.appendChild(txt);
  box.appendChild(wrap);
}


// ---------- "Tracking now" strip ----------
// Shown above the task list ONLY while a ClickUp timer is running: task name
// (opens in ClickUp), live elapsed time and a Stop button. Hidden otherwise.
let cuNowTimer = null;
function renderNowTracking() {
  const el = document.getElementById("cuNow");
  if (!el) return;
  const st = (optClickup && optClickup.state) || null;
  const run = st && st.running && st.running.taskId ? st.running : null;
  if (!run) { clearInterval(cuNowTimer); el.hidden = true; el.innerHTML = ""; el.dataset.key = ""; return; }
  const key = String(run.taskId) + ":" + String(run.startMs || "");
  const old = el.querySelector(".cu-now-note");
  if (el.dataset.key === key && old) {
    // Same timer: keep the note box as is (never wipe what's being typed).
    if (document.activeElement !== old && !old.dataset.dirty) old.value = run.description || "";
    return;
  }
  clearInterval(cuNowTimer);
  el.dataset.key = key;
  el.hidden = false;
  el.innerHTML = "";
  const top = document.createElement("div");
  top.className = "cu-now-top";
  const dot = document.createElement("span");
  dot.className = "cu-now-dot";
  const lab = document.createElement("span");
  lab.className = "cu-now-lab";
  lab.textContent = "Tracking now";
  const nm = document.createElement("a");
  nm.className = "cu-now-name";
  nm.textContent = run.taskName || "(task)";
  nm.title = run.taskName || "";
  nm.href = "https://app.clickup.com/t/" + encodeURIComponent(run.taskId);
  nm.target = "_blank";
  nm.rel = "noopener";
  const time = document.createElement("span");
  time.className = "cu-now-time";
  const tick = () => { time.textContent = run.startMs ? fmtDurOpt(Math.max(0, Date.now() - run.startMs)) : ""; };
  tick();
  cuNowTimer = setInterval(tick, 15000);

  // Note = this time entry's Description in ClickUp. Saved on Enter / leaving the
  // box, so it's already on the entry before Stop, Complete or switching tasks.
  const note = document.createElement("input");
  note.type = "text";
  note.className = "cu-now-note";
  note.maxLength = 500;
  note.placeholder = "Add a note to this time entry (e.g. task completed, meeting time)";
  note.title = "Shows in the Description column of your ClickUp Timesheet. Enter to save.";
  note.value = run.description || "";
  const saved = document.createElement("span");
  saved.className = "cu-now-saved";
  let last = note.value.trim();
  let saving = null;
  const commit = () => {
    const v = note.value.trim();
    if (v === last) { delete note.dataset.dirty; return saving || Promise.resolve(); }
    saved.textContent = "Saving…";
    saving = send({ type: "CLICKUP_SET_ENTRY_NOTE", entryId: run.id || null, taskId: String(run.taskId), description: v })
      .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }))
      .then((r) => {
        if (r && r.ok) {
          last = v;
          delete note.dataset.dirty;
          saved.textContent = "Saved ✓";
          setTimeout(() => { if (saved.textContent === "Saved ✓") saved.textContent = ""; }, 1800);
        } else {
          saved.textContent = "Not saved";
          saved.title = (r && (r.error || r.reason)) || "";
        }
      });
    return saving;
  };
  note.oninput = () => { note.dataset.dirty = "1"; };
  note.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } };
  note.onblur = () => { commit(); };

  const stop = document.createElement("button");
  stop.type = "button";
  stop.className = "cu-now-stop";
  stop.textContent = "\u25A0 Stop";
  stop.title = "Stop the ClickUp timer";
  stop.onclick = async () => {
    stop.disabled = true;
    stop.textContent = "\u2026";
    await commit(); // note first, so it lands on this entry
    sendTaskActionOpt(String(run.taskId), "stop");
  };
  top.append(dot, lab, nm, time, stop);
  const noteRow = document.createElement("div");
  noteRow.className = "cu-now-noterow";
  noteRow.append(note, saved);
  el.append(top, noteRow);
}

function renderClickupPreview(st) {
  if (cuEstEditingOpt) { cuRenderPendingOpt = true; return; }
  const box = $("cuPreview");
  if (!box) return;
  if (!st) {
    box.style.display = "none";
    return;
  }
  box.style.display = "block";
  box.innerHTML = "";
  if ($("dashTasks")) $("dashTasks").innerHTML = "";
  renderNowTracking();

  if (st.error) {
    const e = document.createElement("div");
    e.style.color = "var(--red)";
    e.style.fontSize = "12.5px";
    e.textContent = "Couldn't reach ClickUp: " + st.error;
    box.appendChild(e);
    // If we still have a cached total, fall through and show it below the error.
    if (!(st.at && Number.isFinite(Number(st.estimateMs)))) return;
    const note = document.createElement("div");
    note.className = "hint";
    note.style.margin = "4px 0 8px";
    note.textContent = "Showing the last total from " + fmtClock(st.at) + ".";
    box.appendChild(note);
  }

  // The today card mirrors the popup's Filter dropdown. The headline estimate +
  // tracked bars follow the WIDEST checked DATE scope (resolveCuFilterView);
  // nothing checked keeps the extended "active today" default (st.todayFilter).
  // The refine boxes (missingEst/deadlineCrossed) narrow the task LIST only.
  const view = resolveCuFilterView(st || {}, cuFilter);
  const targetMs = Number(st.targetMs) || 0;
  let estMs = Number(view.estimateMs) || 0;
  let met = targetMs > 0 && estMs >= targetMs;
  let spentTot = Number(view.spentMs) || 0;
  let viewDeadline = Array.isArray(view.deadlineTasks) ? view.deadlineTasks : [];
  let viewTasks = Array.isArray(view.tasks) ? view.tasks : [];
  let viewTracked = Array.isArray(view.trackedTasks) ? view.trackedTasks : [];
  const refineOn = cuFilter.missingEst || cuFilter.missingDue || cuFilter.waitingOthers || cuFilter.deadlineCrossed || cuFilter.hasTracked
    || (cuFilter.statuses && cuFilter.statuses.length) || (cuFilter.priorities && cuFilter.priorities.length);
  if (refineOn) {
    const keep = cuRefinePredicate(cuFilter);
    const todayStart = new Date().setHours(0, 0, 0, 0);
    viewTasks = viewTasks.filter(keep);
    viewTracked = viewTracked.filter(keep);
    // deadlineCrossed = not done AND due date on a day before today; rows
    // without a due date (some week-scope rows) never match.
    viewDeadline = viewDeadline.filter((d) => {
      if (cuFilter.missingEst && Number(d.dayEstimateMs)) return false;
      if (cuFilter.missingDue && Number(d.dueDateMs)) return false;
      if (cuFilter.waitingOthers && !cuWaitFor(d)) return false;
      if (cuFilter.hasTracked && !(Number(d.spentMs) > 0)) return false;
      if (cuFilter.deadlineCrossed) {
        if (d.done) return false;
        const due = Number(d.dueDateMs) || 0;
        if (!due || new Date(due).setHours(0, 0, 0, 0) >= todayStart) return false;
      }
      if (cuFilter.statuses && cuFilter.statuses.length && !cuFilter.statuses.includes(String(d.status || "").toLowerCase())) return false;
      if (cuFilter.priorities && cuFilter.priorities.length && !cuFilter.priorities.includes(String(d.priority || "").toLowerCase() || "none")) return false;
      return true;
    });
  }
  // Client narrowing: when one or more clients are checked, show only their
  // tasks (the options preview narrows rather than groups — its three sections
  // would get congested if grouped, unlike the popup's single list).
  const clientsSel = Array.isArray(cuFilter.clients) ? cuFilter.clients.filter(Boolean) : [];
  if (clientsSel.length) {
    const set = new Set(clientsSel);
    const keepClient = (t) => set.has(String((t && t.client) || "").trim());
    viewTasks = viewTasks.filter(keepClient);
    viewDeadline = viewDeadline.filter(keepClient);
    viewTracked = viewTracked.filter(keepClient);
    // "similarly its time": recompute the headline est/tracked from just the
    // selected clients (same reduce the popup's per-client subtotals use).
    estMs = viewTasks.reduce((a, t) => a + (Number(t.estimateMs) || 0), 0)
      + viewDeadline.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0);
    spentTot = viewTasks.concat(viewDeadline, viewTracked).reduce((a, t) => a + (Number(t.spentMs) || 0), 0);
    met = targetMs > 0 && estMs >= targetMs;
  }
  cuExportRowsOpt(viewTasks, viewDeadline, viewTracked,
    (CU_SCOPE_LABEL[view.scope] || "tasks") + (clientsSel.length ? " - " + clientsSel.join(", ") : ""));
  const noEst = viewTasks.filter((t) => !Number(t.estimateMs)).length;
  const scopeLabel = (view.scope && view.scope !== "extended") ? (view.label || CU_SCOPE_LABEL[view.scope]) : "";

  const big = document.createElement("div");
  big.className = "big";
  big.textContent = fmtDurOpt(estMs) + " ";
  const muted = document.createElement("span");
  muted.className = "muted";
  muted.textContent = targetMs > 0 ? "/ " + fmtDurOpt(targetMs) + (met ? "  ·  target met ✓" : "") : "";
  big.appendChild(muted);
  box.appendChild(big);

  // Estimated Time + its progress bar, and Tracked Time + its progress bar.
  const barWrap = document.createElement("div");
  barWrap.className = "cu-bars";
  // Estimated block.
  const estLabel = document.createElement("div");
  estLabel.className = "bar-label";
  const estName = document.createElement("span");
  estName.textContent = "Estimated Time";
  const estVal = document.createElement("span");
  estVal.className = "val";
  estVal.textContent = fmtDurOpt(estMs) + (targetMs > 0 ? " of " + fmtDurOpt(targetMs) : "");
  estLabel.appendChild(estName);
  estLabel.appendChild(estVal);

  const estBar = document.createElement("div");
  estBar.className = "cu-bar2";
  const estFill = document.createElement("div");
  estFill.className = "cu-fill2" + (met ? " met" : "");
  const estPct = targetMs > 0 ? Math.min(100, Math.round((estMs / targetMs) * 100)) : 0;
  estFill.style.width = estPct + "%";
  estBar.appendChild(estFill);
  barWrap.appendChild(estLabel);
  barWrap.appendChild(estBar);

  // Tracked block.
  const trkLabel = document.createElement("div");
  trkLabel.className = "bar-label";
  const trkName = document.createElement("span");
  trkName.textContent = "Tracked Time";
  const trkVal = document.createElement("span");
  trkVal.className = "val";
  trkVal.textContent = fmtDurOpt(spentTot) + (targetMs > 0 ? " of " + fmtDurOpt(targetMs) : "");
  trkLabel.appendChild(trkName);
  trkLabel.appendChild(trkVal);

  const trkBar = document.createElement("div");
  trkBar.className = "cu-bar2 trk";
  const trkFill = document.createElement("div");
  trkFill.className = "cu-fill2 trk" + (spentTot >= targetMs && targetMs > 0 ? " met" : "");
  const trkPct = targetMs > 0 ? Math.min(100, Math.round((spentTot / targetMs) * 100)) : 0;
  trkFill.style.width = trkPct + "%";
  trkBar.appendChild(trkFill);
  barWrap.appendChild(trkLabel);
  barWrap.appendChild(trkBar);
  box.appendChild(barWrap);

  // Summary lines: total estimated vs. total tracked + support info.
  const meta = document.createElement("div");
  meta.className = "hint";
  const line1 = document.createElement("div");
  line1.textContent =
    (scopeLabel ? scopeLabel.charAt(0).toUpperCase() + scopeLabel.slice(1) + "  ·  " : "") +
    "Total estimated: " + fmtDurOpt(estMs) +
    (targetMs > 0 ? " of " + fmtDurOpt(targetMs) + " target" : "") +
    (targetMs > 0 && !met ? "  ·  " + fmtDurOpt(Math.max(0, targetMs - estMs)) + " to go" : "");
  if (met) line1.textContent += "   ·  target met ✓";
  meta.appendChild(line1);
  const line2 = document.createElement("div");
  const deadlineMs = viewDeadline.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0);
  const spentBits = ["Total tracked today: " + fmtDurOpt(spentTot)];
  if (deadlineMs > 0) spentBits.push("deadline+" + fmtDurOpt(deadlineMs));
  if (noEst) spentBits.push(noEst + " without an estimate");
  if (refineOn) {
    const tags = [];
    if (cuFilter.missingEst) tags.push("missing estimate");
    if (cuFilter.missingDue) tags.push("missing due date");
    if (cuFilter.waitingOthers) tags.push("waiting on others");
    if (cuFilter.hasTracked) tags.push("tracked");
    if (cuFilter.deadlineCrossed) tags.push("deadline crossed");
    if (cuFilter.statuses && cuFilter.statuses.length) tags.push("status: " + cuFilter.statuses.join("/"));
    if (cuFilter.priorities && cuFilter.priorities.length) tags.push("priority: " + cuFilter.priorities.join("/"));
    spentBits.push("filter: " + tags.join(" + "));
  }
  if (clientsSel.length) spentBits.push("client: " + clientsSel.join("/"));
  if (st.at) spentBits.push("updated " + fmtClock(st.at));
  line2.textContent = spentBits.join("  ·  ");
  meta.appendChild(line2);
  box.appendChild(meta);
  optRenderCuFilterMenu();
  // Sidebar layout: the task lists render into the Dashboard's Tasks card
  // (#dashTasks); the Today card keeps just the numbers and bars.
  const lists = $("dashTasks") || box;
  {
    const scopeTxt = scopeLabel ? scopeLabel.charAt(0).toUpperCase() + scopeLabel.slice(1) : "Today";
    if ($("dashTodayTitle")) $("dashTodayTitle").textContent = scopeTxt;
    if ($("dashTasksScope")) $("dashTasksScope").textContent = scopeTxt.toLowerCase() + (clientsSel.length ? " · " + clientsSel.join(", ") : "");
    const chip = $("dashTodayChip");
    if (chip) {
      chip.style.display = targetMs > 0 ? "" : "none";
      chip.className = "dash-chip" + (met ? " met" : "");
      chip.textContent = met ? "Target met ✓" : fmtDurOpt(Math.max(0, targetMs - estMs)) + " to go";
    }
  }

  if (viewDeadline.length) {
    const dHead = document.createElement("div");
    dHead.className = "hint";
    dHead.style.marginTop = "8px";
    dHead.style.fontWeight = "700";
    dHead.textContent = "Configured tasks (by URL)";
    lists.appendChild(dHead);
    const dList = document.createElement("div");
    dList.className = "cu-tasklist";
    dList.style.maxHeight = "120px";
    for (const dt of sortByPriority(viewDeadline)) {
      const row = document.createElement("div");
      row.className = "cu-task";
      const nm = document.createElement("a");
      nm.className = "nm";
      nm.textContent = dt.name || "(configured task)";
      nm.title = nm.textContent;
      if (dt.url) { nm.href = dt.url; nm.target = "_blank"; nm.rel = "noopener"; }
      appendDoneTickOpt(nm, dt);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const estTxt = dt.accumulated
        ? (dt.dayEstimateMs ? "est " + fmtDurOpt(dt.dayEstimateMs) : "no estimate")
        : (dt.isWeekday === false
            ? "weekend 0"
            : (dt.dayEstimateMs ? fmtDurOpt(dt.dayEstimateMs) + "/day" : "no estimate"));
      const estSpan = document.createElement("span");
      estSpan.className = "est" + (dt.dayEstimateMs ? "" : " zero");
      estSpan.textContent = estTxt;
      spans.appendChild(estSpan);
      if (Number(dt.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDurOpt(dt.spentMs); markTrk(trk, dt);
        spans.appendChild(trk);
      }
      appendNameCellOpt(row, nm, dt);
      row.appendChild(spans);
      appendTaskControlsOpt(row, dt);
      dList.appendChild(row);
    }
    lists.appendChild(dList);
  }

  if (viewTasks.length) {
    const listHead = document.createElement("div");
    listHead.className = "hint";
    listHead.style.marginTop = "8px";
    listHead.style.fontWeight = "700";
    listHead.textContent = "Tasks today - each estimated / tracked";
    lists.appendChild(listHead);
    const listEl = document.createElement("div");
    listEl.className = "cu-tasklist";
    // Preserve parent -> subtask grouping: sort only the top-level rows by
    // estimate (desc), then emit each parent's subtasks (original order) right
    // under it. A plain sort would scatter subtasks away from their parent.
    const subsByParent = new Map();
    const parentRows = [];
    for (const t of viewTasks) {
      if (t.isSubtask) {
        const k = String(t.parentId);
        if (!subsByParent.has(k)) subsByParent.set(k, []);
        subsByParent.get(k).push(t);
      } else {
        parentRows.push(t);
      }
    }
    parentRows.sort(cuPrioCmp); // priority first, then bigger estimate
    const sorted = [];
    const emittedSubs = new Set();
    for (const p of parentRows) {
      sorted.push(p);
      const subs = subsByParent.get(String(p.id));
      if (subs) for (const s of subs) { sorted.push(s); emittedSubs.add(s); }
    }
    // Orphaned subtasks (parent filtered out by a refine box) - append so none vanish.
    for (const subs of subsByParent.values()) for (const s of subs) if (!emittedSubs.has(s)) sorted.push(s);
    for (const t of sorted) {
      const row = document.createElement("div");
      row.className = "cu-task" + (t.isSubtask ? " cu-sub" : "");
      const nm = document.createElement("a");
      nm.className = "nm";
      // Subtasks of a due-today parent render indented with a ↳ marker.
      nm.textContent = (t.isSubtask ? "↳ " : "") + (t.name || "(untitled task)"); // user data -> textContent
      nm.title = nm.textContent;
      if (t.url) { nm.href = t.url; nm.target = "_blank"; nm.rel = "noopener"; }
      appendDoneTickOpt(nm, t);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const est = document.createElement("span");
      est.className = "est" + (t.estimateMs ? "" : " zero");
      est.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
      spans.appendChild(est);
      if (Number(t.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t);
        spans.appendChild(trk);
      }
      appendNameCellOpt(row, nm, t);
      row.appendChild(spans);
      appendTaskControlsOpt(row, t);
      listEl.appendChild(row);
    }
    lists.appendChild(listEl);
  }

  if (viewTracked.length) {
    const listHead = document.createElement("div");
    listHead.className = "hint";
    listHead.style.marginTop = "8px";
    listHead.style.fontWeight = "700";
    listHead.textContent = view.scope === "today" ? "Tracked · not due today" : "Tracked · no dates";
    lists.appendChild(listHead);
    const listEl = document.createElement("div");
    listEl.className = "cu-tasklist";
    listEl.style.maxHeight = "120px";
    for (const t of sortByPriority(viewTracked)) {
      const row = document.createElement("div");
      row.className = "cu-task";
      const nm = document.createElement("a");
      nm.className = "nm";
      nm.textContent = t.name || "(untitled task)";
      nm.title = nm.textContent;
      if (t.url) { nm.href = t.url; nm.target = "_blank"; nm.rel = "noopener"; }
      appendDoneTickOpt(nm, t);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const est = document.createElement("span");
      est.className = "est zero";
      est.textContent = "no est";
      spans.appendChild(est);
      if (Number(t.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t);
        spans.appendChild(trk);
      }
      appendNameCellOpt(row, nm, t);
      row.appendChild(spans);
      appendTaskControlsOpt(row, t);
      listEl.appendChild(row);
    }
    lists.appendChild(listEl);
  }
  if (lists !== box && !lists.children.length) {
    const e = document.createElement("div");
    e.className = "dash-empty";
    e.textContent = view.loading ? "Loading tasks for these dates…" : "No tasks in this view.";
    lists.appendChild(e);
  }
}

// Verify + store the token. On success the background returns the workspaces
// and auto-selects the first one so data loads right away; the first refresh
// happens in the background so the "Connected" reply is never held up by
// ClickUp's network. The user can switch workspace afterwards via the dropdown.
$("cuSaveToken").onclick = async () => {
  const token = $("cuToken").value.trim();
  if (!token) {
    cuMsg("cuTokenMsg", "Paste your ClickUp token first.", false);
    return;
  }
  cuMsg("cuTokenMsg", "Connecting…", true);
  try {
    const res = await send({ type: "CLICKUP_SAVE_TOKEN", token });
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      const map = {
        "unknown message": RELOAD_HINT,
        empty: "The token was empty.",
        "no-user": "That token didn't identify a ClickUp user - double-check you copied the whole thing.",
        "verify-failed": (res && res.error) || "ClickUp rejected the token.",
      };
      cuMsg("cuTokenMsg", "Couldn't connect: " + (map[reason] || (res && (res.error || res.reason)) || "unknown error"), false);
      return;
    }
    cuTeams = res.teams || [];
    $("cuToken").value = "";
    $("cuToken").type = "password"; // re-hide if it was revealed
    const who = (res.user && (res.user.username || res.user.email)) || "you";
    const teams = res.teams || [];
    let connMsg;
    if (res.teamId) {
      const picked = teams.find((t) => String(t.id) === String(res.teamId));
      const nm = (picked && picked.name) || "your workspace";
      connMsg = teams.length > 1
        ? "Connected as " + who + " · showing " + nm + ". Switch workspace below if you track time elsewhere."
        : "Connected as " + who + " · " + nm + " ✓";
    } else {
      connMsg = "Connected as " + who + " - no workspace found on this token.";
    }
    cuMsg("cuTokenMsg", connMsg, true);
    await load(); // pulls the fresh public view (configured=true) into the form
    // First connect: trigger the first refresh explicitly so Weekly Totals + the
    // preview render immediately instead of showing "-" until a manual Refresh.
    // That fetch (today estimate + weekly + tasks) can take a few seconds, so show
    // a clear loading state in the card meanwhile - the "Connected ✓" message sits
    // in the connection section that collapses right after connecting.
    if (res.teamId) {
      renderCuPreviewLoading("Loading your ClickUp tracking… this can take a few seconds on first connect.");
      await send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeekly: true }, 25000).catch(() => {});
      await load();
    }
  } catch (e) {
    cuMsg("cuTokenMsg", "Couldn't connect: " + (e && e.message ? e.message : e), false);
  }
};

// Switch workspace - the background refreshes against the new team immediately.
$("cuTeam").onchange = async () => {
  const teamId = $("cuTeam").value;
  if (!teamId) return;
  const mt = cuTeams.find((t) => String(t.id) === teamId);
  cuMsg("cuSaveMsg", "Loading workspace…", true);
  try {
    const res = await send({ type: "CLICKUP_SET_TEAM", teamId, teamName: mt ? mt.name : null });
    if (res && res.data) renderClickupPreview(res.data);
    else if (res && res.refreshError) renderClickupPreview({ error: res.refreshError });
    cuMsg("cuSaveMsg", "", true);
  } catch (e) {
    cuMsg("cuSaveMsg", "Couldn't switch workspace: " + (e && e.message ? e.message : e), false);
  }
};

// Save the optional Admin API token (used only for the Filter Tasks card).
$("cuSaveAdminToken").onclick = async () => {
  const token = $("cuAdminToken").value.trim();
  cuMsg("cuAdminTokenMsg", "Connecting admin…", true);
  try {
    const res = await send({ type: "CLICKUP_SAVE_ADMIN_TOKEN", token });
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      const map = {
        "not-configured": "Connect your personal token first.",
        "no-user": "That admin token didn't identify a ClickUp user - check the whole key.",
        "verify-failed": (res && res.error) || "ClickUp rejected the admin token.",
      };
      cuMsg("cuAdminTokenMsg", "Couldn't connect: " + (map[reason] || (res && (res.error || res.reason)) || "unknown error"), false);
      return;
    }
    $("cuAdminToken").value = "";
    $("cuAdminToken").type = "password";
    await load(); // refreshes adminConfigured + adminUser from the public view
    const au = res.adminUser || {};
    const who = (au.username || au.email) || "you";
    cuMsg("cuAdminTokenMsg",
      res.adminConfigured
        ? "Connected as " + who + " ✓ (used for Filter Tasks views)"
        : "Admin token cleared ✓ (using your personal token)",
      true);
    setTimeout(() => cuMsg("cuAdminTokenMsg", "", true), 4000);
  } catch (e) {
    cuMsg("cuAdminTokenMsg", "Couldn't connect: " + (e && e.message ? e.message : e), false);
  }
};

// Save target hours / nudge hour / badge / notify / deadline URLs / workday end.
// Validates the numbers here so a stray letter can't blank the target; the
// background re-validates too.
$("cuSave").onclick = async () => {
  const targetRaw = $("cuTarget").value.trim();
  const nudgeRaw = $("cuNudge").value.trim();
  const endRaw = $("cuWorkdayEnd").value.trim();
  const thresholdRaw = $("cuRunningThreshold").value.trim();
  const idleStartRaw = $("cuIdleStart").value.trim();
  const idleEndRaw = $("cuIdleEnd").value.trim();
  const idleRepeatRaw = $("cuIdleRepeat").value.trim();
  const target = parseFloat(targetRaw);
  const nudge = parseInt(nudgeRaw, 10);
  const end = parseInt(endRaw, 10);
  const runningThreshold = parseInt(thresholdRaw, 10);
  const idleStart = parseInt(idleStartRaw, 10);
  const idleEnd = parseInt(idleEndRaw, 10);
  const idleRepeat = parseInt(idleRepeatRaw, 10);
  if (!Number.isFinite(target) || target <= 0 || target > 24) {
    cuMsg("cuSaveMsg", "Enter a daily target between 0 and 24 hours.", false);
    return;
  }
  if (!Number.isInteger(nudge) || nudge < 0 || nudge > 23) {
    cuMsg("cuSaveMsg", "Nudge hour must be a whole number from 0 to 23.", false);
    return;
  }
  if (!Number.isInteger(end) || end < 0 || end > 23) {
    cuMsg("cuSaveMsg", "Workday end hour must be a whole number from 0 to 23.", false);
    return;
  }
  if (!Number.isInteger(runningThreshold) || runningThreshold < 1 || runningThreshold > 180) {
    cuMsg("cuSaveMsg", "\"Warn when\" must be a whole number of minutes from 1 to 180.", false);
    return;
  }
  if (!Number.isInteger(idleStart) || idleStart < 0 || idleStart > 23) {
    cuMsg("cuSaveMsg", "Office hours start must be a whole number from 0 to 23.", false);
    return;
  }
  if (!Number.isInteger(idleEnd) || idleEnd < 0 || idleEnd > 23) {
    cuMsg("cuSaveMsg", "Office hours end must be a whole number from 0 to 23.", false);
    return;
  }
  if (idleStart >= idleEnd) {
    cuMsg("cuSaveMsg", "Office hours end must be later than the start hour.", false);
    return;
  }
  if (!Number.isInteger(idleRepeat) || idleRepeat < 5 || idleRepeat > 480) {
    cuMsg("cuSaveMsg", "\"Re-remind every\" must be a whole number of minutes from 5 to 480.", false);
    return;
  }
  const awayMin = parseInt($("cuAwayMin").value.trim(), 10);
  if (!Number.isInteger(awayMin) || awayMin < 5 || awayMin > 240) {
    cuMsg("cuSaveMsg", "\"Away for at least\" must be a whole number of minutes from 5 to 240.", false);
    return;
  }
  const wrapUpTime = $("cuWrapUpTime").value || "16:45";
  const deadlineUrls = $("cuDeadlineUrls").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    await send({
      type: "CLICKUP_SET",
      patch: {
        clickupTargetHours: target,
        clickupNudgeHour: nudge,
        clickupWorkdayEndHour: end,
        clickupExtendedMode: ($("cuExtendedMode") && $("cuExtendedMode").value === "excl0") ? "excl0" : "days",
        clickupWeeklyTo: ($("cuWeeklyTo") && $("cuWeeklyTo").value === "friday") ? "friday" : "today",
        clickupBadge: $("cuBadge").checked,
        clickupNotify: $("cuNotify").checked,
        clickupHalfwayNotify: $("cuHalfway").checked,
        clickupAlmostThereNotify: $("cuAlmostThere").checked,
        clickupRunningNotify: $("cuRunningNotify").checked,
        clickupRunningThresholdMin: runningThreshold,
        clickupIdleNotify: $("cuIdleNotify").checked,
        clickupIdleStartHour: idleStart,
        clickupIdleEndHour: idleEnd,
        clickupIdleRepeatMin: idleRepeat,
        clickupSyncMin: Number($("cuSyncMin").value) || 5,
        clickupWeekMode: ($("cuWeekMode") && $("cuWeekMode").value) || "sun-sat",
        clickupAwayNotify: $("cuAwayNotify").checked,
        clickupAwayMin: awayMin,
        clickupWrapUp: $("cuWrapUp").checked,
        clickupWrapUpTime: wrapUpTime,
        clickupDeadlineTaskUrls: deadlineUrls,
      },
    });
    await load(); // recomputes targetMet against the new goal and repaints
    cuMsg("cuSaveMsg", "Saved ✓", true);
    setTimeout(() => cuMsg("cuSaveMsg", "", true), 1500);
  } catch (e) {
    cuMsg("cuSaveMsg", "Couldn't save: " + (e && e.message ? e.message : e), false);
  }
};

// Force a fresh pull from ClickUp (with the per-task breakdown for the preview).
$("cuRefreshNow").onclick = async () => {
  const btn = $("cuRefreshNow");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    // Heavy pull (today + weekly + per-task). The service worker may be cold and a
    // forced weekly recompute is slow, so the default 8s often expired first - that
    // was the "Refresh now does nothing / No response from the extension" bug. Give
    // it real time to wake and finish.
    const res = await send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeekly: true, forceWeeks: true }, 25000);
    if (res && res.ok && res.data) renderClickupPreview(res.data);
    // On failure the background keeps the last-good numbers and annotates the
    // error, so reload to repaint from that cached state ("showing last total…").
    else await load();
    btn.disabled = false;
    btn.textContent = orig;
  } catch (e) {
    // Still no reply (worker wedged, or this page went stale after an extension
    // reload). Fall back to a plain page reload - it re-establishes the connection
    // and repaints from the last-good cached state, i.e. the Ctrl+R the user would
    // otherwise do by hand. (No button reset needed; the page is reloading.)
    location.reload();
  }
};

// Open the (normally collapsed) "Connection settings" section - shared by the
// "Manage connection" button and the sign-out flow - and scroll it into view.
function openConnectionSettings() {
  if (typeof showOptTab === "function") showOptTab("clickup");
  const body = $("cuConnBody");
  const btn = document.querySelector('[data-optcollapse="connection"]');
  if (body) body.classList.remove("collapsed");
  if (btn) {
    btn.textContent = "▾ Hide";
    btn.setAttribute("aria-expanded", "true");
    // Expand for the current view only - deliberately NOT persisted, so the
    // section returns to its collapsed default on the next options-page load.
  }
  if (body && body.scrollIntoView) body.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Reveal the token + admin-token fields (shared by the sign-out flow).
$("cuSignOut").onclick = async () => {
  if (!confirm("Sign out of ClickUp? This removes the stored token(s) from this browser. You can paste a new personal token (and admin token) afterwards.")) return;
  try {
    await send({ type: "CLICKUP_CLEAR" });
    cuTeams = [];
    $("cuToken").value = "";
    $("cuAdminToken").value = "";
    await load();
    openConnectionSettings();
    $("cuToken").focus();
    cuMsg("cuTokenMsg", "Signed out. Paste a new personal API token to reconnect.", true);
  } catch (e) {
    showErr("Couldn't sign out: " + (e && e.message ? e.message : e));
  }
};

// Disconnect - wipes the stored token + cached state from this browser.
$("cuClear").onclick = async () => {
  if (!confirm("Disconnect ClickUp? This removes the stored token from this browser.")) return;
  try {
    await send({ type: "CLICKUP_CLEAR" });
    cuTeams = [];
    $("cuToken").value = "";
    cuMsg("cuTokenMsg", "Disconnected.", true);
    setTimeout(() => cuMsg("cuTokenMsg", "", true), 1500);
    await load();
  } catch (e) {
    showErr("Couldn't disconnect: " + (e && e.message ? e.message : e));
  }
};

// ===========================================================================
// Debug - GitHub login / logout test.
// ===========================================================================
function dbgMsg(text, ok) {
  const el = $("dbgOut");
  if (!el) return;
  el.style.display = "block";
  el.textContent = text || "";
  el.style.color = ok === false ? "var(--red)" : ok ? "var(--green)" : "var(--muted)";
}

function dbgAppend(text) {
  const el = $("dbgOut");
  if (!el) return;
  el.style.display = "block";
  el.style.color = "var(--text)";
  el.textContent += (el.textContent ? "\n" : "") + text;
}

// Populate the account <select> in the Debug card from the public account list.
function renderDebugAccounts(accounts) {
  const sel = $("dbgAccount");
  if (!sel) return;
  sel.innerHTML = "";
  const withTotp = accounts.filter((a) => a.hasTotp);
  const list = withTotp.length ? withTotp : accounts;
  if (!list.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no accounts)";
    sel.appendChild(opt);
    return;
  }
  for (const a of list) {
    const opt = document.createElement("option");
    opt.value = a.id;
    const tags = [];
    if (a.hasTotp) tags.push("2FA");
    if (a.authMethod === "google") tags.push("Google");
    else if (a.authMethod === "google-passkey") tags.push("Google · passkey");
    opt.textContent = (a.label || a.username) + (tags.length ? " (" + tags.join(", ") + ")" : "");
    sel.appendChild(opt);
  }
}

$("dbgLoginBtn").onclick = async () => {
  const id = $("dbgAccount").value;
  if (!id) {
    dbgMsg("Pick an account to test.", false);
    return;
  }
  const btn = $("dbgLoginBtn");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Testing login…";
  dbgMsg("Starting GitHub login test…\n");
  try {
    const res = await send({ type: "DEBUG_GITHUB_LOGIN", id });
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      dbgAppend(reason === "already running" ? "Another login is already running - wait and retry." : "Couldn't start: " + (reason || "unknown"), false);
      return;
    }
    // Test started - arm the Stop button so the user can force-cancel it.
    const stop = $("dbgStopBtn");
    if (stop) stop.disabled = false;
    // Further progress arrives via DEBUG_PROGRESS messages.
  } catch (e) {
    dbgAppend("Couldn't start test: " + (e && e.message ? e.message : e), false);
  }
};

// Force-stop a running debug login/test. Sends RUN_CANCEL to the background,
// which the login loop checks each iteration and bails out as "Stopped by user."
$("dbgStopBtn").onclick = async () => {
  const stop = $("dbgStopBtn");
  if (stop) stop.disabled = true;
  try {
    const res = await send({ type: "RUN_CANCEL" });
    dbgAppend(res && res.ok ? "Stop requested - cancelling the running login…" : "Couldn't send stop: " + ((res && res.reason) || "unknown"), true);
  } catch (e) {
    dbgAppend("Couldn't send stop: " + (e && e.message ? e.message : e), false);
  }
};

$("dbgLogoutBtn").onclick = async () => {
  const btn = $("dbgLogoutBtn");
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = "Testing logout…";
  dbgMsg("Clearing GitHub + Agent Router session…\n");
  try {
    const res = await send({ type: "DEBUG_GITHUB_LOGOUT" });
    if (res && res.ok) {
      const lines = Object.entries(res.summary || {})
        .map(([d, s]) => d + ": cleared " + s.cleared + " cookie(s), kept " + s.kept + " device-trust");
      dbgAppend("Logout done.\n" + lines.join("\n"), true);
    } else {
      dbgAppend("Logout failed: " + ((res && (res.error || res.reason)) || "unknown"), false);
    }
  } catch (e) {
    dbgAppend("Logout failed: " + (e && e.message ? e.message : e), false);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
};

// Live "Run all" progress from the background: keep the Accounts card's Run/Stop
// buttons and the per-account status in step while a batch runs.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "RUN_PROGRESS") {
    // phase "done" for the last account flips running off shortly after; simplest
    // is to reload the public state, which carries the authoritative running flag.
    load();
  }
});

// Live Drive-sync busy phase from the background (mirrors the popup). Fires
// during the interactive Google window and whenever a sign-in/out/sync runs -
// including one started from the popup - so the card's dot + label stay in step.
// We repaint only the Drive Sync card (not a full load()) to avoid re-fetching
// department members etc. on every phase change; when the phase clears we pull
// fresh signedIn / last-sync with a light GET_STATE.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "DRIVE_BUSY") return;
  optDriveBusy = msg.phase || "";
  if (optDriveBusy) {
    renderDriveSync(optLastState || {});
  } else {
    send({ type: "GET_STATE" }).then((s) => { if (s) { optLastState = s; renderDriveSync(s); } }).catch(() => {});
  }
});

// Listen for live DEBUG_PROGRESS updates from the background.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "DEBUG_PROGRESS") {
    const btn = $("dbgLoginBtn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Test login";
    }
    const stop = $("dbgStopBtn");
    if (stop) stop.disabled = true;
    if (msg.done) {
      const ok = msg.ok;
      const lines = [];
      lines.push(ok ? "✓ Login succeeded." : (msg.result ? msg.result + " - " : "") + (msg.note || "Login did not complete."));
      if (msg.detected) {
        if (msg.detected.githubLogin) lines.push("GitHub handle: " + msg.detected.githubLogin);
        if (msg.detected.githubEmail) lines.push("GitHub email: " + msg.detected.githubEmail);
        if (msg.detected.arUsername) lines.push("Agent Router user: " + msg.detected.arUsername);
        if (msg.detected.balance != null) lines.push("Balance captured.");
      }
      dbgAppend(lines.join("\n"), ok);
    } else {
      dbgAppend("Step: " + (msg.phase || msg.result || "") + (msg.note ? " - " + msg.note : ""));
    }
  }
});

// Collapsible "Weekly totals" + "Filter tasks" sections (mirrors the popup's
// card collapse). Each subhead keeps a ▸/▾ button; the chevron persists and
// both sections default to collapsed - the weekly SUMMARY (toggle + numbers +
// accumulated line) stays visible, only the per-day detail list is hidden.
const OPT_COLLAPSE_KEYS = { weekly: "cuOptCollapseWeekly", filter: "cuOptCollapseFilter", connection: "cuOptCollapseConnection", settings: "cuOptCollapseSettings" };
function initOptCollapse() {
  chrome.storage.local.get(Object.values(OPT_COLLAPSE_KEYS)).then((stored) => {
    stored = stored || {};
    document.querySelectorAll("[data-optcollapse]").forEach((btn) => {
      const key = btn.dataset.optcollapse;
      const body = document.getElementById(btn.dataset.optcolltarget || "");
      if (!key || !body) return;
      const cacheKey = OPT_COLLAPSE_KEYS[key];
      // "This week by day" (weekly) and "Explore tasks" (filter) always open
      // hidden; Show only lasts for this visit, so no preference is saved.
      const alwaysHidden = key === "weekly" || key === "filter";
      let collapsed = alwaysHidden ? true : stored[cacheKey] !== false;
      const apply = (col) => {
        body.classList.toggle("collapsed", col);
        btn.textContent = col ? "▸ Show" : "▾ Hide";
        btn.setAttribute("aria-expanded", String(!col));
      };
      apply(collapsed);
      btn.onclick = () => {
        const nc = !body.classList.contains("collapsed");
        apply(nc);
        if (!alwaysHidden) chrome.storage.local.set({ [cacheKey]: nc }).catch(() => {});
      };
    });
  }).catch(() => {});
}

initTheme();
initCardCollapse();
initOptCollapse();
initOptionsFilterControls();
initDeptCreator();
resetForm();
load();

// Filter dropdown on the options Today preview (replaces the old "Due today
// only" checkbox). Shares the `cuFilter` storage key with the popup, so ticking
// a box in one place updates the other (see the cuFilter branch in the
// storage.onChanged listener below). Repaints from the already-cached
// clickupState - no refetch. See resolveCuFilterView above for scope semantics.
function optCuFilterBtnLabel() {
  const btn = $("optCuFilterBtn");
  if (!btn) return;
  const n = cuActiveFilterCount(cuFilter);
  btn.textContent = "▾ Filter" + (n ? " · " + n : "");
  btn.classList.toggle("active", n > 0);
}
function cuPrettyName(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function cuArrEq(a, b) { a = Array.isArray(a) ? a : []; b = Array.isArray(b) ? b : []; if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }
function cuToggleArrayVal(f, key, val, on) {
  const arr = Array.isArray(f[key]) ? f[key] : (f[key] = []);
  const i = arr.indexOf(val);
  if (on && i < 0) arr.push(val);
  else if (!on && i >= 0) arr.splice(i, 1);
}
function cuBuildFacetList(box, attr, values, checked, labelFn) {
  if (!box) return;
  const lbl = labelFn || cuPrettyName;
  box.textContent = "";
  for (const v of values) {
    const label = document.createElement("label");
    label.title = lbl(v);
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute(attr, v);
    input.checked = checked.includes(v);
    const span = document.createElement("span");
    span.textContent = lbl(v);
    label.appendChild(input);
    label.appendChild(document.createTextNode(" "));
    label.appendChild(span);
    box.appendChild(label);
  }
}
// Repaint the whole dropdown: static boolean boxes from cuFilter, then rebuild
// the dynamic Status / Priority sections from the last-known clickupState
// (checked-but-absent values are preserved so a set refine never silently drops).

// ---------- Filter selection mode: "One at a time" vs "Multiple" ----------
// Single mode is PER GROUP (Due / Client / Status / Priority / Refine): ticking a
// box unticks the others in its own group, so e.g. "Due today" + one client still
// combine. Shared with the other page through the "cuFilterMode" storage key.
const CU_DATE_KEYS = ["dueToday", "dueTomorrow", "dueWeek", "dueNextWeek", "dueCustom"];
const CU_REFINE_KEYS = ["missingEst", "missingDue", "hasTracked", "deadlineCrossed", "waitingOthers"];
let cuFilterSingle = false;
// Before a box is ticked in single mode, clear the rest of its group.
function cuSingleClearGroup(el) {
  if (!cuFilterSingle || !el || !el.checked) return;
  const k = el.getAttribute("data-cf");
  if (k) {
    const grp = CU_DATE_KEYS.includes(k) ? CU_DATE_KEYS : CU_REFINE_KEYS.includes(k) ? CU_REFINE_KEYS : null;
    if (grp) grp.forEach((x) => { if (x !== k) cuFilter[x] = false; });
  } else if (el.hasAttribute("data-cf-status")) cuFilter.statuses = [];
  else if (el.hasAttribute("data-cf-priority")) cuFilter.priorities = [];
  else if (el.hasAttribute("data-cf-client")) cuFilter.clients = [];
}
// Switching to single mode: keep only the first ticked box in each group.
function cuTrimToSingle() {
  for (const grp of [CU_DATE_KEYS, CU_REFINE_KEYS]) {
    let kept = false;
    for (const k of grp) { if (cuFilter[k]) { if (kept) cuFilter[k] = false; kept = true; } }
  }
  for (const key of ["statuses", "priorities", "clients"]) {
    if (Array.isArray(cuFilter[key]) && cuFilter[key].length > 1) cuFilter[key] = cuFilter[key].slice(0, 1);
  }
}

// "Clear all filters": one click instead of unticking each box. Leaves the view
// on its default (no date box ticked = the extended "active today" list).
function cuClearAllFilters() {
  for (const k of CU_FILTER_KEYS) cuFilter[k] = false;
  cuFilter.statuses = [];
  cuFilter.priorities = [];
  cuFilter.clients = [];
  cuFilter.customFrom = "";
  cuFilter.customTo = "";
  chrome.storage.local.set({ cuFilter }).catch(() => {});
  optRenderCuFilterMenu();
  optCuFilterBtnLabel();
  optRepaintCuPreview();
}
function cuPaintClearBtn(menu) {
  const b = menu && menu.querySelector("[data-fclear]");
  if (!b) return;
  const on = CU_FILTER_KEYS.some((k) => cuFilter[k]) ||
    (cuFilter.statuses && cuFilter.statuses.length) ||
    (cuFilter.priorities && cuFilter.priorities.length) ||
    (cuFilter.clients && cuFilter.clients.length);
  b.disabled = !on;
}
function cuPaintModeToggle(menu) {
  if (!menu) return;
  menu.querySelectorAll("[data-fmode]").forEach((b) => b.classList.toggle("on", (b.dataset.fmode === "single") === cuFilterSingle));
}
function optRenderCuFilterMenu() {
  const menu = $("optCuFilterMenu");
  if (!menu) return;
  cuPaintClearBtn(menu);
  menu.querySelectorAll("input[data-cf]").forEach((el) => { el.checked = !!cuFilter[el.getAttribute("data-cf")]; });
  const st = (optClickup && optClickup.state) || {};
  menu.querySelectorAll("[data-cf-dates]").forEach((row) => {
    row.hidden = !cuFilter.dueCustom;
    const fromEl = row.querySelector("[data-cf-from]");
    const toEl = row.querySelector("[data-cf-to]");
    if (fromEl && document.activeElement !== fromEl) fromEl.value = cuFilter.customFrom || "";
    if (toEl && document.activeElement !== toEl) toEl.value = cuFilter.customTo || "";
  });
  const facets = cuAvailableFacets(st);
  const statuses = Array.isArray(cuFilter.statuses) ? cuFilter.statuses : [];
  const priorities = Array.isArray(cuFilter.priorities) ? cuFilter.priorities : [];
  const clients = Array.isArray(cuFilter.clients) ? cuFilter.clients : [];
  const statusVals = Array.from(new Set(facets.statuses.concat(statuses))).sort();
  const priorityVals = CU_PRIORITY_ORDER.filter((p) => facets.priorities.includes(p) || priorities.includes(p));
  const clientVals = Array.from(new Set(facets.clients.concat(clients))).sort((a, b) => a.localeCompare(b));
  cuBuildFacetList($("optCuFilterStatusList"), "data-cf-status", statusVals, statuses);
  cuBuildFacetList($("optCuFilterPriorityList"), "data-cf-priority", priorityVals, priorities);
  cuBuildFacetList($("optCuFilterClientList"), "data-cf-client", clientVals, clients, (v) => v);
  const sg = $("optCuFilterStatusGroup"); if (sg) sg.hidden = !statusVals.length;
  const pg = $("optCuFilterPriorityGroup"); if (pg) pg.hidden = !priorityVals.length;
  const cg = $("optCuFilterClientGroup"); if (cg) cg.hidden = !clientVals.length;
}
function optOpenCuFilterMenu(open) {
  const menu = $("optCuFilterMenu");
  const btn = $("optCuFilterBtn");
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}
function optRepaintCuPreview() {
  if (optClickup && optClickup.state) renderClickupPreview(optClickup.state);
}
(async function initOptCuFilter() {
  const btn = $("optCuFilterBtn");
  const menu = $("optCuFilterMenu");
  if (!btn || !menu) return;
  try {
    const got = await chrome.storage.local.get(["cuFilter", "cuDueTodayOnly"]);
    if (got.cuFilter && typeof got.cuFilter === "object") {
      for (const k of CU_FILTER_KEYS) cuFilter[k] = !!got.cuFilter[k];
      if (got.cuFilter.dueWorkweek) { cuFilter.dueWeek = true; chrome.storage.local.set({ cuFilter }).catch(() => {}); } // "Due Mon-Fri" was removed
      cuFilter.statuses = Array.isArray(got.cuFilter.statuses) ? got.cuFilter.statuses.slice() : [];
      cuFilter.priorities = Array.isArray(got.cuFilter.priorities) ? got.cuFilter.priorities.slice() : [];
      cuFilter.clients = Array.isArray(got.cuFilter.clients) ? got.cuFilter.clients.slice() : [];
      cuFilter.customFrom = typeof got.cuFilter.customFrom === "string" ? got.cuFilter.customFrom : "";
      cuFilter.customTo = typeof got.cuFilter.customTo === "string" ? got.cuFilter.customTo : "";
    } else if (got.cuDueTodayOnly === true) {
      cuFilter.dueToday = true; // migrate the legacy single checkbox
      chrome.storage.local.set({ cuFilter }).catch(() => {});
    }
  } catch (e) {}
  optRenderCuFilterMenu();
  optCuFilterBtnLabel();
  optRepaintCuPreview();

  try {
    const gm = await chrome.storage.local.get("cuFilterMode");
    cuFilterSingle = gm && gm.cuFilterMode === "single";
  } catch (e) {}
  cuPaintModeToggle(menu);
  cuPaintClearBtn(menu);
  const clearBtn = menu.querySelector("[data-fclear]");
  if (clearBtn) clearBtn.onclick = (e) => { e.stopPropagation(); cuClearAllFilters(); cuPaintClearBtn(menu); };
  menu.querySelectorAll("[data-fmode]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      cuFilterSingle = b.dataset.fmode === "single";
      if (cuFilterSingle) {
        cuTrimToSingle();
        chrome.storage.local.set({ cuFilter }).catch(() => {});
        optRenderCuFilterMenu();
        optCuFilterBtnLabel();
        optRepaintCuPreview();
      }
      cuPaintModeToggle(menu);
      chrome.storage.local.set({ cuFilterMode: cuFilterSingle ? "single" : "multi" }).catch(() => {});
    };
  });

  btn.onclick = (e) => { e.stopPropagation(); optOpenCuFilterMenu(menu.hidden); };
  // Delegated so the dynamically-rebuilt Status/Priority boxes are handled too.
  menu.addEventListener("change", (e) => {
    const el = e.target;
    if (!el || el.tagName !== "INPUT") return;
    if (el.hasAttribute("data-cf-from") || el.hasAttribute("data-cf-to")) {
      cuFilter[el.hasAttribute("data-cf-from") ? "customFrom" : "customTo"] = el.value || "";
      // Picking a date switches the custom range on (single mode clears the rest of Due).
      if (cuFilter.customFrom && !cuFilter.dueCustom) {
        const cb = menu.querySelector('input[data-cf="dueCustom"]');
        if (cb) { cb.checked = true; cuSingleClearGroup(cb); }
        cuFilter.dueCustom = true;
      }
      chrome.storage.local.set({ cuFilter }).catch(() => {});
      optRenderCuFilterMenu();
      optCuFilterBtnLabel();
      optRepaintCuPreview();
      return;
    }
    cuSingleClearGroup(el); // single mode: untick the rest of this group first
    if (el.hasAttribute("data-cf")) cuFilter[el.getAttribute("data-cf")] = el.checked;
    else if (el.hasAttribute("data-cf-status")) cuToggleArrayVal(cuFilter, "statuses", el.getAttribute("data-cf-status"), el.checked);
    else if (el.hasAttribute("data-cf-priority")) cuToggleArrayVal(cuFilter, "priorities", el.getAttribute("data-cf-priority"), el.checked);
    else if (el.hasAttribute("data-cf-client")) cuToggleArrayVal(cuFilter, "clients", el.getAttribute("data-cf-client"), el.checked);
    else return;
    chrome.storage.local.set({ cuFilter }).catch(() => {});
    optRenderCuFilterMenu(); // repaint unticked boxes + show/hide the custom date pickers
    optCuFilterBtnLabel();
    optRepaintCuPreview();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) optOpenCuFilterMenu(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) optOpenCuFilterMenu(false); });
})();

// -----------------------------------------------------------------------------
// Live updates - keep this page in step with changes made elsewhere (the popup,
// the background's periodic refresh, or ClickUp itself) instead of forcing a
// manual reload. Debounced + focus-guarded so a background refresh never wipes
// out text the user is actively typing.
// -----------------------------------------------------------------------------
function _isEditingField() {
  const ae = document.activeElement;
  return !!(ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.isContentEditable));
}

// Full reload (accounts + ClickUp + Department card + filters). Used only when
// ClickUp is connected/disconnected elsewhere - clickupEnc changes rarely, so no
// risk of a refresh loop.
let _optReloadTimer = null;
function scheduleOptionsReload(delay) {
  clearTimeout(_optReloadTimer);
  _optReloadTimer = setTimeout(() => {
    if (_isEditingField()) { scheduleOptionsReload(1500); return; } // wait until they stop typing
    load().catch(() => {});
  }, delay == null ? 400 : delay);
}

// Lightweight ClickUp-card repaint (connected state + Start/Stop button + today/
// weekly preview) without re-running the Department fetch - so the frequent
// clickupState writes (5-min poll, timer actions, running-state sync) can't cause
// a reload loop and don't disturb the rest of the page.
let _cuUiTimer = null;
function scheduleClickupUiRefresh(delay) {
  clearTimeout(_cuUiTimer);
  _cuUiTimer = setTimeout(async () => {
    if (_isEditingField()) { scheduleClickupUiRefresh(1500); return; }
    try {
      const st = await send({ type: "GET_STATE" });
      if (st) { optClickup = st.clickup || {}; renderClickupSettings(optClickup); }
    } catch (e) {}
  }, delay == null ? 300 : delay);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Accounts added/deleted, synced from Drive, or wiped by a Google sign-out ->
  // re-apply the Agent Router cards' "show once you have accounts" default AND
  // refresh the account list so an open options page reflects the change without
  // a manual reload. acctCount only fires when the count actually changes, so this
  // reload is rare (real add/delete/sign-out), not part of the periodic churn.
  if (changes.acctCount) {
    applyAcctCardDefaults((changes.acctCount.newValue || 0) > 0);
    scheduleOptionsReload();
  }
  // ClickUp connected/disconnected elsewhere (e.g. a personal token pasted in the
  // popup) -> full reload so the connected UI, Department card and filters appear
  // without a manual reload.
  if (changes.clickupEnc) { scheduleOptionsReload(); return; }
  // ClickUp data refreshed (periodic poll, a timer start/stop, or a running-state
  // sync) -> light repaint of just the ClickUp card.
  if (changes.clickupState) { cuOverdueInvalidate(); scheduleClickupUiRefresh(); }
  // Filter toggled in the popup (or another options tab) -> mirror it here and
  // repaint the preview so the pages stay in sync. Guarded so a change this page
  // itself made (identical values) is a no-op.
  if (changes.cuFilterMode) {
    cuFilterSingle = changes.cuFilterMode.newValue === "single";
    cuPaintModeToggle($("optCuFilterMenu"));
  }
  if (changes.cuFilter && changes.cuFilter.newValue && typeof changes.cuFilter.newValue === "object") {
    const nv = changes.cuFilter.newValue;
    let diff = false;
    for (const k of CU_FILTER_KEYS) { const b = !!nv[k]; if (cuFilter[k] !== b) { cuFilter[k] = b; diff = true; } }
    const nvS = Array.isArray(nv.statuses) ? nv.statuses : [];
    const nvP = Array.isArray(nv.priorities) ? nv.priorities : [];
    const nvC = Array.isArray(nv.clients) ? nv.clients : [];
    if (!cuArrEq(cuFilter.statuses, nvS)) { cuFilter.statuses = nvS.slice(); diff = true; }
    if (!cuArrEq(cuFilter.priorities, nvP)) { cuFilter.priorities = nvP.slice(); diff = true; }
    if (!cuArrEq(cuFilter.clients, nvC)) { cuFilter.clients = nvC.slice(); diff = true; }
    for (const k of ["customFrom", "customTo"]) { const v = typeof nv[k] === "string" ? nv[k] : ""; if ((cuFilter[k] || "") !== v) { cuFilter[k] = v; diff = true; } }
    if (diff) { optRenderCuFilterMenu(); optCuFilterBtnLabel(); optRepaintCuPreview(); }
  }
  // A Drive sync finished somewhere (periodic alarm, the popup's Sync, or a
  // sign-in) -> refresh just the Drive Sync card's "Last synced" line + dot.
  if (changes.driveLastSync) {
    send({ type: "GET_STATE" }).then((s) => { if (s) { optLastState = s; renderDriveSync(s); } }).catch(() => {});
  }
  // Theme toggled in the popup.
  if (changes.theme) applyTheme(changes.theme.newValue === "dark" ? "dark" : "light");
});

// ---------- Client Site Uptime Monitor ----------
// url -> client name, so monitored sites keep a readable label (filled from the
// saved config and from the Auto-detect review table).
const smSiteNames = {};

function smHint(text, isErr) {
  const el = $("siteMonitorDiscoverHint");
  if (!el) return;
  el.textContent = text || "";
  el.style.display = text ? "block" : "none";
  el.style.color = isErr ? "var(--red)" : "";
}

// Normalize what the user typed into an origin: "acmehvac.com/x" ->
// "https://acmehvac.com". Returns "" when it isn't a usable web address.
function smNormalizeUrl(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    if (!/\.[a-z]{2,}$/i.test(u.hostname)) return "";
    return u.protocol + "//" + u.hostname.toLowerCase() + (u.port ? ":" + u.port : "");
  } catch (e) { return ""; }
}

async function loadSiteMonitorConfig() {
  // Background replies { ok, cfg } - the old code read the wrapper itself as the
  // config, so saved sites never loaded back into the page.
  const resp = await send({ type: "GET_SITE_MONITOR_CONFIG" }).catch(() => null);
  const cfg = resp && resp.cfg && typeof resp.cfg === "object" ? resp.cfg : null;
  if (!cfg) return;
  const sites = Array.isArray(cfg.sites) ? cfg.sites : [];
  for (const s of sites) if (s && s.url && s.name && s.name !== s.url) smSiteNames[s.url] = s.name;
  $("siteMonitorEnabled").checked = !!cfg.enabled;
  $("siteMonitorBody").style.opacity = cfg.enabled ? "1" : "0.5";
  $("siteMonitorUrls").value = smFormatLines(sites);
  renderSiteMonitorStatus(cfg);
}

// Site list lines: "Client | https://site.com", "Client, site.com", "site.com Client"
// or a bare URL. The part that is a web address is the URL; the rest is the client
// name, matched to your ClickUp client spelling when it's the same client.
function smKnownClients() {
  const st = (optClickup && optClickup.state) || {};
  const names = new Map();
  for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) {
    if (!b) continue;
    for (const t of [...(b.tasks || []), ...(b.deadlineTasks || []), ...(b.trackedTasks || [])]) {
      if (t && t.client) names.set(String(t.client).toLowerCase().replace(/[^a-z0-9]+/g, ""), t.client);
    }
  }
  return names;
}
function smParseLine(line, known) {
  const parts = String(line).split(/\s*[|,\t]\s*|\s+(?=https?:\/\/)/).map((p) => p.trim()).filter(Boolean);
  let url = "";
  const rest = [];
  for (const p of parts) {
    if (!url && /^(https?:\/\/)?[^\s]+\.[a-z]{2,}(\/|$|:)/i.test(p) && smNormalizeUrl(p)) url = smNormalizeUrl(p);
    else rest.push(p);
  }
  if (!url) {
    // "site.com Client name": look for the web address among the words.
    rest.length = 0;
    for (const w of String(line).split(/\s+/)) {
      if (!url && /\.[a-z]{2,}/i.test(w) && smNormalizeUrl(w)) url = smNormalizeUrl(w);
      else if (w && w !== "|" && w !== ",") rest.push(w);
    }
  }
  if (!url) return null;
  let name = rest.join(" ").trim();
  if (name && known) {
    const hit = known.get(name.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    if (hit) name = hit;
  }
  return { url, name };
}
function smFormatLines(sites) {
  return (sites || []).map((s) => (s.name && s.name !== s.url ? s.name + " | " : "") + s.url).join("\n");
}

async function saveSiteMonitorConfig() {
  const enabled = $("siteMonitorEnabled").checked;
  const lines = $("siteMonitorUrls").value.split("\n").map((s) => s.trim()).filter(Boolean);
  const sites = [];
  const bad = [];
  const known = smKnownClients();
  for (const line of lines) {
    const p = smParseLine(line, known);
    if (!p) { bad.push(line); continue; }
    if (sites.some((s) => s.url === p.url)) continue;
    const name = p.name || smSiteNames[p.url] || p.url;
    if (p.name) smSiteNames[p.url] = p.name;
    sites.push({ url: p.url, name });
  }
  const cfg = { enabled, sites };
  const res = await send({ type: "SET_SITE_MONITOR_CONFIG", cfg }).catch(() => null);
  if (res && res.ok) {
    $("siteMonitorUrls").value = smFormatLines(sites);
    $("siteMonitorSaved").style.display = "inline";
    setTimeout(() => { $("siteMonitorSaved").style.display = "none"; }, 2000);
    renderSiteBackup();
    if (bad.length) smHint(bad.length + " line(s) skipped - not a web address: " + bad.slice(0, 3).join(", ") + (bad.length > 3 ? "…" : ""), true);
    else if (!enabled && sites.length) smHint("Saved " + sites.length + " site(s). Tick \"Enable site monitoring\" and save again to start checking them.");
    else smHint("");
    renderSiteMonitorStatus(cfg);
  } else {
    smHint("Couldn't save - reload the extension and try again.", true);
  }
}

// Auto-detect: ask the background for every client in open ClickUp tasks plus a
// best-guess website, then show a review table (client · editable URL · where
// the guess came from) so the user can verify/correct before adding anything.
async function discoverClientSitesOpt() {
  const box = $("siteMonitorDetected");
  if (box) { box.innerHTML = ""; box.style.display = "none"; }
  smHint("Scanning your open ClickUp tasks for clients and their websites…");
  let res = null;
  try { res = await send({ type: "DISCOVER_CLIENT_SITES" }, 60000); }
  catch (e) { smHint("Auto-detect failed: " + (e && e.message ? e.message : e), true); return; }
  if (!res || !res.ok) {
    const why = res && res.reason === "not-configured" ? "connect ClickUp first (ClickUp card above)."
      : "ClickUp request failed" + (res && res.reason ? " (" + res.reason + ")" : "") + ". Try again in a minute.";
    smHint("Auto-detect: " + why, true);
    return;
  }
  const clients = Array.isArray(res.clients) ? res.clients : [];
  if (!clients.length) {
    smHint("No clients found in " + (res.scanned || 0) + " open ClickUp task(s).", true);
    return;
  }
  const found = clients.filter((c) => c.url).length;
  smHint("Found " + clients.length + " client(s) in " + res.scanned + " open task(s); a website was detected for " + found + "." +
    (res.rateLimited ? " (ClickUp rate limit hit - list may be partial.)" : "") +
    " Check each URL below, fix or fill in any that are wrong/empty, tick the ones to monitor, then click \"Add ticked sites\".");
  renderDetectedSites(clients);
}

function renderDetectedSites(clients) {
  const box = $("siteMonitorDetected");
  if (!box) return;
  const monitored = new Set($("siteMonitorUrls").value.split("\n").map((l) => { const p = smParseLine(l); return p ? p.url : ""; }).filter(Boolean));
  box.innerHTML = "";
  box.style.display = "block";
  const table = document.createElement("div");
  table.className = "sm-det";
  const head = document.createElement("div");
  head.className = "sm-det-row sm-det-head";
  head.innerHTML = "<span></span><span>Client</span><span>Website (editable)</span>";
  table.appendChild(head);
  clients.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "sm-det-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    const already = c.url && monitored.has(smNormalizeUrl(c.url));
    // Pre-tick only confident matches; weak/guessed ones wait for the user.
    cb.checked = !!c.url && !already && (c.confidence === "high" || c.confidence === "medium");
    const nameCell = document.createElement("span");
    nameCell.className = "sm-det-name";
    nameCell.innerHTML = "<b></b><span class=\"hint\"></span>";
    nameCell.querySelector("b").textContent = c.name;
    nameCell.querySelector(".hint").textContent = " · " + c.taskCount + " task" + (c.taskCount === 1 ? "" : "s");
    const urlCell = document.createElement("span");
    urlCell.className = "sm-det-url";
    const inp = document.createElement("input");
    inp.type = "text";
    inp.value = c.url || "";
    inp.placeholder = "https://client-site.com";
    inp.spellcheck = false;
    if (Array.isArray(c.candidates) && c.candidates.length) {
      const dl = document.createElement("datalist");
      dl.id = "smCand" + i;
      for (const u of c.candidates) { const o = document.createElement("option"); o.value = u; dl.appendChild(o); }
      urlCell.appendChild(dl);
      inp.setAttribute("list", dl.id);
    }
    const src = document.createElement("span");
    src.className = "hint sm-det-src conf-" + (already ? "high" : (c.confidence || "none"));
    const confLabel = { high: "✓ ", medium: "", low: "weak - ", guess: "? ", none: "" }[c.confidence] || "";
    src.textContent = already ? "already monitored" : confLabel + (c.source || "");
    inp.addEventListener("input", () => {
      cb.checked = !!inp.value.trim();
      inp.classList.remove("bad");
      src.className = "hint sm-det-src conf-high";
      src.textContent = "edited by you";
    });
    urlCell.appendChild(inp);
    urlCell.appendChild(src);
    row._client = c;
    row._cb = cb;
    row._inp = inp;
    row.appendChild(cb);
    row.appendChild(nameCell);
    row.appendChild(urlCell);
    table.appendChild(row);
  });
  box.appendChild(table);
  const btns = document.createElement("div");
  btns.className = "btns";
  btns.style.marginTop = "10px";
  const add = document.createElement("button");
  add.className = "primary";
  add.textContent = "Add ticked sites";
  const all = document.createElement("button");
  all.textContent = "Tick all with a URL";
  const close = document.createElement("button");
  close.textContent = "Close";
  btns.appendChild(add);
  btns.appendChild(all);
  btns.appendChild(close);
  box.appendChild(btns);
  const rows = () => [...table.querySelectorAll(".sm-det-row")].filter((r) => r._client);
  all.onclick = () => rows().forEach((r) => { r._cb.checked = !!r._inp.value.trim(); });
  close.onclick = () => { box.innerHTML = ""; box.style.display = "none"; smHint(""); };
  add.onclick = () => {
    const lines = $("siteMonitorUrls").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const have = new Set(lines.map((l) => { const p = smParseLine(l); return p ? p.url : ""; }).filter(Boolean));
    let added = 0;
    let bad = 0;
    for (const r of rows()) {
      if (!r._cb.checked) continue;
      const url = smNormalizeUrl(r._inp.value);
      if (!url) { r._inp.classList.add("bad"); bad++; continue; }
      smSiteNames[url] = r._client.name;
      if (have.has(url)) continue;
      have.add(url);
      lines.push(r._client.name + " | " + url);
      added++;
    }
    if (bad) { smHint(bad + " ticked row(s) need a valid web address (e.g. https://client.com) - fix the red fields or untick them.", true); return; }
    $("siteMonitorUrls").value = lines.join("\n");
    box.innerHTML = "";
    box.style.display = "none";
    smHint("Added " + added + " site(s) to the list above. Review it, tick \"Enable site monitoring\", then click \"Save sites\".");
  };
}

function renderSiteMonitorStatus(cfg) {
  const el = $("siteMonitorStatus");
  if (!el) return;
  if (!cfg || !Array.isArray(cfg.sites) || cfg.sites.length === 0) {
    el.innerHTML = '<p class="hint">No sites configured yet.</p>';
    return;
  }
  if (!cfg.enabled) {
    el.innerHTML = '<p class="hint">Monitoring is disabled (' + cfg.sites.length + ' site(s) saved). Tick "Enable site monitoring" and save to start.</p>';
    return;
  }
  // Background replies { ok, state } - read the state object, not the wrapper.
  send({ type: "GET_SITE_MONITOR_STATE" }).then((resp) => {
    const state = resp && resp.state && typeof resp.state === "object" ? resp.state : {};
    const rows = cfg.sites.map((s) => {
      const st = state[s.url] || { up: null, fails: 0, lastCheck: 0 };
      const statusText = st.up === true ? "✅ Up" : st.up === false ? "❌ Down" : "⚪ Not checked yet";
      const lastCheckText = st.lastCheck ? new Date(st.lastCheck).toLocaleString() : "never";
      const label = s.name && s.name !== s.url ? escapeHtml(s.name) + ' <span class="hint">' + escapeHtml(s.url) + "</span>" : escapeHtml(s.url);
      return '<div class="imp-row"><div class="imp-entry"><b>' + label + '</b><br><span class="hint">' + statusText + " · last check: " + lastCheckText + (st.fails ? " · " + st.fails + " consecutive failures" : "") + "</span></div></div>";
    }).join("");
    el.innerHTML = '<div class="cu-subhead" style="margin-top:12px;">Current status</div>' + rows;
  }).catch(() => {
    el.innerHTML = '<p class="hint">Could not fetch state.</p>';
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

if ($("versionsBtn")) $("versionsBtn").onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("update.html#versions") }).catch(() => {});
};

// Header: open the side panel / the wrap-up page from the options page too.
// Explore tasks: its own export (rows as filtered there, including the client).
if (window.pcmExport) window.pcmExport.attach($("optFltExportBtn"), () => optFltExport);
if ($("optFltClient")) $("optFltClient").addEventListener("change", () => renderOptionsFilter());
// Explore tasks: clear its tick boxes, client and department in one go.
if ($("optFltClearBtn")) $("optFltClearBtn").onclick = () => {
  for (const id of ["optFltOnlyMissing", "optFltMissingStart", "optFltMissingDue", "optFltIncomplete", "optFltOverdue", "optFltSpan"]) {
    if ($(id)) $(id).checked = false;
  }
  for (const id of ["optFltClient", "optFltDept", "optFltDeptUser"]) if ($(id)) $(id).value = "";
  if ($("optFltDeptUserWrap")) $("optFltDeptUserWrap").style.display = "none";
  renderOptionsFilter();
};

// Export button on the ClickUp card (exports exactly what the card shows).
if (window.pcmExport) window.pcmExport.attach($("optCuExportBtn"), () => cuExportDataOpt);

(function initHeaderTools() {
  const panel = $("optPanelBtn"), wrap = $("optWrapBtn");
  if (wrap) wrap.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL("wrapup.html") }).catch(() => {});
  if (!panel) return;
  if (!chrome.sidePanel || !chrome.sidePanel.open) { panel.hidden = true; return; }
  let winId = null;
  chrome.windows.getCurrent().then((w) => { winId = w && w.id; }).catch(() => {});
  panel.onclick = () => { if (winId != null) chrome.sidePanel.open({ windowId: winId }).catch(() => {}); };
})();

// Wire up site monitor UI
const smEnabled = $("siteMonitorEnabled");
const smSave = $("siteMonitorSave");
if (smEnabled) smEnabled.addEventListener("change", () => {
  $("siteMonitorBody").style.opacity = smEnabled.checked ? "1" : "0.5";
});
if (smSave) smSave.addEventListener("click", saveSiteMonitorConfig);
// Backup line: shows when this list last went to Google Drive.
function renderSiteBackup() {
  const el = $("siteMonitorBackup");
  if (!el) return;
  chrome.storage.local.get(["extrasStamps", "driveLastSync"]).then(({ extrasStamps, driveLastSync }) => {
    const at = Number(extrasStamps && extrasStamps.siteMonitorConfig) || 0;
    if (!at) { el.textContent = "Not backed up to Drive yet - save the list while Drive sync is on."; return; }
    const synced = Number(driveLastSync) || 0;
    el.textContent = synced >= at
      ? "Saved to Google Drive ✓ · " + new Date(synced).toLocaleString()
      : "Saved here at " + new Date(at).toLocaleTimeString() + " · sending to Drive…";
  }).catch(() => {});
}
renderSiteBackup();
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.extrasStamps || ch.driveLastSync)) renderSiteBackup();
});

const smDiscover = $("siteMonitorDiscover");
if (smDiscover) smDiscover.addEventListener("click", () => {
  if (smDiscover.disabled) return;
  smDiscover.disabled = true;
  const originalLabel = smDiscover.textContent;
  smDiscover.textContent = "Detecting…";
  discoverClientSitesOpt()
    .catch((e) => smHint("Auto-detect failed: " + (e && e.message ? e.message : e), true))
    .finally(() => {
      smDiscover.disabled = false;
      smDiscover.textContent = originalLabel;
    });
});

// Load on startup
loadSiteMonitorConfig().catch(() => {});

// Two-way timer sync: pull ClickUp's live running-timer state when the tab
// regains focus/visibility (e.g. after starting or stopping the timer directly
// in ClickUp) and on a slow interval while visible. CLICKUP_SYNC_RUNNING is a
// single light GET that only rewrites clickupState (-> the listener above flips
// the button) when the running entry actually changed.
function syncClickupRunning() {
  if (!optClickup || !optClickup.configured) return;
  send({ type: "CLICKUP_SYNC_RUNNING" }).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) syncClickupRunning(); });
window.addEventListener("focus", syncClickupRunning);
setInterval(() => { if (!document.hidden) syncClickupRunning(); }, 60000);

// ---------- Sidebar navigation (tabbed layout) ----------
// One section visible at a time; the choice is remembered (per browser) and can
// be deep-linked with #dashboard / #clickup / #agent / #sites / #general.
const OPT_TABS = ["dashboard", "clickup", "agent", "sites", "admin", "general"];
function showOptTab(name) {
  if (!OPT_TABS.includes(name)) name = "dashboard";
  document.querySelectorAll("#sideNav [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".panel[data-panel]").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  try { localStorage.setItem("optTab", name); } catch (e) {}
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
if (document.body.classList.contains("tabbed")) {
  document.querySelectorAll("#sideNav [data-tab]").forEach((b) => { b.onclick = () => { showOptTab(b.dataset.tab); window.scrollTo({ top: 0 }); }; });
  document.querySelectorAll("[data-goto]").forEach((b) => { b.onclick = () => showOptTab(b.dataset.goto); });
  let first = (location.hash || "").replace("#", "");
  if (!OPT_TABS.includes(first)) { try { first = localStorage.getItem("optTab") || ""; } catch (e) { first = ""; } }
  showOptTab(first || "dashboard");
  window.addEventListener("hashchange", () => showOptTab((location.hash || "").replace("#", "")));
}

// Dashboard refresh + General "Save" reuse the existing handlers.
if ($("dashRefresh")) $("dashRefresh").onclick = () => { const b = $("cuRefreshNow"); if (b) b.click(); };
if ($("saveSettings2")) $("saveSettings2").onclick = async () => {
  try { await $("saveSettings").onclick(); } catch (e) {}
  const m = $("settingsSaved2");
  if (m) { m.style.display = "inline"; setTimeout(() => { m.style.display = "none"; }, 1800); }
};

// ---------- Status strip ----------
// ClickUp · Drive · Agent Router · Sites at a glance; each chip jumps to its section.
let _stripTimer = null;
function refreshStatusStrip(delay) {
  clearTimeout(_stripTimer);
  _stripTimer = setTimeout(async () => {
    const el = $("statusStrip");
    if (!el) return;
    let st = null, sm = null, smState = null;
    try { st = await send({ type: "GET_STATE" }); } catch (e) {}
    try { sm = await send({ type: "GET_SITE_MONITOR_CONFIG" }); } catch (e) {}
    try { smState = await send({ type: "GET_SITE_MONITOR_STATE" }); } catch (e) {}
    if (!st) return;
    const chips = [];
    const cu = st.clickup || {};
    const cuName = cu.user && (cu.user.username || cu.user.email);
    chips.push({ tab: "clickup", cls: cu.configured ? "ok" : "warn", text: cu.configured ? "ClickUp" + (cuName ? " · " + cuName : "") : "ClickUp not connected" });
    const last = st.driveLastSync;
    const lastAt = last && (last.at || last.ts || (typeof last === "number" ? last : 0));
    chips.push({ tab: "general", cls: st.signedIn ? "ok" : "warn", text: st.signedIn ? "Drive synced" + (lastAt ? " " + new Date(lastAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "") : "Drive sync off" });
    const accs = st.accounts || [];
    if (!arVisible(st)) {
      // Agent Router hidden - no chip.
    } else if (accs.length) {
      const done = accs.filter((a) => ((st.status || {})[a.id] || {}).lastDone === st.today).length;
      chips.push({ tab: "agent", cls: done >= accs.length ? "ok" : "warn", text: "Agent Router " + done + "/" + accs.length + " done today" });
    } else {
      chips.push({ tab: "agent", cls: "", text: "Agent Router · no accounts" });
    }
    const cfg = sm && sm.cfg;
    const sites = cfg && Array.isArray(cfg.sites) ? cfg.sites : [];
    if (cfg && cfg.enabled && sites.length) {
      const state = (smState && smState.state) || {};
      const down = sites.filter((x) => (state[x.url] || {}).up === false).length;
      chips.push({ tab: "sites", cls: down ? "bad" : "ok", text: down ? down + " site" + (down === 1 ? "" : "s") + " down" : sites.length + " site" + (sites.length === 1 ? "" : "s") + " up" });
    } else {
      chips.push({ tab: "sites", cls: "", text: "Site monitor off" });
    }
    try {
      const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
      if (ui && ui.newer) chips.unshift({ href: chrome.runtime.getURL("update.html"), cls: "warn", text: "Update available: v" + ui.latest });
    } catch (e) {}
    el.innerHTML = "";
    for (const c of chips) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "st-chip" + (c.cls ? " st-" + c.cls : ""); // own names: a bare "warn" collides with the page-wide .warn box style
      b.innerHTML = '<span class="dot"></span>';
      b.appendChild(document.createTextNode(c.text));
      b.onclick = () => { if (c.href) window.open(c.href, "_blank", "noopener"); else showOptTab(c.tab); };
      el.appendChild(b);
    }
  }, delay == null ? 250 : delay);
}
refreshStatusStrip(0);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.updateInfo) renderVersionRow();
  if (changes.updateInfo || changes.status || changes.clickupState || changes.clickupEnc || changes.driveLastSync || changes.siteMonitorState || changes.siteMonitorConfig || changes.acctCount) refreshStatusStrip();
});

// ---------- Version / updates (General section) ----------
async function renderVersionRow() {
  const el = $("versionLine");
  if (!el) return;
  const current = chrome.runtime.getManifest().version;
  let ui = null;
  try { ui = (await chrome.storage.local.get("updateInfo")).updateInfo; } catch (e) {}
  el.innerHTML = "";
  const t = document.createElement("span");
  t.textContent = "Installed version v" + current + " · ";
  el.appendChild(t);
  const s = document.createElement("span");
  if (ui && ui.newer) {
    const a = document.createElement("a");
    a.href = ui.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = "v" + ui.latest + " is available - open the release";
    s.appendChild(a);
  } else if (ui && ui.error) {
    s.textContent = "couldn't check (" + ui.error + ")";
  } else if (ui && ui.latest) {
    s.textContent = "up to date (checked " + new Date(ui.checkedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ")";
  } else {
    s.textContent = "not checked yet";
  }
  el.appendChild(s);
  const dl = $("downloadUpdateBtn");
  if (dl) { dl.style.display = ui && ui.newer ? "" : "none"; if (ui && ui.newer) dl.textContent = "Update to v" + ui.latest; }
}
if ($("downloadUpdateBtn")) $("downloadUpdateBtn").onclick = () => { window.open(chrome.runtime.getURL("update.html"), "_blank"); };
if ($("setupUpdatesBtn")) $("setupUpdatesBtn").onclick = () => { window.open(chrome.runtime.getURL("update.html?setup=1"), "_blank"); };
if ($("reloadExtBtn")) $("reloadExtBtn").onclick = () => { send({ type: "RELOAD_EXTENSION" }).catch(() => {}); };
if ($("checkUpdateBtn")) $("checkUpdateBtn").onclick = async () => {
  const b = $("checkUpdateBtn");
  b.disabled = true; b.textContent = "Checking…";
  try {
    const r = await send({ type: "CHECK_UPDATE", force: true }, 20000);
    if (r && r.reason === "not-configured") $("versionLine").textContent = "Update checks start once the extension is published on GitHub.";
    else await renderVersionRow();
  } catch (e) { $("versionLine").textContent = "Couldn't check: " + (e && e.message ? e.message : e); }
  b.disabled = false; b.textContent = "Check for updates";
};
renderVersionRow();

// ---------- Custom notification sounds (Options > General) ----------
// Stored in chrome.storage.local "customSounds" = { notify|danger|winner: { kind, src, name } }
// (kept out of settings so large sound files aren't copied to Drive).
const SND_MAX_BYTES = 1024 * 1024;
const SND_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|webm)$/i;
function sndTest(src) {
  // Resolves when the browser can actually decode + play it (8s timeout).
  return new Promise((resolve, reject) => {
    const a = new Audio();
    const t = setTimeout(() => { a.src = ""; reject(new Error("took too long to load")); }, 8000);
    a.oncanplaythrough = () => { clearTimeout(t); resolve(a); };
    a.onerror = () => { clearTimeout(t); reject(new Error("the browser can't play it (unsupported format or not an audio file)")); };
    a.preload = "auto";
    a.src = src;
    a.load();
  });
}
async function sndGetAll() {
  try { const { customSounds } = await chrome.storage.local.get("customSounds"); return customSounds && typeof customSounds === "object" ? customSounds : {}; } catch (e) { return {}; }
}
async function sndSave(key, val) {
  const all = await sndGetAll();
  if (val) all[key] = val; else delete all[key];
  await chrome.storage.local.set({ customSounds: all });
}
async function initSoundRows() {
  const all = await sndGetAll();
  document.querySelectorAll(".snd-row").forEach((row) => {
    const key = row.dataset.snd;
    const kind = row.querySelector(".snd-kind");
    const fileIn = row.querySelector(".snd-file");
    const urlIn = row.querySelector(".snd-url");
    const play = row.querySelector(".snd-play");
    const msg = row.querySelector(".snd-msg");
    const say = (t, bad) => { msg.textContent = t || ""; msg.style.color = bad ? "var(--red)" : ""; };
    const cur = all[key];
    const layout = () => {
      fileIn.style.display = kind.value === "file" ? "" : "none";
      urlIn.style.display = kind.value === "url" ? "" : "none";
    };
    kind.value = cur ? cur.kind : "default";
    if (cur && cur.kind === "url") urlIn.value = cur.src;
    say(cur ? (cur.kind === "file" ? "Using your file: " + (cur.name || "sound") : "Using your link") : "");
    layout();
    kind.onchange = async () => {
      layout();
      if (kind.value === "default") { await sndSave(key, null); say("Back to the default sound."); }
      else if (kind.value === "file") { say("Choose an audio file (MP3, WAV, OGG, M4A/AAC or WebM, up to 1 MB)."); fileIn.click(); }
      else { say("Paste a direct link to an audio file, then press Enter."); urlIn.focus(); }
    };
    fileIn.onchange = async () => {
      const f = fileIn.files && fileIn.files[0];
      fileIn.value = "";
      if (!f) return;
      if (f.size > SND_MAX_BYTES) { say("That file is " + (f.size / 1048576).toFixed(1) + " MB - please use one under 1 MB (trim it to a few seconds).", true); return; }
      if (!SND_EXT.test(f.name) && !/^audio\//.test(f.type)) { say("That isn't a supported audio file. Use MP3, WAV, OGG, M4A/AAC or WebM.", true); return; }
      const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(f); });
      try {
        const a = await sndTest(dataUrl);
        await sndSave(key, { kind: "file", src: dataUrl, name: f.name });
        say("Saved \u2713 Using your file: " + f.name);
        a.play().catch(() => {});
      } catch (e) { say("Couldn't use that file: " + e.message + ".", true); }
    };
    const saveUrl = async () => {
      const u = urlIn.value.trim();
      if (!u) return;
      if (!/^https:\/\//i.test(u)) { say("Use a secure https:// link.", true); return; }
      if (/youtube\.com|youtu\.be|drive\.google\.com|spotify\.com|soundcloud\.com/i.test(u)) { say("That's a web page, not an audio file. Use a link that opens the sound file itself (e.g. ending in .mp3).", true); return; }
      say("Checking the link\u2026");
      try {
        const a = await sndTest(u);
        await sndSave(key, { kind: "url", src: u, name: u });
        say("Saved \u2713 Using your link.");
        a.play().catch(() => {});
      } catch (e) { say("Couldn't use that link: " + e.message + ".", true); }
    };
    urlIn.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); saveUrl(); } };
    urlIn.onchange = saveUrl;
    play.onclick = async () => {
      const now = (await sndGetAll())[key];
      if (now && now.src) { const a = new Audio(now.src); a.play().catch(() => say("Couldn't play it right now.", true)); }
      else send({ type: "PLAY_TEST_SOUND", sound: key === "notify" ? undefined : key }).catch(() => {});
    };
  });
}
initSoundRows();

// ---------- Agent Router visibility ----------
// settings.showAgentRouter: true / false; unset = show only if accounts exist
// (new users don't see it; existing Agent Router users keep it).
function arVisible(st) {
  const v = st && st.settings ? st.settings.showAgentRouter : undefined;
  if (v === true || v === false) return v;
  return !!(st && Array.isArray(st.accounts) && st.accounts.length);
}

// ======================= Admin: publish a new version =======================
// Packages the extension's own files (Chrome can read them) into a zip and
// publishes it as a GitHub release, so a new version can go out without leaving
// the browser. The GitHub token lives encrypted in the background, never here.
const ADMIN_FILES = [
  "manifest.json", "background.js", "popup.html", "popup.js", "options.html", "options.js",
  "offscreen.html", "offscreen.js", "update.html", "update.js", "wrapup.html", "wrapup.js",
  "notify-menu.js", "export-tasks.js", "lib-zip.js", "lib-unzip.js", "lib-automation.js",
  "lib-availability.js", "lib-clickup.js", "lib-crypto.js", "lib-drive.js",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png",
  "sounds/notify.wav", "sounds/danger.mp3", "sounds/winner.wav",
  "README.md", "CHANGELOG.md",
];
let admZip = null; // { blob, version, files }

function admSay(text, cls) {
  const box = $("admLog");
  if (!box) return;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
function admClear() { if ($("admLog")) $("admLog").innerHTML = ""; }
function admBusy(on) {
  for (const id of ["admPublish", "admGithub", "admBuild", "admSetVersion"]) if ($(id)) $(id).disabled = on;
}
const admFmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");

// Read this extension's own files and zip them, exactly as they run right now.
async function admBuildZip() {
  const files = [];
  let missing = 0;
  for (const path of ADMIN_FILES) {
    try {
      const res = await fetch(chrome.runtime.getURL(path));
      if (!res.ok) { missing++; continue; }
      files.push({ path, data: new Uint8Array(await res.arrayBuffer()) });
    } catch (e) { missing++; }
  }
  if (!files.length) throw new Error("Couldn't read the extension's files.");
  const version = JSON.parse(new TextDecoder().decode(files.find((f) => f.path === "manifest.json").data)).version;
  const blob = window.pcmZip.makeZip(files);
  admZip = { blob, version, files: files.length };
  admSay("Packaged " + files.length + " files (" + admFmtSize(blob.size) + ") for v" + version + (missing ? " - " + missing + " file(s) skipped" : ""), "ok");
  return admZip;
}
function admDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const admB64 = (blob) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result).split(",")[1] || "");
  fr.onerror = () => rej(new Error("Couldn't read the package."));
  fr.readAsDataURL(blob);
});

// The version lives in manifest.json, which sits in the extension's folder. The
// same folder handle the one-click updater remembers is used to rewrite it.
function admFolderHandle() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("pcm-updater", 1); } catch (e) { return resolve(null); }
    req.onupgradeneeded = () => { try { req.result.createObjectStore("kv"); } catch (e) {} };
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction("kv", "readonly").objectStore("kv").get("extDir");
        tx.onsuccess = () => resolve(tx.result || null);
        tx.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    };
  });
}
// Remember this extension's folder (same place the one-click updater keeps it),
// so "Set version & reload" can rewrite manifest.json.
function admSaveFolder(handle) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open("pcm-updater", 1); } catch (e) { return resolve(false); }
    req.onupgradeneeded = () => { try { req.result.createObjectStore("kv"); } catch (e) {} };
    req.onerror = () => resolve(false);
    req.onsuccess = () => {
      try {
        const tx = req.result.transaction("kv", "readwrite").objectStore("kv").put(handle, "extDir");
        tx.onsuccess = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    };
  });
}
async function admPickFolder() {
  try {
    const dir = await window.showDirectoryPicker({ mode: "readwrite", id: "pcm-ext-folder" });
    // Make sure it really is this extension's folder before trusting it.
    let ok = false;
    try { await dir.getFileHandle("manifest.json"); ok = true; } catch (e) {}
    if (!ok) { admSay("That folder has no manifest.json - pick the folder this extension was unzipped into.", "err"); return false; }
    await admSaveFolder(dir);
    admSay("Folder remembered: " + dir.name, "ok");
    return true;
  } catch (e) {
    if (e && e.name === "AbortError") admSay("No folder chosen.", "err");
    else admSay("Couldn't use that folder: " + (e && e.message ? e.message : e), "err");
    return false;
  }
}
async function admSetVersion() {
  const want = String($("admVersion").value || "").replace(/^v/, "").trim();
  if (!/^\d+\.\d+(\.\d+)?$/.test(want)) { admSay("Version must look like 3.7.0", "err"); return; }
  let dir = await admFolderHandle();
  if (!dir) {
    admSay("This extension's folder isn't remembered yet - choose it now (the folder you unzipped this extension into).", "err");
    if (!(await admPickFolder())) return;
    dir = await admFolderHandle();
    if (!dir) return;
  }
  try {
    if ((await dir.queryPermission({ mode: "readwrite" })) !== "granted" &&
        (await dir.requestPermission({ mode: "readwrite" })) !== "granted") {
      admSay("Permission to write to the folder was refused.", "err");
      return;
    }
    const fh = await dir.getFileHandle("manifest.json");
    const text = await (await fh.getFile()).text();
    const next = text.replace(/("version"\s*:\s*")[^"]+(")/, "$1" + want + "$2");
    if (next === text) { admSay("Couldn't find the version line in manifest.json.", "err"); return; }
    const w = await fh.createWritable();
    await w.write(next);
    await w.close();
    admSay("manifest.json now says " + want + " - restarting the extension…", "ok");
    setTimeout(() => { send({ type: "RELOAD_EXTENSION" }).catch(() => {}); }, 800);
  } catch (e) {
    admSay("Couldn't write manifest.json: " + (e && e.message ? e.message : e), "err");
  }
}

// Release notes: start from this version's section of CHANGELOG.md.
async function admNotesFromChangelog(version) {
  try {
    const text = await (await fetch(chrome.runtime.getURL("CHANGELOG.md"))).text();
    const lines = text.split("\n");
    const start = lines.findIndex((l) => new RegExp("^##\\s+v?" + version.replace(/\./g, "\\.") + "(\\s|$)").test(l.trim()));
    if (start < 0) return "";
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out.join("\n").trim();
  } catch (e) { return ""; }
}

async function admRefresh() {
  let st = null;
  try { st = await send({ type: "ADMIN_STATE" }); } catch (e) {}
  const version = (st && st.version) || chrome.runtime.getManifest().version;
  if ($("admCurrent")) $("admCurrent").textContent = "v" + version;
  if ($("admRepo") && st && st.repo) $("admRepo").textContent = st.repo;
  // Default to the version that is actually running: that is what Upload
  // publishes. Type a higher number and press "Set version & reload" to move up.
  if ($("admVersion") && !$("admVersion").value) $("admVersion").value = version;
  if ($("admSyncToken") && st) $("admSyncToken").checked = st.syncToken !== false;
  if ($("admTokenState")) {
    $("admTokenState").textContent = st && st.hasToken ? "- saved (" + st.tokenHint + ")" : "- not saved yet";
  }
  if ($("admNotes") && !$("admNotes").value) $("admNotes").value = await admNotesFromChangelog(version);
}

if ($("admSetVersion")) $("admSetVersion").onclick = () => { admClear(); admSetVersion(); };
if ($("admPickFolder")) $("admPickFolder").onclick = () => { admClear(); admPickFolder(); };
if ($("admBuild")) $("admBuild").onclick = async () => {
  admClear();
  admBusy(true);
  try {
    const z = await admBuildZip();
    admDownload(z.blob, "personal-clickup-manager-v" + z.version + ".zip");
    admSay("Saved to your Downloads folder.", "ok");
  } catch (e) { admSay(String(e && e.message ? e.message : e), "err"); }
  admBusy(false);
};
if ($("admGithub")) $("admGithub").onclick = async () => {
  admClear();
  admBusy(true);
  try {
    const version = String($("admVersion").value || "").replace(/^v/, "").trim();
    const running = chrome.runtime.getManifest().version;
    if (version && version !== running) {
      throw new Error("This extension is running v" + running + ", so that is what gets packaged. Press \"Set version & reload\" to make it v" + version + " first.");
    }
    const z = await admBuildZip();
    admDownload(z.blob, "personal-clickup-manager-v" + z.version + ".zip");
    const st = await send({ type: "ADMIN_STATE" }).catch(() => null);
    const repo = (st && st.repo) || "";
    const notes = String($("admNotes").value || "");
    const url = "https://github.com/" + repo + "/releases/new?tag=v" + encodeURIComponent(version) +
      "&title=" + encodeURIComponent("v" + version) + "&body=" + encodeURIComponent(($("admCritical").checked ? "[critical]\n\n" : "") + notes);
    chrome.tabs.create({ url }).catch(() => {});
    admSay("GitHub is open with everything filled in. Drag the zip from your Downloads into the \"Attach binaries\" box, then press Publish release.", "ok");
  } catch (e) { admSay(String(e && e.message ? e.message : e), "err"); }
  admBusy(false);
};
if ($("admPublish")) $("admPublish").onclick = async () => {
  admClear();
  admBusy(true);
  try {
    const st = await send({ type: "ADMIN_STATE" });
    if (!st || !st.hasToken) throw new Error("Save a GitHub token below first, or use \"Open GitHub page instead\".");
    const version = String($("admVersion").value || "").replace(/^v/, "").trim();
    const z = await admBuildZip();
    if (version !== z.version) {
      throw new Error("The running extension is v" + z.version + ", so that is what would be published. Press \"Set version & reload\" to make it v" + version + " first.");
    }
    admSay("Uploading v" + version + " to GitHub…");
    const res = await send({
      type: "ADMIN_PUBLISH",
      version,
      notes: $("admNotes").value || "",
      critical: !!($("admCritical") && $("admCritical").checked),
      zipB64: await admB64(z.blob),
    }, 120000);
    if (!res || !res.ok) throw new Error((res && res.error) || "Publish failed.");
    admSay("Published " + res.tag + " ✓ - everyone gets the update prompt within ~12 hours (or straight away via Check for updates).", "ok");
    const a = document.createElement("a");
    a.href = res.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open the release on GitHub";
    const line = document.createElement("div");
    line.appendChild(a);
    $("admLog").appendChild(line);
  } catch (e) { admSay(String(e && e.message ? e.message : e), "err"); }
  admBusy(false);
};
if ($("admSaveToken")) $("admSaveToken").onclick = async () => {
  const btn = $("admSaveToken");
  btn.disabled = true;
  const res = await send({ type: "ADMIN_SET_TOKEN", token: $("admToken").value }).catch((e) => ({ ok: false, error: String(e) }));
  btn.disabled = false;
  cuMsg("admTokenMsg", res && res.ok ? "Saved ✓" : (res && res.error) || "Couldn't save", !!(res && res.ok));
  if (res && res.ok) {
    $("admToken").value = "";
    send({ type: "SYNC_NOW" }).catch(() => {}); // back it up straight away when allowed
  }
  admRefresh();
};
if ($("admSyncToken")) $("admSyncToken").onchange = async () => {
  const on = $("admSyncToken").checked;
  try { await send({ type: "SET_SETTINGS", patch: { adminSyncToken: on } }); } catch (e) {}
  cuMsg("admTokenMsg", on ? "Will be backed up to Drive" : "Kept on this computer only", true);
  if (on) send({ type: "SYNC_NOW" }).catch(() => {});
};
if ($("admForgetToken")) $("admForgetToken").onclick = async () => {
  await send({ type: "ADMIN_SET_TOKEN", token: "" }).catch(() => {});
  $("admToken").value = "";
  cuMsg("admTokenMsg", "Forgotten", true);
  admRefresh();
};
function adminVisible(st) {
  return !!(st && st.settings && st.settings.showAdmin);
}
function applyAdminVisibility(st) {
  const on = adminVisible(st);
  document.body.classList.toggle("no-admin", !on);
  if (!on && document.querySelector('.panel.on[data-panel="admin"]') && typeof showOptTab === "function") showOptTab("dashboard");
  if (on) admRefresh();
}
if ($("showAdmin")) $("showAdmin").onchange = async () => {
  const on = $("showAdmin").checked;
  try { await send({ type: "SET_SETTINGS", patch: { showAdmin: on } }); } catch (e) {}
  document.body.classList.toggle("no-admin", !on);
  if (on) admRefresh();
  else if (document.querySelector('.panel.on[data-panel="admin"]') && typeof showOptTab === "function") showOptTab("dashboard");
};

function applyArVisibility(st) {
  document.body.classList.toggle("no-ar", !arVisible(st));
  if (!arVisible(st) && document.querySelector('.panel.on[data-panel="agent"]') && typeof showOptTab === "function") showOptTab("dashboard");
}

if ($("showAgentRouter")) $("showAgentRouter").onchange = async () => {
  const on = $("showAgentRouter").checked;
  try { await send({ type: "SET_SETTINGS", patch: { showAgentRouter: on } }); } catch (e) {}
  document.body.classList.toggle("no-ar", !on);
  if (!on && document.querySelector('.panel.on[data-panel="agent"]') && typeof showOptTab === "function") showOptTab("dashboard");
  if (typeof refreshStatusStrip === "function") refreshStatusStrip(0);
};
