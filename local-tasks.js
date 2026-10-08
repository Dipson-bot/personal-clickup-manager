// Draft tasks: "＋ New task" above the task list (options dashboard, popup, side
// panel). A draft lives only in this extension until "Apply to ClickUp" creates
// it in the chosen List (background CLICKUP_CREATE_TASK - one request); then its
// notes, pin and reminders move to the real task and the draft goes away.
//  - Rows look like the task list's own rows (.cu-task, so 📌 / 📝 from
//    task-notes.js work too) with a "Draft" tag, Apply to ClickUp and ✕.
//  - ▸ opens the shared details panel; task-panel.js hands "local-…" ids to
//    PcmLocalTasks.fill instead of asking ClickUp.
//  - The List picker lists the Lists your open tasks are in (CLICKUP_TASK_LISTS,
//    from the cached open-task read), or takes a pasted List link.
// Storage: localTasks [{ id: "local-…", name, md, listId, listName, client,
//   dueDateMs, startDateMs, estimateMs, priority, assignees [{id, name}] (older
//   drafts: assignMe), parentId/parentName (a subtask), applyAt (send to ClickUp
//   by itself then - background sendScheduledDrafts), createdAt, updatedAt, error }]
// (backed up to Drive with the other extras). Drafts don't count in any totals.
(() => {
  "use strict";
  const KEY = "localTasks";
  let drafts = [];
  const busy = new Set(); // ids being applied right now
  let flash = null;       // { name, url, at } - the last one created, for a moment
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const uid = () => "local-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const send = (msg, ms) => new Promise((ok) => {
    let done = false;
    const to = setTimeout(() => { done = true; ok(null); }, ms || 30000);
    try {
      chrome.runtime.sendMessage(msg, (r) => { if (done) return; done = true; clearTimeout(to); void chrome.runtime.lastError; ok(r || null); });
    } catch (e) { clearTimeout(to); ok(null); }
  });
  const fmt = (ms) => {
    const m = Math.round((Number(ms) || 0) / 60000);
    if (m <= 0) return "";
    const h = Math.floor(m / 60), r = m % 60;
    return h ? h + "h" + (r ? " " + r + "m" : "") : r + "m";
  };
  // "45m", "1h 30m", "1.5" (bare number = hours). null when it can't be read.
  function parseDur(s) {
    const raw = String(s || "").trim().toLowerCase();
    if (!raw) return 0;
    if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(parseFloat(raw) * 3600000);
    const re = /(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/g;
    let ms = 0, hit = false, m;
    while ((m = re.exec(raw)) !== null) { ms += parseFloat(m[1]) * (/^h/.test(m[2]) ? 3600000 : 60000); hit = true; }
    return hit ? Math.round(ms) : null;
  }
  const dayStart = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const dueText = (ms) => {
    if (!ms) return "";
    const diff = Math.round((dayStart(ms) - dayStart(Date.now())) / 86400000);
    return diff === 0 ? "Today" : diff === 1 ? "Tmrw" : new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
  };
  const toDateInput = (ms) => { if (!ms) return ""; const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); };
  // A date-only due date: noon that day, so it reads as that date in every time zone nearby.
  const fromDateInput = (v) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3], 12).getTime() : 0; };
  const PRIOS = { "": "No priority", urgent: "Urgent", high: "High", normal: "Normal", low: "Low" };

  // ---------- data ----------
  function load() {
    try {
      chrome.storage.local.get(KEY).then((g) => { drafts = Array.isArray(g && g[KEY]) ? g[KEY] : []; paint(); }).catch(() => {});
    } catch (e) {}
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[KEY]) { drafts = Array.isArray(ch[KEY].newValue) ? ch[KEY].newValue : []; paint(); } }); } catch (e) {}
  const find = (id) => drafts.find((d) => d.id === id) || null;
  async function save(list) { drafts = list.slice(0, 200); await chrome.storage.local.set({ [KEY]: drafts }); paint(); }
  async function upsert(d) {
    const g = await chrome.storage.local.get(KEY).catch(() => ({}));
    const list = Array.isArray(g && g[KEY]) ? g[KEY] : [];
    const i = list.findIndex((x) => x.id === d.id);
    if (i >= 0) list[i] = d; else list.unshift(d);
    await save(list);
  }
  async function remove(id) {
    const g = await chrome.storage.local.get(KEY).catch(() => ({}));
    await save((Array.isArray(g && g[KEY]) ? g[KEY] : []).filter((x) => x.id !== id));
  }

  // Lists to create in (cached for the page's life, re-read after 10 minutes).
  let lists = null, listsAt = 0, listsP = null, listsErr = "";
  function getLists(force) {
    if (!force && lists && Date.now() - listsAt < 600000) return Promise.resolve(lists);
    if (listsP) return listsP;
    listsP = send({ type: "CLICKUP_TASK_LISTS", force: !!force }, 60000).then((r) => {
      listsP = null;
      if (r && r.ok && Array.isArray(r.lists)) { lists = r.lists; listsAt = Date.now(); listsErr = ""; }
      else listsErr = (r && (r.error || (r.reason === "not-configured" ? "Connect ClickUp first (ClickUp setup)." : r.reason))) || "Couldn't read your Lists.";
      return lists || [];
    });
    return listsP;
  }
  // A pasted List link (…/v/li/901234…, …/l/li/…) or a bare List id.
  const listIdFrom = (s) => { const v = String(s || "").trim(); const m = /\/li\/(\d+)/.exec(v) || /^(\d{4,})$/.exec(v); return m ? m[1] : ""; };

  // ---------- styles ----------
  const css = el("style");
  css.textContent = `
  .lt-box { margin: 6px 0 4px; }
  .lt-head { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 700; color: var(--muted); }
  .lt-head .sp { flex: 1; }
  .lt-head .lt-sub { font-weight: 500; font-size: 11px; }
  .lt-new { font: inherit; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border: 1px dashed var(--indigo, #6366f1); border-radius: 7px; background: none; color: var(--indigo, #6366f1); cursor: pointer; }
  .lt-new:hover { background: rgba(99,102,241,.1); border-style: solid; }
  .lt-list { margin-top: 4px; max-height: 260px; }
  .cu-task.lt-row { background: repeating-linear-gradient(135deg, transparent 0 8px, rgba(99,102,241,.04) 8px 16px); }
  .lt-pill { flex: none; font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 999px; border: 1px dashed var(--indigo, #6366f1); color: var(--indigo, #6366f1); text-transform: uppercase; letter-spacing: .04em; }
  .lt-pill.err { border-color: var(--red, #dc2626); color: var(--red, #dc2626); cursor: help; }
  .lt-acts { display: inline-flex; gap: 4px; align-items: center; flex: none; }
  .lt-btn { font: inherit; font-size: 11px; font-weight: 600; padding: 3px 9px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; }
  .lt-btn:hover:not(:disabled) { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
  .lt-btn.pri { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
  .lt-btn.pri:hover:not(:disabled) { color: #fff; filter: brightness(1.1); }
  .lt-btn:disabled { opacity: .55; cursor: default; }
  .lt-x { font: inherit; border: 0; background: none; color: var(--muted); cursor: pointer; padding: 2px 5px; border-radius: 5px; }
  .lt-x:hover { color: var(--red, #dc2626); background: var(--bg2, rgba(0,0,0,.05)); }
  .lt-msg { font-size: 11.5px; margin: 4px 0 0; color: var(--green, #16a34a); }
  .lt-msg.err { color: var(--red, #dc2626); }
  .lt-modal { position: fixed; inset: 0; z-index: 2147482000; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; padding: 28px 12px; overflow: auto; }
  .lt-dlg { width: min(640px, 100%); background: var(--card, #fff); color: var(--text); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; box-shadow: 0 20px 50px rgba(0,0,0,.25); font-size: 12.5px; display: flex; flex-direction: column; gap: 10px; }
  .lt-dlg h3 { margin: 0; font-size: 15px; }
  .lt-dlg .hint { margin: -4px 0 0; color: var(--muted); font-size: 11.5px; line-height: 1.45; }
  .lt-dlg label.f { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .lt-dlg input[type=text], .lt-dlg input[type=date], .lt-dlg select { font: inherit; font-size: 12.5px; text-transform: none; letter-spacing: 0; font-weight: 400; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); min-width: 0; }
  .lt-dlg input:focus, .lt-dlg select:focus { outline: none; border-color: var(--indigo, #6366f1); }
  .lt-dlg .row3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
  @media (max-width: 520px) { .lt-dlg .row3 { grid-template-columns: 1fr; } }
  .lt-dlg .chk { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .lt-dlg .bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .lt-dlg .bar .sp { flex: 1; }
  .lt-dlg .err { color: var(--red, #dc2626); font-size: 11.5px; min-height: 14px; }
  .lt-dlg .bad { border-color: var(--red, #dc2626) !important; }
  .lt-dlg .opt { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .lt-dlg div.f { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; position: relative; }
  .lt-date { font: inherit; font-size: 12.5px; text-transform: none; letter-spacing: 0; font-weight: 400; text-align: left; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); cursor: pointer; }
  .lt-date.empty { color: var(--muted); }
  .lt-date:hover { border-color: var(--indigo, #6366f1); }
  .lt-when { display: flex; gap: 6px; align-items: center; }
  .lt-when .lt-date { flex: 1; }
  .lt-when input[type=time] { font: inherit; font-size: 12.5px; padding: 5px 6px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); text-transform: none; letter-spacing: 0; font-weight: 400; }
  .lt-people { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding: 4px 6px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); text-transform: none; letter-spacing: 0; font-weight: 400; }
  .lt-people input { flex: 1; min-width: 120px; border: 0 !important; padding: 3px 2px !important; outline: none; background: none; }
  .lt-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 2px 4px 2px 9px; border-radius: 999px; background: rgba(99,102,241,.14); color: var(--text); }
  .lt-chip button { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 3px; font-size: 11px; }
  .lt-chip button:hover { color: var(--red, #dc2626); }
  .lt-pick { position: relative; }
  .lt-pick input { width: 100%; box-sizing: border-box; }
  .lt-sug { position: absolute; left: 0; right: 0; top: 100%; z-index: 5; margin-top: 2px; max-height: 220px; overflow: auto; background: var(--card); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 10px 24px rgba(0,0,0,.15); text-transform: none; letter-spacing: 0; font-weight: 400; }
  .lt-opt { padding: 6px 9px; font-size: 12.5px; cursor: pointer; color: var(--text); }
  .lt-opt:hover { background: rgba(99,102,241,.1); }
  .lt-opt .m, .lt-chosen .m { color: var(--muted); font-size: 11px; }
  .lt-none { padding: 7px 9px; font-size: 12px; color: var(--muted); }
  .lt-chosen { display: flex; align-items: center; gap: 4px; font-size: 12.5px; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--text); padding: 5px 8px; border: 1px dashed var(--indigo, #6366f1); border-radius: 7px; }
  .lt-pmeta { display: flex; flex-wrap: wrap; gap: 6px 12px; color: var(--muted); font-size: 11px; align-items: center; }
  .lt-pmeta b { color: var(--text); font-weight: 600; }
  .lt-pacts { display: flex; gap: 6px; flex-wrap: wrap; }
  `;
  document.head.appendChild(css);

  // ---------- the drafts block above the task list ----------
  const mountId = "ltBox";
  function mountPoint() {
    // Options dashboard: above #dashTasks. Popup / side panel: above #cuTaskList.
    const a = document.getElementById("dashTasks") || document.getElementById("cuTaskList");
    return a && a.parentNode ? a : null;
  }
  function paint() {
    const anchor = mountPoint();
    if (!anchor) return;
    let box = document.getElementById(mountId);
    if (!box) { box = el("div", "lt-box"); box.id = mountId; anchor.parentNode.insertBefore(box, anchor); }
    box.textContent = "";
    const head = el("div", "lt-head");
    if (drafts.length) {
      head.append(el("span", "", "Drafts · " + drafts.length), el("span", "lt-sub", "only in this extension until you apply them to ClickUp"));
    } else head.append(el("span", "lt-sub", "Plan a task here first - it goes to ClickUp only when you apply it."));
    head.appendChild(el("span", "sp"));
    const nb = el("button", "lt-new", "＋ New task");
    nb.type = "button";
    nb.title = "Write a new task in ClickUp's format. It stays in this extension until you press Apply to ClickUp.";
    nb.onclick = (e) => { e.stopPropagation(); openEditor(null); };
    head.appendChild(nb);
    box.appendChild(head);
    if (flash && Date.now() - flash.at < 20000) {
      const m = el("div", "lt-msg");
      m.append("“" + flash.name + "” is now in ClickUp ✓ ");
      const a = el("a", "", "Open ↗"); a.href = flash.url; a.target = "_blank"; a.rel = "noopener";
      m.appendChild(a);
      box.appendChild(m);
    }
    if (!drafts.length) return;
    const list = el("div", "cu-tasklist lt-list");
    for (const d of drafts) list.appendChild(row(d));
    box.appendChild(list);
  }
  function row(d) {
    const r = el("div", "cu-task lt-row");
    // task-notes.js reads row._cuTask (📌 / 📝); .local keeps the pages'
    // estimate editor away from it.
    r._cuTask = { id: d.id, name: d.name, client: d.client || "", local: true, estimateMs: d.estimateMs || 0, dueDateMs: d.dueDateMs || null };
    if (window.PcmTaskPanel) r.appendChild(window.PcmTaskPanel.chevron({ id: d.id }));
    const wrap = el("span", "nmwrap");
    const nm = el("a", "nm", d.name || "(untitled task)");
    nm.title = d.name + " - a draft, not in ClickUp yet. Click to edit it.";
    nm.href = "#";
    nm.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openEditor(d); };
    wrap.appendChild(nm);
    const pill = el("span", "lt-pill" + (d.error ? " err" : ""), d.error ? "Not applied" : d.applyAt ? "⏰ " + new Date(d.applyAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Draft");
    pill.title = d.error ? "ClickUp said: " + d.error + " - fix it with Edit, then Apply again." : d.applyAt ? "Goes to ClickUp by itself at this time (or press Apply to ClickUp now)" : "Only in this extension - press Apply to ClickUp to create it there";
    wrap.appendChild(pill);
    if (d.client || d.listName) { const c = el("span", "cu-client", d.client || d.listName); c.title = "List: " + (d.listName || "") + (d.client && d.client !== d.listName ? " (" + d.client + ")" : ""); wrap.appendChild(c); }
    const due = el("span", "cu-due" + (d.dueDateMs ? (dayStart(d.dueDateMs) < dayStart(Date.now()) ? " overdue" : dayStart(d.dueDateMs) === dayStart(Date.now()) ? " today" : "") : " nodue"), d.dueDateMs ? dueText(d.dueDateMs) : "+ due");
    due.title = d.dueDateMs ? "Due " + new Date(d.dueDateMs).toDateString() + " - click to change" : "Add a due date";
    due.style.cursor = "pointer";
    due.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openEditor(d, "due"); };
    wrap.appendChild(due);
    r.appendChild(wrap);
    const spans = el("span", "estpairs");
    const est = el("span", "est" + (d.estimateMs ? "" : " zero"), d.estimateMs ? fmt(d.estimateMs) : "no est");
    est.title = "Click to change the estimate";
    est.style.cursor = "pointer";
    est.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openEditor(d, "est"); };
    spans.appendChild(est);
    r.appendChild(spans);
    const acts = el("span", "lt-acts");
    const ap = el("button", "lt-btn pri", busy.has(d.id) ? "Creating…" : "Apply to ClickUp");
    ap.type = "button"; ap.disabled = busy.has(d.id);
    ap.title = d.listName ? "Create this task in ClickUp, in the List “" + d.listName + "”" : "Pick a List first (opens the editor)";
    ap.onclick = (e) => { e.preventDefault(); e.stopPropagation(); apply(d.id); };
    const x = el("button", "lt-x", "✕");
    x.type = "button"; x.title = "Delete this draft";
    x.onclick = (e) => { e.preventDefault(); e.stopPropagation(); del(d.id); };
    acts.append(ap, x);
    r.appendChild(acts);
    return r;
  }

  // ---------- create / edit ----------
  // People (for Assignees): the workspace members the extension already loaded,
  // and who "me" is.
  let people = null, me = null;
  async function getPeople() {
    if (people) return people;
    // The workspace roster (cached ~1h, built in the background - no wait here).
    const r = await send({ type: "CLICKUP_DEPT_DATA" }, 15000);
    me = r && r.userId != null ? { id: String(r.userId), name: r.meName || "Me" } : null;
    const ms = (r && r.ok && Array.isArray(r.members)) ? r.members : [];
    if (!ms.length) { setTimeout(() => { people = null; }, 0); } // try again next time it's opened
    people = ms.filter((m) => m && m.id != null).map((m) => ({ id: String(m.id), name: String(m.name || m.username || m.email || ("User " + m.id)), email: String(m.email || "") }));
    if (me && !people.some((p) => p.id === me.id)) people.unshift({ id: me.id, name: me.name, email: "" });
    return people;
  }
  // Open tasks to hang a subtask under (the cached open-task read; it also gives each task's List).
  let parents = null;
  async function getParents() {
    if (parents) return parents;
    const r = await send({ type: "CLICKUP_OPEN_TASKS" }, 45000);
    const ts = (r && r.ok && r.data && Array.isArray(r.data.tasks)) ? r.data.tasks : [];
    parents = ts.filter((t) => t && t.id && !t.parentId).map((t) => ({ id: String(t.id), name: String(t.name || ""), listId: (t.container && t.container.listId) || "", listName: (t.container && t.container.listName) || "", client: t.client || "" }));
    return parents;
  }
  const dateLabel = (ms) => ms ? new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "";
  let modal = null;
  function closeEditor() { if (modal) { modal.remove(); modal = null; } }
  function openEditor(d0, focus) {
    closeEditor();
    const d = d0 ? { ...d0 } : { id: uid(), name: "", md: "", listId: "", listName: "", client: "", dueDateMs: 0, startDateMs: 0, estimateMs: 0, priority: "", assignees: null, parentId: "", parentName: "", applyAt: 0 };
    modal = el("div", "lt-modal");
    const dlg = el("div", "lt-dlg");
    dlg.setAttribute("role", "dialog");
    dlg.innerHTML =
      "<h3>" + (d0 ? "Edit draft task" : "New task") + "</h3>" +
      '<p class="hint">Kept only in this extension until you press <b>Apply to ClickUp</b> (or the time you set comes) - then it\'s created in ClickUp with these people, dates, estimate, priority and description.</p>' +
      '<label class="f">Task name<input type="text" data-k="name" maxlength="1000" placeholder="e.g. Fix the slow server response (TTFB)" /></label>' +
      '<div class="f">Make it a subtask of <span class="opt">(optional)</span><div class="lt-pick" data-k="parentbox"><input type="text" data-k="parentq" placeholder="Search your open tasks…" autocomplete="off" /><div class="lt-sug" data-k="parentsug" hidden></div></div><div class="lt-chosen" data-k="parentchosen" hidden></div></div>' +
      '<label class="f" data-k="listrow">List (where it goes in ClickUp)<select data-k="list"><option value="">Loading your Lists…</option></select></label>' +
      '<div class="f">Assignees<div class="lt-people" data-k="people"><span data-k="chips"></span><input type="text" data-k="pq" placeholder="Type a name…" autocomplete="off" /></div><div class="lt-sug" data-k="psug" hidden></div></div>' +
      '<div class="row3"><div class="f">Start date<button type="button" class="lt-date" data-k="start"></button></div>' +
      '<div class="f">Due date<button type="button" class="lt-date" data-k="due"></button></div>' +
      '<label class="f">Estimate<input type="text" data-k="est" placeholder="e.g. 1h 30m" /></label></div>' +
      '<div class="row3"><label class="f">Priority<select data-k="prio">' + Object.keys(PRIOS).map((k) => '<option value="' + k + '">' + PRIOS[k] + "</option>").join("") + "</select></label>" +
      '<div class="f" style="grid-column: span 2">Send to ClickUp <span class="opt">(optional - otherwise when you press Apply)</span><div class="lt-when"><button type="button" class="lt-date" data-k="applyday"></button><input type="time" data-k="applytime" /><button type="button" class="lt-x" data-k="applyclear" title="Don\'t schedule it">✕</button></div></div></div>' +
      '<div class="f" style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Description</div><div data-k="desc"></div>' +
      '<div class="err" data-err></div>' +
      '<div class="bar"><button type="button" class="lt-btn" data-cancel>Cancel</button><span class="sp"></span>' +
      '<button type="button" class="lt-btn" data-save>Save draft</button><button type="button" class="lt-btn pri" data-apply>Save &amp; apply to ClickUp</button></div>';
    modal.appendChild(dlg);
    document.body.appendChild(modal);
    const $ = (k) => dlg.querySelector('[data-k="' + k + '"]');
    const errEl = dlg.querySelector("[data-err]");
    $("name").value = d.name || "";
    $("est").value = fmt(d.estimateMs);
    $("prio").value = d.priority || "";

    // Dates: the extension's own calendar (holidays, work-from-home days, how full each day is).
    const dates = { start: Number(d.startDateMs) || 0, due: Number(d.dueDateMs) || 0, applyday: d.applyAt ? dayStart(d.applyAt) : 0 };
    const paintDate = (k) => { const btn = $(k); const ms = dates[k]; btn.textContent = ms ? dateLabel(ms) : (k === "applyday" ? "Pick a day…" : "Pick a date…"); btn.classList.toggle("empty", !ms); };
    for (const k of ["start", "due", "applyday"]) {
      paintDate(k);
      $(k).onclick = (e) => {
        e.preventDefault();
        const pick = (dayMs) => { dates[k] = dayMs ? new Date(new Date(dayMs).setHours(12, 0, 0, 0)).getTime() : 0; paintDate(k); };
        if (window.PcmCalendar && typeof window.PcmCalendar.pick === "function") window.PcmCalendar.pick($(k), { value: dates[k], canClear: true, what: k === "start" ? "start date" : k === "due" ? "due date" : "day to send it", onPick: pick, onClose: () => {} });
        else { const v = prompt("Date (YYYY-MM-DD)", dates[k] ? toDateInput(dates[k]) : ""); if (v !== null) pick(fromDateInput(v)); }
      };
    }
    if (d.applyAt) { const t = new Date(d.applyAt); $("applytime").value = String(t.getHours()).padStart(2, "0") + ":" + String(t.getMinutes()).padStart(2, "0"); }
    $("applyclear").onclick = () => { dates.applyday = 0; $("applytime").value = ""; paintDate("applyday"); };

    // Assignees: chips + type-ahead over the workspace people. New drafts start with you.
    let chosen = Array.isArray(d.assignees) ? d.assignees.slice() : null;
    const chips = () => {
      const box = $("chips"); box.textContent = "";
      for (const p of chosen || []) {
        const c = el("span", "lt-chip", p.name + (me && p.id === me.id ? " (you)" : ""));
        const x = el("button", "", "✕"); x.type = "button"; x.title = "Remove " + p.name;
        x.onclick = () => { chosen = chosen.filter((q) => q.id !== p.id); chips(); };
        c.appendChild(x); box.appendChild(c);
      }
    };
    getPeople().then(() => { if (!chosen) chosen = d.assignMe === false || !me ? [] : [me]; chips(); });
    const pq = $("pq"), psug = $("psug");
    const showPeople = () => {
      const q = pq.value.trim().toLowerCase();
      const have = new Set((chosen || []).map((p) => p.id));
      const hits = (people || []).filter((p) => !have.has(p.id) && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))).slice(0, 8);
      psug.innerHTML = hits.length ? hits.map((p) => '<div class="lt-opt" data-id="' + esc(p.id) + '">' + esc(p.name) + (p.email ? ' <span class="m">' + esc(p.email) + "</span>" : "") + "</div>").join("") : '<div class="lt-none">' + (people && people.length ? "No one matches." : "The people list loads after the first ClickUp refresh.") + "</div>";
      psug.hidden = false;
    };
    pq.onfocus = () => getPeople().then(showPeople);
    pq.oninput = showPeople;
    pq.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); const f = psug.querySelector(".lt-opt"); if (f) f.click(); } else if (e.key === "Backspace" && !pq.value && chosen && chosen.length) { chosen.pop(); chips(); } };
    psug.onmousedown = (e) => {
      const o = e.target.closest(".lt-opt"); if (!o) return;
      e.preventDefault();
      const p = (people || []).find((x) => x.id === o.dataset.id);
      if (p) { chosen = (chosen || []).concat([p]); chips(); pq.value = ""; showPeople(); }
    };
    pq.onblur = () => setTimeout(() => { psug.hidden = true; }, 150);

    // Subtask of: search the open tasks; the parent decides the List.
    let parent = d.parentId ? { id: d.parentId, name: d.parentName || "", listId: d.listId, listName: d.listName } : null;
    const sel = $("list");
    const paintParent = () => {
      const ch = $("parentchosen");
      ch.hidden = !parent; $("parentbox").hidden = !!parent;
      $("listrow").hidden = !!(parent && parent.listId); // the parent decides the List (asked only if unknown)
      ch.textContent = "";
      if (parent) {
        ch.append(el("span", "", "↳ subtask of "), el("b", "", parent.name || ("task " + parent.id)), el("span", "m", parent.listName ? "  · in " + parent.listName : ""));
        const x = el("button", "lt-x", "✕"); x.type = "button"; x.title = "Not a subtask"; x.onclick = () => { parent = null; paintParent(); };
        ch.appendChild(x);
      }
    };
    paintParent();
    const parq = $("parentq"), parsug = $("parentsug");
    const showParents = () => {
      const q = parq.value.trim().toLowerCase();
      if (!parents) { parsug.innerHTML = '<div class="lt-none">Loading your open tasks…</div>'; parsug.hidden = false; return; }
      const hits = parents.filter((p) => !q || p.name.toLowerCase().includes(q) || p.client.toLowerCase().includes(q)).slice(0, 10);
      parsug.innerHTML = hits.length ? hits.map((p) => '<div class="lt-opt" data-id="' + esc(p.id) + '">' + esc(p.name) + (p.client || p.listName ? ' <span class="m">' + esc(p.client || p.listName) + "</span>" : "") + "</div>").join("") : '<div class="lt-none">No open task matches.</div>';
      parsug.hidden = false;
    };
    parq.onfocus = () => { showParents(); getParents().then(showParents); };
    parq.oninput = showParents;
    parsug.onmousedown = (e) => {
      const o = e.target.closest(".lt-opt"); if (!o) return;
      e.preventDefault();
      const p = (parents || []).find((x) => x.id === o.dataset.id);
      if (p) { parent = p; parq.value = ""; parsug.hidden = true; paintParent(); }
    };
    parq.onblur = () => setTimeout(() => { parsug.hidden = true; }, 150);

    const ed = window.PcmMd ? window.PcmMd.editor(d.md || "", { maxLength: 20000, placeholder: "What needs doing, links, steps… Paste from Claude / ChatGPT keeps its formatting." }) : null;
    if (ed) $("desc").replaceWith(ed); else { const ta = el("textarea"); ta.value = d.md || ""; ta.style.cssText = "min-height:120px;font:inherit"; ta.getMarkdown = () => ta.value; $("desc").replaceWith(ta); }
    const descEl = () => dlg.querySelector(".md-ed") || dlg.querySelector("textarea");
    const fillLists = (ls) => {
      const opts = ['<option value="">' + (ls.length ? "Pick a List…" : listsErr ? "Couldn't read your Lists" : "No Lists found") + "</option>"];
      let known = false;
      for (const l of ls) {
        if (String(l.id) === String(d.listId)) known = true;
        const label = (l.client && l.client !== l.name ? l.client + " › " : "") + l.name + (l.folder && l.folder !== l.client ? " (" + l.folder + ")" : "");
        opts.push('<option value="' + esc(l.id) + '">' + esc(label) + "</option>");
      }
      if (d.listId && !known) opts.push('<option value="' + esc(d.listId) + '">' + esc(d.listName || "List " + d.listId) + "</option>");
      sel.innerHTML = opts.join("");
      sel.value = d.listId ? String(d.listId) : "";
    };
    getLists(false).then(fillLists);
    const read = () => {
      errEl.textContent = "";
      dlg.querySelectorAll(".bad").forEach((x) => x.classList.remove("bad"));
      const name = $("name").value.trim();
      if (!name) { $("name").classList.add("bad"); errEl.textContent = "Give the task a name."; $("name").focus(); return null; }
      const est = parseDur($("est").value);
      if (est == null) { $("est").classList.add("bad"); errEl.textContent = "Estimate: try 45m, 1h 30m or 1.5 (hours)."; $("est").focus(); return null; }
      if (dates.start && dates.due && dates.start > dates.due) { errEl.textContent = "The start date is after the due date."; return null; }
      let listId = sel.value, listName = "", client = "";
      if (parent && parent.listId) { listId = parent.listId; listName = parent.listName || ""; client = parent.client || parent.listName || ""; }
      else if (listId) {
        const l = (lists || []).find((x) => String(x.id) === listId);
        listName = l ? l.name : d.listName || "List " + listId;
        client = l ? (l.client || l.name) : d.client || "";
      }
      let applyAt = 0;
      if (dates.applyday) {
        const [hh, mm] = ($("applytime").value || "09:00").split(":").map(Number);
        applyAt = new Date(new Date(dates.applyday).setHours(hh || 0, mm || 0, 0, 0)).getTime();
        if (applyAt <= Date.now()) { errEl.textContent = "The time to send it is already past - pick a later one, or clear it."; return null; }
      }
      const de = descEl();
      return { ...d, name: name.slice(0, 1000), md: String(de && de.getMarkdown ? de.getMarkdown() : "").trim().slice(0, 20000), listId, listName, client,
        dueDateMs: dates.due, startDateMs: dates.start, estimateMs: est, priority: $("prio").value,
        assignees: (chosen || []).map((p) => ({ id: p.id, name: p.name })), assignMe: undefined,
        parentId: parent ? parent.id : "", parentName: parent ? parent.name : "", applyAt, error: "",
        createdAt: d.createdAt || Date.now(), updatedAt: Date.now() };
    };
    dlg.querySelector("[data-cancel]").onclick = closeEditor;
    dlg.querySelector("[data-save]").onclick = async () => {
      const v = read(); if (!v) return;
      if (v.applyAt && !v.listId) { sel.classList.add("bad"); errEl.textContent = "Pick the List it goes in, so it can be sent at that time."; return; }
      await upsert(v); closeEditor();
    };
    dlg.querySelector("[data-apply]").onclick = async () => {
      const v = read(); if (!v) return;
      if (!v.listId) { sel.classList.add("bad"); errEl.textContent = "Pick the List it goes in (or Save draft and choose later)."; return; }
      v.applyAt = 0; // applied now
      await upsert(v);
      closeEditor();
      apply(v.id);
    };
    modal.addEventListener("mousedown", (e) => { if (e.target === modal) modal._down = true; });
    modal.addEventListener("click", (e) => { if (e.target === modal && modal._down) { /* outside click keeps the work: ask */ if (confirm("Close without saving?")) closeEditor(); } if (modal) modal._down = false; });
    dlg.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEditor(); }
      else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); dlg.querySelector("[data-save]").click(); }
    });
    setTimeout(() => { const f = focus === "due" ? $("due") : focus === "est" ? $("est") : $("name"); if (f) { f.focus(); if (f.select) try { f.select(); } catch (e) {} if (focus === "due") f.click(); } }, 30);
  }

  async function del(id) {
    const d = find(id);
    if (!d || !confirm("Delete the draft “" + (d.name || "untitled") + "”? It was never in ClickUp.")) return;
    if (window.PcmTaskPanel) try { window.PcmTaskPanel.close(); } catch (e) {}
    await remove(id);
  }

  // ---------- Apply to ClickUp ----------
  async function apply(id) {
    const d = find(id);
    if (!d || busy.has(id)) return;
    if (!d.listId) { openEditor(d); return; }
    busy.add(id); paint(); repanel(id);
    const r = await send({ type: "CLICKUP_CREATE_TASK", draft: d }, 45000);
    busy.delete(id);
    if (!(r && r.ok && r.task && r.task.id)) {
      const msg = (r && (r.status === 429 ? "ClickUp is busy - try again in a minute." : r.error)) || "No reply from the extension - try again.";
      const g = await chrome.storage.local.get(KEY).catch(() => ({}));
      const list = Array.isArray(g && g[KEY]) ? g[KEY] : [];
      const x = list.find((y) => y.id === id);
      if (x) { x.error = String(msg).slice(0, 300); await save(list); } else paint();
      repanel(id);
      return;
    }
    await moveExtras(id, r.task);
    if (window.PcmTaskPanel) try { window.PcmTaskPanel.close(); } catch (e) {}
    flash = { name: d.name, url: r.task.url, at: Date.now() };
    setTimeout(paint, 20500);
    await remove(id);
  }
  // The draft's notes, pin and reminders now belong to the real task.
  async function moveExtras(fromId, task) {
    const to = String(task.id);
    try {
      const g = await chrome.storage.local.get(["taskNotes", "taskPins", "reminders"]);
      const out = {};
      const n = g.taskNotes && typeof g.taskNotes === "object" ? g.taskNotes : null;
      if (n && n[fromId]) { n[to] = n[fromId]; delete n[fromId]; out.taskNotes = n; }
      const p = g.taskPins && typeof g.taskPins === "object" ? g.taskPins : null;
      if (p && p[fromId]) { p[to] = p[fromId]; delete p[fromId]; out.taskPins = p; }
      const rs = Array.isArray(g.reminders) ? g.reminders : null;
      if (rs && rs.some((x) => x && x.taskId === fromId)) {
        for (const x of rs) if (x && x.taskId === fromId) { x.taskId = to; x.taskUrl = task.url || x.taskUrl; }
        out.reminders = rs;
      }
      if (Object.keys(out).length) await chrome.storage.local.set(out);
    } catch (e) {}
  }

  // ---------- ▸ details for a draft (task-panel.js calls this) ----------
  function fill(p, id) {
    p.textContent = "";
    p._ltId = id;
    const d = find(id);
    if (!d) { p.appendChild(el("div", "pcm-empty", "This draft is gone (applied to ClickUp or deleted).")); return; }
    const meta = el("div", "lt-pmeta");
    meta.innerHTML = '<span class="lt-pill' + (d.error ? " err" : "") + '">' + (d.error ? "Not applied" : "Draft") + "</span>" +
      "<span>List <b>" + esc(d.listName || "not picked yet") + "</b></span>" +
      "<span>Due <b>" + esc(d.dueDateMs ? new Date(d.dueDateMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) : "-") + "</b></span>" +
      "<span>Estimate <b>" + esc(fmt(d.estimateMs) || "-") + "</b></span>" +
      "<span>Priority <b>" + esc(PRIOS[d.priority || ""]) + "</b></span>" +
      "<span>" + esc(Array.isArray(d.assignees) ? (d.assignees.length ? "Assignees: " + d.assignees.map((a) => a.name).join(", ") : "Unassigned") : (d.assignMe !== false ? "Assigned to you" : "Unassigned")) + "</span>" +
      (d.startDateMs ? "<span>Start <b>" + esc(new Date(d.startDateMs).toLocaleDateString([], { month: "short", day: "numeric" })) + "</b></span>" : "") +
      (d.parentId ? "<span>Subtask of <b>" + esc(d.parentName || d.parentId) + "</b></span>" : "") +
      (d.applyAt ? "<span>Sends to ClickUp <b>" + esc(new Date(d.applyAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + "</b></span>" : "");
    p.appendChild(meta);
    if (d.error) p.appendChild(el("div", "pcm-err", "ClickUp said: " + d.error));
    const dh = el("div", "pcm-sec-h", "Description");
    p.appendChild(dh);
    const desc = el("div", "md");
    if (d.md && window.PcmMd) desc.innerHTML = window.PcmMd.render(d.md);
    else { desc.className = "pcm-empty"; desc.textContent = d.md || "No description yet."; }
    p.appendChild(desc);
    const acts = el("div", "lt-pacts");
    const e1 = el("button", "pcm-btn", "Edit draft"); e1.type = "button"; e1.onclick = () => openEditor(find(id) || d);
    const a1 = el("button", "pcm-btn pri", busy.has(id) ? "Creating…" : "Apply to ClickUp"); a1.type = "button"; a1.disabled = busy.has(id);
    a1.title = "Create it in ClickUp now"; a1.onclick = () => apply(id);
    const x1 = el("button", "pcm-btn", "Delete draft"); x1.type = "button"; x1.onclick = () => del(id);
    acts.append(e1, a1, x1);
    p.appendChild(acts);
    if (window.PcmTaskNotes) { const tn = el("div"); p.appendChild(tn); window.PcmTaskNotes.renderPanel(tn, { id, name: d.name, client: d.client || d.listName || "" }); }
  }
  // Redraw an open draft panel after a change.
  function repanel(id) {
    document.querySelectorAll(".pcm-panel").forEach((p) => { if (p._ltId && (!id || p._ltId === id) && p.isConnected) fill(p, p._ltId); });
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch[KEY]) repanel(); }); } catch (e) {}

  window.PcmLocalTasks = { fill, open: () => openEditor(null), list: () => drafts.slice(), _parseDur: parseDur, _listIdFrom: listIdFrom };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
})();
