// lib-tidy.js
// -----------------------------------------------------------------------------
// The "Needs tidying" list behind the daily reminder notification, as pure
// functions so the background service worker and the test runner agree.
//
// The buckets are deliberately the SAME four the Insights tab paints
// (options.js `insBuildModel`): overdue, no estimate, no due date, blocked.
// dev-tools/t_lib_tidy.js runs both over one fixture and fails if a bucket
// ever drifts, so the notification can never contradict the tab.
//
// Everything here is pure: no chrome.* , no fetch, no Date.now() unless passed
// in. Rows are the open-task rows from the ClickUp "Any date" fetch
// (id, name, url, estimateMs, dueDateMs, done, parentId, isSubtask, client)
// and `waiting` is clickupState.waiting (the same state the task rows' "waiting"
// chip reads - no extra API call).
// -----------------------------------------------------------------------------

// "12 Sep" - short, locale-independent, sorts fine inside a sentence.
export function tidyDateShort(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  if (isNaN(d.getTime())) return "";
  const M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return d.getDate() + " " + M[d.getMonth()];
}

// "2 days late" / "today" - how overdue a task is, in whole days.
export function tidyOverdueBy(dueMs, todayStart) {
  const days = Math.floor((todayStart - Number(dueMs) || 0) / 86400000);
  if (days <= 0) return "today";
  return days === 1 ? "1 day late" : days + " days late";
}

export function tidyClip(name, max = 38) {
  const s = String(name || "").replace(/\s+/g, " ").trim() || "(untitled task)";
  return s.length > max ? s.slice(0, max - 1).trim() + "…" : s;
}

// The four Insights buckets, from the open-task rows + clickupState.waiting.
// Mirrors options.js insBuildModel() on purpose - see the drift test.
export function tidyCollect(rows, waiting, todayStart) {
  const list = [], hasKids = Object.create(null);
  for (const r of rows || []) {
    if (!r || r.done) continue;
    if (r.parentId) hasKids[r.parentId] = true;
    list.push({
      id: String(r.id),
      name: tidyClip(r.name),
      url: r.url || "",
      due: Number(r.dueDateMs) || 0,
      est: Number(r.estimateMs) || 0,
    });
  }
  const byId = Object.create(null);
  for (const r of list) byId[r.id] = r;

  const overdueList = [], noEstList = [], noDueList = [], blockedList = [];
  for (const r of list) {
    const umbrella = !!hasKids[r.id]; // a parent whose subtasks are in this list
    if (r.due && r.due < todayStart) {
      r.reason = tidyOverdueBy(r.due, todayStart); // "3 days late" for the line
      overdueList.push(r);
    }
    if (!umbrella && r.est <= 0) noEstList.push(r);
    if (!umbrella && !r.due) noDueList.push(r);
  }
  for (const key in waiting || {}) {
    if (!Object.prototype.hasOwnProperty.call(waiting, key)) continue;
    const e = waiting[key];
    if (!e) continue;
    const personBlock = e.blockers && e.blockers.length, sb = e.selfBlock;
    const subBlock = sb && (sb.later || sb.parentOverdue);
    if (!personBlock && !subBlock) continue;
    const row = byId[String(key)];
    let reason;
    if (personBlock) {
      const uniq = [];
      for (const x of e.blockers) {
        const nm = (x && (x.who || x.name)) || "";
        if (nm && uniq.indexOf(nm) < 0) uniq.push(nm);
      }
      reason = "waiting on " + (uniq.slice(0, 2).join(", ") || "someone") +
        (uniq.length > 2 ? " +" + (uniq.length - 2) : "");
    } else if (sb.parentOverdue) {
      reason = sb.open + " open subtask" + (sb.open === 1 ? "" : "s") + " · task is overdue";
    } else {
      reason = sb.later + " subtask" + (sb.later === 1 ? "" : "s") + " due after it" +
        (sb.latestDueMs ? " (to " + tidyDateShort(sb.latestDueMs) + ")" : "");
    }
    blockedList.push({
      id: String(key),
      name: row ? row.name : tidyClip("task " + key),
      url: row ? row.url : "",
      due: row ? row.due : 0,
      reason,
    });
  }
  // Oldest first for overdue, biggest-looking first elsewhere: the top of the
  // list is what the notification gets to name.
  overdueList.sort((a, b) => a.due - b.due);
  noEstList.sort((a, b) => (b.est - a.est) || a.name.localeCompare(b.name));
  noDueList.sort((a, b) => a.name.localeCompare(b.name));
  blockedList.sort((a, b) => a.name.localeCompare(b.name));

  return {
    todayStart,
    overdue: overdueList,
    noEst: noEstList,
    noDue: noDueList,
    blocked: blockedList,
    blockedIds: blockedList.map((b) => b.id),
    openList: list, // every open task, for the "was blocked, isn't now" check
    k: {
      overdue: overdueList.length,
      noEst: noEstList.length,
      noDue: noDueList.length,
      blocked: blockedList.length,
      open: list.length,
    },
  };
}

// Which days a reminder may fire on: "every" | "weekdays" | "1,3,5" (0=Sun).
export function tidyDayOk(daysSpec, date) {
  const spec = String(daysSpec || "weekdays").toLowerCase();
  if (spec === "every" || spec === "all") return true;
  const day = date.getDay();
  if (spec === "weekdays") return day !== 0 && day !== 6;
  const list = spec.split(",").map((x) => parseInt(x, 10)).filter((n) => n >= 0 && n <= 6);
  if (!list.length) return day !== 0 && day !== 6;
  return list.indexOf(day) >= 0;
}

// Tasks that were blocked on an earlier day and are free now: the "dependency
// resolved, carry on" nudge. Needs yesterday's ids, so the background keeps a
// snapshot. A task that isn't an open task of yours right now (never heard of
// it, or already finished) is not a match - we only announce what we can see.
export function tidyResolved(prevIds, model, rows) {
  const was = new Set((prevIds || []).map(String));
  if (!was.size) return [];
  const stillBlocked = new Set(model.blockedIds);
  const done = new Set((rows || []).filter((r) => r && r.done).map((r) => String(r.id)));
  const openById = Object.create(null);
  for (const r of model.openList || []) openById[r.id] = r;
  const seen = new Set();
  const out = [];
  for (const id of was) {
    if (seen.has(id) || stillBlocked.has(id) || done.has(id)) continue;
    const row = openById[id];
    if (!row) continue;
    seen.add(id);
    out.push({ id, name: row.name, url: row.url || "" });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const CATS = [
  ["overdue", "Overdue"],
  ["noEst", "No estimate"],
  ["noDue", "No due date"],
  ["blocked", "Blocked"],
];

// "A, B and 3 more" - the compact way to name a bucket in one line.
function nameList(items, max, withReason) {
  const shown = items.slice(0, max).map((it) =>
    tidyClip(withReason ? it.name + " (" + it.reason + ")" : it.name, 60));
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? " and " + rest + " more" : "");
}

// The notification's title + message. Returns empty:true when there is nothing
// worth saying, so a clean board stays silent. Only the categories that are
// switched on count towards the title, and a task with two problems (no
// estimate AND no due date) is still one task.
export function tidyLines(model, opts = {}) {
  const cats = opts.cats || {};
  const on = (k) => cats[k] !== false; // every category is on unless switched off
  const max = Math.max(1, Math.min(6, Number(opts.max) || 3));
  const resolved = Array.isArray(opts.resolved) ? opts.resolved : [];
  const lines = [], counts = Object.create(null), said = new Set();

  const add = (key, label, items, withReason) => {
    if (!on(key) || !items.length) return;
    lines.push(label + ": " + nameList(items, max, withReason));
    counts[key] = items.length;
    for (const it of items) said.add(it.id);
  };
  add("overdue", "Overdue", model.overdue, true);
  add("noEst", "No estimate", model.noEst, false);
  add("noDue", "No due date", model.noDue, false);
  add("blocked", "Blocked", model.blocked, true);
  if (resolved.length) {
    // The one the user asked for by name: a dependency cleared, so the task can
    // be finished and closed.
    lines.push("Dependencies resolved - you can continue " + nameList(resolved, max, false) +
      " and close " + (resolved.length === 1 ? "it" : "them") + ".");
    counts.resolved = resolved.length;
    for (const it of resolved) said.add(it.id);
  }
  if (!lines.length) return { empty: true, title: "", message: "", lines: [] };

  const nOverdue = counts.overdue || 0;
  const onlyGoodNews = !nOverdue && Object.keys(counts).every((k) => k === "resolved");
  const nTasks = said.size;
  const title = nOverdue
    ? "Needs tidying: " + nOverdue + (nOverdue === 1 ? " overdue task" : " overdue tasks")
    : onlyGoodNews
      ? (resolved.length === 1 ? "A task is ready to continue ✅" : resolved.length + " tasks are ready to continue ✅")
      : "Needs tidying: " + nTasks + (nTasks === 1 ? " task" : " tasks");
  return {
    empty: false,
    title,
    message: lines.join("\n"),
    lines,
    counts,
    context: "Insights › Needs tidying",
  };
}

// Anything urgent enough to be worth a louder chime? (overdue or unblocked work)
export function tidyUrgent(model, resolved) {
  return model.k.overdue > 0 || (Array.isArray(resolved) && resolved.length > 0);
}
