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
function doneToday() {
  const b = todayBundle();
  return uniq([...(b.tasks || []), ...(b.deadlineTasks || []), ...(b.trackedTasks || [])])
    .filter((t) => (Number(t.spentMs) || 0) > 0 || t.done)
    .sort((a, b) => (Number(b.spentMs) || 0) - (Number(a.spentMs) || 0));
}
function nextUp() {
  const nd = nextWorkday();
  const pool = [];
  for (const b of [st && st.thisWeek, st && st.nextWeek]) if (b) pool.push(...(b.tasks || []), ...(b.deadlineTasks || []));
  const out = uniq(pool).filter((t) => !t.done && !isExtra(t) && t.dueDateMs && dayFloor(t.dueDateMs) === nd);
  // Today's leftovers carry over too (moved or not).
  return uniq([...out, ...openToday(), ...moved.values()]).sort((a, b) => rank(a) - rank(b));
}
function blocked() {
  const names = new Map();
  for (const b of [st, st && st.todayFilter, st && st.thisWeek, st && st.nextWeek]) {
    if (b) for (const t of [...(b.tasks || []), ...(b.deadlineTasks || [])]) if (t && t.id != null) names.set(String(t.id), t.name);
  }
  const out = [];
  for (const [id, w] of Object.entries((st && st.waiting) || {})) {
    const nm = names.get(String(id));
    if (!nm) continue;
    const bl = (w && w.blockers) || [];
    const who = [...new Set(bl.map((x) => x.who).filter(Boolean))].join(", ");
    out.push(nm + ": waiting on " + (who || "a teammate") + (bl.some((x) => x.overdue) ? " (overdue)" : ""));
  }
  return out;
}
function buildStandup() {
  const L = ["*Standup · " + new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + "*", "", "*Done today*"];
  const done = doneToday();
  if (done.length) for (const t of done) L.push("• " + t.name + ((Number(t.spentMs) || 0) > 0 ? " (" + fmt(t.spentMs) + ")" : "") + (t.done ? " ✅" : ""));
  else L.push("• Nothing tracked yet");
  L.push("", "*Next*");
  const next = nextUp();
  if (next.length) for (const t of next) L.push("• " + t.name);
  else L.push("• Nothing due " + dayWord(nextWorkday()));
  const bl = blocked();
  if (bl.length) { L.push("", "*Blocked*"); for (const x of bl) L.push("• " + x); }
  return L.join("\n");
}

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
  try {
    await navigator.clipboard.writeText($("standup").value);
    b.textContent = "Copied ✓";
  } catch (e) {
    $("standup").select();
    document.execCommand("copy");
    b.textContent = "Copied ✓";
  }
  setTimeout(() => { b.textContent = "Copy"; }, 1600);
};

(async () => {
  try {
    const { theme } = await chrome.storage.local.get("theme");
    if (theme === "dark") document.documentElement.dataset.theme = "dark";
    const { clickupState } = await chrome.storage.local.get("clickupState");
    st = clickupState && typeof clickupState === "object" && !clickupState.error ? clickupState : null;
  } catch (e) {}
  render();
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.clickupState && ch.clickupState.newValue) { st = ch.clickupState.newValue; render(); }
    if (ch.theme) document.documentElement.dataset.theme = ch.theme.newValue === "dark" ? "dark" : "light";
  });
})();
