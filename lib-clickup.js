// lib-clickup.js
// -----------------------------------------------------------------------------
// A tiny read-only client for the ClickUp API (v2). It answers two questions:
//   1. "How much time estimate is on the tasks due today that are assigned to
//       me, and how does that compare to my daily target?"
//   2. "How much of a specific deadline task's estimate should count toward
//       today?" (divided by 5 for Mon-Fri weekly tasks)
//
// Auth is a ClickUp *personal API token* (starts with `pk_`), which ANY member
// can generate (ClickUp → avatar → Settings → Apps → API Token) - no admin /
// team-lead role required. It is passed in the Authorization header and, in this
// extension, stored obfuscated at rest exactly like the other secrets.
//
// Runs from the background service worker, which has `https://api.clickup.com/*`
// in host_permissions, so these cross-origin fetches are not subject to CORS.
// -----------------------------------------------------------------------------

const API = "https://api.clickup.com/api/v2";

// time_estimate / time_spent come back from ClickUp in MILLISECONDS.
const MS_PER_HOUR = 3600000;

// Safety cap so a misconfiguration can never spin the pager forever. 100 tasks
// per page × 20 = 2000 tasks due in a single day would be absurd already.
const MAX_PAGES = 20;

// How many team-task pages the roster harvest scans when building the member
// directory (up to 2000 accessible tasks → every assignee on them).
const ROSTER_SCAN_PAGES = 20;

// Number of weekdays to divide a weekly deadline task's estimate across.
const WEEKDAY_COUNT = 5;

// ---------- low-level fetch ----------
// Build a typed 429 error, reading ClickUp's Retry-After / X-RateLimit-Reset
// headers so callers can back off for exactly the window the API asks for
// (falling back to ~1 min, clamped to a sane range).
function rateLimitError(res) {
  let ms = 0;
  try {
    const ra = res && res.headers && res.headers.get("Retry-After");
    if (ra != null && ra !== "") {
      const secs = Number(ra);
      if (Number.isFinite(secs)) ms = secs * 1000;
    }
    if (!ms) {
      const reset = res && res.headers && res.headers.get("X-RateLimit-Reset");
      if (reset) {
        const deltaMs = Number(reset) * 1000 - Date.now(); // ClickUp: epoch seconds
        if (Number.isFinite(deltaMs) && deltaMs > 0) ms = deltaMs;
      }
    }
  } catch (e) {}
  if (!ms || !Number.isFinite(ms)) ms = 60000;
  ms = Math.max(1000, Math.min(120000, ms));
  const err = new Error("ClickUp rate limit hit - try again in a minute.");
  err.status = 429;
  err.retryAfterMs = ms;
  return err;
}

// Wraps one ClickUp GET. Throws a typed-ish Error with a `.status` so callers
// can tell "bad token" (401) apart from "network died".
async function cuFetch(token, path, params) {
  const url = new URL(API + path);
  if (params) {
    for (const [k, v] of params) url.searchParams.append(k, v);
  }
  let res;
  try {
    res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: token, "Content-Type": "application/json" },
    });
  } catch (e) {
    const err = new Error("Couldn't reach ClickUp (network error).");
    err.status = 0;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error("ClickUp rejected the token - check it's correct and not revoked.");
    err.status = res.status;
    throw err;
  }
  if (res.status === 429) {
    throw rateLimitError(res);
  }
  if (!res.ok) {
    const err = new Error("ClickUp API error (HTTP " + res.status + ").");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Wraps one ClickUp POST (JSON body). Same typed-error mapping as cuFetch so
// callers can tell "bad token" (401/403) from rate-limit (429) from network (0),
// but also surfaces ClickUp's own error text (e.g. "Time entry already running")
// so the UI can show something actionable instead of a bare status code.
async function cuPost(token, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: "POST",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    const err = new Error("Couldn't reach ClickUp (network error).");
    err.status = 0;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error("ClickUp rejected the token - check it's correct and not revoked.");
    err.status = res.status;
    throw err;
  }
  if (res.status === 429) {
    throw rateLimitError(res);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      const m = j && (j.err || j.error || j.ECODE);
      if (m) detail = ": " + m;
    } catch (e2) {}
    const err = new Error("ClickUp API error (HTTP " + res.status + ")" + detail + ".");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// PUT sibling of cuPost - same auth + error mapping, used to mutate a task (e.g.
// change its status). ClickUp surfaces an invalid-status name as a 4xx with a
// message body, which we bubble up verbatim so the UI can show it in the row hint.
async function cuPut(token, path, body) {
  let res;
  try {
    res = await fetch(API + path, {
      method: "PUT",
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    const err = new Error("Couldn't reach ClickUp (network error).");
    err.status = 0;
    throw err;
  }
  if (res.status === 401 || res.status === 403) {
    const err = new Error("ClickUp rejected the token - check it's correct and not revoked.");
    err.status = res.status;
    throw err;
  }
  if (res.status === 429) {
    throw rateLimitError(res);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      const m = j && (j.err || j.error || j.ECODE);
      if (m) detail = ": " + m;
    } catch (e2) {}
    const err = new Error("ClickUp API error (HTTP " + res.status + ")" + detail + ".");
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Fetch team time entries, asking ClickUp server-side for `assigneeIds` when
// given. Without the `assignee` param this endpoint ONLY returns the token
// owner's own entries, so a department/single-user scope (e.g. a teammate's
// tracked time) requires it. That param is Owner/Admin-only; if ClickUp rejects
// it (403), retry without it and let the callers client-side-filter whatever
// the endpoint returns (best effort). 401/429 are rethrown untouched.
async function cuFetchTimeEntries(token, teamId, params, assigneeIds) {
  if (assigneeIds && assigneeIds.length) {
    const scoped = params.concat([["assignee", assigneeIds.map(String).join(",")]]);
    try {
      return await cuFetch(token, "/team/" + teamId + "/time_entries", scoped);
    } catch (e) {
      if (e.status === 401 || e.status === 429) throw e;
    }
  }
  return cuFetch(token, "/team/" + teamId + "/time_entries", params);
}

// ---------- identity + workspaces ----------
// The token's own user. Its `id` is what the task filter's assignees[] wants.
export async function getUser(token) {
  const j = await cuFetch(token, "/user");
  const u = (j && j.user) || {};
  return { id: u.id, username: u.username || "", email: u.email || "" };
}

// Workspaces ("teams") the token can see. Most people have exactly one.
export async function getTeams(token) {
  const j = await cuFetch(token, "/team");
  const teams = Array.isArray(j && j.teams) ? j.teams : [];
  return teams.map((t) => ({ id: String(t.id), name: t.name || ("Workspace " + t.id) }));
}

// All assignable users in a workspace (members + guests). This powers the
// Department Creator's search-as-you-type suggestion box AND the multi-assignee
// task queries in the Filter card.
//
// Importantly: there is NO documented v2 endpoint that reliably lists every,
// named, member for a plain (non-Enterprise) personal token - "Get User" is
// Enterprise-only, and the list/task member endpoints are per-item. POST the
// Authorized Teams response (GET /team) sometimes only carries {id, role} with no
// name. So the dependable, token-agnostic NAME source is the TEAM TASK query we
// already use elsewhere: GET /team/{id}/task returns the `assignees` array on
// every accessible task, carrying id + username + email. We probe the cheap roster
// shapes first, then always enrich with a task-assignee scan.
export async function fetchTeamMembers(token, teamId) {
  const map = new Map();
  await probeDirectRoster(token, teamId, map);
  const anyRealName = [...map.values()].some((m) => !/^User \d+$/.test(m.name));
  if (!anyRealName) {
    // Roster endpoints gave nothing (or ids without names): the task scan is the
    // one source guaranteed to carry usernames - run it fully.
    await harvestAssigneesFromTasks(token, teamId, map, ROSTER_SCAN_PAGES);
  } else {
    await harvestAssigneesFromTasks(token, teamId, map, 4); // light enrichment only
  }
  return [...map.values()].sort((a, b) => (a.name || a.email || "").localeCompare(b.name || b.email || ""));
}

function addRosterEntry(map, user) {
  if (!user || user.id == null) return;
  const id = String(user.id);
  const name = String(user.username || user.name || user.email || ("User " + id)).trim() || ("User " + id);
  const email = typeof user.email === "string" ? user.email.trim() : "";
  const prev = map.get(id);
  if (!prev) {
    map.set(id, { id, name, email });
  } else {
    if (/^User \d+$/.test(prev.name) && !/^User \d+$/.test(name)) prev.name = name;
    if (email && !prev.email) prev.email = email;
  }
}

// A member-directory response (if the workspace honors one) arrives with entries
// wrapped as {user:{...}}, plus a `guests` array of the same shape.
function entriesFromMemberJson(j) {
  const out = [];
  for (const r of ["members", "guests"]) {
    for (const e of Array.isArray(j && j[r]) ? j[r] : []) {
      out.push(e && e.user ? e.user : e);
    }
  }
  return out;
}

function addUids(map, entries) {
  for (const u of entries) addRosterEntry(map, u);
}

async function probeDirectRoster(token, teamId, map) {
  // 1) The Authorized Teams response (GET /team) carries each team's members
  //    array ({user:{...}} wrappers) - a single cheap call, no pagination. It can
  //    come back name-less ({id, role}), so don't treat it as final.
  try {
    const j = await cuFetch(token, "/team");
    const teams = Array.isArray(j && j.teams) ? j.teams : [];
    for (const t of teams) {
      if (String(t && t.id) !== String(teamId)) continue;
      addUids(map, Array.isArray(t && t.members) ? t.members : []);
      break;
    }
  } catch (e) {
    /* fall through to the per-team shapes below */
  }
  // 2) Legacy per-team roster shapes (also used by some docs/examples).
  for (const path of ["/team/" + teamId + "/user", "/team/" + teamId + "/member"]) {
    try {
      const j = await cuFetch(token, path);
      addUids(map, entriesFromMemberJson(j));
    } catch (e) {
      /* 403/404/enterprise-only → try the next shape */
    }
  }
}

// Harvest every unique assignee from the workspace's accessible tasks. The scan
// is deliberately unfiltered (all statuses, subtasks included) so we cover as
// many people as possible; `maxPages` bounds how many 100-task pages we consume.
async function harvestAssigneesFromTasks(token, teamId, map, maxPages) {
  for (let page = 0; page < maxPages; page++) {
    const params = [
      ["include_closed", "true"],
      ["subtasks", "true"],
      ["page", String(page)],
    ];
    let tasks = [];
    let lastPage = false;
    try {
      const j = await cuFetch(token, "/team/" + teamId + "/task", params);
      tasks = Array.isArray(j && j.tasks) ? j.tasks : [];
      lastPage = j.last_page === true;
    } catch (e) {
      if (page === 0) console.warn("[ClickUp] roster task-scan failed:", e && e.message ? e.message : e);
      break;
    }
    for (const t of tasks) {
      for (const a of Array.isArray(t && t.assignees) ? t.assignees : []) addRosterEntry(map, a);
    }
    if (tasks.length < 100 || lastPage) break;
  }
}

// Verify a freshly-entered token and hand back everything the options page needs
// to finish setup (which workspace to use, who the token belongs to).
export async function verifyToken(token) {
  const user = await getUser(token);
  const teams = await getTeams(token);
  return { user, teams };
}

// ---------- the day's tasks ----------
// Local-day bounds [00:00:00.000, 23:59:59.999] for the timestamp `now`.
function localDayBounds(now) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  return { start, end };
}

// All tasks assigned to `userId` whose due date falls on the local day of `now`.
// We deliberately INCLUDE closed tasks (a task you finished today still counts
// toward the day's estimate) and subtasks (a lot of real work lives in them).
export async function getTasksDueToday(token, teamId, userId, now = Date.now()) {
  const { start, end } = localDayBounds(now);
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = [
      ["assignees[]", String(userId)],
      // ClickUp's filter is strictly greater/less-than, so nudge the bounds by 1ms.
      ["due_date_gt", String(start - 1)],
      ["due_date_lt", String(end + 1)],
      ["subtasks", "true"],
      ["include_closed", "true"],
      ["page", String(page)],
    ];
    const j = await cuFetch(token, "/team/" + teamId + "/task", params);
    const tasks = Array.isArray(j && j.tasks) ? j.tasks : [];
    for (const t of tasks) out.push(t);
    // v2 returns up to 100 per page; a short page (or last_page flag) means we're done.
    if (tasks.length < 100 || j.last_page === true) break;
  }
  return out;
}

// All subtasks of a given parent task, across statuses. Subtasks frequently
// carry NO due date of their own (only the parent does), so the due-today filter
// in getTasksDueToday never surfaces them - this pulls a parent's breakdown work
// explicitly. `userId`, when given, drops subtasks assigned SOLELY to other
// people (unassigned subtasks are kept) so someone else's work can't inflate the
// viewer's day. Returns the raw task objects (time_estimate/time_spent/dates).
// A single task's export fields (ClickUp's subtask lists carry no description,
// so each subtask has to be asked for separately).
export async function getTaskDetail(token, taskId) {
  const t = await cuFetch(token, "/task/" + encodeURIComponent(String(taskId)));
  const rows = Array.isArray(t && t.dependencies) ? t.dependencies : [];
  const id = String((t && t.id) || "");
  return {
    dependsOn: rows.filter((d) => String(d.task_id) === id && d.depends_on).map((d) => String(d.depends_on)),
    blocks: rows.filter((d) => String(d.depends_on) === id && d.task_id).map((d) => String(d.task_id)),
    priority: cuPriorityName(t),
    id: t && t.id,
    name: (t && t.name) || "",
    description: String((t && (t.description || t.text_content)) || "").trim(),
    status: (t && t.status && t.status.status) || "",
    done: isTaskDone(t),
    dueDateMs: t && t.due_date ? Number(t.due_date) : null,
    estimateMs: Number(t && t.time_estimate) || 0,
    spentMs: Number(t && t.time_spent) || 0,
    url: taskUrlFor(t && t.id),
  };
}

// One request: the task itself (so we learn ITS parent) plus its subtasks.
export async function getTaskTree(token, parentId, userId) {
  const uid = userId != null ? String(userId) : null;
  let j;
  try {
    j = await cuFetch(token, "/task/" + encodeURIComponent(String(parentId)), [["include_subtasks", "true"]]);
  } catch (e) {
    if (e && e.status === 429) throw e; // let callers back off
    return { parent: null, subtasks: [] };
  }
  const subs = Array.isArray(j && j.subtasks) ? j.subtasks : [];
  const out = [];
  for (const t of subs) {
    if (!t || String(t.id) === String(parentId)) continue;
    if (t.parent != null && String(t.parent) !== String(parentId)) continue; // direct children only
    if (uid) {
      const who = Array.isArray(t.assignees) ? t.assignees : [];
      if (who.length && !who.some((a) => String(a && a.id) === uid)) continue;
    }
    out.push(t);
  }
  // ClickUp lists dependencies as { task_id, depends_on }: task_id waits for
  // depends_on. Split them per task so an export can say what blocks what.
  const deps = (t) => {
    const rows = Array.isArray(t && t.dependencies) ? t.dependencies : [];
    const id = String((t && t.id) || "");
    return {
      dependsOn: rows.filter((d) => String(d.task_id) === id && d.depends_on).map((d) => String(d.depends_on)),
      blocks: rows.filter((d) => String(d.depends_on) === id && d.task_id).map((d) => String(d.task_id)),
    };
  };
  const plain = (t) => ({
    ...deps(t),
    priority: cuPriorityName(t),
    id: t && t.id,
    name: (t && t.name) || "",
    description: String((t && (t.description || t.text_content)) || "").trim(),
    status: (t && t.status && t.status.status) || "",
    done: isTaskDone(t),
    dueDateMs: t && t.due_date ? Number(t.due_date) : null,
    estimateMs: Number(t && t.time_estimate) || 0,
    spentMs: Number(t && t.time_spent) || 0,
    url: taskUrlFor(t && t.id),
  });
  return {
    parent: j && j.parent != null ? String(j.parent) : null,
    self: plain(j),
    subtasks: out,
    subtaskRows: out.map(plain),
  };
}

export async function getSubtasksOfParent(token, teamId, parentId, userId) {
  // The team /task endpoint ignores a "parent" filter (it returned hundreds of
  // unrelated tasks), so ask for the parent task itself WITH its subtasks - the
  // documented way, one request per parent.
  return (await getTaskTree(token, parentId, userId)).subtasks;
}

// ---------- auto-detected "Extra(s) Task(s)" ----------
// The daily extra is the assigned task whose NAME contains the daily-extra
// pattern (case-insensitive) - e.g. "...Extra(s) Task(s)...". Matching is
// intentionally loose about parens/apostrophes/plural "s". The search FIRST uses
// a due-date window (the same query the "Filter → This Week" card uses, which
// reliably surfaces the task) and only falls back to an unfiltered scan. An
// OPEN match is preferred, but a closed/completed occurrence still wins when
// nothing open matches; cancelled tasks are never picked. If the user's username
// (email/handle) is known, a match that includes it wins.
export const EXTRA_TASK_NAME_RE = /extra\s*\(?\s*s?\s*\)?\s*-?\s*tasks?/i;

export async function findExtraTaskByName({ token, teamId, userId, usernameHint = "", fromTs, toTs }) {
  const hint = String(usernameHint || "").toLowerCase();
  // Try the due-date window first (proven: the This Week filter finds it there),
  // then fall back to an unfiltered paginated scan of the user's tasks.
  const windows = fromTs && toTs ? [{ fromTs: Number(fromTs), toTs: Number(toTs) }, null] : [null];
  for (const win of windows) {
    const open = [];
    const closed = [];
    outer: for (let page = 0; page < MAX_PAGES; page++) {
      const params = [
        ["assignees[]", String(userId)],
        ["include_closed", "true"],
        ["subtasks", "true"],
        ["page", String(page)],
      ];
      if (win) {
        params.push(["due_date_gt", String(win.fromTs - 1)]);
        params.push(["due_date_lt", String(win.toTs + 1)]);
      }
      const j = await cuFetch(token, "/team/" + teamId + "/task", params);
      const tasks = Array.isArray(j && j.tasks) ? j.tasks : [];
      for (const t of tasks) {
        const name = t.name || "";
        if (!EXTRA_TASK_NAME_RE.test(name)) continue;
        const status = (t.status && t.status.status) || "";
        if (/(cancelled|canceled)/i.test(status)) continue;
        const hit = {
          id: t.id,
          name,
          url: taskUrlFor(t.id),
          status,
          estimateMs: Number(t.time_estimate) || 0,
          hasHint: !!(hint && name.toLowerCase().includes(hint)),
        };
        (/(closed|done|completed)/i.test(status) ? closed : open).push(hit);
        if (hint && open.some((m) => m.hasHint)) break outer;
        if (!hint && (open.length || closed.length)) break outer;
      }
      if (tasks.length < 100 || j.last_page === true) break;
    }
    let found = null;
    if (hint && (open.length || closed.length)) {
      found = (open.find((m) => m.hasHint) || closed.find((m) => m.hasHint) || open[0] || closed[0]);
    } else if (open.length || closed.length) {
      found = (open[0] || closed[0]);
    }
    if (found) return found;
  }
  return null;
}

// ---------- deadline task (weekly task divided across weekdays) ----------
// Parses a ClickUp task URL to extract the task ID.
// Supported formats:
//   https://app.clickup.com/t/36162007/86eyrpk3c  → "86eyrpk3c"
//   https://app.clickup.com/t/86eyrpk3c            → "86eyrpk3c"
export function parseTaskIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const trimmed = url.trim();
  // Match the last segment after /t/ which is the task ID
  const match = trimmed.match(/\/t\/(?:\d+\/)?([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}

// Build a user-facing ClickUp task URL for a single task id. Used so each task
// name in the UI is clickable and opens the task in ClickUp.
export function taskUrlFor(taskId) {
  if (!taskId) return "";
  return "https://app.clickup.com/t/" + encodeURIComponent(taskId);
}

// ClickUp priority is `{ priority:"urgent"|"high"|"normal"|"low", ... } | null`.
// Normalize to a lower-case name ("" when the task has no priority set) so the
// Status/Priority refine filters can match on it without new API calls.
export function cuPriorityName(t) {
  return (t && t.priority && t.priority.priority) ? String(t.priority.priority).toLowerCase() : "";
}

// ---------- client label (which "client" a task belongs to) ----------
// Some agencies store the client in a ClickUp CUSTOM FIELD (e.g. a "Client Name"
// dropdown) rather than in the Space/Folder/List hierarchy - so the hierarchy
// name (a folder like "All SEO Clients") is NOT the client. This resolves that
// field's display value straight from a raw task payload's custom_fields[]: no
// extra API call, because each field carries its own type_config.options. The
// field is matched by name, case-insensitively, against common client labels.
const CLIENT_FIELD_NAMES = ["client name", "client", "clientname", "client_name", "client (s)", "clients"];

// Resolve a custom field's human-readable value across the common field types.
// drop_down: value is the selected option's id OR orderindex -> its name/label.
// labels: value is an array of option ids -> names joined. text/url/number/etc:
// the primitive value as text. Anything unrecognised or empty -> "".
function resolveCustomFieldValue(cf) {
  if (!cf) return "";
  const v = cf.value;
  const type = String(cf.type || "").toLowerCase();
  const opts = (cf.type_config && Array.isArray(cf.type_config.options)) ? cf.type_config.options : [];
  const optName = (o) => (o && (o.name || o.label) != null) ? String(o.name || o.label).trim() : "";
  if (type === "drop_down" || type === "dropdown") {
    if (v == null || v === "") return "";
    const hit = opts.find((o) => o && String(o.id) === String(v))
      || opts.find((o) => o && o.orderindex != null && String(o.orderindex) === String(v));
    return hit ? optName(hit) : "";
  }
  if (type === "labels" || type === "label") {
    const arr = Array.isArray(v) ? v : (v != null && v !== "" ? [v] : []);
    const names = arr.map((el) => {
      const id = (el && typeof el === "object") ? el.id : el;
      const hit = opts.find((o) => o && String(o.id) === String(id));
      if (hit) return optName(hit);
      return (el && typeof el === "object") ? optName(el) : "";
    }).filter(Boolean);
    return names.join(" / ");
  }
  // text / short_text / url / email / phone / number and similar primitives.
  if (v == null || typeof v === "object") return "";
  return String(v).trim();
}

// The client name from a task's custom fields (the first client-named field with
// a non-empty value), or "" when the task has no such field.
export function taskClientField(t) {
  const cfs = t && Array.isArray(t.custom_fields) ? t.custom_fields : [];
  for (const cf of cfs) {
    const nm = String((cf && cf.name) || "").trim().toLowerCase();
    if (CLIENT_FIELD_NAMES.includes(nm)) {
      const val = resolveCustomFieldValue(cf);
      if (val) return val;
    }
  }
  return "";
}

// A ClickUp task lives in Space ▸ Folder ▸ List ▸ Task. Different agencies put
// the client name at different levels, so we capture all three from the raw task
// payload. `folder.name` and `list.name` come free in every task response; a
// space carries only its id (its name needs a separate, cacheable /space/{id}
// call - see getSpaceName). `folder.hidden === true` is ClickUp's "folderless
// list" marker (not a real client grouping), so we ignore a hidden folder.
// `clientField` captures a "Client Name"-style custom field when present - the
// most explicit signal, preferred by the "auto" level below.
export function taskContainer(t) {
  const folder = t && t.folder;
  const list = t && t.list;
  const space = t && t.space;
  return {
    folderName: folder && folder.hidden !== true ? (folder.name || "") : "",
    listName: (list && list.name) || "",
    spaceId: space && space.id != null ? String(space.id) : "",
    clientField: taskClientField(t),
  };
}

// Resolve a display client name from a captured container + chosen level.
// `spaceNames` is a Map(spaceId → name) the caller pre-populates (see
// getSpaceName); an unresolved space id is simply skipped in the fallback chain.
//   auto   → List (breadcrumb direct parent), else field, else Folder, else Space
//   field  → Client-Name field, else List, else Folder, else Space
//   folder → Folder, else field, else List, else Space
//   space  → Space, else field, else Folder, else List
//   list   → List, else field, else Folder, else Space
// NOTE ON auto: the List is the task's DIRECT parent container (the breadcrumb),
// and in practice it is ALWAYS present and IS the client, whereas the "Client
// Name" custom field is frequently empty or inconsistently typed. So auto now
// treats the LIST as the PRIMARY client identity for every client (field is only
// a fallback when a task somehow has no list). Users whose field is the real
// signal can still pick the explicit "field" level in Advanced Settings.
export function clientLabelFromContainer(ctr, level, spaceNames) {
  if (!ctr) return "";
  const folder = ctr.folderName || "";
  const list = ctr.listName || "";
  const field = ctr.clientField || "";
  const space = (ctr.spaceId && spaceNames) ? (spaceNames.get(ctr.spaceId) || "") : "";
  switch (level) {
    case "list": return list || field || folder || space;
    case "space": return space || field || folder || list;
    case "folder": return folder || field || list || space;
    case "field": return field || list || folder || space;
    case "auto":
    default: return list || field || folder || space;
  }
}

// Fetch a Space's display name, cached in `spaceNames` (a Map). Spaces are
// stable, so once resolved we never re-fetch for the life of the cache - keeping
// the extra /space/{id} calls to at most one per distinct space.
export async function getSpaceName(token, spaceId, spaceNames) {
  const id = spaceId != null ? String(spaceId) : "";
  if (!id) return "";
  if (spaceNames && spaceNames.has(id)) return spaceNames.get(id);
  let name = "";
  try {
    const j = await cuFetch(token, "/space/" + encodeURIComponent(id));
    name = (j && j.name) || "";
  } catch (e) { name = ""; }
  if (spaceNames) spaceNames.set(id, name);
  return name;
}

// Resolve every space name still missing from `spaceNames` for a batch of
// captured containers - but only when the level actually needs them. In "auto"
// the Space is the LAST fallback (after field, list and folder), and a task's
// list name is always present in the payload, so auto effectively never needs a
// space lookup; "space" always needs them. Folder/list-only levels do no network
// work at all.
export async function resolveSpaceNamesFor(token, containers, level, spaceNames) {
  if (!spaceNames || (level !== "auto" && level !== "space")) return;
  const need = new Set();
  for (const c of containers || []) {
    if (!c || !c.spaceId || spaceNames.has(c.spaceId)) continue;
    if (level === "auto" && (c.clientField || c.listName || c.folderName)) continue; // field/list/folder wins → no lookup needed
    need.add(c.spaceId);
  }
  for (const id of need) await getSpaceName(token, id, spaceNames);
}

// Fetch a single task by its ID (including time_estimate, time_spent, dates).
export async function getTaskById(token, taskId) {
  const j = await cuFetch(token, "/task/" + encodeURIComponent(taskId));
  const t = j && j.task ? j.task : j;
  const assignees = (Array.isArray(t.assignees) ? t.assignees : []).map((a) => ({
    id: a && a.id,
    username: (a && (a.username || a.email)) || "",
  }));
  return {
    id: t.id || taskId,
    name: t.name || "(untitled task)",
    estimateMs: Number(t.time_estimate) || 0,
    spentMs: Number(t.time_spent) || 0,
    status: (t.status && t.status.status) || "",
    statusType: (t.status && t.status.type) || "",
    priority: cuPriorityName(t),
    hasEstimate: (Number(t.time_estimate) || 0) > 0,
    startDateMs: t.start_date ? Number(t.start_date) : null,
    dueDateMs: t.due_date ? Number(t.due_date) : null,
    dueDateHasTime: t.due_date_time == null ? null : !!t.due_date_time,
    assignees,
    assigneeCount: assignees.length,
    listId: (t.list && t.list.id) || null,
    container: taskContainer(t),
    url: taskUrlFor(t.id || taskId),
  };
}

// Change a task's status (e.g. "to do" / "in progress" / "complete"). ClickUp
// matches the status name case-insensitively against the task's list; an unknown
// name comes back as a 4xx whose message cuPut surfaces so the caller can show it.
export async function setTaskStatus(token, taskId, statusName) {
  return cuPut(token, "/task/" + encodeURIComponent(taskId), { status: statusName });
}

// Whether a task counts as "completed" for the green ✓ marker. ClickUp reports
// the status TYPE on every task ("open" / "in progress" / "closed" / "custom");
// type "closed" is the canonical "done" signal, but we also accept common done-
// style status NAMES for workspaces that use a custom status of type "custom".
export function isTaskDone(t) {
  const s = t && t.status;
  const type = s && typeof s === "object" ? s.type : (t && t.statusType);
  if (type === "closed" || type === "done" || type === "complete") return true;
  const name = String((s && typeof s === "object" ? s.status : s) || "").toLowerCase().trim();
  return ["closed", "done", "complete", "completed", "resolved", "shipped", "approved"].includes(name);
}

// A per-run in-memory cache for task-by-id fetches so the same configured URL is
// never fetched twice in one refresh (today + weekly + filter all read the cache).
export function createTaskCache() {
  const map = new Map();
  return {
    map,
    async get(token, taskId) {
      if (!taskId) return null;
      if (map.has(taskId)) return map.get(taskId) || null;
      let task = null;
      try { task = await getTaskById(token, taskId); } catch (e) {}
      map.set(taskId, task);
      return task;
    },
  };
}

// getTaskById with an optional shared cache (used when several fetchers request
// the same configured task URLs within one refresh).
async function getTaskCached(token, taskId, cache) {
  return cache ? await cache.get(token, taskId) : getTaskById(token, taskId);
}

// Returns the day-of-week (1=Mon … 5=Fri, 6=Sat, 0=Sun) for a timestamp.
function dayOfWeek(ts) {
  return new Date(ts).getDay();
}

// Whether the given timestamp falls on a weekday (Mon-Fri).
function isWeekday(ts) {
  const dow = dayOfWeek(ts);
  return dow >= 1 && dow <= 5;
}

// ---------- currently running timer (task-level "about to hit estimate") ----------
// ClickUp's "current time entry" endpoint tells us which task (if any) has a
// live timer running right now for this token's user, and when it started.
// Returns null if nothing is currently running or it isn't attached to a task.
export async function getCurrentTimeEntry(token, teamId) {
  const j = await cuFetch(token, "/team/" + teamId + "/time_entries/current");
  const d = j && j.data;
  if (!d || !d.task || !d.task.id) return null;
  const startMs = Number(d.start) || 0;
  if (!startMs) return null;
  return { taskId: d.task.id, taskName: d.task.name || "", startMs, id: d.id != null ? String(d.id) : null, description: d.description || "" };
}

// ---------- timer control (start / stop the running timer for this token's user) ----------
// Start a timer on `taskId` for the token owner. ClickUp rejects this with an
// error if a timer is already running (even on a different task), so callers
// that want to switch tasks should stopTimer() first. Returns the started entry.
export async function startTimer(token, teamId, taskId, description) {
  // Optional description shows on the time entry in ClickUp (e.g. "Meeting").
  const body = { tid: String(taskId) };
  if (description && String(description).trim()) body.description = String(description).trim().slice(0, 500);
  const j = await cuPost(token, "/team/" + teamId + "/time_entries/start", body);
  return (j && j.data) || null;
}

// Edit a time entry (e.g. end it earlier to drop away-from-desk time).
export async function updateTimeEntry(token, teamId, entryId, body) {
  return cuPut(token, "/team/" + teamId + "/time_entries/" + encodeURIComponent(entryId), body || {});
}

// Change a task's due date. hasTime null = leave ClickUp's date-only/timed flag alone.
export async function setTaskDueDate(token, taskId, dueMs, hasTime) {
  // dueMs null/0 clears the due date.
  const body = { due_date: dueMs ? Number(dueMs) : null };
  if (dueMs && hasTime != null) body.due_date_time = !!hasTime;
  return cuPut(token, "/task/" + encodeURIComponent(taskId), body);
}

// Stop the currently-running timer for the token owner. Only call when something
// is actually running - ClickUp errors ("no time entry running") otherwise.
export async function stopTimer(token, teamId) {
  const j = await cuPost(token, "/team/" + teamId + "/time_entries/stop", {});
  return (j && j.data) || null;
}

// How close a currently-running task is to ITS OWN time_estimate: today's
// already-closed entries on that task, plus the live segment (now - startMs).
// Separate from the daily-aggregate estimate/tracked numbers used elsewhere in
// this file. Returns null if the task has no estimate set (nothing to compare
// against).
export async function getRunningTaskProgress(token, teamId, taskId, startMs, now = Date.now()) {
  const task = await getTaskById(token, taskId);
  if (!task || !task.hasEstimate) return null;
  const { start, end } = localDayBounds(now);
  const params = [
    ["start_date", String(start)],
    ["end_date", String(end)],
    ["task_id", String(taskId)],
  ];
  const j = await cuFetchTimeEntries(token, teamId, params, null);
  const entries = (j && Array.isArray(j.data)) ? j.data : [];
  let closedMs = 0;
  for (const e of entries) {
    const dur = Number(e.duration) || 0;
    if (dur > 0) closedMs += dur; // the live entry reports 0/negative while running - skip it here
  }
  const liveMs = Math.max(0, now - startMs);
  return { estimateMs: task.estimateMs, trackedMs: closedMs + liveMs, taskName: task.name || "" };
}

// ---------- time entries (today-only tracked time) ----------
// Fetch all time entries for the team during today's local day, grouped by task ID.
// Returns a Map<taskId, totalMs> of time tracked today per task. This is used
// instead of the cumulative `time_spent` field on tasks so that daily tasks only
// show the time tracked on the current day.
//
// When `assigneeIds` is given, only time entries logged BY those users count.
// ClickUp's time_entries response puts the person who logged each entry in the
// entry's `user` object, so a department/single-user scope gets that user's
// tracked time instead of the whole team's.
export async function fetchTodayTimeEntriesByTask(token, teamId, now = Date.now(), assigneeIds) {
  const { start, end } = localDayBounds(now);
  const params = [["start_date", String(start)], ["end_date", String(end)]];
  const j = await cuFetchTimeEntries(token, teamId, params, assigneeIds);
  const entries = (j && Array.isArray(j.data)) ? j.data : [];
  const who = (Array.isArray(assigneeIds) && assigneeIds.length)
    ? assigneeIds.map(String).reduce((s, id) => s.add(id), new Set())
    : null;
  const map = new Map();
  for (const e of entries) {
    if (who) {
      const uid = (e.user && e.user.id != null) ? String(e.user.id)
        : (e.assignee && e.assignee.id != null) ? String(e.assignee.id)
        : "";
      if (!uid || !who.has(uid)) continue;
    }
    const taskId = e.task && e.task.id;
    if (!taskId) continue;
    const dur = Number(e.duration) || 0;
    if (dur <= 0) continue;
    map.set(taskId, (map.get(taskId) || 0) + dur);
  }
  return map;
}

// Add the CURRENTLY RUNNING timer's live elapsed time into a per-task tracked
// map (Map<taskId, ms>), so today's tracked total reflects an in-progress timer
// instead of showing 0 until it's paused/stopped. The list time-entries endpoint
// omits the running entry (or reports a non-positive duration), so we read it
// explicitly via /time_entries/current and add (now - start), clamped to today's
// start so an overnight timer only contributes today's portion. Best-effort:
// any failure leaves the map unchanged. Scoped to the token's own user (which is
// exactly whose timer /current returns), so it only applies to personal totals.
export async function addRunningTimerToTodayMap(token, teamId, map, now = Date.now()) {
  try {
    const entry = await getCurrentTimeEntry(token, teamId);
    if (!entry || !entry.taskId || !entry.startMs) return map;
    const { start: todayStart } = localDayBounds(now);
    const liveFrom = Math.max(entry.startMs, todayStart);
    const liveMs = Math.max(0, now - liveFrom);
    if (liveMs <= 0) return map;
    map.set(entry.taskId, (map.get(entry.taskId) || 0) + liveMs);
  } catch (e) {
    // best-effort - don't let a failed running-timer lookup break the estimate
  }
  return map;
}

// Fetch time entries for a specific task during today's local day and sum them.
// Returns the total milliseconds tracked today for that single task. Scoped to
// the logged-in user when `assigneeIds` is provided.
export async function fetchTimeEntriesForTaskToday(token, teamId, taskId, now = Date.now(), assigneeIds) {
  const { start, end } = localDayBounds(now);
  const params = [
    ["start_date", String(start)],
    ["end_date", String(end)],
    ["task_id", String(taskId)],
  ];
  const j = await cuFetchTimeEntries(token, teamId, params, assigneeIds);
  const entries = (j && Array.isArray(j.data)) ? j.data : [];
  const who = (Array.isArray(assigneeIds) && assigneeIds.length)
    ? assigneeIds.map(String).reduce((s, id) => s.add(id), new Set())
    : null;
  let total = 0;
  for (const e of entries) {
    if (who) {
      const uid = (e.user && e.user.id != null) ? String(e.user.id)
        : (e.assignee && e.assignee.id != null) ? String(e.assignee.id)
        : "";
      if (!uid || !who.has(uid)) continue;
    }
    total += Number(e.duration) || 0;
  }
  return total;
}

// Fetch ALL time entries that fall within [fromTs, toTs], grouped by the LOCAL
// calendar day they started in → per-task totals. One API call covers a whole
// week, which the weekly summary needs to split tracked time across the days
// that tasks were actually worked on.
// Fetch time entries for a date range, grouped day → task. Returns
// Map<dayStartMs, Map<taskId, totalMs>>. Scoped to the logged users when
// `assigneeIds` is provided (a department, a single member, or the viewer).
export async function fetchTimeEntriesByDayTask(token, teamId, fromTs, toTs, assigneeIds, adminToken) {
  const startD = new Date(fromTs);
  startD.setHours(0, 0, 0, 0);
  const endD = new Date(toTs);
  endD.setHours(23, 59, 59, 999);
  const params = [
    ["start_date", String(startD.getTime())],
    ["end_date", String(endD.getTime())],
  ];
  // Department/single-user scopes need a token that can read OTHERS' entries. If
  // an `adminToken` is configured, try it FIRST with the assignee scope; if it
  // returns nothing (or isn't set), fall back to the personal token the same way.
  // The caller decides whether the personal fallback keeps the assignee scope
  // (it silently drops other users' entries, leaving them at 0m - never a wrong
  // rounded cumulative).
  let j = null;
  if (adminToken && assigneeIds && assigneeIds.length) {
    try {
      const aj = await cuFetchTimeEntries(adminToken, teamId, params, assigneeIds);
      const ae = (aj && Array.isArray(aj.data)) ? aj.data : [];
      if (ae.length) { j = aj; }
    } catch (e) {
      if (e.status === 401 || e.status === 429) throw e;
    }
  }
  if (!j) {
    j = await cuFetchTimeEntries(token, teamId, params, assigneeIds);
  }
  const entries = (j && Array.isArray(j.data)) ? j.data : [];
  const who = (Array.isArray(assigneeIds) && assigneeIds.length)
    ? assigneeIds.map(String).reduce((s, id) => s.add(id), new Set())
    : null;
  const byDay = new Map(); // dayStartMs -> Map<taskId, ms>
  for (const e of entries) {
    if (who) {
      const uid = (e.user && e.user.id != null) ? String(e.user.id)
        : (e.assignee && e.assignee.id != null) ? String(e.assignee.id)
        : "";
      if (!uid || !who.has(uid)) continue;
    }
    const taskId = e.task && e.task.id;
    if (!taskId) continue;
    const dur = Number(e.duration) || 0;
    if (dur <= 0) continue;
    const d = new Date(Number(e.start) || 0);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
    if (!byDay.has(dayStart)) byDay.set(dayStart, new Map());
    const m = byDay.get(dayStart);
    m.set(taskId, (m.get(taskId) || 0) + dur);
  }
  return byDay;
}

// All calendar days (normalized to their 00:00 start) between two easy dates.
function dayStartsInRange(fromTs, toTs) {
  const out = [];
  const start = new Date(fromTs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(toTs);
  end.setHours(23, 59, 59, 999);
  const cur = new Date(start.getTime());
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.getTime());
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Which calendar days between start and due had ZERO tracked minutes, using the
// full week's per-day time map (from fetchTimeEntriesByDayTask). Used by the
// "exclude untracked days" extended-task strategy when building the weekly total.
function zeroTrackedDaysFromMap(taskId, startDateMs, dueDateMs, byDayTask) {
  const out = [];
  const MS = 86400000;
  const start = Math.min(startDateMs, dueDateMs);
  const end = Math.max(startDateMs, dueDateMs);
  const days = Math.max(1, Math.round((end - start) / MS) + 1);
  for (let i = 0; i < days; i++) {
    const dayStart = new Date(start + i * MS);
    dayStart.setHours(0, 0, 0, 0);
    const dayTime = byDayTask.get(dayStart.getTime());
    const spent = (dayTime && dayTime.get(taskId)) || 0;
    if (spent <= 0) out.push(dayStart.getTime());
  }
  return out;
}

// Fetch a deadline task's contribution to today's estimate. The task's total
// estimate is divided by 5 (WEEKDAY_COUNT) for Mon-Fri; Saturday/Sunday = 0.
// The tracked time is TODAY-ONLY (from the time-entries map passed in), so it
// does not include time tracked on previous days.
export async function fetchDeadlineTaskEstimate({ token, teamId, taskUrl, todayByTask, now = Date.now(), taskCache }) {
  const taskId = parseTaskIdFromUrl(taskUrl);
  if (!taskId) return { error: "invalid-url", taskUrl };
  try {
    const task = await getTaskCached(token, taskId, taskCache);
    if (!task) return { error: "task-unavailable", taskUrl };
    const weekday = isWeekday(now);
    const dayEstimateMs = weekday ? Math.round(task.estimateMs / WEEKDAY_COUNT) : 0;
    // Today-only tracked time, from the pre-fetched team time-entries map.
    // Falls back to the task's cumulative spent only when no time-entries map
    // is available (e.g. older callers) or the API didn't return an entry.
    let spentMs = (todayByTask instanceof Map && todayByTask.has(task.id) && todayByTask.get(task.id) > 0)
      ? todayByTask.get(task.id)
      : 0;
    if (!(todayByTask instanceof Map) && teamId) {
      spentMs = await fetchTimeEntriesForTaskToday(token, teamId, task.id, now);
    }
    return {
      taskId: task.id,
      name: task.name,
      totalEstimateMs: task.estimateMs,
      dayEstimateMs,
      dueDateMs: task.dueDateMs || null,
      spentMs,
      spentToday: true,
      hasEstimate: task.hasEstimate,
      isWeekday: weekday,
      dayOfWeek: dayOfWeek(now),
      url: task.url,
      status: task.status,
      priority: task.priority || "",
      done: isTaskDone(task),
      container: task.container,
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e), taskUrl };
  }
}

// ---------- EXTENDED / multi-day tasks ----------
// Some tasks span many days (a "start" and a "due" date). Instead of counting
// the FULL estimate on the due day, we spread it across the working days between
// start and due. This avoids double-counting the whole estimate on a single day
// when the task legitimately occupies a whole week.
//
// Two division strategies (user toggle, defaults to `days` = exclude OFF):
//   • days  : spread equally across the WORKING days (Mon-Fri) inside the span.
//             A Mon→Fri task = estimate ÷ 5 and EVERY one of those weekdays
//             shows 1/5 of the estimate - regardless of how many days have
//             passed. The "up to today" total simply sums the days shown so far.
//   • excl0 : skip weekdays with 0 tracked minutes and re-divide the estimate
//             onto the remaining (tracked) days.
// Weekends NEVER count as days. A task with a DUE date but no START date is a
// single-day task: its whole estimate sits on the due date. Same-day dates (a
// daily-recurring occurrence) keep the historical weekly ÷5 rule.
// Returns a byDay Map<dayStartMs, share> plus the divisor info for display.
export function splitEstimateAcrossDays({ estimateMs, startDateMs, dueDateMs, mode = "days", excludedDays = [], singleDay = false }) {
  const empty = () => ({ totalDays: 0, divisor: 0, dayEstimateMs: 0, skippedDays: 0, byDay: new Map() });
  if (!estimateMs || estimateMs <= 0) return empty();
  const tStart = Number(startDateMs) || 0;
  const tDue = Number(dueDateMs) || 0;
  if (!tStart && !tDue) {
    // No date info at all → historical weekly rule (÷ weekdays).
    return { totalDays: 5, divisor: 5, dayEstimateMs: Math.round(estimateMs / 5), skippedDays: 0, byDay: new Map() };
  }
  const effStart = tStart || tDue;
  const effDue = tDue || tStart;
  const MS = 86400000;
  const spanStart = new Date(effStart).setHours(0, 0, 0, 0);
  const single = singleDay || effDue <= effStart;
  const days = [];
  if (single) {
    days.push(spanStart);
  } else {
    for (let i = 0; i <= Math.round((effDue - effStart) / MS); i++) {
      const ts = spanStart + i * MS;
      if (isWeekday(ts)) days.push(ts); // weekends never count as days
    }
  }
  if (!days.length) return empty();
  const excluded = new Set((excludedDays || []).map((d) => new Date(d).setHours(0, 0, 0, 0)));
  const totalDays = days.length;
  let divisor = totalDays;
  let fallbackAll = false;
  let skippedDays = 0;
  if (mode === "excl0") {
    divisor = days.filter((ts) => !excluded.has(ts)).length;
    if (divisor === 0 && totalDays > 1) {
      // A real multi-day span where EVERY day is untracked: fall back to a plain
      // all-days split (div-by-zero guard) instead of wiping out the task.
      divisor = totalDays;
      fallbackAll = true;
    }
    skippedDays = fallbackAll ? 0 : totalDays - divisor;
  }
  const share = divisor > 0 ? Math.round(estimateMs / divisor) : 0;
  const byDay = new Map();
  for (const ts of days) {
    if (mode === "excl0" && !fallbackAll && excluded.has(ts)) continue; // excluded/untracked days → 0
    byDay.set(ts, share);
  }
  return { totalDays, divisor, dayEstimateMs: share, skippedDays, byDay };
}

// Fetch an EXTENDED task's per-day estimate contribution for a given `now`
// (defaults to today). The task is fetched by URL; its estimate is spread across
// the WORKING days inside the start..due span using the chosen `mode`. A task
// with only a DUE date is treated as a single-day task (its whole estimate sits
// on the due date). In "excl0" mode, 0-tracked weekdays are skipped (their
// share is re-spread onto the tracked days), which needs a real per-day tracked
// map - one is fetched for the task's span when the caller didn't supply it.
// Returns the same shape as fetchDeadlineTaskEstimate, plus date info.
export async function fetchExtendedTaskEstimate({ token, teamId, taskUrl, todayByTask, byDayTracked, now = Date.now(), mode = "days", taskCache, userScope }) {
  const taskId = parseTaskIdFromUrl(taskUrl);
  if (!taskId) return { error: "invalid-url", taskUrl };
  try {
    const task = await getTaskCached(token, taskId, taskCache);
    if (!task) return { error: "task-unavailable", taskUrl };
    const tStart = Number(task.startDateMs) || 0;
    const tDue = Number(task.dueDateMs) || 0;
    if (!tStart && !tDue) {
      // No date span at all → the plain weekly ÷5 deadline task.
      return await fetchDeadlineTaskEstimate({ token, teamId, taskUrl, todayByTask, now, taskCache });
    }
    const singleBound = (!!tStart !== !!tDue);
    if (mode === "excl0" && !(byDayTracked instanceof Map)) {
      // Fetch the span's per-day tracked map so 0m days can be excluded properly
      // (a today-only map can't tell us about the other days in the span).
      try {
        byDayTracked = await fetchTimeEntriesByDayTask(token, teamId, tStart || tDue, tDue || tStart, userScope);
      } catch (e) {
        byDayTracked = new Map();
      }
    }
    const excluded = mode === "excl0"
      ? zeroTrackedDaysFromMap(task.id, tStart || tDue, tDue || tStart, byDayTracked)
      : [];
    const split = splitEstimateAcrossDays({
      estimateMs: task.estimateMs,
      startDateMs: tStart,
      dueDateMs: tDue,
      mode,
      excludedDays: excluded,
      singleDay: singleBound,
    });
    // Today-only tracked time (from the map, else the task's cumulative spent).
    let spentMs = (todayByTask instanceof Map && todayByTask.has(task.id) && todayByTask.get(task.id) > 0)
      ? todayByTask.get(task.id)
      : 0;
    if (!(todayByTask instanceof Map) && teamId) {
      spentMs = await fetchTimeEntriesForTaskToday(token, teamId, task.id, now, userScope);
    }
    const nowDay = new Date(now).setHours(0, 0, 0, 0);
    return {
      taskId: task.id,
      name: task.name,
      totalEstimateMs: task.estimateMs,
      dayEstimateMs: split.byDay.get(nowDay) || 0,
      divisor: split.divisor,
      totalDays: split.totalDays,
      skippedDays: split.skippedDays,
      startDateMs: (tStart || tDue) || null,
      dueDateMs: (tDue || tStart) || null,
      spentMs,
      spentToday: true,
      hasEstimate: task.hasEstimate,
      isWeekday: isWeekday(now),
      dayOfWeek: dayOfWeek(now),
      url: task.url,
      status: task.status,
      priority: task.priority || "",
      done: isTaskDone(task),
      container: task.container,
    };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e), taskUrl };
  }
}

// Given an array of taskUrl strings (which may be a mix plain deadline/weekly
// tasks AND extended multi-day tasks), fetch each and compute the per-day
// estimate for `now`, respecting the configured `mode`.
export async function fetchConfiguredTasks({ token, teamId, taskUrls = [], todayByTask, now = Date.now(), extendedMode = "days", taskCache, userScope }) {
  const out = [];
  for (const url of taskUrls) {
    const taskId = parseTaskIdFromUrl(url);
    if (!taskId) {
      out.push({ error: "invalid-url", taskUrl: url });
      continue;
    }
    // Pre-fetch the task so we can tell whether it's extended (has date range).
    let task;
    try {
      task = await getTaskCached(token, taskId, taskCache);
    } catch (e) {
      out.push({ error: String(e && e.message ? e.message : e), taskUrl: url });
      continue;
    }
    // The task fetch may resolve to null (deleted / archived / no access) without
    // throwing - skip it so one dead URL can't sink the whole refresh.
    if (!task) {
      out.push({ error: "task-unavailable", taskUrl: url });
      continue;
    }
    // A task is "scaled" (divided by its span's working days) when it has a real
    // multi-day start→due range OR only a single bound (due-only = single day).
    const tStart = Number(task.startDateMs) || 0;
    const tDue = Number(task.dueDateMs) || 0;
    const scaled = !!(tStart && tDue && tDue > tStart) || (!!tStart !== !!tDue);
    const est = scaled
      ? await fetchExtendedTaskEstimate({ token, teamId, taskUrl: url, todayByTask, now, mode: extendedMode, taskCache, userScope })
      : await fetchDeadlineTaskEstimate({ token, teamId, taskUrl: url, todayByTask, now, taskCache });
    out.push(est);
  }
  return out;
}

// Accumulate a "weekly" summary across Mon→Fri of the current week. Unlike the
// old version (which only counted the by-URL configured tasks), this also fetches
// the tasks due EACH weekday (assigned to the user) and sums their whole estimate
// + that day's tracked time, plus the configured task(s)' per-day share. It
// returns BOTH the Mon→today and Mon→Friday aggregates so the popup's ToToday /
// ToFriday toggle flips instantly with no extra network calls.
//
//   today  = { estimateMs, spentMs, fromTs, toTs, count } (Mon → today)
//   friday = { estimateMs, spentMs, fromTs, toTs, count } (Mon → Fri, full week)
export async function fetchWeeklySummary({ token, teamId, userId, taskUrls = [], fromTs, toTs, extendedMode = "days", now = Date.now(), taskCache, assigneeIds }) {
  const MS = 86400000;
  const monday = new Date(fromTs);
  monday.setHours(0, 0, 0, 0);
  const friEnd = new Date(toTs);
  friEnd.setHours(23, 59, 59, 999);

  // Weekday day-starts Mon..Fri.
  const weekdays = [];
  const cur = new Date(monday.getTime());
  while (cur.getTime() <= friEnd.getTime()) {
    if (isWeekday(cur.getTime())) weekdays.push(cur.getTime());
    cur.setDate(cur.getDate() + 1);
  }
  if (!weekdays.length) {
    return { perDay: [], today: null, friday: null, fromTs: monday.getTime(), toTs: friEnd.getTime() };
  }

  // One call for tracked-time across the whole week, bucketed by day → task, and
  // scoped to the requested users (defaults to the signed-in user) so a
  // department/single-user view never counts the whole team's hours.
  const scopeUsers = (Array.isArray(assigneeIds) && assigneeIds.length)
    ? assigneeIds.map(String)
    : (userId != null ? [String(userId)] : []);
  let byDayTask = new Map();
  try {
    byDayTask = await fetchTimeEntriesByDayTask(token, teamId, weekdays[0], weekdays[weekdays.length - 1] + (MS - 1), scopeUsers);
  } catch (e) {}

  // Pre-fetch the configured (by-URL) tasks once and compute each one's per-day
  // contribution for every weekday of the current week, stored as a day→share map.
  //
  //   • A task with a genuine multi-day start→due range is an EXTENDED task: its
  //     estimate is spread across the weekdays inside that range.
  //   • A task with NO range (or a same-day range - e.g. ClickUp's rolling daily
  //     recurring occurrence, which only shows today's dates) contributes its
  //     estimate ÷ weekday-count EVERY weekday. That's the daily-extra rule:
  //     a 7h weekly task = 1h24m per weekday (Mon→Fri).
  const weekdayCount = Math.max(weekdays.length, 1);
  const configs = [];
  for (const url of Array.isArray(taskUrls) ? taskUrls : []) {
    const taskId = parseTaskIdFromUrl(url);
    if (!taskId) continue;
    try {
      const task = await getTaskCached(token, taskId, taskCache);
      const byDay = new Map();
      const tStart = Number(task.startDateMs) || 0;
      const tDue = Number(task.dueDateMs) || 0;
      // Scaled = real multi-day start→due range, or single-bound (due-only =>
      // its whole estimate sits on the due date). Equal/same-day dates (a daily
      // recurring occurrence) are NOT scaled → plain weekly ÷ weekday-count.
      const scaled = !!(tStart && tDue && tDue > tStart) || (!!tStart !== !!tDue);
      if (scaled) {
        const excluded = extendedMode === "excl0"
          ? zeroTrackedDaysFromMap(task.id, tStart || tDue, tDue || tStart, byDayTask)
          : [];
        const split = splitEstimateAcrossDays({
          estimateMs: task.estimateMs,
          startDateMs: tStart,
          dueDateMs: tDue,
          mode: extendedMode,
          excludedDays: excluded,
          singleDay: !!tStart !== !!tDue,
        });
        for (const ts of weekdays) {
          const share = split.byDay.get(ts);
          if (share != null) byDay.set(ts, share);
        }
      } else {
        // Daily/recurring task → its weekly estimate spread over the weekdays.
        const share = Math.round(((Number(task.estimateMs) || 0) * 100) / weekdayCount) / 100;
        for (const ts of weekdays) byDay.set(ts, share);
      }
      configs.push({ taskId: task.id, name: task.name || "", url: taskUrlFor(task.id), byDay, done: isTaskDone(task), status: task.status || "", priority: task.priority || "", container: task.container });
    } catch (e) {
      // A bad URL shouldn't sink the whole week; skip it.
    }
  }

  const perDay = [];
  let extraTask = null; // the auto-detected "Extra(s) Task(s)" (by name) - if found
  for (const ts of weekdays) {
    const dayTime = byDayTask.get(ts) || new Map();
    let dayTasks = [];
    try {
      dayTasks = await getTasksDueToday(token, teamId, userId, ts);
    } catch (e) {
      dayTasks = [];
    }
    const dayRows = [];
    const dueIds = new Set();
    let dayEst = 0;
    for (const t of dayTasks) {
      const isExtraName = EXTRA_TASK_NAME_RE.test(t.name || "");
      if (!extraTask && isExtraName) {
        extraTask = {
          id: t.id,
          estimateMs: Number(t.time_estimate) || 0,
          name: t.name || "",
          url: taskUrlFor(t.id),
          startDateMs: Number(t.start_date) || 0,
          dueDateMs: Number(t.due_date) || 0,
        };
      }
      // Any recurring occurrence of "Extra(s) Task(s)" is dropped from the raw
      // due-day rows; the single discovered extra is spread across the week below.
      if (isExtraName) continue;
      dueIds.add(t.id);
      const est = Number(t.time_estimate) || 0;
      const sp = dayTime.get(t.id) || 0;
      dayEst += est;
      dayRows.push({ id: t.id, name: t.name || "(untitled task)", url: taskUrlFor(t.id), estimateMs: est, totalEstimateMs: est, dueDateMs: Number(t.due_date) || null, spentMs: sp, done: isTaskDone(t), status: (t.status && t.status.status) || "", priority: cuPriorityName(t), type: "due", container: taskContainer(t) });
    }
    // Configured tasks active on this day (skip the extra and anything already
    // counted in the due list). The auto-detected "Extra(s) Task(s)" is matched
    // BY NAME and always excluded here - it's rendered exactly once per day by
    // the dedicated block below. (A recurring occurrence can carry a different
    // task id than the configured URL's, so an id compare alone would let it
    // render twice.)
    for (const c of configs) {
      if (EXTRA_TASK_NAME_RE.test(c.name || "")) continue;
      if (dueIds.has(c.taskId)) continue;
      const share = c.byDay.get(ts);
      if (!share) continue;
      const spent = dayTime.get(c.taskId) || 0;
      dayEst += share;
      dayRows.push({ id: c.taskId, name: c.name || "(configured task)", url: c.url || "", estimateMs: share, spentMs: spent, done: c.done, status: c.status || "", priority: c.priority || "", type: "cfg", container: c.container });
    }
    // The day's TOTAL tracked time is every entry bucketed to this day - tracked
    // or manually added, on ANY task (due/config/otherwise) - not just the ones
    // listed above. Summing the full day map captures manual minutes on tasks
    // that aren't in the due/config lists.
    let daySpent = 0;
    for (const v of dayTime.values()) daySpent += v;
    // Tasks tracked this day that have NO start AND NO due date (and weren't
    // listed in the rows above). ClickUp won't surface them in the due/config
    // lists because they have no date bound, so surface them as their own
    // "tracked, no dates" section per day. Their minutes are already in daySpent.
    const surfacedIds = new Set(dueIds);
    for (const c of configs) surfacedIds.add(c.taskId);
    const trackedTasks = [];
    for (const [tid, mv] of dayTime) {
      if (!mv || surfacedIds.has(tid)) continue;
      let tt;
      try { tt = await getTaskCached(token, tid, taskCache); } catch (e) { continue; }
      if (!tt) continue;
      if (Number(tt.startDateMs) || 0) continue;
      if (Number(tt.dueDateMs) || 0) continue;
      if (EXTRA_TASK_NAME_RE.test(tt.name || "")) continue;
      trackedTasks.push({ id: tid, name: tt.name || "(untitled task)", url: tt.url || taskUrlFor(tid), estimateMs: 0, spentMs: mv, done: isTaskDone(tt), status: tt.status || "", priority: tt.priority || "", startDateMs: null, dueDateMs: null, type: "tracked", container: tt.container });
    }
    perDay.push({ ts, estimateMs: dayEst, spentMs: daySpent, tasks: dayRows, trackedTasks });
  }

  // "Extra(s) Task(s)" - rendered exactly ONCE per day, after perDay is complete.
  // Source of the per-day estimate: the local due-day occurrence (best - reflects
  // the current week) or, if no occurrence is due-today, the configured extra's
  // already-computed byDay shares. Both a multi-day span (start ≠ due) and a
  // same-day / no-range occurrence keep their own spread rule. Because extra-named
  // configs were skipped in the per-day loop above, nothing here duplicates.
  const extraCfg = configs.find((c) => EXTRA_TASK_NAME_RE.test(c.name || ""));
  if (extraTask || extraCfg) {
    const exId = extraTask ? extraTask.id : (extraCfg ? extraCfg.taskId : null);
    const exName = extraTask ? (extraTask.name || "(Extra(s) Task(s))") : (extraCfg ? (extraCfg.name || "(Extra(s) Task(s))") : "(Extra(s) Task(s))");
    const exUrl = extraTask ? (extraTask.url || "") : (extraCfg ? (extraCfg.url || "") : "");
    const extraByDay = new Map();
    if (extraTask) {
      const tStart = extraTask.startDateMs || 0;
      const tDue = extraTask.dueDateMs || 0;
      const scaled = !!(tStart && tDue && tDue > tStart) || (!!tStart !== !!tDue);
      if (scaled) {
        const excluded = extendedMode === "excl0"
          ? zeroTrackedDaysFromMap(extraTask.id, tStart || tDue, tDue || tStart, byDayTask)
          : [];
        const split = splitEstimateAcrossDays({
          estimateMs: extraTask.estimateMs,
          startDateMs: tStart,
          dueDateMs: tDue,
          mode: extendedMode,
          excludedDays: excluded,
          singleDay: !!tStart !== !!tDue,
        });
        for (const p of perDay) if (split.byDay.has(p.ts)) extraByDay.set(p.ts, split.byDay.get(p.ts));
      } else {
        const share = Math.round(((extraTask.estimateMs || 0) * 100) / weekdayCount) / 100;
        for (const p of perDay) extraByDay.set(p.ts, share);
      }
    } else if (extraCfg) {
      for (const p of perDay) {
        const share = extraCfg.byDay.get(p.ts);
        if (share != null) extraByDay.set(p.ts, share);
      }
    }
    for (const p of perDay) {
      const share = extraByDay.get(p.ts) || 0;
      const spent = (byDayTask.get(p.ts) && byDayTask.get(p.ts).get(exId)) || 0;
      if (share <= 0 && spent <= 0) continue; // not active this day → skip
      p.estimateMs += share;
      p.tasks.push({ id: exId, name: exName, url: exUrl, estimateMs: share, spentMs: spent, type: "extra" });
    }
  }

  // Safety: whatever the source (a recurring occurrence, a user-configured URL,
  // an auto-discovered one), never surface more than ONE Extra(s) Task(s) row
  // per day. Keep the first; drop any duplicate extra-named rows.
  for (const p of perDay) {
    let seenExtra = false;
    p.tasks = p.tasks.filter((t) => {
      if (!EXTRA_TASK_NAME_RE.test(t.name || "")) return true;
      if (seenExtra) return false;
      seenExtra = true;
      return true;
    });
  }

  // Slice: today's aggregate stops at the current day; friday's is the full week.
  const nowDay = new Date(now);
  nowDay.setHours(0, 0, 0, 0);
  const nowTs = nowDay.getTime();
  const upToNow = perDay.filter((p) => p.ts <= nowTs);
  const sum = (arr) =>
    arr.reduce(
      (a, p) => ({ estimateMs: a.estimateMs + (p.estimateMs || 0), spentMs: a.spentMs + (p.spentMs || 0) }),
      { estimateMs: 0, spentMs: 0 }
    );
  const t = upToNow.length ? upToNow : [perDay[0]];
  const tg = sum(t);
  const fg = sum(perDay);
  const todayTs = t[t.length - 1].ts;
  const fridayTs = perDay[perDay.length - 1].ts;

  return {
    perDay,
    today: { estimateMs: tg.estimateMs, spentMs: tg.spentMs, fromTs: weekdays[0], toTs: todayTs + (MS - 1), count: t.length },
    friday: { estimateMs: fg.estimateMs, spentMs: fg.spentMs, fromTs: weekdays[0], toTs: fridayTs + (MS - 1), count: perDay.length },
    fromTs: weekdays[0],
    toTs: friEnd.getTime(),
  };
}

// The headline number. Sums time_estimate (and time_spent, for context) across
// today's tasks, and reports whether the estimate has reached `targetHours`.
//
// When deadlineTaskUrls is provided, each deadline task's estimate is fetched
// separately and divided by 5 for weekdays, then added to the total.
//
// NOTE on multi-assignee tasks: if the workspace uses *per-assignee* time
// estimates, the filtered-task endpoint returns the task's ROLLED-UP estimate
// (all assignees), not just this user's slice. For solo-assigned tasks (the
// common case for "due today, assigned to me") this is exact.
export async function fetchTodayEstimate({ token, teamId, userId, targetHours = 7, deadlineTaskUrls = [], now = Date.now(), extendedMode = "days", taskCache }) {
  const rawTasks = await getTasksDueToday(token, teamId, userId, now);
  // Fetch today's tracked time per task ONCE (time entries API), so both the
  // regular tasks and the deadline tasks report time tracked today - not the
  // cumulative time_spent field (which includes previous days). Scoped to the
  // signed-in user so only their own tracked minutes count.
  const userScope = userId != null ? [String(userId)] : [];
  let todayByTask = new Map();
  try {
    todayByTask = await fetchTodayTimeEntriesByTask(token, teamId, now, userScope);
    // Fold in the live running timer so tracked time reflects an in-progress
    // timer instead of showing 0 until it's paused. Personal-token scope only.
    await addRunningTimerToTodayMap(token, teamId, todayByTask, now);
  } catch (e) {
    // If the time-entries endpoint fails, fall back to cumulative time_spent.
  }

  let estimateMs = 0;
  let spentMs = 0;
  const tasks = [];
  for (const t of rawTasks) {
    // A due-today occurrence of the daily "Extra(s) Task(s)" carries the WEEKLY
    // estimate in the API - count estimate ÷ 5 (weekdays) so the day matches the
    // daily-extra rule, same as the ÷5 configured group below. Any task with a
    // real multi-day span (start ≠ due) or a due-only bound contributes its
    // per-day share instead (estimate ÷ working days of the span).
    const isExtra = EXTRA_TASK_NAME_RE.test(t.name || "");
    const tStart = Number(t.start_date) || 0;
    const tDue = Number(t.due_date) || 0;
    const hasBound = !!(tStart || tDue);
    const scaled = hasBound && (!!(tStart && tDue && tDue > tStart) || (!!tStart !== !!tDue));
    let est;
    if (scaled) {
      let spanMap = null;
      if (extendedMode === "excl0") {
        try { spanMap = await fetchTimeEntriesByDayTask(token, teamId, tStart || tDue, tDue || tStart, userScope); } catch (e) {}
      }
      const excluded = extendedMode === "excl0"
        ? zeroTrackedDaysFromMap(t.id, tStart || tDue, tDue || tStart, spanMap || new Map())
        : [];
      const split = splitEstimateAcrossDays({
        estimateMs: Number(t.time_estimate) || 0,
        startDateMs: tStart,
        dueDateMs: tDue,
        mode: extendedMode,
        excludedDays: excluded,
        singleDay: !!tStart !== !!tDue,
      });
      est = split.byDay.get(new Date(now).setHours(0, 0, 0, 0)) || 0;
    } else if (isExtra) {
      est = Math.round(((Number(t.time_estimate) || 0) * 100) / 5) / 100;
    } else {
      est = Number(t.time_estimate) || 0;
    }
    const spent = todayByTask.size ? (todayByTask.get(t.id) || 0) : (Number(t.time_spent) || 0);
    estimateMs += est;
    spentMs += spent;
    tasks.push({
      id: t.id,
      name: t.name || "(untitled task)",
      estimateMs: est,
      totalEstimateMs: Number(t.time_estimate) || 0, // full task estimate (est may be today's share)
      startDateMs: tStart || null,
      dueDateMs: tDue || null,
      spentMs: spent,
      spentToday: todayByTask.size > 0,
      status: (t.status && t.status.status) || "",
      priority: cuPriorityName(t),
      done: isTaskDone(t),
      hasEstimate: est > 0,
      container: taskContainer(t),
      url: taskUrlFor(t.id),
    });
  }

  // Subtasks of due-today parents. ClickUp's due-date filter never returns a
  // subtask that carries no due date of its own (the common case), so a parent's
  // breakdown work is invisible in the Today view. Pull each parent's subtasks
  // explicitly and fold them in RIGHT AFTER their parent: they count toward the
  // day's estimate + tracked total and render as indented rows. Scoped to
  // subtasks assigned to the user (or unassigned) so someone else's subtask can't
  // inflate the day. `seenIds` also blocks re-listing a subtask that is itself
  // due today (already a parent row) and, later, tracked-not-due-today dupes.
  const seenIds = new Set(tasks.map((t) => String(t.id)));
  const originalParentIds = tasks.map((t) => t.id);
  const todayFloorMs = new Date(now).setHours(0, 0, 0, 0);
  for (const parentId of originalParentIds) {
    let subs = [];
    try { subs = await getSubtasksOfParent(token, teamId, parentId, userId); } catch (e) { subs = []; }
    if (!subs.length) continue;
    const subRows = [];
    for (const s of subs) {
      if (seenIds.has(String(s.id))) continue;
      const sStart = Number(s.start_date) || 0;
      const sDue = Number(s.due_date) || 0;
      // A subtask that carries its OWN due date must obey it - only surface it in
      // the "due today" view when that due date actually falls today. ONLY
      // subtasks with NO due date of their own inherit the parent's due-today
      // slot (the common breakdown case, where only the parent is dated). Do NOT
      // mark a skipped subtask "seen" - if it was tracked today it still belongs
      // in the "Tracked · not due today" section built later.
      if (sDue && new Date(sDue).setHours(0, 0, 0, 0) !== todayFloorMs) continue;
      seenIds.add(String(s.id));
      const sScaled = !!(sStart && sDue && sDue > sStart) || (!!sStart !== !!sDue);
      let sEst;
      if (sScaled) {
        const split = splitEstimateAcrossDays({
          estimateMs: Number(s.time_estimate) || 0,
          startDateMs: sStart,
          dueDateMs: sDue,
          mode: extendedMode,
          singleDay: !!sStart !== !!sDue,
        });
        sEst = split.byDay.get(new Date(now).setHours(0, 0, 0, 0)) || 0;
      } else {
        // Subtasks normally have no dates - their full estimate counts today.
        sEst = Number(s.time_estimate) || 0;
      }
      const sSpent = todayByTask.size ? (todayByTask.get(s.id) || 0) : (Number(s.time_spent) || 0);
      estimateMs += sEst;
      spentMs += sSpent;
      subRows.push({
        id: s.id,
        name: s.name || "(untitled subtask)",
        estimateMs: sEst,
        totalEstimateMs: Number(s.time_estimate) || 0,
        spentMs: sSpent,
        spentToday: todayByTask.size > 0,
        status: (s.status && s.status.status) || "",
        priority: cuPriorityName(s),
        done: isTaskDone(s),
        hasEstimate: sEst > 0,
        container: taskContainer(s),
        url: taskUrlFor(s.id),
        isSubtask: true,
        parentId: parentId,
        dueDateMs: sDue || null,
      });
    }
    if (subRows.length) {
      // Insert right after the parent so the list reads parent -> its subtasks.
      // findIndex re-locates the parent as earlier inserts shift the array; we
      // only iterate the ORIGINAL parents, so we never recurse into sub-subtasks.
      const at = tasks.findIndex((t) => t.id === parentId);
      tasks.splice(at + 1, 0, ...subRows);
    }
  }

  // Fetch the configured (deadline / extended / extra) tasks and add their
  // per-day estimate to the daily total. These are fetched BY URL and may be a
  // mix of weekly-÷5 tasks and extended multi-day tasks (divided by day count,
  // or by tracked days only when extendedMode === "excl0").
  const deadlineTasks = [];
  let deadlineEstimateMs = 0;
  let deadlineSpentMs = 0;
  if (Array.isArray(deadlineTaskUrls) && deadlineTaskUrls.length) {
    const configured = await fetchConfiguredTasks({ token, teamId, taskUrls: deadlineTaskUrls, todayByTask, now, extendedMode, taskCache, userScope });
    for (const dt of configured) {
      if (dt.error) {
        deadlineTasks.push({ error: dt.error, taskUrl: dt.taskUrl });
        continue;
      }
      // Only count if this task isn't already in the "due today" list (avoid double-counting).
      const alreadyCounted = tasks.some((t) => t.id === dt.taskId);
      if (!alreadyCounted) {
        estimateMs += dt.dayEstimateMs;
        spentMs += dt.spentMs;
        deadlineTasks.push({
          id: dt.taskId,
          name: dt.name,
          totalEstimateMs: dt.totalEstimateMs,
          dayEstimateMs: dt.dayEstimateMs,
          divisor: dt.divisor,
          totalDays: dt.totalDays,
          skippedDays: dt.skippedDays,
          spentMs: dt.spentMs,
          spentToday: true,
          isWeekday: dt.isWeekday,
          hasEstimate: dt.hasEstimate,
          url: dt.url,
          status: dt.status,
          priority: dt.priority || "",
          done: !!dt.done,
          startDateMs: dt.startDateMs,
          dueDateMs: dt.dueDateMs,
          fromDates: dt.startDateMs && dt.dueDateMs,
          container: dt.container,
        });
        deadlineEstimateMs += dt.dayEstimateMs;
        deadlineSpentMs += dt.spentMs;
      }
    }
  }

  // Time tracked TODAY on tasks that are NOT due today (and aren't a configured
  // deadline task) - e.g. a task due yesterday that you logged time on today.
  // Those minutes are already in `todayByTask` but no due-today row consumed
  // them, so they'd silently vanish from the Today view. Surface them as their
  // own "Tracked · not due today" section and fold the minutes into the tracked
  // total. The estimate is deliberately untouched (estimateMs: 0) - the due-today
  // estimate is correct as-is; this only recovers otherwise-lost tracked time.
  for (const dt of deadlineTasks) if (dt && dt.id) seenIds.add(String(dt.id));
  const trackedTasks = [];
  if (todayByTask.size) {
    for (const [tid, ms] of todayByTask) {
      if (!(Number(ms) > 0)) continue;
      if (seenIds.has(String(tid))) continue;
      seenIds.add(String(tid));
      let t;
      try { t = await getTaskCached(token, tid, taskCache); } catch (e) { continue; }
      if (!t) continue;
      spentMs += Number(ms) || 0;
      trackedTasks.push({
        id: tid,
        name: t.name || "(untitled task)",
        url: t.url || taskUrlFor(tid),
        estimateMs: 0,
        spentMs: Number(ms) || 0,
        spentToday: true,
        done: isTaskDone(t),
        status: t.status || "",
        priority: t.priority || "",
        hasEstimate: false,
        container: t.container,
        startDateMs: t.startDateMs || null,
        dueDateMs: t.dueDateMs || null,
        type: "tracked",
      });
    }
  }

  const targetMs = Math.max(0, Number(targetHours) || 0) * MS_PER_HOUR;
  return {
    estimateMs,
    spentMs,
    targetMs,
    targetHours: Number(targetHours) || 0,
    taskCount: tasks.length,
    noEstimateCount: tasks.filter((t) => !t.hasEstimate).length,
    targetMet: targetMs > 0 && estimateMs >= targetMs,
    tasks,
    deadlineTasks,
    trackedTasks,
    deadlineEstimateMs,
    deadlineSpentMs,
    at: now,
  };
}

// ---------- date-range filtering (Filter Tasks card) ----------
// Fetch tasks due within an arbitrary [fromTs, toTs] date range (inclusive) and
// sum their estimates + tracked time within that window. Used by the popup's
// "Filter Tasks" card for Today / This Week / Custom date views.
export async function fetchDateRangeEstimate({ token, teamId, userId, fromTs, toTs, deadlineTaskUrls = [], extendedMode = "days", taskCache, assigneeIds, adminToken }) {
  const MS = 86400000;
  const start = new Date(fromTs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(toTs);
  end.setHours(23, 59, 59, 999);

  // Who is in scope: the requested users (department / single member / all), else
  // the signed-in user. Used BOTH to filter the task queries AND to scope the
  // tracked-time map, so a "Dept ▸ one user" view only counts that user's hours.
  const scope = (Array.isArray(assigneeIds) && assigneeIds.length)
    ? assigneeIds.map(String)
    : (userId != null ? [String(userId)] : []);

  // Tracked time WITHIN the range (one call), bucketed day→task then summed to
  // task. This replaces the tasks' cumulative time_spent so "Today" in the Filter
  // card matches the daily view instead of showing all-time totals.
  const rangeByTask = new Map();
  let rangeByDay = new Map();
  try {
    rangeByDay = await fetchTimeEntriesByDayTask(token, teamId, start.getTime(), end.getTime(), scope, adminToken);
    for (const dayMap of rangeByDay.values()) {
      for (const [tid, ms] of dayMap) rangeByTask.set(tid, (rangeByTask.get(tid) || 0) + ms);
    }
  } catch (e) {}

  // Live running timer: ClickUp's list endpoint reports the still-open entry with
  // a non-positive duration, so it's excluded above and the day would read 0m
  // until the user pauses once. Fold the live segment (now - start, clamped to
  // today) into today's bucket so a running timer counts immediately. Only for
  // the signed-in user (the personal token reads THEIR current timer) and only
  // when the range actually includes today.
  const nowTs = Date.now();
  const includesToday = nowTs >= start.getTime() && nowTs <= end.getTime();
  const selfInScope = userId != null && (!scope.length || scope.includes(String(userId)));
  if (includesToday && selfInScope) {
    try {
      const running = await getCurrentTimeEntry(token, teamId);
      if (running && running.taskId && running.startMs) {
        const { start: todayStart } = localDayBounds(nowTs);
        const liveFrom = Math.max(running.startMs, todayStart);
        const liveMs = Math.max(0, nowTs - liveFrom);
        if (liveMs > 0) {
          rangeByTask.set(running.taskId, (rangeByTask.get(running.taskId) || 0) + liveMs);
          if (!rangeByDay.has(todayStart)) rangeByDay.set(todayStart, new Map());
          const dm = rangeByDay.get(todayStart);
          dm.set(running.taskId, (dm.get(running.taskId) || 0) + liveMs);
        }
      }
    } catch (e) {}
  }

  // 1) Tasks assigned to the scope that are DUE in range. Because ClickUp's task
  //    endpoint has no start-date filter, extended (multi-day) tasks whose span
  //    crosses the range but whose DUE lands AFTER it must also be surfaced: we
  //    pull a bounded "due just after the range" window (HORIZON_DAYS) and then
  //    keep only tasks whose working-day span actually overlaps the range. This
  //    is what makes a Mon→Tue task show on BOTH Monday and Tuesday with the
  //    estimate divided per day.
  const collected = new Set();
  const out = [];
  const collectTasks = async (params) => {
    for (let page = 0; page < MAX_PAGES; page++) {
      const p = params.concat([["page", String(page)]]);
      const j = await cuFetch(token, "/team/" + teamId + "/task", p);
      const tasks = Array.isArray(j && j.tasks) ? j.tasks : [];
      for (const t of tasks) {
        if (!t || t.id == null || collected.has(t.id)) continue;
        collected.add(t.id);
        out.push(t);
      }
      if (tasks.length < 100 || j.last_page === true) break;
    }
  };
  const baseParams = [["subtasks", "true"], ["include_closed", "true"]];
  for (const a of scope) baseParams.push(["assignees[]", a]);
  const HORIZON_DAYS = 14;
  await collectTasks(baseParams.concat([
    ["due_date_gt", String(start.getTime() - 1)],
    ["due_date_lt", String(end.getTime() + 1)],
  ]));
  await collectTasks(baseParams.concat([
    ["due_date_gt", String(end.getTime() + 1)],
    ["due_date_lt", String(end.getTime() + HORIZON_DAYS * MS + 1)],
  ]));

  let estimateMs = 0;
  let spentMs = 0;
  const tasks = [];
  const seen = new Set();
  for (const t of out) {
    const tStart = Number(t.start_date) || 0;
    const tDue = Number(t.due_date) || 0;
    const hasBounds = !!(tStart || tDue);
    const isExtra = EXTRA_TASK_NAME_RE.test(t.name || "");
    // "Extra(s) Task(s)" rows are handled by the configured/deadline branch below
    // (the ONE discovered extra per scoped user), so the recurring daily
    // occurrences don't each show up as a full-estimate row here.
    if (isExtra) continue;
    // Extended = genuine multi-day span (start < due) OR a single bound (due-only
    // single-day task). Same-day dates (the daily recurring occurrence) are NOT
    // extended - they keep the weekday ÷5 rule.
    const scaled = hasBounds && ((tStart && tDue && tDue > tStart) || (!!tStart !== !!tDue));
    const rawEst = Number(t.time_estimate) || 0;

    let est = rawEst;
    let divisor = 0;
    let totalDays = 0;
    if (scaled) {
      // Spread across the span's working days; count ONLY the days inside the
      // range so a Mon→Tue task contributes its share on Monday AND Tuesday.
      const excluded = extendedMode === "excl0"
        ? zeroTrackedDaysFromMap(t.id, tStart || tDue, tDue || tStart, rangeByDay)
        : [];
      const split = splitEstimateAcrossDays({
        estimateMs: rawEst,
        startDateMs: tStart,
        dueDateMs: tDue,
        mode: extendedMode,
        excludedDays: excluded,
        singleDay: !!tStart !== !!tDue,
      });
      divisor = split.divisor;
      totalDays = split.totalDays;
      const winStart = start.getTime();
      const winEnd = end.getTime();
      est = 0;
      for (const [ts, share] of split.byDay) {
        const dayStart = new Date(ts).setHours(0, 0, 0, 0);
        if (dayStart >= winStart && dayStart <= winEnd) est += share;
      }
    }
    // Tasks pulled only by the after-range window must actually be active in the
    // range (a future single-day task acts on its own due day, which is outside).
    if (tDue > end.getTime() && (!scaled || est <= 0)) continue;

    const spent = rangeByTask.get(t.id) || 0;
    // The range-scoped time map is authoritative per-day tracked for the scope.
    // When it's empty for a department/single-user scope (token can't read that
    // user's entries), we show 0m - never a misleading cumulative÷span estimate.
    let spentRow = spent;
    estimateMs += est;
    spentMs += spentRow;
    seen.add(t.id);
    tasks.push({
      id: t.id,
      name: t.name || "(untitled task)",
      estimateMs: est,
      totalEstimateMs: Number(t.time_estimate) || 0,
      spentMs: spentRow,
      spentToday: false,
      status: (t.status && t.status.status) || "",
      priority: cuPriorityName(t),
      done: isTaskDone(t),
      hasEstimate: est > 0,
      startDateMs: tStart || null,
      dueDateMs: tDue || null,
      extended: !!scaled,
      divisor,
      totalDays,
      container: taskContainer(t),
      url: taskUrlFor(t.id),
    });
  }

  // 2) Configured (by-URL) tasks - include their per-day estimate for EACH
  //    weekday in the range, accumulated. This covers "Extra(s) Task(s)" and
  //    any extended multi-day tasks.
  const deadlineTasks = [];
  if (Array.isArray(deadlineTaskUrls) && deadlineTaskUrls.length) {
    let day = new Date(start.getTime());
    const weekdaySet = new Set();
    while (day.getTime() <= end.getTime()) {
      if (isWeekday(day.getTime())) weekdaySet.add(day.getTime());
      day.setDate(day.getDate() + 1);
    }
    for (const url of deadlineTaskUrls) {
      const taskId = parseTaskIdFromUrl(url);
      if (!taskId) continue;
      let task;
      try { task = await getTaskCached(token, taskId, taskCache); } catch (e) { continue; }
      if (!task) continue;
      if (seen.has(task.id)) continue; // already counted as a range task
      const cStart = Number(task.startDateMs) || 0;
      const cDue = Number(task.dueDateMs) || 0;
      // Multi-day span, or single-bound (due-only → single day) → spread by the
      // span's working days; same-day / no-range → plain weekly ÷5 deadline.
      const scaled = !!(cStart && cDue && cDue > cStart) || (!!cStart !== !!cDue);
      let dayEst = 0;
      if (weekdaySet.size) {
        for (const ts of weekdaySet) {
          const r = scaled
            ? await fetchExtendedTaskEstimate({ token, teamId, taskUrl: url, todayByTask: null, byDayTracked: rangeByDay, now: ts, mode: extendedMode, taskCache })
            : await fetchDeadlineTaskEstimate({ token, teamId, taskUrl: url, todayByTask: null, now: ts, taskCache });
          if (r && !r.error) dayEst += r.dayEstimateMs || 0;
        }
      }
      if (dayEst > 0) {
        estimateMs += dayEst;
        const dSpent = rangeByTask.get(task.id) || 0; // range-scoped, not cumulative
        const dSpentRow = dSpent; // empty scope → 0m, never a misleading cumulative
        spentMs += dSpentRow;
        deadlineTasks.push({
          id: task.id,
          name: task.name,
          totalEstimateMs: task.estimateMs,
          dayEstimateMs: dayEst, // accumulated across the range
          accumulated: true,
          spentMs: dSpentRow,
          spentToday: false,
          isWeekday: true,
          hasEstimate: task.hasEstimate,
          url: task.url,
          status: task.status,
          priority: task.priority || "",
          done: isTaskDone(task),
          startDateMs: task.startDateMs,
          dueDateMs: task.dueDateMs,
          container: task.container,
        });
      }
    }
  }

  // Tasks that received tracked time within this range but weren't surfaced in
  // `tasks`/`deadlineTasks` above - including tasks whose due date falls OUTSIDE
  // the range (e.g. worked today but due yesterday). Their minutes are already in
  // the range total below; this makes the list match the total so no tracked time
  // goes unexplained. (Previously limited to no-date tasks, which hid worked-but-
  // not-in-range tasks - the exact "tracked, not due today" gap in the Today case.)
  for (const dt of deadlineTasks) if (dt.id) seen.add(dt.id);
  const trackedTasks = [];
  for (const [tid, ms] of rangeByTask) {
    if (!ms) continue;
    if (seen.has(tid)) continue;
    let t;
    try { t = await getTaskCached(token, tid, taskCache); } catch (e) { continue; }
    if (!t) continue;
    trackedTasks.push({
      id: tid,
      name: t.name || "(untitled task)",
      url: t.url || taskUrlFor(tid),
      estimateMs: 0,
      spentMs: ms,
      done: isTaskDone(t),
      status: t.status || "",
      priority: t.priority || "",
      container: t.container,
      startDateMs: t.startDateMs || null,
      dueDateMs: t.dueDateMs || null,
      type: "tracked",
    });
  }

  // The day/range's TOTAL tracked time = every entry within the range for the
  // scope - tracked or manually added, on ANY task - not just the ones surfaced
  // in `tasks`/`deadlineTasks` above. Summing the full range map is what makes a
  // manually added minute on a task that isn't in today's due list still count.
  let rangeTotalSpent = 0;
  for (const v of rangeByTask.values()) rangeTotalSpent += v;
  spentMs = rangeTotalSpent;

  return {
    estimateMs,
    spentMs,
    fromTs: start.getTime(),
    toTs: end.getTime(),
    tasks,
    deadlineTasks,
    trackedTasks,
    taskCount: tasks.length,
    noEstimateCount: tasks.filter((t) => !t.hasEstimate).length,
  };
}

// ---------- formatting helper (shared by popup + options) ----------
// 9000000 -> "2h 30m", 0 -> "0m". Kept here so both UIs format identically.
export function fmtDuration(ms) {
  const totalMin = Math.round((Number(ms) || 0) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return h + "h " + m + "m";
  if (h > 0) return h + "h";
  return m + "m";
}
