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
// "🔥 Acme Plumbing SEO" -> "Acme Plumbing", "NORTH STAR ROOFING SEO" -> "North Star Roofing".
function projectName(client) {
  let n = String(client || "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+seo\s*$/i, "").trim();
  if (n && n === n.toUpperCase() && /[A-Z]{2}/.test(n)) n = n.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  return n || "Other";
}
const byName = (a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { numeric: true, sensitivity: "base" });
function linkPart(links) {
  const l = Array.isArray(links) ? links : [];
  if (!l.length) return "";
  return " : " + (l.length === 1 ? "<" + l[0] + "|Click Here>" : l.map((u, i) => "<" + u + "|Click Here " + (i + 1) + ">").join("  "));
}
function buildStandup() {
  const L = ["Daily Tasks Update", "Date: " + new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), ""];
  if (doneRows === null) { L.push("Loading the tasks you completed today…"); return L.join("\n"); }
  const rows = doneRows.filter((t) => !isExtra(t));
  if (!rows.length) {
    L.push(doneErr ? "Couldn't load today's completed tasks: " + doneErr : "No tasks completed today yet.");
    return L.join("\n");
  }
  const groups = new Map();
  for (const t of rows) {
    const p = projectName(t.client);
    if (!groups.has(p)) groups.set(p, []);
    groups.get(p).push(t);
  }
  const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  order.forEach(([p, list], i) => {
    if (i) L.push("");
    L.push("Project Name: " + p, "  Complete (" + list.length + ")");
    for (const t of list.slice().sort(byName)) L.push("    · " + t.name + linkPart(t.links));
  });
  return L.join("\n");
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

async function move(t, btn) {
  const day = nextWorkday();
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
      ok.textContent = "Moved to " + label + " ✓";
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

  if (!standupEdited) $("standup").value = buildStandup();
  $("rebuild").hidden = !standupEdited;
}

$("standup").addEventListener("input", () => { standupEdited = true; $("rebuild").hidden = false; });
$("rebuild").onclick = () => { standupEdited = false; render(); };
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
  await loadDone(true);
  b.disabled = false;
};

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
  render();
  loadDone(false);
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.clickupState && ch.clickupState.newValue) { st = ch.clickupState.newValue; render(); }
    if (ch.theme) document.documentElement.dataset.theme = ch.theme.newValue === "dark" ? "dark" : "light";
  });
})();
