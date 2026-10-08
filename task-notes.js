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
      chrome.storage.local.get(["taskNotes", "taskPins", "reminders"]).then((g) => {
        notes = g.taskNotes && typeof g.taskNotes === "object" ? g.taskNotes : {};
        pins = g.taskPins && typeof g.taskPins === "object" ? g.taskPins : {};
        rems = Array.isArray(g.reminders) ? g.reminders : [];
        changed();
      }).catch(() => {});
    } catch (e) {}
  }
  try { chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.taskNotes || ch.taskPins || ch.reminders) load();
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
  .tn-pin { filter: grayscale(1); }
  .tn-pin.on { filter: none; }
  .tn-note.on { color: var(--indigo, #6366f1); font-weight: 700; }
  .cu-task.tn-pinned { box-shadow: inset 3px 0 0 var(--amber, #d97706); }
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
      box.innerHTML = '<button type="button" class="tn-b tn-cmt" hidden></button><button type="button" class="tn-b tn-pin"></button><button type="button" class="tn-b tn-note"></button>';
      const nm = wrap.querySelector(".nm");
      if (nm && nm.nextSibling) wrap.insertBefore(box, nm.nextSibling); else wrap.appendChild(box);
      box.querySelector(".tn-pin").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setPin(id, !isPinned(id)); });
      // 💬: open the task's details - its comments are there (and that marks them read).
      box.querySelector(".tn-cmt").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const chev = row.querySelector(".pcm-chev");
        if (chev && chev.getAttribute("aria-expanded") !== "true") chev.click();
        else window.PcmComments.markRead(id);
      });
      box.querySelector(".tn-note").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        focusNotesFor = id;
        const chev = row.querySelector(".pcm-chev");
        const open = chev && chev.getAttribute("aria-expanded") === "true";
        if (chev && !open) chev.click();
        else focusPanelNotes();
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
        h += '<div class="tn-note-i" data-nid="' + esc(n.id) + '"><div class="tn-txt md">' + (window.PcmMd ? window.PcmMd.render(n.text) : linkify(n.text)) + "</div>" + filesHtml(n.files || [], false) +
          '<div class="tn-meta"><span>' + esc(day(n.at)) + (n.editedAt ? " · edited" : "") + "</span>" +
          (remAt ? '<button type="button" class="tn-remchip" data-remlist title="A reminder about this note is set - click to see your reminders">⏰ ' + esc(day(remAt)) + "</button>" : "") +
          sentChip(n) +
          '<span class="sp"></span>' +
          (canSend ? '<button type="button" class="tn-btn" data-send title="Send this note to a teammate on this task - it appears in their extension">🔔 Send</button>' : "") +
          '<button type="button" class="tn-btn" data-rem title="Get reminded about this note at a date and time you pick">⏰ Remind me</button><button type="button" class="tn-btn" data-edit-btn>Edit</button><button type="button" class="tn-btn" data-del title="Delete this note">✕</button></div></div>';
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
  window.PcmTaskNotes = { notesOf, isPinned, setPin, renderPanel, onChange: (fn) => subs.push(fn), _decorateAll: decorateAll, _teammatesOf: teammatesOf };
})();
