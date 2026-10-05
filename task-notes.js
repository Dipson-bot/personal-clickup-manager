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
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.taskNotes || ch.taskPins || ch.reminders)) load(); }); } catch (e) {}
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
  const notesOf = (id) => (notes[String(id)] && Array.isArray(notes[String(id)].notes)) ? notes[String(id)].notes : [];
  const isPinned = (id) => !!pins[String(id)];
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
  `;
  document.head.appendChild(css);

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
      box.innerHTML = '<button type="button" class="tn-b tn-pin"></button><button type="button" class="tn-b tn-note"></button>';
      const nm = wrap.querySelector(".nm");
      if (nm && nm.nextSibling) wrap.insertBefore(box, nm.nextSibling); else wrap.appendChild(box);
      box.querySelector(".tn-pin").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); setPin(id, !isPinned(id)); });
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
    pb.textContent = "📌"; pb.classList.toggle("on", pinOn);
    pb.title = pinOn ? "Pinned - it stays at the top. Click to unpin." : "Pin this task to the top of the list (only in this extension)";
    pb.setAttribute("aria-pressed", String(pinOn));
    nb.textContent = n ? "📝 " + n : "📝"; nb.classList.toggle("on", n > 0);
    nb.title = n ? n + " personal note" + (n === 1 ? "" : "s") + " - click to read or add (only in this extension, not in ClickUp)" : "Add a personal note (only in this extension, not in ClickUp)";
    row.classList.toggle("tn-pinned", pinOn);
  }
  function decorateAll() { document.querySelectorAll(".cu-task").forEach(decorate); }
  let pending = 0;
  new MutationObserver(() => { if (!pending) pending = setTimeout(() => { pending = 0; decorateAll(); }, 30); }).observe(document.documentElement, { childList: true, subtree: true });

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
        h += '<div class="tn-note-i" data-nid="' + esc(n.id) + '"><div class="tn-txt md">' + (window.PcmMd ? window.PcmMd.render(n.text) : linkify(n.text)) + "</div>" + filesHtml(n.files || [], false) +
          '<div class="tn-meta"><span>' + esc(day(n.at)) + (n.editedAt ? " · edited" : "") + "</span>" +
          (remAt ? '<button type="button" class="tn-remchip" data-remlist title="A reminder about this note is set - click to see your reminders">⏰ ' + esc(day(remAt)) + "</button>" : "") +
          '<span class="sp"></span><button type="button" class="tn-btn" data-rem title="Get reminded about this note at a date and time you pick">⏰ Remind me</button><button type="button" class="tn-btn" data-edit-btn>Edit</button><button type="button" class="tn-btn" data-del title="Delete this note">✕</button></div></div>';
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

  window.PcmTaskNotes = { notesOf, isPinned, setPin, renderPanel, onChange: (fn) => subs.push(fn), _decorateAll: decorateAll };
})();
