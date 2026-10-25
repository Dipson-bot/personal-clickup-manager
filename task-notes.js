// Personal notes and pins on tasks - only in this extension, never sent to
// ClickUp. Loaded after task-panel.js and lib-taskfiles.js on the options page
// and the popup / side panel.
//  - Task rows: a 📌 pin and a 📝 notes button right after the task name (faint
//    until the row is hovered; a pinned task / a task with notes keeps its mark).
//    Pinned tasks sort to the top of their list (cuPrioCmp + task-sort read
//    PcmTaskNotes.isPinned). Rows are decorated from row._cuTask, so the pages'
//    row builders don't need to know about any of this.
//  - Task details (▸): a "My notes" section like the Clients tab's notes - text
//    with clickable links, screenshots pasted / dropped / attached with
//    thumbnails that open big, edit in place, delete.
// Storage (chrome.storage.local, backed up to Drive with the other extras):
//   taskNotes: { [taskId]: { name, client, notes: [{ id, text, at, editedAt, files: [{ id, name, type, size }] }] } }
//   taskPins:  { [taskId]: pinnedAtMs }
// Attachment files live in the shared "pcm-remfiles" store (PcmFiles.attPut /
// attBlob / attCleanup), like client-note attachments - on this computer only.
(() => {
  "use strict";
  let notes = {}, pins = {};
  // ✓ Done early (storage taskEarly { [taskId]: { at, name } }): a task of a later
  // week you've already finished, still open in ClickUp until its week - marked
  // here only, so it reads as done in your plan (dimmed, ✓ done early).
  let early = {};
  let colors = {}, colorLabels = []; // 🎨 (see "your own colours on tasks" below)
  // Earlier colour swatches -> their new shade (same meaning, easier to see on every palette).
  // Older shades of the colours, moved to today's (TN_SWATCH): each one straight to its current shade.
  const TN_RESHADE = { "#dc2626": "#e5383b", "#ea580c": "#df6e0c", "#d97706": "#eab308", "#16a34a": "#1e8a44", "#0d9488": "#17a19a", "#2563eb": "#3474f4", "#7c3aed": "#9b4dec", "#db2777": "#d65cad", "#64748b": "#757575",
    "#d9480f": "#df6e0c", "#0f8a7e": "#17a19a", "#3b6fe8": "#3474f4", "#8b5cf6": "#9b4dec", "#d6338a": "#d65cad", "#6b7a90": "#757575" };
  const subs = [];
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const isImage = (f) => /^image\//.test(f.type || "") || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || "");
  const day = (ts) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  function linkify(text) {
    const s = String(text || "");
    let out = "", at = 0;
    for (const m of s.matchAll(/\bhttps?:\/\/[^\s<>"'`]+/g)) {
      let u = m[0];
      while (/[.,;:!?)\]]$/.test(u) && !(u.endsWith(")") && u.split("(").length > u.split(")").length - 1)) u = u.slice(0, -1);
      out += esc(s.slice(at, m.index)) + '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + "</a>";
      at = m.index + u.length;
    }
    return out + esc(s.slice(at));
  }

  // ---------- data ----------
  // Open "My notes" panels redraw themselves on any change (here or in another tab).
  const hosts = new Set();
  function changed() {
    for (const fn of subs) { try { fn(); } catch (e) {} }
    decorateAll();
    // After the page's own list refresh (above), which briefly takes the open
    // details panel out of the page and puts it back: redraw a moment later, and
    // forget a panel only once it has been gone for a minute.
    setTimeout(() => {
      for (const h of [...hosts]) {
        // Not while typing in it (the caret would jump away): once focus leaves.
        if (h.isConnected && h.contains(document.activeElement) && document.activeElement.closest(".md-ed")) h._tnStale = true;
        else if (h.isConnected) { try { renderPanel(h, h._tnTask); } catch (e) {} }
        else if (Date.now() - (h._tnSeen || 0) > 60000) hosts.delete(h);
      }
    }, 60);
  }
  let rems = [];
  function load() {
    try {
      chrome.storage.local.get(["taskNotes", "taskPins", "reminders", "taskEarly", "taskColors", "taskColorLabels"]).then((g) => {
        colors = g.taskColors && typeof g.taskColors === "object" ? g.taskColors : {};
        colorLabels = Array.isArray(g.taskColorLabels) ? g.taskColorLabels : [];
        if (colorLabels.some((l) => l && TN_RESHADE[String(l.color).toLowerCase()])) {
          colorLabels = colorLabels.map((l) => (l && TN_RESHADE[String(l.color).toLowerCase()] ? { ...l, color: TN_RESHADE[String(l.color).toLowerCase()] } : l));
          chrome.storage.local.set({ taskColorLabels: colorLabels }).catch(() => {});
        }
        notes = g.taskNotes && typeof g.taskNotes === "object" ? g.taskNotes : {};
        pins = g.taskPins && typeof g.taskPins === "object" ? g.taskPins : {};
        early = g.taskEarly && typeof g.taskEarly === "object" ? g.taskEarly : {};
        rems = Array.isArray(g.reminders) ? g.reminders : [];
        // "Done early" is one of the colours now (built in, green): earlier marks move over once.
        if (Object.keys(early).length) {
          const next = { ...colors };
          for (const [k, v] of Object.entries(early)) if (!next[k]) next[k] = { l: "early", note: "", at: Number(v && v.at) || Date.now(), name: String((v && v.name) || "") };
          colors = next; early = {};
          chrome.storage.local.set({ taskColors: next, taskEarly: {} }).catch(() => {});
        }
        // An older colour's "why" text becomes that task's note in My notes (once).
        const olds = Object.entries(colors).filter(([, v]) => v && v.note && !v.nid);
        if (olds.length) {
          const nextC = { ...colors }, nextN = { ...notes };
          for (const [k, v] of olds) {
            const nid = uid();
            const cur = nextN[k] && Array.isArray(nextN[k].notes) ? nextN[k].notes : [];
            nextN[k] = { name: String((nextN[k] && nextN[k].name) || v.name || ""), client: String((nextN[k] && nextN[k].client) || ""), notes: cur.map((n) => (n.c ? (({ c, ...r }) => r)(n) : n)).concat([{ id: nid, text: String(v.note), at: Number(v.at) || Date.now(), files: [], c: v.l }]) };
            nextC[k] = { l: v.l, nid, at: v.at, name: v.name || "" };
          }
          colors = nextC; notes = nextN;
          chrome.storage.local.set({ taskColors: nextC, taskNotes: nextN }).catch(() => {});
        }
        changed();
      }).catch(() => {});
    } catch (e) {}
  }
  try { chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.taskNotes || ch.taskPins || ch.reminders || ch.taskEarly || ch.taskColors || ch.taskColorLabels) load();
    // A reminder from a teammate (or one being read / dismissed here) redraws the
    // open panels too, so the list is right the moment it arrives.
    if (ch.nudgesIn || ch.nudgeSeen) loadNudges();
  }); } catch (e) {}
  // The next reminder set from a note (⏰ Remind me), if one is still to come.
  const noteRemAt = (nid) => {
    let best = 0;
    for (const r of rems) {
      if (!r || r.noteId !== nid || r.done || r.paused || r.active === false) continue;
      const at = Number(r.at) || 0;
      if (at > Date.now() && (!best || at < best)) best = at;
    }
    return best;
  };
  // A note's Markdown as one plain line (for the reminder's text).
  const plain = (md) => String(md || "").replace(/```[\s\S]*?```/g, " ").replace(/^\s*(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "").replace(/\[( |x|X)\]\s+/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1").replace(/\*\*|__|~~|`/g, "").replace(/\s+/g, " ").trim();
  load();
  loadNudges();
  const notesOf = (id) => (notes[String(id)] && Array.isArray(notes[String(id)].notes)) ? notes[String(id)].notes : [];
  const isPinned = (id) => !!pins[String(id)];
  const isEarly = (id) => !!(colors[String(id)] && colors[String(id)].l === "early");

  // ---------- reminders sent to teammates, and the ones they sent you ----------
  // SENDING: a saved note can go to a co-assignee. It travels through the Team hub
  // to THEIR extension (a desktop notification + the From teammates list below),
  // so what you see on screen here is not what they get: the note is sent as plain
  // text, capped at the 300 characters the hub accepts, and its screenshots and
  // files stay on this computer (the hub carries text, it has no file store). The
  // note itself is never in ClickUp - only the text you explicitly send, and only
  // to the person you pick.
  //
  // RECEIVING: hubPollNudges in background.js collects what teammates sent you into
  // nudgesIn (last 30, newest last) and now the two places that read it are here:
  // the From teammates section inside a task's notes, filtered to that task, and
  // the Reminders tab's own list (reminders.js reads these same helpers).
  let nudgesIn = [], nudgeSeen = {};
  // Who wants to hear about it when the list changes. The Reminders tab is a
  // separate reader on its own page and gets no redraw from `changed()` (that only
  // walks the notes panels), so it subscribes here. Fired AFTER the async read has
  // landed - a listener that redraws on the storage event alone would paint the
  // previous list, because the event arrives before the read resolves.
  const nudgeSubs = [];
  const nudgesChanged = () => { for (const fn of nudgeSubs) { try { fn(); } catch (e) {} } };
  const maxSent = (list) => list.slice(-5);
  const nudgeKey = (n) => String((n && n.id) || "") || (String((n && n.taskId) || "") + "@" + String(Number(n && n.at) || 0));
  // A nudge read on this computer stays read; the watermark is kept per nudge and
  // pruned to the nudges still in the list, so it can never grow without limit.
  const nudgeUnread = (n) => !!n && !nudgeSeen[nudgeKey(n)];
  const nudgeCount = () => nudgesIn.filter(nudgeUnread).length;
  function loadNudges() {
    try {
      chrome.storage.local.get(["nudgesIn", "nudgeSeen"]).then((g) => {
        const seen = g.nudgeSeen && typeof g.nudgeSeen === "object" ? g.nudgeSeen : {};
        const list = (Array.isArray(g.nudgesIn) ? g.nudgesIn : []).filter((n) => n && (n.id || n.taskId));
        const keys = new Set(list.map(nudgeKey));
        nudgesIn = list;
        nudgeSeen = Object.fromEntries(Object.entries(seen).filter(([k]) => keys.has(k)));
        changed();
        nudgesChanged();
      }).catch(() => {});
    } catch (e) {}
  }
  async function readNudges() {
    const g = await chrome.storage.local.get(["nudgesIn", "nudgeSeen"]).catch(() => ({}));
    return {
      list: (Array.isArray(g.nudgesIn) ? g.nudgesIn : []).filter((n) => n && (n.id || n.taskId)),
      seen: g.nudgeSeen && typeof g.nudgeSeen === "object" ? g.nudgeSeen : {},
    };
  }
  async function setNudges(list, seen) {
    const kept = (list || []).slice(-30);
    const keys = new Set(kept.map(nudgeKey));
    const s = Object.fromEntries(Object.entries(seen || nudgeSeen || {}).filter(([k]) => keys.has(k)));
    nudgesIn = kept;
    nudgeSeen = s;
    await chrome.storage.local.set({ nudgesIn: kept, nudgeSeen: s });
    changed();
    nudgesChanged();
  }
  // Opening the list marks what is in it as read (it says "3 new" until then).
  async function markNudgesRead(keys) {
    const { list, seen } = await readNudges();
    const want = keys && keys.length ? keys : list.map(nudgeKey);
    const next = { ...seen };
    let added = 0;
    for (const k of want) if (!next[k]) { next[k] = Date.now(); added++; }
    if (!added) return;
    await setNudges(list, next);
  }
  async function dismissNudge(key) {
    const { list, seen } = await readNudges();
    await setNudges(list.filter((n) => nudgeKey(n) !== String(key)), seen);
  }
  async function clearNudges() {
    await setNudges([], {});
  }
  // Done early = the built-in green colour (see "your own colours on tasks").
  function setEarly(id, on, name) {
    const cur = colors[String(id)];
    if (on) return setColor(id, "early", cur ? cur.note : "", name);
    if (cur && cur.l === "early") return setColor(id, null);
    return Promise.resolve();
  }
  async function setPin(id, on) {
    const g = await chrome.storage.local.get("taskPins").catch(() => ({}));
    const p = g.taskPins && typeof g.taskPins === "object" ? g.taskPins : {};
    if (on) p[String(id)] = Date.now(); else delete p[String(id)];
    pins = p;
    await chrome.storage.local.set({ taskPins: p });
    changed();
  }
  async function saveNotes(task, list) {
    const g = await chrome.storage.local.get("taskNotes").catch(() => ({}));
    const all = g.taskNotes && typeof g.taskNotes === "object" ? g.taskNotes : {};
    const id = String(task.id);
    if (list.length) all[id] = { name: String(task.name || (all[id] && all[id].name) || ""), client: String(task.client || task.list || (all[id] && all[id].client) || ""), notes: list.slice(0, 100) };
    else delete all[id];
    notes = all;
    await chrome.storage.local.set({ taskNotes: all });
    changed();
  }

  // ---------- styles ----------
  const css = document.createElement("style");
  css.textContent = `
  .tn-marks { display: inline-flex; align-items: center; gap: 2px; flex: none; margin-left: 2px; }
  .tn-b.tn-cmt { font-size: 10.5px; font-weight: 700; color: #b45309; background: rgba(217,119,6,.14); border-radius: 999px; padding: 0 6px; }
  .tn-b.tn-cmt.men { color: #fff; background: #dc2626; }
  .tn-b.tn-cmt[hidden] { display: none; }
  .tn-b { border: 0; background: none; cursor: pointer; padding: 0 3px; font-size: 11px; line-height: 16px; border-radius: 5px; color: var(--muted); opacity: 0; transition: opacity .12s; font-family: inherit; }
  .cu-task:hover .tn-b, .tn-b:focus-visible, .tn-b.on { opacity: 1; }
  .tn-b:hover { background: var(--bg2, rgba(0,0,0,.06)); color: var(--text); }
  .cu-task:has(> .tn-cbar) { position: relative; }
  /* the bar sits in the gap after the drag grip (or at the very left without one); 8px wide to hover, 4px drawn */
  .tn-cbar { position: absolute; top: 3px; bottom: 3px; left: 0; width: 8px; z-index: 1; cursor: help; }
  /* thin (3px, a hairline edge so yellow still shows on white); the 8px around it is what you hover */
  .tn-cbar::before { content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 3px; border-radius: 2px; background: var(--tn-c); box-shadow: 0 0 0 0.5px rgba(0,0,0,.35); }
  html[data-theme="dark"] .tn-cbar::before { box-shadow: 0 0 0 0.5px rgba(255,255,255,.35); }
  .cu-task:has(> .cu-drag) > .tn-cbar { left: 15px; }
  /* the tint: visible on every palette - stronger on dark ones, where a light wash disappears */
  .cu-task.tn-colored { background-image: linear-gradient(90deg, color-mix(in srgb, var(--tn-c) 18%, transparent), color-mix(in srgb, var(--tn-c) 8%, transparent)); }
  html[data-theme="dark"] .cu-task.tn-colored { background-image: linear-gradient(90deg, color-mix(in srgb, var(--tn-c) 30%, transparent), color-mix(in srgb, var(--tn-c) 14%, transparent)); }
  .tn-cls { border: 1px solid var(--border); background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; white-space: nowrap; }
  .tn-cls.on { color: #b45309; border-color: rgba(217,119,6,.5); background: rgba(245,158,11,.1); }
  .tn-note-i.tn-note-col { border-left: 4px solid var(--tn-c) !important; background-image: linear-gradient(90deg, color-mix(in srgb, var(--tn-c) 10%, transparent), transparent 70%); }
  .tn-ncl { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 700; color: var(--muted); margin-bottom: 3px; }
  .tn-ncl i { width: 9px; height: 9px; border-radius: 50%; background: var(--tn-c); }
  textarea.tn-cpnote { resize: vertical; min-height: 38px; font-family: inherit; }
  .tn-cpskip { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--muted); cursor: pointer; }
  .tn-cpop { position: fixed; z-index: 2147483000; width: 250px; box-sizing: border-box; padding: 10px; border-radius: 12px; border: 1px solid var(--border); background: var(--card, #fff); color: var(--text); box-shadow: 0 14px 34px rgba(0,0,0,.22); font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
  .tn-cph { display: flex; align-items: center; font-weight: 700; }
  .tn-cph .sp { flex: 1; }
  .tn-cpx { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 12px; }
  .tn-cphint { color: var(--muted); font-size: 11.5px; }
  .tn-cl { display: flex; align-items: center; gap: 4px; }
  .tn-clb { flex: 1; display: flex; align-items: center; gap: 7px; text-align: left; border: 1px solid transparent; background: none; color: var(--text); font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 7px; cursor: pointer; }
  .tn-clb:hover, .tn-cl.on .tn-clb { background: var(--bg2, rgba(0,0,0,.05)); border-color: var(--border); }
  .tn-cl.on .tn-clb { font-weight: 700; }
  .tn-clb i { width: 11px; height: 11px; border-radius: 50%; flex: none; }
  .tn-cle { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 12px; padding: 2px 5px; border-radius: 5px; }
  .tn-cle:hover { color: var(--indigo, #6366f1); background: rgba(99,102,241,.1); }
  .tn-cledit { display: flex; flex-direction: column; gap: 6px; padding: 6px; border: 1px solid var(--indigo, #6366f1); border-radius: 8px; }
  .tn-cledit .tn-cename { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 5px 7px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg, #fff); color: var(--text); }
  .tn-cledit .tn-cprow { align-items: center; flex-wrap: wrap; }
  .tn-cld { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 11px; padding: 2px 5px; border-radius: 5px; }
  .tn-cld:hover { color: var(--red, #dc2626); background: rgba(220,38,38,.08); }
  .tn-cpnote, .tn-cpname { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 5px 7px; border: 1px solid var(--border); border-radius: 7px; background: var(--bg, #fff); color: var(--text); }
  .tn-cpnew { border-top: 1px solid var(--border); padding-top: 7px; display: flex; flex-direction: column; gap: 6px; }
  .tn-sw { display: flex; gap: 5px; flex-wrap: wrap; }
  .tn-sw button { width: 18px; height: 18px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; padding: 0; }
  .tn-sw button.on { border-color: var(--text); box-shadow: 0 0 0 2px var(--card, #fff) inset; }
  .tn-cprow { display: flex; gap: 6px; }
  .tn-cpoff { align-self: flex-start; }
  .tn-pin { filter: grayscale(1); }
  .tn-pin.on { filter: none; }
  .tn-note.on { color: var(--indigo, #6366f1); font-weight: 700; }
  .tn-sec { display: flex; flex-direction: column; gap: 8px; }
  .tn-sec .tn-h { display: flex; align-items: center; gap: 8px; }
  .tn-sec .tn-h .sp { flex: 1; }
  .tn-sec .tn-priv { font-size: 10.5px; color: var(--muted); font-weight: 500; text-transform: none; letter-spacing: 0; }
  .tn-note-i { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--card); }
  .tn-note-i.editing { border-color: var(--indigo, #6366f1); }
  .tn-txt { white-space: pre-wrap; line-height: 1.5; overflow-wrap: anywhere; font-size: 12.5px; }
  .tn-txt a { color: var(--indigo, #6366f1); }
  .tn-meta { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11px; color: var(--muted); }
  .tn-meta .sp { flex: 1; }
  .tn-btn { font: inherit; font-size: 11px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); cursor: pointer; }
  .tn-btn:hover { border-color: var(--indigo, #6366f1); color: var(--indigo, #6366f1); }
  .tn-btn.pri { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
  .tn-ta { width: 100%; box-sizing: border-box; min-height: 54px; resize: vertical; font: inherit; font-size: 12.5px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--card); color: var(--text); }
  .tn-ta:focus { outline: none; border-color: var(--indigo, #6366f1); }
  .tn-drop { outline: 2px dashed var(--indigo, #6366f1); outline-offset: 3px; }
  .tn-shots { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .tn-shot { position: relative; width: 92px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; cursor: zoom-in; background: var(--bg2, rgba(0,0,0,.04)); }
  .tn-shot img { display: block; width: 100%; height: 62px; object-fit: cover; }
  .tn-shot .n { display: block; font-size: 10px; padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--muted); }
  .tn-shot.gone img { display: none; } .tn-shot.gone::before { content: "not on this computer"; display: block; height: 62px; font-size: 10px; color: var(--muted); padding: 6px; box-sizing: border-box; }
  .tn-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 2px 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); cursor: pointer; max-width: 220px; }
  .tn-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tn-x { position: absolute; top: 2px; right: 2px; border: 0; border-radius: 50%; width: 18px; height: 18px; font-size: 10px; background: rgba(0,0,0,.6); color: #fff; cursor: pointer; }
  .tn-chip .tn-x { position: static; background: none; color: var(--muted); width: auto; height: auto; }
  .tn-light { position: fixed; inset: 0; z-index: 2147483000; background: rgba(0,0,0,.75); display: flex; align-items: center; justify-content: center; padding: 24px; }
  .tn-light[hidden] { display: none; }
  .tn-light .bx { max-width: 100%; max-height: 100%; display: flex; flex-direction: column; gap: 8px; }
  .tn-light img { max-width: calc(100vw - 48px); max-height: calc(100vh - 100px); object-fit: contain; border-radius: 6px; background: #fff; }
  .tn-light .bar { display: flex; gap: 8px; align-items: center; color: #fff; font-size: 12px; }
  .tn-light .bar .sp { flex: 1; }
  .tn-msg { font-size: 11px; color: var(--amber, #d97706); }
  .tn-remchip { font: inherit; font-size: 10.5px; padding: 1px 7px; border: 1px solid var(--amber, #d97706); border-radius: 10px; background: none; color: var(--amber, #d97706); cursor: pointer; }
  .tn-remchip:hover { background: rgba(217,119,6,.1); }
  /* The "send this note to …" picker, and the list of what teammates sent you. */
  .tn-pop { position: fixed; z-index: 2147483000; width: 320px; max-width: calc(100vw - 16px); box-sizing: border-box; padding: 10px 12px; border-radius: 10px; background: var(--card, #fff); color: var(--fg, #111); border: 1px solid var(--line, rgba(0,0,0,.15)); box-shadow: 0 10px 30px rgba(0,0,0,.28); font-size: 12.5px; display: flex; flex-direction: column; gap: 7px; }
  .tn-pop-h { font-weight: 600; font-size: 12px; }
  .tn-pop-msg { font-size: 11.5px; color: var(--muted, #6b7280); line-height: 1.4; }
  .tn-pop-msg.ok { color: #15803d; }
  .tn-pop-msg.err { color: #b91c1c; }
  .tn-pop-r { display: flex; align-items: center; gap: 7px; }
  .tn-pop-av { width: 22px; height: 22px; flex: none; border-radius: 50%; color: #fff; font-size: 10px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
  .tn-pop-n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tn-pop-b { font: inherit; font-size: 11.5px; padding: 2px 10px; border: 1px solid var(--line, rgba(0,0,0,.2)); border-radius: 6px; background: none; color: inherit; cursor: pointer; }
  .tn-pop-b:hover { background: rgba(0,0,0,.06); }
  .tn-pop-b.go { border-color: #2563eb; color: #2563eb; }
  .tn-pop-b:disabled { opacity: .55; cursor: default; }
  .tn-inbox { margin-top: 10px; border-top: 1px dashed var(--line, rgba(0,0,0,.15)); padding-top: 6px; }
  .tn-inbox .tn-new { font-size: 10.5px; font-weight: 600; color: #b91c1c; }
  .tn-unread { border-left: 3px solid #b91c1c; padding-left: 7px; }
  `;
  document.head.appendChild(css);

  // ---------- unread comments (background scanComments) ----------
  // A comment by someone else newer than when you last opened the task's
  // details (and under 60 days old) is unread; one that @mentions you is marked.
  let cmtCache = {}, cmtSeen = {};
  function unreadOf(id) {
    const c = cmtCache[String(id)];
    if (!c || !Array.isArray(c.list)) return { n: 0, mention: false, latest: null };
    const since = Math.max(Number(cmtSeen[String(id)]) || 0, Date.now() - 60 * 86400000);
    const fresh = c.list.filter((x) => x.at > since);
    return { n: fresh.length, mention: fresh.some((x) => x.mention), latest: fresh[0] || null, task: c };
  }
  function unreadAll() {
    return Object.keys(cmtCache).map((id) => ({ id, ...unreadOf(id) })).filter((x) => x.n > 0).sort((a, b) => (b.mention - a.mention) || (b.latest.at - a.latest.at));
  }
  try {
    chrome.storage.local.get(["cuComments", "cuCommentSeen"]).then((g) => { cmtCache = g.cuComments || {}; cmtSeen = g.cuCommentSeen || {}; decorateAll(); }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local" || (!ch.cuComments && !ch.cuCommentSeen)) return;
      if (ch.cuComments) cmtCache = ch.cuComments.newValue || {};
      if (ch.cuCommentSeen) cmtSeen = ch.cuCommentSeen.newValue || {};
      decorateAll();
    });
  } catch (e) {}
  window.PcmComments = { unreadOf, unreadAll, markRead: (ids) => new Promise((ok) => { try { chrome.runtime.sendMessage({ type: "COMMENTS_SEEN", taskIds: [].concat(ids) }, () => { void chrome.runtime.lastError; ok(); }); } catch (e) { ok(); } }) };


  // ---------- 🎨 your own colours on tasks ----------
  // A colour with a meaning you give it once ("Can't do yet", "Waiting on the
  // client"...), put on any task with an optional note of why - a bar down the row
  // and a chip with the colour's name (the note on hover). Only in this extension.
  // storage taskColorLabels: [{ id, color, name }] · taskColors: { [taskId]: { l, note, at, name } }
  // Picked to show on every palette: each (but yellow) stands out at least 3:1 on
  // every light and dark palette's cards (Nord, the lightest dark one, included); every bar also gets a thin edge (dark on
  // light themes, light on dark ones), which carries the bright yellow. No amber -
  // it looked like the old pinned mark. And as far apart from each other as that
  // allows (no two closer than about 37 in CIELAB; red and orange were 21), so
  // two colours are never mistaken for each other. A colour already given a
  // meaning (Done early's green included) isn't offered again.
  const TN_SWATCH = ["#e5383b", "#df6e0c", "#eab308", "#1e8a44", "#17a19a", "#3474f4", "#9b4dec", "#d65cad", "#9b6e3b", "#757575"];
  const TN_SWNAME = { "#e5383b": "Red", "#df6e0c": "Orange", "#eab308": "Yellow", "#1e8a44": "Green", "#17a19a": "Teal", "#3474f4": "Blue", "#9b4dec": "Violet", "#d65cad": "Pink", "#9b6e3b": "Brown", "#757575": "Grey" };
  // The swatches no other colour uses yet (except: the one being edited keeps its own).
  const freeSwatches = (except) => {
    const used = new Set(allLabels().filter((l) => l && l.id !== except).map((l) => String(l.color).toLowerCase()));
    return TN_SWATCH.filter((c) => !used.has(c));
  };
  const swatchRow = (list, attr, cur) => '<div class="tn-sw">' + list.map((c) => '<button type="button" ' + attr + '="' + c + '" style="background:' + c + '"' + (c === cur ? ' class="on"' : "") + ' title="' + (TN_SWNAME[c] || c) + '" aria-label="' + (TN_SWNAME[c] || c) + '"></button>').join("") + "</div>";
  // A colour with skip: true is left out of planning: its tasks' guessed time isn't
  // added to "with guesses", the 7h day gauge or Fill to 7h (they can't be done yet).
  const TN_PRESETS = [["#e5383b", "Can't do yet", true], ["#eab308", "Waiting on the client", true], ["#3474f4", "Ask the team", false]];
  const TN_EARLY = { id: "early", color: "#1e8a44", name: "Done early", builtin: true, skip: false };
  const allLabels = () => [TN_EARLY].concat(colorLabels.filter((l) => l && l.id !== "early"));
  const labelOf = (lid) => allLabels().find((l) => l.id === lid) || null;
  let colorPop = null;
  function closeColorPop() { if (colorPop) { colorPop.remove(); colorPop = null; } }
  async function saveColors(next) { colors = next; await chrome.storage.local.set({ taskColors: next }); changed(); }
  async function saveLabels(next) { colorLabels = next; await chrome.storage.local.set({ taskColorLabels: next }); changed(); }
  // A colour's reason is one of the task's My notes (one and the same note): the
  // task's entry links it (nid) and the note carries the colour (c). text: the
  // reason typed in the 🎨 box (undefined = leave the note as it is); opts.nid: link
  // this existing note (its 🎨 in My notes). Removing the colour keeps the note.
  async function setColor(id, labelId, text, name, opts) {
    id = String(id);
    const next = { ...colors };
    const prev = next[id];
    let list = notesOf(id).slice();
    const has = (n) => !!n && list.some((x) => x.id === n);
    let nid = opts && has(opts.nid) ? opts.nid : prev && has(prev.nid) ? prev.nid : "";
    let touched = false;
    // Only one note carries the task's colour.
    if (list.some((n) => n.c && n.id !== nid)) { list = list.map((n) => (n.c && n.id !== nid ? (({ c, ...r }) => r)(n) : n)); touched = true; }
    const taskName = String(name || (prev && prev.name) || (notes[id] && notes[id].name) || "");
    if (labelId) {
      const t = typeof text === "string" ? text.trim() : "";
      if (t && nid) { const cur = list.find((n) => n.id === nid); if (cur.text !== t || cur.c !== labelId) { list = list.map((n) => (n.id === nid ? { ...n, text: t.slice(0, 20000), c: labelId, editedAt: cur.text !== t ? Date.now() : n.editedAt } : n)); touched = true; } }
      else if (t) { nid = uid(); list.push({ id: nid, text: t.slice(0, 20000), at: Date.now(), files: [], c: labelId }); touched = true; }
      else if (nid && list.find((n) => n.id === nid).c !== labelId) { list = list.map((n) => (n.id === nid ? { ...n, c: labelId } : n)); touched = true; }
      next[id] = { l: labelId, nid, at: Date.now(), name: taskName };
    } else {
      if (nid) { list = list.map((n) => (n.id === nid ? (({ c, ...r }) => r)(n) : n)); touched = true; }
      delete next[id];
    }
    if (touched) await saveNotes({ id, name: taskName }, list);
    return saveColors(next);
  }
  // The note that gives a task's colour its reason (or null).
  const colorNote = (id) => { const c = colors[String(id)]; return c && c.nid ? notesOf(id).find((n) => n.id === c.nid) || null : null; };
  function openColorPop(btn, id, task, opts) {
    opts = opts || {};
    closeColorPop();
    const pop = document.createElement("div");
    pop.className = "tn-cpop";
    let picked = TN_SWATCH[0];
    // ✎ on one of your colours: rename it / pick another colour, in place.
    let editing = "", editColor = "";
    const draw = () => {
      const cur = colors[String(id)];
      const labels = colorLabels;
      // What's typed in the Why box stays when the picker redraws (an edit, a toggle).
      const typed = pop.querySelector(".tn-cpnote") ? pop.querySelector(".tn-cpnote").value : null;
      const free = freeSwatches();
      if (!free.includes(picked)) picked = free[0] || "";
      pop.innerHTML = '<div class="tn-cph">Colour this task <span class="sp"></span><button type="button" class="tn-cpx" data-x title="Close">✕</button></div>' +
        allLabels().map((l) => editing === l.id
          ? '<div class="tn-cledit"><input type="text" class="tn-cename" maxlength="40" value="' + esc(l.name) + '" aria-label="The colour\u2019s meaning" />' +
            swatchRow(freeSwatches(l.id), "data-esw", editColor) +
            '<div class="tn-cprow"><button type="button" class="tn-btn pri" data-esave>Save</button><button type="button" class="tn-btn" data-ecancel>Cancel</button><span class="tn-cphint">Every task in this colour changes with it.</span></div></div>'
          : '<div class="tn-cl' + (cur && cur.l === l.id ? " on" : "") + '"><button type="button" class="tn-clb" data-l="' + esc(l.id) + '"><i style="background:' + esc(l.color) + '"></i>' + esc(l.name) + (cur && cur.l === l.id ? " \u2713" : "") + "</button>" +
          (l.builtin ? "" : '<button type="button" class="tn-cls' + (l.skip ? " on" : "") + '" data-skip="' + esc(l.id) + '" title="' + (l.skip ? "Left out of planning: its tasks\u2019 guessed time isn\u2019t counted (with guesses, the 7h gauge, Fill to 7h). Click to count them again." : "Counted in planning. Click to leave its tasks\u2019 guessed time out (for tasks that can\u2019t be done yet).") + '">' + (l.skip ? "\u2298 not counted" : "counted") + "</button>" +
          '<button type="button" class="tn-cle" data-edit="' + esc(l.id) + '" title="Edit this colour: its name or colour (every task in it follows)">\u270E</button>' +
          '<button type="button" class="tn-cld" data-del="' + esc(l.id) + '" title="Delete this colour (it comes off every task)">\u2715</button>') + "</div>").join("") +
        (labels.length ? "" : '<div class="tn-cphint">Or make one for what it means, e.g.</div>' + TN_PRESETS.map(([c, n, sk]) => '<button type="button" class="tn-clb tn-pre" data-pre="' + esc(c) + "|" + esc(n) + "|" + (sk ? 1 : 0) + '"><i style="background:' + c + '"></i>' + esc(n) + (sk ? ' <span class="tn-cphint">(not counted in plans)</span>' : "") + "</button>").join("")) +
        '<textarea class="tn-cpnote" rows="2" maxlength="20000" placeholder="Why - saved as a note in My notes (optional)">' + esc(opts.nid ? ((notesOf(id).find((n) => n.id === opts.nid) || {}).text || "") : colorNote(id) ? colorNote(id).text : "") + "</textarea>" +
        '<div class="tn-cphint">' + (opts.nid || colorNote(id) ? "This is the task\u2019s note in My notes - edit it here or there." : "What you type becomes a note in My notes, in this colour.") + "</div>" +
        (free.length
          ? '<div class="tn-cpnew">' + swatchRow(free, "data-sw", picked) +
            '<div class="tn-cprow"><input type="text" class="tn-cpname" maxlength="40" placeholder="New colour\u2019s meaning" /><button type="button" class="tn-btn pri" data-add>Add</button></div>' +
            '<label class="tn-cpskip"><input type="checkbox" class="tn-cpsk" /> Leave its tasks out of planning (can\u2019t be done yet)</label>' +
            (free.length < TN_SWATCH.length ? '<div class="tn-cphint">Colours that already have a meaning aren\u2019t offered again.</div>' : "") + "</div>"
          : '<div class="tn-cpnew"><div class="tn-cphint">Every colour has a meaning now. To add another, \u270E change one of yours or \u2715 delete one you don\u2019t use.</div></div>') +
        (cur ? '<button type="button" class="tn-btn tn-cpoff" data-off>Remove the colour</button>' : "");
      if (typed != null && pop.querySelector(".tn-cpnote")) pop.querySelector(".tn-cpnote").value = typed;
      if (editing) { const ei = pop.querySelector(".tn-cename"); if (ei) { ei.focus(); ei.select(); } }
    };
    const saveEdit = async () => {
      const ei = pop.querySelector(".tn-cename");
      const nm = ei ? ei.value.trim() : "";
      if (!nm) { if (ei) ei.focus(); return; }
      const lid = editing;
      editing = "";
      await saveLabels(colorLabels.map((l) => (l.id === lid ? { ...l, name: nm.slice(0, 40), color: editColor || l.color } : l)));
      draw();
    };
    const noteOf = () => { const n = pop.querySelector(".tn-cpnote"); return n ? n.value.trim() : ""; };
    const name = (task && task.name) || "";
    pop.addEventListener("mousedown", (e) => e.stopPropagation());
    pop.addEventListener("click", async (e) => {
      e.stopPropagation();
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-x")) { closeColorPop(); return; }
      if (b.dataset.sw) { picked = b.dataset.sw; pop.querySelectorAll("[data-sw]").forEach((x) => x.classList.toggle("on", x.dataset.sw === picked)); return; }
      if (b.dataset.l) { await setColor(id, b.dataset.l, noteOf(), name, opts); closeColorPop(); return; }
      if (b.dataset.edit) { const l = colorLabels.find((x) => x.id === b.dataset.edit); if (l) { editing = l.id; editColor = l.color; draw(); } return; }
      if (b.dataset.esw) { editColor = b.dataset.esw; pop.querySelectorAll("[data-esw]").forEach((x) => x.classList.toggle("on", x.dataset.esw === editColor)); return; }
      if (b.hasAttribute("data-esave")) { await saveEdit(); return; }
      if (b.hasAttribute("data-ecancel")) { editing = ""; draw(); return; }
      if (b.dataset.skip) { const lid = b.dataset.skip; await saveLabels(colorLabels.map((l) => (l.id === lid ? { ...l, skip: !l.skip } : l))); draw(); return; }
      if (b.dataset.del) {
        const lid = b.dataset.del;
        await saveLabels(colorLabels.filter((l) => l.id !== lid));
        const next = { ...colors }; for (const k of Object.keys(next)) if (next[k] && next[k].l === lid) delete next[k];
        for (const k of Object.keys(notes)) { const ls = notesOf(k); if (ls.some((n) => n.c === lid)) await saveNotes({ id: k, name: notes[k].name }, ls.map((n) => (n.c === lid ? (({ c, ...r }) => r)(n) : n))); }
        await saveColors(next); draw(); return;
      }
      const make = async (c, n, sk) => { const l = { id: "c" + Date.now().toString(36), color: c, name: n, skip: !!sk }; await saveLabels(colorLabels.concat([l])); await setColor(id, l.id, noteOf(), name, opts); closeColorPop(); };
      if (b.dataset.pre) { const [c, n, sk] = b.dataset.pre.split("|"); if (!freeSwatches().includes(c)) { draw(); return; } await make(c, n, sk === "1"); return; }
      if (b.hasAttribute("data-add")) { const n = pop.querySelector(".tn-cpname").value.trim(); if (!n) { pop.querySelector(".tn-cpname").focus(); return; } if (!picked || !freeSwatches().includes(picked)) { draw(); return; } await make(picked, n, pop.querySelector(".tn-cpsk") && pop.querySelector(".tn-cpsk").checked); return; }
      if (b.hasAttribute("data-off")) { await setColor(id, null); closeColorPop(); }
    });
    pop.addEventListener("keydown", async (e) => {
      // In an edit: Enter saves it, Esc cancels just the edit (the picker stays).
      if (editing && e.target.classList.contains("tn-cename")) {
        if (e.key === "Enter") { e.preventDefault(); await saveEdit(); return; }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editing = ""; draw(); return; }
      }
      if (e.key === "Escape") { closeColorPop(); return; }
      if (e.key !== "Enter") return;
      if (e.target.classList.contains("tn-cpname")) pop.querySelector("[data-add]").click();
      else if (e.target.classList.contains("tn-cpnote") && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const cur = colors[String(id)]; if (cur) { await setColor(id, cur.l, noteOf(), name, opts); closeColorPop(); } }
    });
    // A changed note on a task that already has a colour is kept when you leave the box.
    pop.addEventListener("change", (e) => { if (e.target.classList.contains("tn-cpnote")) { const cur = colors[String(id)]; if (cur) setColor(id, cur.l, noteOf(), name, opts); } });
    draw();
    document.body.appendChild(pop);
    colorPop = pop;
    const r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left - 20)) + "px";
    pop.style.top = (r.bottom + pop.offsetHeight + 8 > window.innerHeight ? Math.max(8, r.top - pop.offsetHeight - 6) : r.bottom + 6) + "px";
    const f = pop.querySelector(colorLabels.length ? ".tn-cpnote" : ".tn-pre"); if (f) f.focus();
  }
  document.addEventListener("mousedown", () => closeColorPop());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeColorPop(); });

  // ---------- task rows: 📌 + 📝 ----------
  let focusNotesFor = "";
  function decorate(row) {
    const t = row && row._cuTask;
    const wrap = row && row.querySelector(".nmwrap");
    if (!t || t.id == null || !wrap || /^rev-/.test(String(t.id))) return;
    const id = String(t.id);
    let box = wrap.querySelector(".tn-marks");
    if (!box) {
      box = document.createElement("span");
      box.className = "tn-marks";
      box.innerHTML = '<button type="button" class="tn-b tn-cmt" hidden></button><button type="button" class="tn-b tn-color"></button><button type="button" class="tn-b tn-pin"></button><button type="button" class="tn-b tn-note"></button>';
      const nm = wrap.querySelector(".nm");
      if (nm && nm.nextSibling) wrap.insertBefore(box, nm.nextSibling); else wrap.appendChild(box);
      box.querySelector(".tn-pin").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setPin(id, !isPinned(id)); });
      box.querySelector(".tn-color").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); if (colorPop) { closeColorPop(); return; } openColorPop(e.currentTarget, id, row._cuTask); });
      box.querySelector(".tn-color").addEventListener("mousedown", (e) => e.stopPropagation());
      // 💬: open the task's details - its comments are there (and that marks them read).
      box.querySelector(".tn-cmt").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const chev = row.querySelector(".pcm-chev");
        const TP = window.PcmTaskPanel;
        if (chev && chev.getAttribute("aria-expanded") !== "true") { if (TP && TP.wantTab) TP.wantTab("cmt"); chev.click(); }
        else { if (TP && TP.showTab) TP.showTab("cmt"); window.PcmComments.markRead(id); }
      });
      box.querySelector(".tn-note").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        focusNotesFor = id;
        const chev = row.querySelector(".pcm-chev");
        const open = chev && chev.getAttribute("aria-expanded") === "true";
        const TP = window.PcmTaskPanel;
        // The details are tabs now: open them on My notes (the notes were hidden in
        // another tab, so this click used to do nothing visible).
        if (chev && !open) { if (TP && TP.wantTab) TP.wantTab("notes"); chev.click(); }
        else { if (TP && TP.showTab) TP.showTab("notes"); focusPanelNotes(); }
      });
    }
    const pinOn = isPinned(id), n = notesOf(id).length;
    const pb = box.querySelector(".tn-pin"), nb = box.querySelector(".tn-note");
    // Only write what changed: any textContent write is a DOM change, and this
    // runs from a MutationObserver - rewriting the same text re-woke it forever.
    if (pb.textContent !== "📌") pb.textContent = "📌";
    pb.classList.toggle("on", pinOn);
    pb.title = pinOn ? "Pinned - it stays at the top. Click to unpin." : "Pin this task to the top of the list (only in this extension)";
    pb.setAttribute("aria-pressed", String(pinOn));
    const nt = n ? "📝 " + n : "📝";
    if (nb.textContent !== nt) nb.textContent = nt;
    nb.classList.toggle("on", n > 0);
    nb.title = n ? n + " personal note" + (n === 1 ? "" : "s") + " - click to read or add (only in this extension, not in ClickUp)" : "Add a personal note (only in this extension, not in ClickUp)";
    row.classList.toggle("tn-pinned", pinOn);
    {
      // 🎨 your colour (Done early included): no chip on the row - a bar between the
      // grip and ▸ with the meaning and note on hover, and a faint tint. A pinned
      // task without a colour gets an amber bar (pinned).
      const c = colors[id], lab = c ? labelOf(c.l) : null;
      const cb2 = box.querySelector(".tn-color");
      if (cb2) {
        if (cb2.textContent !== "\uD83C\uDFA8") cb2.textContent = "\uD83C\uDFA8";
        const tt = lab ? "Colour: " + lab.name + ". Click to change it or its note." : "Colour this task with a meaning of your own (Done early, Can't do yet...) and a note - only in this extension";
        if (cb2.title !== tt) cb2.title = tt;
      }
      // (A pinned task shows its 📌; it has no bar, so no colour means "pinned".)
      const cn = lab ? colorNote(id) : null, reason = cn ? plain(cn.text).replace(/\s+/g, " ").trim().slice(0, 160) : c && c.note ? c.note : "";
      const why = lab ? lab.name + (reason ? " - " + reason : "") + (lab.skip ? " (left out of planning)" : "") + " \u00b7 your colour, only in this extension" : "";
      const colour = lab ? lab.color : "";
      let bar = row.querySelector(":scope > .tn-cbar");
      if (colour) {
        if (!bar) { bar = document.createElement("span"); bar.className = "tn-cbar"; row.appendChild(bar); }
        if (bar.title !== why) bar.title = why;
        bar.style.setProperty("--tn-c", colour);
      } else if (bar) bar.remove();
      row.classList.toggle("tn-colored", !!lab);
      if (lab) row.style.setProperty("--tn-c", lab.color); else row.style.removeProperty("--tn-c");
    }
    const u = unreadOf(id), cb = box.querySelector(".tn-cmt");
    if (cb) {
      const ct = u.n ? (u.mention ? "@" : "💬") + " " + u.n : "";
      if (cb.textContent !== ct) cb.textContent = ct;
      if (cb.hidden !== !u.n) cb.hidden = !u.n;
      cb.classList.toggle("men", u.mention);
      const tt = u.n ? u.n + " comment" + (u.n === 1 ? "" : "s") + " you haven't read" + (u.mention ? ", mentioning you" : "") + (u.latest ? " - latest from " + u.latest.who + ": “" + u.latest.text.slice(0, 120) + "”" : "") + ". Click to read them." : "";
      if (cb.title !== tt) cb.title = tt;
    }
  }
  function decorateAll() { document.querySelectorAll(".cu-task").forEach(decorate); }
  let pending = 0;
  // Chips added in the same frame the rows were drawn (a timer let the bare rows show first).
  let burst = 0;
  new MutationObserver(() => {
    if (pending) return;
    pending = 1;
    const run = () => { pending = 0; decorateAll(); };
    if (burst++ < 3) { queueMicrotask(run); setTimeout(() => { burst = 0; }, 0); } else setTimeout(run, 30);
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ---------- lightbox ----------
  const light = document.createElement("div");
  light.className = "tn-light"; light.hidden = true;
  light.innerHTML = '<div class="bx"><img alt="" /><div class="bar"><span class="nm"></span><span class="sp"></span><button type="button" class="tn-btn" data-tab>Open in a new tab</button><button type="button" class="tn-btn" data-x>✕ Close</button></div></div>';
  let lightUrl = "", lightBlob = null;
  const closeLight = () => { light.hidden = true; if (lightUrl) URL.revokeObjectURL(lightUrl); lightUrl = ""; lightBlob = null; };
  light.addEventListener("click", (e) => {
    if (e.target.closest("[data-tab]") && lightBlob) { const u = URL.createObjectURL(lightBlob); window.open(u, "_blank"); setTimeout(() => URL.revokeObjectURL(u), 60000); return; }
    if (e.target.closest("[data-x]") || e.target === light) closeLight();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !light.hidden) { e.preventDefault(); e.stopPropagation(); closeLight(); } }, true);
  const ensureLight = () => { if (!light.isConnected) document.body.appendChild(light); };
  async function blobOf(f, pendingList) {
    const p = (pendingList || []).find((x) => x.id === f.id && x.blob);
    if (p) return p.blob;
    try { return window.PcmFiles ? await window.PcmFiles.attBlob({ id: f.id }) : null; } catch (e) { return null; }
  }

  // ---------- "My notes" in the task details ----------
  function focusPanelNotes() {
    const sec = document.querySelector(".tn-sec");
    if (!sec) return false;
    try { sec.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
    const ed = sec.querySelector(".tn-new .md-ed");
    if (ed && ed.focusEnd) ed.focusEnd();
    focusNotesFor = "";
    return true;
  }
  function filesHtml(list, removable) {
    const shots = list.filter(isImage), rest = list.filter((f) => !isImage(f));
    const x = removable ? '<button type="button" class="tn-x" data-rm title="Take this file off">✕</button>' : "";
    return (shots.length ? '<div class="tn-shots">' + shots.map((f) => '<span class="tn-shot" data-fid="' + esc(f.id) + '" title="' + esc(f.name) + '"><img data-thumb="' + esc(f.id) + '" alt="' + esc(f.name) + '"/><span class="n">' + esc(f.name) + "</span>" + x + "</span>").join("") + "</div>" : "") +
      (rest.length ? '<div class="tn-shots">' + rest.map((f) => '<span class="tn-chip" data-fid="' + esc(f.id) + '" title="' + esc(f.name) + '"><span>📎 ' + esc(f.name) + "</span>" + x + "</span>").join("") + "</div>" : "");
  }
  // ---------- sending a note to a co-assignee ----------
  // The people on the task, minus me: `assigneePeople` comes from the task panel
  // (id + name); a row built without it (a local task, or the moment before the
  // panel loads) falls back to the plain name list, which can still be offered by
  // name - ClickUp only needs the id, so without one the person is left out.
  function teammatesOf(d) {
    const me = d && d.meUserId != null ? String(d.meUserId) : "";
    const people = Array.isArray(d && d.assigneePeople) ? d.assigneePeople.filter((p) => p && p.id) : [];
    return people.filter((p) => !me || String(p.id) !== me);
  }
  const sentText = (n) => plain(n.text).slice(0, 300);
  // One message to the background worker, with a timeout: a send that hangs must
  // come back as a failure, not leave the button spinning forever.
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
  const ini = (name) => {
    const w = String(name || "").split("@")[0].replace(/[._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
    if (!w.length) return "?";
    return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
  };
  const iniColor = (key) => { let h = 0; for (const ch of String(key || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return "hsl(" + (h % 360) + ", 55%, 42%)"; };
  let sendPop = null;
  const closeSendPop = () => { if (sendPop) { sendPop.remove(); sendPop = null; } };
  document.addEventListener("click", (e) => { if (sendPop && !sendPop.contains(e.target)) closeSendPop(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sendPop) closeSendPop(); }, true);
  window.addEventListener("scroll", () => { if (sendPop) closeSendPop(); }, true);
  window.addEventListener("resize", () => { if (sendPop) closeSendPop(); });

  // The picker: who to send this note to. Modeled on the Team hub's own reminder
  // flow (assignees.js) so the two feel like the same feature - including the
  // "they don't use the extension, post it in ClickUp instead?" way out.
  function openSendPop(anchor, d, note, nid, host) {
    closeSendPop();
    const people = teammatesOf(d);
    sendPop = document.createElement("div");
    sendPop.className = "tn-pop";
    sendPop.addEventListener("click", (e) => e.stopPropagation());
    const head = document.createElement("div");
    head.className = "tn-pop-h";
    head.textContent = "Send this note to";
    sendPop.appendChild(head);
    const prev = document.createElement("div");
    prev.className = "tn-pop-msg";
    prev.textContent = "“" + (sentText(note) || "(a note with files)") + "”" + (plain(note.text).length > 300 ? "…" : "");
    sendPop.appendChild(prev);
    // Say plainly what travels and what doesn't, before anyone sends it - the note
    // text is private, and a screenshot pasted into it is not carried by the hub.
    if (plain(note.text).length > 300 || (note.files || []).length) {
      const warn = document.createElement("div");
      warn.className = "tn-pop-msg";
      warn.textContent = [
        plain(note.text).length > 300 ? "Only the first 300 characters are sent." : "",
        (note.files || []).length ? (note.files.length === 1 ? "The attached file isn't sent." : "The " + note.files.length + " attached files aren't sent.") + " They stay on this computer." : "",
      ].filter(Boolean).join(" ");
      sendPop.appendChild(warn);
    }
    const note2 = notesOf(String(d.id)).find((n) => n.id === nid) || note;
    if (!people.length) {
      const none = document.createElement("div");
      none.className = "tn-pop-msg";
      none.textContent = String(d.id) && /^\d+$/.test(String(d.id))
        ? "Nobody else is assigned to this task. Add them as an assignee in ClickUp and they'll be offered here."
        : "This isn't a ClickUp task, so there's nobody to send it to.";
      sendPop.appendChild(none);
    }
    for (const p of people) {
      const row = document.createElement("div");
      row.className = "tn-pop-r";
      const av = document.createElement("span");
      av.className = "tn-pop-av";
      av.textContent = ini(p.username);
      av.style.background = iniColor(p.id || p.username);
      const nm = document.createElement("span");
      nm.className = "tn-pop-n";
      nm.textContent = p.username;
      nm.title = p.username;
      const go = document.createElement("button");
      go.type = "button";
      go.className = "tn-pop-b";
      go.textContent = "Send";
      go.title = "Send this note to " + p.username + "'s extension";
      const st = document.createElement("span");
      st.className = "tn-pop-msg";
      const send = async (via) => {
        go.disabled = true;
        st.textContent = via === "clickup" ? "Posting it in ClickUp…" : "Sending…";
        const r = await sendMsg({ type: "CLICKUP_NUDGE", via, taskId: String(d.id), userId: String(p.id), taskName: d.name || "", text: sentText(note) }, 30000);
        const alt = sendPop && sendPop.querySelector(".tn-pop-alt");
        if (alt) alt.remove();
        if (r && r.ok) {
          st.textContent = r.via === "clickup" ? "Posted in ClickUp, assigned to " + p.username + " - ClickUp notifies them." : "Sent - " + p.username + "'s extension shows it within a few minutes.";
          st.classList.add("ok");
          go.textContent = "Sent";
          // Remember it on the note, so the chip says who has seen it (this is the
          // only record - the hub doesn't report back whether they opened it).
          const list = notesOf(String(d.id)).map((n) => n.id === nid
            ? { ...n, sent: maxSent((Array.isArray(n.sent) ? n.sent : []).concat([{ id: String(p.id), name: p.username, at: Date.now(), via: r.via === "clickup" ? "clickup" : "hub" }])) }
            : n);
          await saveNotes(d, list);
          setTimeout(closeSendPop, 1200);
          return;
        }
        go.disabled = false;
        const why = r && r.reason;
        if (why === "no-extension" || why === "no-hub" || why === "old-hub") {
          st.textContent = (why === "no-extension"
            ? p.username + " doesn't use the extension (or hasn't opened it since the Team hub was set up)."
            : (r.error || "The Team hub isn't set up.")) + " Send it as a ClickUp comment assigned to them instead?";
          const b = document.createElement("button");
          b.type = "button";
          b.className = "tn-pop-b go tn-pop-alt";
          b.textContent = "Send as a ClickUp comment";
          b.onclick = () => send("clickup");
          row.appendChild(b);
          return;
        }
        st.textContent = (r && r.error) || "No answer - try again.";
        st.classList.add("err");
      };
      go.onclick = () => send("hub");
      row.append(av, nm, go, st);
      sendPop.appendChild(row);
    }
    const noteBox = document.createElement("div");
    noteBox.className = "tn-pop-msg";
    noteBox.textContent = "Sent to their extension, where it's waiting for them. It isn't posted in ClickUp and nobody else sees it.";
    if (people.length) sendPop.appendChild(noteBox);
    document.body.appendChild(sendPop);
    const b = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    const w = Math.min(320, window.innerWidth - 16);
    const vw = window.innerWidth || document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
    const h = sendPop.offsetHeight || 120;
    if (b && b.width) {
      sendPop.style.top = Math.round((b.bottom + 6 + h > vh && b.top - h - 6 > 0 ? b.top - h - 6 : b.bottom + 6)) + "px";
      sendPop.style.left = Math.round(Math.max(8, Math.min(b.left, vw - w - 8))) + "px";
    } else {
      sendPop.style.top = Math.round(Math.max(8, (vh - h) / 3)) + "px";
      sendPop.style.left = Math.round((vw - w) / 2) + "px";
    }
  }

  // ---------- "From teammates" - the reminders other people sent you ----------
  // Draws into any host element. With `taskId` it shows only that task's (the task
  // details panel), without it everything (the Reminders tab).
  function renderNudges(host, opts) {
    if (!host) return;
    const taskId = opts && opts.taskId != null ? String(opts.taskId) : "";
    const all = nudgesIn || [];
    const rows = (taskId ? all.filter((n) => String(n.taskId || "") === taskId) : all).slice().sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
    const unread = rows.filter(nudgeUnread).length;
    // Only the section this function owns is cleared: the notes panel calls it on
    // a host that already holds the notes, so wiping the host would erase them.
    const old = host.querySelector(":scope > .tn-inbox");
    if (old) old.remove();
    const wrap = document.createElement("div");
    wrap.className = "tn-sec tn-inbox";
    const h = document.createElement("div");
    h.className = "pcm-sec-h tn-h";
    const title = document.createElement("span");
    title.textContent = "From teammates" + (rows.length ? " (" + rows.length + ")" : "");
    h.appendChild(title);
    if (unread) {
      const dot = document.createElement("span");
      dot.className = "tn-new";
      dot.textContent = unread + " new";
      h.appendChild(dot);
    }
    const priv = document.createElement("span");
    priv.className = "tn-priv";
    priv.textContent = taskId ? "reminders someone sent you about this task" : "reminders your teammates sent you";
    h.appendChild(priv);
    h.appendChild(Object.assign(document.createElement("span"), { className: "sp" }));
    if (!taskId && rows.length) {
      const clr = document.createElement("button");
      clr.type = "button";
      clr.className = "tn-btn";
      clr.textContent = "Clear all";
      clr.title = "Forget every reminder in this list (the sender's copy is not affected)";
      clr.onclick = async () => {
        if (!confirm("Clear all " + rows.length + " reminder" + (rows.length === 1 ? "" : "s") + " from teammates?\n\nThis only empties this list on this computer - nothing changes for whoever sent them.")) return;
        clr.disabled = true;
        await clearNudges();
      };
      h.appendChild(clr);
    }
    wrap.appendChild(h);
    if (!rows.length) {
      const e = document.createElement("div");
      e.className = "tn-pop-msg";
      e.textContent = taskId
        ? "Nobody has sent you a reminder about this task."
        : "Nothing yet. When a teammate sends you a reminder from a task, it shows up here (and as a desktop notification).";
      wrap.appendChild(e);
      host.appendChild(wrap);
      return;
    }
    for (const n of rows) {
      const row = document.createElement("div");
      row.className = "tn-note-i" + (nudgeUnread(n) ? " tn-unread" : "");
      const top = document.createElement("div");
      top.className = "tn-txt";
      const who = document.createElement("b");
      who.textContent = (n.fromName || "A teammate") + ":";
      top.appendChild(who);
      top.appendChild(document.createTextNode(" " + (n.text || "(no message)")));
      row.appendChild(top);
      const meta = document.createElement("div");
      meta.className = "tn-meta";
      const when = document.createElement("span");
      when.textContent = day(Number(n.at) || 0);
      meta.appendChild(when);
      if (!taskId && (n.taskName || n.taskId)) {
        const a = document.createElement("a");
        a.textContent = n.taskName || "the task";
        a.title = n.taskName || "Open the task in ClickUp";
        const url = /^https:\/\/app\.clickup\.com\//.test(String(n.taskUrl || "")) ? n.taskUrl : (n.taskId ? "https://app.clickup.com/t/" + n.taskId : "");
        if (url) { a.href = url; a.target = "_blank"; a.rel = "noopener"; }
        meta.appendChild(a);
      }
      meta.appendChild(Object.assign(document.createElement("span"), { className: "sp" }));
      const x = document.createElement("button");
      x.type = "button";
      x.className = "tn-btn";
      x.textContent = "✕";
      x.title = "Remove this from the list";
      x.onclick = () => dismissNudge(nudgeKey(n));
      meta.appendChild(x);
      row.appendChild(meta);
      wrap.appendChild(row);
    }
    host.appendChild(wrap);
    // Showing the list is reading it: the "new" flags clear a moment later, so the
    // dots are still visible for this paint (otherwise they'd flash and vanish).
    if (unread) setTimeout(() => markNudgesRead(rows.filter(nudgeUnread).map(nudgeKey)), 1400);
  }

  // the ⏰ reminder chip: both say "something else is set on this note".
  function sentChip(n) {
    const s = Array.isArray(n.sent) ? n.sent : [];
    if (!s.length) return "";
    const last = s[s.length - 1];
    return '<button type="button" class="tn-remchip" data-sentlist title="' + esc("Sent " + s.map((x) => x.name + " (" + day(x.at) + (x.via === "clickup" ? ", as a ClickUp comment" : "") + ")").join("\nSent ")) + '">🔔 ' + esc(String(last.name || "").split(/\s+/)[0] || "sent") + (s.length > 1 ? " +" + (s.length - 1) : "") + "</button>";
  }
  // Render (or re-render) the notes section into `host` for task `d`.
  function renderPanel(host, d) {
    if (!host || !d || d.id == null) return;
    const id = String(d.id);
    const st = host._tn || (host._tn = { draft: "", draftFiles: [], editing: {}, editFiles: {}, thumbs: new Map() });
    host._tnTask = d;
    host._tnSeen = Date.now();
    hosts.add(host);
    const list = notesOf(id);
    const pinOn = isPinned(id);
    let h = '<div class="pcm-sec-h tn-h"><span>My notes' + (list.length ? " (" + list.length + ")" : "") + '</span><span class="tn-priv">only in this extension - not sent to ClickUp</span><span class="sp"></span>' +
      '<button type="button" class="tn-btn" data-pin>' + (pinOn ? "📌 Pinned" : "📌 Pin task") + "</button></div>";
    for (const n of list.slice().sort((a, b) => b.at - a.at)) {
      const ed = st.editing[n.id];
      if (ed != null) {
        h += '<div class="tn-note-i editing" data-nid="' + esc(n.id) + '"><div data-edhost></div>' + filesHtml(st.editFiles[n.id] || [], true) +
          '<div class="tn-meta"><span>Ctrl+Enter saves · Esc cancels · paste or drop screenshots</span><span class="sp"></span><button type="button" class="tn-btn" data-attach>📎 Attach</button><button type="button" class="tn-btn pri" data-save>Save</button><button type="button" class="tn-btn" data-cancel>Cancel</button></div></div>';
      } else {
        const remAt = noteRemAt(n.id);
        // The Send button only appears when there is somebody else on the task to
        // send to - a local task (a panel built without assigneePeople) or a task
        // you alone are on shows nothing rather than a dead button.
        const canSend = teammatesOf(d).length > 0;
        const nl2 = n.c ? labelOf(n.c) : null;
        h += '<div class="tn-note-i' + (nl2 ? " tn-note-col" : "") + '" data-nid="' + esc(n.id) + '"' + (nl2 ? ' style="--tn-c:' + esc(nl2.color) + '"' : "") + ">" + (nl2 ? '<div class="tn-ncl"><i></i>' + esc(nl2.name) + (nl2.skip ? " \u00b7 not counted in plans" : "") + "</div>" : "") + '<div class="tn-txt md">' + (window.PcmMd ? window.PcmMd.render(n.text) : linkify(n.text)) + "</div>" + filesHtml(n.files || [], false) +
          '<div class="tn-meta"><span>' + esc(day(n.at)) + (n.editedAt ? " · edited" : "") + "</span>" +
          (remAt ? '<button type="button" class="tn-remchip" data-remlist title="A reminder about this note is set - click to see your reminders">⏰ ' + esc(day(remAt)) + "</button>" : "") +
          sentChip(n) +
          '<span class="sp"></span>' +
          (canSend ? '<button type="button" class="tn-btn" data-send title="Send this note to a teammate on this task - it appears in their extension">🔔 Send</button>' : "") +
          '<button type="button" class="tn-btn" data-ncolor title="' + (nl2 ? "Change this note\u2019s colour (it\u2019s the task\u2019s colour)" : "Colour the task with this note as the reason") + '">\uD83C\uDFA8</button><button type="button" class="tn-btn" data-copy title="Copy this note (keeps its formatting)">⧉ Copy</button><button type="button" class="tn-btn" data-rem title="Get reminded about this note at a date and time you pick">⏰ Remind me</button><button type="button" class="tn-btn" data-edit-btn>Edit</button><button type="button" class="tn-btn" data-del title="Delete this note">✕</button></div></div>';
      }
    }
    h += '<div class="tn-new"><div data-newhost></div>' + filesHtml(st.draftFiles, true) +
      '<div class="tn-meta"><span class="tn-msg"></span><span class="sp"></span><button type="button" class="tn-btn" data-attach-new>📎 Attach</button><button type="button" class="tn-btn pri" data-add>Save note</button></div></div>';
    host.innerHTML = h;
    host._tnStale = false;
    if (!host._tnFocusOut) {
      host._tnFocusOut = true;
      host.addEventListener("focusout", () => setTimeout(() => { if (host._tnStale && host.isConnected && !host.contains(document.activeElement)) renderPanel(host, host._tnTask); }, 150));
    }
    host.classList.add("tn-sec");
    wire(host, d, st);
    // What teammates sent you about this task, right under the notes. After wire()
    // so this section's own buttons are wired independently of the notes above.
    renderNudges(host, { taskId: id });
    fillThumbs(host, st);
    if (focusNotesFor === id) setTimeout(focusPanelNotes, 50);
  }
  async function fillThumbs(host, st) {
    for (const img of [...host.querySelectorAll("img[data-thumb]")]) {
      const fid = img.getAttribute("data-thumb");
      let url = st.thumbs.get(fid);
      if (!url) {
        const pend = st.draftFiles.concat(...Object.values(st.editFiles));
        const blob = await blobOf({ id: fid }, pend);
        if (!blob) { const t = img.closest(".tn-shot"); if (t) t.classList.add("gone"); continue; }
        url = URL.createObjectURL(blob);
        st.thumbs.set(fid, url);
      }
      if (img.isConnected) img.src = url;
    }
    // A redraw that landed while the first pass was loading: one more try.
    if (!st._retry && [...host.querySelectorAll("img[data-thumb]")].some((i) => !i.getAttribute("src"))) {
      st._retry = true;
      setTimeout(() => { st._retry = false; if (host.isConnected) fillThumbs(host, st); }, 250);
    }
  }
  function takeFiles(cur, files, host) {
    const msg = host.querySelector(".tn-msg");
    for (const f of [...files].slice(0, 10)) {
      if (cur.length >= 10) { if (msg) msg.textContent = "Up to 10 files per note."; break; }
      if (f.size > 20 * 1048576) { if (msg) msg.textContent = f.name + " is over 20 MB."; continue; }
      const dt = new Date(), pad = (x) => String(x).padStart(2, "0");
      const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate()) + "-" + pad(dt.getHours()) + pad(dt.getMinutes()) + pad(dt.getSeconds()) + ".png";
      cur.push({ id: uid(), name, type: f.type || "application/octet-stream", size: f.size, blob: f });
    }
  }
  function pickFiles(cb) {
    const inp = document.createElement("input");
    inp.type = "file"; inp.multiple = true;
    inp.onchange = () => cb([...inp.files]);
    inp.click();
  }
  async function storeFiles(list) {
    const fresh = list.filter((f) => f.blob);
    if (fresh.length && window.PcmFiles) await window.PcmFiles.attPut(fresh.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size, blob: p.blob, at: Date.now() })));
    return list.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size }));
  }
  function wire(host, d, st) {
    const id = String(d.id);
    const rerender = () => renderPanel(host, d);
    const say = (t) => { const m = host.querySelector(".tn-msg"); if (m) m.textContent = t; };
    host.querySelector("[data-pin]").onclick = () => setPin(id, !isPinned(id));
    // Notes are written and edited formatted (PcmMd.editor), saved as Markdown.
    const newTa = window.PcmMd.editor(st.draft, { maxLength: 20000, onInput: (v) => { st.draft = v; },
      placeholder: "Write a note for yourself about this task… Paste from Claude / ChatGPT keeps its formatting; paste a screenshot with Ctrl+V or drop files here. Ctrl+Enter saves." });
    Object.defineProperty(newTa, "value", { get: () => newTa.getMarkdown() });
    newTa.focus = () => newTa.focusEnd();
    host.querySelector("[data-newhost]").replaceWith(newTa);
    const addNote = async () => {
      const text = newTa.value.trim();
      if (!text && !st.draftFiles.length) { newTa.focus(); return; }
      let files;
      try { files = await storeFiles(st.draftFiles); } catch (e) { say("Couldn't save the files (is the disk full?)."); return; }
      const list = notesOf(id).slice();
      list.push({ id: uid(), text: (text || files.map((f) => f.name).join(", ")).slice(0, 20000), at: Date.now(), files });
      st.draft = ""; st.draftFiles = [];
      if (document.activeElement && host.contains(document.activeElement)) document.activeElement.blur(); // lets the panel redraw
      await saveNotes(d, list); // redraws every open panel
    };
    host.querySelector("[data-add]").onclick = addNote;
    newTa.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote(); } });
    host.querySelector("[data-attach-new]").onclick = () => pickFiles((fl) => { st.draft = newTa.value; takeFiles(st.draftFiles, fl, host); rerender(); });
    const newBox = host.querySelector(".tn-new");
    const pasteDrop = (box, target, cur) => {
      target.addEventListener("paste", (e) => { const fl = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fl.length) { e.preventDefault(); e.stopPropagation(); cur(fl); } });
      box.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) { e.preventDefault(); e.stopPropagation(); box.classList.add("tn-drop"); } });
      box.addEventListener("dragleave", () => box.classList.remove("tn-drop"));
      box.addEventListener("drop", (e) => { box.classList.remove("tn-drop"); if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); e.stopPropagation(); cur([...e.dataTransfer.files]); } });
    };
    pasteDrop(newBox, newTa, (fl) => { st.draft = newTa.value; takeFiles(st.draftFiles, fl, host); rerender(); });
    newBox.querySelectorAll("[data-rm]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const fid = b.closest("[data-fid]").getAttribute("data-fid"); st.draft = newTa.value; st.draftFiles = st.draftFiles.filter((f) => f.id !== fid); rerender(); }; });
    // Saved notes
    host.querySelectorAll(".tn-note-i").forEach((box) => {
      const nid = box.getAttribute("data-nid");
      const note = notesOf(id).find((n) => n.id === nid);
      if (!note) return;
      // Tick / untick a checkbox in the shown note - saved at once, no Edit needed.
      const txt = box.querySelector(".tn-txt");
      if (txt) txt.addEventListener("click", (e) => {
        const b = e.target.closest(".md-box");
        if (!b || !window.PcmMd) return;
        const idx = [...txt.querySelectorAll(".md-box")].indexOf(b);
        const t2 = window.PcmMd.toggleTask(note.text, idx);
        if (t2 !== note.text) saveNotes(d, notesOf(id).map((x) => x.id === nid ? { ...x, text: t2 } : x));
      });
      const ncb = box.querySelector("[data-ncolor]");
      if (ncb) ncb.onclick = (e) => { e.stopPropagation(); if (colorPop) { closeColorPop(); return; } openColorPop(ncb, id, d, { nid }); };
      if (ncb) ncb.addEventListener("mousedown", (e) => e.stopPropagation());
      const rb = box.querySelector("[data-rem]");
      if (rb) rb.onclick = (e) => {
        e.stopPropagation(); // the page's outside-click would close the card at once
        if (!window.PcmReminders) return;
        window.PcmReminders.open({ title: "⏰ Remind me about this note", text: ((d.name ? d.name + ": " : "") + plain(note.text)).slice(0, 200), files: note.files || [],
          task: { id, name: d.name || "", url: d.url || "" }, noteId: nid }, rb);
      };
      const rl = box.querySelector("[data-remlist]");
      if (rl) rl.onclick = (e) => { e.stopPropagation(); if (window.PcmReminders) window.PcmReminders.openList(); };
      // Send this note to a co-assignee: the picker lists the other people on the
      // task (never you), and the note itself is what travels - capped at the 300
      // characters the Team hub accepts, files left behind. See the block at the top
      // of this file for why files can't come along.
      const sb = box.querySelector("[data-send]");
      if (sb) sb.onclick = (e) => {
        e.stopPropagation(); // the page's outside-click would close the popover at once
        if (sendPop && sendPop._for === nid) { closeSendPop(); return; }
        openSendPop(sb, d, note, nid, host);
        if (sendPop) sendPop._for = nid;
      };
      const sl = box.querySelector("[data-sentlist]");
      if (sl) sl.onclick = (e) => { e.stopPropagation(); alert(sl.title); };
      const cpb = box.querySelector("[data-copy]");
      if (cpb) cpb.onclick = async (e) => {
        e.stopPropagation();
        const txt = box.querySelector(".tn-txt");
        if (window.PcmCopy) { window.PcmCopy.copyText(note.text, txt ? txt.innerHTML : "", cpb); return; }
        try { await navigator.clipboard.writeText(note.text); cpb.textContent = "Copied \u2713"; } catch (x) { cpb.textContent = "Couldn't copy"; }
        setTimeout(() => { cpb.textContent = "\u29C9 Copy"; }, 1500);
      };
      const eb = box.querySelector("[data-edit-btn]");
      if (eb) eb.onclick = () => { st.editing[nid] = note.text; st.editFiles[nid] = (note.files || []).slice(); rerender(); };
      const del = box.querySelector("[data-del]");
      if (del) del.onclick = async () => {
        if (!confirm("Delete this note?")) return;
        const ids = (note.files || []).map((f) => f.id);
        await saveNotes(d, notesOf(id).filter((n) => n.id !== nid));
        if (window.PcmFiles && ids.length) await window.PcmFiles.attCleanup(ids).catch(() => {});
      };
      const edHost = box.querySelector("[data-edhost]");
      if (edHost) {
        const ta = window.PcmMd.editor(st.editing[nid], { maxLength: 20000, onInput: (v) => { st.editing[nid] = v; } });
        Object.defineProperty(ta, "value", { get: () => ta.getMarkdown() });
        edHost.replaceWith(ta);
        setTimeout(() => { if (ta.isConnected && !ta.contains(document.activeElement)) ta.focusEnd(); }, 30);
        const cancel = () => { delete st.editing[nid]; delete st.editFiles[nid]; rerender(); };
        const save = async () => {
          const cur = st.editFiles[nid] || [];
          let files;
          try { files = await storeFiles(cur); } catch (e) { return; }
          const removed = (note.files || []).map((f) => f.id).filter((fid) => !cur.some((f) => f.id === fid));
          const list = notesOf(id).map((n) => n.id === nid ? { ...n, text: (ta.value.trim() || files.map((f) => f.name).join(", ")).slice(0, 20000), files, editedAt: Date.now() } : n);
          delete st.editing[nid]; delete st.editFiles[nid];
          if (document.activeElement && host.contains(document.activeElement)) document.activeElement.blur(); // lets the panel redraw
      await saveNotes(d, list);
          // Only after the note is written: cleanup keeps anything still referenced.
          if (removed.length && window.PcmFiles) await window.PcmFiles.attCleanup(removed).catch(() => {});
        };
        box.querySelector("[data-save]").onclick = save;
        box.querySelector("[data-cancel]").onclick = cancel;
        ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); } });
        box.querySelector("[data-attach]").onclick = () => pickFiles((fl) => { st.editing[nid] = ta.value; takeFiles(st.editFiles[nid] || (st.editFiles[nid] = []), fl, host); rerender(); });
        pasteDrop(box, ta, (fl) => { st.editing[nid] = ta.value; takeFiles(st.editFiles[nid] || (st.editFiles[nid] = []), fl, host); rerender(); });
        box.querySelectorAll("[data-rm]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const fid = b.closest("[data-fid]").getAttribute("data-fid"); st.editing[nid] = ta.value; st.editFiles[nid] = (st.editFiles[nid] || []).filter((f) => f.id !== fid); rerender(); }; });
      }
    });
    // Click a file: images open big, other files open / download.
    host.querySelectorAll(".tn-shot, .tn-chip").forEach((el) => {
      el.addEventListener("click", async (e) => {
        if (e.target.closest("[data-rm]")) return;
        const fid = el.getAttribute("data-fid");
        const all = notesOf(id).flatMap((n) => n.files || []).concat(st.draftFiles, ...Object.values(st.editFiles));
        const f = all.find((x) => x.id === fid) || { id: fid, name: el.title };
        const pend = st.draftFiles.concat(...Object.values(st.editFiles));
        const blob = await blobOf(f, pend);
        if (!blob) { say("“" + f.name + "” isn't on this computer (note attachments aren't backed up to Drive)."); return; }
        if (isImage(f)) {
          ensureLight();
          if (lightUrl) URL.revokeObjectURL(lightUrl);
          lightUrl = URL.createObjectURL(blob); lightBlob = blob;
          light.querySelector("img").src = lightUrl;
          light.querySelector(".nm").textContent = f.name || "";
          light.hidden = false;
        } else if (window.PcmFiles) { try { window.PcmFiles.openFile({ blob, name: f.name }); } catch (err) {} }
      });
    });
  }

  // PcmNudgeInbox is the read side of "reminders teammates sent me", shared with
  // reminders.js (the Reminders tab) so both places draw the same list the same
  // way. It's exported rather than passed because the two scripts load in
  // different orders on the two pages - callers must tolerate it being missing.
  window.PcmNudgeInbox = { list: readNudges, render: renderNudges, dismiss: dismissNudge, markRead: markNudgesRead, clear: clearNudges, key: nudgeKey, unread: nudgeUnread, count: nudgeCount, onChange: (fn) => { nudgeSubs.push(fn); return () => { const i = nudgeSubs.indexOf(fn); if (i >= 0) nudgeSubs.splice(i, 1); }; } };
  window.PcmTaskNotes = { notesOf, isPinned, setPin, isEarly, setEarly, colorLabels: () => allLabels(), colorOf: (id) => { const c = colors[String(id)]; const l = c && labelOf(c.l); const cn = l ? colorNote(id) : null; return l ? { ...l, note: cn ? plain(cn.text) : c.note || "" } : null; },
    isSkipped: (id) => { const c = colors[String(id)]; const l = c && labelOf(c.l); return !!(l && l.skip); }, renderPanel, onChange: (fn) => subs.push(fn), _decorateAll: decorateAll, _teammatesOf: teammatesOf };
})();
