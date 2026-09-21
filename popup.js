// popup.js - status overview + run controls. Live-updates during a run and
// ticks the reset countdowns while the popup is open. Includes the ClickUp
// "Filter Tasks", "Weekly Totals", and "Today estimate/tracked" cards.

const $ = (id) => document.getElementById(id);
// Same page runs as the toolbar popup and in Chrome's side panel (?view=panel).
const IN_PANEL = new URLSearchParams(location.search).get("view") === "panel";
if (IN_PANEL) document.documentElement.classList.add("in-panel");
// "12:10 PM · Sep 6" - used for the "Last synced" line and the transient
// "Synced ✓" confirmation.
function fmtSyncStamp(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString([], { month: "short", day: "numeric" });
  return time + " · " + date;
}
let transientSyncText = "";
let transientSyncUntil = 0;
// Matches the auto-detected "Extra(s) Task(s)" name pattern (mirrors
// lib-clickup.js EXTRA_TASK_NAME_RE) for de-duplicating weekly rows.
const EXTRA_TASK_NAME_RE = /extra\s*\(?\s*s?\s*\)?\s*-?\s*tasks?/i;
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
const send = (msg, timeoutMs) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const timer = timeoutMs == null ? null : setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("No response from the extension."));
    }, timeoutMs);
    chrome.runtime.sendMessage(msg, (resp) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || "Message to the extension failed."));
      else resolve(resp);
    });
  });

let state = { accounts: [], status: {}, today: "", running: false, resetHours: 24, balances: {}, availability: {}, clickup: {} };

// Start/Stop Extra Task timer: in-flight guard + a transient message (e.g. an
// error) shown under the button that survives re-renders until the next action.
let cuTimerBusy = false;
let cuTimerMsg = "";

// Per-task row controls (Start/Stop/Complete). Busy is a Set of task ids with an
// action in flight (so one busy row doesn't disable the others); msg is a
// task-id -> transient message map shown inline on that row until the next action.
const cuRowBusy = new Set();
const cuRowMsg = {};
// Toast notifications inside popup
let toastTimeout = null;
function showPopupToast(msg, type = "info") {
  let toast = document.getElementById("popupToast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "popupToast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = "popup-toast show " + type;
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.className = "popup-toast";
  }, 4000);
}
// task-id -> { activeTaskName, tracking } while a Start awaits switch confirmation
// (another task is already in progress). Cleared on confirm/cancel/other action.
const cuRowConfirm = {};

// ---- Department filter (popup) ----
// Lazy-loaded once per popup open from CLICKUP_DEPT_DATA in the background.
let popupDeptMembers = [];    // [{ id, name }]
let popupDeptList = [];       // [{ id, name, users:[{id,name}] }]
let popupDeptLoaded = false;
let fltRenderSeq = 0; // bumped per renderFilter() so a superseded load never overwrites a newer one

async function loadDeptData() {
  if (popupDeptLoaded) return;
  if (!(state.clickup && state.clickup.configured)) return;
  const res = await send({ type: "CLICKUP_DEPT_DATA" });
  if (res && res.ok) {
    popupDeptMembers = res.members || [];
    popupDeptList = res.departments || [];
  }
  popupDeptLoaded = true;
  populateDeptSelects();
}

function populateDeptSelects() {
  const fsel = $("fltDept");
  if (!fsel) return;
  const prev = fsel.value;
  fsel.innerHTML = '<option value="">My tasks</option><option value="__all__">All users (workspace)</option>';
  for (const d of popupDeptList) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.name;
    fsel.appendChild(o);
  }
  if (prev && [...fsel.options].some((o) => o.value === prev)) fsel.value = prev;
  syncDeptUserSelect();
}

function syncDeptUserSelect() {
  const fsel = $("fltDept");
  const row = $("fltDeptUserRow");
  const usel = $("fltDeptUser");
  if (!fsel || !row || !usel) return;
  const dept = popupDeptList.find((d) => String(d.id) === String(fsel.value));
  const users = dept && Array.isArray(dept.users) ? dept.users : [];
  if (!dept || !users.length) {
    row.style.display = "none";
    usel.value = "";
    return;
  }
  row.style.display = "";
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

// Agent Router (new-api) stores balance as an integer "quota"; the default unit
// is 500000 quota = $1. If a deployment ever reports currency directly, set
// settings.quotaPerUnit = 1. Format is display-only - the RAW value goes in the
// element title so it's always verifiable.
const DEFAULT_QUOTA_PER_UNIT = 500000;
function fmtBalance(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return "-";
  const per = (state.settings && Number(state.settings.quotaPerUnit)) || DEFAULT_QUOTA_PER_UNIT;
  const div = per > 0 ? per : DEFAULT_QUOTA_PER_UNIT;
  return "$" + (n / div).toFixed(2);
}

// ---------- header: side panel + wrap-up ----------
function initHeaderExtras() {
  const w = $("wrapBtn");
  if (w) w.onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("wrapup.html") }).catch(() => {});
    if (!IN_PANEL) window.close();
  };
  const side = $("sideBtn");
  if (side && IN_PANEL) {
    side.hidden = false;
    // Chrome decides left/right for every extension's panel (Settings > Appearance).
    side.onclick = () => chrome.tabs.create({ url: "chrome://settings/appearance" }).catch(() => {});
  }
  const b = $("panelBtn");
  if (!b) return;
  if (IN_PANEL || !chrome.sidePanel || !chrome.sidePanel.open) { b.hidden = true; return; }
  // Fetch the window id up front: sidePanel.open must run straight from the click.
  let winId = null;
  chrome.windows.getCurrent().then((win) => { winId = win && win.id; }).catch(() => {});
  b.onclick = () => {
    if (winId == null) return;
    chrome.sidePanel.open({ windowId: winId }).then(() => window.close())
      .catch(() => { b.title = "Right-click the extension icon, then \"Open side panel\""; });
  };
}

// ---------- theme (persisted, shared with the options page) ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const btn = $("themeToggle");
  if (btn) btn.textContent = t === "dark" ? "☀️" : "🌙";
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

// ---------- time formatting ----------
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
function fmtCountdown(ms) {
  if (ms < 0) ms = 0;
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return h + "h " + m + "m";
  if (m > 0) return m + "m";
  return "<1m";
}
function isToday(ts) {
  if (!ts) return false;
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` === state.today;
}
function doneAtOf(st) {
  if (!st) return 0;
  if (st.lastDoneAt) return st.lastDoneAt;
  if (st.lastDone && st.lastRunAt) return st.lastRunAt;
  return 0;
}

function statusFor(acc) {
  const st = state.status[acc.id] || {};
  const resetMs = (state.resetHours || 24) * 3600000;
  if (st.lastResult === "running") return { cls: "running", text: "Logging in…" };

  const dAt = doneAtOf(st);
  if (dAt && Date.now() < dAt + resetMs) {
    const nextAt = dAt + resetMs;
    return {
      cls: "done",
      // dAt is the earning checkpoint: the exact moment the $25 was credited in
      // this 24h window (preserved across re-runs). Surface that clock time so the
      // user knows when tomorrow's auto-login will fire to re-claim it.
      text: "Done · credited " + fmtClock(dAt) + (st.creditSource === "login" ? " (at login)" : ""),
      sub: "Resets in " + fmtCountdown(nextAt - Date.now()) + " · " + fmtDayTime(nextAt),
    };
  }
  if (st.lastResult && st.lastResult !== "success" && isToday(st.lastRunAt)) {
    const label = st.lastResult === "failed" ? "Failed" : "Needs you";
    return {
      cls: "attention",
      text: st.note || label,
      sub: st.lastRunAt ? "Tried " + fmtDayTime(st.lastRunAt) : "",
      attention: true,
    };
  }
  if (dAt) {
    // Show the last RUN and the last CREDIT separately - one "Last login" line
    // used to show only the credit checkpoint and hid newer runs.
    const ranLater = st.lastRunAt && st.lastRunAt > dAt + 60000;
    return {
      cls: "pending",
      text: "Ready to run again",
      sub: (ranLater ? "Last run " + fmtDayTime(st.lastRunAt) + " · " : "") + "Last credit " + fmtDayTime(dAt),
    };
  }
  if (st.lastResult === "success" && st.lastRunAt) {
    // Login succeeded but no credit has been confirmed yet (the balance poll
    // will flip this to "Done · credited" the moment the batch lands). Show the
    // truth instead of pretending the daily earning is already banked.
    return {
      cls: "pending",
      text: "Logged in · awaiting credit",
      sub: "Run " + fmtDayTime(st.lastRunAt),
    };
  }
  return { cls: "pending", text: "Not run yet" };
}

// ---------- availability chip ----------
// Turn a stored availability record into what the account row shows. Tri-state:
//   green  = a test relay request just succeeded (Claude is usable now)
//   red    = the account is in a blocked (limit/billing) window
//   grey   = unknown (never checked, no relay key yet, or an inconclusive result)
// Green is only ever shown when `ok` is literally true, so the chip can't lie.
function availView(av, hasSession) {
  if (!hasSession) {
    return { dot: "unknown", cls: "", label: "Availability: log in to check", btn: null,
      title: "Run a login for this account so the extension can test whether Claude is usable." };
  }
  const when = av && av.at ? fmtDayTime(av.at) : "";
  if (!av || av.at == null) {
    return { dot: "unknown", cls: "", label: "Availability: not checked", btn: "Check", create: false,
      title: "Check whether Claude will accept a request right now." };
  }
  if (av.ok === true) {
    return { dot: "ok", cls: "", label: "Available", btn: "Recheck", create: false,
      title: "A test request succeeded" + (when ? " · " + when : "") + "." };
  }
  if (av.ok === false) {
    return { dot: "blocked", cls: "blocked", label: "Blocked", btn: "Recheck", create: false,
      title: (av.reason || "Usage limit reached - blocked until the next quota window.") + (when ? "\nChecked " + when : "") };
  }
  // ok === null -> unknown. "No key yet" needs an Enable (creates a relay key);
  // everything else is just a retry.
  const noKey = av.reason === "no-key" || av.reason === "create-failed" || av.reason === "key-unreadable";
  return {
    dot: "unknown",
    cls: "",
    label: noKey ? "Availability: not enabled" : "Availability: unknown",
    btn: noKey ? "Enable" : "Recheck",
    create: noKey,
    title: (av.reason ? "Reason: " + av.reason + "\n" : "") +
      (noKey ? "No relay key on this account yet. Enable creates one and runs a test."
             : "Couldn't determine availability - click Recheck to retry.") +
      (when ? "\nChecked " + when : ""),
  };
}

// ---------- ClickUp ----------
function fmtDur(ms) {
  const totalMin = Math.round((Number(ms) || 0) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return h + "h " + m + "m";
  if (h > 0) return h + "h";
  return m + "m";
}

// Cap a task name to a fixed number of characters so a long ClickUp title can't
// stretch a row wider than the list (which is what forced the horizontal
// scrollbar). The full, untruncated name still shows on hover via the link's
// title (set in makeTaskLink), so nothing is lost. Uses the single ellipsis glyph
// to match the CSS text-overflow fallback that clips anything still too wide.
const TASK_NAME_MAX = 70;
function truncName(s) {
  const str = String(s == null ? "" : s);
  if (str.length <= TASK_NAME_MAX) return str;
  return str.slice(0, TASK_NAME_MAX).replace(/\s+$/, "") + "…";
}

// Make a task name open its ClickUp URL (https://app.clickup.com/t/<id>).
function makeTaskLink(anchor, url, titleText) {
  if (url) {
    anchor.href = url;
    anchor.target = "_blank";
    anchor.rel = "noopener";
    anchor.classList.add("nm");
  } else {
    anchor.href = "#";
    anchor.style.cursor = "default";
    anchor.classList.add("nm");
    anchor.addEventListener("click", (e) => e.preventDefault());
  }
  anchor.title = titleText || (url || "");
}

// Add a green ✓ after a completed task's name in a task row.
function appendDoneTick(anchor, t) {
  if (t && t.done) {
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    anchor.appendChild(tick);
  }
}

// Append the per-task action controls (Start/Stop + Complete) to a task row.
// Done tasks show nothing (the static ✓ from appendDoneTick already marks them).
// The Start/Stop label is driven by the live running timer (state.clickup.state
// .running); a per-row busy guard + inline message mirror the Extra-Task button.
function appendTaskControls(row, t) {
  if (!t || !t.id) return;
  if (t.done) return; // completed - no live controls
  const cu = state.clickup || {};
  if (!cu.configured) return;
  const tid = String(t.id);
  const running = cu.state && cu.state.running ? cu.state.running : null;
  const isRunning = running && String(running.taskId) === tid;
  const busy = cuRowBusy.has(tid);

  const actions = document.createElement("span");
  actions.className = "cu-actions";

  if (isRunning) {
    const stop = document.createElement("button");
    stop.className = "cu-iconbtn stop";
    stop.title = "Stop tracking · set to “to do”";
    stop.textContent = busy ? "…" : "⏸";
    stop.disabled = busy;
    stop.onclick = () => sendTaskAction(tid, "stop");
    actions.appendChild(stop);
  } else {
    const start = document.createElement("button");
    start.className = "cu-iconbtn start";
    start.title = "Start · set to “in progress” and start the timer";
    start.textContent = busy ? "…" : "▶";
    start.disabled = busy;
    start.onclick = () => sendTaskAction(tid, "start");
    actions.appendChild(start);
  }

  const done = document.createElement("button");
  done.className = "cu-iconbtn done";
  done.title = "Mark complete · stops the timer";
  done.textContent = "✓";
  done.disabled = busy;
  done.onclick = () => sendTaskAction(tid, "complete");
  actions.appendChild(done);

  row.appendChild(actions);

  // Switch confirmation: another task is in progress. Warn, then let the user
  // confirm the switch (start this one, stop + revert the other) or cancel.
  const cf = cuRowConfirm[tid];
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
        a.textContent = "“" + truncName(cf.activeTaskName) + "”";
        txt.appendChild(a);
      } else {
        txt.appendChild(document.createTextNode("“" + truncName(cf.activeTaskName) + "”"));
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
    yes.onclick = () => { delete cuRowConfirm[tid]; sendTaskAction(tid, "start", true); };
    const no = document.createElement("button");
    no.className = "cu-iconbtn";
    no.textContent = "Cancel";
    no.onclick = () => { delete cuRowConfirm[tid]; render(); };
    btns.appendChild(yes);
    btns.appendChild(no);
    warn.appendChild(btns);
    row.appendChild(warn);
  } else if (cuRowMsg[tid]) {
    row.classList.add("has-msg");
    row.appendChild(cuRowNotice(cuRowMsg[tid], () => { delete cuRowMsg[tid]; render(); }));
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
// The multi-assignee refusal, worded as what to do rather than a rule recital.
function cuMultiAssigneeMsg(tid, assignees) {
  const names = Array.isArray(assignees) ? assignees.map((a) => a && (a.username || a.id)).filter(Boolean) : [];
  const who = names.length ? names.length + " assignees (" + names.join(", ") + ")" : "more than one assignee";
  return { text: "Can't start here: " + who + ". Start it in ClickUp.", url: "https://app.clickup.com/t/" + encodeURIComponent(tid) };
}

// Fire a per-task Start/Stop/Complete action, then repaint. Modeled on
// toggleExtraTimer: 20s timeout (the background does the ClickUp write THEN a
// today+tasks refresh before replying), inline error via cuRowMsg on that row.
async function sendTaskAction(taskId, action, force) {
  const tid = String(taskId);
  if (cuRowBusy.has(tid)) return;
  cuRowBusy.add(tid);
  delete cuRowMsg[tid];
  delete cuRowConfirm[tid];
  render();
  const typeMap = { start: "CLICKUP_TASK_START", stop: "CLICKUP_TASK_STOP", complete: "CLICKUP_TASK_COMPLETE" };
  try {
    const res = await send({ type: typeMap[action], taskId: tid, force: !!force }, 20000);
    cuRowBusy.delete(tid);
    if (!res || res.ok === false) {
      if (res && res.reason === "needs-confirm") {
        // Another task is in progress - surface the in-row switch confirmation.
        cuRowConfirm[tid] = {
          activeTaskName: res.activeTaskName || "",
          activeTaskUrl: res.activeTaskUrl || "",
          activeInProgress: !!res.activeInProgress,
          tracking: !!res.tracking,
        };
        render();
        return;
      }
      if (res && res.reason === "multi-assignee") {
        cuRowMsg[tid] = cuMultiAssigneeMsg(tid, res && res.assignees);
      } else {
        const reason = res && res.reason;
        const map = { "not-configured": "connect ClickUp first", "incomplete-setup": "pick a workspace first", "no-task": "task id missing" };
        const verb = action === "complete" ? "complete" : action;
        cuRowMsg[tid] = "Couldn't " + verb + ": " + ((res && res.error) || map[reason] || reason || "unknown error");
      }
      render();
      return;
    }
  } catch (e) {
    cuRowBusy.delete(tid);
    cuRowMsg[tid] = "Couldn't update task: " + (e && e.message ? e.message : e);
    render();
    return;
  }
  // Success: background updated clickupState (fires the storage listener), but
  // load() guarantees an immediate repaint with fresh status/running state.
  await load();
}

// Append the task-name anchor to a row, tucking a small client tag right after
// it so each row shows which client the task belongs to. The name ellipsizes
// (via the .nm CSS) while the pill stays pinned beside it and never overlaps the
// est/tracked. In client-grouped mode the client is already a section header, so
// callers pass opts.hideClient to suppress the redundant per-row pill.

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
    (Number(b.estimateMs != null ? b.estimateMs : b.dayEstimateMs) || 0) - (Number(a.estimateMs != null ? a.estimateMs : a.dayEstimateMs) || 0) ||
    // Same priority and same estimate: fall back to the name, read the way a
    // person would (ACT-025.S1 before ACT-025.S3), instead of ClickUp's order.
    String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
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
function cuWaitMap() { const st = (state && state.clickup && state.clickup.state) || null; return (st && st.waiting) || {}; }
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
  const st = (state && state.clickup && state.clickup.state) || null;
  const run = st && st.running;
  const id = t && (t.id != null ? t.id : t.taskId);
  if (run && id != null && String(run.taskId) === String(id)) trk.classList.add("running");
}

// Small floating message used by the due-date editor (both pages).
function cuDueToast(text) {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1200;max-width:90%;padding:8px 12px;border-radius:8px;background:var(--red);color:#fff;font-size:12px;box-shadow:0 8px 20px rgba(0,0,0,.25)";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
// ---------- export: remember what the list is showing right now ----------
let cuExportData = { rows: [], title: "tasks" };
function cuExportRows(tasks, deadlineTasks, trackedTasks, scope) {
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
  cuExportData = { rows, title: scope || "tasks" };
}

// ---------- due date: click the chip to set / change / clear it ----------
function startEditDue(chip, task) {
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
      cuDueToast("Couldn't save the due date: " + (e && e.message ? e.message : e));
    }
  };
  input.addEventListener("blur", save);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") { e.preventDefault(); input.removeEventListener("blur", save); cancel(); }
  });
  input.addEventListener("click", (e) => e.stopPropagation());
}
function makeDueEditable(chip, t) {
  if (!chip || !t || (t.id == null && t.taskId == null)) return chip;
  chip.style.cursor = "pointer";
  chip.title = (chip.title ? chip.title + " · " : "") + "Click to edit the due date";
  chip.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); startEditDue(chip, t); });
  return chip;
}

function appendNameCell(row, nm, t, opts) {
  row.appendChild(prioBadge(t));
  // Every task row passes through here, so it's also where the row learns its
  // task object - the delegated estimate editor (document click handler below
  // startEditEstimate) reads it back.
  row._cuTask = t;
  const client = !(opts && opts.hideClient) && t && t.client ? String(t.client) : "";
  const due = dueChip(t);
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
function dueChip(t) {
  const ms = Number(t && t.dueDateMs) || 0;
  if (!ms) {
    const add = document.createElement("span");
    add.className = "cu-due nodue";
    add.textContent = "+ due";
    add.title = "No due date";
    return makeDueEditable(add, t);
  }
  const day = new Date(ms).setHours(0, 0, 0, 0);
  const today = new Date().setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86400000);
  const overdue = diff < 0 && !(t && t.done);
  const chip = document.createElement("span");
  chip.className = "cu-due" + (diff === 0 ? " today" : "") + (overdue ? " overdue" : "");
  chip.textContent = diff === 0 ? "Today" : diff === 1 ? "Tmrw" : diff === -1 ? "Yday"
    : new Date(ms).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }); // compact in the narrow popup
  chip.title = "Due " + new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) +
    (overdue ? " - overdue" : "");
  return makeDueEditable(chip, t);
}

// Shared task-row rendering (upper today card + Filter card use this so the two
// listings are identical). Mirrors the row format of the Filter card. `opts
// .controls` (default true) gates the per-task Start/Stop/Complete buttons - the
// caller turns them OFF for department / other-member scopes (read-only reports).
function appendFilterTaskRows(container, tasks, deadlineTasks, trackedTasks = [], opts = {}) {
  const withControls = opts.controls !== false;
  for (const t of sortByPriority(tasks)) {
    const row = document.createElement("div");
    row.className = "cu-task" + (t.isSubtask ? " cu-sub" : "");
    const nm = document.createElement("a");
    makeTaskLink(nm, t.url, t.name);
    // Subtasks of a due-today parent render indented under it with a ↳ marker.
    nm.textContent = (t.isSubtask ? "↳ " : "") + truncName(t.name || "(untitled task)");
    appendDoneTick(nm, t);
    const spans = document.createElement("span");
    spans.className = "estpairs";
    const estSpan = document.createElement("span");
    estSpan.className = "est" + (t.estimateMs ? "" : " zero");
    estSpan.textContent = t.estimateMs ? fmtDur(t.estimateMs) : "no est";
    estSpan.title = "Click to edit estimate";
    estSpan.style.cursor = "pointer";
    estSpan.addEventListener("click", (e) => { e.stopPropagation(); startEditEstimate(estSpan, t); });
    spans.appendChild(estSpan);
    if (Number(t.spentMs) > 0) {
      const trk = document.createElement("span");
      trk.className = "trk";
      trk.textContent = fmtDur(t.spentMs); markTrk(trk, t);
      spans.appendChild(trk);
    }
    appendNameCell(row, nm, t, opts);
    row.appendChild(spans);
    if (withControls) appendTaskControls(row, t);
    container.appendChild(row);
  }
  for (const dt of sortByPriority(deadlineTasks)) {
    if (dt.error) continue;
    const row = document.createElement("div");
    row.className = "cu-task";
    const nm = document.createElement("a");
    makeTaskLink(nm, dt.url, dt.name);
    nm.textContent = truncName(dt.name || "(configured task)");
    appendDoneTick(nm, dt);
    const spans = document.createElement("span");
    spans.className = "estpairs";
    const estSpan = document.createElement("span");
    estSpan.className = "est" + (dt.dayEstimateMs ? "" : " zero");
    estSpan.textContent = dt.accumulated ? "est " + fmtDur(dt.dayEstimateMs) : fmtDur(dt.dayEstimateMs) + "/day";
    estSpan.title = "Click to edit estimate";
    estSpan.style.cursor = "pointer";
    estSpan.addEventListener("click", (e) => { e.stopPropagation(); startEditEstimate(estSpan, dt); });
    spans.appendChild(estSpan);
    if (Number(dt.spentMs) > 0) {
      const trk = document.createElement("span");
      trk.className = "trk";
      trk.textContent = fmtDur(dt.spentMs); markTrk(trk, dt);
      spans.appendChild(trk);
    }
    appendNameCell(row, nm, dt, opts);
    row.appendChild(spans);
    if (withControls) appendTaskControls(row, dt);
    container.appendChild(row);
  }
  // Tasks tracked in this range but not surfaced by the due/config queries. In
  // the Today scope these are tasks worked today but NOT due today ("Tracked ·
  // not due today"); in other scopes they're date-less tasks ("Tracked · no
  // dates"). The caller passes the right label via opts.trackedLabel.
  if (Array.isArray(trackedTasks) && trackedTasks.length) {
    const sec = document.createElement("div");
    sec.className = "cu-dhead";
    sec.textContent = opts.trackedLabel || "Tracked · no dates";
    container.appendChild(sec);
    for (const t of sortByPriority(trackedTasks)) {
      const row = document.createElement("div");
      row.className = "cu-task";
      const nm = document.createElement("a");
      makeTaskLink(nm, t.url, t.name);
      nm.textContent = truncName(t.name || "(untitled task)");
      appendDoneTick(nm, t);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const estSpan = document.createElement("span");
      estSpan.className = "est zero";
      estSpan.textContent = "no est";
      estSpan.title = "Click to edit estimate";
      estSpan.style.cursor = "pointer";
      estSpan.addEventListener("click", (e) => { e.stopPropagation(); startEditEstimate(estSpan, t); });
      spans.appendChild(estSpan);
      if (Number(t.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDur(t.spentMs); markTrk(trk, t);
        spans.appendChild(trk);
      }
      appendNameCell(row, nm, t, opts);
      row.appendChild(spans);
      if (withControls) appendTaskControls(row, t);
      container.appendChild(row);
    }
  }
}

// "Group subtasks under their parent": arrange the rows ALREADY in view so a
// parent is followed by its own subtasks, indented. Nothing extra is fetched,
// and a subtask whose parent is not in this view simply stays where it was.
function cuGroupSubtaskRows(rows) {
  if (!cuFilter.groupSubtasks) return rows;
  const list = Array.isArray(rows) ? rows : [];
  const present = new Set(list.map((t) => String(t && (t.id != null ? t.id : t.taskId))));
  return list.map((t) => {
    const p = t && t.parentId != null ? String(t.parentId) : null;
    return p && present.has(p) ? { ...t, isSubtask: true } : t;
  });
}

function renderClickupTasks(tasks, deadlineTasks, trackedTasks, scope) {
  tasks = cuGroupSubtaskRows(tasks);
  cuExportRows(tasks, deadlineTasks, trackedTasks, scope);
  const listEl = $("cuTaskList");
  if (!listEl) return;
  listEl.innerHTML = "";
  const hasTasks = Array.isArray(tasks) && tasks.length > 0;
  const hasDeadline = Array.isArray(deadlineTasks) && deadlineTasks.length > 0;
  const hasTracked = Array.isArray(trackedTasks) && trackedTasks.length > 0;
  listEl.style.display = hasTasks || hasDeadline || hasTracked ? "block" : "none";
  if (!hasTasks && !hasDeadline && !hasTracked) return;
  // In the Today scope the tracked section holds tasks worked today but not due
  // today; elsewhere it's date-less tasks. Label it accordingly.
  const trackedLabel = scope === "today" ? "Tracked · not due today" : "Tracked · no dates";
  appendFilterTaskRows(listEl, hasTasks ? tasks : [], hasDeadline ? deadlineTasks : [], hasTracked ? trackedTasks : [], { trackedLabel });
}

// ---------- Estimate editing ----------
// Parse a flexible ClickUp time estimate typed by the user into milliseconds.
// Accepts: "20m", "20min", "20mins", "20minutes", "1h", "1hr", "1hrs",
// "1h30m", "1h 30m", "1 hour 30 minutes", "1.5 (bare number = hours)".
// Returns null when nothing usable was typed.
function parseFlexDuration(s) {
  const raw = String(s || "").trim().toLowerCase();
  if (!raw) return null;
  if (parseFloat(raw) == parseFloat(raw) && /^\d+(\.\d+)?$/.test(raw.trim())) {
    // Bare number or "0.5" -> hours (backward compatible with the old field).
    return Math.round(parseFloat(raw) * 3600000);
  }
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

// Formatting / id helpers for the estimate editor. (These were referenced but
// never defined in the popup, so clicking an existing estimate threw before the
// input appeared, and a successful save threw while repainting.)
function fmtFlexDur(ms) {
  const totalMin = Math.round((Number(ms) || 0) / 60000);
  if (totalMin <= 0) return "";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? h + "h" + (m > 0 ? " " + m + "m" : "") : m + "m";
}
function parseTaskIdFromUrl(url) {
  const m = String(url || "").match(/\/t\/(?:\d+\/)?([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// While an estimate input is open, background repaints (storage listener, 30s
// timers) are deferred - a repaint would destroy the input mid-typing.
let cuEstEditing = false;
let cuRenderPending = false;
function flushDeferredRender() {
  if (cuEstEditing || !cuRenderPending) return;
  cuRenderPending = false;
  load();
}

// A row's estimate may be a per-day SHARE (task spread over several days, the
// Extra task, configured tasks). Editing always sets the task's FULL ClickUp
// estimate, so prefill from the full value (null = total not known here).
function taskFullEstimate(task) {
  if (task.totalEstimateMs != null) return Number(task.totalEstimateMs) || 0;
  if ("dayEstimateMs" in task || task.type === "cfg" || task.extended) return null;
  return Number(task.estimateMs) || 0;
}

function startEditEstimate(span, task) {
  if (span._editing) return;
  const taskId = task.id || task.taskId || parseTaskIdFromUrl(task.url);
  if (!taskId) return;
  span._editing = true;
  cuEstEditing = true;
  const prevText = span.textContent;
  const prevClass = span.className;
  const fullMs = taskFullEstimate(task);
  const isShare = fullMs == null || "dayEstimateMs" in task || fullMs !== (Number(task.estimateMs) || 0);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "est-input";
  input.value = fullMs > 0 ? fmtFlexDur(fullMs) : "";
  input.placeholder = isShare ? "total, e.g. 5h" : "e.g. 20m, 1h 30m";
  input.title = isShare
    ? "Sets the task's TOTAL ClickUp estimate (this row shows only its share for the day). Enter = save, Esc = cancel."
    : "Enter = save, Esc = cancel. Accepts 20m, 1h 30m, 1.5 (hours).";
  span.textContent = "";
  span.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  let saving = false; // Enter and the blur that follows must not send two PUTs
  const finish = (text, cls, title) => {
    if (done) return;
    done = true;
    span.textContent = text;
    span.className = cls;
    span.title = title || "Click to edit estimate";
    span._editing = false;
    cuEstEditing = false;
    flushDeferredRender();
  };
  const cancel = () => finish(prevText, prevClass);
  const save = async () => {
    if (done || saving) return;
    saving = true;
    const raw = input.value.trim();
    const newMs = parseFlexDuration(raw);
    if (!raw || newMs == null || newMs === fullMs) { cancel(); return; }
    input.disabled = true;
    span.classList.add("syncing"); // spinner while the PUT is in flight
    try {
      const resp = await send({ type: "SET_CLICKUP_ESTIMATE", taskId: String(taskId), estimateMs: newMs }, 15000);
      if (!resp || !resp.ok) throw new Error("save failed" + (resp && resp.status ? " (HTTP " + resp.status + ")" : ""));
      task.totalEstimateMs = newMs;
      if (!isShare) { task.estimateMs = newMs; task.hasEstimate = newMs > 0; }
      // Share rows show their new day share once the background recompute lands.
      markEstPending(taskId, newMs, isShare);
      cuRenderPending = true;
      finish(isShare ? prevText : (newMs > 0 ? fmtDur(newMs) : "no est"),
        "est syncing" + (isShare || newMs > 0 ? "" : " zero"), "Saved to ClickUp - syncing totals…");
    } catch (e) {
      finish(prevText, prevClass);
      showPopupToast("Couldn't save estimate: " + (e && e.message ? e.message : e), "warn");
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

// Saved-but-not-yet-synced estimates: taskId -> { ms, isShare, timer }. The row
// shows the new value with a spinner until the background's recompute lands
// (CLICKUP_EST_SYNCED) - so it never looks like the edit was lost. Re-applied
// after every repaint via a MutationObserver, whichever renderer drew the row.
const cuEstPending = new Map();
function markEstPending(taskId, ms, isShare) {
  const id = String(taskId);
  const prev = cuEstPending.get(id);
  if (prev) clearTimeout(prev.timer);
  // Safety net: never spin forever if the sync message is missed.
  const timer = setTimeout(() => { cuEstPending.delete(id); load(); }, 120000);
  cuEstPending.set(id, { ms, isShare, timer });
  applyEstPending();
}
function applyEstPending() {
  if (!cuEstPending.size) return;
  document.querySelectorAll(".cu-task").forEach((row) => {
    const t = row._cuTask;
    if (!t) return;
    const p = cuEstPending.get(String(t.id || t.taskId || ""));
    if (!p) return;
    const el = row.querySelector(".est");
    if (!el || el.querySelector("input")) return;
    if (!p.isShare) {
      const txt = p.ms > 0 ? fmtDur(p.ms) : "no est";
      if (el.textContent !== txt) el.textContent = txt;
      const cls = "est syncing" + (p.ms > 0 ? "" : " zero");
      if (el.className !== cls) el.className = cls;
    } else if (!el.classList.contains("syncing")) {
      el.classList.add("syncing");
    }
    el.title = "Saved to ClickUp - syncing totals…";
  });
}
let cuEstApplyQueued = false;
if (document.body) {
  new MutationObserver(() => {
    if (!cuEstPending.size || cuEstApplyQueued) return;
    cuEstApplyQueued = true;
    requestAnimationFrame(() => { cuEstApplyQueued = false; applyEstPending(); });
  }).observe(document.body, { childList: true, subtree: true });
}
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "CLICKUP_EST_SYNCED") return;
  const id = String(msg.taskId || "");
  const p = cuEstPending.get(id);
  if (p) { clearTimeout(p.timer); cuEstPending.delete(id); }
  load();
});

// ONE delegated handler for every estimate in every task list (today, filter,
// per-client groups, department views...). Capture phase on document, so it
// runs before (and replaces) any per-row listener and no renderer can miss it.
// The row's task comes from row._cuTask, stamped by appendNameCell.
document.addEventListener("click", (e) => {
  const el = e.target && e.target.closest ? e.target.closest(".cu-task .est") : null;
  if (!el || el.querySelector("input")) return;
  const row = el.closest(".cu-task");
  const t = row && row._cuTask;
  if (!t) return;
  e.preventDefault();
  e.stopPropagation();
  startEditEstimate(el, t);
}, true);

// ---------- Client site auto-discovery ----------
async function discoverClientSites() {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId) return [];
  try {
    const res = await fetch("https://api.clickup.com/api/v2/team/" + cfg.teamId + "/task?include_subtasks=false&include_closed=false&limit=100", {
      headers: { "Authorization": cfg.token }
    });
    if (!res.ok) return [];
    const data = await res.json();
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const clients = new Map();
    for (const t of tasks) {
      const container = t.folder || t.list || t.space;
      const clientName = (container && container.name) || (t.folder && t.folder.name) || (t.list && t.list.name);
      if (clientName && !clientName.startsWith("All ") && !clientName.startsWith("Template")) {
        if (!clients.has(clientName)) clients.set(clientName, { name: clientName, taskCount: 0, url: "" });
        clients.get(clientName).taskCount++;
      }
    }
    return Array.from(clients.values());
  } catch (e) {
    return [];
  }
}

// Render the task list grouped by client (used when >=1 client is checked in the
// Filter menu). The lists are already narrowed to the selected clients by the
// caller; here we just split them into per-client sections, each headed by the
// client name + its own est/tracked subtotal. Row format matches the flat list;
// the per-row client pill is suppressed (hideClient) since the header names it.
function renderClickupTasksByClient(tasks, deadlineTasks, trackedTasks, scope, selected) {
  tasks = cuGroupSubtaskRows(tasks);
  cuExportRows(tasks, deadlineTasks, trackedTasks, scope);
  const listEl = $("cuTaskList");
  if (!listEl) return;
  listEl.innerHTML = "";
  const clientOf = (t) => String((t && t.client) || "").trim();
  const order = (Array.isArray(selected) ? selected.filter(Boolean) : []).slice().sort((a, b) => a.localeCompare(b));
  const trackedLabel = scope === "today" ? "Tracked · not due today" : "Tracked · no dates";
  let any = false;
  for (const c of order) {
    const t1 = tasks.filter((t) => clientOf(t) === c);
    const t2 = deadlineTasks.filter((t) => clientOf(t) === c);
    const t3 = trackedTasks.filter((t) => clientOf(t) === c);
    if (!t1.length && !t2.length && !t3.length) continue;
    any = true;
    const est = t1.reduce((a, t) => a + (Number(t.estimateMs) || 0), 0)
      + t2.reduce((a, t) => a + (Number(t.dayEstimateMs) || 0), 0);
    const trk = t1.concat(t2, t3).reduce((a, t) => a + (Number(t.spentMs) || 0), 0);
    const head = document.createElement("div");
    head.className = "cu-dhead cu-clienthead";
    const nameSpan = document.createElement("span");
    nameSpan.className = "cu-chname";
    nameSpan.textContent = c;
    nameSpan.title = c;
    head.appendChild(nameSpan);
    const subSpan = document.createElement("span");
    subSpan.className = "cu-chsub";
    subSpan.textContent = "est " + fmtDur(est) + (trk > 0 ? " · tracked " + fmtDur(trk) : "");
    head.appendChild(subSpan);
    listEl.appendChild(head);
    appendFilterTaskRows(listEl, t1, t2, t3, { trackedLabel, hideClient: true });
  }
  listEl.style.display = any ? "block" : "none";
}

// Filter type -> helpers for date range.
function dayStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}
function dayEnd(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x.getTime();
}
function mondayOf(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const d2 = new Date(d);
  d2.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d2;
}
function weekdayName(dow) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
}

// Render the "Filter Tasks" result for the currently-selected filter.
async function renderFilter() {
  const cu = state.clickup || {};
  const box = $("fltResult");
  const seq = ++fltRenderSeq;
  if (!cu.configured) return;
  const type = $("fltType").value;
  const now = new Date();
  let fromTs, toTs, label;

  if (type === "today") {
    fromTs = dayStart(now);
    toTs = dayEnd(now);
    label = "Today";
  } else if (type === "week") {
    const mon = mondayOf(now);
    const mode = $("fltWeekMode").value;
    if (mode === "day") {
      const dow = Number($("fltWeekDay").value || "1");
      const day = new Date(mon);
      day.setDate(mon.getDate() + (dow - 1));
      fromTs = dayStart(day);
      toTs = dayEnd(day);
      label = weekdayName(dow) + " · " + day.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } else {
      fromTs = dayStart(mon);
      toTs = dayEnd(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 4));
      label = "This week (Mon-Fri)";
    }
  } else {
    const s = $("fltCustomStart").value;
    const d = $("fltCustomDue").value;
    if (s || d) {
      const startD = s ? new Date(s + "T00:00:00") : new Date(now);
      const dueD = d ? new Date(d + "T00:00:00") : new Date(now);
      fromTs = dayStart(startD);
      toTs = dayEnd(dueD);
      label = (s || "today") + " → " + (d || "today");
    } else {
      box.style.display = "none";
      return;
    }
  }

  box.style.display = "block";
  box.innerHTML = '<div class="cu-sub">Loading ' + (label || "") + "…</div>";
  try {
    // Department scope: resolve the Department/User selects into the assignee ids
    // to query. Empty => background queries the signed-in user's own tasks.
    await loadDeptData();
    if (seq !== fltRenderSeq) return;
    let scopeTag = "";
    let assigneeIds = [];
    const deptId = $("fltDept") ? $("fltDept").value : "";
    const selUser = $("fltDeptUser") ? $("fltDeptUser").value : "";
    if (deptId === "__all__") {
      assigneeIds = popupDeptMembers.map((m) => m.id).filter(Boolean);
      scopeTag = " · All users";
    } else if (deptId) {
      const dept = popupDeptList.find((d) => String(d.id) === String(deptId));
      if (selUser) {
        assigneeIds = [selUser];
        const u = dept && dept.users.find((x) => String(x.id) === String(selUser));
        scopeTag = " · " + (dept ? dept.name : "") + " ▸ " + (u ? u.name : "user");
      } else {
        assigneeIds = dept ? (dept.users || []).map((u) => u.id).filter(Boolean) : [];
        scopeTag = dept ? " · " + dept.name : "";
      }
    }
    let fltRes = await send({ type: "CLICKUP_FILTER", fromTs, toTs, assigneeIds: assigneeIds.length ? assigneeIds : [] })
      .catch((e) => ({ ok: false, reason: "send-failed", error: (e && e.message) || String(e) }));
    if (seq !== fltRenderSeq) return;
    // A fresh scope (esp. "All users") computes in the background; poll until the
    // cached result lands instead of surfacing "No response" right away.
    let waitTries = 0;
    if (fltRes && fltRes.ok && fltRes.building && !fltRes.data) {
      while (waitTries < 45) {
        await new Promise((r) => setTimeout(r, 2000));
        waitTries++;
        if (seq !== fltRenderSeq) return;
        fltRes = await send({ type: "CLICKUP_FILTER", fromTs, toTs, assigneeIds: assigneeIds.length ? assigneeIds : [] })
          .catch((e) => ({ ok: false, reason: "send-failed", error: (e && e.message) || String(e) }));
        if (seq !== fltRenderSeq) return;
        if (!fltRes || !fltRes.ok || fltRes.data) break;
      }
    }
    if (seq !== fltRenderSeq) return;
    if (!fltRes || !fltRes.ok || !fltRes.data) {
      const why = (fltRes && (fltRes.error || fltRes.reason)) || (fltRes && fltRes.building ? "is still computing - try again in a moment." : "");
      box.innerHTML = '<div class="cu-sub err">Couldn\x27t load: ' + (why || "unknown") + "</div>";
      return;
    }
    const d = fltRes.data;
    label = label + scopeTag;
    const est = Number(d.estimateMs) || 0;
    const spent = Number(d.spentMs) || 0;
    const tasks = d.tasks || [];
    const deadline = d.deadlineTasks || [];
    // Read the active filter flags. All that are checked must be satisfied (AND).
    const flt = {
      estimate: !!($("fltOnlyMissing") && $("fltOnlyMissing").checked),
      start: !!($("fltMissingStart") && $("fltMissingStart").checked),
      due: !!($("fltMissingDue") && $("fltMissingDue").checked),
      incomplete: !!($("fltIncomplete") && $("fltIncomplete").checked),
      overdue: !!($("fltOverdue") && $("fltOverdue").checked),
      span: !!($("fltSpan") && $("fltSpan").checked),
    };
    const active = Object.keys(flt).filter((k) => flt[k]);
    // "Deadline crossed" = the due DAY is strictly before today. Comparing whole
    // days (not the exact due timestamp) so a task due TODAY - including due dates
    // with no time component, which ClickUp stores at an arbitrary hour - is never
    // counted as crossed; only tasks whose due date fell on an earlier day are.
    const todayStartMs = new Date().setHours(0, 0, 0, 0);
    const isOverdue = (t) => {
      if (t.done) return false;
      const d = Number(t.dueDateMs) || 0;
      if (!d) return false;
      return new Date(d).setHours(0, 0, 0, 0) < todayStartMs;
    };
    const passes = (t) =>
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
    const shownTasks = tasks.filter(passes);
    const shownTracked = (Array.isArray(d.trackedTasks) ? d.trackedTasks : []).filter(passes);
    const shownDeadline = deadline.filter((dt) => {
      if (dt.error) return false;
      return active.every((k) => {
        switch (k) {
          case "estimate": return !Number(dt.dayEstimateMs);
          case "start": return !Number(dt.startDateMs);
          case "due": return !Number(dt.dueDateMs);
          case "incomplete": return !dt.done;
          case "overdue": return isOverdue(dt);
          case "span": {
            const a = Number(dt.startDateMs) || 0;
            const b = Number(dt.dueDateMs) || 0;
            if (!a || !b) return false;
            return new Date(a).setHours(0, 0, 0, 0) !== new Date(b).setHours(0, 0, 0, 0);
          }
        }
        return true;
      });
    });
    box.innerHTML = "";
    const totalEl = document.createElement("div");
    totalEl.className = "cu-sub";
    const filterTags = active.map((k) => ({
      estimate: "missing estimates",
      start: "missing start date",
      due: "missing due date",
      incomplete: "incomplete",
      overdue: "deadline crossed",
      span: "start ≠ due",
    }[k] || k)).join(" · ");
    totalEl.innerHTML =
      "<b>" + (label || "") + "</b> · est <b>" + fmtDur(est) + "</b> · tracked <b>" + fmtDur(spent) + "</b>" +
      " · " + (shownTasks.length + shownDeadline.length + shownTracked.length) + " task" + ((shownTasks.length + shownDeadline.length + shownTracked.length) === 1 ? "" : "s") +
      (active.length ? " <span style=\"color:var(--amber)\">(filter: " + filterTags + ")</span>" : "");
    box.appendChild(totalEl);
    const list = document.createElement("div");
    list.className = "cu-tasklist";
    // Live controls only when viewing your OWN tasks (no department/user scope).
    // In the Today preset the tracked section = worked today but not due today.
    const trackedLabel = type === "today" ? "Tracked · not due today" : "Tracked · no dates";
    appendFilterTaskRows(list, shownTasks, shownDeadline, shownTracked, { controls: assigneeIds.length === 0, trackedLabel });
    box.appendChild(list);
  } catch (e) {
    box.innerHTML = '<div class="cu-sub err">Couldn\x27t load: ' + (e && e.message ? e.message : e) + "</div>";
  }
}

// Collapsible Weekly Totals + Filter Tasks cards. Each card keeps its title bar
// (with a ▾/▸ button) and hides its body, so the vertical space actually closes
// - unlike the security notice which keeps its slot. State persists in local
// storage and defaults to collapsed.
const COLLAPSE_KEYS = { weekly: "cuCollapseWeekly", filter: "cuCollapseFilter" };
async function initCollapseToggles() {
  const stored = (await chrome.storage.local.get(Object.values(COLLAPSE_KEYS))) || {};
  document.querySelectorAll("[data-collapse]").forEach((btn) => {
    const key = btn.dataset.collapse;
    const card = btn.closest(".card");
    if (!key || !card) return;
    const cacheKey = COLLAPSE_KEYS[key];
    const collapsed = stored[cacheKey] !== false;
    const apply = (col) => {
      card.classList.toggle("collapsed", col);
      btn.textContent = (col || card.style.display === "none") ? "▸" : "▾";
    };
    apply(collapsed);
    btn.onclick = () => {
      const nc = !card.classList.contains("collapsed");
      apply(nc);
      chrome.storage.local.set({ [cacheKey]: nc }).catch(() => {});
    };
  });
}

function initFilterControls() {
  const type = $("fltType");
  const weekMode = $("fltWeekMode");
  const weekDay = $("fltWeekDay");
  const customRow = $("fltCustomRow");
  const weekRow = $("fltWeekRow");
  const show = () => {
    const t = type.value;
    weekRow.style.display = t === "week" ? "flex" : "none";
    customRow.style.display = t === "custom" ? "flex" : "none";
    const m = weekMode.value;
    weekDay.style.display = t === "week" && m === "day" ? "inline-block" : "none";
  };
  type.onchange = () => { show(); renderFilter(); };
  weekMode.onchange = () => { show(); renderFilter(); };
  weekDay.onchange = () => renderFilter();
  $("fltCustomStart").onchange = renderFilter;
  $("fltCustomDue").onchange = renderFilter;
  ["fltOnlyMissing", "fltMissingStart", "fltMissingDue", "fltIncomplete", "fltOverdue", "fltSpan"].forEach((id) => {
    const el = $(id);
    if (el) el.onchange = renderFilter;
  });
  const dsel = $("fltDept");
  if (dsel) dsel.onchange = () => { syncDeptUserSelect(); renderFilter(); };
  const dusel = $("fltDeptUser");
  if (dusel) dusel.onchange = renderFilter;
  show();
}

// Render the weekly totals card. fetchWeeklySummary (in the background) already
// computed BOTH Mon→today and Mon→Friday aggregates during the last refresh, so
// the ToToday/ToFriday toggle just repaints from the cached state - no lag.
function renderWeekly() {
  const cu = state.clickup || {};
  const card = $("weekCard");
  const w = cu.state && cu.state.weekly;
  const wkList = $("weekList");
  if (!cu.configured || !w || !w.today || !w.friday) {
    if (card) card.style.display = "none";
    if (wkList) { wkList.style.display = "none"; wkList.innerHTML = ""; }
    return;
  }
  card.style.display = "block";
  const targetMs = Number(cu.state.targetMs) || 0;
  const to = (cu.weeklyTo === "friday" ? "friday" : "today");
  const agg = to === "friday" ? w.friday : w.today;
  const est = Number(agg.estimateMs) || 0;
  const spent = Number(agg.spentMs) || 0;
  $("weekEst").textContent = fmtDur(est);
  $("weekEstTarget").textContent = targetMs > 0 ? "of " + fmtDur(targetMs) + "/day" : "";
  $("weekTrk").textContent = fmtDur(spent);
  const fromD = new Date(agg.fromTs);
  const toD = new Date(agg.toTs);
  const cnt = agg.count || 0;
  $("weekSub").textContent =
    "Accumulated " + fromD.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " → " + toD.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " · " + cnt + (cnt === 1 ? " weekday" : " weekdays");
  document.querySelectorAll("#weekToggle button").forEach((b) => {
    const on = b.dataset.to === to;
    b.className = on ? "on" : "";
    b.onclick = async () => {
      if (on) return;
      await send({ type: "CLICKUP_SET", patch: { clickupWeeklyTo: b.dataset.to } });
      await load();
    };
  });
  renderWeekDetail(w, agg);
}

// Per-weekday task detail under the weekly totals (shown when the card is
// expanded). Mirrors the options page's optWeekList: one block per day up to
// the selected toggle (today / friday), reusing the cached perDay breakdown.
function renderWeekDetail(w, agg) {
  const box = $("weekList");
  if (!box) return;
  box.innerHTML = "";
  const days = Array.isArray(w.perDay)
    ? w.perDay.filter((d) => d.ts <= agg.toTs)
    : [];
  if (!days.length) { box.style.display = "none"; return; }
  box.style.display = "block";
  for (const d of days) {
    const head = document.createElement("div");
    head.className = "cu-dhead";
    const dateTxt = new Date(d.ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    head.textContent = weekdayName(new Date(d.ts).getDay()) + " · " + dateTxt +
      " - est " + fmtDur(d.estimateMs) + " · tracked " + fmtDur(d.spentMs);
    box.appendChild(head);
    const rows = dedupeExtraRows(Array.isArray(d.tasks) ? d.tasks : []);
    const trackedRows = Array.isArray(d.trackedTasks) ? d.trackedTasks : [];
    if (!rows.length && !trackedRows.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "(no tasks this day)";
      box.appendChild(e);
      continue;
    }
    for (const t of sortByPriority(rows)) {
      const row = document.createElement("div");
      row.className = "cu-task";
      const nm = document.createElement("a");
      makeTaskLink(nm, t.url, t.name);
      nm.textContent = truncName(t.name || "(untitled task)");
      appendDoneTick(nm, t);
      const spans = document.createElement("span");
      spans.className = "estpairs";
      const est = document.createElement("span");
      est.className = t.estimateMs ? "est" : "est zero";
      est.textContent = t.estimateMs ? fmtDur(t.estimateMs) : "no est";
      spans.appendChild(est);
      if (Number(t.spentMs) > 0) {
        const trk = document.createElement("span");
        trk.className = "trk";
        trk.textContent = fmtDur(t.spentMs); markTrk(trk, t);
        spans.appendChild(trk);
      }
      appendNameCell(row, nm, t, {});
      row.appendChild(spans);
      box.appendChild(row);
    }
    if (trackedRows.length) {
      const sec = document.createElement("div");
      sec.className = "cu-dhead";
      sec.textContent = "Tracked · no dates";
      box.appendChild(sec);
      for (const t of sortByPriority(trackedRows)) {
        const row = document.createElement("div");
        row.className = "cu-task";
        const nm = document.createElement("a");
        makeTaskLink(nm, t.url, t.name);
        nm.textContent = truncName(t.name || "(untitled task)");
        appendDoneTick(nm, t);
        const spans = document.createElement("span");
        spans.className = "estpairs";
        const est = document.createElement("span");
        est.className = "est zero";
        est.textContent = "no est";
        spans.appendChild(est);
        if (Number(t.spentMs) > 0) {
          const trk = document.createElement("span");
          trk.className = "trk";
          trk.textContent = fmtDur(t.spentMs); markTrk(trk, t);
          spans.appendChild(trk);
        }
        appendNameCell(row, nm, t, {});
        row.appendChild(spans);
        box.appendChild(row);
      }
    }
  }
}

// ---- ClickUp quick-filter (all-checkbox model; mirrored in options.js + the
// badge in background.js) ----------------------------------------------------
// Date scopes are nested (today ⊂ this-week ⊂ till-Friday), so the headline
// estimate/tracked bars - and the toolbar badge - follow the WIDEST checked
// scope. With nothing checked we keep the previous default: the extended
// "active today" view (state.todayFilter). The refine boxes
// (missingEst / hasTracked / deadlineCrossed) and the Status / Priority sections
// narrow the visible task LIST only; they never change the headline totals or
// the badge.
// "Due today" is ticked by default (a saved choice always wins).
let cuFilter = { dueToday: true, dueTomorrow: false, dueWeek: false, dueNextWeek: false, dueCustom: false, missingDue: false, customFrom: "", customTo: "", missingEst: false, hasTracked: false, deadlineCrossed: false, waitingOthers: false, statuses: [], priorities: [], clients: [] };
const CU_FILTER_KEYS = ["dueToday", "dueTomorrow", "dueWeek", "dueNextWeek", "dueCustom", "missingEst", "missingDue", "hasTracked", "deadlineCrossed", "waitingOthers", "groupSubtasks"];
const CU_PRIORITY_ORDER = ["urgent", "high", "normal", "low", "none"];

function cuTodayEndMs() { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); }

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
// day BEFORE today (day-floor compare, mirrors options.js) so tasks due today
// never count. Status/Priority are OR within a group, AND across groups.
// `t.priority` is a lower-case name ("" → treated as "none").
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
  renderClickup(); renderCuFilterMenu();
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
function cuCustomOnReady() { renderClickup(); renderCuFilterMenu(); }
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
    spentMs: sum(tasks, "spentMs") + sum(deadlineTasks, "spentMs"),
    tasks, deadlineTasks, trackedTasks: [],
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
  // Configured tasks already hold this range's share - don't due-filter them.
  const deadlineTasks = Array.isArray(d.deadlineTasks) ? d.deadlineTasks : [];
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

const CU_SCOPE_LABEL = { today: "due today", tomorrow: "due tomorrow", week: "this week", nextweek: "due next week", extended: "active today" };
function cuActiveFilterCount(f) {
  return CU_FILTER_KEYS.reduce((n, k) => n + (f[k] ? 1 : 0), 0)
    + (Array.isArray(f.statuses) ? f.statuses.length : 0)
    + (Array.isArray(f.priorities) ? f.priorities.length : 0)
    + (Array.isArray(f.clients) ? f.clients.length : 0);
}

function renderClickup() {
  if (cuEstEditing) { cuRenderPending = true; return; }
  const cu = state.clickup || {};
  const statsCard = $("statsCard");
  const filterCard = $("filterCard");
  const setup = $("clickupSetup");
  if (!cu.configured) {
    if (statsCard) statsCard.style.display = "none";
    if (filterCard) filterCard.style.display = "none";
    $("weekCard").style.display = "none";
    if (setup) setup.style.display = "block";
    return;
  }
  if (setup) setup.style.display = "none";
  if (statsCard) statsCard.style.display = "block";
  if (filterCard) filterCard.style.display = "block";

  const st = cu.state || null;
  renderClickupTimer(st);
  renderNowTracking();
  // The upper (today) card mirrors the Filter dropdown. The headline estimate +
  // tracked bars follow the WIDEST checked DATE scope (resolveCuFilterView);
  // nothing checked keeps the previous default (extended "active today" =
  // state.todayFilter). Refine boxes (missingEst/deadlineCrossed) only narrow the
  // task LIST below - they never move these bars or the toolbar badge.
  const view = resolveCuFilterView(st || {}, cuFilter);
  const targetMs = st && Number(st.targetMs) > 0 ? Number(st.targetMs) : (Number(cu.targetHours) || 0) * 3600000;
  const estMs = Number(view.estimateMs) || 0;
  const spentTot = Number(view.spentMs) || 0;

  $("cuTotal").textContent = st ? fmtDur(estMs) : "-";
  $("cuTarget").textContent = targetMs > 0 ? "/ " + fmtDur(targetMs) : "";

  const fill = $("cuFill");
  const pct = targetMs > 0 ? Math.min(100, Math.round((estMs / targetMs) * 100)) : 0;
  fill.style.width = pct + "%";
  const met = targetMs > 0 && estMs >= targetMs;
  fill.className = "cu-fill" + (met ? " met" : "");
  $("cuEstVal").textContent = st ? fmtDur(estMs) + (targetMs > 0 ? " / " + fmtDur(targetMs) : "") : "-";

  const trk = $("cuFillTrk");
  const trkPct = targetMs > 0 ? Math.min(100, Math.round((spentTot / targetMs) * 100)) : 0;
  trk.style.width = trkPct + "%";
  const trkMet = targetMs > 0 && spentTot >= targetMs;
  trk.className = "cu-fill trk" + (trkMet ? " met" : "");
  $("cuTrkVal").textContent = st ? fmtDur(spentTot) + (targetMs > 0 ? " / " + fmtDur(targetMs) : "") : "-";

  const sub = $("cuSub");
  if (!st) {
    sub.className = "cu-sub";
    sub.textContent = "Loading today's estimate…";
    return;
  }
  if (st.error) {
    sub.className = "cu-sub err";
    sub.textContent = "Couldn't refresh: " + st.error + (st.at ? " · last total from " + fmtClock(st.at) : "");
    return;
  }
  sub.className = "cu-sub";
  let taskList = Array.isArray(view.tasks) ? view.tasks : [];
  let deadlineList = Array.isArray(view.deadlineTasks) ? view.deadlineTasks : [];
  let trackedList = Array.isArray(view.trackedTasks) ? view.trackedTasks : [];
  // Refine boxes narrow the visible list only (headline/bars/badge stay on the
  // date scope). deadlineCrossed = not done AND due date on a day before today;
  // rows without a due date (some week-scope rows) simply never match.
  const refineOn = cuFilter.missingEst || cuFilter.missingDue || cuFilter.waitingOthers || cuFilter.deadlineCrossed || cuFilter.hasTracked
    || (cuFilter.statuses && cuFilter.statuses.length) || (cuFilter.priorities && cuFilter.priorities.length);
  if (refineOn) {
    const keep = cuRefinePredicate(cuFilter);
    const todayStart = new Date().setHours(0, 0, 0, 0);
    taskList = taskList.filter(keep);
    trackedList = trackedList.filter(keep);
    deadlineList = deadlineList.filter((d) => {
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
  // Client filter: when >=1 client is checked, keep only those clients' rows.
  // Composes with the refine filters above; the list is then grouped by client
  // (each group carries its own est/tracked subtotal). Headline bars + badge
  // stay on the date scope - same rule as Status/Priority.
  const clientsSel = Array.isArray(cuFilter.clients) ? cuFilter.clients.filter(Boolean) : [];
  if (clientsSel.length) {
    const set = new Set(clientsSel);
    const keepC = (t) => set.has(String((t && t.client) || "").trim());
    taskList = taskList.filter(keepC);
    deadlineList = deadlineList.filter(keepC);
    trackedList = trackedList.filter(keepC);
  }
  const taskCount = taskList.length;
  const noEstimateCount = taskList.filter((t) => !Number(t.estimateMs)).length;
  const bits = [];
  if (view.scope && view.scope !== "extended") bits.push(view.label || CU_SCOPE_LABEL[view.scope]);
  bits.push(taskCount + (taskCount === 1 ? " task" : " tasks"));
  bits.push("est " + fmtDur(estMs) + (targetMs > 0 ? " / " + fmtDur(targetMs) : ""));
  if (met) bits.push("met ✓");
  else if (targetMs > 0) bits.push(fmtDur(Math.max(0, targetMs - estMs)) + " to go");
  if (spentTot > 0) bits.push("tracked " + fmtDur(spentTot));
  const deadlineMs = deadlineList.reduce((a, d) => a + (Number(d.dayEstimateMs) || 0), 0);
  if (deadlineMs > 0) bits.push("deadline +" + fmtDur(deadlineMs));
  if (noEstimateCount) bits.push(noEstimateCount + " w/o est");
  if (refineOn) {
    const tags = [];
    if (cuFilter.missingEst) tags.push("missing estimate");
    if (cuFilter.missingDue) tags.push("missing due date");
    if (cuFilter.waitingOthers) tags.push("waiting on others");
    if (cuFilter.hasTracked) tags.push("tracked");
    if (cuFilter.deadlineCrossed) tags.push("deadline crossed");
    if (cuFilter.statuses && cuFilter.statuses.length) tags.push("status: " + cuFilter.statuses.join("/"));
    if (cuFilter.priorities && cuFilter.priorities.length) tags.push("priority: " + cuFilter.priorities.join("/"));
    bits.push("filter: " + tags.join(" + "));
  }
  if (clientsSel.length) bits.push("client: " + clientsSel.join("/"));
  if (st.at) bits.push("updated " + fmtClock(st.at));
  sub.textContent = bits.join(" · ");

  if (clientsSel.length) renderClickupTasksByClient(taskList, deadlineList, trackedList, view.scope, clientsSel);
  else renderClickupTasks(taskList, deadlineList, trackedList, view.scope);
  renderCuFilterMenu();
  renderFilter();
  renderWeekly();
}

// One-click Start/Stop timer for the auto-detected "Extra(s) Task(s)". Reads the
// live running entry (st.running) vs the detected task (st.extraTask) to decide
// the label/action. Re-wired each render so the closure always has fresh state.

// ---------- "Tracking now" strip ----------
// Shown above the task list ONLY while a ClickUp timer is running: task name
// (opens in ClickUp), live elapsed time and a Stop button. Hidden otherwise.
let cuNowTimer = null;
function renderNowTracking() {
  const el = document.getElementById("cuNow");
  if (!el) return;
  const st = (state && state.clickup && state.clickup.state) || null;
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
  const tick = () => { time.textContent = run.startMs ? fmtDur(Math.max(0, Date.now() - run.startMs)) : ""; };
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
    sendTaskAction(String(run.taskId), "stop");
  };
  top.append(dot, lab, nm, time, stop);
  const noteRow = document.createElement("div");
  noteRow.className = "cu-now-noterow";
  noteRow.append(note, saved);
  el.append(top, noteRow);
}


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

function renderClickupTimer(st) {
  const row = $("cuTimerRow");
  const btn = $("cuTimerBtn");
  const hint = $("cuTimerHint");
  if (!row || !btn || !hint) return;
  if (!st) { row.style.display = "none"; return; }
  row.style.display = "flex";
  const extra = st.extraTask && st.extraTask.id ? st.extraTask : null;
  const running = st.running && st.running.taskId ? st.running : null;
  if (!extra) {
    btn.textContent = "▶ Start Extra Task";
    btn.className = "cu-timer-btn";
    btn.disabled = true;
    btn.onclick = null;
    hint.textContent = cuTimerMsg || "No “Extra Tasks” task detected for you yet.";
    return;
  }
  const onExtra = running && String(running.taskId) === String(extra.id);
  showExtraMode(!onExtra);
  btn.disabled = cuTimerBusy;
  if (onExtra) {
    btn.textContent = cuTimerBusy ? "…" : "⏸ Stop";
    btn.className = "cu-timer-btn stop";
    btn.onclick = () => toggleExtraTimer("stop");
    hint.textContent = cuTimerMsg || ("Tracking " + (running.taskName || extra.name || "Extra Tasks") +
      (running.startMs ? " · since " + fmtClock(running.startMs) : ""));
  } else {
    btn.textContent = cuTimerBusy ? "…" : "▶ Start Extra Task";
    btn.className = "cu-timer-btn";
    btn.onclick = () => toggleExtraTimer("start");
    if (cuTimerMsg) hint.textContent = cuTimerMsg;
    else if (running) hint.textContent = "Tracking " + (running.taskName || "another task") + " — click to switch to " + (extra.name || "Extra Tasks") + ".";
    else hint.textContent = extra.name ? ("Ready: " + extra.name) : "Start tracking your Extra Tasks task.";
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
    const description = action === "stop" ? undefined : extraModeDescription();
    const res = await send({ type, description }, 20000);
    if (res && res.ok !== false && action !== "stop") resetExtraMode();
    cuTimerBusy = false;
    if (!res || res.ok === false) {
      const reason = res && res.reason;
      const map = { "not-configured": "connect ClickUp first", "incomplete-setup": "pick a workspace first", "no-task": "no Extra Tasks task detected" };
      cuTimerMsg = "Couldn't " + (action === "stop" ? "stop" : "start") + ": " + ((res && res.error) || map[reason] || reason || "unknown error");
      renderClickup(); // re-render keeps cuTimerMsg visible and re-enables the button
      return;
    }
  } catch (e) {
    cuTimerBusy = false;
    cuTimerMsg = "Couldn't update timer: " + (e && e.message ? e.message : e);
    renderClickup();
    return;
  }
  // Success: the background updated clickupState (fires the storage listener too),
  // but load() here guarantees an immediate repaint with the new running state.
  await load();
}

// "📋" header button: opens the wrap-up page (any time, once ClickUp is connected).
function updateWrapBtn() {
  const b = $("wrapBtn");
  if (!b) return;
  const cu = state && state.clickup;
  let show = false;
  if (cu && cu.configured) show = true;
  b.hidden = !show;
}

function render() {
  updateWrapBtn();
  if (cuEstEditing) { cuRenderPending = true; return; }
  const list = $("list");
  const accounts = state.accounts || [];
  if (!accounts.length) {
    list.innerHTML =
      '<div class="empty">No accounts yet.<br/>Click <b>Manage</b> to add a GitHub account.</div>';
    $("runAll").disabled = true;
  } else {
    $("runAll").disabled = !!state.running;
    list.innerHTML = "";
    for (const a of accounts) {
      const s = statusFor(a);
      const row = document.createElement("div");
      row.className = "acct";

      const dot = document.createElement("div");
      dot.className = "dot " + s.cls;

      const meta = document.createElement("div");
      meta.className = "meta";
      const name = document.createElement("div");
      name.className = "name";
      const modeSuffix = a.mode === "off" ? " (off)" : a.mode === "reminder" ? " (reminder)" : "";
      name.textContent = a.label + modeSuffix;
      const stat = document.createElement("div");
      stat.className = "stat" + (s.attention ? " attention" : "");
      stat.textContent = s.text;
      meta.appendChild(name);
      const who = a.detectedEmail || a.username || "";
      if (who && who !== a.label) {
        const user = document.createElement("div");
        user.className = "user";
        user.textContent = who;
        user.title = who;
        meta.appendChild(user);
      }

      const bal = document.createElement("div");
      bal.className = "balance";
      const balInfo = state.balances && state.balances[a.id];
      const hasBal = balInfo && Number.isFinite(Number(balInfo.value));
      const balText = document.createElement("span");
      if (hasBal) {
        balText.textContent = "Bal: " + fmtBalance(balInfo.value) + (balInfo.at ? " · as of " + fmtDayTime(balInfo.at) : "");
        balText.title = "Raw quota: " + balInfo.value + (balInfo.at ? "\nas of " + fmtDayTime(balInfo.at) : "");
      } else {
        balText.textContent = "Bal: -";
        balText.title = "No balance captured yet - it's read after a successful login, or click ⟳ with Agent Router open as this account.";
      }
      bal.appendChild(balText);
      const refreshBtn = document.createElement("button");
      refreshBtn.className = "refreshBalanceBtn";
      refreshBtn.textContent = "⟳";
      refreshBtn.title = "Refresh from the open Agent Router tab";
      refreshBtn.onclick = async (ev) => {
        ev.stopPropagation();
        refreshBtn.disabled = true;
        refreshBtn.textContent = "…";
        try {
          const res = await send({ type: "FETCH_BALANCE", id: a.id });
          if (res && res.ok && res.matched) { await load(); return; }
          if (res && res.reason === "no-tab") {
            balText.textContent = "Open Agent Router, then ⟳";
          } else if (res && res.reason === "identity-mismatch" && res.loggedInAs) {
            balText.textContent = "That tab is " + res.loggedInAs;
            balText.title = "The open Agent Router tab is signed in as " + res.loggedInAs +
              ", not this account. Open Agent Router as this account, then click ⟳.";
          } else {
            balText.textContent = "Log in as this account to refresh";
          }
        } catch (e) {
          balText.textContent = "Couldn't refresh";
        }
        refreshBtn.textContent = "⟳";
        refreshBtn.disabled = false;
      };
      bal.appendChild(refreshBtn);
      meta.appendChild(bal);

      // Availability chip: can this account actually use Claude right now (vs. a
      // blocked window that the balance number can't reveal)?
      const av = state.availability && state.availability[a.id];
      const view = availView(av, !!a.hasSession);
      const avRow = document.createElement("div");
      avRow.className = "avail";
      const adot = document.createElement("span");
      adot.className = "adot " + view.dot;
      const alabel = document.createElement("span");
      alabel.className = "alabel" + (view.cls ? " " + view.cls : "");
      alabel.textContent = view.label;
      if (view.title) alabel.title = view.title;
      avRow.appendChild(adot);
      avRow.appendChild(alabel);
      if (view.btn) {
        const abtn = document.createElement("button");
        abtn.className = "abtn";
        abtn.textContent = view.btn;
        abtn.title = view.create
          ? "Create a relay key on this account and run a test request."
          : "Run a fresh availability test now.";
        abtn.onclick = async (ev) => {
          ev.stopPropagation();
          abtn.disabled = true;
          abtn.textContent = "…";
          try {
            // Probe can list tokens + fetch a key + call the model, so allow time.
            await send({ type: "PROBE_AVAILABILITY", id: a.id, force: true, create: !!view.create }, 30000);
          } catch (e) {}
          await load();
        };
        avRow.appendChild(abtn);
      }
      meta.appendChild(avRow);

      meta.appendChild(stat);
      if (s.sub) {
        const sub = document.createElement("div");
        sub.className = "substat";
        sub.textContent = s.sub;
        meta.appendChild(sub);
      }

      const actions = document.createElement("div");
      actions.className = "actions";

      const btn = document.createElement("button");
      btn.className = "runBtn";
      btn.textContent = "Run";
      btn.disabled = !!state.running;
      btn.onclick = async () => {
        btn.disabled = true;
        await send({ type: "RUN_ONE", id: a.id });
        state.running = true;
        render();
      };
      actions.appendChild(btn);

      const del = document.createElement("button");
      del.className = "iconBtn";
      del.textContent = "🗑";
      del.title = "Delete this account";
      del.disabled = !!state.running;
      let armed = false;
      let armTimer = null;
      del.onclick = async () => {
        if (!armed) {
          armed = true;
          del.classList.add("confirm");
          del.textContent = "✓";
          del.title = "Click again to delete - this removes its stored credentials";
          armTimer = setTimeout(() => {
            armed = false;
            del.classList.remove("confirm");
            del.textContent = "🗑";
            del.title = "Delete this account";
          }, 3000);
          return;
        }
        clearTimeout(armTimer);
        del.disabled = true;
        await send({ type: "DELETE_ACCOUNT", id: a.id });
        await load();
      };
      actions.appendChild(del);

      row.appendChild(dot);
      row.appendChild(meta);
      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  $("runAll").textContent = state.running ? "Running…" : "Run all now";
  // While a run is in flight, swap "Run all now" for a Stop button that cancels
  // the login loop (RUN_CANCEL). The background loop checks the cancel flag each
  // iteration and bails out as "Stopped by user."
  $("runAll").style.display = state.running ? "none" : "block";
  $("stopAll").style.display = state.running ? "block" : "none";
  const anyReminder = (state.accounts || []).some((a) => a.mode === "reminder");
  $("reminderNote").style.display = anyReminder ? "block" : "none";

  const on = !!state.signedIn;
  // Drive busy phase from the background survives the popup closing during the
  // interactive Google window, so reopening the popup still shows the right line.
  const busy = state.driveBusy || "";
  if (busy === "signin") {
    $("syncDot").className = "syncdot running";
    $("syncLabel").textContent = "Signing in…";
    $("googleBtn").textContent = "Working…";
    $("googleBtn").disabled = true;
    $("syncNow").style.display = "none";
  } else if (busy === "sync") {
    $("syncDot").className = "syncdot running";
    $("syncLabel").textContent = "Syncing…";
    $("googleBtn").textContent = on ? "Sign out" : "Sign in";
    $("googleBtn").disabled = true;
    $("syncNow").style.display = on ? "inline" : "none";
  } else {
    $("syncDot").className = "syncdot" + (on ? " on" : "");
    // Right after a sign-in or manual sync finishes, briefly show a confirmation
    // ("Synced ✓ 12:10 PM · Sep 6") instead of immediately reverting to the
    // plain "Drive sync on" - so it's obvious the sync actually happened.
    $("syncLabel").textContent = (transientSyncText && Date.now() < transientSyncUntil)
      ? transientSyncText
      : (on ? "Drive sync on" : "Drive sync off");
    $("googleBtn").textContent = on ? "Sign out" : "Sign in";
    $("googleBtn").disabled = false;
    $("syncNow").style.display = on ? "inline" : "none";
  }
  const lastSyncEl = $("lastSyncLine");
  if (lastSyncEl) {
    if (on) {
      lastSyncEl.style.display = "block";
      lastSyncEl.textContent = state.driveLastSync
        ? "Last synced: " + fmtSyncStamp(state.driveLastSync)
        : "Not synced yet.";
    } else {
      lastSyncEl.style.display = "none";
    }
  }

  renderClickup();
}


async function load() {
  const s = await send({ type: "GET_STATE" });
  if (s) state = s;
  applyArVisibility(state);
  render();
}

$("runAll").onclick = async () => {
  if (state.running) return;
  const res = await send({ type: "RUN_ALL" });
  if (res && res.ok) {
    state.running = true;
    render();
  } else if (res && res.reason) {
    $("runAll").textContent = res.reason === "no accounts" ? "Add an account first" : "Busy…";
  }
};

$("stopAll").onclick = async () => {
  $("stopAll").textContent = "Stopping…";
  $("stopAll").disabled = true;
  await send({ type: "RUN_CANCEL" });
  // Give the loop a moment to bail, then refresh (it flips running=false).
  setTimeout(() => {
    $("stopAll").textContent = "Stop";
    $("stopAll").disabled = false;
    load();
  }, 800);
};

$("manage").onclick = () => chrome.runtime.openOptionsPage();

$("googleBtn").onclick = async () => {
  if (state.signedIn) {
    // Sign-out now clears the accounts saved on this device (so a different Google
    // account can sign in and show its own accounts). Confirm first - it's
    // destructive locally - and reassure that Drive keeps a backup.
    const ok = confirm(
      "Sign out of Google Drive?\n\n" +
      "This removes the Agent Router accounts saved on this device. " +
      "They're backed up to Drive first and come back when you sign in again."
    );
    if (!ok) return;
    // Show progress: the sign-out pushes a final backup to Drive before wiping,
    // which can take a moment on a cold connection.
    state.driveBusy = "sync";
    render();
    await send({ type: "GOOGLE_SIGN_OUT" });
    transientSyncText = "";
    load();
    return;
  }
  // Sign-in takes a few seconds (interactive Google flow): show progress instead
  // of silence so the user knows the popup is working and didn't freeze. The
  // background tracks the "signin" phase too, so if this popup closes when the
  // Google window steals focus, reopening it still shows "Signing in…".
  state.driveBusy = "signin";
  render();
  const res = await send({ type: "GOOGLE_SIGN_IN" });
  if (res && res.ok) {
    transientSyncText = "Synced ✓ " + fmtSyncStamp(res.syncedAt || Date.now());
    transientSyncUntil = Date.now() + 3500;
    setTimeout(() => { transientSyncText = ""; render(); }, 3500);
  }
  await load();
};

$("syncNow").onclick = async () => {
  state.driveBusy = "sync";
  render();
  const res = await send({ type: "SYNC_NOW" });
  if (res && res.ok) {
    transientSyncText = "Synced ✓ " + fmtSyncStamp(res.syncedAt || Date.now());
    transientSyncUntil = Date.now() + 3500;
    setTimeout(() => { transientSyncText = ""; render(); }, 3500);
  }
  await load();
};

$("resetAll").onclick = async () => {
  await send({ type: "RESET_STATUS" });
  load();
};

$("refresh").onclick = load;

$("cuRefresh").onclick = async () => {
  const btn = $("cuRefresh");
  if (btn.classList.contains("spin")) return;
  btn.classList.add("spin");
  try {
    // Explicit click: also recompute the due-this/next-week bundles (60-min TTL)
    // so estimates edited in ClickUp itself show up now.
    await send({ type: "CLICKUP_REFRESH", forceWeekly: true, forceWeeks: true });
    await load();
  } catch (e) {}
  btn.classList.remove("spin");
};
$("cuSetupBtn").onclick = () => chrome.runtime.openOptionsPage();

initFilterControls();

initCollapseToggles();

// Filter dropdown on the Today card (replaces the old "Due today only" checkbox).
// State lives in the shared `cuFilter` storage key so popup + options stay in
// sync. Toggling repaints from the already-cached clickupState (every scope is
// precomputed there) - no refetch. See resolveCuFilterView above for semantics.
function cuFilterBtnLabel() {
  const btn = $("cuFilterBtn");
  if (!btn) return;
  const n = cuActiveFilterCount(cuFilter);
  btn.textContent = "▾ Filter" + (n ? " · " + n : "");
  btn.classList.toggle("active", n > 0);
}
function cuPrettyName(s) { s = String(s || ""); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function cuArrEq(a, b) { a = Array.isArray(a) ? a : []; b = Array.isArray(b) ? b : []; if (a.length !== b.length) return false; const s = new Set(a); return b.every((x) => s.has(x)); }

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
  renderCuFilterMenu();
  cuFilterBtnLabel();
  renderClickup();
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
function cuApplyFilterSnapshot(snap) {
  if (!snap || typeof snap !== "object") return false;
  for (const k of CU_FILTER_KEYS) cuFilter[k] = !!snap[k];
  for (const k of CU_FILTER_EXTRAS) cuFilter[k] = Array.isArray(snap[k]) ? snap[k].slice() : (snap[k] || "");
  cuFilterSingle = snap.mode === "single";
  chrome.storage.local.set({ cuFilter, cuFilterMode: snap.mode === "single" ? "single" : "multi" }).catch(() => {});
  renderCuFilterMenu();
  cuFilterBtnLabel();
  renderClickup();
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
function cuToggleArrayVal(f, key, val, on) {
  const arr = Array.isArray(f[key]) ? f[key] : (f[key] = []);
  const i = arr.indexOf(val);
  if (on && i < 0) arr.push(val);
  else if (!on && i >= 0) arr.splice(i, 1);
}
// Build one dynamic facet section (Status / Priority / Client) into `box`.
// labelFn maps a raw value to its display text (Status/Priority get title-case
// via cuPrettyName; Client names keep their own casing, e.g. "AWAX").
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
function renderCuFilterMenu() {
  const menu = $("cuFilterMenu");
  if (!menu) return;
  cuPaintClearBtn(menu);
  menu.querySelectorAll("input[data-cf]").forEach((el) => { el.checked = !!cuFilter[el.getAttribute("data-cf")]; });
  const st = (state.clickup && state.clickup.state) || {};
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
  const statusVals = Array.from(new Set(facets.statuses.concat(statuses))).sort();
  const priorityVals = CU_PRIORITY_ORDER.filter((p) => facets.priorities.includes(p) || priorities.includes(p));
  const clients = Array.isArray(cuFilter.clients) ? cuFilter.clients : [];
  const clientVals = Array.from(new Set(facets.clients.concat(clients))).sort((a, b) => a.localeCompare(b));
  cuBuildFacetList($("cuFilterStatusList"), "data-cf-status", statusVals, statuses);
  cuBuildFacetList($("cuFilterPriorityList"), "data-cf-priority", priorityVals, priorities);
  cuBuildFacetList($("cuFilterClientList"), "data-cf-client", clientVals, clients, (v) => v);
  const sg = $("cuFilterStatusGroup"); if (sg) sg.hidden = !statusVals.length;
  const pg = $("cuFilterPriorityGroup"); if (pg) pg.hidden = !priorityVals.length;
  const cg = $("cuFilterClientGroup"); if (cg) cg.hidden = !clientVals.length;
}
function openCuFilterMenu(open) {
  const menu = $("cuFilterMenu");
  const btn = $("cuFilterBtn");
  if (!menu || !btn) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
}
(async function initCuFilter() {
  const btn = $("cuFilterBtn");
  const menu = $("cuFilterMenu");
  if (!btn || !menu) return;
  try {
    const got = await chrome.storage.local.get(["cuFilter", "cuDueTodayOnly", "cuFilterDefault"]);
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
  renderCuFilterMenu();
  cuFilterBtnLabel();
  renderClickup();

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
    saveDefBtn.textContent = "Saved as default \u2713";
    setTimeout(() => { saveDefBtn.textContent = "Save as my default"; }, 1600);
  };
  const useDefBtn = menu.querySelector("[data-fusedef]");
  if (useDefBtn) useDefBtn.onclick = async (e) => {
    e.stopPropagation();
    const ok = await cuUseDefaultFilter();
    useDefBtn.textContent = ok ? "Default applied \u2713" : "No default saved yet";
    setTimeout(() => { useDefBtn.textContent = "Use my default"; }, 1600);
    cuPaintClearBtn(menu);
  };
  menu.querySelectorAll("[data-fmode]").forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      cuFilterSingle = b.dataset.fmode === "single";
      if (cuFilterSingle) {
        cuTrimToSingle();
        chrome.storage.local.set({ cuFilter }).catch(() => {});
        renderCuFilterMenu();
        cuFilterBtnLabel();
        renderClickup();
      }
      cuPaintModeToggle(menu);
      chrome.storage.local.set({ cuFilterMode: cuFilterSingle ? "single" : "multi" }).catch(() => {});
    };
  });

  btn.onclick = (e) => { e.stopPropagation(); openCuFilterMenu(menu.hidden); };
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
      renderCuFilterMenu();
      cuFilterBtnLabel();
      renderClickup();
      return;
    }
    cuSingleClearGroup(el); // single mode: untick the rest of this group first
    if (el.hasAttribute("data-cf")) cuFilter[el.getAttribute("data-cf")] = el.checked;
    else if (el.hasAttribute("data-cf-status")) cuToggleArrayVal(cuFilter, "statuses", el.getAttribute("data-cf-status"), el.checked);
    else if (el.hasAttribute("data-cf-priority")) cuToggleArrayVal(cuFilter, "priorities", el.getAttribute("data-cf-priority"), el.checked);
    else if (el.hasAttribute("data-cf-client")) cuToggleArrayVal(cuFilter, "clients", el.getAttribute("data-cf-client"), el.checked);
    else return;
    chrome.storage.local.set({ cuFilter }).catch(() => {});
    renderCuFilterMenu(); // repaint unticked boxes + show/hide the custom date pickers
    cuFilterBtnLabel();
    renderClickup();
  });
  document.addEventListener("click", (e) => {
    if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) openCuFilterMenu(false);
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) openCuFilterMenu(false); });
})();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "RUN_PROGRESS") load();
  // Drive sign-in/sync phase changed in the background - repaint the sync line.
  if (msg && msg.type === "DRIVE_BUSY") load();
  // Background balance poll landed fresh credit - repaint the balance lines.
  if (msg && msg.type === "BALANCES_UPDATED") load();
  // An availability probe finished in the background - repaint the chips.
  if (msg && msg.type === "AVAILABILITY_UPDATED") load();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.status) load();
  if (changes.balances) load();
  if (changes.availability) load();
  // A settings change can alter how totals are counted (see the parent/subtask
  // estimate rule), so drop the views this page caches itself and refetch.
  if (changes.settings) {
    cuCustomCache = { key: "", status: "", data: null, at: 0 };
    cuOverdueCache = { status: "", data: null, at: 0 };
    load();
  }
  if (changes.clickupState) { cuOverdueInvalidate(); cuTomorrowInvalidate(); load(); }
  // Filter changed on the options page -> mirror it here and repaint. Guarded so
  // a change this popup itself made (identical values) doesn't double-render.
  if (changes.cuFilterMode) {
    cuFilterSingle = changes.cuFilterMode.newValue === "single";
    cuPaintModeToggle($("cuFilterMenu"));
  }
  if (changes.cuFilter && changes.cuFilter.newValue && typeof changes.cuFilter.newValue === "object") {
    const nv = changes.cuFilter.newValue;
    let diff = false;
    for (const k of CU_FILTER_KEYS) { const b = !!nv[k]; if (cuFilter[k] !== b) { cuFilter[k] = b; diff = true; } }
    const nvS = Array.isArray(nv.statuses) ? nv.statuses : [];
    const nvP = Array.isArray(nv.priorities) ? nv.priorities : [];
    if (!cuArrEq(cuFilter.statuses, nvS)) { cuFilter.statuses = nvS.slice(); diff = true; }
    if (!cuArrEq(cuFilter.priorities, nvP)) { cuFilter.priorities = nvP.slice(); diff = true; }
    const nvC = Array.isArray(nv.clients) ? nv.clients : [];
    if (!cuArrEq(cuFilter.clients, nvC)) { cuFilter.clients = nvC.slice(); diff = true; }
    for (const k of ["customFrom", "customTo"]) { const v = typeof nv[k] === "string" ? nv[k] : ""; if ((cuFilter[k] || "") !== v) { cuFilter[k] = v; diff = true; } }
    if (diff) { renderCuFilterMenu(); cuFilterBtnLabel(); renderClickup(); }
  }
  if (changes.theme) applyTheme(changes.theme.newValue === "dark" ? "dark" : "light");
});

setInterval(render, 30000);

// Two-way timer sync: while the popup is open, periodically pull ClickUp's live
// running-timer state so a Start/Stop done directly in ClickUp flips our button.
// CLICKUP_SYNC_RUNNING is a single lightweight GET and only rewrites clickupState
// (-> the storage listener above repaints) when the running state changed.
setInterval(() => {
  if (!document.hidden && state && state.clickup && state.clickup.configured) {
    send({ type: "CLICKUP_SYNC_RUNNING" }).catch(() => {});
  }
}, 30000);

initTheme();
initHeaderExtras();
if (window.pcmExport) window.pcmExport.attach($("cuExportBtn"), () => cuExportData);
load();
// Kick one throttled, reuse-only availability sweep per popup open. The chips
// paint instantly from cache; fresh verdicts arrive via AVAILABILITY_UPDATED.
// The background guards per-account frequency and never mints a token from here.
send({ type: "PROBE_AVAILABILITY" }).catch(() => {});
// The weekly card reads persisted state (30-min TTL), so freshly-added manual
// tracked time on date-less tasks won't show in the per-day "Tracked · no dates"
// lists until it recomputes. Nudge a background recompute on open - the storage
// listener above repaints when it lands, so this never blocks first render.
send({ type: "CLICKUP_REFRESH", forceWeekly: true, forceWeeks: true }).catch(() => {});

// ---------- "Update available" banner ----------
(async function showUpdateBanner() {
  try {
    const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
    if (!ui || !ui.newer || document.getElementById("updateBanner")) return;
    const bar = document.createElement("a");
    bar.id = "updateBanner";
    bar.className = "update-banner";
    bar.href = ui.url; bar.target = "_blank"; bar.rel = "noopener";
    bar.textContent = "Update available: v" + ui.latest + " (you have v" + ui.current + ") - click to update";
    // One click downloads the zip; Ctrl/middle-click still opens the release page.
    bar.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey || e.button === 1) return;
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL("update.html") });
    });
    document.body.insertBefore(bar, document.body.firstChild);
  } catch (e) {}
})();

// ---------- Agent Router visibility ----------
// settings.showAgentRouter: true / false; unset = show only if accounts exist
// (new users don't see it; existing Agent Router users keep it).
function arVisible(st) {
  const v = st && st.settings ? st.settings.showAgentRouter : undefined;
  if (v === true || v === false) return v;
  return !!(st && Array.isArray(st.accounts) && st.accounts.length);
}
function applyArVisibility(st) {
  document.body.classList.toggle("no-ar", !arVisible(st));
}
