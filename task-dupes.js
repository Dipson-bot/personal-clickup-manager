// Duplicate task alert: the same job sitting in your lists twice, so nobody has
// to wonder "did I already do this one?". The copies are often NOT on the same
// day - one standalone task this week and the same name as a subtask under next
// week's production schedule - which is exactly the case you can't spot by eye,
// because the two are never on screen together.
//  - Task rows (dashboard, popup, side panel): a "⧉ Duplicate" chip at the end
//    of the name cell. Hover lists every other copy with its due date and where
//    it sits; click opens the other copy in ClickUp. Added from a
//    MutationObserver like task-notes.js's 📌/📝, so no row builder changes.
//  - Insights › Health: a "Possible duplicates" list with a "Not a duplicate"
//    button per group (see insDrillsHtml / insRowAction in options.js).
// NO ClickUp request of its own. It reads insOpenCache - every open task
// assigned to you, already fetched and stored by the Insights tab (options.js
// INS_STORE) - so the cross-day comparison is free. Only the popup, which may
// never have had the options page open, asks for that set itself, and then only
// when the stored copy is missing or more than 12 hours old.
// Storage (chrome.storage.local):
//   cuDupesOk: ["namekey|clientkey", …]   groups the user called not-a-duplicate
//                                         (user intent, so it's in EXTRA_KEYS
//                                          and rides along to Drive)
(() => {
  "use strict";
  if (window.PcmDupes) return;

  const STORE = "insOpenCache";  // the open-task set the Insights tab keeps
  const OK_KEY = "cuDupesOk";
  // A name needs this many letters/digits before it can flag anything: "QA",
  // "Blog" and "Call" repeat across clients all week by design.
  const MIN_KEY = 6;
  const WARM_AFTER = 12 * 3600000;
  const NO_DATE = 8.64e15; // sorts undated last (Infinity - Infinity is NaN)
  // The weekly "Extra(s) Task(s)" carries the SAME name every week on purpose -
  // a guaranteed cross-day false positive (mirrors options.js EXTRA_TASK_NAME_RE).
  const EXTRA_RE = /extra\s*\(?\s*s?\s*\)?\s*-?\s*tasks?/i;
  // Letters and digits only, so "Location page title has no brand",
  // "location page-title has no brand" and a client spelled two ways are one
  // group (the same key canonicalizeClientLabels uses).
  const key = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const dayOf = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).setHours(0, 0, 0, 0) : 0);
  const fmtDue = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
  const taskUrl = (id) => "https://app.clickup.com/t/" + encodeURIComponent(id);

  let groups = [];                 // [{ key, name, client, members, sameDay, due }]
  let byId = Object.create(null);  // task id -> its group
  let okKeys = [];                 // cuDupesOk
  let okDirty = false;             // dismissed something already - the first
                                   // read must not undo it (storage answers
                                   // asynchronously, a click doesn't wait)
  let rows = null;                 // the open-task set, or null until read
  let at = 0;                      // when that set was fetched
  const subs = [];

  // ---------- the rule (pure: dev-tools/t_dupes.js drives this directly) ----------
  // opts.ok      keys the user has called not-a-duplicate
  // opts.paused  (t) => truthy when the client is paused - those rows are
  //              already struck through and out of every total, so a duplicate
  //              in them is not work anybody is about to do twice.
  function build(list, opts) {
    const o = opts || {};
    const okSet = Object.create(null);
    for (const k of (Array.isArray(o.ok) ? o.ok : [])) okSet[String(k)] = 1;
    const isPaused = typeof o.paused === "function" ? o.paused : () => false;
    const all = Array.isArray(list) ? list : [];
    // Parent names come from the set itself: a subtask only carries parentId.
    const names = Object.create(null);
    for (const t of all) if (t && t.id != null) names[String(t.id)] = String(t.name || "");
    const bucket = Object.create(null);
    for (const t of all) {
      if (!t || t.id == null || t.done) continue;
      const name = String(t.name || "");
      if (EXTRA_RE.test(name)) continue;
      const nk = key(name);
      if (nk.length < MIN_KEY) continue;
      if (isPaused(t)) continue;
      const client = String(t.client || (t.container && t.container.listName) || "");
      const gk = nk + "|" + key(client);
      if (okSet[gk]) continue;
      const g = bucket[gk] || (bucket[gk] = { key: gk, name, client, members: [] });
      const id = String(t.id);
      if (g.members.some((m) => m.id === id)) continue; // the pages fetch in pages; ids can repeat
      const pid = t.parentId != null ? String(t.parentId) : "";
      g.members.push({
        id, name, client,
        url: t.url || taskUrl(id),
        due: Number(t.dueDateMs) || 0,
        isSubtask: !!t.isSubtask,
        parentId: pid,
        parentName: (pid && names[pid]) || String(t.parentName || ""),
        listName: String((t.container && t.container.listName) || ""),
      });
    }
    const out = [];
    for (const gk of Object.keys(bucket)) {
      const g = bucket[gk];
      const ids = Object.create(null);
      for (const m of g.members) ids[m.id] = 1;
      // A task and its own same-named subtask are a hierarchy, not two copies of
      // a job - drop the child and the group usually falls below two.
      const own = g.members.filter((m) => !(m.parentId && ids[m.parentId]));
      // The same step under two DIFFERENT parents is a template, not a copy:
      // "Live & Schema Placement" under "BLOG 7 | ..." and under "BLOG | How we
      // onboard ..." are two pages' work. Two copies count only when they sit
      // under the same parent, or when one of them stands on its own (the
      // "Location page title has no brand" case: once nested, once loose).
      const pair = (a, b) => !a.parentId || !b.parentId || a.parentId === b.parentId;
      const keep = own.filter((m) => own.some((o) => o !== m && pair(m, o)));
      if (keep.length < 2) continue;
      keep.sort((a, b) => (a.due || NO_DATE) - (b.due || NO_DATE) || a.id.localeCompare(b.id));
      const days = {};
      let dated = 0;
      for (const m of keep) { const d = dayOf(m.due); if (d) { days[d] = 1; dated++; } }
      g.members = keep;
      // Red only when they really collide on one day; amber for the spread-out
      // case, which is the one the eye misses.
      g.sameDay = dated === keep.length && Object.keys(days).length === 1;
      g.due = keep[0].due || 0;
      out.push(g);
    }
    return out.sort((a, b) => (a.due || NO_DATE) - (b.due || NO_DATE) || a.name.localeCompare(b.name));
  }

  function recompute() {
    groups = build(rows || [], { ok: okKeys, paused: (t) => !!(window.PcmPaused && window.PcmPaused.pausedFor(t)) });
    byId = Object.create(null);
    for (const g of groups) for (const m of g.members) byId[m.id] = g;
    decorateAll();
    for (const fn of subs) { try { fn(); } catch (e) {} }
  }

  // ---------- what the rest of the extension asks ----------
  const of = (t) => {
    const id = t && (t.id != null ? t.id : t.taskId);
    return id == null ? null : byId[String(id)] || null;
  };
  // The other copies of this task, soonest first.
  const othersOf = (t) => {
    const g = of(t);
    if (!g) return [];
    const id = String(t.id != null ? t.id : t.taskId);
    return g.members.filter((m) => m.id !== id);
  };
  // Where a copy sits, in words - the thing that tells two copies apart.
  function whereOf(m) {
    if (m.parentName) return "under " + m.parentName;
    if (m.isSubtask) return "a subtask";
    return "a task on its own";
  }
  function tipFor(t) {
    const g = of(t);
    if (!g) return "";
    const others = othersOf(t);
    const head = g.sameDay
      ? "This task is in your lists " + g.members.length + " times on the same day."
      : "This task is in your lists " + g.members.length + " times, on different days.";
    return head + "\nThe other " + (others.length === 1 ? "one is" : "ones are") + ":\n" +
      others.map((m) => "• " + (m.due ? "due " + fmtDue(m.due) : "no due date") + " · " + whereOf(m)).join("\n") +
      "\nClick to open " + (others.length === 1 ? "it" : "the first one") + " in ClickUp, and close whichever you don't need." +
      "\nNot a duplicate? Insights › Health › Possible duplicates can dismiss it for good.";
  }

  // ---------- task rows: the ⧉ chip ----------
  function decorate(row) {
    const t = row && row._cuTask;
    const wrap = row && row.querySelector(".nmwrap");
    if (!wrap) return;
    const g = t && !t.done ? of(t) : null;
    let chip = wrap.querySelector(".cu-dup");
    if (!g) { if (chip) chip.remove(); return; }
    if (!chip) {
      chip = document.createElement("span");
      chip.className = "cu-dup";
      chip.innerHTML = '<span class="di">⧉</span><span class="dl"></span>';
      chip.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const o = othersOf(row._cuTask)[0];
        if (o && o.url) window.open(o.url, "_blank", "noopener");
      });
    }
    // Right after the name, never at the end: the Who / Client / Due cells live
    // in this same wrap, and a chip after them pushed every cell of the row out
    // of line with the rows above and below. Here only the name gives way.
    const nm = wrap.querySelector(".nm");
    const spot = nm ? nm.nextSibling : null;
    if (nm ? chip !== spot : chip.parentNode !== wrap) wrap.insertBefore(chip, spot);
    // Only write when it changed: this runs from a MutationObserver, and
    // rewriting the same text would wake it forever.
    const same = !!g.sameDay;
    if (chip.classList.contains("same") !== same) chip.classList.toggle("same", same);
    const label = "Duplicate"; // how many copies: in the hover, so the chip stays one size
    const lab = chip.querySelector(".dl");
    if (lab && lab.textContent !== label) lab.textContent = label;
    const tip = tipFor(row._cuTask);
    if (chip.title !== tip) chip.title = tip;
  }
  function decorateAll() { document.querySelectorAll(".cu-task").forEach(decorate); }
  let pending = 0, burst = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = 1;
    const run = () => { pending = 0; decorateAll(); };
    if (burst++ < 3) { queueMicrotask(run); setTimeout(() => { burst = 0; }, 0); } else setTimeout(run, 30);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- not a duplicate ----------
  // Recurring work that genuinely carries one name is dismissed for good, not
  // until the next refresh.
  async function ignore(gk) {
    const k = String(gk || "");
    if (!k || okKeys.indexOf(k) >= 0) return false;
    okKeys = okKeys.concat(k);
    okDirty = true;
    try { await chrome.storage.local.set({ [OK_KEY]: okKeys }); } catch (e) {}
    recompute();
    return true;
  }
  async function unignore(gk) {
    const k = String(gk || "");
    if (okKeys.indexOf(k) < 0) return false;
    okKeys = okKeys.filter((x) => x !== k);
    okDirty = true;
    try { await chrome.storage.local.set({ [OK_KEY]: okKeys }); } catch (e) {}
    recompute();
    return true;
  }

  // ---------- the open-task set ----------
  function take(blob) {
    if (!blob || !Array.isArray(blob.tasks)) return false;
    rows = blob.tasks;
    at = Number(blob.at) || 0;
    return true;
  }
  function sendMsg(msg, ms) {
    return new Promise((res) => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; res(null); } }, ms || 30000);
      try {
        chrome.runtime.sendMessage(msg, (r) => {
          if (done) return;
          done = true; clearTimeout(t);
          res(chrome.runtime.lastError ? null : r);
        });
      } catch (e) { done = true; clearTimeout(t); res(null); }
    });
  }
  // Only for a page that has no stored set to read (a popup on a computer where
  // the options page has never been opened). Unforced, so the background's own
  // 3-minute cache answers it for free if anything else fetched recently.
  let warmed = false;
  async function warm() {
    if (warmed || (rows && Date.now() - at < WARM_AFTER)) return false;
    warmed = true;
    const r = await sendMsg({ type: "CLICKUP_OPEN_TASKS" }, 30000);
    if (!(r && r.ok && r.data && Array.isArray(r.data.tasks))) return false;
    const blob = { at: Date.now(), tasks: r.data.tasks };
    take(blob);
    // Same key and shape the Insights tab writes, so the two share one copy.
    try { if (JSON.stringify(blob).length < 3000000) chrome.storage.local.set({ [STORE]: blob }); } catch (e) {}
    recompute();
    return true;
  }

  try {
    chrome.storage.local.get([STORE, OK_KEY]).then((g) => {
      if (!okDirty) okKeys = Array.isArray(g && g[OK_KEY]) ? g[OK_KEY].map(String) : [];
      take(g && g[STORE]);
      recompute();
      // The popup fetches only when it has nothing recent of its own to show.
      if (!rows || Date.now() - at >= WARM_AFTER) warm();
    }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (!ch[STORE] && !ch[OK_KEY]) return;
      if (ch[OK_KEY]) okKeys = Array.isArray(ch[OK_KEY].newValue) ? ch[OK_KEY].newValue.map(String) : [];
      if (ch[STORE]) take(ch[STORE].newValue);
      recompute();
    });
  } catch (e) {}

  window.PcmDupes = {
    of, othersOf, whereOf, tipFor, ignore, unignore, warm,
    all: () => groups,
    at: () => at,
    ignored: () => okKeys.slice(),
    onChange: (fn) => subs.push(fn),
    // For the options page, which already holds the open-task list the Insights
    // tab fetched: hand it straight over instead of waiting for the storage event.
    feed: (list, when) => { rows = Array.isArray(list) ? list : []; at = Number(when) || Date.now(); recompute(); },
    _build: build,
    _key: key,
    _decorateAll: decorateAll,
  };
})();
