// The comment posted on every task in a bulk change, written the way the owner
// asked for it: the change first, then why - "Due date is changed due to ...".
// With no reason typed it still says WHAT changed, just not why. `by` is only
// passed when the batch is on SOMEBODY ELSE's tasks, so the comment says who
// moved their work instead of leaving them to guess. Pure, so the wording is
// pinned down by dev-tools/t_bulk_tag.js rather than by eye.
function bulkCommentText(change, why, by) {
  const c = change || {};
  const r = String(why || "").replace(/\s+/g, " ").trim().slice(0, 800);
  const tail = r ? " because " + r : ".";
  const who = String(by || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const pre = who ? "Bulk edit by " + who + " - " : "";
  const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const dur = (ms) => { const m = Math.round((Number(ms) || 0) / 60000), h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
  if (c.kind === "due" || c.kind === "start") {
    const what = c.kind === "due" ? "Due date" : "Start date";
    if (c.mode === "clear") return pre + what + " removed" + tail;
    if (c.mode === "shift") {
      const d = Math.round(Number(c.days) || 0);
      return pre + what + " moved " + Math.abs(d) + " day" + (Math.abs(d) === 1 ? "" : "s") + (d > 0 ? " later" : " earlier") + tail;
    }
    return pre + what + " changed to " + day(c.dayMs) + tail;
  }
  if (c.kind === "status") return pre + "Status changed to \u201c" + c.value + "\u201d" + tail;
  if (c.kind === "priority") return pre + "Priority changed to " + (c.value === "none" ? "none" : c.value) + tail;
  if (c.kind === "estimate") return pre + "Estimate changed to " + dur(c.ms) + tail;
  if (c.kind === "restore") return pre + "Bulk change undone - previous values restored" + tail;
  return pre + "Updated in a bulk edit" + tail;
}

// Which of the loaded rows the filters let through. PURE and top-level so the
// rules are pinned down by dev-tools instead of trusted, because the one that
// keeps getting misread is `missing`: it is OFF unless a kind was actually
// chosen, so "show me the overdue ones" shows every overdue task whether or not
// it happens to be missing an estimate or a start date. "Missing" narrows the
// list on purpose and only when you ask for it.
const MISSING_KINDS = { due: 1, start: 1, est: 1 };
// Client + status + search: the filters that have always been on. Split out so
// bkRowPasses() is the one place that decides a row is IN, and the missing
// filter is visibly the last thing applied to something already accepted.
function bkRowBasePasses(t, o) {
  if (o.client && String((t.client || (t.container && t.container.listName)) || "").trim() !== o.client) return false;
  if (o.status === "open" && bkRowIsDone(t)) return false;
  if (o.status && o.status !== "open" && String(t.status || "").trim() !== o.status) return false;
  const q = String(o.q || "");
  if (q && !(String(t.name || "").toLowerCase().indexOf(q) >= 0 || String((t.client || (t.container && t.container.listName)) || "").trim().toLowerCase().indexOf(q) >= 0)) return false;
  return true;
}
function bkRowPasses(t, f) {
  if (!t) return false;
  const o = f || {};
  if (!bkRowBasePasses(t, o)) return false;
  // Then the missing filter, and only if it is a kind we know: a missing filter
  // narrows, so a value we do not understand must never empty the list.
  const miss = MISSING_KINDS[o.missing] ? o.missing : "";
  if (miss === "due" && t.dueDateMs) return false;
  if (miss === "start" && t.startDateMs) return false;
  if (miss === "est" && Number(t.estimateMs) > 0) return false;
  return true;
}
function bkRowIsDone(t) {
  return !!(t && (t.done || /^(closed|done|complete|completed|resolved|shipped|approved)$/i.test(String(t.status || "").trim())));
}
// How well does a person match what was typed? 0 = exact, 1 = starts with it,
// 2 = a surname or later word does, 3 = it appears mid-name, 4 = the email does,
// -1 = no match. PURE and top-level so the ranking is pinned down by dev-tools:
// "no matter how much or whoever name is typed nothing shows up" is a ranking bug
// waiting to happen, and the ranking decides whose name you see first.
function bkWhoMatch(p, q) {
  const s = String(q || "").trim().toLowerCase();
  if (!s) return -1;
  const name = String((p && p.name) || "").toLowerCase();
  const mail = String((p && p.email) || "").toLowerCase();
  if (!name && !mail) return -1;
  if (name === s) return 0;
  if (name.indexOf(s) === 0) return 1;
  if (name.split(/\s+/).some((w) => w.indexOf(s) === 0)) return 2;
  if (name.indexOf(s) >= 0) return 3;
  if (mail.indexOf(s) >= 0) return 4;
  return -1;
}
// Merge a freshly-found list INTO the people we already have, never over them.
// Returns the new `people`. Also top-level and pure, because replacing the list
// with a search result is exactly what made every colleague disappear after one
// lookup: people = findByName(q) reads fine and is a lie, because the other
// four hundred people are still real and still clickable.
function bkMergePeople(current, found, selfId) {
  const map = new Map();
  const me = selfId == null ? "" : String(selfId);
  for (const p of (Array.isArray(current) ? current : [])) {
    if (p && p.id != null && String(p.id) !== me) map.set(String(p.id), p);
  }
  for (const p of (Array.isArray(found) ? found : [])) {
    if (!p || p.id == null) continue;
    const id = String(p.id);
    if (id === me) continue;
    const have = map.get(id);
    // Field by field, so neither side can lose what it alone knows. A whole
    // record "first wins" pins a person to the poorer copy forever: found by
    // name gives a name but no email or role, so no later full re-read would
    // ever fill those in. A whole record "newest wins" is worse - a name-less
    // task-assignee match would blank a good directory entry. An empty or
    // blank field never overwrites a real one, so take whichever side knows it.
    if (!have) { map.set(id, p); continue; }
    const out = Object.assign({}, have);
    for (const k of Object.keys(p)) {
      if (k === "id") continue;
      const v = p[k];
      if (v == null) continue;
      if (typeof v === "string" ? v.trim() : true) out[k] = v;
    }
    map.set(id, out);
  }
  return [...map.values()];
}

// Options > Bulk edit: pick tasks (range / client / status / search), tick the
// ones to change, then change their due date, status, priority or estimate in
// one go. One task at a time through the background (CLICKUP_BULK_ONE, which
// waits out ClickUp's rate limit), a single refresh at the end, and Undo from
// the old values each change reports back. A batch can carry one comment, the
// same line on every task, so the change is explained where the work happens.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  if (!$("bulkCard")) return;
  const send = (msg, ms = 30000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    try { chrome.runtime.sendMessage(msg, (r) => { clearTimeout(t); void chrome.runtime.lastError; resolve(r || null); }); }
    catch (e) { clearTimeout(t); resolve(null); }
  });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtDur = (ms) => { const m = Math.round((Number(ms) || 0) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
  const fmtShort = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  const fmtDay = (ms) => (ms ? new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "no date");
  const isoDay = (ms) => { const d = new Date(ms); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fromIso = (v) => { const [y, m, d] = String(v).split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
  // "Done" and the row filter now live at the top of the file as bkRowIsDone /
  // bkRowPasses, so there is ONE definition of each and the tab and the test can
  // never drift apart.
  const clientOf = (t) => String((t && (t.client || (t.container && t.container.listName))) || "").trim();

  let tasks = [];          // loaded rows
  const picked = new Set(); // ticked task ids
  const results = new Map(); // taskId -> "ok" | "no" | "skip" (+ title)
  let loadSeq = 0;
  let running = false;
  let loadedTag = "";       // tag name of the current view, for the empty-list hint
  // "Whose tasks": empty = me. Set only when the workspace role says this token
  // can reach another person's tasks (or when ClickUp didn't say and we let it
  // answer), so a plain member is never shown a picker that cannot work.
  let myId = "", myName = "", scopeId = "", scopeName = "", canScope = null, scopeChecked = false;
  // Why there is no "Whose tasks" picker, when that's the story to tell. Kept
  // apart from the "you are looking at <person>" warning below, so one never
  // overwrites the other.
  let idleNote = "";
  // The people picker: everyone in the workspace except me, and the search box's
  // state. A <select> stops being usable at a few dozen names and a workspace has
  // hundreds, so it is a search box with a short list of matches under it - and
  // selection is always by CLICKING a name, never by typing one, so a half-typed
  // name can never turn into somebody else's user id.
  let people = [];
  let whoHi = -1; // highlighted row, for arrow keys

  const whoName = (id) => (scopeId && scopeId === myId) ? "your tasks"
    : (scopeName ? scopeName + "'s tasks" : "their tasks");
  const isMine = () => !scopeId || scopeId === myId;

  // Roster: who else is in the workspace, and may I load their tasks? One
  // cached reply (CLICKUP_DEPT_DATA) already powers the Filter card's
  // department picker, so this costs nothing extra. force re-reads it from
  // ClickUp, which is the answer to "somebody I know isn't in the list".
  async function loadScope(force) {
    if (scopeChecked && !force) return;
    // `wait` makes the background finish the rebuild and answer with the NEW list
    // instead of the cache we already saw. Without it the first render can show a
    // partial roster and never learn better - which is how a colleague ends up
    // "missing" from the picker with a working probe sitting right there.
    const res = await send({ type: "CLICKUP_DEPT_DATA", force: !!force, wait: true }, 45000);
    if (res && res.ok) {
      myId = String(res.userId || "");
      myName = String(res.meName || "").trim();
      canScope = res.canScope === true ? true : res.canScope === false ? false : null;
      const others = (Array.isArray(res.members) ? res.members : [])
        .filter((m) => m && m.id != null && String(m.id) !== myId)
        .filter((m) => String(m.name || m.email || "").trim());
      // An EMPTY roster must never wipe the list. A read that found nobody (every
      // source refused, a token problem, a build that failed) used to paint an
      // empty picker over people who were there a moment ago - which reads to the
      // user as "the names disappeared", with no way back. Keep what we know and
      // let the note beside the picker explain the problem instead. bkMergePeople
      // would keep them anyway; the point of the check is to say so out loud.
      const readNothing = !others.length;
      if (readNothing && people.length) idleNote = "Couldn't re-read the member list from ClickUp, so this is the list from last time. Press ↻ to try again.";
      // Merge, not replace, for the same reason as findByName: a refresh must
      // never be the thing that makes a colleague unfindable. Anyone already
      // found by name is kept (ClickUp gave us that id) unless the new roster
      // knows them too, in which case the roster's copy wins because it is the
      // better record.
      people = bkMergePeople(people, others, myId)
        .filter((p) => String(p.name || p.email || "").trim())
        .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
      if (canScope !== false && people.length) {
        $("bkWhoWrap").hidden = false;
        // Rebuild the search results, keeping whoever is already chosen: a
        // re-read must not silently switch the card back to my own tasks.
        if (scopeId && scopeId !== myId && !people.some((p) => String(p.id) === scopeId)) {
          scopeId = ""; // they are not in this roster any more
          scopeName = "";
        }
        if (scopeId) $("bkWhoSearch").value = scopeName;
        // Repaint with what is in the box, not with "". A reload that came back
        // empty keeps the old list, and painting it blank would hide it again.
        renderWho($("bkWhoSearch").value);
      } else if (canScope === false) {
        // A known plain member: say why there is no picker, instead of silently
        // looking like the feature is missing.
        $("bkWhoWrap").hidden = true;
        idleNote = "Your ClickUp role can only change your own tasks. A workspace Owner or Admin token sees other people's tasks too.";
      } else if (res.building) {
        idleNote = "Reading your workspace's user list - come back to this tab in a minute, or press ↻ to try again.";
      }
      // A shorter list than last time means a ClickUp source was refused. Say so
      // next to the picker instead of quietly dropping colleagues.
      if (res.warn) { $("bkWhoWarn").hidden = false; $("bkWhoWarn").textContent = res.warn; }
      else if (!readNothing) { $("bkWhoWarn").hidden = true; $("bkWhoWarn").textContent = ""; }
    }
    scopeChecked = true;
    syncScope();
  }

  // A person ClickUp clearly has, that this roster is missing. We can't invent an
  // id from typed text, but we CAN ask ClickUp: their own tasks name them, and a
  // task's assignee is a real user object. So a search that finds nothing locally
  // goes out as a name, and comes back as people ClickUp vouched for.
  async function findByName(q) {
    const name = String(q || "").trim();
    if (!name) return [];
    const res = await send({ type: "CLICKUP_FIND_USER", name }, 25000);
    if (!res || !res.ok) return [];
    // MERGE, never replace. This was the bug: assigning the search result to
    // `people` meant that typing one name threw away the whole roster, so every
    // other colleague became unfindable and stayed that way until the tab was
    // reloaded. A lookup ADDS people; it never decides who exists.
    const found = (Array.isArray(res.members) ? res.members : [])
      .filter((m) => m && m.id != null && String(m.id) !== myId)
      .filter((m) => String(m.name || m.email || "").trim());
    people = bkMergePeople(people, found, myId);
    return found;
  }

  // Does `q` match this person? PURE and top-level, because the ranking is what
  // decides whose name you see first, and "my colleague vanished from the search"
  // is a bug worth pinning down in a test rather than reasoning about.
  const WHO_MAX = 12;
  function whoMatches(q) {
    if (!String(q || "").trim()) return people;
    const scored = [];
    for (const p of people) {
      const rank = bkWhoMatch(p, q);
      if (rank >= 0) scored.push([rank, p]);
    }
    return scored.sort((a, b) => a[0] - b[0] || String(a[1].name || "").localeCompare(String(b[1].name || ""))).map((x) => x[1]);
  }
  // The "Me" row, always first. Separate because the fallback list below needs it
  // too, and a second copy is how the two drift apart.
  const meRow = () => '<div class="bk-wrow' + (isMine() ? " cur" : "") + '" role="option" aria-selected="' + (isMine() ? "true" : "false") + '" data-id="' + esc(myId) + '" data-name="' + esc(myName || "Me") + '"><span>Me' + (myName ? " (" + esc(myName) + ")" : "") + '</span><span class="bk-wmail">my tasks</span></div>';
  function renderWho(q) {
    const box = $("bkWhoList");
    if (!box) return;
    // Only ever (re)draw a list that is open or about to be (you're in the box).
    // The member list arriving in the background on the first visit used to pop
    // it open by itself, as if something had broken.
    if (box.hidden && document.activeElement !== $("bkWhoSearch")) return;
    const list = whoMatches(q);
    whoHi = -1;
    // Still waiting on ClickUp for this very name? Then a miss is not a miss yet,
    // and saying "nothing matches" would report an answer to a question that has
    // not come back - which is how a working lookup gets written off as broken.
    const waiting = whoPending && String(q || "").trim().toLowerCase().indexOf(whoPending.toLowerCase()) >= 0;
    // Never paint a blank list over a picker that has names. If a search matched
    // nobody but we still KNOW people, say so and show who there is - "the list
    // vanished" is the failure being fixed, and an empty box is that failure
    // wearing a different hat.
    if (!list.length && people.length && !waiting) {
      const shown = people.slice(0, WHO_MAX);
      const who = shown.map((p) => {
        const id = String(p.id);
        const role = p.role === 1 ? "owner" : p.role === 2 ? "admin" : p.role === 4 ? "guest" : "";
        return '<div class="bk-wrow" role="option" aria-selected="false" data-id="' + esc(id) + '" data-name="' + esc(String(p.name || p.email)) + '"><span>' + esc(String(p.name || p.email)) + "</span><span class=\"bk-wmail\">" + esc([p.email, role].filter(Boolean).join(" · ")) + "</span></div>";
      }).join("");
      const tail = people.length > WHO_MAX ? '<div class="bk-wmore">' + (people.length - WHO_MAX) + " more - keep typing to narrow it down</div>" : "";
      const why = '<div class="bk-wnone">Nothing matches "' + esc(String(q || "").trim()) + '". Here is everyone in your workspace - pick one, or keep typing.</div>';
      box.innerHTML = meRow() + who + tail + why;
      box.hidden = false;
      $("bkWhoSearch").setAttribute("aria-expanded", "true");
      return;
    }
    const rows = list.slice(0, WHO_MAX).map((p) => {
      const id = String(p.id);
      const cur = id === scopeId;
      const role = p.role === 1 ? "owner" : p.role === 2 ? "admin" : p.role === 4 ? "guest" : "";
      return '<div class="bk-wrow' + (cur ? " cur" : "") + '" role="option" aria-selected="' + (cur ? "true" : "false") + '" data-id="' + esc(id) + '" data-name="' + esc(String(p.name || p.email)) + '"><span>' + esc(String(p.name || p.email)) + "</span><span class=\"bk-wmail\">" + esc([p.email, role].filter(Boolean).join(" · ")) + "</span></div>";
    });
    const more = list.length > WHO_MAX ? '<div class="bk-wmore">' + (list.length - WHO_MAX) + " more - keep typing to narrow it down</div>" : "";
    // Only claim to be waiting when something IS being asked - otherwise a query
    // nobody has sent comes back as a permanent "no one matches", which is both
    // wrong and unfalsifiable from the user's side.
    const looking = list.length ? "" : (waiting
      ? '<div class="bk-wnone">Asking ClickUp for "' + esc(String(q || "").trim()) + '"...</div>'
      : '<div class="bk-wnone">No one in your workspace matches "' + esc(String(q || "").trim()) + '". Press ↻ to re-read the member list.</div>');
    box.innerHTML = meRow() + rows.join("") + more + looking;
    box.hidden = false;
    $("bkWhoSearch").setAttribute("aria-expanded", "true");
  }
  const closeWho = () => { const box = $("bkWhoList"); if (box) box.hidden = true; whoHi = -1; $("bkWhoSearch").setAttribute("aria-expanded", "false"); };
  // Pick a person by ID from the roster - never from typed text.
  function chooseWho(id, name) {
    const want = String(id == null ? "" : id);
    if (want && want !== myId && !people.some((p) => String(p.id) === want)) return; // not ours: ignore
    const same = scopeId === want;
    scopeId = want === myId ? "" : want;
    scopeName = scopeId ? String(name || "").trim() : "";
    $("bkWhoSearch").value = isMine() ? "" : (scopeName || "");
    closeWho();
    syncScope();
    // Same person's tasks? Nothing to do - and never clear ticks on a no-op.
    if (same) return;
    picked.clear();
    results.clear();
    ask();
  }
  function syncScope() {
    // Being pointed at another person always wins the note: it is the one that
    // stops a change landing on the wrong person's work. On "Me" the note is
    // whatever loadScope had to say (or nothing at all).
    if (isMine()) {
      $("bkScopeNote").hidden = !idleNote;
      if (idleNote) $("bkScopeNote").textContent = idleNote;
    } else {
      $("bkScopeNote").hidden = false;
      $("bkScopeNote").textContent = "You are looking at " + whoName() + ". Changes and comments go to " + (scopeName || "this person") + "'s tasks in ClickUp.";
    }
  }

  // ---------- ranges (week follows Options > "A week runs") ----------
  const WEEK_MODES = { "sun-sat": [0, 7], "mon-sun": [1, 7], "mon-fri": [1, 5], "sun-thu": [0, 5] };
  let weekMode = "sun-sat";
  chrome.storage.local.get("settings").then((g) => { const m = g.settings && g.settings.clickupWeekMode; if (WEEK_MODES[m]) weekMode = m; }).catch(() => {});
  function range(kind) {
    const day0 = new Date(); day0.setHours(0, 0, 0, 0);
    const span = (from, days) => { const e = new Date(from); e.setDate(e.getDate() + days - 1); e.setHours(23, 59, 59, 999); return { fromTs: from.getTime(), toTs: e.getTime() }; };
    if (kind === "today") return span(day0, 1);
    if (kind === "tomorrow") { const d = new Date(day0); d.setDate(d.getDate() + 1); return span(d, 1); }
    if (kind === "week" || kind === "nextweek") {
      const [startDow, len] = WEEK_MODES[weekMode] || WEEK_MODES["sun-sat"];
      const s = new Date(day0); s.setDate(s.getDate() - ((s.getDay() - startDow + 7) % 7));
      if (kind === "nextweek") s.setDate(s.getDate() + 7);
      return span(s, len);
    }
    if (kind === "custom") {
      const f = $("bkFrom").value, t = $("bkTo").value;
      if (!f || !t) return null;
      const a = new Date(fromIso(f)), b = fromIso(t);
      return span(a, Math.max(1, Math.round((b - a.getTime()) / 86400000) + 1));
    }
    return null;
  }

  // ---------- load ----------
  // Nothing is read from ClickUp until "Load tasks" is pressed: picking a range,
  // a person or a tag only says what will load (ClickUp's request allowance is
  // shared by the whole office). Pressing it again with the same choices re-reads.
  let loadedSig = "";
  const sig = () => [$("bkRange").value, scopeId, $("bkFrom").value, $("bkTo").value, $("bkTag").value].join("|");
  async function ask() {
    ++loadSeq;
    const kind = $("bkRange").value;
    $("bkCustom").hidden = kind !== "custom";
    $("bkTagWrap").hidden = kind !== "tag";
    if (kind === "tag" && !tagNames.length) await loadTags(false);
    tasks = [];
    loadedTag = "";
    loadedSig = "";
    $("bkList").innerHTML = '<div class="hint bk-ask" style="padding:14px;">Choose <b>Tasks due</b>' + ($("bkWhoWrap").hidden ? "" : ", <b>Whose tasks</b>") + " and the rest, then press <b>Load tasks</b>. Nothing is read from ClickUp before that.</div>";
    renderCount();
  }
  async function load(force) {
    loadedSig = sig();
    const seq = ++loadSeq;
    const kind = $("bkRange").value;
    await loadScope();
    if (seq !== loadSeq) return;
    syncScope();
    $("bkCustom").hidden = kind !== "custom";
    $("bkTagWrap").hidden = kind !== "tag";
    // "By tag" needs its dropdown before it can ask anything, so read the
    // workspace's tags on the first switch to it (afterwards it's cached, and
    // the ↻ Load button re-reads it).
    if (kind === "tag" && !tagNames.length) { await loadTags(false); if (seq !== loadSeq) return; }
    const list = $("bkList");
    list.innerHTML = '<div class="hint" style="padding:14px;">Loading from ClickUp…</div>';
    let res = null;
    loadedTag = kind === "tag" ? $("bkTag").value.trim() : "";
    if (kind === "overdue") {
      res = await send({ type: "CLICKUP_OVERDUE", assignee: scopeId, force: !!force }, 40000);
    } else if (kind === "any") {
      // Every open task, with or without dates - the only way to find tasks
      // that have no due date at all.
      res = await send({ type: "CLICKUP_OPEN_TASKS", assignee: scopeId, force: !!force }, 60000);
    } else if (kind === "tag") {
      // ClickUp filters by tag name server-side, so this finds the tasks that
      // match even when they are not due in any date window.
      if (!loadedTag) {
        list.innerHTML = '<div class="hint" style="padding:14px;">' + (tagNames.length ? "Pick a tag, then Load." : "Reading your workspace's tags from ClickUp…") + "</div>";
        tasks = [];
        renderCount();
        return;
      }
      res = await send({ type: "CLICKUP_OPEN_TASKS", tag: loadedTag, assignee: scopeId, force: !!force }, 60000);
    } else {
      const r = range(kind);
      if (!r) { list.innerHTML = '<div class="hint" style="padding:14px;">Pick both dates.</div>'; return; }
      for (let i = 0; i < 20; i++) {
        res = await send({ type: "CLICKUP_FILTER", fromTs: r.fromTs, toTs: r.toTs, assigneeIds: scopeId ? [scopeId] : [], force: !!force && i === 0 }, 20000);
        if (seq !== loadSeq) return;
        if (!res || !res.ok || res.data) break;
        await new Promise((z) => setTimeout(z, 2000));
      }
      if (res && res.ok && res.data) {
        const inRange = (t) => { const x = Number(t && t.dueDateMs) || 0; return x >= r.fromTs && x <= r.toTs; };
        res = { ok: true, data: { tasks: (res.data.tasks || []).filter(inRange) } };
      }
    }
    if (seq !== loadSeq) return;
    if (!res || !res.ok || !res.data) {
      const why = res && (res.error || res.reason);
      list.innerHTML = '<div class="hint" style="padding:14px;color:var(--red);">Couldn\'t load tasks' + (why ? " (" + esc(why) + ")" : "") + ". Try ↻ in a minute.</div>";
      tasks = [];
      renderCount();
      return;
    }
    const seen = new Set();
    tasks = (res.data.tasks || []).filter((t) => t && t.id && !seen.has(String(t.id)) && seen.add(String(t.id)));
    tasks.sort((a, b) => (Number(a.dueDateMs) || 0) - (Number(b.dueDateMs) || 0));
    for (const id of [...picked]) if (!tasks.some((t) => String(t.id) === id)) picked.delete(id);
    fillFacets();
    fillTagList();
    render();
  }

  // The tag dropdown: every tag in the workspace, straight from ClickUp, so the
  // name sent to ClickUp is always spelled the way ClickUp spells it. Read once
  // and cached in the background for a day; the tags on the rows we just loaded
  // are merged in too, so a tag in use still shows even if the workspace list was
  // refused, and the chosen one always stays.
  let tagNames = [];
  function fillTagList() {
    const sel = $("bkTag");
    if (!sel) return;
    const names = new Set(tagNames);
    for (const t of tasks) for (const g of (Array.isArray(t.tags) ? t.tags : [])) { const s = String(g || "").trim(); if (s) names.add(s); }
    const cur = sel.value;
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    sel.innerHTML = '<option value="">Any tag</option>' + sorted.map((n) => '<option value="' + esc(n) + '">' + esc(n) + "</option>").join("");
    if (cur && sorted.indexOf(cur) >= 0) sel.value = cur;
    sel.disabled = sorted.length === 0;
    if (!sorted.length) sel.innerHTML = '<option value="">No tags found</option>';
  }
  async function loadTags(force) {
    const res = await send({ type: "CLICKUP_TAG_LIST", force: !!force }, 20000);
    if (res && res.ok && Array.isArray(res.tags)) {
      tagNames = res.tags.map((t) => String(t || "").trim()).filter(Boolean);
    }
    fillTagList();
  }

  function fillFacets() {
    const keep = (sel, values, first) => {
      const cur = sel.value;
      sel.innerHTML = first + values.map((v) => '<option value="' + esc(v) + '">' + esc(v) + "</option>").join("");
      if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
    };
    keep($("bkClient"), [...new Set(tasks.map(clientOf).filter(Boolean))].sort((a, b) => a.localeCompare(b)), '<option value="">All clients</option>');
    const statuses = [...new Set(tasks.map((t) => String(t.status || "").trim()).filter(Boolean))].sort();
    keep($("bkStatus"), statuses, '<option value="open">All not done</option><option value="">Any status</option>');
    const common = ["to do", "in progress", "complete"];
    const all = [...new Set([...statuses.map((s) => s.toLowerCase()), ...common])];
    keep($("bkStatusVal"), all, "");
    // Missing keeps whatever was chosen (it is never rebuilt here), but the
    // "off" look has to be re-applied: a load can change the row set under it.
    paintMissing();
  }

  function shown() {
    const client = $("bkClient").value, status = $("bkStatus").value, q = $("bkSearch").value.trim().toLowerCase();
    // The checkbox IS the filter. Unticked there is no "anything" value to
    // misread and no dropdown that looks active: the kind below is simply
    // disabled and filters nothing until it is asked for.
    const missing = $("bkMissingOn").checked ? $("bkMissing").value : "";
    const f = { client, status, q, missing };
    return tasks.filter((t) => bkRowPasses(t, f));
  }
  // Untick = off, and the dropdown is visibly dead rather than quietly active.
  function paintMissing() {
    const on = $("bkMissingOn").checked;
    const sel = $("bkMissing");
    sel.disabled = !on;
    sel.classList.toggle("off", !on);
    sel.title = on
      ? "Only tasks with no " + ({ due: "due date", start: "start date", est: "estimate" }[sel.value] || "value") + "."
      : "Off: every task in this range is listed. Tick 'Filter missing' to hide the ones that do have it.";
    $("bkMissingOn").title = on
      ? "On: the list keeps only tasks missing the thing below."
      : "Off: every task in this range is listed, missing things or not.";
  }

  function render() {
    const rows = shown();
    const list = $("bkList");
    if (!rows.length) {
      const why = tasks.length ? "No tasks match these filters."
        : (loadedTag ? "No open tasks tagged \u201c" + esc(loadedTag) + "\u201d" + (isMine() ? "." : " for " + esc(whoName()) + ".") + (isMine() ? " Pick another tag from the list." : " They may not have tagged any open task with it.")
          : isMine() ? "No tasks in this range."
            : "Nothing here for " + esc(whoName()) + " - your ClickUp role may not be able to see their tasks.");
      list.innerHTML = '<div class="hint" style="padding:14px;">' + why + "</div>";
      renderCount();
      return;
    }
    list.innerHTML = rows.map((t) => {
      const id = String(t.id);
      const r = results.get(id);
      const mark = r ? '<span class="res ' + r.kind + '" title="' + esc(r.title || "") + '">' + (r.kind === "ok" ? "✓" : r.kind === "skip" ? "–" : "✗") + "</span>" : '<span class="res"></span>';
      return '<div class="bk-row" data-id="' + esc(id) + '"><input type="checkbox"' + (picked.has(id) ? " checked" : "") + ' aria-label="Select" />' +
        '<a class="nm" href="' + esc(t.url || "https://app.clickup.com/t/" + encodeURIComponent(id)) + '" target="_blank" rel="noopener" title="' + esc(t.name) + '">' + (t.isSubtask ? "↳ " : "") + esc(t.name || "(task)") + "</a>" +
        '<span class="cl" title="' + esc(clientOf(t)) + '">' + esc(clientOf(t)) + "</span>" +
        '<span class="st">' + esc(t.status || "") + (t.priority ? " · " + esc(t.priority) : "") + "</span>" +
        '<span class="du">' +
        '<span class="bk-start' + (t.startDateMs ? "" : " bk-miss") + '" role="button" tabindex="0" title="Start date - click to change">' + (t.startDateMs ? "from " + esc(fmtShort(t.startDateMs)) : "+ start") + "</span>" +
        '<span class="bk-due' + (t.dueDateMs ? "" : " bk-miss") + '" role="button" tabindex="0" title="Due date - click to change">' + (t.dueDateMs ? esc(fmtDay(t.dueDateMs)) : "+ due") + "</span>" +
        '<span class="bk-est' + (Number(t.estimateMs) > 0 ? "" : " bk-miss") + '" role="button" tabindex="0" title="Estimate - click to change (e.g. 1h 30m, 45m, 1.5h)">' + (Number(t.estimateMs) > 0 ? esc(fmtDur(t.estimateMs)) : "+ est") + "</span>" +
        "</span>" + mark + "</div>";
    }).join("");
    renderCount();
  }
  function renderCount() {
    const rows = shown();
    const sel = rows.filter((t) => picked.has(String(t.id))).length;
    $("bkCount").textContent = (rows.length ? sel + " of " + rows.length + " selected" : "") + (loadedTag ? " \u00b7 tagged " + loadedTag : "");
    $("bkAll").checked = rows.length > 0 && sel === rows.length;
    $("bkAll").indeterminate = sel > 0 && sel < rows.length;
    const n = [...picked].filter((id) => tasks.some((t) => String(t.id) === id)).length;
    $("bkApply").disabled = running || n === 0;
    $("bkApply").textContent = "Apply to " + n + " task" + (n === 1 ? "" : "s");
  }

  // ---------- the change ----------
  function change() {
    const kind = $("bkKind").value;
    if (kind === "due" || kind === "start") {
      const what = kind === "due" ? "due date" : "start date";
      const mode = $("bkDueMode").value;
      if (mode === "set") {
        if (!$("bkDueDate").value) return { error: "Pick a date." };
        const dayMs = fromIso($("bkDueDate").value);
        return { change: { kind, mode, dayMs }, text: "set the " + what + " of {n} to " + fmtDay(dayMs) };
      }
      if (mode === "shift") {
        const days = Math.round(Number($("bkShift").value));
        if (!Number.isFinite(days) || !days) return { error: "Enter a number of days, like 2 or -1." };
        return { change: { kind, mode, days }, text: "move the " + what + " of {n} " + (days > 0 ? "later" : "earlier") + " by " + Math.abs(days) + " day" + (Math.abs(days) === 1 ? "" : "s") };
      }
      return { change: { kind, mode: "clear" }, text: "remove the " + what + " of {n}" };
    }
    if (kind === "status") {
      const v = $("bkStatusVal").value;
      if (!v) return { error: "Pick a status." };
      return { change: { kind, value: v }, text: "set the status of {n} to “" + v + "”" };
    }
    if (kind === "priority") {
      const v = $("bkPrioVal").value;
      return { change: { kind, value: v }, text: v === "none" ? "remove the priority of {n}" : "set the priority of {n} to " + v };
    }
    const h = Number($("bkEstH").value) || 0, m = Number($("bkEstM").value) || 0;
    if (h < 0 || m < 0 || h + m === 0) return { error: "Enter hours and/or minutes." };
    const ms = (h * 60 + m) * 60000;
    return { change: { kind: "estimate", ms }, text: "set the estimate of {n} to " + fmtDur(ms) };
  }
  function paintKind() {
    const k = $("bkKind").value;
    $("bkDueOpts").hidden = k !== "due" && k !== "start";
    $("bkStatusOpts").hidden = k !== "status";
    $("bkPrioOpts").hidden = k !== "priority";
    $("bkEstOpts").hidden = k !== "estimate";
    const mode = $("bkDueMode").value;
    $("bkDueDate").hidden = mode !== "set";
    $("bkShiftWrap").hidden = mode !== "shift";
  }

  // ---------- the comment ----------
  // Two ways to write it: give a reason and the sentence is built for you (the
  // usual case, and the same sentence for every task in the batch), or open the
  // box and write the line yourself. The preview always shows the exact text.
  const ownMode = () => { const o = $("bkCommentOwn"); return o && !o.hidden; };
  function commentText() {
    if (!$("bkCommentOn").checked) return "";
    if (ownMode()) return $("bkCommentOwn").value.replace(/\s+/g, " ").trim().slice(0, 5000);
    const c = change();
    // On somebody else's tasks the comment carries who did it, so the owner of
    // the task isn't left wondering who moved their work.
    return c.change ? bulkCommentText(c.change, $("bkCommentWhy").value, isMine() ? "" : myName).trim() : "";
  }
  function paintComment() {
    const on = $("bkCommentOn").checked;
    $("bkCommentPreviewRow").hidden = !on;
    $("bkCommentNote").hidden = on;
    $("bkCommentWhy").disabled = !on;
    $("bkCommentEdit").disabled = !on;
    $("bkCommentOwn").disabled = !on;
    if (!on) return;
    const own = $("bkCommentOwn");
    if (ownMode() && own.dataset.auto === "1") own.value = commentText();
    $("bkCommentPreview").textContent = commentText() || "\u2014 pick a change above to see the comment \u2014";
  }
  function toggleCommentEdit() {
    const own = $("bkCommentOwn"), why = $("bkCommentWhy"), btn = $("bkCommentEdit");
    const toOwn = !ownMode();
    own.hidden = !toOwn;
    why.hidden = toOwn;
    btn.textContent = toOwn ? "Use the reason" : "Edit text";
    if (toOwn) { own.value = commentText() || bulkCommentText(change().change || { kind: "due", mode: "set", dayMs: Date.now() }, why.value); own.dataset.auto = "1"; }
    paintComment();
  }

  async function runBatch(items, makeChange, label, comment) {
    running = true;
    renderCount();
    const res = $("bkResult");
    res.hidden = false;
    const undo = [];
    let ok = 0, skip = 0, fail = 0, noComment = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      res.textContent = label + "… " + (i + 1) + " of " + items.length;
      const r = await send({ type: "CLICKUP_BULK_ONE", taskId: it.id, change: makeChange(it), assignee: scopeId, comment: comment || undefined }, 120000);
      if (r && r.ok) {
        ok++;
        // The change is what the owner asked for, so a task whose comment failed
        // still counts as changed - only the tooltip and the summary say so.
        if (r.comment === "no") { noComment++; results.set(it.id, { kind: "ok", title: "changed, but the comment was not added: " + (r.commentError || "unknown reason") }); }
        else results.set(it.id, { kind: "ok" });
        if (r.before) undo.push({ id: it.id, name: it.name, before: r.before });
      } else if (r && r.skipped) { skip++; results.set(it.id, { kind: "skip", title: r.error || "skipped" }); }
      else { fail++; results.set(it.id, { kind: "no", title: (r && (r.error || r.reason)) || "no reply" }); }
      render();
    }
    send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeeks: true }, 60000);
    running = false;
    return { ok, skip, fail, noComment, undo };
  }

  $("bkApply").onclick = () => {
    const c = change();
    const box = $("bkConfirm");
    box.hidden = false;
    if (c.error) { box.innerHTML = '<span style="color:var(--red)">' + esc(c.error) + "</span>"; return; }
    const ids = [...picked].filter((id) => tasks.some((t) => String(t.id) === id));
    const n = ids.length + " task" + (ids.length === 1 ? "" : "s");
    const cmt = commentText();
    // Someone else's work is being changed in bulk, so say whose, out loud,
    // right before it happens - not just in the dropdown.
    const whose = isMine() ? "" : '<br /><b style="color:var(--red)">These belong to ' + esc(scopeName || "another user") + ".</b>";
    box.innerHTML = "<span>This will " + esc(c.text.replace("{n}", n)) + ".</span>" + whose +
      (cmt ? '<br /><span>and comment on ' + (ids.length === 1 ? "it" : "all of them") + ": \u201c" + esc(cmt) + "\u201d</span>" : "");
    const yes = document.createElement("button");
    yes.className = "primary";
    yes.textContent = isMine() ? "Yes, change them" : "Yes, change " + (scopeName || "their") + "'s " + n;
    const no = document.createElement("button"); no.textContent = "Cancel";
    no.onclick = () => { box.hidden = true; };
    yes.onclick = async () => {
      box.hidden = true;
      results.clear();
      const items = ids.map((id) => { const t = tasks.find((x) => String(x.id) === id); return { id, name: (t && t.name) || "" }; });
      const out = await runBatch(items, () => c.change, "Changing", cmt);
      if (out.undo.length) {
        try { await chrome.storage.local.set({ bulkUndo: { at: Date.now(), text: c.text.replace("{n}", n), items: out.undo } }); } catch (e) {}
      }
      showSummary(out, true);
      await load(true);
    };
    box.append(yes, no);
  };

  function showSummary(out, canUndo) {
    const res = $("bkResult");
    res.hidden = false;
    res.innerHTML = "<span>" + out.ok + " changed" + (out.skip ? ", " + out.skip + " skipped" : "") + (out.fail ? ", <b style='color:var(--red)'>" + out.fail + " failed</b> (point at ✗ for why)" : "") + (out.noComment ? ", <b style='color:var(--red)'>" + out.noComment + " comment" + (out.noComment === 1 ? "" : "s") + " not added</b> (point at ✓ for why)" : "") + (isMine() ? "" : " in " + esc(whoName())) + ".</span>";
    if (canUndo && out.undo.length) {
      const u = document.createElement("button");
      u.textContent = "Undo";
      u.title = "Put back the old values of the tasks just changed";
      u.onclick = undoLast;
      res.appendChild(u);
    }
  }
  async function undoLast() {
    let saved = null;
    try { saved = (await chrome.storage.local.get("bulkUndo")).bulkUndo; } catch (e) {}
    if (!saved || !Array.isArray(saved.items) || !saved.items.length) { $("bkResult").textContent = "Nothing to undo."; return; }
    results.clear();
    const out = await runBatch(saved.items, (it) => ({ kind: "restore", before: it.before }), "Undoing");
    try { await chrome.storage.local.remove("bulkUndo"); } catch (e) {}
    $("bkResult").innerHTML = "<span>Undone: " + out.ok + " task" + (out.ok === 1 ? "" : "s") + " put back" + (out.fail ? ", " + out.fail + " couldn't be" : "") + ".</span>";
    await load(true);
  }

  // ---------- wiring ----------
  $("bkList").addEventListener("change", (e) => {
    const row = e.target.closest(".bk-row");
    if (!row || e.target.type !== "checkbox") return;
    if (e.target.checked) picked.add(row.dataset.id); else picked.delete(row.dataset.id);
    renderCount();
  });
  // One task's due date: click its date - the same calendar editor as the
  // dashboard's date chips (options.js startEditDueOpt; keeps the time of day,
  // Clear removes the date). The list redraws once the editor closes.
  const editOne = (chip) => {
    const row = chip.closest(".bk-row");
    const t = row && tasks.find((x) => String(x.id) === row.dataset.id);
    if (!t || running || typeof startEditDueOpt !== "function") return;
    startEditDueOpt(chip, t);
    const wait = setInterval(() => {
      if (chip._editing) return;
      clearInterval(wait);
      setTimeout(render, 600); // let "syncing" show briefly, then the full date
    }, 300);
  };
  // Start date and estimate: a small editor in place of the chip. Saved through
  // the same one-task change as the bulk tools (CLICKUP_BULK_ONE).
  const parseEst = (v) => {
    const s = String(v || "").trim().toLowerCase().replace(",", ".");
    if (!s) return 0;
    let m = 0, hit = false;
    const h = s.match(/(\d+(?:\.\d+)?)\s*h/); if (h) { m += Number(h[1]) * 60; hit = true; }
    const mm = s.match(/(\d+)\s*m/); if (mm) { m += Number(mm[1]); hit = true; }
    if (!hit && /^\d+(\.\d+)?$/.test(s)) m = Number(s) <= 12 && s.includes(".") ? Number(s) * 60 : Number(s); // "1.5" = hours, "45" = minutes
    return Math.round(m) * 60000;
  };
  async function saveOne(t, change, chip) {
    chip.textContent = "saving…";
    const r = await send({ type: "CLICKUP_BULK_ONE", taskId: String(t.id), change, assignee: scopeId }, 90000);
    if (r && r.ok) {
      if (change.kind === "start") t.startDateMs = change.mode === "clear" ? null : new Date(new Date(change.dayMs).setHours(12, 0, 0, 0)).getTime();
      if (change.kind === "estimate") t.estimateMs = change.ms;
      results.set(String(t.id), { kind: "ok" });
      send({ type: "CLICKUP_REFRESH", includeTasks: true, forceWeeks: true }, 60000);
    } else {
      results.set(String(t.id), { kind: "no", title: (r && (r.error || r.reason)) || "no reply" });
    }
    render();
  }
  function editInline(chip) {
    const row = chip.closest(".bk-row");
    const t = row && tasks.find((x) => String(x.id) === row.dataset.id);
    if (!t || running || chip._editing) return;
    chip._editing = true;
    const isStart = chip.classList.contains("bk-start");
    const input = document.createElement("input");
    input.className = "bk-edit";
    if (isStart) {
      input.type = "date";
      if (t.startDateMs) input.value = isoDay(t.startDateMs);
      input.title = "Pick the start date (Clear = no start date). Esc cancels.";
    } else {
      input.type = "text";
      input.placeholder = "e.g. 1h 30m";
      input.value = Number(t.estimateMs) > 0 ? fmtDur(t.estimateMs) : "";
      input.title = "1h 30m, 45m or 1.5h, then Enter. Esc cancels.";
    }
    chip.textContent = "";
    chip.appendChild(input);
    input.focus();
    if (isStart) { try { input.showPicker(); } catch (e) {} }
    let done = false;
    const cancel = () => { if (done) return; done = true; chip._editing = false; render(); };
    const save = () => {
      if (done) return;
      done = true;
      chip._editing = false;
      if (isStart) {
        if (!input.value) { if (t.startDateMs) saveOne(t, { kind: "start", mode: "clear" }, chip); else render(); return; }
        const dayMs = fromIso(input.value);
        if (t.startDateMs && isoDay(t.startDateMs) === input.value) { render(); return; }
        saveOne(t, { kind: "start", mode: "set", dayMs }, chip);
      } else {
        const ms = parseEst(input.value);
        if (ms === (Number(t.estimateMs) || 0)) { render(); return; }
        saveOne(t, { kind: "estimate", ms }, chip);
      }
    };
    let lastKey = 0;
    input.addEventListener("keydown", (e) => {
      lastKey = Date.now();
      if (e.key === "Enter") { e.preventDefault(); save(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    if (isStart) input.addEventListener("change", () => { if (Date.now() - lastKey > 400) save(); });
    input.addEventListener("blur", () => setTimeout(save, 0));
    input.addEventListener("click", (e) => e.stopPropagation());
  }
  $("bkList").addEventListener("click", (e) => {
    const chip = e.target.closest(".bk-due, .bk-start, .bk-est");
    if (!chip || chip._editing || e.target.tagName === "INPUT") return;
    e.preventDefault();
    if (chip.classList.contains("bk-due")) editOne(chip); else editInline(chip);
  });
  $("bkList").addEventListener("keydown", (e) => {
    const chip = e.target.closest && e.target.closest(".bk-due, .bk-start, .bk-est");
    if (!chip || chip._editing || e.target.tagName === "INPUT" || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    if (chip.classList.contains("bk-due")) editOne(chip); else editInline(chip);
  });
  $("bkAll").onchange = () => {
    for (const t of shown()) { if ($("bkAll").checked) picked.add(String(t.id)); else picked.delete(String(t.id)); }
    render();
  };
  // Select none: the safety valve after ticking the wrong rows.
  $("bkNone").onclick = () => { picked.clear(); render(); };
  for (const id of ["bkClient", "bkStatus"]) $(id).onchange = render;
  $("bkMissing").onchange = () => { paintMissing(); render(); };
  $("bkMissingOn").onchange = () => { paintMissing(); render(); };
  $("bkSearch").oninput = render;
  $("bkRange").onchange = () => ask();
  // Switching person loads a different task set, so the ticks go with it -
  // carrying them over would mean changing one person's tasks on another's tick.
  // People picker: type to search, click (or Enter/arrows) to choose. The list
  // closes on Escape or a click anywhere else, and never accepts typed text as
  // an id.
  // Names ClickUp does not have in any list we can read still have to be
  // reachable, so a search that finds nobody here asks ClickUp by name. Typed
  // text is only ever a QUESTION: the id we use comes back from ClickUp, and
  // chooseWho() still refuses anything not in the roster we ended up with.
  let whoAsk = 0;
  // The name ClickUp is being asked about right now, so the list can say "still
  // asking" instead of the far more alarming "nothing matches" for the second or
  // two a lookup takes. "" when nothing is in flight.
  let whoPending = "";
  async function askByName(q) {
    const name = String(q || "").trim();
    if (name.length < 3) return;
    // A plain counter, not AbortController: sendMessage can't be aborted, so we
    // only care that the LAST question asked is the one that gets to paint.
    const ticket = ++whoAsk;
    whoPending = name;
    renderWho(q); // repaint straight away, so the box says "Asking ClickUp for ..."
    const found = await findByName(name); // merges into `people`
    if (ticket !== whoAsk) return; // a newer keystroke already took over
    whoPending = "";
    // Repaint either way. A failed lookup still has to redraw, because the box is
    // still sitting on "Asking ClickUp for ..." and "still asking" is a lie once
    // the answer is in. Re-painting cannot lose anyone: the list is built FROM
    // `people`, which the merge only ever grows.
    renderWho(q);
  }
  let whoTimer = null;
  $("bkWhoSearch").oninput = () => {
    const q = $("bkWhoSearch").value;
    renderWho(q);
    clearTimeout(whoTimer);
    if (String(q).trim().length >= 3) whoTimer = setTimeout(() => askByName(q), 400);
  };
  $("bkWhoSearch").onfocus = () => renderWho($("bkWhoSearch").value);
  $("bkWhoSearch").onkeydown = (e) => {
    const rows = [...document.querySelectorAll("#bkWhoList .bk-wrow")];
    if (e.key === "Escape") { e.preventDefault(); closeWho(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if ($("bkWhoList").hidden) { renderWho($("bkWhoSearch").value); return; }
      whoHi = Math.max(0, Math.min(rows.length - 1, whoHi + (e.key === "ArrowDown" ? 1 : -1)));
      rows.forEach((r, i) => r.classList.toggle("sel", i === whoHi));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[whoHi] || rows[0];
      if (row) chooseWho(row.dataset.id, row.dataset.name);
    }
  };
  $("bkWhoList").onclick = (e) => {
    const row = e.target.closest(".bk-wrow");
    if (row) chooseWho(row.dataset.id, row.dataset.name);
  };
  $("bkWhoReload").onclick = async () => {
    $("bkWhoReload").disabled = true;
    await loadScope(true);
    $("bkWhoReload").disabled = false;
    if (!$("bkWhoWrap").hidden) renderWho($("bkWhoSearch").value);
  };
  document.addEventListener("click", (e) => { if (!$("bkWhoWrap").hidden && !e.target.closest("#bkWhoWrap")) closeWho(); });
  // Tags: pick one and the list loads straight away; Load also re-reads the tag
  // list from ClickUp, for tags added there since this tab was opened.
  $("bkTag").onchange = () => ask();
  $("bkTagGo").onclick = () => { loadTags(true); };
  $("bkFrom").onchange = $("bkTo").onchange = () => ask();
  // Same choices as what's showing = read them again from ClickUp.
  $("bkReload").onclick = () => load(loadedSig === sig());
  paintMissing();
  const repaint = () => { paintKind(); paintComment(); };
  $("bkKind").onchange = repaint;
  $("bkDueMode").onchange = repaint;
  for (const id of ["bkDueDate", "bkShift", "bkEstH", "bkEstM", "bkCommentWhy"]) $(id).addEventListener("input", paintComment);
  for (const id of ["bkStatusVal", "bkPrioVal"]) $(id).addEventListener("change", paintComment);
  $("bkCommentOn").onchange = paintComment;
  $("bkCommentOwn").addEventListener("input", () => { $("bkCommentOwn").dataset.auto = "0"; paintComment(); });
  $("bkCommentEdit").onclick = toggleCommentEdit;
  const tmr = new Date(); tmr.setDate(tmr.getDate() + 1);
  $("bkDueDate").value = isoDay(tmr.getTime());
  repaint();

  // Load when the tab is first opened (not on every Options page load).
  let loaded = false;
  const panel = document.querySelector('.panel[data-panel="bulk"]');
  const maybeLoad = () => { if (!loaded && panel && panel.classList.contains("on")) { loaded = true; loadScope().then(() => { syncScope(); ask(); }).catch(() => ask()); } };
  new MutationObserver(maybeLoad).observe(panel, { attributes: true, attributeFilter: ["class"] });
  maybeLoad();
  // A previous batch that can still be undone.
  chrome.storage.local.get("bulkUndo").then((g) => {
    const u = g.bulkUndo;
    if (!u || !u.items || !u.items.length || Date.now() - u.at > 7 * 86400000) return;
    const res = $("bkResult");
    res.hidden = false;
    res.innerHTML = "<span class='hint'>Last change: " + esc(u.text) + " (" + new Date(u.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + ").</span>";
    const b = document.createElement("button"); b.textContent = "Undo it"; b.onclick = undoLast;
    res.appendChild(b);
  }).catch(() => {});
})();
