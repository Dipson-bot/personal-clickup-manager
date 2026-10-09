// Sortable column header for every task list (options page, popup, side panel).
// A slim header sits right above each list, its labels lined up over the
// columns of the first row: Task (with the number of tasks), Assignee, Client,
// Due, Time. Click a label: A-Z / earliest / smallest first (▲), click again:
// the other way (▼), a third time: the normal order again. Subtasks move with
// their task, section headings inside a list stay where they are, and the
// choice is remembered and applies to every list. Works on the rows the pages
// already draw (each row carries its task as row._cuTask), so no list code
// needs to know about it.
(() => {
  "use strict";
  const KEY = "pcm.taskSort";
  let state = { key: "", dir: 1 };
  try { const s = JSON.parse(localStorage.getItem(KEY) || "{}"); if (s && s.key) state = { key: String(s.key), dir: s.dir === -1 ? -1 : 1 }; } catch (e) {}
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} };

  const COLS = [
    { key: "name", label: "Task", sel: ".nm", tip: "Sort by task name" },
    { key: "who", label: "Who", short: "👤", shortBelow: 34, sel: ".cu-who", tip: "Sort by who else is on the task (tasks only you are on first)", resize: true, min: 20, max: 140 },
    { key: "client", label: "Client", sel: ".cu-client", tip: "Sort by client", resize: true, min: 50, max: 280 },
    { key: "due", label: "Due", sel: ".cu-due", tip: "Sort by due date", resize: true, min: 36, max: 130 },
    { key: "time", label: "Time", sel: ".estpairs", tip: "Sort by time tracked (then estimate)" },
  ];
  // Column widths the user dragged, per page (the popup is narrower than the
  // dashboard), applied to every row through CSS variables.
  const WKEY = "pcm.taskColW." + (/popup/.test(location.pathname) ? "popup" : "options");
  let widths = {};
  try { widths = JSON.parse(localStorage.getItem(WKEY) || "{}") || {}; } catch (e) {}
  function applyWidths() {
    const root = document.documentElement;
    for (const k of ["who", "client", "due"]) {
      const w = Number(widths[k]);
      root.classList.toggle("pcs-w-" + k, w > 0);
      if (w > 0) root.style.setProperty("--pcs-w-" + k, w + "px"); else root.style.removeProperty("--pcs-w-" + k);
    }
  }
  applyWidths();
  const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
  // The value a row sorts by; null = no value (always listed last).
  // The person on most rows of the list being sorted (that's you): "Who" sorts
  // by the OTHER people, otherwise every row would tie on your own name.
  let listMe = "";
  const nameOfA = (a) => low(a && (a.username || a.email || a.id));
  function value(t, key) {
    if (!t) return null;
    if (key === "name") return low(String(t.name || "").replace(/^[^\p{L}\p{N}]+/u, "")) || null;
    if (key === "who") {
      const a = Array.isArray(t.assignees) ? t.assignees : [];
      if (!a.length) return null;
      const others = a.filter((x) => String(x && x.id) !== listMe).map(nameOfA).filter(Boolean).sort();
      return others.length ? "1" + others.join(", ") : "0"; // only you: first
    }
    if (key === "client") return low(t.client) || null;
    if (key === "due") return Number(t.dueDateMs) || null;
    // The bold number on the row is the time tracked, so that leads; the estimate breaks ties.
    if (key === "time") { const e = Number(t.estimateMs || t.totalEstimateMs || t.dayEstimateMs) || 0; const s = Number(t.spentMs) || 0; return e || s ? Math.round(s / 1000) * 1e7 + Math.round(e / 1000) : null; }
    return null;
  }
  function pickMe(rows) {
    const n = new Map();
    for (const r of rows) for (const a of ((r._cuTask && r._cuTask.assignees) || [])) { const id = String(a && a.id); n.set(id, (n.get(id) || 0) + 1); }
    let best = "", c = 0;
    for (const [id, k] of n) if (k > c) { best = id; c = k; }
    return best;
  }
  function compare(a, b) {
    // Pinned tasks (task-notes.js) stay on top whatever the column sort.
    const pa = !!(window.PcmTaskNotes && a && window.PcmTaskNotes.isPinned(a.id)), pb = !!(window.PcmTaskNotes && b && window.PcmTaskNotes.isPinned(b.id));
    if (pa !== pb) return pa ? -1 : 1;
    const va = value(a, state.key), vb = value(b, state.key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // empty values last, either way
    if (vb == null) return -1;
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : String(va).localeCompare(String(vb), undefined, { numeric: true });
    return c * state.dir;
  }

  const css = document.createElement("style");
  css.textContent = `
    .pcs-sorthead { position: relative; height: 18px; margin: 8px 0 3px; padding-bottom: 3px; border-bottom: 1px solid var(--border); font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); user-select: none; }
    .pcs-sorthead button { position: absolute; top: 0; background: none; border: 0; padding: 0 2px; font: inherit; letter-spacing: inherit; text-transform: inherit; color: inherit; cursor: pointer; white-space: nowrap; line-height: 18px; overflow: hidden; text-overflow: ellipsis; }
    .pcs-sorthead button:hover, .pcs-sorthead button.on { color: var(--indigo, #6366f1); }
    .pcs-sorthead .pcs-grip { position: absolute; top: 1px; width: 7px; height: 16px; cursor: col-resize; border-radius: 2px; }
    .pcs-sorthead .pcs-grip::after { content: ""; position: absolute; left: 3px; top: 3px; bottom: 3px; width: 1px; background: var(--border); }
    .pcs-sorthead .pcs-grip:hover::after, .pcs-sorthead .pcs-grip.drag::after { background: var(--indigo, #6366f1); width: 2px; left: 2px; }
    html.pcs-w-who .cu-task .cu-who { width: var(--pcs-w-who) !important; overflow: hidden; }
    html.pcs-w-client .cu-task .cu-client { width: var(--pcs-w-client) !important; }
    html.pcs-w-due .cu-task .cu-due { width: var(--pcs-w-due) !important; }
  `;
  document.head.appendChild(css);

  const isRow = (el) => !!(el && el.classList && el.classList.contains("cu-task"));
  const rowsOf = (list) => [...list.children].filter(isRow);
  let busy = false;

  // Reorder each run of rows (between section headings) - blocks of a task and
  // the subtasks right under it move together.
  function applySort(list) {
    const kids = [...list.children];
    kids.forEach((el, i) => { if (isRow(el) && el._pcsOrd == null) el._pcsOrd = i; });
    const runs = [];
    let run = null;
    for (const el of kids) {
      if (isRow(el)) { if (!run) runs.push((run = [])); run.push(el); } else run = null;
    }
    listMe = pickMe(kids.filter(isRow));
    for (const r of runs) {
      const blocks = [];
      for (const el of r.slice().sort((a, b) => a._pcsOrd - b._pcsOrd)) {
        if (el.classList.contains("cu-sub") && blocks.length) blocks[blocks.length - 1].push(el);
        else blocks.push([el]);
      }
      // A day plan applied from Insights > Plan keeps its own order (plan-apply.js).
      if (state.key && !document.documentElement.classList.contains("pcm-plan-on")) blocks.sort((x, y) => compare(x[0]._cuTask, y[0]._cuTask) || x[0]._pcsOrd - y[0]._pcsOrd);
      // Only move rows when the order really changes (the lists redraw every
      // second while a timer runs; moving rows under the mouse loses clicks).
      const want = blocks.flat();
      if (want.every((el, i) => el === r[i])) continue;
      const after = r[r.length - 1].nextSibling;
      for (const el of want) list.insertBefore(el, after);
    }
  }

  // Put the labels over the matching parts of the first row.
  function place(head, list) {
    const rows = rowsOf(list);
    const first = rows.find((r) => !r.classList.contains("cu-sub")) || rows[0];
    const hb = head.getBoundingClientRect();
    if (!first || !hb.width) return;
    const spots = [];
    for (const btn of head.querySelectorAll("button")) {
      const col = COLS.find((c) => c.key === btn.dataset.key);
      const el = first.querySelector(col.sel);
      const r = el && el.getBoundingClientRect();
      btn.hidden = !r || !r.width;
      const left = btn.hidden ? "" : Math.max(0, Math.round(r.left - hb.left)) + "px";
      if (btn.style.left !== left) btn.style.left = left;
      if (!btn.hidden) spots.push({ btn, col, left: r.left - hb.left, right: r.right - hb.left });
      // A very narrow column (the popup's assignee avatars) gets a short label.
      btn._narrow = !!(col.short && r && r.width && r.width < col.shortBelow);
      const grip = head.querySelector('.pcs-grip[data-key="' + col.key + '"]');
      if (grip) {
        grip.hidden = btn.hidden;
        const gl = btn.hidden ? "" : Math.round(r.right - hb.left - 4) + "px";
        if (grip.style.left !== gl) grip.style.left = gl;
      }
    }
    // A label never runs into the next one: it gets "…" instead.
    spots.sort((a, b) => a.left - b.left);
    spots.forEach((s, i) => {
      const next = spots[i + 1];
      const mw = next ? Math.max(14, Math.round(next.left - s.left - 8)) + "px" : "";
      if (s.btn.style.maxWidth !== mw) s.btn.style.maxWidth = mw;
    });
  }
  function paint(head, list) {
    place(head, list);
    const n = rowsOf(list).length;
    for (const btn of head.querySelectorAll("button")) {
      const col = COLS.find((c) => c.key === btn.dataset.key);
      const on = state.key === col.key;
      btn.classList.toggle("on", on);
      const text = (btn._narrow ? col.short : col.label) + (col.key === "name" ? " (" + n + ")" : "") + (on ? (state.dir === 1 ? " ▲" : " ▼") : "");
      if (btn.textContent !== text) btn.textContent = text;
      btn.title = col.tip + (on ? (state.dir === 1 ? " - click for the other way" : " - click for the normal order") : "");
    }
    place(head, list);
  }
  function header(list) {
    let head = list.previousElementSibling;
    if (head && head.classList.contains("pcs-sorthead")) return head;
    head = document.createElement("div");
    head.className = "pcs-sorthead";
    for (const col of COLS) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.key = col.key;
      b.onclick = (e) => {
        e.stopPropagation();
        if (state.key !== col.key) state = { key: col.key, dir: 1 };
        else if (state.dir === 1) state = { key: col.key, dir: -1 };
        else state = { key: "", dir: 1 };
        save();
        refreshAll();
      };
      head.appendChild(b);
    }
    for (const col of COLS) {
      if (!col.resize) continue;
      const g = document.createElement("span");
      g.className = "pcs-grip";
      g.dataset.key = col.key;
      g.title = "Drag to make the " + col.label.toLowerCase() + " column wider or narrower. Double-click: normal width.";
      g.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopPropagation();
        const cell = list.querySelector(".cu-task " + col.sel);
        const start = cell ? cell.getBoundingClientRect().width : Number(widths[col.key]) || 60;
        const x0 = e.clientX;
        g.classList.add("drag");
        try { g.setPointerCapture(e.pointerId); } catch (e2) {}
        const move = (ev) => {
          widths[col.key] = Math.round(Math.max(col.min, Math.min(col.max, start + ev.clientX - x0)));
          applyWidths();
          refreshAll();
        };
        const up = () => {
          g.classList.remove("drag");
          g.removeEventListener("pointermove", move);
          try { localStorage.setItem(WKEY, JSON.stringify(widths)); } catch (e3) {}
        };
        g.addEventListener("pointermove", move);
        g.addEventListener("pointerup", up, { once: true });
        g.addEventListener("pointercancel", up, { once: true });
      });
      g.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        delete widths[col.key];
        try { localStorage.setItem(WKEY, JSON.stringify(widths)); } catch (e2) {}
        applyWidths();
        refreshAll();
      });
      head.appendChild(g);
    }
    list.before(head);
    try { new ResizeObserver(() => place(head, list)).observe(list); } catch (e) {}
    return head;
  }
  function setup(list) {
    if (!list || !list.isConnected) return;
    if (rowsOf(list).length < 2) { const h = list.previousElementSibling; if (h && h.classList.contains("pcs-sorthead")) h.remove(); return; }
    applySort(list);
    paint(header(list), list);
  }
  function lists() {
    const out = new Set();
    for (const r of document.querySelectorAll(".cu-task")) if (r.parentElement) out.add(r.parentElement);
    return [...out];
  }
  // Our own changes (header, moved rows) must not wake the observer again.
  function refreshAll() {
    busy = true;
    try { for (const l of lists()) setup(l); } finally { mo.takeRecords(); busy = false; }
  }

  // Lists are redrawn often (refresh, filter, timer ticks): set up again shortly
  // after a change (a timer, not a frame: hidden side panels draw no frames).
  let queued = false;
  // Sorted in the same frame the list was redrawn in: on a 40 ms timer the rows
  // were painted in their normal order first and jumped into the sorted order a
  // moment later, which was the dashboard's flicker on every background refresh.
  let burst = 0;
  const mo = new MutationObserver(() => {
    if (busy || queued) return;
    queued = true;
    const run = () => { queued = false; refreshAll(); };
    if (burst++ < 3) { queueMicrotask(run); setTimeout(() => { burst = 0; }, 0); } else setTimeout(run, 40);
  });
  // Keep where you were when a list is redrawn (every few minutes, or when
  // something changes): emptying and refilling a task list put its scroll box -
  // and sometimes the page - back at the top while you were reading a task.
  // Positions are noted on every scroll and put back right after the redraw,
  // before anything is painted.
  // Keyed by where the list sits (its nearest ancestor with an id + its place
  // among the lists there), because a redraw can swap in a brand-new list element.
  const lastTop = new Map();
  const listKey = (l) => { const host = (l.parentElement && l.parentElement.closest("[id]")) || document.body; return (host.id || "body") + ":" + [...host.querySelectorAll(".cu-tasklist")].indexOf(l); };
  let lastY = window.scrollY || 0, userScrollAt = 0, domAt = 0;
  const noteUser = () => { userScrollAt = Date.now(); };
  for (const ev of ["wheel", "touchmove", "keydown", "pointerdown"]) window.addEventListener(ev, noteUser, { capture: true, passive: true });
  document.addEventListener("scroll", (e) => {
    const el = e.target;
    if (el === document || el === document.documentElement || el === document.body) {
      // A redraw that makes the page shorter for an instant makes the browser
      // scroll up by itself. Taking that as "where you were" is how the position
      // used to be lost, so a scroll right after a redraw with no sign of you
      // touching anything doesn't count.
      if (!guarding && (Date.now() - domAt > 250 || Date.now() - userScrollAt < 250)) lastY = window.scrollY || 0;
      return;
    }
    if (el && el.classList && el.classList.contains("cu-tasklist") && !guarding) lastTop.set(listKey(el), el.scrollTop);
  }, true);
  let guarding = false;
  // A change worth guarding: inside a list, or a whole list added or taken away
  // (emptying the container that HOLDS the lists is the big one - that mutation
  // isn't inside a list, so it used to be ignored).
  const touchesList = (r) => {
    if (r.target && r.target.closest && r.target.closest(".cu-tasklist")) return true;
    for (const set of [r.removedNodes, r.addedNodes]) {
      for (const n of set) {
        if (!n || n.nodeType !== 1) continue;
        if (n.classList && n.classList.contains("cu-tasklist")) return true;
        if (n.querySelector && n.querySelector(".cu-tasklist")) return true;
      }
    }
    return false;
  };
  const keep = new MutationObserver((recs) => {
    if (!recs.some(touchesList)) return;
    domAt = Date.now();
    if (Date.now() - userScrollAt < 150) return; // the person is scrolling: leave it
    guarding = true;
    try {
      for (const l of document.querySelectorAll(".cu-tasklist")) {
        const want = lastTop.get(listKey(l));
        if (want > 0 && Math.abs(l.scrollTop - want) > 2) l.scrollTop = want;
      }
      if (lastY > 0 && (window.scrollY || 0) < lastY - 4) window.scrollTo(window.scrollX || 0, lastY);
    } finally { setTimeout(() => { guarding = false; }, 0); }
  });
  const start = () => { mo.observe(document.documentElement, { childList: true, subtree: true }); keep.observe(document.documentElement, { childList: true, subtree: true }); refreshAll(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.PcmTaskSort = { refresh: refreshAll };
})();

// While the lists are rebuilt for a changed setting (background: cuRebuild),
// every task list hides its old rows and says it's updating, so tasks counted
// the old way (e.g. "Spread over days" rows under "Due today") are never shown
// as if they were current. Recently completed (stored history) is left alone.
// At most 15 seconds, whatever happens: never stuck on "Updating".
(() => {
  if (typeof chrome === "undefined" || !chrome.storage) return;
  const css = document.createElement("style");
  css.textContent = `
  .cu-tasklist.pcm-rebuild > * { display: none !important; }
  .cu-tasklist.pcm-rebuild::before { content: attr(data-rebuild); display: block; padding: 16px 12px; text-align: center; color: var(--muted); font-size: 12.5px; animation: pcmRebuild 1.4s ease-in-out infinite; }
  @keyframes pcmRebuild { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }`;
  document.head.appendChild(css);
  let cur = null;
  const apply = () => {
    const on = !!(cur && Date.now() - (Number(cur.at) || 0) < 15000);
    for (const l of document.querySelectorAll(".cu-tasklist")) {
      if (l.id === "dashDoneList") continue;
      if (on) l.dataset.rebuild = "\u27F3 Updating the list for the new setting" + (cur.what ? " (" + cur.what + ")" : "") + "\u2026";
      l.classList.toggle("pcm-rebuild", on);
    }
    if (!on) cur = null;
  };
  chrome.storage.local.get("cuRebuild").then((g) => { cur = (g && g.cuRebuild) || null; apply(); }).catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.cuRebuild) { cur = ch.cuRebuild.newValue || null; apply(); } });
  // Lists drawn while it's updating get the same; the time limit is checked too.
  new MutationObserver(() => { if (cur) apply(); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(() => { if (cur) apply(); }, 1000);
})();
