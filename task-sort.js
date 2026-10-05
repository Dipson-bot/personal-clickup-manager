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
    { key: "who", label: "Who", short: "👤", shortBelow: 34, sel: ".cu-who", tip: "Assignee - sort by who it's assigned to", resize: true, min: 20, max: 140 },
    { key: "client", label: "Client", sel: ".cu-client", tip: "Sort by client", resize: true, min: 50, max: 280 },
    { key: "due", label: "Due", sel: ".cu-due", tip: "Sort by due date", resize: true, min: 36, max: 130 },
    { key: "time", label: "Time", sel: ".estpairs", tip: "Sort by estimate (then time tracked)" },
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
  function value(t, key) {
    if (!t) return null;
    if (key === "name") return low(t.name) || null;
    if (key === "who") { const a = Array.isArray(t.assignees) ? t.assignees : []; return a.length ? low(a[0] && (a[0].username || a[0].email || a[0].id)) : null; }
    if (key === "client") return low(t.client) || null;
    if (key === "due") return Number(t.dueDateMs) || null;
    if (key === "time") { const e = Number(t.estimateMs || t.totalEstimateMs || t.dayEstimateMs) || 0; const s = Number(t.spentMs) || 0; return e || s ? e * 1e6 + s / 1000 : null; }
    return null;
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
  const mo = new MutationObserver(() => {
    if (busy || queued) return;
    queued = true;
    setTimeout(() => { queued = false; refreshAll(); }, 40);
  });
  const start = () => { mo.observe(document.documentElement, { childList: true, subtree: true }); refreshAll(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.PcmTaskSort = { refresh: refreshAll };
})();
