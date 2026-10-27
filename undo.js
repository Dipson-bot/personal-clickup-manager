// Ctrl+Z for the extension: one undo history for every page (kept by the
// background in storage "undoStack", the last 20 actions, survives a reload).
//
// - Your own data (colours, pins, My notes, reminders, client notes, paused
//   clients, drafts, settings...): a change to one of the keys below is
//   recorded when YOU clicked or typed on this page just before it, so syncing
//   and the background's own writes never fill the history. Only what changed
//   is kept (the task's colour, that one reminder), so an undo never throws
//   away what was changed after it.
// - ClickUp field changes (due, start, estimate, status, priority, people) are
//   recorded by the background itself (background.js undoBefore / undoAfter).
//
// Ctrl+Z undoes the newest one, except while typing in a box (the browser's own
// text undo). After each action a small toast offers Undo; after an undo it says
// what was put back.
(() => {
  if (window.PcmUndo) return;
  // storage key -> what it holds, for the toast ("Undone: colour on Monthly Report").
  const KEYS = {
    taskColors: "colour", taskColorLabels: "colour meanings", taskPins: "pin", taskNotes: "My notes",
    reminders: "reminder", settings: "setting", clientNotes: "client notes", myPausedClients: "paused clients",
    pausedClients: "paused clients", relatedOffClients: "client setting", localTasks: "draft task",
    siteOff: "site monitor", siteSnooze: "site snooze", cnoteDismissed: "client notice", cuManualOrder: "task order", cuListOrder: "task order",
  };
  // Settings the extension writes by itself (never yours to undo).
  const SETTINGS_SKIP = new Set(["_updatedAt"]);
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } });
  let gestureAt = 0, typing = false, suppressUntil = 0;
  const mark = (e) => {
    gestureAt = Date.now();
    const t = e.target;
    typing = e.type === "input" || (e.type === "keydown" && !!t && !!t.closest && !!t.closest("input, textarea, [contenteditable=''], [contenteditable='true']") && e.key && e.key.length === 1);
  };
  for (const ev of ["pointerdown", "keydown", "change", "input", "drop"]) window.addEventListener(ev, mark, true);

  const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const idArr = (v) => Array.isArray(v) && v.every((x) => isObj(x) && x.id != null);
  // What changed in one key, as the old values needed to put it back.
  function diffOp(key, oldV, newV) {
    if (isObj(oldV) && isObj(newV)) {
      const sub = {};
      for (const k of new Set(Object.keys(oldV).concat(Object.keys(newV)))) {
        if (key === "settings" && SETTINGS_SKIP.has(k)) continue;
        if (!same(oldV[k], newV[k])) sub[k] = k in oldV ? oldV[k] : null;
      }
      const gone = Object.keys(sub).filter((k) => !(k in oldV));
      return Object.keys(sub).length ? { key, mode: "sub", sub, gone } : null;
    }
    if (idArr(oldV || []) && idArr(newV || [])) {
      const o = new Map((oldV || []).map((x, i) => [String(x.id), { x, i }])), n = new Map((newV || []).map((x) => [String(x.id), x]));
      const items = [];
      for (const id of new Set([...o.keys(), ...n.keys()])) {
        const was = o.get(id);
        if (!same(was && was.x, n.get(id))) items.push({ id, old: was ? was.x : null, at: was ? was.i : -1 });
      }
      return items.length ? { key, mode: "item", items } : null;
    }
    return same(oldV, newV) ? null : { key, mode: "whole", old: oldV === undefined ? null : oldV };
  }
  const taskName = (id) => { try { for (const r of document.querySelectorAll(".cu-task")) if (r._cuTask && String(r._cuTask.id) === String(id)) return String(r._cuTask.name || ""); } catch (e) {} return ""; };
  const nameIn = (v) => (isObj(v) && String(v.name || v.text || v.title || "").trim()) || "";
  function labelOf(ops) {
    const op = ops[0];
    const noun = KEYS[op.key] || op.key;
    let what = "", verb = "Changed";
    if (op.mode === "sub") {
      const ks = Object.keys(op.sub);
      if (op.key === "settings") return "Setting changed" + (ks.length === 1 ? " (" + ks[0] + ")" : "");
      // Keyed by task id: the task's name from its row when the value has none.
      what = ks.length === 1 ? nameIn(op.sub[ks[0]]) || nameIn(op._new && op._new[ks[0]]) || taskName(ks[0]) : ks.length + " tasks";
      if (ks.length === 1) verb = (op.gone || []).includes(ks[0]) ? "Added" : !(op._new && ks[0] in op._new) ? "Removed" : "Changed";
    } else if (op.mode === "item") {
      what = op.items.length === 1 ? nameIn(op.items[0].old) || nameIn(op.items[0]._new) : op.items.length + " items";
      if (op.items.length === 1) verb = op.items[0].old ? (op.items[0]._new ? "Changed" : "Deleted") : "Added";
    }
    return verb + " " + noun + (what ? " · " + (what.length > 60 ? what.slice(0, 59) + "…" : what) : "");
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.undoStack) onStack(ch.undoStack.newValue, ch.undoStack.oldValue);
      const now = Date.now();
      if (now < suppressUntil || now - gestureAt > 2500) return; // not from something you did here
      const ops = [];
      for (const k of Object.keys(ch)) {
        if (!(k in KEYS)) continue;
        const op = diffOp(k, ch[k].oldValue, ch[k].newValue);
        if (!op) continue;
        // Names for the label only (not sent): the new side of a change.
        if (op.mode === "sub") op._new = ch[k].newValue; else if (op.mode === "item") for (const it of op.items) it._new = (ch[k].newValue || []).find((x) => String(x.id) === it.id) || null;
        ops.push(op);
      }
      if (!ops.length) return;
      const label = labelOf(ops);
      for (const op of ops) { delete op._new; if (op.items) for (const it of op.items) delete it._new; }
      send({ type: "UNDO_PUSH", entry: { kind: "local", label, ops, typing } });
    });
  } catch (e) {}

  // ---- the toast ----
  let toast = null, toastT = 0, lastTop = "";
  function css() {
    if (document.getElementById("pcm-undo-css")) return;
    const s = document.createElement("style");
    s.id = "pcm-undo-css";
    s.textContent = ".pcm-undo{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483000;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 32px));padding:8px 10px 8px 14px;border-radius:10px;background:#1f2937;color:#f9fafb;font:13px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25)}" +
      ".pcm-undo .m{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pcm-undo.err{background:#7f1d1d}" +
      ".pcm-undo button{flex:none;border:0;border-radius:7px;padding:4px 10px;font:600 12.5px system-ui,sans-serif;cursor:pointer;background:#374151;color:#fff}.pcm-undo button.u{background:#f9fafb;color:#111827}" +
      ".pcm-undo .k{opacity:.6;font-size:11.5px;flex:none}.pcm-undo .sp{display:inline-block;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:pcmUndoSp .8s linear infinite;vertical-align:-1px;margin-right:6px}@keyframes pcmUndoSp{to{transform:rotate(360deg)}}";
    document.head.appendChild(s);
  }
  function show(text, opts) {
    opts = opts || {};
    css();
    if (!toast) { toast = document.createElement("div"); toast.setAttribute("role", "status"); document.body.appendChild(toast); }
    toast.className = "pcm-undo" + (opts.err ? " err" : "");
    toast.textContent = "";
    const m = document.createElement("span");
    m.className = "m";
    if (opts.busy) { const sp = document.createElement("span"); sp.className = "sp"; m.appendChild(sp); }
    m.append(text);
    m.title = text;
    toast.appendChild(m);
    if (opts.id) {
      const u = document.createElement("button");
      u.type = "button"; u.className = "u"; u.textContent = "Undo";
      u.onclick = () => undo(opts.id);
      const k = document.createElement("span"); k.className = "k"; k.textContent = "Ctrl+Z";
      toast.append(u, k);
    }
    const x = document.createElement("button");
    x.type = "button"; x.textContent = "✕"; x.title = "Close"; x.setAttribute("aria-label", "Close");
    x.onclick = hide;
    toast.appendChild(x);
    clearTimeout(toastT);
    if (!opts.busy) toastT = setTimeout(hide, opts.ms || 6000);
  }
  function hide() { clearTimeout(toastT); if (toast) { toast.remove(); toast = null; } }
  // A new action at the top of the history: the page you're on offers Undo.
  function onStack(list, prev) {
    const top = Array.isArray(list) && list[list.length - 1];
    const id = top ? top.id : "";
    if (!top || id === lastTop) { lastTop = id; return; }
    const was = Array.isArray(prev) && prev[prev.length - 1];
    lastTop = id;
    if (was && was.id === id) return;
    if (top.typing || !document.hasFocus() || document.hidden) return;
    show(top.label || "Changed", { id });
  }
  async function undo(id) {
    suppressUntil = Date.now() + 4000; // what the undo writes back isn't a new action
    show("Undoing…", { busy: true });
    const r = await send({ type: "UNDO_RUN", id: id || "" });
    suppressUntil = Date.now() + 1500;
    if (!r) { show("Couldn't undo - the extension didn't answer. Try again.", { err: true }); return; }
    if (r.empty) { show("Nothing to undo", { ms: 2500 }); return; }
    if (!r.ok) { show("Couldn't undo: " + (r.error || "something went wrong") + (r.kept ? " - it's still in the list, Ctrl+Z tries again." : ""), { err: true, ms: 9000 }); return; }
    show("Undone: " + (r.label || "the last change"), { ms: 4000 });
  }
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== "z") return;
    const t = e.target;
    // Typing in a box: the browser's own text undo.
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']")) return;
    e.preventDefault();
    undo("");
  });
  try { chrome.storage.local.get("undoStack").then((g) => { const l = g.undoStack; lastTop = Array.isArray(l) && l.length ? l[l.length - 1].id : ""; }).catch(() => {}); } catch (e) {}
  window.PcmUndo = { undo, show, _diffOp: diffOp, _labelOf: labelOf };
})();
