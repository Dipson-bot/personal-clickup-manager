// options.js - manage accounts + settings. Talks to background via messages.
// Secrets are only ever sent TO the background; they are never read back into
// this page (the background returns a "hasPassword/hasTotp" flag instead).

const $ = (id) => document.getElementById(id);

// Show the running version (from manifest.json) next to the header title.
try { const _vb = $("verBadge"); if (_vb) _vb.textContent = "v" + chrome.runtime.getManifest().version; } catch (e) {}

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
    // The runner waits longer after each failure (1h, 6h, 24h, then 72h) so a broken
    // login doesn't hammer GitHub; show when it will really try next.
    const nextTry = Number(st.nextAttemptAt) || 0;
    const nextTryTxt = nextTry > Date.now() ? " · next try " + fmtDayTime(nextTry) : "";
    const waiting = !!(st.lastResult && st.lastResult !== "success" && nextTryTxt);
    if (dAt && Date.now() < dAt + resetMs) {
      statusText = "credited " + fmtDayTime(dAt) + (st.creditSource === "login" ? " (at login)" : "") + " · resets " + fmtDayTime(dAt + resetMs);
    } else if (Number(st.retryStoppedAt) > 0) {
      // No retry can fix this login (wrong password, bad TOTP secret...), so the
      // runner has stopped attempting it. Checked before "ready to run" because a
      // stopped account is never ready, however long ago it last tried.
      statusText = "automatic retries stopped - fix this login, then Run" + (st.lastRunAt ? " (tried " + fmtDayTime(st.lastRunAt) + ")" : "");
    } else if (dAt && !waiting) {
      const ranLater = st.lastRunAt && st.lastRunAt > dAt + 60000;
      statusText = "ready to run · " + (ranLater ? "last run " + fmtDayTime(st.lastRunAt) + " · " : "") + "last credit " + fmtDayTime(dAt);
    } else if (!dAt && st.lastResult === "success" && st.lastRunAt) {
      // Login landed but the balance poll hasn't confirmed the daily credit yet;
      // the row flips to "logged in … resets …" the moment the batch is detected.
      statusText = "Logged in · awaiting credit (run " + fmtDayTime(st.lastRunAt) + ")";
    } else if (st.lastResult && st.lastResult !== "success") {
      statusText = "last: " + st.lastResult + (st.lastRunAt ? " (" + fmtDayTime(st.lastRunAt) + ")" : "") + nextTryTxt;
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
    if ($("notifyVolume")) {
      const v = Number(state.settings && state.settings.notifyVolume);
      $("notifyVolume").value = String(Number.isFinite(v) && v > 0 ? v : 100);
      $("notifyVolumeVal").textContent = $("notifyVolume").value + "%";
    }
    $("slowNetwork").checked = !!(state.settings && state.settings.slowNetwork);
    if ($("ghKeepSignedIn")) $("ghKeepSignedIn").checked = !!(state.settings && state.settings.ghKeepSignedIn);
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
    try { renderDashStrip(); } catch (e) {}
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

// After Stop, re-read the run state a few times until the background reports
// it has finished, then repaint (Run buttons re-enable).
async function pollUntilStopped() {
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 700));
    let st = null;
    try { st = await send({ type: "GET_STATE" }); } catch (e) {}
    if (st && !st.running) break;
  }
  await load();
}

$("optStopAll").onclick = async () => {
  const stop = $("optStopAll");
  stop.disabled = true;
  stop.textContent = "Stopping…";
  try {
    await send({ type: "RUN_CANCEL" });
  } catch (e) {}
  // The background now always ends the run within about a second of Stop;
  // keep checking until it confirms, so Run all comes back by itself.
  pollUntilStopped();
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
  // Tests use the slider's current position, so a change is audible before Save.
  const vol = () => Number(($("notifyVolume") || {}).value) || 100;
  if (btn) btn.onclick = () => send({ type: "PLAY_TEST_SOUND", volume: vol() }).catch(() => {});
  const dbtn = $("notifyDangerTest");
  if (dbtn) dbtn.onclick = () => send({ type: "PLAY_TEST_SOUND", sound: "danger", volume: vol() }).catch(() => {});
  const vs = $("notifyVolume");
  if (vs) {
    vs.oninput = () => { $("notifyVolumeVal").textContent = vs.value + "%"; };
    // Letting go of the slider saves it and plays a short sample at that level.
    vs.onchange = () => {
      send({ type: "SET_SETTINGS", patch: { notifyVolume: Number(vs.value) } }).catch(() => {});
      send({ type: "PLAY_TEST_SOUND", volume: Number(vs.value) }).catch(() => {});
    };
  }
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
        ...($("notifyVolume") ? { notifyVolume: Number($("notifyVolume").value) || 100 } : {}),
        slowNetwork: $("slowNetwork").checked,
        ghKeepSignedIn: !!($("ghKeepSignedIn") && $("ghKeepSignedIn").checked),
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
  cuLastPaintSig = ""; // a postponed redraw must really redraw
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
  const timer = setTimeout(() => { cuEstPendingOpt.delete(id); cuLastPaintSig = ""; scheduleClickupUiRefresh(0); }, 120000);
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
  cuLastPaintSig = ""; // clear the row's syncing spinner even if nothing else changed
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
  if (!t || t.local) return; // a draft (local-tasks.js) isn't in ClickUp
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
  // A day plan applied from Insights > Plan keeps the plan's order (plan-apply.js).
  if (a && b && a._planIdx != null && b._planIdx != null) return a._planIdx - b._planIdx;
  // Pinned tasks (task-notes.js) first.
  const pa = !!(window.PcmTaskNotes && a && window.PcmTaskNotes.isPinned(a.id)), pb = !!(window.PcmTaskNotes && b && window.PcmTaskNotes.isPinned(b.id));
  if (pa !== pb) return pa ? -1 : 1;
  return cuPrioRank(a) - cuPrioRank(b) ||
    (Number(b.estimateMs != null ? b.estimateMs : b.dayEstimateMs) || 0) - (Number(a.estimateMs != null ? a.estimateMs : a.dayEstimateMs) || 0) ||
    // Same priority and same estimate: fall back to the name, read the way a
    // person would (ACT-025.S1 before ACT-025.S3), instead of ClickUp's order.
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
}
// Stable identity for a task row. Regular tasks carry `.id`; deadline/configured
// tasks carry `.taskId`. This is the key used for manual (drag) ordering.
function cuId(t) {
  return String(t && (t.id != null ? t.id : t.taskId));
}
// Comparator for the user's custom drag order: tasks appear in the exact order
// their ids sit in `orderIds`. Ids not in the list (e.g. a task added since the
// last arrange) sink to the bottom, where they fall back to the normal priority
// order so they stay sensible until the user drags them into place.
function cuManualCmp(orderIds) {
  const rank = new Map();
  const list = Array.isArray(orderIds) ? orderIds : [];
  for (let i = 0; i < list.length; i++) rank.set(String(list[i]), i);
  return (a, b) => {
    const ra = rank.has(cuId(a)) ? rank.get(cuId(a)) : Infinity;
    const rb = rank.has(cuId(b)) ? rank.get(cuId(b)) : Infinity;
    if (ra !== rb) return ra - rb;
    return cuPrioCmp(a, b);
  };
}
function sortByPriority(rows, orderIds) {
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
  // A custom drag order (when supplied) replaces the priority order for the
  // top level only; subtasks always trail their parent in their own order.
  const cmp = Array.isArray(orderIds) ? cuManualCmp(orderIds) : cuPrioCmp;
  top.sort(cmp);
  const out = [];
  for (const p of top) {
    out.push(p);
    const s = subs.get(idOf(p));
    // Grouped view: keep ClickUp's own order (S1, S2, S3…) rather than
    // re-sorting the breakdown by priority.
    if (s) out.push(...(cuFilter.groupSubtasks ? s : s.slice().sort(cuPrioCmp)));
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
  if (!w) return span;
  const b = Array.isArray(w.blockers) ? w.blockers : [];
  const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (b.length) {
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
    span.title = (late ? "Blocked by someone else's overdue subtask" : "Your part is done - waiting on someone else") + ":\n" +
      b.map((x) => "\u2022 " + x.name + " \u00B7 " + x.who + (x.due ? " \u00B7 due " + fmt(x.due) : "") + (x.overdue ? " (overdue)" : "")).join("\n") +
      "\nClick to open it in ClickUp.";
    span.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.open(b[0].url, "_blank", "noopener"); });
    return span;
  }
  // Idea A - the task's OWN open subtasks keep it from closing: they're due after
  // this task's due date, or the task is already past due with open subtasks left.
  const sb = w.selfBlock;
  if (sb && (sb.later || sb.parentOverdue)) {
    const late = !!sb.parentOverdue;
    span.classList.add("on", late ? "late" : "waiting");
    const icon = document.createElement("span");
    icon.className = "wi";
    icon.textContent = "\u23F3";
    const label = document.createElement("span");
    label.className = "wl";
    label.textContent = late ? "Blocked: subtasks open" : (sb.latestDueMs ? "Subtasks to " + fmt(sb.latestDueMs) : "Subtasks open");
    span.appendChild(icon);
    span.appendChild(label);
    span.title = (late
      ? "This task is past its due date but still has open subtasks"
      : "This task can't close yet - it has open subtasks due after its own due date") + ":\n" +
      "\u2022 " + sb.open + " open subtask" + (sb.open > 1 ? "s" : "") +
      (sb.later ? ", " + sb.later + " due after this task" : "") +
      (sb.latestDueMs ? "\n\u2022 latest subtask due " + fmt(sb.latestDueMs) : "") +
      "\nOpen the task in ClickUp to see them.";
    const url = t && t.url;
    if (url) span.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); window.open(url, "_blank", "noopener"); });
    return span;
  }
  return span;
}
// Time cell: "tracked / est". Tracked turns red past the estimate; a running
// timer gets a dot. Called right after the tracked text is set. `spans` is the
// row's .estpairs box: when the task was also worked on another day, a small
// "31m today" pill goes in there after the pair, so a multi-day figure can't be
// mistaken for today's work. The pill is ordered last (.trk is order 1, .est
// order 3) instead of landing between the two numbers.
function markTrk(trk, t, spans) {
  const spent = Number(t && t.spentMs) || 0;
  const est = Number(t && (t.estimateMs != null ? t.estimateMs : t.dayEstimateMs)) || 0;
  if (est > 0 && spent > est) trk.classList.add("over");
  const st = (optClickup && optClickup.state) || null;
  const run = st && st.running;
  const id = t && (t.id != null ? t.id : t.taskId);
  if (spans) {
    const todayMs = cuTrkTodayMs(st, t, spent, cuRunPrior, Date.now());
    if (todayMs > 0) {
      const pill = document.createElement("span");
      pill.className = "trk-today";
      pill.style.order = "4";
      pill.textContent = fmtDurOpt(todayMs) + " today";
      pill.title = CU_TRK_TODAY_TIP;
      spans.appendChild(pill);
    }
  }
  if (run && id != null && String(run.taskId) === String(id)) {
    trk.classList.add("running");
    liveTrk(trk, t, st, run, est, fmtDurOpt);
  }
}
// The running task's tracked time is a snapshot from when its list was last built
// (the week lists are rebuilt about hourly to spare ClickUp's rate limit), so add
// the time since that snapshot and keep counting here - no extra ClickUp calls.
function liveTrk(trk, t, st, run, est, fmt) {
  let at = 0;
  for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) {
    if (b && ["tasks", "deadlineTasks", "trackedTasks"].some((k) => Array.isArray(b[k]) && b[k].includes(t))) { at = Number(b.at) || 0; break; }
  }
  if (!at) at = Number(st.at) || Date.now();
  trk.dataset.liveBase = String(Number(t.spentMs) || 0);
  trk.dataset.liveFrom = String(Math.max(Number(run.startMs) || 0, at));
  trk.dataset.liveEst = String(est || 0);
  const paint = () => {
    if (!trk.isConnected) return false;
    const ms = Number(trk.dataset.liveBase) + Math.max(0, Date.now() - Number(trk.dataset.liveFrom));
    trk.textContent = fmt(ms);
    const e = Number(trk.dataset.liveEst);
    trk.classList.toggle("over", e > 0 && ms > e);
    return true;
  };
  paint();
  const iv = setInterval(() => { if (!paint()) clearInterval(iv); }, 20000);
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
      priority: t.priority || "",
      // The on-screen "Waiting: Name" chip, so an export can explain the hold-up.
      waitingOn: (() => { const w = cuWaitFor(t); const b = (w && w.blockers) || []; return b.length ? { who: [...new Set(b.map((x) => x.who).filter(Boolean))].join(", "), overdue: b.some((x) => x.overdue), what: b[0] && b[0].name } : null; })(),
      dueDateMs: Number(t.dueDateMs) || null,
      estimateMs: Number(t.totalEstimateMs || t.estimateMs || t.dayEstimateMs) || 0,
      spentMs: Number(t.spentMs) || 0,
      status: t.status || "",
      done: !!t.done,
      url: t.url || "",
    });
  }
  // Returned, not stored: the Tasks card and Explore tasks each keep their own
  // copy. (Sharing one variable let an Explore refresh replace what the Tasks
  // card's Export sent - a "Due this week" export came out as Explore's "Today".)
  return { rows, title: scope || "tasks" };
}

// ---------- due date: click the chip to set / change / clear it ----------
// The calendar that opens is the extension's own (calendar.js): it shows the
// company holidays, the work-from-home days and how many tasks are already due
// on each day, so a date can be chosen for a reason instead of guessed. The
// browser's plain date box is only used if that calendar isn't loaded.
function startEditDueOpt(chip, task) {
  if (chip._editing) return;
  const taskId = task.id || task.taskId;
  if (!taskId) return;
  chip._editing = true;
  const prevText = chip.textContent;
  const prevClass = chip.className;
  const prevTitle = chip.title;
  const ms = Number(task.dueDateMs) || 0;
  let done = false;
  let saving = false;
  const finish = (text, cls, title) => {
    if (done) return;
    done = true;
    chip.textContent = text;
    chip.className = cls;
    chip.title = title;
    chip.style.boxShadow = "";
    chip._editing = false;
    cuEstEditingOpt = false;
    flushDeferredRenderOpt();
  };
  const cancel = () => finish(prevText, prevClass, prevTitle);
  // The time of day the task already had is kept, so only the day changes; a
  // task that had no due date gets midday.
  const atMs = (dayMs) => {
    if (!dayMs) return null;
    const d = new Date(dayMs);
    const keep = ms ? new Date(ms) : null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), keep ? keep.getHours() : 12, keep ? keep.getMinutes() : 0, 0, 0).getTime();
  };
  const save = async (newMs) => {
    if (done || saving) return;
    saving = true;
    if ((newMs || 0) === ms) { cancel(); return; }
    chip.style.boxShadow = "";
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
  if (window.PcmCalendar && typeof window.PcmCalendar.pick === "function") {
    // pick() first: it closes any calendar already open, whose cancel would
    // otherwise clear the redraw guard set for THIS chip.
    window.PcmCalendar.pick(chip, {
      value: ms,
      canClear: ms > 0,
      onPick: (dayMs) => save(atMs(dayMs)),
      onClose: cancel,
    });
    cuEstEditingOpt = true; // a background redraw would take the chip away mid-pick
    chip.style.boxShadow = "0 0 0 2px var(--indigo, #6366f1)";
    chip.title = "Pick the new due date in the calendar. Esc = keep this one.";
    return;
  }
  const input = document.createElement("input");
  input.type = "date";
  input.className = "due-input";
  input.title = "Pick a date to save it, or type it and press Enter. Esc = cancel. Clear = no due date.";
  if (ms) {
    const d = new Date(ms);
    input.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  chip.textContent = "";
  chip.appendChild(input);
  input.focus();
  try { input.showPicker(); } catch (e) {}
  const saveInput = () => {
    const v = input.value;
    let day = null;
    if (v) { const [y, m, d] = v.split("-").map(Number); day = new Date(y, m - 1, d).getTime(); }
    input.disabled = true;
    save(atMs(day));
  };
  input.addEventListener("blur", saveInput);
  // A date picked in the calendar (or its Clear button) saves at once. Typing
  // also fires change after each part of the date, so a change that follows a
  // keystroke waits for Enter / leaving the box instead of saving half-typed.
  let lastKeyAt = 0;
  input.addEventListener("keydown", () => { lastKeyAt = Date.now(); });
  input.addEventListener("change", () => { if (Date.now() - lastKeyAt > 400) saveInput(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); saveInput(); }
    else if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", saveInput); cancel(); }
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

// Who a task is assigned to: initials in coloured circles, full name on hover.
// Two assignees overlap as two circles; three or more show the first plus a
// "+N" circle whose hover lists the rest. Every row gets the same fixed-width
// slot (0, 1 or many people) so the columns never shift. A person keeps the
// same colour everywhere (hue from their ClickUp id).
function cuInitials(name) {
  const s = String(name || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  const w = s.split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}
function cuAvatarColor(key) {
  let h = 0;
  for (const ch of String(key || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return "hsl(" + (h % 360) + ", 55%, 42%)";
}
function whoSlot(t) {
  const slot = document.createElement("span");
  slot.className = "cu-who";
  const list = (Array.isArray(t && t.assignees) ? t.assignees : []).filter((a) => a && (a.username || a.id));
  const circle = (text, title, bg, extra) => {
    const c = document.createElement("span");
    c.className = "av" + (extra ? " " + extra : "");
    c.textContent = text;
    c.title = title;
    if (bg) c.style.background = bg;
    slot.appendChild(c);
  };
  const nameOf = (a) => a.username || ("User " + a.id);
  const shown = list.length > 2 ? list.slice(0, 1) : list;
  for (const a of shown) circle(cuInitials(a.username), nameOf(a), cuAvatarColor(a.id || a.username));
  if (list.length > 2) circle("+" + (list.length - 1), list.slice(1).map(nameOf).join(", "), "", "more");
  return slot;
}

// A bar under each task list: click it to show every task or go back to the
// normal height, drag it to pick any height in between. The chosen height is
// remembered per list. The normal cap on the list's height is lifted the moment
// it is opened or dragged, so it can grow past it.
// Height of a list's rows (plus its bottom padding/border), independent of how
// tall the box is stretched. 0 when it can't be measured (hidden page).
function listContentHeight(el) {
  const last = el && el.lastElementChild;
  if (!last) return 0;
  const r = el.getBoundingClientRect(), lr = last.getBoundingClientRect();
  if (!r.height && !lr.height) return 0;
  const cs = getComputedStyle(el);
  return Math.ceil(lr.bottom - r.top + el.scrollTop + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0));
}
function capListToContent(el) {
  // Only lists the user has resized: an untouched list keeps its CSS default.
  if (!el.style.height) return;
  const h = listContentHeight(el);
  if (h > 0) el.style.maxHeight = h + "px";
}
// Keep the page still while the task lists are rebuilt.
// Rebuilding empties their boxes for an instant (every refresh, every timer
// action, and once a minute while the dashboard is open). The page gets shorter,
// the browser pulls the scroll position up to fit, and you end up back near the
// top while you were reading a task. Noting the position and putting it back
// afterwards can't fix that on its own: by then the remembered position has
// already been overwritten with the pulled-up one.
// So the containers hold their height while the rows are swapped, every
// stretched list is given its FINAL height in the same go (they used to shrink
// to their rows a tick later, which moved the page again - the stretch bar
// "closing by itself"), and the scroll position is put back before the page is
// painted, so none of it is ever visible.
function keepPageStill(rebuild) {
  const pins = [];
  for (const el of [$("dashTasks"), $("cuPreview")]) {
    const h = el ? el.offsetHeight : 0;
    if (h > 0) { el.style.minHeight = h + "px"; pins.push({ el, h }); }
  }
  const x = window.scrollX || 0, y = window.scrollY || 0;
  try {
    rebuild();
  } finally {
    document.querySelectorAll(".cu-tasklist.cu-resizable").forEach(capListToContent);
    // The rows are in, but the other scripts dress them a moment later (tick
    // boxes, avatars, the add-time link), so a list measured right now can come
    // out a little short and grow again on the next tick. Letting go of the
    // heights at that exact moment is what still cost the last few pixels of
    // scroll: the page was briefly shorter than it ended up being, and the
    // browser had already pulled the view up by then. So each box is only
    // released once it is back to the height it had - and after a second at the
    // latest, in case the list really did get shorter (fewer tasks). While a box
    // is held the page can only be too tall, never too short, so nothing moves.
    const until = Date.now() + 1000;
    const release = () => {
      let holding = false;
      for (const p of pins) {
        if (p.done) continue;
        if (!p.el.isConnected) { p.done = true; continue; }
        p.el.style.minHeight = "";
        if (Date.now() < until && p.el.offsetHeight < p.h - 1) { p.el.style.minHeight = p.h + "px"; holding = true; }
        else p.done = true;
      }
      if (holding) setTimeout(release, 50);
    };
    release();
    if (Math.abs((window.scrollY || 0) - y) > 1) window.scrollTo(x, y);
  }
}
function makeListResizable(el, key) {
  if (!el || el._pcmResizable) return;
  el._pcmResizable = true;
  el.classList.add("cu-resizable");
  const store = "pcm.listH." + key;
  // "Show every task" is a MODE, not a height: the list grows with whatever is
  // in it (an opened task's details, notes, more rows after a refresh). A fixed
  // height taken at click time brought the scroll bar straight back the moment
  // anything inside got taller. A height you DRAG to is still remembered as px.
  let saved = 0, all = false;
  try { const v = localStorage.getItem(store); all = v === "all"; saved = Number(v) || 0; } catch (e) {}
  if (all) { el.dataset.all = "1"; el.style.maxHeight = "none"; }
  else if (saved > 40) { el.style.height = saved + "px"; el.style.maxHeight = "none"; }
  // Never let the list be taller than its rows: with fewer tasks than the saved
  // height it shrinks to fit, and dragging stops at the last task. Re-measured
  // whenever the rows change (the popup refills the same list on every refresh).
  // Measured at once (this runs right after the rows are in, still before the
  // page is painted, so the box never flashes at its old height and the page
  // never moves), and again on the next tick in case the rows arrive in batches.
  // A timer, not requestAnimationFrame: rAF never fires while the page is hidden.
  const recap = () => { capListToContent(el); setTimeout(() => capListToContent(el), 0); };
  recap();
  new MutationObserver(recap).observe(el, { childList: true });
  const save = () => {
    if (!el.style.height || !el.isConnected || !el.offsetHeight) return; // only after the user resized it
    try { localStorage.setItem(store, String(el.offsetHeight)); } catch (e) {}
  };
  // A full-width bar UNDER the list (the browser's own corner handle sat on top
  // of the last row's buttons and was hard to grab). Click it to show every task
  // or go back to the normal height; drag it to pick any height in between.
  // It's placed next to the list once the list is in the page.
  const grip = document.createElement("div");
  grip.className = "cu-grip";
  grip.setAttribute("role", "separator");
  grip.setAttribute("aria-orientation", "horizontal");
  grip.tabIndex = 0;
  const lab = document.createElement("span");
  lab.className = "cu-griplab";
  grip.appendChild(lab);
  let sayTimer = 0;
  const say = (text, ms) => {
    lab.textContent = text || "";
    clearTimeout(sayTimer);
    if (text && ms) sayTimer = setTimeout(() => { if (lab.textContent === text) lab.textContent = ""; }, ms);
  };
  const stretched = () => !!el.style.height || el.dataset.all === "1";
  const retitle = () => {
    const t = stretched()
      ? "Click to go back to the normal height \u00b7 or drag to set your own"
      : "Click to show every task \u00b7 or drag to set your own height";
    grip.title = t;
    grip.setAttribute("aria-label", t);
  };
  retitle();
  const collapse = () => {
    delete el.dataset.all;
    el.style.height = "";
    el.style.maxHeight = "";
    try { localStorage.removeItem(store); } catch (e) {}
    retitle();
    say("Normal height", 1200);
  };
  // Expanding needs the height of the rows, and that can't be measured while the
  // page is hidden or before the rows are in - exactly the moments a click used
  // to do nothing at all, so the list only ever opened after enough random
  // clicking that one of them landed on a ready list. Now the bar says it's
  // loading and keeps measuring, so one click is always enough.
  let waiting = 0;
  const expand = (tries) => {
    const h = listContentHeight(el);
    if (h > 0) {
      clearTimeout(waiting); waiting = 0;
      grip.classList.remove("busy");
      // Even when everything fits right now: an opened task or a refresh with
      // more rows must not bring a scroll bar back, which is what this mode is for.
      el.dataset.all = "1";
      el.style.height = "";
      el.style.maxHeight = "none";
      try { localStorage.setItem(store, "all"); } catch (e) {}
      retitle();
      say("Showing every task", 1200);
      return;
    }
    if (tries <= 0) {
      grip.classList.remove("busy");
      say("Nothing to show yet", 1600);
      return;
    }
    grip.classList.add("busy");
    say("Loading the list\u2026", 0);
    clearTimeout(waiting);
    waiting = setTimeout(() => expand(tries - 1), 200);
  };
  const toggle = () => { if (stretched()) collapse(); else expand(10); };
  const place = () => { if (el.isConnected && grip.previousElementSibling !== el) el.after(grip); };
  setTimeout(place, 0);
  new MutationObserver(place).observe(el, { childList: true });
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startT = Date.now();
    const startH = el.getBoundingClientRect().height;
    const maxH = listContentHeight(el) || Infinity;
    let moved = 0;
    grip.classList.add("active");
    try { grip.setPointerCapture(e.pointerId); } catch (e2) {}
    const move = (ev) => {
      const dy = ev.clientY - startY;
      moved = Math.max(moved, Math.abs(dy));
      if (moved < 4) return; // a click wobbles a pixel or two: that's not a drag
      delete el.dataset.all; // dragging sets your own height instead of "every task"
      el.style.maxHeight = "none"; // lift the normal cap only once it IS a drag
      el.style.height = Math.round(Math.max(60, Math.min(maxH, startH + dy))) + "px";
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.classList.remove("active");
      // A press that didn't go anywhere is a CLICK, and a click opens or closes
      // the list in one go - the whole point of the bar for anyone who doesn't
      // realise it can be dragged.
      if (moved < 4 && Date.now() - startT < 400) { toggle(); return; }
      capListToContent(el);
      save();
      retitle();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up, { once: true });
    grip.addEventListener("pointercancel", up, { once: true });
  });
  grip.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    toggle();
  });
}

function appendNameCellOpt(row, nm, t) {
  // ▸ opens the task details dropdown (task-panel.js).
  if (window.PcmTaskPanel) row.appendChild(PcmTaskPanel.chevron(t));
  row.appendChild(prioBadge(t));
  // Every task row passes through here, so it's also where the row learns its
  // task object - the delegated estimate editor reads it back (row._cuTask).
  row._cuTask = t;
  row.classList.toggle("cu-done", !!(t && t.done)); // finished: green tint + edge, name greyed
  const client = t && t.client ? String(t.client) : "";
  const due = dueChipOpt(t);
  const wrap = document.createElement("span");
  wrap.className = "nmwrap";
  wrap.appendChild(nm);
  wrap.appendChild(whoSlot(t));
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
// What a row says while ClickUp answers (spinner + words), so a slow reply never
// looks like a broken button. After 6 seconds it says ClickUp is slow.
const cuRowBusyActOpt = {};
function cuBusyLine(tid) {
  const b = cuRowBusyActOpt[tid] || {};
  const verb = { start: "Starting", stop: "Stopping", complete: "Completing" }[b.action] || "Working";
  const line = document.createElement("div");
  line.className = "cu-rowmsg cu-rowbusy";
  const spin = document.createElement("span");
  spin.className = "cu-spin";
  const txt = document.createElement("span");
  txt.className = "cu-rowmsg-txt";
  txt.textContent = Date.now() - (b.at || Date.now()) > 6000
    ? "ClickUp is slow to answer - still working\u2026"
    : verb + "\u2026 waiting for ClickUp";
  line.append(spin, txt);
  return line;
}
function cuSpinIcon() { const s = document.createElement("span"); s.className = "cu-spin"; return s; }

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
  if (btn) { btn.disabled = true; btn.textContent = action === "stop" ? "Stopping…" : "Starting…"; }
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
  const cu = optClickup || {};
  if (!cu.configured) return;
  if (t.done) {
    // Completed: no live controls - a "✓ Done" badge in their place instead, in
    // the same fixed-width column (so the chips and times stay lined up, and a
    // long task name can never push it out of sight).
    const ghost = document.createElement("span");
    ghost.className = "cu-actions cu-done-cell";
    for (let i = 0; i < 2; i++) {
      const g = document.createElement("span");
      g.className = "cu-iconbtn";
      g.setAttribute("aria-hidden", "true");
      ghost.appendChild(g);
    }
    const pill = document.createElement("span");
    pill.className = "cu-done-pill";
    pill.textContent = "✓ Done";
    pill.title = "Completed in ClickUp";
    ghost.appendChild(pill);
    row.appendChild(ghost);
    return;
  }
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
    stop.textContent = busy ? "" : "⏸";
    if (busy) stop.appendChild(cuSpinIcon());
    stop.disabled = busy;
    stop.onclick = () => sendTaskActionOpt(tid, "stop");
    actions.appendChild(stop);
  } else {
    const start = document.createElement("button");
    start.className = "cu-iconbtn start";
    start.title = "Start · set to “in progress” and start the timer";
    start.textContent = busy ? "" : "▶";
    if (busy) start.appendChild(cuSpinIcon());
    start.disabled = busy;
    start.onclick = () => sendTaskActionOpt(tid, "start");
    // More than one assignee: the ▶ turns amber and its hover warns who else is
    // on it, but a click still starts it (in progress + your own timer).
    const who = Array.isArray(t.assignees) ? t.assignees : [];
    if (who.length > 1 && !busy) {
      const names = who.map((a) => a && a.username).filter(Boolean);
      start.className = "cu-iconbtn start multi";
      start.title = "⚠ Multiple users assigned: " + who.length + " people" + (names.length ? " (" + names.join(", ") + ")" : "") +
        ".\nStarting sets it “in progress” for everyone and starts your own timer. Click to start anyway.";
    }
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
    row.classList.add("has-msg");
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
  } else if (busy) {
    row.classList.add("has-msg");
    row.appendChild(cuBusyLine(tid));
  } else if (cuRowMsgOpt[tid]) {
    row.classList.add("has-msg");
    row.appendChild(cuRowNotice(cuRowMsgOpt[tid], () => { delete cuRowMsgOpt[tid]; repaintCuTaskRows(); }));
  }
}

// One tidy line under a task row: the message, an optional "Open in ClickUp"
// link and a x to dismiss. The row gets `has-msg` so it wraps and the notice
// sits on its own line instead of squeezing the task name to "ACT-...".
function cuRowNotice(m, onDismiss) {
  const box = document.createElement("div");
  box.className = "cu-rowmsg";
  const txt = document.createElement("span");
  txt.className = "cu-rowmsg-txt";
  txt.textContent = typeof m === "string" ? m : ((m && m.text) || "");
  box.appendChild(txt);
  if (m && m.url) {
    const a = document.createElement("a");
    a.href = m.url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open in ClickUp";
    box.appendChild(a);
  }
  const x = document.createElement("button");
  x.type = "button";
  x.className = "cu-rowmsg-x";
  x.title = "Dismiss";
  x.textContent = "×";
  x.onclick = (e) => { e.stopPropagation(); onDismiss(); };
  box.appendChild(x);
  return box;
}

// Fire a per-task Start/Stop/Complete action from the options page, then repaint.
// 20s timeout (the background does the ClickUp write THEN a today+tasks refresh
// before replying). Errors surface inline on the row via cuRowMsgOpt.
async function sendTaskActionOpt(taskId, action, force) {
  const tid = String(taskId);
  if (cuRowBusyOpt.has(tid)) return;
  cuRowBusyOpt.add(tid);
  cuRowBusyActOpt[tid] = { action, at: Date.now() };
  delete cuRowMsgOpt[tid];
  delete cuRowConfirmOpt[tid];
  repaintCuTaskRows(); // repaint so the clicked row shows its "Starting… waiting for ClickUp" line
  setTimeout(() => { if (cuRowBusyOpt.has(tid)) repaintCuTaskRows(); }, 6500); // switch to "ClickUp is slow"
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
      {
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
  $("cuMultiDay") && ($("cuMultiDay").value = cu.multiDay === "days" || cu.multiDay === "excl0" ? cu.multiDay : "due");
  paintMultiDayExample();
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
      link.textContent = extra.name;
      const stEl = $("cuAutoExtraStatus");
      if (stEl) { stEl.textContent = extra.status || ""; stEl.hidden = !extra.status; }
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
      // Never an empty space: say whether it's still looking, couldn't look this
      // time, or really found nothing - and what to do about the last one.
      const hint = autoNote.querySelector(".hint") || autoNote;
      hint.textContent = !cu.state
        ? "Looking for your Extra task…"
        : cu.state.extraLookup === "failed"
          ? "Couldn't check for your Extra task just now (ClickUp was busy) - it tries again on the next refresh."
          : "No Extra task found for this week. It's found by its name - something like \"Extra Tasks - " + ((cu.user && cu.user.username) || "Your Name") + "\", assigned to you, with this week's dates. Or paste its link in ClickUp setup › Configured tasks.";
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
  if ($("cuExtraAutoClose")) $("cuExtraAutoClose").checked = cu.extraAutoClose !== false;
  $("cuWrapUpTime").value = cu.wrapUpTime || "16:45";
  $("cuTidyNotify").checked = cu.tidyNotify !== false;
  $("cuTidyTime").value = cu.tidyTime || "14:00";
  $("cuTidyDays").value = cu.tidyDays || "weekdays";
  $("cuTidyMax").value = cu.tidyMax != null ? String(cu.tidyMax) : "3";
  $("cuTidyResolved").checked = cu.tidyResolved !== false;
  var tc = cu.tidyCats || {};
  $("cuTidyCatOverdue").checked = tc.overdue !== false;
  $("cuTidyCatNoEst").checked = tc.noEst !== false;
  $("cuTidyCatNoDue").checked = tc.noDue !== false;
  $("cuTidyCatBlocked").checked = tc.blocked !== false;
  if ($("cuTidyDaysRow")) $("cuTidyDaysRow").style.display = cu.tidyNotify === false ? "none" : "";
  if ($("cuTidyCatsRow")) $("cuTidyCatsRow").style.display = cu.tidyNotify === false ? "none" : "";
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

// Mon-Fri mini chart in the This week card: estimated (amber) vs tracked (blue)
// per day, a dashed line at the daily target, today highlighted. Uses the
// cached weekly.perDay - no extra ClickUp calls.
// Clicking a day in the weekly chart shows that day's tasks in the Tasks card
// (a one-day custom date filter, saved like any filter so the popup, side panel
// and badge follow), with a bar to go back to the previous filter.
let cuChartPrev = null, cuChartDay = "", cuChartSrc = "chart";
const cuYmd = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
function cuShowChartDay(ts, src) {
  const ymd = cuYmd(ts);
  cuChartSrc = src || "chart";
  if (!cuChartPrev) cuChartPrev = cuSnapshotFilter();
  const snap = cuSnapshotFilter();
  for (const k of ["dueToday", "dueTomorrow", "dueWeek", "dueNextWeek", "deadlineCrossed"]) snap[k] = false;
  snap.dueCustom = true; snap.customFrom = ymd; snap.customTo = ymd;
  cuChartDay = ymd;
  document.querySelectorAll("#optWeekChart .wk-day").forEach((c) => c.classList.remove("sel"));
  cuApplyFilterSnapshot(snap); // saved, so the popup, side panel and badge follow too
  document.querySelectorAll("#optWeekChart .wk-day[data-ymd=\"" + ymd + "\"]").forEach((c) => c.classList.add("sel"));
  const card = $("dashTasksCard");
  if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
}
function cuPaintChartBanner() {
  const card = $("dashTasksCard");
  if (!card) return;
  let bar = $("cuChartDayBar");
  const active = !!cuChartPrev && cuFilter.dueCustom && cuFilter.customFrom === cuChartDay && (cuFilter.customTo || cuChartDay) === cuChartDay;
  if (!active) {
    if (bar) bar.remove();
    cuChartPrev = null; cuChartDay = "";
    document.querySelectorAll("#optWeekChart .wk-day.sel").forEach((c) => c.classList.remove("sel"));
    return;
  }
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "cuChartDayBar";
    bar.className = "cu-chartday";
    const head = card.querySelector(".dash-h");
    if (head) head.after(bar); else card.prepend(bar);
  }
  bar.textContent = "";
  const d = new Date(cuChartDay + "T12:00:00");
  bar.append("\uD83D\uDCC5 Showing " + d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " (picked in the " + cuChartSrc + ")");
  bar.title = "The popup, side panel and toolbar badge show this day too. Back to my filter returns everywhere.";
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "\u2715 Back to my filter";
  back.onclick = () => { const prev = cuChartPrev; cuChartPrev = null; cuChartDay = ""; if (prev) cuApplyFilterSnapshot(prev); };
  bar.appendChild(back);
}
// Calendar (calendar.js): clicking a day lists that day's tasks, like the chart.
window.pcmPickDay = (ts) => cuShowChartDay(ts, "calendar");
// The worked example under ClickUp setup › Advanced › Multi-day tasks: highlight
// the row (and its explanation) of the option chosen in the dropdown.
function paintMultiDayExample() {
  const sel = $("cuMultiDay"), box = $("cuMultiDayEx");
  if (!sel || !box) return;
  box.querySelectorAll("[data-md]").forEach((el) => el.classList.toggle("on", el.getAttribute("data-md") === sel.value));
}
if ($("cuMultiDay")) $("cuMultiDay").addEventListener("change", paintMultiDayExample);
// Mon-Fri (the week's working days; a weekend day only shows when it has something).
function cuIsWorkday(ts) { const g = new Date(ts).getDay(); return g >= 1 && g <= 5; }
function renderWeekChartOpt(w, targetMs) {
  const box = $("optWeekChart");
  if (!box) return;
  const days = (Array.isArray(w && w.perDay) ? w.perDay : []).filter((d) => d && d.ts && (cuIsWorkday(d.ts) || Number(d.estimateMs) > 0 || Number(d.spentMs) > 0));
  if (!days.length) { box.hidden = true; box.textContent = ""; return; }
  const today = new Date().setHours(0, 0, 0, 0);
  const max = Math.max(targetMs, ...days.map((d) => Math.max(Number(d.estimateMs) || 0, Number(d.spentMs) || 0))) || 1;
  const pct = (v) => Math.min(100, Math.round(((Number(v) || 0) / max) * 100)) + "%";
  box.textContent = "";
  // One column per day actually drawn (5 on a plain Mon-Fri week, up to 7 when a
  // weekend day carries time) - the stylesheet's fixed 5 wrapped the extras.
  box.style.gridTemplateColumns = "repeat(" + days.length + ", 1fr)";
  for (const d of days) {
    const dayStart = new Date(d.ts).setHours(0, 0, 0, 0);
    const col = document.createElement("div");
    col.className = "wk-day" + (dayStart === today ? " today" : dayStart > today ? " future" : "");
    const est = Number(d.estimateMs) || 0, trk = Number(d.spentMs) || 0;
    // Hover card: day, estimated, tracked, and how that compares to the target.
    const tip = document.createElement("div");
    tip.className = "wk-tip";
    const tb = document.createElement("b");
    tb.textContent = new Date(d.ts).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    tip.appendChild(tb);
    const tipLine = (color, label, v) => {
      const row = document.createElement("div");
      const sw = document.createElement("i");
      sw.style.background = color;
      row.append(sw, label + " " + fmtDurOpt(v) + (targetMs > 0 ? "  \u00b7  " + Math.round((v / targetMs) * 100) + "%" : ""));
      tip.appendChild(row);
    };
    tipLine("var(--amber, #f5b400)", "Estimated", est);
    tipLine("var(--blue, #4d8ef7)", "Tracked", trk);
    col.appendChild(tip);
    col.style.setProperty("--i", days.indexOf(d));
    col.dataset.ymd = cuYmd(d.ts);
    col.classList.toggle("sel", cuChartDay === col.dataset.ymd);
    col.style.cursor = "pointer";
    col.onclick = () => cuShowChartDay(d.ts);
    const bars = document.createElement("div");
    bars.className = "wk-bars";
    if (targetMs > 0) {
      const t = document.createElement("div");
      t.className = "wk-target";
      t.style.bottom = pct(targetMs);
      bars.appendChild(t);
    }
    const e = document.createElement("div");
    e.className = "wk-bar est";
    e.style.height = pct(est);
    e.style.animationDelay = days.indexOf(d) * 70 + "ms"; // bars grow in one day after another
    const k = document.createElement("div");
    k.className = "wk-bar trk";
    k.style.height = pct(trk);
    k.style.animationDelay = days.indexOf(d) * 70 + 90 + "ms";
    bars.append(e, k);
    const lab = document.createElement("div");
    lab.className = "wk-lab";
    lab.textContent = new Date(d.ts).toLocaleDateString(undefined, { weekday: "short" });
    const val = document.createElement("div");
    val.className = "wk-val";
    // A future day is labelled with what it's estimated to take. Today and past
    // days are labelled with what was tracked - but when nothing is tracked yet
    // that read "0m" however many estimates were added, which looked like the
    // chart was stuck. Fall back to the estimate (amber, like the bar) instead.
    if (dayStart > today) {
      val.textContent = est ? fmtDurOpt(est) : "-";
    } else if (trk > 0 || !est) {
      val.textContent = fmtDurOpt(trk);
    } else {
      val.textContent = fmtDurOpt(est);
      val.style.color = "var(--amber, #f5b400)";
      val.title = "Estimated - nothing tracked yet";
    }
    col.append(bars, lab, val);
    box.appendChild(col);
  }
  const lg = document.createElement("div");
  lg.className = "wk-legend";
  lg.innerHTML = '<span><i style="background:color-mix(in srgb, var(--amber, #f5b400) 80%, transparent)"></i>Estimated</span><span><i style="background:var(--blue, #4d8ef7)"></i>Tracked</span>' +
    (targetMs > 0 ? '<span>- - Daily target</span>' : "");
  box.appendChild(lg);
  box.hidden = false;
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
    if ($("optWeekRange")) { $("optWeekRange").textContent = ""; $("optWeekRange").removeAttribute("title"); }
    const listBox0 = $("optWeekList");
    if (listBox0) { listBox0.style.display = "none"; listBox0.innerHTML = ""; }
    document.querySelectorAll("#optWeekToggle button").forEach((b) => (b.className = ""));
    return;
  }
  const to = cu.weeklyTo === "friday" ? "friday" : "today";
  const agg = to === "friday" ? w.friday : w.today;
  if (window.pcmCountTo) {
    window.pcmCountTo($("optWeekEst"), "optWeekEst", agg.estimateMs, fmtDurOpt);
    window.pcmCountTo($("optWeekTrk"), "optWeekTrk", agg.spentMs, fmtDurOpt);
  } else {
    $("optWeekEst").textContent = fmtDurOpt(agg.estimateMs);
    $("optWeekTrk").textContent = fmtDurOpt(agg.spentMs);
  }
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
  // Click either number: the tasks behind it (each task's share added up over these days).
  if (window.PcmBreakdown && PcmBreakdown.fromWeek) {
    const bd = () => PcmBreakdown.fromWeek(w, agg, to === "friday" ? "the whole week" : "this week so far", fmtDurOpt);
    PcmBreakdown.attach($("optWeekEst"), "est", bd);
    PcmBreakdown.attach($("optWeekTrk"), "trk", bd);
  }
  renderWeekChartOpt(w, Number(cu.state && cu.state.targetMs) || 0);
  // When the week was last rebuilt. The card paints from persisted state, which
  // the background only recomputes every ~30 min (and skips while rate-limited),
  // so without this a snapshot that's merely old looked like a chart that had
  // stopped updating. Hit ↻ on the Tasks card to rebuild it now.
  {
    const stamp = $("optWeekRange");
    const at = Number(w.at) || 0;
    if (stamp) {
      if (!at) { stamp.textContent = ""; stamp.removeAttribute("title"); }
      else {
        const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
        stamp.textContent = "Updated " + (mins < 1 ? "just now" : mins < 60 ? mins + "m ago" : new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
        stamp.title = "This week was last rebuilt at " + new Date(at).toLocaleString() +
          (mins >= 35 ? "\nIt's older than the 30-minute refresh window - use ↻ on the Tasks card to rebuild it now." : "");
      }
    }
  }
  const fromD = new Date(agg.fromTs);
  const toD = new Date(agg.toTs);
  const n = agg.count || 0;
  $("optWeekSub").textContent =
    "Accumulated " + fromD.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " → " + toD.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + n + (n === 1 ? " working day" : " working days");
  // How multi-day tasks count (same setting as ClickUp setup › Advanced) - flip it here to compare.
  const modeBox = $("optWeekMode");
  if (modeBox) {
    const md = cu.multiDay === "days" || cu.multiDay === "excl0" ? cu.multiDay : "due";
    modeBox.innerHTML = '<span>Multi-day tasks:</span><span class="opt-toggle sm"><button type="button" data-md="due" class="' + (md === "due" ? "on" : "") + '" title="A task\'s whole estimate counts on its due date">By due date</button><button type="button" data-md="days" class="' + (md !== "due" ? "on" : "") + '" title="A task\'s estimate is divided over the working days it covers (start to due)">Spread over days</button></span>';
    modeBox.querySelectorAll("[data-md]").forEach((b) => {
      b.onclick = async () => {
        const want = b.getAttribute("data-md");
        if ((want === "due") === (md === "due")) return;
        modeBox.querySelectorAll("button").forEach((x) => { x.disabled = true; });
        try { await send({ type: "CLICKUP_SET", patch: { clickupMultiDay: want } }); if ($("cuMultiDay")) $("cuMultiDay").value = want; } catch (e) {}
        setTimeout(() => load().catch(() => {}), 400);
      };
    });
  }
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
  const showDays = days.filter((d) => d.ts <= agg.toTs && (cuIsWorkday(d.ts) || Number(d.estimateMs) > 0 || Number(d.spentMs) > 0));
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
              trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t, spans);
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
            sec.innerHTML = "<b>" + cuOtherTrackedLabel("range") + "</b>";
            sec.title = CU_OTHER_TRACKED_TIP;
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
              est.className = "est" + (t.estimateMs ? "" : " zero");
              // the task's own estimate (shown only - not part of the period's total)
              est.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
              spans.appendChild(est);
              if (Number(t.spentMs) > 0) {
                const trk = document.createElement("span");
                trk.className = "trk";
                trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t, spans);
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
// ---- Explore "Pick people…": any mix of people, across departments ----
// Every different set of people is a fresh ClickUp query, so ticks are batched:
// the query runs once the ticking pauses or the menu closes (see
// schedulePeopleApply below), never once per tick.
let optFltPeople = [];
try {
  chrome.storage.local.get("optFltPeople").then((g) => {
    if (Array.isArray(g.optFltPeople)) { optFltPeople = g.optFltPeople.map(String); updatePeopleBtn(); }
  }).catch(() => {});
} catch (e) {}
// "Same task" (AND): show only tasks assigned to EVERY ticked person. Off = the
// default "either" (OR). ClickUp already returns all their tasks, so this only
// narrows what is shown - no extra requests.
let optFltPeopleAnd = false;
try { chrome.storage.local.get("optFltPeopleAnd").then((g) => { optFltPeopleAnd = !!g.optFltPeopleAnd; updatePeopleBtn(); }).catch(() => {}); } catch (e) {}
function savePeople() { chrome.storage.local.set({ optFltPeople, optFltPeopleAnd }).catch(() => {}); }
function peopleNameOf(id) {
  const m = (optDeptMembers || []).find((x) => String(x.id) === String(id));
  if (m) return m.name;
  for (const d of optDeptList || []) {
    const u = (d.users || []).find((x) => String(x.id) === String(id));
    if (u) return u.name;
  }
  return "User " + id;
}
function peopleLabel() {
  const names = optFltPeople.map((id) => String(peopleNameOf(id)).split(" ")[0]);
  const and = optFltPeopleAnd && names.length > 1;
  const who = names.length <= 3 ? names.join(and ? " & " : ", ") : names.length + " people";
  return who + (and ? " \u00b7 same task" : "");
}
function updatePeopleBtn() {
  const b = $("optFltPeopleBtn");
  if (!b) return;
  b.innerHTML = (optFltPeople.length ? escapeHtml(peopleLabel()) : "Choose people") + " &#9662;";
}
// A tick changes the selection at once (button label, count, saved). The ClickUp
// query runs a moment after the ticking stops, or as soon as the menu closes -
// so ticking three people quickly is one query, and closing the menu by clicking
// elsewhere never throws the ticks away (it used to: they only counted after a
// "Show tasks" press nobody knew they needed).
const PEOPLE_APPLY_DELAY_MS = 1200;
let optFltPeopleTimer = null;
let optFltPeopleQueried = null; // the selection the current results were built for
function peopleSig() { return optFltPeople.slice().sort().join(","); }
function applyPeopleIfChanged() {
  clearTimeout(optFltPeopleTimer);
  optFltPeopleTimer = null;
  const dept = $("optFltDept");
  if (!dept || dept.value !== "__pick__") return; // only while Pick people is chosen
  if (peopleSig() === optFltPeopleQueried) return; // nothing new to show
  renderOptionsFilter();
}
function schedulePeopleApply() {
  clearTimeout(optFltPeopleTimer);
  optFltPeopleTimer = setTimeout(applyPeopleIfChanged, PEOPLE_APPLY_DELAY_MS);
}
function closePeopleMenu() {
  const m = $("optFltPeopleMenu");
  if (!m || m.hidden) return;
  m.hidden = true;
  const b = $("optFltPeopleBtn");
  if (b) b.setAttribute("aria-expanded", "false");
  applyPeopleIfChanged(); // closing = done choosing: load now, don't wait
}
function openPeopleMenu() {
  const m = $("optFltPeopleMenu");
  if (!m) return;
  renderPeopleMenu();
  m.hidden = false;
  const s = m.querySelector(".psearch");
  if (s) s.focus();
  const b = $("optFltPeopleBtn");
  if (b) b.setAttribute("aria-expanded", "true");
}
function renderPeopleMenu() {
  const m = $("optFltPeopleMenu");
  if (!m) return;
  const groups = [];
  const inDept = new Set();
  for (const d of optDeptList || []) {
    const users = (d.users || []).filter((u) => u && u.id != null);
    if (!users.length) continue;
    users.forEach((u) => inDept.add(String(u.id)));
    groups.push({ name: d.name, users });
  }
  const rest = (optDeptMembers || []).filter((u) => u && u.id != null && !inDept.has(String(u.id)));
  if (rest.length) groups.push({ name: groups.length ? "Not in a department" : "Everyone", users: rest });
  m.innerHTML = "";
  if (!groups.length) {
    m.innerHTML = '<div class="grp">No people loaded yet</div><div style="font-size:12px;padding:4px">Open <b>General \u2192 Department Creator</b> and press <b>Refresh user list</b>.</div>';
    return;
  }
  const andLab = document.createElement("label");
  andLab.className = "and";
  andLab.title = "Off: tasks assigned to ANY ticked person. On: only tasks that EVERY ticked person is assigned to.";
  const andCb = document.createElement("input");
  andCb.type = "checkbox";
  andCb.checked = optFltPeopleAnd;
  andCb.onchange = () => {
    optFltPeopleAnd = andCb.checked;
    savePeople();
    updatePeopleBtn();
    renderOptionsFilter(); // same people, so the answer comes from the cache
  };
  andLab.appendChild(andCb);
  andLab.appendChild(document.createTextNode("Only tasks shared by everyone ticked"));
  m.appendChild(andLab);
  // Search: narrows the list as you type (any part of the name); a department
  // heading hides when none of its people match. Esc clears it.
  const search = document.createElement("input");
  search.type = "search";
  search.className = "psearch";
  search.placeholder = "Search people\u2026";
  search.setAttribute("aria-label", "Search people");
  m.appendChild(search);
  const none = document.createElement("div");
  none.className = "pnone";
  none.textContent = "No one matches";
  none.hidden = true;
  const count = document.createElement("span");
  count.className = "n";
  const paintCount = () => {
    const n = optFltPeople.length;
    count.textContent = n ? n + (n === 1 ? " person" : " people") + " \u00b7 tasks load as you tick" : "Tick anyone to see their tasks";
    andLab.classList.toggle("off", n < 2); // needs two or more people to mean anything
  };
  const setPicked = (id, on) => {
    const has = optFltPeople.includes(id);
    if (on && !has) optFltPeople.push(id);
    if (!on && has) optFltPeople = optFltPeople.filter((x) => x !== id);
  };
  for (const g of groups) {
    const h = document.createElement("div");
    h.className = "grp";
    h.textContent = g.name;
    m.appendChild(h);
    for (const u of g.users) {
      const id = String(u.id);
      const lab = document.createElement("label");
      lab.dataset.pname = String(u.name || "").toLowerCase();
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = optFltPeople.includes(id);
      cb.dataset.pid = id;
      cb.onchange = () => {
        setPicked(id, cb.checked);
        // The same person can sit in two departments: keep every copy in step.
        m.querySelectorAll('input[data-pid="' + CSS.escape(id) + '"]').forEach((x) => { x.checked = cb.checked; });
        savePeople();
        updatePeopleBtn();
        paintCount();
        schedulePeopleApply();
      };
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(u.name || ("User " + id)));
      m.appendChild(lab);
    }
  }
  m.appendChild(none);
  const applySearch = () => {
    const q = search.value.trim().toLowerCase();
    let heading = null, headingHasMatch = false, any = false;
    const closeHeading = () => { if (heading) heading.hidden = !headingHasMatch; };
    for (const el of m.children) {
      if (el.classList.contains("grp")) { closeHeading(); heading = el; headingHasMatch = false; continue; }
      if (el.dataset && el.dataset.pname != null) {
        const hit = !q || el.dataset.pname.includes(q);
        el.hidden = !hit;
        if (hit) { headingHasMatch = true; any = true; }
      }
    }
    closeHeading();
    none.hidden = any;
  };
  search.addEventListener("input", applySearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && search.value) { e.preventDefault(); e.stopPropagation(); search.value = ""; applySearch(); }
  });
  const foot = document.createElement("div");
  foot.className = "foot";
  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear";
  clear.onclick = (e) => {
    e.stopPropagation();
    optFltPeople = [];
    m.querySelectorAll("input[data-pid]").forEach((x) => { x.checked = false; });
    savePeople();
    updatePeopleBtn();
    paintCount();
    schedulePeopleApply();
  };
  const done = document.createElement("button");
  done.type = "button";
  done.className = "primary";
  done.textContent = "Done";
  done.onclick = (e) => { e.stopPropagation(); closePeopleMenu(); };
  paintCount();
  foot.appendChild(count);
  const btns = document.createElement("span");
  btns.style.display = "inline-flex";
  btns.style.gap = "6px";
  btns.appendChild(clear);
  btns.appendChild(done);
  foot.appendChild(btns);
  m.appendChild(foot);
}

// ---- Explore Client dropdown: every client, not just today's ----
// It used to list only the clients in the current results, so a narrow view
// (Today, just your own tasks) offered one or two clients. Now it is every client
// in the workspace (background CLICKUP_CLIENT_NAMES, cached a day) plus any
// extra name the current results carry. The chosen client is kept even when it
// has nothing in the current range - the list below simply comes up empty.
let optWorkspaceClients = [];
let optFltResultClients = [];
function fillClientSelect() {
  const sel = $("optFltClient");
  if (!sel) return "";
  const pick = sel.value;
  // One entry per client: names differing only by emoji, spacing or case are the
  // same client (the key canonicalizeClientLabels uses). The spelling your tasks
  // carry wins, because that is what the filter matches against.
  const key = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "") || String(n);
  const byKey = new Map();
  for (const n of [].concat(pick ? [pick] : [], optFltResultClients, optWorkspaceClients)) {
    if (n && !byKey.has(key(n))) byKey.set(key(n), n);
  }
  const names = [...byKey.values()].sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">All clients</option>' +
    names.map((n) => '<option value="' + escapeHtml(n) + '"' + (n === pick ? " selected" : "") + ">" + escapeHtml(n) + "</option>").join("");
  sel.value = pick;
  return pick;
}
async function loadWorkspaceClients() {
  try {
    const res = await send({ type: "CLICKUP_CLIENT_NAMES" }, 30000);
    if (res && Array.isArray(res.names)) { optWorkspaceClients = res.names; fillClientSelect(); }
  } catch (e) {}
}

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
    if (deptId === "__pick__") {
      // Hand-picked people, from any departments ("Pick people…").
      assigneeIds = optFltPeople.slice();
      optFltPeopleQueried = peopleSig();
      if (!assigneeIds.length) {
        box.innerHTML = '<div class="flt-tot">Tick at least one person under <b>People</b> - their tasks load as you tick.</div>';
        return;
      }
      scopeTag = " · " + peopleLabel();
    } else
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
    const d0 = fltRes.data;
    // "Same task" (AND): keep only rows whose assignees include every ticked
    // person, and recount the totals from what is left.
    const sameTask = deptId === "__pick__" && optFltPeopleAnd && assigneeIds.length > 1;
    const hasAll = (t) => {
      const ids = new Set((Array.isArray(t && t.assignees) ? t.assignees : []).map((a) => String(a && a.id)));
      return assigneeIds.every((id) => ids.has(String(id)));
    };
    const d = !sameTask ? d0 : (() => {
      const tk = (d0.tasks || []).filter(hasAll);
      const dl = (d0.deadlineTasks || []).filter(hasAll);
      const tr = (Array.isArray(d0.trackedTasks) ? d0.trackedTasks : []).filter(hasAll);
      const sum = (a, k) => a.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
      return { ...d0, tasks: tk, deadlineTasks: dl, trackedTasks: tr,
        estimateMs: sum(tk, "estimateMs") + sum(dl, "dayEstimateMs"),
        spentMs: sum(tk, "spentMs") + sum(dl, "spentMs") + sum(tr, "spentMs") };
    })();
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
    // "Due in this range only" (default on): drop multi-day tasks that are only
    // in progress here (due after the range) and show each task's FULL estimate
    // instead of the share that falls inside the range.
    // "Missing due date" asks for tasks WITHOUT a due date, so it wins over this.
    const dueOnly = !!($("optFltDueOnly") && $("optFltDueOnly").checked) && !flt.due;
    const rangeLo = new Date(fromTs).setHours(0, 0, 0, 0), rangeHi = new Date(toTs).setHours(23, 59, 59, 999);
    const dueInRange = (ms) => { const v = Number(ms) || 0; return v >= rangeLo && v <= rangeHi; };
    let shownTasks = tasks.filter(passTask);
    if (dueOnly) shownTasks = shownTasks.filter((t) => dueInRange(t.dueDateMs))
      .map((t) => (Number(t.totalEstimateMs) > 0 ? { ...t, estimateMs: Number(t.totalEstimateMs) } : t));
    let shownTracked = (Array.isArray(d.trackedTasks) ? d.trackedTasks : []).filter(passTask);
    let shownDeadline = deadline.filter((dt) => {
      if (dt.error) return false;
      if (dueOnly && dt.dueDateMs && !dueInRange(dt.dueDateMs)) return false;
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
      // Clients in this result (taken BEFORE the checkboxes, so a checkbox narrows
      // the rows, not the choices), merged with every client in the workspace.
      optFltResultClients = [...new Set([].concat(tasks, deadline, Array.isArray(d.trackedTasks) ? d.trackedTasks : [])
        .map((t) => String((t && t.client) || "").trim()).filter(Boolean))];
      clientPick = fillClientSelect();
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
    if (dueOnly && estShown == null) {
      // Totals follow the rows actually shown.
      estShown = shownTasks.reduce((x, t) => x + (Number(t.estimateMs) || 0), 0)
        + shownDeadline.reduce((x, t) => x + (Number(t.dayEstimateMs) || 0), 0);
      spentShown = [].concat(shownTasks, shownDeadline, shownTracked).reduce((x, t) => x + (Number(t.spentMs) || 0), 0);
    }
    shownTasks = cuGroupSubtaskRowsOpt(shownTasks);
    optFltExport = cuExportRowsOpt(shownTasks, shownDeadline, shownTracked, label + (clientPick ? " - " + clientPick : ""));
    const total = shownTasks.length + shownDeadline.length + shownTracked.length;
    const filterTags = active.map((k) => ({
      estimate: "missing estimates",
      start: "missing start date",
      due: "missing due date",
      incomplete: "incomplete",
      overdue: "deadline crossed",
      span: "start ≠ due",
    }[k] || k)).join(" · ");
    // Tracked time for someone ELSE can only be read with a workspace Admin API
    // token (ClickUp refuses the assignee filter otherwise). When that read was
    // refused, the number above is not "they tracked nothing" - it's unknown - so
    // say which of the two it is instead of letting "0m" speak for itself.
    const trackedHint = (d.trackedScoped === false)
      ? " <span class=\"hint\">· tracked time for other people needs a workspace <b>Admin API token</b> in Settings</span>"
      : "";
    box.innerHTML =
      '<div class="flt-tot"><b>' + label + "</b> · est <b>" + fmtDurOpt(estShown == null ? est : estShown) +
      "</b> · tracked <b>" + fmtDurOpt(spentShown == null ? spent : spentShown) + "</b>" +
      " · " + total + " task" + (total === 1 ? "" : "s") +
      (clientPick ? " <span class=\"hint\">· client: " + escapeHtml(clientPick) + "</span>" : "") +
      (active.length ? " <span class=\"hint\">(filter: " + filterTags + ")</span>" : "") +
      trackedHint + "</div>";
    const list = document.createElement("div");
    list.className = "cu-tasklist";
    makeListResizable(list, "explore");
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
        trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t, spans);
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
        trk.textContent = fmtDurOpt(dt.spentMs); markTrk(trk, dt, spans);
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
      sec.innerHTML = "<b>" + cuOtherTrackedLabel(type === "today" ? "today" : "range") + "</b>";
      sec.title = CU_OTHER_TRACKED_TIP;
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
        estSpan.className = "est" + (t.estimateMs ? "" : " zero");
        // the task's own estimate (shown only - not part of the period's total)
        estSpan.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
        spans.appendChild(estSpan);
        if (Number(t.spentMs) > 0) {
          const trk = document.createElement("span");
          trk.className = "trk";
          trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t, spans);
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
  // "Due in this range only" is a view mode, remembered on this computer.
  const dueOnlyEl = $("optFltDueOnly");
  if (dueOnlyEl) {
    try { if (localStorage.getItem("optFltDueOnly") === "0") dueOnlyEl.checked = false; } catch (e) {}
    dueOnlyEl.onchange = () => { try { localStorage.setItem("optFltDueOnly", dueOnlyEl.checked ? "1" : "0"); } catch (e) {} renderOptionsFilter(); };
  }
  const deptSel = $("optFltDept");
  if (deptSel) deptSel.onchange = () => { syncDeptUserSelect(); renderOptionsFilter(); };
  const deptUserSel = $("optFltDeptUser");
  if (deptUserSel) deptUserSel.onchange = renderOptionsFilter;
  loadWorkspaceClients();
  const peopleBtn = $("optFltPeopleBtn");
  if (peopleBtn) peopleBtn.onclick = (e) => {
    e.stopPropagation();
    const m = $("optFltPeopleMenu");
    if (m && !m.hidden) closePeopleMenu(); else openPeopleMenu();
  };
  document.addEventListener("click", (e) => {
    const wrap = $("optFltPeopleWrap");
    if (wrap && !wrap.contains(e.target)) closePeopleMenu();
  });
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
    // An empty roster is reported in the Department Creator itself when you ask for
    // the user list (deptMsg below). Logging it here too made Chrome list it as an
    // extension error on every options-page load, which looked like a breakage.
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
    fsel.innerHTML = '<option value="">My tasks (default)</option><option value="__all__">All users (workspace)</option><option value="__pick__">Pick people…</option>';
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
  const pWrap = $("optFltPeopleWrap");
  if (pWrap) pWrap.style.display = deptId === "__pick__" ? "" : "none";
  if (deptId !== "__pick__") closePeopleMenu();
  updatePeopleBtn();
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
let cuFilter = { dueToday: true, dueTomorrow: false, dueWeek: false, dueNextWeek: false, dueCustom: false, missingDue: false, customFrom: "", customTo: "", missingEst: false, hasTracked: false, deadlineCrossed: false, waitingOthers: false, manualOrder: false, statuses: [], priorities: [], clients: [] };
const CU_FILTER_KEYS = ["dueToday", "dueTomorrow", "dueWeek", "dueNextWeek", "dueCustom", "missingEst", "missingDue", "hasTracked", "deadlineCrossed", "waitingOthers", "groupSubtasks", "manualOrder"];
const CU_PRIORITY_ORDER = ["urgent", "high", "normal", "low", "none"];
// The section under the task list: time you tracked in the period on tasks
// that aren't in the list (due another day, no due date, or someone else's).
// It used to say "Tracked · no dates", which was wrong for most of them.
const CU_OTHER_TRACKED_TIP = "Tasks you tracked time on in this period that aren't in the list above: due on another day, no due date, or assigned to someone else. Their time is already counted in your Tracked total.";
function cuOtherTrackedLabel(scope) {
  return "Other tasks you tracked " + ({ today: "today", extended: "today", tomorrow: "tomorrow", week: "this week", nextweek: "next week" }[scope] || "in this range");
}
const CU_SCOPE_LABEL = { today: "due today", tomorrow: "due tomorrow", week: "this week", nextweek: "due next week", extended: "active today" };

function cuTodayEndMs() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }
function cuActiveFilterCount(f) {
  return CU_FILTER_KEYS.reduce((n, k) => n + (k !== "manualOrder" && f[k] ? 1 : 0), 0)
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
// The date range the task list is showing (for exports), or null when the
// filter has no date range (e.g. "Deadline crossed").
function cuViewRange(st, f) {
  st = st || {}; f = f || {};
  const day = (ms) => { const a = new Date(ms); a.setHours(0, 0, 0, 0); const b = new Date(a); b.setHours(23, 59, 59, 999); return { fromTs: a.getTime(), toTs: b.getTime() }; };
  const wk = (b) => (b && Number(b.fromTs) && Number(b.toTs) ? { fromTs: Number(b.fromTs), toTs: Number(b.toTs) } : null);
  if (f.deadlineCrossed) return null;
  if (f.dueCustom && f.customFrom) {
    const a = new Date(f.customFrom + "T00:00:00"), b = new Date((f.customTo || f.customFrom) + "T23:59:59");
    if (!isNaN(a) && !isNaN(b)) return { fromTs: a.getTime(), toTs: b.getTime() };
  }
  if (f.dueNextWeek) return wk(st.nextWeek);
  if (f.dueWeek) return wk(st.thisWeek);
  if (f.dueTomorrow) return day(Date.now() + 86400000);
  if (f.dueToday) return day(Date.now());
  return null;
}
// The target for the dates the list shows: the daily target times the working
// days (Mon-Fri) in the filter's range - "Due this week" = 5 x 7h = 35h. One day
// (today, tomorrow) or no date range keeps the daily target.
function cuScopeTargetMs(dailyMs, st, f) {
  const r = cuViewRange(st, f);
  if (!dailyMs || !r) return dailyMs;
  let days = 0;
  const d = new Date(r.fromTs); d.setHours(12, 0, 0, 0);
  const end = new Date(r.toTs); end.setHours(12, 0, 0, 0);
  const holiday = (x) => !!(window.PcmCalendar && window.PcmCalendar.isHoliday(x.getTime()));
  let weekdays = 0;
  for (let i = 0; d <= end && i < 400; i++, d.setDate(d.getDate() + 1)) if (d.getDay() !== 0 && d.getDay() !== 6) { weekdays++; if (!holiday(d)) days++; }
  if (weekdays <= 1) return dailyMs; // today / tomorrow: the daily target
  return dailyMs * days; // company holidays don't count (a whole holiday week = no target)
}
// Today's own tracked time, for the Tracked bar when the active scope is NOT
// today. The bar's own number is only today's when the scope is: "Deadline
// crossed" sums ClickUp's all-time time_spent per task (so it can read 4h 13m
// against a 7h daily target), and a week / tomorrow / custom range counts that
// whole period. st.spentMs is today's time entries (fetchTodayEstimate), the same
// figure the Today card shows. Its rows only carry spentToday when the
// time-entries source was actually used, so a ClickUp fallback to the cumulative
// field returns 0 and the chip stays hidden instead of showing a wrong number.
const CU_TODAY_TIP = "Time you tracked today, across all your tasks. The bar shows this filter's own total, which for this filter is not today only. Point at the light part of the bar for today's share of it.";
// Today's estimate (the Due today total, counted by the same multi-day rule)
// inside a wider date filter's Estimated bar - like the tracked "today" part.
// Only when the filter's dates include today.
const CU_TODAY_EST_TIP = "Today's estimate: what is due today (the Due today total). The bar shows this filter's own total; the light part of it is today's share.";
function cuTodayEstimate(st, view, f) {
  st = st || {}; view = view || {};
  if (!view.scope || view.scope === "today" || view.scope === "extended" || view.scope === "plan") return 0; // the bar IS today
  const r = cuViewRange(st, f), now = Date.now();
  if (!r || now < r.fromTs || now > r.toTs) return 0;
  return Math.max(0, Number(st.estimateMs) || 0);
}
function cuTodayTracked(st, view) {
  st = st || {}; view = view || {};
  if (view.scope === "today" || view.scope === "extended") return 0; // the bar IS today
  const rows = (Array.isArray(st.tasks) ? st.tasks : []).concat(Array.isArray(st.trackedTasks) ? st.trackedTasks : []);
  if (!rows.some((t) => t && t.spentToday === true)) return 0;
  const ms = Math.max(0, Number(st.spentMs) || 0);
  return ms > 0 ? ms : 0;
}
// ---- today's share of ONE task's tracked time ----
// A task worked over several days shows a cumulative figure wherever its tracked
// time appears ("Tracking now" counts every earlier entry; a row's spentMs covers
// the filter's whole range), so 4h 49m on a task can't be read as today's work.
// These two put today's own figure beside it, from data already on the page.
const CU_TRK_TODAY_TIP = "How much of this task's tracked time you put in today. The bigger figure is everything tracked on this task, across the days you worked on it.";
// Today's tracked time per task, from the state's own today bundle (st.tasks +
// st.trackedTasks are today's rows, carrying today-only spentMs). Gated on
// spentToday, so a ClickUp fallback to the cumulative time_spent field yields
// nothing instead of a wrong number. Memoised per state snapshot - the row
// painters ask for this once per task.
function cuTodayByTask(st) {
  st = st || {};
  const at = Number(st.at) || 0;
  const c = cuTodayByTask.c;
  if (c && c.st === st && c.at === at) return c.map;
  const rows = (Array.isArray(st.tasks) ? st.tasks : []).concat(Array.isArray(st.trackedTasks) ? st.trackedTasks : []);
  const map = new Map();
  if (rows.some((t) => t && t.spentToday === true)) {
    for (const t of rows) {
      if (!t || t.spentToday !== true) continue;
      const id = t.id != null ? String(t.id) : (t.taskId != null ? String(t.taskId) : "");
      const ms = Math.max(0, Number(t.spentMs) || 0);
      if (id && ms > 0) map.set(id, Math.max(map.get(id) || 0, ms));
    }
  }
  cuTodayByTask.c = { st, at, map };
  return map;
}
// Today's ms for one task, but ONLY when the task also has time from another day
// - otherwise 0 and nothing is shown, because the figure already on screen IS
// today's (the Today scope, or a task started and finished today). `spentShown`
// is the tracked figure the caller is displaying. `prior` is cuRunPrior: for the
// RUNNING task its exact closed-today + the live segment wins, since the state
// snapshot can be ~5 minutes behind. A one-minute margin keeps the two figures
// from ever rendering identically.
function cuTrkTodayMs(st, t, spentShown, prior, now) {
  st = st || {};
  prior = prior || { key: "", ms: 0, today: 0 };
  now = Number(now) || Date.now();
  const id = t && (t.id != null ? t.id : t.taskId);
  if (id == null || id === "") return 0;
  const run = st.running && st.running.taskId != null ? st.running : null;
  if (run && String(run.taskId) === String(id) && prior.key === String(run.taskId) + ":" + String(run.startMs || "")) {
    const earlier = Math.max(0, Number(prior.ms) || 0);
    const earlierToday = Math.max(0, Number(prior.today) || 0);
    if (earlier <= earlierToday + 60000) return 0; // all of this task's earlier time is today's
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const from = Math.max(Number(run.startMs) || 0, dayStart.getTime());
    return earlierToday + Math.max(0, now - from);
  }
  const today = Math.max(0, Number(cuTodayByTask(st).get(String(id))) || 0);
  const shown = Math.max(0, Number(spentShown) || 0);
  return (today > 0 && today + 60000 <= shown) ? today : 0;
}
// The running task's time from before this timer started (its earlier time
// entries, kept by the background in runningProgress), so "Tracking now" goes
// on from 30m instead of starting at 0m after a stop / complete and restart.
// `today` is the share of that earlier time tracked today, for the today pill.
let cuRunPrior = { key: "", ms: 0, today: 0, est: 0 };
let cuNowTick = null; // the "Tracking now" line's repaint, run again when the earlier time arrives
function cuLoadRunPrior() {
  try {
    chrome.storage.local.get("runningProgress").then(({ runningProgress: rp }) => {
      cuRunPrior = rp && rp.taskId
        ? { key: String(rp.taskId) + ":" + String(rp.startMs || ""), ms: Math.max(0, Number(rp.closedMs) || 0), today: Math.max(0, Number(rp.closedTodayMs) || 0), est: Math.max(0, Number(rp.estimateMs) || 0) }
        : { key: "", ms: 0, today: 0, est: 0 };
      if (cuNowTick) cuNowTick();
    }).catch(() => {});
  } catch (e) {}
}
cuLoadRunPrior();
try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.runningProgress) cuLoadRunPrior(); }); } catch (e) {}
// Tasks tracked in the dates but not due there (for "Other tasks you tracked"):
// rows the range query returned outside the due filter, plus its own list.
function cuOtherTracked(d, dueRows) {
  const keep = new Set((dueRows || []).map((t) => String(t && t.id)));
  const out = [], seen = new Set();
  const add = (t) => { const id = String(t && t.id); if (!t || keep.has(id) || seen.has(id) || !(Number(t.spentMs) > 0)) return; seen.add(id); out.push(t); };
  (Array.isArray(d && d.tasks) ? d.tasks : []).forEach(add);
  (Array.isArray(d && d.trackedTasks) ? d.trackedTasks : []).forEach(add);
  return out;
}
function resolveCuFilterView(st, f) {
  st = st || {};
  // A day plan applied from Insights > Plan wins over the filter (plan-apply.js).
  const planV = window.PcmPlanDay && window.PcmPlanDay.view(st);
  if (planV) return planV;
  // Deadline crossed looks at ALL dates, so it takes over the date scope.
  if (f.deadlineCrossed) return cuOverdueView();
  if (f.dueCustom) { const cv = cuCustomView(f, st); if (cv) return cv; }
  const wk = st.weekly || null;
  if (f.dueNextWeek && st.nextWeek) {
    const nw = st.nextWeek;
    return { estimateMs: nw.estimateMs, spentMs: nw.spentMs, tasks: Array.isArray(nw.tasks) ? nw.tasks : [], deadlineTasks: Array.isArray(nw.deadlineTasks) ? nw.deadlineTasks : [], trackedTasks: Array.isArray(nw.trackedTasks) ? nw.trackedTasks : [], scope: "nextweek", label: cuWeekRangeLabel("due next week", nw) };
  }
  if (f.dueWeek && st.thisWeek) {
    const tw = st.thisWeek;
    return { estimateMs: tw.estimateMs, spentMs: tw.spentMs, tasks: Array.isArray(tw.tasks) ? tw.tasks : [], deadlineTasks: Array.isArray(tw.deadlineTasks) ? tw.deadlineTasks : [], trackedTasks: Array.isArray(tw.trackedTasks) ? tw.trackedTasks : [], scope: "week", label: cuWeekRangeLabel("this week", tw) };
  }
  // Tomorrow is its own one-day query (see cuTomorrowView) so multi-day tasks
  // contribute tomorrow's share, the same way the Today card works.
  if (f.dueTomorrow) return cuTomorrowView(st);
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
// "Due tomorrow" asks ClickUp for that single day, exactly like the Today card
// does for today. That way a task that merely RUNS THROUGH tomorrow (the
// recurring Extra Task, or anything starting tomorrow and due later) brings
// tomorrow's share of its estimate with it.
let cuTomorrowCache = { key: "", status: "", data: null, at: 0 };
function cuTomorrowRange() {
  const s = new Date();
  s.setDate(s.getDate() + 1);
  s.setHours(0, 0, 0, 0);
  const e = new Date(s);
  e.setHours(23, 59, 59, 999);
  return { fromTs: s.getTime(), toTs: e.getTime() };
}
function cuTomorrowInvalidate() { if (cuTomorrowCache.status !== "loading") cuTomorrowCache.at = 0; }
async function cuFetchTomorrow(r, key) {
  const keep = cuTomorrowCache.key === key ? cuTomorrowCache.data : null;
  cuTomorrowCache = { key, status: "loading", data: keep, at: cuTomorrowCache.at };
  let res = null;
  for (let i = 0; i < 20; i++) {
    try { res = await send({ type: "CLICKUP_FILTER", fromTs: r.fromTs, toTs: r.toTs, assigneeIds: [] }, 20000); } catch (e) { res = null; }
    if (cuTomorrowCache.key !== key) return;
    if (!res || !res.ok || res.data) break;
    await new Promise((z) => setTimeout(z, 2000));
  }
  if (cuTomorrowCache.key !== key) return;
  if (!res || !res.ok || !res.data) {
    cuTomorrowCache = { key, status: "error", data: keep, at: Date.now() };
    cuCustomOnReady();
    return;
  }
  const d = res.data;
  const inDay = (t) => { const x = Number(t && t.dueDateMs) || 0; return x >= r.fromTs && x <= r.toTs; };
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).filter(inDay);
  // Configured tasks are already this day's share - never filter them by due date.
  const deadlineTasks = Array.isArray(d.deadlineTasks) ? d.deadlineTasks : [];
  const sum = (a, k) => a.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
  cuTomorrowCache = { key, status: "ready", at: Date.now(), data: {
    estimateMs: sum(tasks, "estimateMs") + sum(deadlineTasks, "dayEstimateMs"),
    spentMs: Math.max(Number(d.spentMs) || 0, sum(tasks, "spentMs") + sum(deadlineTasks, "spentMs")),
    tasks, deadlineTasks, trackedTasks: cuOtherTracked(d, tasks),
  } };
  cuCustomOnReady();
}
function cuTomorrowView(st) {
  // The background keeps tomorrow's bundle in state (refreshClickupImpl ->
  // buildDay), so the card paints from it instantly. Asking ClickUp on every
  // popup open is what made this flash "0m · loading…" for a couple of seconds.
  {
    const r0 = cuTomorrowRange();
    const b = st && st.tomorrow;
    if (b && Number(b.fromTs) === r0.fromTs && Number(b.toTs) === r0.toTs) {
      return { estimateMs: Number(b.estimateMs) || 0, spentMs: Number(b.spentMs) || 0,
        tasks: Array.isArray(b.tasks) ? b.tasks : [],
        deadlineTasks: Array.isArray(b.deadlineTasks) ? b.deadlineTasks : [],
        trackedTasks: Array.isArray(b.trackedTasks) ? b.trackedTasks : [], scope: "tomorrow" };
    }
  }
  // No bundle yet (first refresh after an update, or midnight rolled over
  // between refreshes): ask for that single day directly, just this once.
  const r = cuTomorrowRange();
  const key = r.fromTs + "-" + r.toTs;
  const c = cuTomorrowCache;
  const stale = c.key === key && c.status === "ready" && Date.now() - c.at > 5 * 60000;
  if (c.key !== key || stale) cuFetchTomorrow(r, key);
  if (c.key === key && c.data) return { ...c.data, scope: "tomorrow" };
  return { estimateMs: 0, spentMs: 0, tasks: [], deadlineTasks: [], trackedTasks: [], scope: "tomorrow",
    label: "due tomorrow" + (c.status === "error" ? " (couldn't load)" : " (loading…)"), loading: c.status !== "error" };
}

function cuCustomView(f, state) {
  const r = cuCustomRange(f);
  if (!r) return null;
  // Built once by the background for the saved filter (every page + the badge
  // read the same bundle, so they fill in together).
  const sb = state && state.custom;
  if (sb && sb.fromTs === r.fromTs && sb.toTs === r.toTs) return { ...sb, scope: "custom", label: cuCustomLabel(r) };
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
  // Configured tasks already hold this range's share - don't due-filter them.
  const deadlineTasks = Array.isArray(d.deadlineTasks) ? d.deadlineTasks : [];
  const sum = (a, k) => a.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
  cuCustomCache = { key, status: "ready", at: Date.now(), data: {
    estimateMs: sum(tasks, "estimateMs") + sum(deadlineTasks, "dayEstimateMs"),
    spentMs: Math.max(Number(d.spentMs) || 0, sum(tasks, "spentMs") + sum(deadlineTasks, "spentMs")),
    tasks, deadlineTasks, trackedTasks: cuOtherTracked(d, tasks),
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
  const tm = st.tomorrow || {};
  scan(tm.tasks); scan(tm.deadlineTasks); scan(tm.trackedTasks);
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
  const todayPill = document.createElement("span");
  todayPill.className = "trk-today";
  todayPill.title = CU_TRK_TODAY_TIP;
  todayPill.hidden = true;
  // This session on its own, next to the total: after a pause the timer is a new
  // entry, and showing only it ("9m") hid the 30m already tracked on the task.
  const sess = document.createElement("span");
  sess.className = "cu-now-sess";
  let askedFor = "";
  const tick = () => {
    if (!run.startMs) { time.textContent = ""; sess.textContent = ""; return; }
    const live = Math.max(0, Date.now() - run.startMs);
    const known = cuRunPrior.key === key;
    // The earlier time is worked out by the background for each new timer; if it
    // hasn't been for this one yet (a restart is often between full refreshes),
    // ask for it once instead of showing just this session.
    if (!known && askedFor !== key) { askedFor = key; send({ type: "TRACKER_PROGRESS" }).catch(() => {}); }
    const prior = known ? cuRunPrior.ms : 0;
    const est = known ? cuRunPrior.est : 0;
    time.textContent = fmtDurOpt(prior + live) + (est > 0 ? " / " + fmtDurOpt(est) : "");
    sess.textContent = !known ? "adding earlier time…" : prior > 0 ? "(" + fmtDurOpt(prior) + " before + " + fmtDurOpt(live) + " now)" : "";
    sess.title = !known ? "Looking up how much was tracked on this task before this timer" : prior > 0 ? "Tracked on this task before this timer: " + fmtDurOpt(prior) + " · this timer: " + fmtDurOpt(live) + " · total " + fmtDurOpt(prior + live) : "";
    // Today's own share, when this task was also worked on an earlier day: the
    // big figure is everything ever tracked on it, which on a task that runs for
    // days (a weekly recurring one) is nothing like today's work.
    const todayMs = cuTrkTodayMs(st, { id: run.taskId }, prior + live, cuRunPrior, Date.now());
    todayPill.hidden = !(todayMs > 0);
    todayPill.textContent = todayMs > 0 ? fmtDurOpt(todayMs) + " today" : "";
    time.title = prior
      ? "This session " + fmtDurOpt(live) + " · earlier " + fmtDurOpt(prior) + " (total on this task)" + (todayMs > 0 ? " · today " + fmtDurOpt(todayMs) : "")
      : "This session";
  };
  tick();
  cuNowTick = tick;
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
    stop.textContent = "Stopping\u2026";
    await commit(); // note first, so it lands on this entry
    sendTaskActionOpt(String(run.taskId), "stop");
  };
  // Same action as the task row's check button: saves the note, stops the timer
  // and marks the task complete - no need to find the task in the list first.
  const done = document.createElement("button");
  done.type = "button";
  done.className = "cu-now-done";
  done.textContent = "✓ Complete";
  done.title = "Mark this task complete (stops the timer)";
  done.onclick = async () => {
    done.disabled = true;
    stop.disabled = true;
    done.textContent = "Completing…";
    await commit(); // note first, so it lands on this entry
    sendTaskActionOpt(String(run.taskId), "complete");
  };
  // No Complete for the auto-detected Extra Task: it recurs Mon-Fri, and
  // completing it by mistake makes ClickUp create next week's copy early. It can
  // still be completed from its row in the task list below.
  const isExtra = !!((st.extraTask && st.extraTask.id && String(st.extraTask.id) === String(run.taskId))
    || /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(String(run.taskName || run.name || "")));
  if (isExtra) top.append(dot, lab, nm, time, sess, todayPill, stop);
  else top.append(dot, lab, nm, time, sess, todayPill, stop, done);
  const fl = window.PcmHelp && window.PcmHelp.floatButton();
  if (fl) top.insertBefore(fl, stop);
  const noteRow = document.createElement("div");
  noteRow.className = "cu-now-noterow";
  noteRow.append(note, saved);
  el.append(top, noteRow);
}

// "Group subtasks under their parent": arrange the rows ALREADY in view so a
// parent is followed by its own subtasks, indented. Nothing extra is fetched,
// and a subtask whose parent is not in this view simply stays where it was.
function cuGroupSubtaskRowsOpt(rows) {
  if (!cuFilter.groupSubtasks) return rows;
  const list = Array.isArray(rows) ? rows : [];
  const present = new Set(list.map((t) => String(t && (t.id != null ? t.id : t.taskId))));
  return list.map((t) => {
    const p = t && t.parentId != null ? String(t.parentId) : null;
    return p && present.has(p) ? { ...t, isSubtask: true } : t;
  });
}

// ---------- Custom (drag) task order (options preview) ----------
// Mirror of the popup's drag ordering. The order is remembered per date scope
// and per section and shared via chrome.storage.local.cuManualOrder, so an
// arrangement made in the popup shows here and vice-versa. Rows live in three
// separate .cu-tasklist blocks under the persistent #dashTasks container, so the
// handlers are delegated on that container and read each row's dataset.
let cuManualOrderOpt = {};
let cuActiveScopeOpt = "extended";
let cuDraggingOpt = false;
let cuDragElOpt = null;
let cuDragSectionOpt = null;
let cuDropTargetOpt = null;
let cuDropAfterOpt = false;
let cuRevokeDraggableOpt = null;

// ---------- Task search (dashboard Tasks card) ----------
// A plain local narrowing of the rows the dashboard already has, so it costs no
// ClickUp requests at all. Deliberately NOT persisted: a search box that is
// still filtering after a reload silently hides tasks, and someone who had
// forgotten about it would think work had gone missing.
let cuSearchOpt = "";
// Letters and digits only, so "Acme" matches "🔥 ACME HVAC" and a typed
// hyphen or apostrophe can't make a task unfindable (same key idea as
// canonicalizeClientLabels in background.js).
const cuSearchKey = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, "");
// Everything worth matching on one row: its name, client, status and the people
// on it (assignees are objects in some views, plain names in others).
function cuSearchHaystack(t) {
  if (!t) return "";
  const who = Array.isArray(t.assignees)
    ? t.assignees.map((a) => (a && typeof a === "object" ? (a.username || a.name || a.initials || "") : a)).join(" ")
    : (t.assignee || "");
  return cuSearchKey([t.name, t.client, t.status, who].join(" "));
}
function cuSearchMatches(t, key) { return !key || cuSearchHaystack(t).includes(key); }

// ---------- Recently completed (dashboard history card) ----------
// Reads the local history background.js builds out of refreshes it already made
// (see recordDoneHistory there): no ClickUp request is issued from this card at
// all, neither to fill it nor to search it, which is the whole point of it.
let cuDoneRowsOpt = null;   // null = never loaded, [] = loaded and empty
let cuDoneSearchOpt = "";
let cuDoneDays = 60;
// What the card is waiting for, so it never just looks empty: "loading" (asking
// the background), "nosync" (no ClickUp data has arrived yet), "ok", "error".
let cuDoneState = "loading";
// "today" / "yesterday" / a weekday for the last week / a plain date beyond that -
// the same ladder a person would use out loud, so a glance tells you how recent
// the work was without doing arithmetic on a timestamp.
function cuWhenLabelOpt(ts) {
  const n = Number(ts) || 0;
  if (!n) return "";
  const d = new Date(n);
  const today = new Date().setHours(0, 0, 0, 0);
  const day = new Date(n).setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86400000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 0) return "today " + time;
  if (days === 1) return "yesterday " + time;
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: "long" }) + " " + time;
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
}
async function cuLoadDoneHistory() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "CLICKUP_DONE_HISTORY" });
    if (r && r.ok) {
      cuDoneRowsOpt = Array.isArray(r.rows) ? r.rows : [];
      if (Number(r.days) > 0) cuDoneDays = Number(r.days);
      cuDoneState = r.synced === false && !cuDoneRowsOpt.length ? "nosync" : "ok";
      return;
    }
  } catch (e) {}
  // No answer (the background was waking up): say so, and try again shortly.
  if (!Array.isArray(cuDoneRowsOpt)) cuDoneRowsOpt = [];
  cuDoneState = cuDoneRowsOpt.length ? "ok" : "error";
  setTimeout(() => cuLoadDoneHistory().then(renderDoneHistory), 4000);
}
function renderDoneHistory() {
  const list = $("dashDoneList");
  const sub = $("dashDoneSub");
  if (!list) return;
  const rows = Array.isArray(cuDoneRowsOpt) ? cuDoneRowsOpt : [];
  const key = cuSearchKey(cuDoneSearchOpt);
  const shown = key ? rows.filter((t) => cuSearchMatches(t, key)) : rows;
  if (sub) {
    sub.textContent = !rows.length
      ? (cuDoneState === "loading" ? "loading…" : cuDoneState === "nosync" ? "waiting for ClickUp…" : cuDoneState === "error" ? "loading…" : "nothing saved yet")
      : key
        ? shown.length + " of " + rows.length + " match"
        : rows.length + (rows.length === 1 ? " task" : " tasks") + ", last " + cuDoneDays + " days";
  }
  list.textContent = "";
  if (!shown.length) {
    const e = document.createElement("div");
    e.className = "dash-empty";
    e.textContent = rows.length
      ? "No completed task matches “" + cuDoneSearchOpt.trim() + "”."
      : cuDoneState === "loading"
        ? "Loading the completed tasks…"
        : cuDoneState === "nosync"
          ? "Waiting for the first sync with ClickUp - completed tasks appear here as soon as it lands (no need to reload)."
          : cuDoneState === "error"
            ? "Still loading - the extension is waking up. Trying again in a few seconds…"
            : "No completed tasks in the last " + cuDoneDays + " days yet. A task shows here as soon as it is completed - by you in the extension, or by anyone in ClickUp.";
    if (!rows.length && cuDoneState !== "ok") { const sp = document.createElement("span"); sp.className = "cu-spin"; sp.style.marginRight = "6px"; e.prepend(sp); }
    list.appendChild(e);
    return;
  }
  for (const t of shown) {
    const row = document.createElement("div");
    row.className = "cu-task";
    const wrap = document.createElement("span");
    wrap.className = "nmwrap";
    const nm = document.createElement("a");
    nm.className = "nm";
    nm.textContent = t.name || "(untitled task)";
    nm.title = nm.textContent;
    if (t.url) { nm.href = t.url; nm.target = "_blank"; nm.rel = "noopener"; }
    wrap.appendChild(nm);
    if (t.client) {
      const pill = document.createElement("span");
      pill.className = "cu-client";
      pill.textContent = String(t.client);
      pill.title = "Client: " + t.client;
      wrap.appendChild(pill);
    }
    row.appendChild(wrap);
    const spans = document.createElement("span");
    spans.className = "estpairs";
    const when = document.createElement("span");
    when.className = "hint";
    when.textContent = cuWhenLabelOpt(t.doneAt);
    // Only ClickUp's own date_done is a real completion time. When it didn't give
    // one, this is when the extension first SAW the task done, which can be up to
    // a refresh later - say so rather than imply a precision we don't have.
    when.title = (t.exact ? "Completed " : "First seen completed ") + new Date(Number(t.doneAt) || 0).toLocaleString() +
      (t.exact ? "" : " - ClickUp didn't report a completion time for this task, so this is when the extension noticed.") +
      (t.status ? "\nStatus: " + t.status : "");
    spans.appendChild(when);
    const est = document.createElement("span");
    est.className = "est" + (t.estimateMs ? "" : " zero");
    est.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
    est.title = t.estimateMs ? "Estimate: " + fmtDurOpt(t.estimateMs) : "No estimate was set on this task";
    spans.appendChild(est);
    if (Number(t.spentMs) > 0) {
      const trk = document.createElement("span");
      trk.className = "trk";
      trk.textContent = fmtDurOpt(t.spentMs);
      trk.title = "Tracked: " + fmtDurOpt(t.spentMs);
      spans.appendChild(trk);
    }
    row.appendChild(spans);
    list.appendChild(row);
  }
}

function cuOrderForOpt(scope, section) {
  const s = cuManualOrderOpt && cuManualOrderOpt[scope];
  const arr = s && s[section];
  // null -> the section keeps the priority order (the starting point before the
  // user has dragged anything in this scope).
  return Array.isArray(arr) ? arr : null;
}
function cuSetOrderOpt(scope, section, ids) {
  if (!scope) return;
  if (!cuManualOrderOpt || typeof cuManualOrderOpt !== "object") cuManualOrderOpt = {};
  if (!cuManualOrderOpt[scope] || typeof cuManualOrderOpt[scope] !== "object") cuManualOrderOpt[scope] = {};
  cuManualOrderOpt[scope][section] = Array.isArray(ids) ? ids.slice() : [];
  chrome.storage.local.set({ cuManualOrder: cuManualOrderOpt });
}
function cuDecorateRowOpt(row, t, section, canDrag, group) {
  if (!canDrag || (t && t.isSubtask)) return;
  row.dataset.cuSection = section;
  // Grouped-by-client lists: a row only moves within its own client's group.
  row.dataset.cuGroup = group || "";
  row.dataset.cuId = cuId(t);
  row.classList.add("cu-draggable");
  const h = document.createElement("span");
  h.className = "cu-drag";
  h.textContent = "⠿";
  h.title = "Drag to reorder";
  h.setAttribute("aria-hidden", "true");
  row.insertBefore(h, row.firstChild);
}
function cuClearDropMarksOpt(container) {
  const marked = container.querySelectorAll(".cu-drop-before, .cu-drop-after");
  for (const el of marked) el.classList.remove("cu-drop-before", "cu-drop-after");
}
function cuCommitDragOpt(container) {
  if (!cuDragElOpt || !cuDropTargetOpt || cuDropTargetOpt === cuDragElOpt) return;
  const section = cuDragSectionOpt;
  const rows = Array.prototype.filter.call(
    container.querySelectorAll(".cu-task.cu-draggable"),
    (r) => r.dataset.cuSection === section
  );
  const dragId = cuDragElOpt.dataset.cuId;
  const targetId = cuDropTargetOpt.dataset.cuId;
  const ids = rows.map((r) => r.dataset.cuId).filter((id) => id !== dragId);
  let idx = ids.indexOf(targetId);
  if (idx < 0) idx = ids.length; else if (cuDropAfterOpt) idx += 1;
  ids.splice(idx, 0, dragId);
  cuSetOrderOpt(cuActiveScopeOpt, section, ids);
}
function cuSetupDragOpt(container) {
  if (!container || container.dataset.cuDragWired === "1") return;
  container.dataset.cuDragWired = "1";
  container.addEventListener("mousedown", (e) => {
    const h = e.target && e.target.closest && e.target.closest(".cu-drag");
    const row = h && h.closest(".cu-task.cu-draggable");
    if (!row) return;
    row.draggable = true;
    if (cuRevokeDraggableOpt) cuRevokeDraggableOpt();
    const revoke = () => {
      row.draggable = false;
      document.removeEventListener("mouseup", revoke);
      if (cuRevokeDraggableOpt === revoke) cuRevokeDraggableOpt = null;
    };
    cuRevokeDraggableOpt = revoke;
    document.addEventListener("mouseup", revoke);
  });
  container.addEventListener("dragstart", (e) => {
    const row = e.target && e.target.closest && e.target.closest(".cu-task.cu-draggable");
    if (!row || !row.draggable) return;
    cuDraggingOpt = true;
    cuDragElOpt = row;
    cuDragSectionOpt = row.dataset.cuSection || null;
    cuDropTargetOpt = null;
    cuDropAfterOpt = false;
    row.classList.add("cu-dragging");
    try {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", row.dataset.cuId || "");
    } catch (_) {}
  });
  container.addEventListener("dragover", (e) => {
    if (!cuDraggingOpt) return;
    const target = e.target && e.target.closest && e.target.closest(".cu-task.cu-draggable");
    if (!target || target === cuDragElOpt || target.dataset.cuSection !== cuDragSectionOpt || (target.dataset.cuGroup || "") !== (cuDragElOpt.dataset.cuGroup || "")) {
      cuClearDropMarksOpt(container);
      cuDropTargetOpt = null;
      return;
    }
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_) {}
    const rect = target.getBoundingClientRect();
    const after = (e.clientY - rect.top) > rect.height / 2;
    cuClearDropMarksOpt(container);
    target.classList.add(after ? "cu-drop-after" : "cu-drop-before");
    cuDropTargetOpt = target;
    cuDropAfterOpt = after;
  });
  container.addEventListener("drop", (e) => {
    if (!cuDraggingOpt) return;
    e.preventDefault();
    cuCommitDragOpt(container);
  });
  container.addEventListener("dragend", () => {
    if (cuDragElOpt) { cuDragElOpt.classList.remove("cu-dragging"); cuDragElOpt.draggable = false; }
    cuClearDropMarksOpt(container);
    if (cuRevokeDraggableOpt) cuRevokeDraggableOpt();
    cuDraggingOpt = false;
    cuDragElOpt = null;
    cuDragSectionOpt = null;
    cuDropTargetOpt = null;
    cuDropAfterOpt = false;
    // Redraw from the (possibly) new order and clear any deferred refresh.
    cuRenderPendingOpt = false;
    optRepaintCuPreview();
  });
}

// Every rebuild of the Today card and the task lists goes through keepPageStill,
// so emptying and refilling them can't move the page under the reader.
// The automatic repaints (every clickupState write: the 60-second timer sync, the
// 5-minute refresh, other tabs) rebuilt the whole table even when nothing in it
// had changed - a visible flicker every time. They now compare what they would
// draw with what is on screen (everything but the "Updated" time) and, when it is
// the same, only refresh that time. Any repaint the user causes always redraws.
let cuAutoPaint = false, cuLastPaintSig = "";
function cuPaintSig(st) {
  try {
    return JSON.stringify(st, (k, v) => (k === "at" || k === "membersAt" || k === "errorAt" ? undefined : v)) +
      "|" + JSON.stringify(cuFilter) + "|" + (typeof cuSearchOpt === "string" ? cuSearchOpt : "");
  } catch (e) { return String(Math.random()); }
}
function renderClickupPreview(st) {
  const sig = cuPaintSig(st);
  const box = $("cuPreview");
  if (cuAutoPaint && sig === cuLastPaintSig && box && box.childElementCount) {
    const upd = box.querySelector("[data-upd]");
    if (upd && st && st.at) upd.textContent = upd.textContent.replace(/Updated [^·]*$/, "Updated " + fmtClock(st.at));
    return;
  }
  // Mid-edit / mid-drag the body postpones the redraw: then nothing is on screen
  // for this state yet, so don't remember it as drawn.
  cuLastPaintSig = cuEstEditingOpt || cuDraggingOpt ? "" : sig;
  keepPageStill(() => renderClickupPreviewBody(st));
}
function renderClickupPreviewBody(st) {
  if (cuEstEditingOpt || cuDraggingOpt) { cuRenderPendingOpt = true; return; }
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
    // A 429 rate-limit is transient and self-heals on the next sync (rateLimitedUntil
    // is set ONLY on a rate-limit, never on a real failure), so show a calm muted
    // note and keep the cached total + task list. Genuine errors (bad token, network
    // down) stay red.
    const rateLimited = !!(st.rateLimitedUntil && st.errorAt && st.rateLimitedUntil >= st.errorAt);
    if (rateLimited) {
      const note = document.createElement("div");
      note.className = "hint";
      note.style.margin = "0 0 8px";
      note.textContent = st.at
        ? "ClickUp is busy. Showing totals from " + fmtClock(st.at) + ", refreshing automatically."
        : "ClickUp is busy, refreshing automatically.";
      box.appendChild(note);
      // fall through: render the cached totals + task list below
    } else {
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
  }

  // The today card mirrors the popup's Filter dropdown. The headline estimate +
  // tracked bars follow the WIDEST checked DATE scope (resolveCuFilterView);
  // nothing checked keeps the extended "active today" default (st.todayFilter).
  // The refine boxes (missingEst/deadlineCrossed) narrow the task LIST only.
  const view = resolveCuFilterView(st || {}, cuFilter);
  // The custom-order layer is keyed by the active date scope, so a drag in
  // "due today" is remembered separately from "due next week".
  cuActiveScopeOpt = view.scope || "extended";
  const targetMs = view.scope === "plan" ? Number(st.targetMs) || 0 : cuScopeTargetMs(Number(st.targetMs) || 0, st, cuFilter);
  let estMs = Number(view.estimateMs) || 0;
  let met = targetMs > 0 && estMs >= targetMs;
  let spentTot = Number(view.spentMs) || 0;
  let viewDeadline = Array.isArray(view.deadlineTasks) ? view.deadlineTasks : [];
  let viewTasks = Array.isArray(view.tasks) ? view.tasks : [];
  let viewTracked = Array.isArray(view.trackedTasks) ? view.trackedTasks : [];
  const refineOn = cuFilter.missingEst || cuFilter.missingDue || cuFilter.waitingOthers || cuFilter.deadlineCrossed || cuFilter.hasTracked
    || (cuFilter.statuses && cuFilter.statuses.length) || (cuFilter.priorities && cuFilter.priorities.length);
  if (refineOn && view.scope !== "plan") { // an applied plan is an explicit list: shown whole
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
  // The headline always shows the scope's own totals, exactly like the popup and
  // side panel. Re-summing rows here used to disagree with them (rows don't carry
  // every minute the scope total counts), so the selected clients' share is shown
  // as its own line instead, and only when the filter actually hides some rows.
  let clientShare = null;
  if (clientsSel.length) {
    const set = new Set(clientsSel);
    const keepClient = (t) => set.has(String((t && t.client) || "").trim());
    const before = viewTasks.length + viewDeadline.length + viewTracked.length;
    viewTasks = viewTasks.filter(keepClient);
    viewDeadline = viewDeadline.filter(keepClient);
    viewTracked = viewTracked.filter(keepClient);
    if (viewTasks.length + viewDeadline.length + viewTracked.length < before) {
      clientShare = {
        est: viewTasks.reduce((a, t) => a + (Number(t.estimateMs) || 0), 0)
          + viewDeadline.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0),
        spent: viewTasks.concat(viewDeadline, viewTracked).reduce((a, t) => a + (Number(t.spentMs) || 0), 0),
      };
    }
  }
  // Task search. Goes AFTER the client narrowing and BEFORE cuExportDataOpt, so
  // what you export is always what you can see - the same rule the client filter
  // follows. Pure local filtering of rows already in memory: no request, so it
  // can be typed in freely without spending any of the ClickUp rate limit.
  const searchKey = cuSearchKey(cuSearchOpt);
  let searchHidden = 0;
  if (searchKey) {
    const before = viewTasks.length + viewDeadline.length + viewTracked.length;
    viewTasks = viewTasks.filter((t) => cuSearchMatches(t, searchKey));
    viewDeadline = viewDeadline.filter((t) => cuSearchMatches(t, searchKey));
    viewTracked = viewTracked.filter((t) => cuSearchMatches(t, searchKey));
    searchHidden = before - (viewTasks.length + viewDeadline.length + viewTracked.length);
  }
  cuExportDataOpt = cuExportRowsOpt(viewTasks, viewDeadline, viewTracked,
    (CU_SCOPE_LABEL[view.scope] || "tasks") + (clientsSel.length ? " - " + clientsSel.join(", ") : ""));
  cuExportDataOpt.range = cuViewRange(st, cuFilter); // exports keep to these dates
  viewTasks = cuGroupSubtaskRowsOpt(viewTasks);
  const noEst = viewTasks.filter((t) => !Number(t.estimateMs)).length;
  const scopeLabel = (view.scope && view.scope !== "extended") ? (view.label || CU_SCOPE_LABEL[view.scope]) : "";

  const big = document.createElement("div");
  big.className = "big";
  big.textContent = fmtDurOpt(estMs) + " ";
  if (window.pcmCountTo) window.pcmCountTo(big.firstChild, "optTotal", estMs, fmtDurOpt);
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
  // Wider-than-today dates: today's own estimate beside it, like Tracked's chip.
  const todayEstMs = cuTodayEstimate(st, view, cuFilter);
  if (todayEstMs > 0) {
    const chip = document.createElement("span");
    chip.className = "est-today";
    chip.textContent = fmtDurOpt(todayEstMs) + " today";
    chip.title = CU_TODAY_EST_TIP;
    estName.appendChild(document.createTextNode(" "));
    estName.appendChild(chip);
  }
  estLabel.appendChild(estName);
  estLabel.appendChild(estVal);

  const estBar = document.createElement("div");
  estBar.className = "cu-bar2";
  const estFill = document.createElement("div");
  estFill.className = "cu-fill2" + (met ? " met" : "");
  const estPct = targetMs > 0 ? Math.min(100, Math.round((estMs / targetMs) * 100)) : 0;
  estFill.style.width = estPct + "%";
  if (todayEstMs > 0 && todayEstMs <= estMs) {
    const seg = document.createElement("div");
    seg.className = "cu-today-seg";
    seg.style.width = Math.min(100, Math.round((todayEstMs / estMs) * 100)) + "%";
    seg.title = CU_TODAY_EST_TIP;
    estFill.appendChild(seg);
  }
  estBar.title = todayEstMs > 0 ? CU_TODAY_EST_TIP : "";
  estBar.appendChild(estFill);
  barWrap.appendChild(estLabel);
  barWrap.appendChild(estBar);

  // Tracked block.
  const trkLabel = document.createElement("div");
  trkLabel.className = "bar-label";
  const trkName = document.createElement("span");
  trkName.textContent = "Tracked Time";
  // When the filter's scope is wider than today, say how much of it is today, so
  // a cumulative-looking bar (Deadline crossed) can't be read as today's work.
  const todayTrkMs = cuTodayTracked(st, view);
  if (todayTrkMs > 0) {
    const chip = document.createElement("span");
    chip.className = "trk-today";
    chip.textContent = fmtDurOpt(todayTrkMs) + " today";
    chip.title = CU_TODAY_TIP;
    trkName.appendChild(document.createTextNode(" "));
    trkName.appendChild(chip);
  }
  const trkVal = document.createElement("span");
  trkVal.className = "val";
  trkVal.textContent = fmtDurOpt(spentTot) + (targetMs > 0 ? " of " + fmtDurOpt(targetMs) : "");
  trkLabel.appendChild(trkName);
  trkLabel.appendChild(trkVal);
  // Click either number: the tasks behind it and why the two differ.
  if (window.PcmBreakdown) {
    const bd = () => ({ label: scopeLabel || "today", estMs, spentMs: spentTot, tasks: viewTasks, cfg: viewDeadline, other: viewTracked, fmt: fmtDurOpt });
    PcmBreakdown.attach(estVal, "est", bd);
    PcmBreakdown.attach(trkVal, "trk", bd);
  }

  const trkBar = document.createElement("div");
  trkBar.className = "cu-bar2 trk";
  const trkFill = document.createElement("div");
  trkFill.className = "cu-fill2 trk" + (spentTot >= targetMs && targetMs > 0 ? " met" : "");
  const trkPct = targetMs > 0 ? Math.min(100, Math.round((spentTot / targetMs) * 100)) : 0;
  trkFill.style.width = trkPct + "%";
  // Today's share of the fill, drawn inside the bar. Only when today is part of
  // the bar's own total (a due-tomorrow or custom-range filter can be disjoint).
  if (todayTrkMs > 0 && todayTrkMs <= spentTot) {
    const seg = document.createElement("div");
    seg.className = "cu-today-seg";
    seg.style.width = Math.min(100, Math.round((todayTrkMs / spentTot) * 100)) + "%";
    seg.title = CU_TODAY_TIP;
    trkFill.appendChild(seg);
  }
  trkBar.appendChild(trkFill);
  trkBar.title = todayTrkMs > 0 ? CU_TODAY_TIP : "";
  barWrap.appendChild(trkLabel);
  barWrap.appendChild(trkBar);
  box.appendChild(barWrap);

  // One short summary line. The estimate / target / "target met" are already in
  // the headline, the bars and the chip, so they aren't repeated here.
  const meta = document.createElement("div");
  meta.className = "hint cu-meta";
  const line2 = document.createElement("div");
  const deadlineMs = viewDeadline.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0);
  const spentBits = [];
  if (deadlineMs > 0) spentBits.push("Configured +" + fmtDurOpt(deadlineMs));
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
    spentBits.push("Filter: " + tags.join(" + "));
  }
  // The client names are listed in the Tasks card header; just count them here.
  if (clientsSel.length) spentBits.push(clientsSel.length === 1 ? "1 client" : clientsSel.length + " clients");
  if (st.at) spentBits.push("Updated " + fmtClock(st.at));
  line2.textContent = spentBits.join("  ·  ");
  line2.dataset.upd = "1";
  meta.appendChild(line2);
  if (clientShare) {
    const line3 = document.createElement("div");
    line3.textContent = "Selected clients: " + fmtDurOpt(clientShare.est) + " est  ·  " + fmtDurOpt(clientShare.spent) + " tracked";
    meta.appendChild(line3);
  }
  box.appendChild(meta);
  optRenderCuFilterMenu();
  // Sidebar layout: the task lists render into the Dashboard's Tasks card
  // (#dashTasks); the Today card keeps just the numbers and bars.
  const lists = $("dashTasks") || box;
  cuSetupDragOpt(lists); // one-time delegated drag wiring (self-guarded)
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

  // The list heading follows the filter; it used to say "Tasks today" whatever
  // was chosen, which made a this-week list look like it ignored the filter.
  const taskHead = (view.scope === "today" || view.scope === "extended" || !view.scope)
    ? "Tasks today - each estimated / tracked"
    : "Tasks " + (view.label || CU_SCOPE_LABEL[view.scope] || "in this view") + " - each estimated / tracked";
  // One set of sections (configured / tasks / tracked). With clients ticked it
  // runs once per client under that client's heading - the grouping the popup
  // and side panel use - instead of one flat list sorted across every client.
  const renderSections = (lists, viewDeadline, viewTasks, viewTracked, grouped, groupName) => {
    const first = lists.children.length;
    // Custom (drag) order layers on the active scope. In the grouped-by-client
    // view each row carries its client (groupName) and only moves within it.
    const scope = view.scope || null;
    const useOrder = !!(cuFilter.manualOrder && scope);
    const canDrag = useOrder; // grouped: rows move within their own client (groupName)
    const mainOrder = useOrder ? cuOrderForOpt(scope, "main") : null;
    const deadlineOrder = useOrder ? cuOrderForOpt(scope, "deadline") : null;
    const trackedOrder = useOrder ? cuOrderForOpt(scope, "tracked") : null;
    if (viewDeadline.length) {
      const dHead = document.createElement("div");
      dHead.className = "hint";
      dHead.style.marginTop = "8px";
      dHead.style.fontWeight = "700";
      dHead.textContent = "Configured tasks (by URL)";
      if (!grouped) lists.appendChild(dHead);
      const dList = document.createElement("div");
      dList.className = "cu-tasklist";
      dList.style.maxHeight = "120px";
      for (const dt of sortByPriority(viewDeadline, deadlineOrder)) {
        const row = document.createElement("div");
        row.className = "cu-task";
        const nm = document.createElement("a");
        nm.className = "nm";
        // An { error } row means THIS refresh couldn't load the task (usually one
        // rate-limited request). Say so, instead of a nameless "(configured task)".
        nm.textContent = dt.name || (dt.error ? "Couldn't load this task \u00b7 retries on the next sync" : "(configured task)");
        nm.title = dt.error ? "ClickUp said: " + dt.error : (dt.lastKnownAt ? nm.textContent + " \u00b7 couldn't refresh, showing what loaded at " + new Date(dt.lastKnownAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : nm.textContent);
        const href = dt.url || dt.taskUrl;
        if (href) { nm.href = href; nm.target = "_blank"; nm.rel = "noopener"; }
        appendDoneTickOpt(nm, dt);
        const spans = document.createElement("span");
        spans.className = "estpairs";
        const estTxtErr = dt.error ? "not loaded" : null;
        const estTxt = dt.accumulated
          ? (dt.dayEstimateMs ? "est " + fmtDurOpt(dt.dayEstimateMs) : "no estimate")
          : (dt.isWeekday === false
              ? "weekend 0"
              : (dt.dayEstimateMs ? fmtDurOpt(dt.dayEstimateMs) + "/day" : "no estimate"));
        const estSpan = document.createElement("span");
        estSpan.className = "est" + (dt.dayEstimateMs ? "" : " zero");
        estSpan.textContent = estTxtErr || estTxt;
        spans.appendChild(estSpan);
        if (Number(dt.spentMs) > 0) {
          const trk = document.createElement("span");
          trk.className = "trk";
          trk.textContent = fmtDurOpt(dt.spentMs); markTrk(trk, dt, spans);
          spans.appendChild(trk);
        }
        appendNameCellOpt(row, nm, dt);
        row.appendChild(spans);
        appendTaskControlsOpt(row, dt);
        cuDecorateRowOpt(row, dt, "deadline", canDrag, groupName);
        dList.appendChild(row);
      }
      lists.appendChild(dList);
    }

    if (viewTasks.length) {
      const listHead = document.createElement("div");
      listHead.className = "hint";
      listHead.style.marginTop = "8px";
      listHead.style.fontWeight = "700";
      listHead.textContent = taskHead;
      if (!grouped) lists.appendChild(listHead);
      const listEl = document.createElement("div");
      listEl.className = "cu-tasklist";
      if (!grouped) makeListResizable(listEl, "dash");
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
      // Priority first, then bigger estimate - or the user's own drag order when
      // "Custom order" is on and this scope has one.
      parentRows.sort(mainOrder ? cuManualCmp(mainOrder) : cuPrioCmp);
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
          trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t, spans);
          spans.appendChild(trk);
        }
        appendNameCellOpt(row, nm, t);
        row.appendChild(spans);
        appendTaskControlsOpt(row, t);
        cuDecorateRowOpt(row, t, "main", canDrag, groupName);
        listEl.appendChild(row);
      }
      lists.appendChild(listEl);
    }

    if (viewTracked.length) {
      const listHead = document.createElement("div");
      listHead.className = "hint";
      listHead.style.marginTop = "8px";
      listHead.style.fontWeight = "700";
      listHead.textContent = cuOtherTrackedLabel(view.scope);
      listHead.title = CU_OTHER_TRACKED_TIP;
      lists.appendChild(listHead);
      const listEl = document.createElement("div");
      listEl.className = "cu-tasklist";
      listEl.style.maxHeight = "120px";
      for (const t of sortByPriority(viewTracked, trackedOrder)) {
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
        est.className = "est" + (t.estimateMs ? "" : " zero");
        // the task's own estimate (shown only - not part of the period's total)
        est.textContent = t.estimateMs ? fmtDurOpt(t.estimateMs) : "no est";
        spans.appendChild(est);
        if (Number(t.spentMs) > 0) {
          const trk = document.createElement("span");
          trk.className = "trk";
          trk.textContent = fmtDurOpt(t.spentMs); markTrk(trk, t, spans);
          spans.appendChild(trk);
        }
        appendNameCellOpt(row, nm, t);
        row.appendChild(spans);
        appendTaskControlsOpt(row, t);
        cuDecorateRowOpt(row, t, "tracked", canDrag, groupName);
        listEl.appendChild(row);
      }
      lists.appendChild(listEl);
    }
    if (grouped) {
      // The heading already names the client: drop the per-row pill (from every
      // row of the group, so the columns stay aligned) and keep the rows tight
      // under their heading.
      for (const el of [...lists.children].slice(first)) {
        el.querySelectorAll(".cu-client").forEach((pill) => pill.remove());
        if (el.classList.contains("cu-tasklist")) el.classList.add("cu-grouplist");
      }
    }
  };
  if (clientsSel.length) {
    // All client groups sit in ONE scroll box with the stretch bar under it
    // (each group's own list stops scrolling on its own inside it).
    const gw = document.createElement("div");
    gw.className = "cu-tasklist cu-groupwrap";
    lists.appendChild(gw);
    makeListResizable(gw, "dash");
    const clientOf = (t) => String((t && t.client) || "").trim();
    for (const c of clientsSel.slice().sort((a, b) => a.localeCompare(b))) {
      const d1 = viewDeadline.filter((t) => clientOf(t) === c);
      const t1 = viewTasks.filter((t) => clientOf(t) === c);
      const k1 = viewTracked.filter((t) => clientOf(t) === c);
      if (!d1.length && !t1.length && !k1.length) continue;
      const est = t1.reduce((a, t) => a + (Number(t.estimateMs) || 0), 0)
        + d1.reduce((a, t) => a + (Number(t.dayEstimateMs) || 0), 0);
      const trk = t1.concat(d1, k1).reduce((a, t) => a + (Number(t.spentMs) || 0), 0);
      const head = document.createElement("div");
      head.className = "cu-dhead cu-clienthead";
      const nameSpan = document.createElement("span");
      nameSpan.className = "cu-chname";
      nameSpan.textContent = c;
      nameSpan.title = c;
      head.appendChild(nameSpan);
      const subSpan = document.createElement("span");
      subSpan.className = "cu-chsub";
      subSpan.textContent = "est " + fmtDurOpt(est) + (trk > 0 ? " \u00b7 tracked " + fmtDurOpt(trk) : "");
      head.appendChild(subSpan);
      // Each client in its own card, so the groups are easy to tell apart.
      const card = document.createElement("div");
      card.className = "cu-clientcard";
      card.appendChild(head);
      gw.appendChild(card);
      renderSections(card, d1, t1, k1, true, c);
    }
    if (!gw.children.length) gw.remove();
  } else {
    renderSections(lists, viewDeadline, viewTasks, viewTracked, false);
  }
  if (lists !== box && !lists.children.length) {
    const e = document.createElement("div");
    e.className = "dash-empty";
    // An empty list while a search is typed is the search's doing, not an empty
    // day - say which, or it reads as "my tasks have vanished".
    e.textContent = searchKey
      ? "No task here matches “" + cuSearchOpt.trim() + "”."
      : view.loading ? "Loading tasks for these dates…" : "No tasks in this view.";
    lists.appendChild(e);
  } else if (lists !== box && searchHidden > 0) {
    const n = document.createElement("div");
    n.className = "dash-nores";
    n.textContent = searchHidden + (searchHidden === 1 ? " task is" : " tasks are") +
      " hidden by the search “" + cuSearchOpt.trim() + "”.";
    lists.appendChild(n);
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
      await send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeekly: true, forceWeeks: true }, 25000).catch(() => {});
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

// Daily "needs tidying" reminder: hide its details while it's switched off, and
// wire the two buttons. The preview posts the real summary without spending
// today's one-shot, so you can check the wording and the timing settings.
(function () {
  const box = $("cuTidyNotify");
  if (!box) return;
  const rows = [$("cuTidyDaysRow"), $("cuTidyCatsRow")];
  const paint = () => rows.forEach((r) => { if (r) r.style.display = box.checked ? "" : "none"; });
  box.addEventListener("change", paint);
  paint();
  const go = $("cuTidyGoInsights");
  if (go) go.onclick = (e) => { e.preventDefault(); showOptTab("insights"); window.scrollTo({ top: 0 }); };
  const pv = $("cuTidyPreview");
  if (pv) pv.onclick = async () => {
    pv.disabled = true;
    const was = pv.textContent;
    pv.textContent = "Building…";
    try {
      const r = await send({ type: "CLICKUP_TIDY_PREVIEW", fresh: true }, 30000);
      if (r && r.ok) {
        cuMsg("cuSaveMsg", r.sample ? "Sample sent - your board is clean right now ✓" : "Preview sent ✓", true);
      } else {
        const why = (r && (r.error || r.reason)) || "unknown error";
        cuMsg("cuSaveMsg", r && r.reason === "not-connected" ? "Connect ClickUp first." : "Couldn't build a preview: " + why, false);
      }
    } catch (e) {
      cuMsg("cuSaveMsg", "Couldn't build a preview: " + (e && e.message ? e.message : e), false);
    }
    pv.disabled = false;
    pv.textContent = was;
  };
})();

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
  const tidyTime = $("cuTidyTime").value || "14:00";
  if (!/^\d{1,2}:\d{2}$/.test(tidyTime) || Number(tidyTime.split(":")[0]) > 23 || Number(tidyTime.split(":")[1]) > 59) {
    cuMsg("cuSaveMsg", "The \"needs tidying\" time must be a time of day, like 14:00.", false);
    return;
  }
  const tidyMax = parseInt($("cuTidyMax").value.trim(), 10) || 3;
  if (!Number.isInteger(tidyMax) || tidyMax < 1 || tidyMax > 6) {
    cuMsg("cuSaveMsg", "\"Name up to\" must be a whole number of tasks from 1 to 6.", false);
    return;
  }
  const deadlineUrls = $("cuDeadlineUrls").value.split("\n").map((s) => s.trim()).filter(Boolean);
  try {
    await send({
      type: "CLICKUP_SET",
      patch: {
        clickupTargetHours: target,
        clickupNudgeHour: nudge,
        clickupWorkdayEndHour: end,
        clickupMultiDay: $("cuMultiDay") ? $("cuMultiDay").value : "due",
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
        clickupExtraAutoClose: $("cuExtraAutoClose") ? $("cuExtraAutoClose").checked : true,
        clickupWrapUpTime: wrapUpTime,
        clickupTidyNotify: $("cuTidyNotify").checked,
        clickupTidyTime: tidyTime,
        clickupTidyDays: $("cuTidyDays").value || "weekdays",
        clickupTidyMax: tidyMax,
        clickupTidyResolved: $("cuTidyResolved").checked,
        clickupTidyCats: {
          overdue: $("cuTidyCatOverdue").checked, noEst: $("cuTidyCatNoEst").checked,
          noDue: $("cuTidyCatNoDue").checked, blocked: $("cuTidyCatBlocked").checked,
        },
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
  if (list.length > 1) {
    const all = document.createElement("option");
    all.value = "__all__";
    all.textContent = "All accounts (one after another)";
    sel.appendChild(all);
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
  dbgMsg(id === "__all__"
    ? "Testing every account one after another (accounts whose 24 hours are up are skipped, so no credit goes unrecorded)…\n"
    : "Starting GitHub login test…\n");
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
    pollUntilStopped();
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
    // "All accounts" sends one result per account; the buttons reset after the last.
    const finished = msg.done && !msg.more;
    if (finished || !msg.account) {
      const btn = $("dbgLoginBtn");
      if (btn) {
        btn.disabled = false;
        btn.textContent = "Test login";
      }
      const stop = $("dbgStopBtn");
      if (stop) stop.disabled = true;
    }
    if (msg.done) {
      const ok = msg.ok;
      const lines = [];
      if (msg.account) lines.push("— " + msg.account + " —");
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
const OPT_COLLAPSE_KEYS = { weekly: "cuOptCollapseWeekly", filter: "cuOptCollapseFilter", connection: "cuOptCollapseConnection", settings: "cuOptCollapseSettings", done: "cuOptCollapseDone" };
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

// The dashboard's cards paint from persisted clickupState - nothing on this page
// ever asked the background to rebuild the week, so estimates added in ClickUp
// could sit out the whole 30-minute window and the bar chart looked frozen.
// Nudge a rebuild on open, but ONLY when the snapshot is actually stale, so
// re-opening the dashboard doesn't re-pay the API calls (the popup's equivalent
// nudge is unconditional; this one is deliberately cheaper). Fire-and-forget:
// the clickupState listener below repaints when it lands, so first paint is
// never blocked and the page height never changes underneath a scroll.
const OPT_WEEKLY_NUDGE_MS = 5 * 60000;
(async function nudgeWeeklyIfStale() {
  try {
    const { clickupState: st } = await chrome.storage.local.get("clickupState");
    if (!st) return; // ClickUp isn't set up yet - nothing to rebuild
    const at = Number(st.weekly && st.weekly.at) || 0;
    if (at && Date.now() - at < OPT_WEEKLY_NUDGE_MS) return; // still fresh
    send({ type: "CLICKUP_REFRESH", forceWeekly: true, forceWeeks: true }).catch(() => {});
  } catch (e) {}
})();

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
// "All" at the top of the Client list: tick every client at once, or clear them
// all. Shows a partial tick when only some are chosen. Hidden in "One at a time"
// mode, where choosing every client would contradict the mode.
function cuAddAllClientsBox(box, values, checked) {
  if (!box || cuFilterSingle || values.length < 2) return;
  const n = values.filter((v) => checked.includes(v)).length;
  const label = document.createElement("label");
  label.className = "cu-filter-all";
  label.title = "Tick or untick every client";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.setAttribute("data-cf-client-all", "");
  input.checked = n === values.length;
  input.indeterminate = n > 0 && n < values.length;
  const span = document.createElement("span");
  span.textContent = "All";
  label.appendChild(input);
  label.appendChild(document.createTextNode(" "));
  label.appendChild(span);
  box.insertBefore(label, box.firstChild);
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
  // Custom order is a view setting (the switch in the menu header), not a
  // filter, so "Clear all" leaves it as it is.
  for (const k of CU_FILTER_KEYS) if (k !== "manualOrder") cuFilter[k] = false;
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
// Your own starting point: "Save as my default" remembers the ticked filters
// and the selection mode; a fresh install (or "Use my default") applies them.
const CU_FILTER_EXTRAS = ["statuses", "priorities", "clients", "customFrom", "customTo"];
function cuSnapshotFilter() {
  const out = { mode: cuFilterSingle ? "single" : "multi" };
  for (const k of CU_FILTER_KEYS) out[k] = !!cuFilter[k];
  for (const k of CU_FILTER_EXTRAS) out[k] = Array.isArray(cuFilter[k]) ? cuFilter[k].slice() : (cuFilter[k] || "");
  return out;
}
// opts.persist === false: this page only (a day picked in the weekly chart) - the
// popup, side panel and toolbar badge share the saved filter and must not follow.
function cuApplyFilterSnapshot(snap, opts) {
  if (!snap || typeof snap !== "object") return false;
  for (const k of CU_FILTER_KEYS) cuFilter[k] = !!snap[k];
  for (const k of CU_FILTER_EXTRAS) cuFilter[k] = Array.isArray(snap[k]) ? snap[k].slice() : (snap[k] || "");
  cuFilterSingle = snap.mode === "single";
  if (!(opts && opts.persist === false)) chrome.storage.local.set({ cuFilter, cuFilterMode: snap.mode === "single" ? "single" : "multi" }).catch(() => {});
  optRenderCuFilterMenu();
  optCuFilterBtnLabel();
  optRepaintCuPreview();
  return true;
}
async function cuUseDefaultFilter() {
  try {
    const { cuFilterDefault } = await chrome.storage.local.get("cuFilterDefault");
    return cuApplyFilterSnapshot(cuFilterDefault);
  } catch (e) { return false; }
}
function cuSaveDefaultFilter() {
  chrome.storage.local.set({ cuFilterDefault: cuSnapshotFilter() }).catch(() => {});
}

function cuPaintClearBtn(menu) {
  const b = menu && menu.querySelector("[data-fclear]");
  if (!b) return;
  const on = CU_FILTER_KEYS.some((k) => k !== "manualOrder" && cuFilter[k]) ||
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
  cuAddAllClientsBox($("optCuFilterClientList"), clientVals, clients);
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
  cuPaintChartBanner();
  if (window.PcmPlanDay) { const card = $("dashTasksCard"); window.PcmPlanDay.paintBanner(card && (card.querySelector(".dash-h") || card.firstElementChild), "cuPlanDayBar"); }
  try { renderDashStrip(); } catch (e) {}
  try { if (insTabActive()) renderInsights(); } catch (e) {}
}

if (window.PcmPlanDay) window.PcmPlanDay.onChange(() => optRepaintCuPreview());
// A task pinned / unpinned (task-notes.js) moves to / from the top of the list.
if (window.PcmTaskNotes) window.PcmTaskNotes.onChange(() => optRepaintCuPreview());

/* ============================ Insights ============================ */
/* Phase 1 - a weekly health check surfaced two ways:
   (1) renderDashStrip()  - a quiet one-line strip on the Dashboard. State-only, so
       ZERO extra ClickUp calls; it just reads counts already in optClickup.state
       (this week's "no estimate" and the "waiting"/sub-blocked map), and, only if
       the Insights tab happens to have already loaded the open-task list, enriches
       itself with overdue / no-due counts from that same in-memory cache.
   (2) renderInsights()   - the full Insights tab, built from ONE broad open-tasks
       fetch (CLICKUP_OPEN_TASKS - cached ~3 min in the background and shared with
       Bulk edit) aggregated on the page, plus the already-loaded state.
   All markup reuses existing CSS variables, so light/dark is automatic. */

var insCache = null;      // { status:"ok"|"err", data:[rows], error, at }
// Insights sub-tab: "health" (this file), "plan" / "performance" (insights-plus.js).
var INS_SUBS = ["health", "plan", "performance"];
var insSub = (function () { try { var s = localStorage.getItem("insSub"); return INS_SUBS.indexOf(s) >= 0 ? s : "health"; } catch (e) { return "health"; } })();
function insSetSub(s) {
  insSub = INS_SUBS.indexOf(s) >= 0 ? s : "health";
  try { localStorage.setItem("insSub", insSub); } catch (e) {}
}
var insLoading = false;   // a CLICKUP_OPEN_TASKS fetch is in flight
var INS_TTL = 5 * 60000;  // consider the open-task cache stale after this
// The last good result is also kept in storage, so opening the dashboard again
// shows it at once ("Updated 2h ago · refreshing…") instead of "Loading…" every
// time; only the very first visit has nothing to show.
var INS_STORE = "insOpenCache";
var insLastAuto = 0;
var insHydrated = null;
function insHydrate() {
  if (!insHydrated) insHydrated = (typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local.get(INS_STORE) : Promise.resolve({})).then(function (g) {
    var c = g && g[INS_STORE];
    if (!insCache && c && Array.isArray(c.tasks)) insCache = { status: "ok", data: c.tasks, at: Number(c.at) || 0 };
  }).catch(function () {});
  return insHydrated;
}
insHydrate().then(function () {
  if (!insCache) return;
  if (insTabActive()) { try { renderInsights(); } catch (e) {} }
  try { renderDashStrip(); } catch (e) {}
});

// Narrowing of the four detail lists (NOT of the KPIs or the By client table -
// those always show the whole board). Kept outside the paint so a background
// refresh can put the lists back exactly as the user left them.
var insFilter = { client: "", q: "" };
var insOpenDrills = Object.create(null); // drill id -> the user has it expanded
var insPendingDrill = "";                // open + scroll to this list after the next paint
// Opened from the "needs tidying" notification (options.html?drill=overdue,noest#insights):
// expand each list it talked about and scroll to the first one.
(function () {
  try {
    var want = (new URLSearchParams(location.search).get("drill") || "").split(",").filter(function (d) { return /^(overdue|noest|nodue|blocked)$/.test(d); });
    if (!want.length) return;
    want.forEach(function (d) { insOpenDrills[d] = true; });
    insPendingDrill = want[0];
    insSetSub("health");
    // Drop it from the address, so a later reload doesn't jump there again.
    var q = new URLSearchParams(location.search); q.delete("drill");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q.toString() : "") + location.hash);
  } catch (e) {}
})();
// Same, when the dashboard was already open: the background only switches its
// #hash (a reload would lose half-typed notes) and leaves the lists in storage.
try {
  chrome.storage.onChanged.addListener(function (ch, area) {
    var v = area === "local" && ch.insGoDrills && ch.insGoDrills.newValue;
    if (!v || !Array.isArray(v.drills) || Date.now() - (Number(v.at) || 0) > 60000) return;
    var want = v.drills.filter(function (d) { return /^(overdue|noest|nodue|blocked)$/.test(d); });
    chrome.storage.local.remove("insGoDrills").catch(function () {});
    if (!want.length) return;
    want.forEach(function (d) { insOpenDrills[d] = true; });
    insSetFilter("", "");
    insGoToDrill(want[0]);
  });
} catch (e) {}
var INS_DRILL_CAP = 60;                  // rows visible in one list at a time
var INS_DRILL_MAX = 400;                 // rows put in the DOM per list (filtering needs them there)

function insTabActive() {
  var p = document.querySelector('.panel[data-panel="insights"]');
  return !!(p && p.classList.contains("on"));
}
function insConnected() { return !!(optClickup && (optClickup.configured || optClickup.state)); }
function insTaskUrl(id) { return "https://app.clickup.com/t/" + id; }
function insHrs(ms) {
  ms = Number(ms) || 0;
  if (ms <= 0) return "0h";
  var m = Math.round(ms / 60000), h = Math.floor(m / 60);
  m = m % 60;
  if (!h) return m + "m";
  return m ? h + "h " + m + "m" : h + "h";
}
function insEsc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
  });
}
function insDateShort(ms) {
  if (!ms) return "";
  try { return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) { return ""; }
}
function insDaysAgo(ms, todayStart) {
  return Math.round((todayStart - new Date(Number(ms)).setHours(0, 0, 0, 0)) / 86400000);
}
function insWhen(at) {
  var s = Math.round((Date.now() - at) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "a minute ago";
  if (s < 3600) return Math.round(s / 60) + " minutes ago";
  try { return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); } catch (e) { return "recently"; }
}

// Tasks that can't move: someone else's subtask is still open (person-blocked) OR
// their own subtasks run past their due date / they're overdue with open subtasks
// (Idea A). Same state.waiting the task rows use for the "waiting" chip - no fetch.
function insBlockedCount(st) {
  var w = st && st.waiting;
  if (!w) return 0;
  var n = 0;
  for (var k in w) {
    if (!Object.prototype.hasOwnProperty.call(w, k)) continue;
    var e = w[k];
    if (!e) continue;
    if ((e.blockers && e.blockers.length) || (e.selfBlock && (e.selfBlock.later || e.selfBlock.parentOverdue))) n++;
  }
  return n;
}

function insWeekBounds(st) {
  var twTo = (st && st.thisWeek && Number(st.thisWeek.toTs)) || 0;
  var nwTo = (st && st.nextWeek && Number(st.nextWeek.toTs)) || 0;
  if (!twTo) {
    var e = new Date(); e.setHours(23, 59, 59, 999);
    e.setDate(e.getDate() + ((7 - e.getDay()) % 7)); // end of this week (Sun)
    twTo = e.getTime();
  }
  if (!nwTo || nwTo <= twTo) nwTo = twTo + 7 * 86400000;
  return { twTo: twTo, nwTo: nwTo, todayStart: new Date().setHours(0, 0, 0, 0) };
}

// Aggregate the open-task rows + state into everything the tab and strip need.
function insBuildModel(rows, st) {
  var b = insWeekBounds(st), todayStart = b.todayStart, twTo = b.twTo, nwTo = b.nwTo;
  var list = [], hasKids = Object.create(null), i, r;
  for (i = 0; i < rows.length; i++) {
    r = rows[i];
    if (!r || r.done) continue;
    if (r.parentId) hasKids[r.parentId] = true;
    list.push({
      id: r.id, name: r.name || "(untitled task)", url: r.url || insTaskUrl(r.id),
      due: Number(r.dueDateMs) || 0, est: Number(r.estimateMs) || 0,
      client: (r.client && String(r.client)) || "(no client)",
      isSubtask: !!r.isSubtask, parentId: r.parentId || null,
    });
  }
  function mk() { return { n: 0, est: 0 }; }
  var buckets = { overdue: mk(), thisWeek: mk(), nextWeek: mk(), later: mk(), noDate: mk() };
  var overdueList = [], noEstList = [], noDueList = [], byClient = Object.create(null);
  var kOverdue = 0, kWeek = 0, kNoEst = 0, kNoDue = 0, openTotal = 0;
  for (i = 0; i < list.length; i++) {
    r = list[i];
    var umbrella = !!hasKids[r.id]; // a parent whose subtasks are in this list
    openTotal++;
    var c = byClient[r.client] || (byClient[r.client] = { name: r.client, open: 0, overdue: 0, noEst: 0, blocked: 0, weekEst: 0 });
    c.open++;
    var bk;
    if (!r.due) bk = "noDate";
    else if (r.due < todayStart) bk = "overdue";
    else if (r.due <= twTo) bk = "thisWeek";
    else if (r.due <= nwTo) bk = "nextWeek";
    else bk = "later";
    buckets[bk].n++;
    if (!umbrella) buckets[bk].est += r.est; // don't double-count umbrella hours
    if (bk === "overdue") { kOverdue++; c.overdue++; overdueList.push(r); }
    if (bk === "thisWeek") { kWeek++; if (!umbrella) c.weekEst += r.est; }
    if (!umbrella && r.est <= 0) { kNoEst++; c.noEst++; noEstList.push(r); }
    if (!umbrella && !r.due) { kNoDue++; noDueList.push(r); }
  }
  var byId = Object.create(null);
  for (i = 0; i < list.length; i++) byId[list[i].id] = list[i];
  var blockedList = [], w = (st && st.waiting) || {};
  for (var key in w) {
    if (!Object.prototype.hasOwnProperty.call(w, key)) continue;
    var e2 = w[key];
    if (!e2) continue;
    var personBlock = e2.blockers && e2.blockers.length, sb = e2.selfBlock;
    var subBlock = sb && (sb.later || sb.parentOverdue);
    if (!personBlock && !subBlock) continue;
    var row = byId[key], reason;
    if (personBlock) {
      var uniq = [];
      e2.blockers.forEach(function (x) { var nm = x.who || x.name; if (nm && uniq.indexOf(nm) < 0) uniq.push(nm); });
      reason = "Waiting on " + (uniq.slice(0, 2).join(", ") || "someone") + (uniq.length > 2 ? " +" + (uniq.length - 2) : "");
    } else if (sb.parentOverdue) {
      reason = "Overdue · " + sb.open + " subtask" + (sb.open === 1 ? "" : "s") + " still open";
    } else {
      reason = sb.later + " subtask" + (sb.later === 1 ? "" : "s") + " due after it" + (sb.latestDueMs ? " (to " + insDateShort(sb.latestDueMs) + ")" : "");
    }
    blockedList.push({ id: key, name: row ? row.name : "(task " + key + ")", url: row ? row.url : insTaskUrl(key), client: row ? row.client : "", reason: reason });
  }
  overdueList.sort(function (a, z) { return a.due - z.due; });
  // Per-client blocked count, so a By client row can jump into the Blocked /
  // waiting list for that client alone. Only rows that HAVE a client are
  // counted: a blocked task that isn't in the open list has no client known
  // (see above), so counting it would promise a row the filter can't show.
  for (i = 0; i < blockedList.length; i++) {
    var bcl = blockedList[i].client;
    if (bcl && byClient[bcl]) byClient[bcl].blocked++;
  }
  var clients = Object.keys(byClient).map(function (kk) { return byClient[kk]; });
  clients.sort(function (a, z) { return (z.overdue - a.overdue) || (z.open - a.open); });
  return {
    k: { overdue: kOverdue, week: kWeek, noEst: kNoEst, noDue: kNoDue, blocked: blockedList.length, open: openTotal },
    buckets: buckets, clients: clients, todayStart: todayStart,
    overdueList: overdueList, noEstList: noEstList, noDueList: noDueList, blockedList: blockedList,
  };
}

// ---- Dashboard health strip (state-only, zero API) ----
function insStateCounts(st) {
  var blocked = insBlockedCount(st);
  var noEst = (st.thisWeek && Number(st.thisWeek.noEstimateCount)) || 0;
  var overdue = 0, noDue = 0;
  if (insCache && insCache.status === "ok" && Array.isArray(insCache.data)) {
    var m = insBuildModel(insCache.data, st);
    overdue = m.k.overdue; noEst = m.k.noEst; noDue = m.k.noDue; blocked = m.k.blocked;
  }
  return { overdue: overdue, blocked: blocked, noEst: noEst, noDue: noDue, total: overdue + blocked + noEst + noDue };
}
function renderDashStrip() {
  var el = document.getElementById("pcmDashStrip");
  if (!el) return;
  var st = optClickup && optClickup.state;
  if (!insConnected() || !st) { el.style.display = "none"; return; }
  var c = insStateCounts(st);
  if (!c.total) { el.style.display = "none"; return; } // don't nag when all is well
  // Each chip is a shortcut: it switches to Insights and opens that exact list.
  var chips = [];
  function chip(n, cls, label, drill) {
    return '<button type="button" class="mini ' + cls + '" data-ds="' + drill +
      '" title="See these ' + n + " in Insights\">" + n + " " + label + "</button>";
  }
  if (c.overdue) chips.push(chip(c.overdue, "red", "overdue", "overdue"));
  if (c.blocked) chips.push(chip(c.blocked, "red", "blocked", "blocked"));
  if (c.noEst) chips.push(chip(c.noEst, "amber", "no estimate", "noest"));
  if (c.noDue) chips.push(chip(c.noDue, "amber", "no due date", "nodue"));
  el.className = "pcm-dash-strip";
  el.innerHTML =
    '<span class="lead"><span style="color:var(--amber)">⚠️</span> Worth a look:</span>' +
    chips.join("") +
    '<span class="grow"><button type="button" class="pds-go" id="pcmDashStripGo">See all insights →</button></span>';
  el.style.display = "flex";
  var go = document.getElementById("pcmDashStripGo");
  if (go) go.onclick = function () { showOptTab("insights"); window.scrollTo({ top: 0 }); };
  el.querySelectorAll("[data-ds]").forEach(function (b) {
    b.onclick = function () { insGoToDrill(b.getAttribute("data-ds")); };
  });
}
// A chip on the Dashboard: show Insights, then open and scroll to that list.
// The drill is remembered rather than opened here, because the tab may still
// have to fetch - insWire applies it as soon as the lists exist.
function insGoToDrill(drill) {
  insSetSub("health"); // the lists live on Health
  insPendingDrill = drill;
  window.scrollTo({ top: 0 });
  showOptTab("insights");
}

// ---- Full Insights tab ----
function insShell(inner) {
  return '<div class="page-h" style="margin:0 0 4px;"><h2 style="margin:0;font-size:18px;">Insights</h2></div>' +
    '<p class="ins-sub">A weekly health check of everything assigned to you.</p>' + inner;
}
function insPaintSubNav() {
  var nav = document.getElementById("insSubNav");
  if (!nav) return;
  var labels = { health: "Health", plan: "Plan", performance: "Performance" };
  nav.innerHTML = INS_SUBS.map(function (s) {
    return '<button type="button" role="tab" data-sub="' + s + '" class="' + (s === insSub ? "on" : "") + '" aria-selected="' + (s === insSub) + '">' + labels[s] + "</button>";
  }).join("");
  nav.querySelectorAll("[data-sub]").forEach(function (b) {
    b.onclick = function () { insSetSub(b.getAttribute("data-sub")); history.replaceState(null, "", "#insights" + (insSub === "health" ? "" : "/" + insSub)); renderInsights(); };
  });
  // One ↻ Refresh for all three: Health + Plan re-read the open tasks (Plan also
  // the developers' dev tasks); Performance re-reads the tracked-time history.
  var rb = document.getElementById("insRefresh");
  if (rb && !rb._busy) {
    rb.title = insSub === "performance" ? "Read your tracked-time history from ClickUp again (at most every 10 minutes)"
      : insSub === "plan" ? "Read your open tasks and the developers' dev tasks from ClickUp again" : "Read your open tasks from ClickUp again";
    rb.onclick = function () {
      var plus = window.PcmInsightsPlus;
      var jobs = insSub === "performance" ? [plus ? plus.refresh("performance") : null]
        : [insFetchOpen(true), insSub === "plan" && plus ? plus.refresh("plan") : null];
      rb._busy = true; rb.disabled = true; rb.textContent = "Refreshing…";
      Promise.all(jobs.map(function (j) { return Promise.resolve(j).catch(function () {}); })).then(function () {
        rb._busy = false; rb.disabled = false; rb.textContent = "↻ Refresh";
        if (insTabActive()) { try { renderInsights(); } catch (e) {} }
      });
    };
  }
}
function renderInsights() {
  var view = document.getElementById("insView");
  if (!view) return;
  insPaintSubNav();
  var plus = document.getElementById("insPlusView");
  if (plus) {
    var other = insSub !== "health" && window.PcmInsightsPlus;
    plus.hidden = !other;
    view.hidden = !!other;
    if (other) { try { window.PcmInsightsPlus.render(insSub, plus); } catch (e) { plus.textContent = "Couldn't show this: " + e.message; } return; }
  }
  var st = (optClickup && optClickup.state) || {};
  if (!insConnected()) {
    view.innerHTML = insShell('<div class="ins-empty">Connect ClickUp first &mdash; open <b>ClickUp setup</b> to sign in. Insights then shows a health check of everything assigned to you.</div>');
    return;
  }
  // Wait for the stored copy first (a few ms), so it paints instead of "Loading…".
  if (!insCache) {
    var waited = insHydrated;
    insHydrate().then(function () { if (insCache && insTabActive()) { try { renderInsights(); } catch (e) {} } });
    if (!waited) { view.innerHTML = insShell('<div class="ins-empty">Loading a health check of your tasks…</div>'); return; }
  }
  var fresh = insCache && insCache.status === "ok" && (Date.now() - insCache.at < INS_TTL);
  // At most one automatic refresh a minute: a failing one must not retry in a loop.
  if (!fresh && !insLoading && Date.now() - insLastAuto > 60000) { insLastAuto = Date.now(); insFetchOpen(false); }
  if (insCache && insCache.status === "ok") {
    var meta = "Updated " + insWhen(insCache.at) + " · one ClickUp fetch, then cached" + (insLoading ? " · refreshing…" : "");
    view.innerHTML = insPaint(insBuildModel(insCache.data, st), st, meta);
    insWire(view);
  } else if (insCache && insCache.status === "err") {
    view.innerHTML = insShell('<div class="ins-empty">Couldn’t load your tasks: ' + insEsc(insCache.error || "unknown error") +
      '<br><br><button type="button" class="lnk" id="insRetry">Try again</button></div>');
    var rt = document.getElementById("insRetry"); if (rt) rt.onclick = function () { insFetchOpen(true); };
  } else {
    view.innerHTML = insShell('<div class="ins-empty">Loading a health check of your tasks…</div>');
  }
}
var insFetchP = null;
function insFetchOpen(force) {
  if (insLoading) return insFetchP;
  insLoading = true;
  if (insTabActive()) { try { renderInsights(); } catch (e) {} }
  return insFetchP = send({ type: "CLICKUP_OPEN_TASKS", force: !!force }, 30000).then(function (r) {
    insLoading = false;
    if (r && r.ok && r.data && Array.isArray(r.data.tasks)) {
      insCache = { status: "ok", data: r.data.tasks, at: Date.now() };
      try { var blob = { at: insCache.at, tasks: r.data.tasks }; if (JSON.stringify(blob).length < 3000000) chrome.storage.local.set({ [INS_STORE]: blob }); } catch (e) {}
    }
    // A failed refresh keeps showing the last good result (with its time) rather than an error.
    else if (!(insCache && insCache.status === "ok")) insCache = { status: "err", error: (r && (r.error || r.reason)) || "No tasks returned", at: Date.now() };
    if (insTabActive()) { try { renderInsights(); } catch (e) {} }
    try { renderDashStrip(); } catch (e) {}
  }).catch(function (e) {
    insLoading = false;
    if (!(insCache && insCache.status === "ok")) insCache = { status: "err", error: String(e && e.message ? e.message : e), at: Date.now() };
    if (insTabActive()) { try { renderInsights(); } catch (e2) {} }
  });
}
function insPaint(m, st, meta) {
  var k = m.k, problems = k.overdue + k.noEst + k.noDue + k.blocked, html = "";
  html += '<div class="page-h" style="display:flex;align-items:center;gap:10px;margin:0 0 4px;"><h2 style="margin:0;font-size:18px;">Insights</h2></div>';
  html += '<p class="ins-sub">A weekly health check of everything assigned to you — the things that are easy to miss until it’s too late. Every number is a shortcut into the details, including the ones in the By client table.</p>';
  if (problems) {
    var bchips = [];
    if (k.overdue) bchips.push('<span class="mini red">' + k.overdue + " overdue</span>");
    if (k.blocked) bchips.push('<span class="mini red">' + k.blocked + " blocked</span>");
    if (k.noEst) bchips.push('<span class="mini amber">' + k.noEst + " missing an estimate</span>");
    if (k.noDue) bchips.push('<span class="mini amber">' + k.noDue + " missing a due date</span>");
    html += '<div class="banner warn"><span class="big">⚠️</span><div><b>' + problems +
      " thing" + (problems === 1 ? "" : "s") + ' could use your attention</b><br><span class="b-sub">' +
      insEsc(meta) + '</span></div><div class="chips">' + bchips.join("") + "</div></div>";
  } else {
    html += '<div class="banner good"><span class="big">✓</span><div><b>All caught up</b><br><span class="b-sub">' +
      "Nothing overdue, everything estimated and dated. " + insEsc(meta) + "</span></div></div>";
  }
  function barCol(cls) { return cls === "red" ? "var(--red)" : cls === "amber" ? "var(--amber)" : cls === "blue" ? "var(--blue)" : "var(--green)"; }
  function barPct(n) { return Math.max(6, Math.min(100, Math.round((n / Math.max(1, k.open)) * 100))); }
  function kpi(cls, n, label, drill, title) {
    var tag = drill ? "button" : "div", attr = drill ? ' type="button" data-drill="' + drill + '"' : "";
    return "<" + tag + ' class="kpi ' + cls + '"' + attr + ' title="' + insEsc(title || "") + '">' +
      (drill ? '<span class="go">details →</span>' : "") +
      '<div class="n">' + n + '</div><div class="l">' + label + '</div>' +
      '<div class="bar"><i style="width:' + barPct(n) + "%;background:" + barCol(cls) + '"></i></div></' + tag + ">";
  }
  html += '<div class="kpis">' +
    kpi("red", k.overdue, "Overdue", k.overdue ? "overdue" : "", "Past their due date and not done") +
    kpi("blue", k.week, "Due this week", "", "Due between today and the end of this week") +
    kpi("amber", k.noEst, "No estimate", k.noEst ? "noest" : "", "Open tasks with no time estimate") +
    kpi("amber", k.noDue, "No due date", k.noDue ? "nodue" : "", "Open tasks with no due date") +
    kpi("red", k.blocked, "Blocked / waiting", k.blocked ? "blocked" : "", "Waiting on someone, or held by their own open subtasks") +
    kpi("green", k.open, "Open total", "", "All open tasks assigned to you") +
    "</div>";
  html += '<div class="cols">' + insWorkloadCard(m) + insHygieneCard(m) + "</div>";
  html += insClientCard(m);
  html += insFilterBar(m);
  html += insDrillsHtml(m);
  return html;
}
function insWorkloadCard(m) {
  var order = [
    { key: "overdue", lab: "Overdue", cls: "od" },
    { key: "thisWeek", lab: "This week", cls: "" },
    { key: "nextWeek", lab: "Next week", cls: "" },
    { key: "later", lab: "Later", cls: "" },
    { key: "noDate", lab: "No date", cls: "nd" },
  ];
  var max = 0, i;
  for (i = 0; i < order.length; i++) max = Math.max(max, m.buckets[order[i].key].est);
  var bars = "";
  for (i = 0; i < order.length; i++) {
    var o = order[i], bk = m.buckets[o.key];
    var pct = max > 0 ? Math.max(bk.est > 0 ? 6 : 0, Math.round((bk.est / max) * 100)) : 0;
    var val = o.key === "noDate" ? "—" : (bk.est > 0 ? insHrs(bk.est) : "—");
    bars += '<div class="wk-day ' + o.cls + '"><div class="wk-cnt">' + bk.n + (bk.n === 1 ? " task" : " tasks") + "</div>" +
      '<div class="wk-bars"><div class="wk-bar est" style="height:' + pct + '%"></div></div>' +
      '<div class="wk-lab">' + o.lab + '</div><div class="wk-val">' + val + "</div></div>";
  }
  return '<div class="card"><div class="dash-h"><div><h3>Workload outlook</h3><p class="hint">Estimated hours waiting for you, by when it’s due</p></div></div>' +
    '<div class="wk-chart">' + bars + "</div>" +
    '<div class="legend"><span><i style="background:color-mix(in srgb,var(--amber) 82%,transparent)"></i>Estimated hours</span>' +
    '<span><i style="background:color-mix(in srgb,var(--red) 78%,transparent)"></i>Overdue</span>' +
    '<span><i style="background:var(--muted);opacity:.5"></i>No due date</span></div></div>';
}
function insHygieneCard(m) {
  var k = m.k;
  function row(cls, n, title, sub, drill) {
    var lnk = (drill && n) ? '<button type="button" class="lnk" data-drill="' + drill + '">Review →</button>' : '<span class="lnk" style="opacity:.4">—</span>';
    return '<div class="hy-row ' + (n ? cls : "muted") + '"><div class="n">' + n + '</div><div class="l">' + title + "<small>" + sub + "</small></div>" + lnk + "</div>";
  }
  var oldest = "None past due";
  if (m.overdueList.length) {
    var d = insDaysAgo(m.overdueList[0].due, m.todayStart);
    oldest = d > 0 ? ("Oldest: " + d + " day" + (d === 1 ? "" : "s") + " past due") : "Due today or just passed";
  }
  return '<div class="card"><div class="dash-h"><div><h3>Needs tidying</h3><p class="hint">Tasks that will skew your day plan</p></div></div>' +
    row("amber", k.noEst, "Missing a time estimate", "Not counted in your daily target", "noest") +
    row("amber", k.noDue, "Missing a due date", "Won’t show in any day / week view", "nodue") +
    row("red", k.overdue, "Overdue and not done", oldest, "overdue") +
    row("red", k.blocked, "Blocked / waiting", "Held by someone else or their own open subtasks", "blocked") + "</div>";
}
function insClientCard(m) {
  if (!m.clients.length) return "";
  // Every count is a shortcut: it narrows the lists below to that client AND
  // opens the matching one. A zero stays plain text - there'd be nothing to
  // show, and a dead button that looks alive is worse than no button.
  function hit(n, cls, drill, client, what) {
    if (!n) return '<span class="badge zero">0</span>';
    return '<button type="button" class="badge ' + cls + '" data-drill="' + drill + '" data-client="' +
      insEsc(client) + '" title="' + insEsc("List the " + n + " " + what + " for " + client) + '">' + n + "</button>";
  }
  function narrow(client, inner, extraCls) {
    return '<button type="button" class="' + extraCls + '" data-client-only="' + insEsc(client) +
      '" title="' + insEsc("Show only " + client + " in the lists below") + '">' + inner + "</button>";
  }
  var maxWeek = 0, i, top = m.clients.slice(0, 8), rows = "";
  for (i = 0; i < top.length; i++) maxWeek = Math.max(maxWeek, top[i].weekEst);
  for (i = 0; i < top.length; i++) {
    var c = top[i];
    var dot = c.overdue ? "var(--red)" : (c.noEst ? "var(--amber)" : "var(--indigo)");
    var wpct = maxWeek > 0 ? Math.round((c.weekEst / maxWeek) * 100) : 0;
    rows += "<tr><td>" +
      narrow(c.name, '<span class="dot" style="background:' + dot + '"></span><span class="nm">' + insEsc(c.name) + "</span>", "client") +
      "</td>" +
      '<td class="num">' + narrow(c.name, String(c.open), "opn") + "</td>" +
      '<td class="num">' + hit(c.overdue, "red", "overdue", c.name, "overdue") + "</td>" +
      '<td class="num">' + hit(c.noEst, "amber", "noest", c.name, "without an estimate") + "</td>" +
      '<td class="num">' + hit(c.blocked, "red", "blocked", c.name, "blocked or waiting") + "</td>" +
      '<td><div class="cell-bar"><i style="width:' + wpct + '%"></i></div></td></tr>';
  }
  var note = m.clients.length > 8 ? '<span class="hint">top 8 of ' + m.clients.length + "</span>" : '<span class="hint">sorted by overdue</span>';
  return '<div class="card" style="margin-top:18px"><div class="dash-h"><div><h3>By client</h3><p class="hint">Where the open work and overdue items are piling up — click a number to list just that client’s tasks</p></div><span class="spacer"></span>' + note + "</div>" +
    '<table class="hot"><thead><tr><th>Client</th><th class="num">Open</th><th class="num">Overdue</th><th class="num">No est.</th><th class="num">Blocked</th><th>This week’s load</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
}
// The one filter bar for all four lists below it. A <select> rather than chips
// because a long client list has to stay findable; alphabetical for the same
// reason, even though the table above is sorted by overdue.
function insFilterBar(m) {
  if (!m.clients.length) return "";
  var sorted = m.clients.slice().sort(function (a, z) { return String(a.name).localeCompare(String(z.name)); });
  var opts = '<option value="">All clients</option>', i, c;
  for (i = 0; i < sorted.length; i++) {
    c = sorted[i];
    opts += '<option value="' + insEsc(c.name) + '">' + insEsc(c.name) + " (" + c.open + ")</option>";
  }
  return '<div class="ins-filter" id="insFilterBar"><span class="f-lab">Narrow the lists below</span>' +
    '<select id="insFClient" class="f-sel" aria-label="Show one client only">' + opts + "</select>" +
    '<input id="insFQ" class="f-q" type="search" placeholder="Search a task name, client or reason…" aria-label="Search the lists below">' +
    '<span class="f-stat" id="insFStat"></span>' +
    '<button type="button" class="lnk" id="insFClear" hidden>Clear</button></div>';
}
function insDrillsHtml(m) {
  // fmt returns `plain`: the sub-line as RAW text. insDrill escapes it once for
  // display and lower-cases it into the search haystack, so searching matches
  // what the eye reads ("waiting on", a date, a client) and nothing is
  // double-escaped.
  var out = "";
  out += insDrill("overdue", "Overdue tasks", m.overdueList, function (r) {
    var d = insDaysAgo(r.due, m.todayStart);
    return { badge: '<span class="badge red">' + (d > 0 ? d + "d" : "due") + "</span>",
      plain: "due " + insDateShort(r.due) + (r.est ? " · " + insHrs(r.est) : " · no est"), action: "Change due date", act: "due" };
  });
  out += insDrill("blocked", "Blocked / waiting", m.blockedList, function (r) {
    return { badge: '<span class="badge red">held</span>', plain: r.reason, action: "Open" };
  });
  out += insDrill("noest", "Missing an estimate", m.noEstList, function (r) {
    return { badge: '<span class="badge amber">no est</span>',
      plain: r.due ? "due " + insDateShort(r.due) : "no due date", action: "Add estimate", act: "est" };
  });
  out += insDrill("nodue", "Missing a due date", m.noDueList, function (r) {
    return { badge: '<span class="badge amber">no date</span>',
      plain: r.est ? insHrs(r.est) : "no estimate", action: "Set due date", act: "due" };
  });
  return out;
}
// Every row goes in the DOM (up to INS_DRILL_MAX) and insApplyFilter decides
// which INS_DRILL_CAP of them are visible. Rendering only the first 60 would
// mean a client filter found nothing for anyone further down the list.
function insDrill(id, label, listArr, fmt) {
  var n = listArr.length, rendered = Math.min(n, INS_DRILL_MAX), body = "", i;
  for (i = 0; i < rendered; i++) {
    var r = listArr[i], f = fmt(r), plain = f.plain || "", client = r.client || "";
    var hay = ((r.name || "") + " " + client + " " + plain).toLowerCase();
    // The name opens the task in ClickUp; the action does the fix right here
    // (an estimate box, or the extension's own calendar) - see insRowAction.
    body += '<div class="trow" data-client="' + insEsc(client) + '" data-hay="' + insEsc(hay) + '"' + (r.id ? ' data-id="' + insEsc(r.id) + '"' : "") + ' data-due="' + (Number(r.due) || 0) + '">' +
      f.badge + '<div class="ttl"><b>' + (r.url ? '<a class="ttl-a" href="' + insEsc(r.url) + '" target="_blank" rel="noopener" title="Open in ClickUp">' + insEsc(r.name) + "</a>" : insEsc(r.name)) + "</b><small>" +
      (client ? insEsc(client) + " · " : "") + insEsc(plain) + "</small></div>" +
      (f.act && r.id
        ? '<button type="button" class="lnk ins-act" data-act="' + f.act + '">' + f.action + "</button>"
        : '<a class="lnk" href="' + insEsc(r.url) + '" target="_blank" rel="noopener">' + f.action + "</a>") + "</div>";
  }
  body += '<div class="det-more" data-more hidden></div>' +
    '<div class="det-more" data-none hidden>No task in this list matches the filter above.</div>';
  if (!n) body += '<div class="det-more">Nothing here — nice.</div>';
  return '<details class="ins-det" data-drill="' + id + '"><summary><span class="caret">▸</span> ' + label +
    ' <span class="count" data-count>(' + n + ')</span></summary>' +
    '<div class="det-body" data-total="' + n + '">' + body + "</div></details>";
}
// One row against the current filter. Pure, so the rule is testable: a row with
// no known client (a blocked task that isn't in the open list) matches only
// "All clients", which is exactly what the By client counts promise.
function insRowMatches(rowClient, hay, client, q) {
  if (client && rowClient !== client) return false;
  if (q && String(hay || "").indexOf(q) < 0) return false;
  return true;
}
// Narrow the lists IN PLACE - no repaint, so typing never loses focus and the
// sections the user opened stay open. The KPIs and the By client table are left
// alone on purpose: they're the whole-board picture the filter is read against.
function insApplyFilter() {
  var view = document.getElementById("insView");
  if (!view) return;
  var client = insFilter.client || "", q = (insFilter.q || "").trim().toLowerCase();
  var active = !!(client || q), hitAll = 0, totalAll = 0;
  view.querySelectorAll("details.ins-det").forEach(function (d) {
    var rows = d.querySelectorAll(".trow"), hit = 0, i, r;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (insRowMatches(r.getAttribute("data-client"), r.getAttribute("data-hay"), client, q)) {
        hit++;
        r.style.display = hit > INS_DRILL_CAP ? "none" : "";
      } else r.style.display = "none";
    }
    var body = d.querySelector(".det-body");
    var total = Number(body && body.getAttribute("data-total")) || 0;
    hitAll += hit; totalAll += total;
    var cnt = d.querySelector("[data-count]");
    if (cnt) cnt.textContent = active ? "(" + hit + " of " + total + ")" : "(" + total + ")";
    var more = d.querySelector("[data-more]");
    if (more) {
      // Rows past INS_DRILL_MAX were never put in the DOM, so they can only be
      // counted while nothing is filtered (lists that long don't happen today).
      var extra = (hit - Math.min(hit, INS_DRILL_CAP)) + (active ? 0 : total - rows.length);
      more.hidden = extra <= 0;
      more.textContent = "+ " + extra + " more" + (active ? " match" + (extra === 1 ? "" : "es") : "");
    }
    var none = d.querySelector("[data-none]");
    if (none) none.hidden = !(active && total > 0 && hit === 0);
  });
  var bar = document.getElementById("insFilterBar");
  if (bar) bar.classList.toggle("on", active);
  var stat = document.getElementById("insFStat");
  if (stat) stat.textContent = active ? hitAll + " of " + totalAll + " listed row" + (totalAll === 1 ? "" : "s") + " match" : "";
  var clr = document.getElementById("insFClear");
  if (clr) clr.hidden = !active;
}
function insSetFilter(client, q) {
  insFilter.client = client || "";
  insFilter.q = q || "";
  var sel = document.getElementById("insFClient");
  if (sel) sel.value = insFilter.client;
  var box = document.getElementById("insFQ");
  if (box) box.value = insFilter.q;
  insApplyFilter();
}
function insWire(view) {
  view.querySelectorAll("[data-drill]").forEach(function (el) {
    if (el.tagName === "DETAILS") {
      // Put back what the user had open: a repaint (a background ClickUp
      // refresh) used to collapse every section out from under them.
      el.open = !!insOpenDrills[el.getAttribute("data-drill")];
      el.addEventListener("toggle", function () { insOpenDrills[el.getAttribute("data-drill")] = el.open; });
      return;
    }
    el.onclick = function () { insOpenDrill(el.getAttribute("data-drill"), el.getAttribute("data-client")); };
  });
  // A client name or its Open count narrows the lists without picking one.
  view.querySelectorAll("[data-client-only]").forEach(function (el) {
    el.onclick = function () {
      insSetFilter(el.getAttribute("data-client-only"), "");
      var bar = document.getElementById("insFilterBar");
      if (!bar) return;
      try { bar.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { bar.scrollIntoView(); }
    };
  });
  var sel = document.getElementById("insFClient");
  if (sel) {
    sel.value = insFilter.client;
    if (sel.value !== insFilter.client) insFilter.client = ""; // that client is gone from the data
    sel.onchange = function () { insFilter.client = sel.value || ""; insApplyFilter(); };
  }
  var box = document.getElementById("insFQ");
  if (box) {
    box.value = insFilter.q;
    box.oninput = function () { insFilter.q = box.value || ""; insApplyFilter(); };
  }
  var clr = document.getElementById("insFClear");
  if (clr) clr.onclick = function () { insSetFilter("", ""); };
  view.querySelectorAll(".ins-act").forEach(function (b) { b.onclick = function (e) { e.preventDefault(); insRowAction(b); }; });
  insApplyFilter();
  if (insPendingDrill) { var p = insPendingDrill; insPendingDrill = ""; insOpenDrill(p, ""); }
}
// "Add estimate" / "Set due date" / "Change due date" in the Insights lists:
// done right here instead of opening ClickUp. Saved with the same messages the
// task lists use; the row then says what was saved and leaves its list.
function insRowDone(row, text) {
  row.classList.add("ins-fixed");
  var a = row.querySelector(".ins-act, .ins-estbox");
  var ok = document.createElement("span");
  ok.className = "ins-ok";
  ok.textContent = "✓ " + text;
  if (a) a.replaceWith(ok); else row.appendChild(ok);
  var det = row.closest("details.ins-det");
  setTimeout(function () {
    row.remove();
    if (!det) return;
    var c = det.querySelector("[data-count]"), body = det.querySelector(".det-body");
    var n = Math.max(0, (Number(body && body.getAttribute("data-total")) || 1) - 1);
    if (body) body.setAttribute("data-total", String(n));
    if (c) c.textContent = "(" + n + ")";
    insApplyFilter();
  }, 1800);
}
// The fix is also written into the cached task list Insights is drawn from, or
// the next repaint (a background refresh lands within seconds) put the row back.
function insPatchCache(id, patch) {
  if (!insCache || !Array.isArray(insCache.data)) return;
  for (var i = 0; i < insCache.data.length; i++) {
    var t = insCache.data[i];
    if (t && String(t.id) === String(id)) { for (var k in patch) t[k] = patch[k]; }
  }
}
function insRowAction(btn) {
  var row = btn.closest(".trow");
  if (!row || row._busy) return;
  var id = row.getAttribute("data-id");
  if (!id) return;
  if (btn.getAttribute("data-act") === "est") {
    var box = document.createElement("span");
    box.className = "ins-estbox";
    box.innerHTML = '<input type="text" class="est-input" placeholder="e.g. 1h 30m" aria-label="Estimate"><button type="button" class="lnk">Save</button>';
    btn.replaceWith(box);
    var inp = box.querySelector("input"), go = box.querySelector("button");
    var back = function () { if (!row._busy && box.isConnected) box.replaceWith(btn); };
    var save = async function () {
      var ms = parseFlexDurationOpt(inp.value.trim());
      if (ms == null || ms <= 0) { inp.title = "Type a time like 20m, 1h 30m or 1.5"; inp.focus(); inp.select(); return; }
      row._busy = true; inp.disabled = true; go.disabled = true; go.textContent = "Saving…";
      var r = await send({ type: "SET_CLICKUP_ESTIMATE", taskId: String(id), estimateMs: ms }, 15000).catch(function () { return null; });
      if (r && r.ok) { insPatchCache(id, { estimateMs: ms, totalEstimateMs: ms }); insRowDone(row, "estimate " + fmtDurOpt(ms) + " saved"); return; }
      row._busy = false; inp.disabled = false; go.disabled = false; go.textContent = "Save";
      inp.title = "Couldn't save" + (r && r.status ? " (HTTP " + r.status + ")" : "") + " - try again";
      inp.style.borderColor = "var(--red)";
    };
    go.onclick = save;
    inp.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); back(); } };
    inp.onblur = function () { setTimeout(function () { if (!inp.value.trim() && document.activeElement !== go) back(); }, 150); };
    inp.focus();
    return;
  }
  // Due date: the extension's own calendar (holidays, work-from-home, how full
  // each day is); keeps the task's time of day, midday if it had none.
  var prev = Number(row.getAttribute("data-due")) || 0;
  var saveDue = async function (dayMs) {
    if (!dayMs) return;
    var d = new Date(dayMs), k = prev ? new Date(prev) : null;
    var at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), k ? k.getHours() : 12, k ? k.getMinutes() : 0, 0, 0).getTime();
    row._busy = true; btn.disabled = true; btn.textContent = "Saving…";
    var r = await send({ type: "CLICKUP_SET_DUE", taskId: String(id), dueMs: at }, 15000).catch(function () { return null; });
    if (r && r.ok) {
      insPatchCache(id, { dueDateMs: at });
      var stillLate = at < new Date().setHours(0, 0, 0, 0);
      if (stillLate) { prev = at; row.setAttribute("data-due", String(at)); row._busy = false; btn.disabled = false; btn.textContent = "Saved - still overdue, change again"; return; }
      insRowDone(row, "due " + insDateShort(at) + " saved"); return;
    }
    row._busy = false; btn.disabled = false; btn.textContent = "Couldn't save - try again";
  };
  if (window.PcmCalendar && typeof window.PcmCalendar.pick === "function") {
    window.PcmCalendar.pick(btn, { value: prev, canClear: false, onPick: saveDue, onClose: function () {} });
    return;
  }
  var di = document.createElement("input");
  di.type = "date";
  di.onchange = function () { if (di.value) saveDue(new Date(di.value + "T00:00:00").getTime()); };
  btn.after(di);
  try { di.showPicker(); } catch (e) { di.focus(); }
}
// client "" (a KPI card, the hygiene card, a Dashboard chip) means the whole
// board. Either way the shortcut sets the filter outright, including clearing
// any search text, so what opens is always exactly what the number promised.
function insOpenDrill(drill, client) {
  insSetFilter(client || "", "");
  var d = document.querySelector('#insView details.ins-det[data-drill="' + drill + '"]');
  if (!d) return;
  d.open = true;
  insOpenDrills[drill] = true;
  try { d.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) { d.scrollIntoView(); }
}
(async function initOptCuFilter() {
  const btn = $("optCuFilterBtn");
  const menu = $("optCuFilterMenu");
  if (!btn || !menu) return;
  try {
    const got = await chrome.storage.local.get(["cuFilter", "cuDueTodayOnly", "cuFilterDefault", "cuManualOrder"]);
    if (got.cuManualOrder && typeof got.cuManualOrder === "object") cuManualOrderOpt = got.cuManualOrder;
    // Nothing saved yet on this machine: start from the user's own default.
    if (!got.cuFilter && got.cuFilterDefault) cuApplyFilterSnapshot(got.cuFilterDefault);
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
  const saveDefBtn = menu.querySelector("[data-fsavedef]");
  if (saveDefBtn) saveDefBtn.onclick = (e) => {
    e.stopPropagation();
    cuSaveDefaultFilter();
    saveDefBtn.textContent = "Saved \u2713";
    setTimeout(() => { saveDefBtn.textContent = "Save default"; }, 1600);
  };
  const useDefBtn = menu.querySelector("[data-fusedef]");
  if (useDefBtn) useDefBtn.onclick = async (e) => {
    e.stopPropagation();
    const ok = await cuUseDefaultFilter();
    useDefBtn.textContent = ok ? "Applied \u2713" : "None saved";
    setTimeout(() => { useDefBtn.textContent = "Use default"; }, 1600);
    cuPaintClearBtn(menu);
  };
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
    else if (el.hasAttribute("data-cf-client-all")) cuFilter.clients = el.checked
      ? [...menu.querySelectorAll("input[data-cf-client]")].map((x) => x.getAttribute("data-cf-client"))
      : [];
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
      if (st) {
        optClickup = st.clickup || {};
        cuAutoPaint = true;
        try { renderClickupSettings(optClickup); } finally { cuAutoPaint = false; }
        try { renderDashStrip(); } catch (e) {} try { if (insTabActive()) renderInsights(); } catch (e) {}
      }
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
  // A settings change can alter how totals are counted (see the parent/subtask
  // estimate rule), so drop the views this page caches itself and refetch.
  if (changes.settings) {
    cuCustomCache = { key: "", status: "", data: null, at: 0 };
    cuOverdueCache = { status: "", data: null, at: 0 };
    if (optClickup && optClickup.state) renderClickupPreview(optClickup.state);
  }
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
  if (changes.clickupState) { cuOverdueInvalidate(); cuTomorrowInvalidate(); scheduleClickupUiRefresh(); }
  // Recently completed: a refresh recorded new completions (or the first sync
  // landed) - repaint the card straight from storage.
  if (changes.cuDoneHistory) {
    cuDoneRowsOpt = Array.isArray(changes.cuDoneHistory.newValue) ? changes.cuDoneHistory.newValue : [];
    cuDoneState = "ok";
    renderDoneHistory();
  } else if (changes.clickupState && cuDoneState !== "ok") cuLoadDoneHistory().then(renderDoneHistory);
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
  // A drag in the popup / side panel (or a Drive restore) changed the custom
  // order: repaint from it, unless a drag is in progress here right now.
  if (changes.cuManualOrder && changes.cuManualOrder.newValue && typeof changes.cuManualOrder.newValue === "object") {
    cuManualOrderOpt = changes.cuManualOrder.newValue;
    if (!cuDraggingOpt && cuFilter.manualOrder) optRepaintCuPreview();
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
  smLoadedText = $("siteMonitorUrls").value;
  renderSiteMonitorStatus(cfg);
}
// Sites can arrive while this page is open (the team's client list). Show them,
// unless the box has unsaved edits - otherwise saving the old list would drop them.
let smLoadedText = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.siteMonitorConfig || !$("siteMonitorUrls")) return;
  const nv = ch.siteMonitorConfig.newValue;
  const box = $("siteMonitorUrls").value;
  // Unchanged since loaded, or just saved from here: safe to refresh.
  if (box === smLoadedText || box === smFormatLines(nv && Array.isArray(nv.sites) ? nv.sites : [])) loadSiteMonitorConfig();
});

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
      const statusText = st.up === true ? "✅ Up" : st.up === false ? (st.blank || st.kind === "blank" ? "⚠️ Blank page" : st.kind === "5xx" ? "🔥 Server error" + (st.status ? " (HTTP " + st.status + ")" : "") : "🚨 Down") : "⚪ Not checked yet";
      const lastCheckText = st.lastCheck ? new Date(st.lastCheck).toLocaleString() : "never";
      const label = s.name && s.name !== s.url ? escapeHtml(s.name) + ' <span class="hint">' + escapeHtml(s.url) + "</span>" : escapeHtml(s.url);
      const why = st.lastError ? ' · <span class="sm-err">' + escapeHtml(st.lastError) + "</span>"
        : st.blocked ? ' · <span class="sm-err" title="The site is up, but its security is blocking or challenging this computer (it fetches the page every few minutes, which can look like a bot). No alarm is raised for this. If it keeps happening, ask whoever manages the site to allow this office\'s IP.">' + escapeHtml(st.blocked) + " (site is up - not an outage)</span>" : "";
      const speed = st.up === true && st.lastMs ? " · " + (st.lastMs < 1000 ? st.lastMs + "ms" : (st.lastMs / 1000).toFixed(1) + "s") : "";
      const u = escapeHtml(s.url);
      return '<div class="imp-row" data-sm-row="' + u + '"><div class="imp-entry"><b>' + label + '</b><br><span class="hint">' + statusText + speed + " · last check: " + lastCheckText + (st.fails && st.up !== false ? " · " + st.fails + " failed check(s)" : "") + why + "</span></div>"
        + '<div class="sm-acts"><button type="button" class="sm-check" data-sm-url="' + u + '" title="Check this site right now">Check</button>'
        + '<button type="button" class="sm-act" data-sm-edit="' + u + '" title="Change the client name or website">Edit</button>'
        + '<button type="button" class="sm-act sm-del" data-sm-del="' + u + '" title="Stop monitoring this site">Delete</button></div></div>';
    }).join("");
    el.innerHTML = '<div class="sm-headrow"><div class="cu-subhead">Current status</div><button type="button" class="sm-act" data-sm-add="1">+ Add site</button></div><div id="smBlankLine" class="hint"></div><div id="smAddSlot"></div>' + rows;
    smPaintBlankLine(cfg.sites);
  }).catch(() => {
    el.innerHTML = '<p class="hint">Could not fetch state.</p>';
  });
}

// Blank-page check: a site can answer "200 OK" with an empty page (WordPress
// white screen) and still look up. Reading the page needs Chrome's permission
// for each monitored site (optional, asked only here, only for these sites).
// Same patterns as background.js siteReadOrigins.
function smReadOrigins(url) {
  try { const h = new URL(url).hostname.replace(/^www\./i, ""); return ["*://" + h + "/*", "*://www." + h + "/*"]; } catch (e) { return []; }
}
async function smPaintBlankLine(sites) {
  const line = $("smBlankLine");
  if (!line || !chrome.permissions) return;
  const missing = [];
  for (const s of sites || []) {
    const o = smReadOrigins(s.url);
    if (!o.length) continue;
    let has = false;
    try { has = await chrome.permissions.contains({ origins: o }); } catch (e) {}
    if (!has) missing.push(s);
  }
  line.textContent = "";
  line.style.margin = "4px 0 8px";
  // Part of every automatic check (every 5 minutes), nothing to switch on. It
  // can only be missing if the extension wasn't reloaded after the update, or
  // its site access was limited in chrome://extensions - say how to fix that.
  if (!missing.length) { line.textContent = "🔎 Each automatic check also looks at the page: a site that answers but shows an empty or error page is marked ⚠️ Blank page."; return; }
  line.textContent = "🔎 The blank-page check can't read " + (missing.length === sites.length ? "these sites" : missing.length + " of these sites") +
    " yet, so an empty page would still look Up. Reload the extension (chrome://extensions › ⟳), or set its Site access to \"On all sites\" in Details.";
}

// "Check now": one site (row button) or all (Check all now). Runs the same check
// as the 5-minute alarm, but decides up/down immediately (no 2-checks-in-a-row
// wait); it notifies only when the status actually changed.
async function smCheckNow(url, btn) {
  const btns = url ? [btn] : [btn].concat([...document.querySelectorAll("#siteMonitorStatus .sm-check")]);
  const old = btns.map((b) => b && b.textContent);
  btns.forEach((b) => { if (b) { b.disabled = true; b.textContent = "Checking…"; } });
  let r = null;
  try { r = await send({ type: "SITE_MONITOR_CHECK_NOW", url: url || "" }); } catch (e) {}
  btns.forEach((b, i) => { if (b) { b.disabled = false; b.textContent = old[i]; } });
  let cfg = null;
  try { const c = await chrome.storage.local.get("siteMonitorConfig"); cfg = c.siteMonitorConfig || null; } catch (e) {}
  renderSiteMonitorStatus(cfg ? Object.assign({}, cfg, { enabled: true }) : cfg);
  const s = r && r.summary;
  if (!r || !r.ok || !s) smHint("Couldn't run the check" + (r && r.reason ? ": " + r.reason : "."));
  else if (s.offline) smHint("This computer looks offline, so nothing was marked down. Check your connection and try again.");
  else if (!url) smHint("Checked " + s.checked + " site(s) just now: " + s.up + " up" + (s.down ? ", " + s.down + " down" : "") + ".");
}
if ($("siteMonitorCheckAll")) $("siteMonitorCheckAll").onclick = (e) => smCheckNow("", e.currentTarget);
// Add / Edit / Delete from the status list. Each one rewrites the "Monitored
// sites" box and then runs the normal Save, so names, duplicates, the alarm and
// the Drive backup all go through exactly the same path as typing in the box.
function smLinesWithout(url) {
  return $("siteMonitorUrls").value.split("\n").filter((l) => { const p = smParseLine(l); return !(p && p.url === url); });
}
async function smApplyLines(lines, msg) {
  $("siteMonitorUrls").value = lines.map((l) => l.trim()).filter(Boolean).join("\n");
  await saveSiteMonitorConfig();
  if (msg) smHint(msg);
}
function smSiteForm(name, url, onSave) {
  const wrap = document.createElement("div");
  wrap.className = "sm-form";
  const n = document.createElement("input");
  n.placeholder = "Client name"; n.value = name || "";
  const u = document.createElement("input");
  u.placeholder = "https://clientsite.com"; u.value = url || "";
  const save = document.createElement("button");
  save.type = "button"; save.className = "sm-act primary"; save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.className = "sm-act"; cancel.textContent = "Cancel";
  const err = document.createElement("span");
  err.className = "hint sm-err";
  const go = async () => {
    const p = smParseLine(u.value.trim());
    if (!p) { err.textContent = "Enter a website, e.g. https://clientsite.com"; u.focus(); return; }
    save.disabled = true;
    await onSave(n.value.trim(), p.url);
  };
  save.onclick = go;
  for (const i of [n, u]) i.onkeydown = (e) => { if (e.key === "Enter") go(); if (e.key === "Escape") cancel.click(); };
  u.oninput = () => { err.textContent = ""; };
  wrap.append(n, u, save, cancel, err);
  return { wrap, cancel, first: name ? u : n };
}
if ($("siteMonitorStatus")) $("siteMonitorStatus").addEventListener("click", async (e) => {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  const chk = t.closest(".sm-check");
  if (chk && !chk.disabled) { smCheckNow(chk.dataset.smUrl, chk); return; }
  const add = t.closest("[data-sm-add]");
  if (add) {
    const slot = $("smAddSlot");
    if (!slot || slot.firstChild) return;
    const row = document.createElement("div");
    row.className = "imp-row";
    const f = smSiteForm("", "", async (name, url) => {
      const exists = smLinesWithout(url).length !== $("siteMonitorUrls").value.split("\n").length;
      if (exists) { smHint("That website is already in the list."); f.cancel.click(); return; }
      const lines = $("siteMonitorUrls").value.split("\n");
      lines.push((name ? name + " | " : "") + url);
      await smApplyLines(lines, "Added " + (name || url) + ". It's checked on the next run, or click Check.");
    });
    f.cancel.onclick = () => { slot.textContent = ""; };
    row.appendChild(f.wrap);
    slot.appendChild(row);
    f.first.focus();
    return;
  }
  const ed = t.closest("[data-sm-edit]");
  if (ed) {
    const url = ed.dataset.smEdit;
    const row = ed.closest(".imp-row");
    // Prefill from the "Monitored sites" box - the same text the save reads.
    const line = $("siteMonitorUrls").value.split("\n").map((l) => smParseLine(l)).find((p) => p && p.url === url);
    const site = { url, name: (line && line.name) || smSiteNames[url] || "" };
    const keep = [...row.childNodes];
    row.textContent = "";
    const f = smSiteForm(site.name && site.name !== site.url ? site.name : "", site.url, async (name, newUrl) => {
      const lines = $("siteMonitorUrls").value.split("\n").map((l) => {
        const p = smParseLine(l);
        return p && p.url === url ? (name ? name + " | " : "") + newUrl : l;
      });
      if (name) smSiteNames[newUrl] = name;
      await smApplyLines(lines, "Saved " + (name || newUrl) + ".");
    });
    f.cancel.onclick = () => { row.textContent = ""; keep.forEach((k) => row.appendChild(k)); };
    row.appendChild(f.wrap);
    f.first.focus();
    return;
  }
  const del = t.closest("[data-sm-del]");
  if (del) {
    const url = del.dataset.smDel;
    const acts = del.closest(".sm-acts");
    const keep = [...acts.childNodes];
    acts.textContent = "";
    const q = document.createElement("span");
    q.className = "hint";
    q.textContent = "Remove this site?";
    const yes = document.createElement("button");
    yes.type = "button"; yes.className = "sm-act sm-del"; yes.textContent = "Remove";
    const no = document.createElement("button");
    no.type = "button"; no.className = "sm-act"; no.textContent = "Cancel";
    yes.onclick = async () => { yes.disabled = true; await smApplyLines(smLinesWithout(url), "Removed " + url + " from monitoring."); };
    no.onclick = () => { acts.textContent = ""; keep.forEach((k) => acts.appendChild(k)); };
    acts.append(q, yes, no);
  }
});

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
  optFltPeople = [];
  savePeople();
  if ($("optFltPeopleWrap")) $("optFltPeopleWrap").style.display = "none";
  closePeopleMenu();
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
const OPT_TABS = ["dashboard", "insights", "clickup", "agent", "sites", "hub", "reminders", "files", "bulk", "admin", "general"];
function showOptTab(name) {
  // "insights/plan" = the Insights tab on its Plan sub-tab (links, notifications).
  const subM = /^insights\/(health|plan|performance)$/.exec(String(name || ""));
  if (subM) { insSetSub(subM[1]); name = "insights"; }
  if (!OPT_TABS.includes(name)) name = "dashboard";
  document.querySelectorAll("#sideNav [data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".panel[data-panel]").forEach((p) => p.classList.toggle("on", p.dataset.panel === name));
  try { renderDashStrip(); } catch (e) {}
  if (name === "insights") { try { renderInsights(); } catch (e) {} }
  try { localStorage.setItem("optTab", name); } catch (e) {}
  const want = "#" + name + (name === "insights" && insSub !== "health" ? "/" + insSub : "");
  if (location.hash !== want) history.replaceState(null, "", want);
}
if (document.body.classList.contains("tabbed")) {
  document.querySelectorAll("#sideNav [data-tab]").forEach((b) => { b.onclick = () => { showOptTab(b.dataset.tab); window.scrollTo({ top: 0 }); }; });
  document.querySelectorAll("[data-goto]").forEach((b) => { b.onclick = () => showOptTab(b.dataset.goto); });
  let first = (location.hash || "").replace("#", "");
  if (!OPT_TABS.includes(first) && !/^insights\/(health|plan|performance)$/.test(first)) { try { first = localStorage.getItem("optTab") || ""; } catch (e) { first = ""; } }
  showOptTab(first || "dashboard");
  window.addEventListener("hashchange", () => showOptTab((location.hash || "").replace("#", "")));
}

// Dashboard refresh + General "Save" reuse the existing handlers.
// Status next to a refresh button, so a click never looks like it did nothing.
function refreshSay(btn) {
  let s = btn.parentNode && btn.parentNode.querySelector(":scope > .refresh-msg");
  if (!s) {
    s = document.createElement("span");
    s.className = "refresh-msg";
    s.style.cssText = "font-size:11.5px;margin:0 6px;white-space:nowrap;";
    btn.after(s);
  }
  clearTimeout(s._t);
  return (text, kind) => {
    s.textContent = text || "";
    s.style.color = kind === "err" ? "var(--red, #dc2626)" : kind === "ok" ? "var(--green, #16a34a)" : "var(--muted)";
    if (kind === "ok") s._t = setTimeout(() => { s.textContent = ""; }, 5000);
  };
}
// Dashboard ↻: refresh from ClickUp right here (it used to press the hidden
// "Refresh now" button on the ClickUp setup tab, so nothing visible happened).
if ($("dashRefresh")) $("dashRefresh").onclick = async () => {
  const b = $("dashRefresh");
  if (b.classList.contains("spin")) return;
  const say = refreshSay(b);
  b.classList.add("spin"); b.disabled = true;
  say("Refreshing from ClickUp…");
  try {
    const res = await send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeekly: true, forceWeeks: true }, 25000);
    if (res && res.ok && res.data) {
      renderClickupPreview(res.data);
      say("Updated " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + " ✓", "ok");
    } else {
      await load();
      say("Couldn't refresh: " + ((res && (res.error || res.reason)) || "no answer") + ". Showing the last numbers.", "err");
    }
  } catch (e) {
    say("No answer from the extension - reloading this page…", "err");
    setTimeout(() => location.reload(), 900);
    return;
  }
  b.classList.remove("spin"); b.disabled = false;
  // That refresh recorded every task that came back done, so the history card may
  // have gained rows. Re-read it from storage - no ClickUp request (see
  // cuLoadDoneHistory).
  cuLoadDoneHistory().then(renderDoneHistory);
};

// Task search box. Repaints from the state already in memory (optRepaintCuPreview
// never fetches), debounced only so a fast typist doesn't redraw on every key.
if ($("dashSearch")) {
  const inp = $("dashSearch");
  let t = null;
  inp.oninput = () => {
    cuSearchOpt = inp.value || "";
    clearTimeout(t);
    t = setTimeout(() => optRepaintCuPreview(), 120);
  };
  // Esc clears it. Without this the only way back to the full list is to select
  // the text and delete it, which is easy to miss.
  inp.onkeydown = (e) => {
    if (e.key !== "Escape" || !inp.value) return;
    e.preventDefault();
    e.stopPropagation();
    inp.value = "";
    cuSearchOpt = "";
    clearTimeout(t);
    optRepaintCuPreview();
  };
}

// Recently completed card: its own search over the saved history, a Clear, and a
// first load. All three are storage-only - the card can be searched and emptied
// without spending any of the ClickUp rate limit, which is what was asked for.
if ($("dashDoneSearch")) {
  const inp = $("dashDoneSearch");
  let t = null;
  inp.oninput = () => {
    cuDoneSearchOpt = inp.value || "";
    clearTimeout(t);
    t = setTimeout(() => renderDoneHistory(), 120);
  };
  inp.onkeydown = (e) => {
    if (e.key !== "Escape" || !inp.value) return;
    e.preventDefault();
    e.stopPropagation();
    inp.value = "";
    cuDoneSearchOpt = "";
    clearTimeout(t);
    renderDoneHistory();
  };
}
if ($("dashDoneClear")) $("dashDoneClear").onclick = async () => {
  const b = $("dashDoneClear");
  const n = Array.isArray(cuDoneRowsOpt) ? cuDoneRowsOpt.length : 0;
  if (!n) return;
  // Forgetting the history can't be undone (the rows only existed here), so ask -
  // but say plainly that ClickUp itself is untouched, or it reads like it might
  // un-complete the tasks.
  if (!confirm("Forget the " + n + (n === 1 ? " completed task" : " completed tasks") + " saved here?\n\nNothing changes in ClickUp - this only empties this list. It fills up again from the completed tasks the extension sees.")) return;
  b.disabled = true;
  try { await chrome.runtime.sendMessage({ type: "CLICKUP_DONE_HISTORY_CLEAR" }); } catch (e) {}
  cuDoneRowsOpt = [];
  cuDoneSearchOpt = "";
  if ($("dashDoneSearch")) $("dashDoneSearch").value = "";
  renderDoneHistory();
  b.disabled = false;
};
// One storage read at boot, so the card is already right when it's expanded for
// the first time (it starts collapsed, and reading it costs nothing).
cuLoadDoneHistory().then(renderDoneHistory);
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
// ---- automatic updates: switch + one status line ----
// The folder handle lives in the updater's IndexedDB ("pcm-updater" / "kv" /
// "extDir"); reading it here only checks whether setup was done and whether
// Chrome still allows writing without asking ("Allow on every visit").
async function autoUpdateFolderState() {
  try {
    const d = await new Promise((res, rej) => { const r = indexedDB.open("pcm-updater", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const h = await new Promise((res) => { const q = d.transaction("kv").objectStore("kv").get("extDir"); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); });
    if (!h) return "none";
    return (await h.queryPermission({ mode: "readwrite" })) === "granted" ? "ok" : "ask";
  } catch (e) { return "none"; }
}
async function renderAutoUpdate() {
  const box = $("autoUpdate"), line = $("autoUpdateLine");
  if (!box || !line) return;
  let got = {};
  try { got = await chrome.storage.local.get(["settings", "updateInfo", "autoUpdateState"]); } catch (e) {}
  const on = !(got.settings && got.settings.autoUpdate === false);
  box.checked = on;
  line.textContent = "";
  const setupLink = (label) => {
    const a = document.createElement("a");
    a.href = "#"; a.textContent = label;
    a.onclick = (e) => { e.preventDefault(); window.open(chrome.runtime.getURL("update.html?setup=1"), "_blank"); };
    return a;
  };
  if (!on) { line.textContent = "Off: you'll get a notice when a new version is out and install it with one click."; return; }
  const folder = await autoUpdateFolderState();
  if (folder === "none") {
    line.append("Needs a one-time setup: ", setupLink("choose this extension's folder"), " and pick \"Allow on every visit\" when Chrome asks.");
    return;
  }
  if (folder === "ask") {
    line.append("Chrome needs permission again: ", setupLink("open the setup"), ", choose the folder and pick \"Allow on every visit\" so updates can install without asking.");
    return;
  }
  const ui = got.updateInfo, st = got.autoUpdateState;
  const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  if (ui && ui.newer) {
    if (st && st.version === ui.latest && st.reason === "needs-click") {
      line.textContent = "v" + ui.latest + " needs one click: press \"Finish update\" in the update tab (or Update now). Chrome asks for your OK once to let the extension update its folder.";
    } else if (st && st.version === ui.latest && st.reason && !/^(no-folder|permission|moved)$/.test(st.reason)) {
      line.textContent = "Still trying to install v" + ui.latest + " for you (" + st.reason + (st.error ? ": " + st.error : "") + "). It keeps retrying; Update now also works.";
    } else if (Number(ui.autoAt) > Date.now()) {
      line.textContent = "On. v" + ui.latest + " installs automatically after " + when(ui.autoAt) + ".";
    } else {
      line.textContent = "On. v" + ui.latest + " installs by itself within a minute or two - the side panel closes and your pages come back.";
    }
  } else {
    line.textContent = "On. New versions install by themselves within a minute or two; you're up to date.";
  }
  // What the last automatic attempt did, step by step (for troubleshooting).
  if (st && Array.isArray(st.trace) && st.trace.length) {
    const d = document.createElement("div");
    d.className = "hint";
    d.style.marginTop = "4px";
    d.textContent = "Last automatic try" + (st.lastTryAt ? " (" + when(st.lastTryAt) + ")" : "") + ": " + st.trace.join(" → ");
    line.appendChild(d);
  }
}
if ($("autoUpdate")) $("autoUpdate").onchange = async () => {
  try { await send({ type: "SET_SETTINGS", patch: { autoUpdate: $("autoUpdate").checked } }); } catch (e) {}
  renderAutoUpdate();
};
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.updateInfo || ch.autoUpdateState || ch.settings)) renderAutoUpdate();
});
renderAutoUpdate();
// Celebration animations (celebrate.js): saved straight away, on by default.
(async () => {
  try {
    const g = await chrome.storage.local.get("settings");
    const st = g.settings || {};
    if ($("celebrations")) $("celebrations").checked = st.celebrations !== false;
    if ($("celebrationWindow")) { $("celebrationWindow").checked = st.celebrationWindow !== false; $("celebrationWindow").disabled = st.celebrations === false; }
    if ($("celebrationSeconds")) { $("celebrationSeconds").value = String([2, 3, 5, 8, 10].includes(Number(st.celebrationSeconds)) ? Number(st.celebrationSeconds) : 3); $("celebrationSeconds").disabled = st.celebrations === false; }
  } catch (e) {}
})();
if ($("celebrations")) $("celebrations").onchange = () => {
  send({ type: "SET_SETTINGS", patch: { celebrations: $("celebrations").checked } }).catch(() => {});
  if ($("celebrationWindow")) $("celebrationWindow").disabled = !$("celebrations").checked;
  if ($("celebrationSeconds")) $("celebrationSeconds").disabled = !$("celebrations").checked;
};
if ($("celebrationSeconds")) $("celebrationSeconds").onchange = () => { send({ type: "SET_SETTINGS", patch: { celebrationSeconds: Number($("celebrationSeconds").value) || 3 } }).catch(() => {}); };
if ($("celebrationWindow")) $("celebrationWindow").onchange = () => { send({ type: "SET_SETTINGS", patch: { celebrationWindow: $("celebrationWindow").checked } }).catch(() => {}); };
// Preview: the animation on this page + the real notification with its picture
// + the pop-up window, so all three can be seen.
for (const [id, mood] of [["celebrateTryHappy", "happy"], ["celebrateTrySad", "sad"]]) {
  if ($(id)) $(id).onclick = () => {
    // Plays here and in any open side panel / popup (via the shared signal).
    send({ type: "CELEBRATE_PREVIEW", mood, secs: Number($("celebrationSeconds") && $("celebrationSeconds").value) || 3 }).catch(() => {});
  };
}
// ---- Animations and effects (fx.js + the toolbar ring in background.js) ----
const FX_KEYS = ["fxLiquid", "fxChart", "fxCount", "fxIconRing"];
(async () => {
  try { const g = await chrome.storage.local.get("settings"); const st = g.settings || {}; for (const k of FX_KEYS) if ($(k)) $(k).checked = st[k] !== false; } catch (e) {}
})();
for (const k of FX_KEYS) if ($(k)) $(k).onchange = () => { send({ type: "SET_SETTINGS", patch: { [k]: $(k).checked } }).catch(() => {}); };
if ($("fxAllOff")) $("fxAllOff").onclick = async () => {
  const patch = { celebrations: false };
  for (const k of FX_KEYS) { patch[k] = false; if ($(k)) $(k).checked = false; }
  if ($("celebrations")) $("celebrations").checked = false;
  try { await send({ type: "SET_SETTINGS", patch }); } catch (e) {}
  const m = $("fxMsg"); if (m) { m.style.display = "inline"; m.textContent = "All animations are off \u2713"; setTimeout(() => { m.style.display = "none"; }, 2500); }
};
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
      const v = Number(($("notifyVolume") || {}).value) || 100;
      if (now && now.src) { const a = new Audio(now.src); a.volume = Math.max(0.05, Math.min(1, v / 100)); a.play().catch(() => say("Couldn't play it right now.", true)); }
      else send({ type: "PLAY_TEST_SOUND", sound: key === "notify" ? undefined : key, volume: v }).catch(() => {});
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
  "manifest.json", "background.js", "popup.html", "popup.js", "options.html", "options.js", "phone-timer.js",
  "offscreen.html", "offscreen.js", "update.html", "update.js", "auto-update.html", "auto-update.js", "wrapup.html", "wrapup.js",
  "notify-menu.js", "export-tasks.js", "lib-zip.js", "lib-unzip.js", "lib-automation.js",
  "lib-availability.js", "lib-clickup.js", "lib-crypto.js", "lib-tidy.js", "lib-drive.js", "task-panel.js", "lib-updater.js", "offscreen-updater.js", "celebrate.js", "celebrate.html", "celebrate-window.js", "fx.js", "pcm-help.js", "tracker.html", "tracker.js", "bulk-edit.js", "pcm-search.js", "lib-taskfiles.js", "task-files.js", "reminders.js", "hub.js", "task-sort.js", "breakdown.js", "calendar.js", "notices.js", "insights-plus.js", "header-ui.js", "plan-apply.js", "task-notes.js", "md-notes.js", "local-tasks.js", "ui-extras.js", "assignees.js", "add-time.js", "team-hub.gs", "vendor/pdf.min.js", "vendor/pdf.worker.min.js", "vendor/pdfjs-LICENSE.txt",
  "icons/icon16.png", "icons/icon48.png", "icons/icon128.png", "icons/celebrate.png", "icons/sad.png",
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
    let start = lines.findIndex((l) => new RegExp("^##\\s+v?" + version.replace(/\./g, "\\.") + "(\\s|$)").test(l.trim()));
    // No section for this exact version yet: use "## Unreleased" if there is one.
    if (start < 0) start = lines.findIndex((l) => /^##\s+unreleased\b/i.test(l.trim()));
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
  admPolLoad();
  admSitesLoad();
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
    const someOnly = document.querySelector('input[name="admWho"][value="some"]');
    if (someOnly && someOnly.checked && !admAudience().length) throw new Error("\"Only some people\" is chosen but nobody is ticked - pick departments or people (or choose Everyone).");
    admSay("Uploading v" + version + " to GitHub…");
    const res = await send({
      type: "ADMIN_PUBLISH",
      version,
      notes: $("admNotes").value || "",
      critical: !!($("admCritical") && $("admCritical").checked),
      commit: !($("admCommit") && !$("admCommit").checked),
      notify: !!($("admNotify") && $("admNotify").checked),
      audience: admAudience(),
      zipB64: await admB64(z.blob),
    }, 120000);
    if (!res || !res.ok) throw new Error((res && res.error) || "Publish failed.");
    admSay("Published " + res.tag + " ✓" + (res.notified === true
      ? " - everyone with Chrome open gets the update prompt within about 1-2 minutes; the rest when Chrome next starts."
      : res.notified === "held"
        ? " - a \"Don't notify before\" time is set, so people are told from then (or press Notify everyone now below)."
        : res.notified === "quiet"
          ? (admAudience().length ? " - only for the people you picked, without a pop-up: it installs by itself for them (or they see it in the popup). Release it to everyone below when you're ready." : " - quietly: no pop-up. Automatic updates install it by itself; others see it in the popup or with Check for updates.")
          : res.notified === "some"
            ? " - only for the people you picked; they get the pop-up. Release it to everyone below when you're ready."
            : " - but recording it for everyone didn't work this time: press Notify everyone now below."), "ok");
    admLoadWho();
    if (res.repoUpdated) admSay("Repository updated: manifest.json and CHANGELOG.md now say " + res.tag + ".", "ok");
    else if (res.repoError) admSay("The release is live, but the repository wasn't updated: " + res.repoError, "err");
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
// ---- Admin: who gets a release (everyone / some people) + "Release to everyone" ----
// People are the single source of truth: a department just ticks / unticks its
// people. Search filters both; "Select shown" ticks everyone currently listed.
const admWho = { people: [], deps: [], picked: new Set() };
function admAudience() {
  const some = document.querySelector('input[name="admWho"][value="some"]');
  if (!some || !some.checked) return [];
  return [...admWho.picked];
}
function admWhoCount() {
  const n = admWho.picked.size;
  const box = $("admWhoCount");
  if (box) box.textContent = n ? n + (n === 1 ? " person" : " people") + " selected" : "Nobody selected yet";
}
function admWhoInitials(name) { return String(name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?"; }
function admWhoPaint() {
  const q = String(($("admWhoSearch") || {}).value || "").trim().toLowerCase();
  const depsBox = $("admWhoDeps"), pplBox = $("admWhoPeople");
  if (!depsBox || !pplBox) return;
  // departments: on = all its people ticked, part = some
  depsBox.textContent = "";
  const deps = admWho.deps.filter((d) => !q || d.name.toLowerCase().includes(q) || d.users.some((u) => String(u.name).toLowerCase().includes(q)));
  if (!admWho.deps.length) depsBox.appendChild(Object.assign(document.createElement("span"), { className: "hint", textContent: "No departments yet (ClickUp setup > Departments)." }));
  for (const d of deps) {
    const ids = d.users.map((u) => u.id);
    const n = ids.filter((id) => admWho.picked.has(id)).length;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "adm-dep" + (n && n === ids.length ? " on" : n ? " part" : "");
    b.innerHTML = "";
    b.append(d.name);
    const c = document.createElement("b"); c.textContent = (n && n < ids.length ? n + "/" : "") + ids.length; b.appendChild(c);
    b.title = d.users.map((u) => u.name).join(", ");
    b.onclick = () => { const all = ids.length && n === ids.length; for (const id of ids) { if (all) admWho.picked.delete(id); else admWho.picked.add(id); } admWhoPaint(); };
    depsBox.appendChild(b);
  }
  // people
  pplBox.textContent = "";
  const shown = admWho.people.filter((p) => !q || String(p.name).toLowerCase().includes(q) || p.deps.some((d) => d.toLowerCase().includes(q)));
  if (!shown.length) pplBox.appendChild(Object.assign(document.createElement("div"), { className: "hint", textContent: q ? "Nobody matches that search." : "Nobody to pick yet.", style: "padding:10px;" }));
  for (const p of shown) {
    const row = document.createElement("label");
    row.className = "adm-person" + (admWho.picked.has(p.id) ? " on" : "");
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = admWho.picked.has(p.id);
    cb.onchange = () => { if (cb.checked) admWho.picked.add(p.id); else admWho.picked.delete(p.id); admWhoPaint(); };
    const av = document.createElement("span"); av.className = "av"; av.textContent = admWhoInitials(p.name);
    const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = p.name;
    if (p.deps.length) { const s = document.createElement("small"); s.textContent = p.deps.join(" \u00b7 "); nm.appendChild(s); }
    const ver = document.createElement("span"); ver.className = "ver"; ver.textContent = p.version ? "v" + p.version : "";
    row.append(cb, av, nm, ver);
    pplBox.appendChild(row);
  }
  admWho.shown = shown;
  admWhoCount();
}
async function admLoadWho() {
  const r = await send({ type: "ADMIN_RELEASE_INFO" }).catch(() => null);
  if (!r || !r.ok) return;
  admWho.deps = (r.departments || []).map((d) => ({ name: d.name, users: (d.users || []).filter((u) => u.id) }));
  const people = new Map();
  for (const p of r.people || []) people.set(p.id, { id: p.id, name: p.name, version: p.version || "", deps: [] });
  for (const d of admWho.deps) for (const u of d.users) {
    if (!people.has(u.id)) people.set(u.id, { id: u.id, name: u.name, version: "", deps: [] });
    people.get(u.id).deps.push(d.name);
  }
  admWho.people = [...people.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  admWhoPaint();
  const pb = $("admPreviewBox");
  if (pb) {
    pb.hidden = !r.preview;
    if (r.preview) $("admPreviewText").textContent = "v" + r.preview.latest + " is out to " + r.preview.cuUserIds.length + (r.preview.cuUserIds.length === 1 ? " person" : " people") + " only.";
  }
}
if ($("admWhoSearch")) $("admWhoSearch").oninput = admWhoPaint;
if ($("admWhoAll")) $("admWhoAll").onclick = () => { for (const p of admWho.shown || []) admWho.picked.add(p.id); admWhoPaint(); };
if ($("admWhoNone")) $("admWhoNone").onclick = () => { admWho.picked.clear(); admWhoPaint(); };
document.querySelectorAll('input[name="admWho"]').forEach((r) => { r.onchange = () => { const box = $("admWhoBox"); if (box) box.hidden = !(document.querySelector('input[name="admWho"][value="some"]') || {}).checked; admWhoCount(); }; });
if ($("admReleaseAll")) $("admReleaseAll").onclick = async () => {
  const b = $("admReleaseAll");
  b.disabled = true; b.textContent = "Releasing\u2026";
  const r = await send({ type: "ADMIN_RELEASE_ALL", notify: !!($("admReleaseNotify") && $("admReleaseNotify").checked) }, 60000);
  b.disabled = false; b.textContent = "Release to everyone";
  if (r && r.ok) { admSay("v" + r.version + " is now out to everyone \u2713", "ok"); admLoadWho(); }
  else admSay("Couldn't release it to everyone: " + ((r && r.error) || "no answer"), "err");
};
if ($("admWhoBox")) admLoadWho();
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

// ---- Admin: update notifications (update-policy.json in the repo) ----
function admPolFill(p) {
  if (!p) return;
  if ($("admPolRemind")) $("admPolRemind").value = p.remindEveryHours;
  if ($("admPolAuto")) $("admPolAuto").value = p.autoInstallAfterHours != null ? p.autoInstallAfterHours : 1;
  if ($("admPolImportant")) $("admPolImportant").checked = !!p.important;
  if ($("admPolHold")) {
    const d = p.holdUntil ? new Date(p.holdUntil) : null;
    $("admPolHold").value = d ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
  }
  const st = $("admPolState");
  if (st) {
    const when = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    const bits = [];
    if (p.notifiedAllAt) bits.push("Last \"Notify everyone\": " + when(p.notifiedAllAt));
    if (p.updatedAt) bits.push("Settings saved " + when(p.updatedAt));
    bits.push("Everyone with Chrome open hears about it within about 1-2 minutes.");
    st.textContent = bits.join(" \u00b7 ");
  }
}
async function admPolLoad() {
  try { const r = await send({ type: "ADMIN_POLICY_GET" }, 20000); if (r && r.ok) admPolFill(r.policy); } catch (e) {}
}
function admPolRead() {
  const hold = $("admPolHold") && $("admPolHold").value ? new Date($("admPolHold").value).getTime() : 0;
  return {
    remindEveryHours: Number($("admPolRemind").value) || 24,
    autoInstallAfterHours: $("admPolAuto") && $("admPolAuto").value !== "" ? Math.max(0, Math.min(168, Number($("admPolAuto").value) || 0)) : 1,
    important: !!$("admPolImportant").checked,
    holdUntil: hold > Date.now() ? hold : 0,
  };
}
async function admPolSend(notifyNow) {
  const msg = $("admPolMsg");
  const btns = [$("admPolSave"), $("admPolNotify")];
  btns.forEach((b) => b && (b.disabled = true));
  if (msg) { msg.style.display = "inline"; msg.style.color = ""; msg.textContent = notifyNow ? "Notifying everyone\u2026" : "Saving\u2026"; }
  try {
    const r = await send({ type: "ADMIN_POLICY_SET", policy: admPolRead(), notifyNow }, 30000);
    if (r && r.ok) {
      admPolFill(r.policy);
      if (msg) msg.textContent = notifyNow
        ? "Sent \u2713 - everyone with Chrome open sees it within about 1-2 minutes"
        : "Saved \u2713";
    } else if (msg) {
      msg.style.color = "var(--red)";
      msg.textContent = "Couldn't save: " + ((r && r.error) || "unknown error");
    }
  } catch (e) {
    if (msg) { msg.style.color = "var(--red)"; msg.textContent = "Couldn't save: " + (e && e.message ? e.message : e); }
  } finally {
    btns.forEach((b) => b && (b.disabled = false));
  }
}
if ($("admPolSave")) $("admPolSave").onclick = () => admPolSend(false);
if ($("admPolNotify")) $("admPolNotify").onclick = () => admPolSend(true);

// ---- Drive Sync > "Where is it saved?" ----
const DRIVE_FILE_LABELS = {
  "daily-login-state.json": "Done / not-done status",
  "daily-login-accounts.json": "Accounts, settings, site list and ClickUp connection (credentials obfuscated)",
  "daily-login-key.json": "The key used to obfuscate them",
  "pcm-task-files.json": "Task files (the text of your client files)",
};
if ($("driveWhere")) $("driveWhere").addEventListener("toggle", async () => {
  if (!$("driveWhere").open) return;
  const box = $("driveFiles");
  box.textContent = "Checking Drive…";
  const r = await send({ type: "DRIVE_FILES" }).catch(() => null);
  if (!r || !r.ok) {
    box.textContent = r && r.reason === "signed-out" ? "Sign in above to see what's saved." : "Couldn't check Drive right now.";
    return;
  }
  box.replaceChildren();
  const head = document.createElement("div");
  head.textContent = r.files.length
    ? r.files.length + " file(s) in the Drive of " + (r.account || "the signed-in Google account") + ":"
    : "Nothing saved yet - it's written on the next sync.";
  box.appendChild(head);
  // How full the Drive is: a warning when little space is left.
  if (r.quota && r.quota.limit) {
    const gb = (n) => (n / 1073741824).toFixed(1) + " GB";
    const left = r.quota.limit - r.quota.usage;
    const q = document.createElement("div");
    q.textContent = "Your Drive: " + gb(r.quota.usage) + " of " + gb(r.quota.limit) + " used" + (left < 500 * 1048576 ? " - almost full: free up space so sync keeps working." : ".");
    if (left < 500 * 1048576) q.style.color = "var(--red)";
    box.appendChild(q);
  }
  for (const f of r.files) {
    const row = document.createElement("div");
    const kb = Math.max(1, Math.round((Number(f.size) || 0) / 1024));
    const when = f.modifiedTime ? new Date(f.modifiedTime).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
    row.textContent = "• " + (DRIVE_FILE_LABELS[f.name] || f.name) + " · " + kb + " KB" + (when ? " · updated " + when : "");
    box.appendChild(row);
  }
});
if ($("driveSettingsBtn")) $("driveSettingsBtn").onclick = () => chrome.tabs.create({ url: "https://drive.google.com/drive/settings" }).catch(() => {});

// ---- General: floating tracker (tracker.html) ----
const FLOAT_KEYS = ["floatTracker", "floatAutoOpen", "floatAutoAnywhere", "floatHover", "floatToday"];
if ($("floatSize")) {
  chrome.storage.local.get("settings").then((g) => { const fs0 = (g.settings && g.settings.floatSize) || "slim"; $("floatSize").value = fs0 === "compact" || fs0 === "normal" ? fs0 : "slim"; }).catch(() => {});
  $("floatSize").onchange = () => { send({ type: "SET_SETTINGS", patch: { floatSize: $("floatSize").value } }).catch(() => {}); };
}
(async () => {
  try { const g = await chrome.storage.local.get("settings"); const st = g.settings || {}; for (const k of FLOAT_KEYS) if ($(k)) $(k).checked = st[k] !== false; } catch (e) {}
})();
for (const k of FLOAT_KEYS) if ($(k)) $(k).onchange = () => { send({ type: "SET_SETTINGS", patch: { [k]: $(k).checked } }).catch(() => {}); };
if ($("floatNow")) {
  if (!("documentPictureInPicture" in window)) { $("floatNow").disabled = true; $("floatUnsupported").style.display = "block"; }
  $("floatNow").onclick = () => window.PcmHelp && window.PcmHelp.openFloat();
}

// ---- General: keyboard shortcuts + help & diagnostics ----
const SHORTCUT_LABELS = { "toggle-timer": "Start / stop the timer", _execute_action: "Open the popup", "open-dashboard": "Open the dashboard" };
async function renderShortcuts() {
  const el = $("shortcutList");
  if (!el || !chrome.commands) return;
  let cmds = [];
  try { cmds = await chrome.commands.getAll(); } catch (e) {}
  el.replaceChildren();
  for (const c of cmds) {
    const row = document.createElement("div");
    const k = document.createElement("kbd");
    k.style.cssText = "display:inline-block;min-width:92px;margin-right:8px;padding:1px 7px;border:1px solid var(--border);border-radius:5px;background:var(--bg2);color:var(--text);font:12px ui-monospace,monospace;";
    k.textContent = c.shortcut || "not set";
    row.append(k, document.createTextNode(SHORTCUT_LABELS[c.name] || c.description || c.name));
    el.appendChild(row);
  }
  if (cmds.some((c) => !c.shortcut)) {
    const n = document.createElement("div");
    n.textContent = "\"not set\" means another extension already uses that key: pick your own with Change shortcuts.";
    el.appendChild(n);
  }
}
if ($("shortcutsChange")) $("shortcutsChange").onclick = async () => {
  let scheme = "chrome";
  try { if (navigator.brave && (await navigator.brave.isBrave())) scheme = "brave"; else if (/Edg\//.test(navigator.userAgent)) scheme = "edge"; } catch (e) {}
  chrome.tabs.create({ url: scheme + "://extensions/shortcuts" }).catch(() => {});
};
renderShortcuts();
window.addEventListener("focus", renderShortcuts); // back from the shortcuts page
if ($("diagCopy")) $("diagCopy").onclick = async () => {
  const msg = $("diagMsg");
  msg.style.display = "block";
  msg.style.color = "";
  msg.textContent = "Collecting…";
  try {
    const text = await window.PcmHelp.copyDiagnostics();
    msg.textContent = "Copied ✓ (" + text.split("\n").length + " lines). Paste it (Ctrl+V) in a message to whoever helps you with the extension.";
  } catch (e) {
    msg.style.color = "var(--red)";
    msg.textContent = "Couldn't copy: " + (e && e.message ? e.message : e);
  }
};
if ($("setupShow")) $("setupShow").onclick = async () => {
  await window.PcmHelp.showSetup();
  location.hash = "#dashboard";
};

// ---- Admin: client sites for everyone (client-sites.json, encrypted) ----
let admSitesMineList = [];
const admSitesText = (list) => list.map((s) => (s.name ? s.name + " | " : "") + s.url).join("\n");
async function admSitesLoad() {
  const box = $("admSites");
  if (!box) return;
  let r = null;
  try { r = await send({ type: "ADMIN_SITES_GET" }, 30000); } catch (e) {}
  if (!r || !r.ok) return;
  admSitesMineList = Array.isArray(r.mine) ? r.mine : [];
  const st = $("admSitesState");
  if (!box.value.trim()) box.value = admSitesText(r.published && r.published.length ? r.published : admSitesMineList);
  if (st) {
    st.textContent = !r.connected ? "Connect ClickUp first: the list is locked to your ClickUp workspace."
      : r.published ? r.published.length + " site(s) published " + new Date(r.publishedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + "."
      : "Nothing published yet. The box shows your own Site monitor list.";
  }
}
function admSitesRead() {
  const out = [];
  for (const line of $("admSites").value.split("\n")) {
    if (!line.trim()) continue;
    const p = smParseLine(line);
    if (p && p.url) out.push({ name: p.name || "", url: p.url });
  }
  return out;
}
if ($("admSitesMine")) $("admSitesMine").onclick = async () => {
  await admSitesLoad();
  $("admSites").value = admSitesText(admSitesMineList);
};
if ($("admSitesPublish")) $("admSitesPublish").onclick = async () => {
  const msg = $("admSitesMsg");
  const btn = $("admSitesPublish");
  const sites = admSitesRead();
  msg.style.display = "inline";
  msg.style.color = "";
  if (!sites.length) { msg.style.color = "var(--red)"; msg.textContent = "No web addresses found in the box."; return; }
  btn.disabled = true;
  msg.textContent = "Publishing " + sites.length + " site(s)…";
  try {
    const r = await send({ type: "ADMIN_SITES_PUBLISH", sites }, 60000);
    if (r && r.ok) {
      msg.textContent = "Published ✓ " + r.count + " site(s). Everyone connected to your ClickUp workspace gets them within about 1-2 minutes" +
        (r.added ? " (" + r.added + " added here)" : "") + ".";
      admSitesLoad();
    } else {
      msg.style.color = "var(--red)";
      msg.textContent = "Couldn't publish: " + ((r && r.error) || "unknown error");
    }
  } catch (e) {
    msg.style.color = "var(--red)";
    msg.textContent = "Couldn't publish: " + (e && e.message ? e.message : e);
  } finally {
    btn.disabled = false;
  }
};

