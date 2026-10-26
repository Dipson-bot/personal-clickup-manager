// End-of-day wrap-up page: tracked vs target, today's leftovers (move to the
// next workday in one click) and a Slack-ready standup. Reads clickupState;
// the only write is CLICKUP_MOVE_DUE (background changes the due date).
const $ = (id) => document.getElementById(id);
const PRIO = { urgent: 0, high: 1, normal: 2, low: 3 };
const EXTRA_RE = /^extras?\s+tasks?\b/i;

let st = null;
const moved = new Map(); // taskId -> task row moved on this page
let standupEdited = false;

function fmt(ms) {
  const m = Math.round(Math.max(0, Number(ms) || 0) / 60000);
  const h = Math.floor(m / 60);
  return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m";
}
const dayFloor = (ts) => new Date(ts).setHours(0, 0, 0, 0);
function nextWorkday(from = Date.now()) {
  const d = new Date(dayFloor(from));
  do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
  return d.getTime();
}
function dayWord(ts) {
  return dayFloor(ts) - dayFloor(Date.now()) === 86400000 ? "tomorrow" : new Date(ts).toLocaleDateString([], { weekday: "long" });
}
const isExtra = (t) => t.type === "extra" || EXTRA_RE.test(t.name || "");
const rank = (t) => { const r = PRIO[String(t.priority || "").toLowerCase()]; return r == null ? 4 : r; };
function uniq(list) {
  const seen = new Set();
  return list.filter((t) => t && t.id != null && !seen.has(String(t.id)) && seen.add(String(t.id)));
}
const todayBundle = () => (st && st.todayFilter && Array.isArray(st.todayFilter.tasks) ? st.todayFilter : st) || {};

function openToday() {
  const today = dayFloor(Date.now());
  return uniq(todayBundle().tasks || [])
    .filter((t) => !t.done && !isExtra(t) && t.dueDateMs && dayFloor(t.dueDateMs) === today)
    .sort((a, b) => rank(a) - rank(b));
}
// ---- Daily Tasks Update (replaces the old Done / Next / Blocked standup) ----
// Every task closed today (ClickUp's own done date, any project, subtasks too),
// grouped by project, each with the links from its description as Click Here 1,
// Click Here 2 ... The box holds Slack-style <url|Click Here 1> links so it stays
// editable; Copy turns them into real links (rich text) so Slack shows the words.
let doneRows = null; // null = still loading
let doneErr = "";
async function loadDone(force) {
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: "CLICKUP_DONE_TODAY", force: !!force }); } catch (e) { r = null; }
  if (r && r.ok) { doneRows = r.tasks || []; doneErr = ""; }
  else { doneErr = (r && (r.error || r.reason)) || "couldn't reach the extension"; if (!doneRows) doneRows = []; }
  render();
}
function buildStandup() {
  return window.PcmDailyUpdate.build(doneRows, { error: doneErr });
}
// Rich-text copy: <url|label> becomes a real link, leading spaces survive.
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LINK_RE = /<(https?:\/\/[^|>\s]+)\|([^>]+)>/g;
function toRich(text) {
  return text.split("\n").map((line) => {
    let html = "", last = 0;
    for (const m of line.matchAll(LINK_RE)) {
      html += escHtml(line.slice(last, m.index)) + '<a href="' + escHtml(m[1]) + '">' + escHtml(m[2]) + "</a>";
      last = m.index + m[0].length;
    }
    html += escHtml(line.slice(last));
    return html.replace(/^ +/, (sp) => "&nbsp;".repeat(sp.length));
  }).join("<br>");
}
const toPlain = (text) => text.replace(LINK_RE, "$2 ($1)");

async function move(t, btn, dayMs, dayLabel) {
  const day = dayMs || nextWorkday();
  t._movedTo = dayLabel || "";
  btn.disabled = true;
  btn.textContent = "Moving…";
  let r;
  try { r = await chrome.runtime.sendMessage({ type: "CLICKUP_MOVE_DUE", taskId: String(t.id), dayMs: day }); }
  catch (e) { r = { ok: false, error: String(e && e.message ? e.message : e) }; }
  if (r && r.ok) {
    moved.set(String(t.id), t);
    render();
  } else {
    btn.disabled = false;
    btn.textContent = "Retry";
    btn.title = (r && (r.error || r.reason)) || "Couldn't move it";
  }
}

function render() {
  $("today").textContent = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  if (!st) {
    $("progCard").hidden = true;
    $("openList").innerHTML = '<div class="empty">Connect ClickUp in Options first.</div>';
    return;
  }
  const spent = Number(st.spentMs) || 0;
  const target = Number(st.targetMs) || 0;
  $("tracked").textContent = fmt(spent) + " tracked";
  $("target").textContent = target ? "of " + fmt(target) + " target" : "";
  $("bar").classList.toggle("met", target > 0 && spent >= target);
  $("bar").firstElementChild.style.width = (target ? Math.min(100, (spent / target) * 100) : 0) + "%";

  const nextDay = dayWord(nextWorkday());
  const label = nextDay === "tomorrow" ? "Tomorrow" : nextDay.slice(0, 3);
  const rows = uniq([...openToday(), ...moved.values()]);
  const list = $("openList");
  list.innerHTML = "";
  if (!rows.length) list.innerHTML = '<div class="empty">Nothing left open for today. Nice work ✓</div>';
  const pending = [];
  for (const t of rows) {
    const row = document.createElement("div");
    row.className = "row";
    const a = document.createElement("a");
    a.className = "nm";
    a.textContent = t.name || "(task)";
    a.title = t.name || "";
    a.href = t.url || "https://app.clickup.com/t/" + encodeURIComponent(t.id);
    a.target = "_blank";
    a.rel = "noopener";
    row.append(a);
    if (t.client) {
      const c = document.createElement("span");
      c.className = "cl";
      c.textContent = t.client;
      row.append(c);
    }
    if (moved.has(String(t.id))) {
      const ok = document.createElement("span");
      ok.className = "ok";
      ok.textContent = "Moved to " + (moved.get(String(t.id))._movedTo || label) + " ✓";
      row.append(ok);
    } else {
      const b = document.createElement("button");
      b.textContent = "→ " + label;
      b.title = "Move the due date to " + nextDay + " (same time of day)";
      b.onclick = () => move(t, b);
      pending.push([t, b]);
      row.append(b);
    }
    list.append(row);
  }
  const all = $("moveAll");
  all.hidden = pending.length < 2;
  all.textContent = "Move all to " + label;
  all.onclick = async () => {
    all.disabled = true;
    for (const [t, b] of pending) await move(t, b);
    all.disabled = false;
  };
  // Same, to any day the user picks (keeps each task's time of day).
  const pick = $("moveAllDate"), dateIn = $("moveDate");
  pick.hidden = pending.length < 1;
  const tmr = new Date(nextWorkday());
  dateIn.min = new Date(dayFloor(Date.now()) + 86400000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  dateIn.value = new Date(tmr.getTime() - tmr.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  pick.onclick = () => { try { dateIn.showPicker(); } catch (e) { dateIn.style.pointerEvents = "auto"; dateIn.focus(); dateIn.click(); } };
  dateIn.onchange = async () => {
    if (!dateIn.value) return;
    const [y, m, d] = dateIn.value.split("-").map(Number);
    const dayMs = new Date(y, m - 1, d).getTime();
    const lbl = new Date(dayMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    pick.disabled = all.disabled = true;
    pick.textContent = "Moving…";
    for (const [t, b] of pending) await move(t, b, dayMs, lbl);
    pick.disabled = all.disabled = false;
    pick.textContent = "Move all to date…";
  };

  if (!standupEdited) $("standup").value = buildStandup();
  $("rebuild").hidden = !standupEdited;
}

// The edited text is kept for today, so the scheduled send posts what you wrote.
const todayKey = () => { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
let draftT = 0;
$("standup").addEventListener("input", () => {
  standupEdited = true; $("rebuild").hidden = false;
  clearTimeout(draftT);
  draftT = setTimeout(() => { chrome.storage.local.set({ dailyUpdateDraft: { day: todayKey(), text: $("standup").value } }).catch(() => {}); }, 500);
});
const dropDraft = () => { clearTimeout(draftT); chrome.storage.local.remove("dailyUpdateDraft").catch(() => {}); };
$("rebuild").onclick = () => { standupEdited = false; dropDraft(); render(); };
$("copy").onclick = async () => {
  const b = $("copy");
  const text = $("standup").value;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      "text/html": new Blob([toRich(text)], { type: "text/html" }),
      "text/plain": new Blob([toPlain(text)], { type: "text/plain" }),
    })]);
    b.textContent = "Copied ✓";
  } catch (e) {
    try { await navigator.clipboard.writeText(toPlain(text)); b.textContent = "Copied ✓"; }
    catch (e2) { $("standup").select(); document.execCommand("copy"); b.textContent = "Copied ✓"; }
  }
  setTimeout(() => { b.textContent = "Copy"; }, 1600);
};
$("refreshDone").onclick = async () => {
  const b = $("refreshDone");
  b.disabled = true;
  standupEdited = false;
  dropDraft();
  await loadDone(true);
  b.disabled = false;
};

// ---- Send to #daily-task-update (posted as you through the extension's Slack sign-in) ----
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function sentLine(sent) {
  const m = $("sendMsg");
  m.className = "hint" + (sent && sent.link ? " ok" : "");
  m.textContent = "";
  if (!sent || sent.day !== todayKey()) return;
  if (sent.skipped) { m.textContent = "Not sent today: " + sent.skipped + "."; return; }
  m.append("\u2713 Sent to #" + (sent.channel || "daily-task-update") + " at " + fmtTime(sent.at) + (sent.how === "auto" ? " (by itself)" : "") + " \u00b7 ");
  const a = document.createElement("a");
  a.href = sent.link; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open in Slack";
  m.appendChild(a);
}
async function initSend() {
  const b = $("sendSlack");
  const g = await chrome.storage.local.get(["slackSession", "dailyUpdateSent"]).catch(() => ({}));
  if (!g.slackSession) { b.disabled = true; b.title = "Connect Slack first: Options \u203A Clients \u203A Slack channels \u203A Connect"; $("sendMsg").textContent = "Connect Slack (Options \u203A Clients) to send it from here."; }
  else sentLine(g.dailyUpdateSent);
  b.onclick = async () => {
    const text = $("standup").value.trim();
    if (!text || /^Loading the tasks/m.test(text)) return;
    const prev = (await chrome.storage.local.get("dailyUpdateSent").catch(() => ({}))).dailyUpdateSent;
    if (prev && prev.day === todayKey() && prev.link && !confirm("Today's update was already sent at " + fmtTime(prev.at) + ". Send it again?")) return;
    b.disabled = true; b.textContent = "Sending\u2026";
    const m = $("sendMsg"); m.className = "hint"; m.textContent = "Posting in #daily-task-update\u2026";
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: "DAILY_UPDATE_SEND", text }); } catch (e) { r = null; }
    b.disabled = false; b.textContent = "Send to #daily-task-update";
    if (r && r.ok) sentLine(r);
    else { m.className = "hint err"; m.textContent = "Not sent: " + ((r && r.error) || "no answer from the extension - reload it and try again."); }
  };
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.dailyUpdateSent) sentLine(ch.dailyUpdateSent.newValue); });
  // Send it by itself (weekdays, not on company holidays, once a day).
  const on = $("autoSend"), at = $("autoAt"), msg = $("autoMsg");
  // On this computer only (not synced): two computers would post it twice.
  let s = {};
  try { s = (await chrome.storage.local.get("dailyUpdateAuto")).dailyUpdateAuto || {}; } catch (e) {}
  on.checked = !!s.on;
  at.value = s.time || "17:30";
  at.disabled = !on.checked;
  const save = async () => {
    at.disabled = !on.checked;
    try {
      await chrome.storage.local.set({ dailyUpdateAuto: { on: on.checked, time: at.value || "17:30" } });
      msg.textContent = on.checked ? "On \u2713 (this computer) - sent once a day after " + (at.value || "17:30") + (g.slackSession ? "" : " (connect Slack first)") + ". If you edit the text here today, your edited text is sent." : "Off";
    } catch (e) { msg.textContent = "Couldn't save"; }
  };
  on.onchange = save;
  at.onchange = save;
}
initSend();

// Reminder controls (same settings as Options > ClickUp setup > Tracking settings).
async function initReminder() {
  const on = $("remOn"), at = $("remAt"), msg = $("remMsg");
  let s = {};
  try { s = (await chrome.storage.local.get("settings")).settings || {}; } catch (e) {}
  on.checked = s.clickupWrapUp !== false;
  at.value = s.clickupWrapUpTime || "16:45";
  at.disabled = !on.checked;
  const save = async () => {
    at.disabled = !on.checked;
    try {
      await chrome.runtime.sendMessage({ type: "SET_SETTINGS", patch: { clickupWrapUp: on.checked, clickupWrapUpTime: at.value || "16:45" } });
      msg.textContent = "Saved ✓";
    } catch (e) { msg.textContent = "Couldn't save"; }
    setTimeout(() => { msg.textContent = ""; }, 1500);
  };
  on.onchange = save;
  at.onchange = save;
}
initReminder();

(async () => {
  try {
    const { theme } = await chrome.storage.local.get("theme");
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    const { clickupState } = await chrome.storage.local.get("clickupState");
    st = clickupState && typeof clickupState === "object" && !clickupState.error ? clickupState : null;
  } catch (e) {}
  // Edited earlier today: that text is shown again (it's what the scheduled send
  // would post) - Rebuild brings back today's full list.
  try {
    const { dailyUpdateDraft: dr } = await chrome.storage.local.get("dailyUpdateDraft");
    if (dr && dr.day === todayKey() && String(dr.text || "").trim()) {
      standupEdited = true;
      $("standup").value = String(dr.text);
      $("rebuild").hidden = false;
      $("standupHint").textContent = "Your edited text from earlier today (this is what's sent). Rebuild shows today's full list again.";
    }
  } catch (e) {}
  render();
  loadDone(false);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.clickupState && ch.clickupState.newValue) { st = ch.clickupState.newValue; render(); }
    if (ch.theme) document.documentElement.dataset.theme = ch.theme.newValue === "dark" ? "dark" : "light";
  });
})();
