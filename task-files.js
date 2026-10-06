// Options > Clients: each client's files (audits, reference files, screenshots)
// and notes. "Explain this task" and the client report use the files; task
// details and "Explain this task" show / use the notes.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  if (!$("tfCard") || !window.PcmFiles) return;
  const F = window.PcmFiles;
  const send = (msg, ms = 30000) => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    try { chrome.runtime.sendMessage(msg, (r) => { clearTimeout(t); void chrome.runtime.lastError; resolve(r || null); }); } catch (e) { clearTimeout(t); resolve(null); }
  });
  /* ---- helpers ---- (lifted by dev-tools/t_clients_notes.js: nothing here touches the DOM) */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
  const day = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const icon = (r) => r.kind === "image" ? "\u{1F5BC}" : r.kind === "unreadable" ? "⚠" : /\.pdf$/i.test(r.name) ? "\u{1F4D5}" : /\.(xlsx|csv|tsv)$/i.test(r.name) ? "\u{1F4CA}" : /\.html?$/i.test(r.name) ? "\u{1F310}" : "\u{1F4C4}";
  const pad = (n) => String(n).padStart(2, "0");
  const toLocalInput = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };
  // A screenshot or photo: worth showing rather than listing. A client file says
  // so itself (kind), a note attachment only has its type and name to go on.
  const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
  const isImage = (f) => !!f && (f.kind === "image" || /^image\//.test(f.type || "") || IMG_EXT.test(f.name || ""));
  // A link pasted into a note should be a link. Only http(s) becomes an anchor,
  // and everything - the href included - goes through esc, so a note is still
  // only text as far as the page is concerned.
  const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
  const countOf = (s, c) => s.split(c).length - 1;
  // A link at the end of a sentence must not swallow the full stop, and a
  // closing bracket belongs to the link only if it was opened inside it.
  function trimUrl(u) {
    let s = String(u);
    for (;;) {
      const c = s.slice(-1);
      if (/[.,;:!?'"’]/.test(c)) { s = s.slice(0, -1); continue; }
      if ((c === ")" && countOf(s, "(") < countOf(s, ")")) ||
          (c === "]" && countOf(s, "[") < countOf(s, "]")) ||
          (c === "}" && countOf(s, "{") < countOf(s, "}"))) { s = s.slice(0, -1); continue; }
      return s;
    }
  }
  function linkify(text) {
    const s = String(text == null ? "" : text);
    let out = "", at = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(s))) {
      const url = trimUrl(m[0]);
      // Nothing left after the scheme: leave it as the plain text it is.
      if (!/^https?:\/\/[^\s/]/.test(url)) { URL_RE.lastIndex = m.index + m[0].length; continue; }
      out += esc(s.slice(at, m.index)) +
        '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>";
      at = m.index + url.length;
      URL_RE.lastIndex = at;
    }
    return out + esc(s.slice(at));
  }
  // Pinned clients first, in the order they were pinned (newest pin on top),
  // then everyone else by name, ignoring a leading emoji.
  const sortName = (s) => String(s || "").replace(/^[^a-z0-9]+/i, "");
  function sortClients(entries, pins) {
    const rank = (k) => { const i = (pins || []).indexOf(k); return i < 0 ? Infinity : i; };
    return entries.slice().sort((a, b) => {
      const ra = rank(a[0]), rb = rank(b[0]);
      if (ra !== rb) return ra - rb;
      return sortName(a[1]).localeCompare(sortName(b[1]));
    });
  }
  /* ---- end helpers ---- */

  let myClients = [];     // from my tasks
  let allClients = [];    // whole workspace (loaded on demand)
  let added = [];         // clients the user added by hand (settings.tfAdded) - not assigned to them
  let files = [];         // every stored file
  let notes = {};         // client key -> [{ id, text, at, editedAt, client, files }]
  const drafts = {};      // client key -> note text being typed (kept across redraws)
  const editing = {};     // note id -> the text being edited in place (same reason)
  const editFiles = {};   // note id -> its attachments while editing: written on Save, thrown away on Cancel
  const noteFiles = {};   // client key -> files waiting to go with the next note
  const remindAt = {};    // client key -> "" | datetime-local value for the next note
  const open = new Set(); // expanded client keys
  let pinned = [];        // pinned client keys, newest first (rides settings to Drive)
  let focusNid = "";      // a note whose editor should get the caret on the next draw
  // One object URL per image, made once and reused: the list is redrawn often,
  // and a URL per redraw would pile up for as long as the tab is open.
  const thumbs = new Map();

  const css = document.createElement("style");
  css.textContent = `
    #tfList .tf-client { border: 1px solid var(--border); border-radius: 12px; margin: 0 0 8px; background: var(--card); overflow: hidden; }
    #tfList .tf-client.open { border-color: var(--indigo); box-shadow: 0 0 0 1px var(--indigo) inset; }
    #tfList .tf-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; }
    #tfList .tf-client.open > .tf-head { background: rgba(99,102,241,.08); border-bottom: 1px solid var(--border); }
    #tfList .tf-name { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tfList .tf-count { font-size: 12px; color: var(--muted); white-space: nowrap; }
    #tfList .tf-client.empty .tf-count { color: var(--amber, #d97706); }
    #tfList .tf-tog { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 12px; width: 18px; padding: 0; }
    #tfList .tf-body { padding: 10px 12px 12px; display: grid; gap: 12px; }
    #tfList .tf-sec { border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: var(--bg); }
    #tfList .tf-sech { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 12.5px; margin-bottom: 8px; flex-wrap: wrap; }
    #tfList .tf-sech .hint { font-weight: 400; flex: 1; min-width: 160px; }
    #tfList .tf-btn { font: inherit; font-size: 11.5px; font-weight: 600; padding: 3px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; white-space: nowrap; }
    #tfList .tf-btn:hover { border-color: var(--indigo); color: var(--indigo); }
    #tfList .tf-btn.pri { background: var(--indigo); border-color: var(--indigo); color: #fff; }
    #tfList .tf-file { display: grid; grid-template-columns: 22px minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 7px 4px; border-top: 1px solid var(--border); }
    #tfList .tf-file:first-of-type { border-top: 0; }
    #tfList .tf-fn { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tfList .tf-fm { font-size: 11.5px; color: var(--muted); }
    #tfList .tf-facts { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
    #tfList .tf-file.bad .tf-fn { color: var(--amber, #d97706); }
    #tfList .tf-note { padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; margin-bottom: 7px; background: var(--card); }
    #tfList .tf-nt { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
    #tfList .tf-nmeta { display: flex; gap: 6px; align-items: center; margin-top: 6px; flex-wrap: wrap; }
    #tfList .tf-nmeta .hint { flex: 1; min-width: 100px; }
    #tfList .tf-chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    #tfList .tf-chip { display: inline-flex; gap: 4px; align-items: center; max-width: 100%; font-size: 11.5px; padding: 2px 4px 2px 9px; border: 1px solid var(--border); border-radius: 99px; background: var(--bg2); cursor: pointer; }
    #tfList .tf-chip span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
    #tfList .tf-chip button { border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0 3px; }
    #tfList .tf-nadd { display: grid; gap: 7px; padding: 10px; border: 1px dashed var(--border); border-radius: 9px; }
    #tfList .tf-nadd.over, #tfList .tf-client.over { outline: 2px dashed var(--indigo); outline-offset: 2px; }
    #tfList .tf-nadd textarea { min-height: 54px; resize: vertical; font: inherit; font-size: 13px; }
    #tfList .tf-nrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
    #tfList .tf-nrow label { display: flex; gap: 6px; align-items: center; margin: 0; font-weight: 400; }
    #tfList .tf-nrow input[type=datetime-local] { font: inherit; font-size: 12px; padding: 3px 6px; }
    #tfList .tf-nrow .sp { flex: 1; }
    .tf-addc { display: inline-flex; gap: 4px; align-items: center; position: relative; }
    .tf-addc input { width: 230px; }
    .tf-addpop { position: absolute; top: calc(100% + 4px); left: 0; z-index: 50; width: min(380px, 90vw); max-height: 320px; overflow: auto; background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 12px 30px rgba(0,0,0,.18); padding: 4px; font-size: 12.5px; }
    .tf-addpop[hidden] { display: none; }
    .tf-addpop .it { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; font: inherit; padding: 6px 9px; border: 0; border-radius: 7px; background: none; color: inherit; cursor: pointer; }
    .tf-addpop .it:hover, .tf-addpop .it.on { background: var(--bg2, rgba(99,102,241,.1)); }
    .tf-addpop .it .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tf-addpop .it .tag { font-size: 10.5px; color: var(--muted); }
    .tf-addpop .it:disabled { cursor: default; opacity: .55; }
    .tf-addpop .msg { padding: 8px 9px; color: var(--muted); line-height: 1.45; }
    .tf-addpop .msg a { color: var(--indigo, #6366f1); cursor: pointer; }
    #tfList .tf-unadd { border: 0; background: none; cursor: pointer; color: var(--muted); font-size: 12px; padding: 2px 5px; border-radius: 6px; }
    #tfList .tf-unadd:hover { color: var(--red, #dc2626); background: var(--bg2); }
    #tfList .tf-pin { border: 0; background: none; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 6px; filter: grayscale(1); opacity: .35; }
    #tfList .tf-pin:hover { opacity: .8; filter: none; }
    #tfList .tf-pin.on { opacity: 1; filter: none; }
    #tfList .tf-client.pinned { border-left: 3px solid var(--indigo); }
    #tfList .tf-note.editing { border-color: var(--indigo); box-shadow: 0 0 0 1px var(--indigo) inset; }
    #tfList .tf-note.over { outline: 2px dashed var(--indigo); outline-offset: 2px; }
    #tfList .tf-nt a { color: var(--indigo); text-decoration: underline; }
    #tfList .tf-nt a:hover { text-decoration: none; }
    #tfList .tf-nein { width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical; font: inherit; font-size: 13px; line-height: 1.45; }
    #tfList .tf-shots { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 7px; }
    #tfList .tf-shot { position: relative; display: block; width: 96px; cursor: zoom-in; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--bg2); }
    #tfList .tf-shot:hover { border-color: var(--indigo); }
    #tfList .tf-shot img { display: block; width: 100%; height: 72px; object-fit: cover; background: var(--bg2); }
    #tfList .tf-shot .tf-shotn { display: block; font-size: 10.5px; padding: 3px 5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tfList .tf-shot .tf-npf-x, #tfList .tf-shot .tf-neatt-x { position: absolute; top: 3px; right: 3px; border: 0; border-radius: 6px; background: rgba(0,0,0,.55); color: #fff; cursor: pointer; font-size: 11px; line-height: 1; padding: 3px 5px; }
    #tfList .tf-shot.gone img { display: none; }
    #tfList .tf-shot.gone::before { content: "⚠ not on this computer"; display: block; font-size: 10.5px; padding: 26px 5px; text-align: center; color: var(--amber, #d97706); }
    #tfList .tf-file.img { grid-template-columns: 46px minmax(0,1fr) auto; }
    #tfList .tf-fthumb { width: 40px; height: 40px; object-fit: cover; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2); cursor: zoom-in; display: block; }
    #tfList .tf-fthumb:hover { border-color: var(--indigo); }
    .tf-light { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; padding: 24px; }
    .tf-light[hidden] { display: none; }
    .tf-lbox { max-width: min(1100px, 94vw); max-height: 92vh; display: flex; flex-direction: column; gap: 8px; }
    .tf-lbox img { max-width: 100%; max-height: calc(92vh - 46px); object-fit: contain; border-radius: 10px; background: #fff; }
    .tf-lbar { display: flex; align-items: center; gap: 8px; }
    .tf-lname { flex: 1; min-width: 0; color: #fff; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tf-lbar .tf-btn { font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 10px; border-radius: 7px; border: 1px solid rgba(255,255,255,.4); background: rgba(255,255,255,.1); color: #fff; cursor: pointer; }
    .tf-lbar .tf-btn:hover { background: rgba(255,255,255,.22); }
  `;
  document.head.appendChild(css);

  function mine() {
    return chrome.storage.local.get("clickupState").catch(() => ({})).then((g) => {
      const st = (g && g.clickupState) || {};
      const names = new Map();
      for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) {
        if (!b) continue;
        for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[k] || []) {
          const c = String((t && (t.client || (t.container && t.container.listName))) || "").trim();
          if (c && !/extra tasks?|daily tracking/i.test(c)) names.set(F.key(c), c);
        }
      }
      return [...names.values()];
    });
  }

  async function readPins() {
    try {
      const g = await chrome.storage.local.get("settings");
      const p = g && g.settings && g.settings.tfPinned;
      return Array.isArray(p) ? p.filter((x) => typeof x === "string") : [];
    } catch (e) { return []; }
  }

  async function readAdded() {
    try {
      const g = await chrome.storage.local.get("settings");
      const a = g && g.settings && g.settings.tfAdded;
      return Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()) : [];
    } catch (e) { return []; }
  }

  async function load() {
    files = await F.all().catch(() => []);
    notes = await F.allNotes().catch(() => ({}));
    myClients = await mine();
    pinned = await readPins();
    added = await readAdded();
    render();
  }

  function clientsShown() {
    const byKey = new Map();
    const src = $("tfAll").checked && allClients.length ? allClients : myClients;
    for (const c of src) byKey.set(F.key(c), c);
    for (const c of added) if (!byKey.has(F.key(c))) byKey.set(F.key(c), c); // added by hand
    for (const f of files) if (!byKey.has(f.ck)) byKey.set(f.ck, f.client); // clients with files always show
    for (const k of Object.keys(notes)) if (!byKey.has(k) && (notes[k] || []).length) byKey.set(k, notes[k][0].client || k); // and clients with notes
    const q = $("tfSearch").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    return sortClients([...byKey.entries()].filter(([k]) => !q || k.includes(q)), pinned);
  }

  /* ---- markup ---- (lifted by dev-tools/t_clients_notes.js) */
  function fileRow(f) {
    const kept = !!(f.blob || f.html);
    const img = isImage(f) && !!f.blob; // only when the picture itself is here
    const what = f.kind === "text" ? (f.text || "").length.toLocaleString() + " characters read" : f.kind === "image" ? "image" : esc(f.why || "can't be read");
    return '<div class="tf-file' + (f.kind === "unreadable" ? " bad" : "") + (img ? " img" : "") + '" data-id="' + esc(f.id) + '">' +
      (img ? '<img class="tf-fthumb" data-thumb="' + esc(f.id) + '" alt="' + esc(f.name) + '" title="' + esc("Show " + f.name) + '" />' : "<span>" + icon(f) + "</span>") +
      '<div style="min-width:0"><div class="tf-fn" title="' + esc(f.name) + '">' + esc(f.name) + '</div><div class="tf-fm">' + fmtSize(f.size || 0) + " · added " + day(f.addedAt) + " · " + what + (kept ? "" : " · only its text is kept") + "</div></div>" +
      '<div class="tf-facts"><button type="button" class="tf-btn tf-open" title="' + (kept ? "Open it (images, PDF, web pages and text open in a tab; other files download)" : "Open the text that was read from it (the original wasn't kept - it was added before files were kept)") + '">Open</button>' +
      '<button type="button" class="tf-btn tf-show" title="Opens the folder with this file. The first time, a copy is saved to Downloads &gt; Personal ClickUp Manager &gt; Clients &gt; ' + esc(f.client) + ' (the file itself is stored inside Chrome, not in a folder); after that the same copy is shown.">Show in folder</button>' +
      '<button type="button" class="tf-btn tf-replace" title="Swap this file for a newer one (for example August\'s audit for September\'s). To keep both, use + Add files instead.">Replace</button>' +
      '<button type="button" class="tf-btn tf-rm" title="Remove this file">✕</button></div></div>';
  }
  // Images get a thumbnail, everything else stays a chip. data-i is the index in
  // the ORIGINAL list, because removing a pending file splices by that index.
  function attHtml(list, cls, removable) {
    if (!list || !list.length) return "";
    const pairs = list.map((f, i) => [f, i]);
    const shots = pairs.filter(([f]) => isImage(f));
    const rest = pairs.filter(([f]) => !isImage(f));
    const x = removable ? '<button type="button" class="' + cls + '-x" title="Remove this file from the note">✕</button>' : "";
    let out = "";
    if (shots.length) {
      out += '<div class="tf-shots">' + shots.map(([f, i]) =>
        '<span class="tf-shot ' + cls + '" data-i="' + i + '" data-fid="' + esc(f.id) + '" title="' + esc("Show " + f.name) + '">' +
        '<img data-thumb="' + esc(f.id) + '" alt="' + esc(f.name) + '" />' +
        '<span class="tf-shotn">' + esc(f.name) + "</span>" + x + "</span>").join("") + "</div>";
    }
    if (rest.length) {
      out += '<div class="tf-chips">' + rest.map(([f, i]) =>
        '<span class="tf-chip ' + cls + '" data-i="' + i + '" data-fid="' + esc(f.id) + '" title="' + esc(f.name) + '"><span>📎 ' + esc(f.name) + "</span>" + x + "</span>").join("") + "</div>";
    }
    return out;
  }
  // A saved note: its text with any links live, or a textarea in its place
  // while it's being edited. While editing, the attachments shown are the
  // working copy in editFiles - each one removable, and more can be added -
  // until Save writes them.
  function noteHtml(n) {
    const ed = editing[n.id];
    const atts = ed == null ? (n.files || []) : (editFiles[n.id] || n.files || []);
    const body = ed == null
      ? '<div class="tf-nt md">' + (typeof window !== "undefined" && window.PcmMd ? window.PcmMd.render(n.text) : linkify(n.text)) + "</div>"
      : '<textarea class="tf-nein" maxlength="20000" data-nid="' + esc(n.id) + '" aria-label="Edit this note">' + esc(ed) + "</textarea>";
    const meta = ed == null
      ? '<span class="hint">' + day(n.at) + (n.editedAt ? " · edited" : "") + "</span>" +
        '<button type="button" class="tf-btn tf-nrem" title="Set a reminder about this note (any date and time)">⏰ Remind me</button>' +
        '<button type="button" class="tf-btn tf-nedit" title="Edit this note right here">Edit</button>' +
        '<button type="button" class="tf-btn tf-ndel" title="Delete this note">✕</button>'
      : '<span class="hint">Ctrl+Enter saves · Esc cancels</span>' +
        '<button type="button" class="tf-btn tf-neattach" title="Attach screenshots or files to this note. You can also paste one with Ctrl+V or drop files on the note. ✕ on a file takes it off.">📎 Attach</button>' +
        '<button type="button" class="tf-btn pri tf-nesave">Save</button>' +
        '<button type="button" class="tf-btn tf-necancel">Cancel</button>';
    return '<div class="tf-note' + (ed == null ? "" : " editing") + '" data-nid="' + esc(n.id) + '">' + body +
      attHtml(atts, ed == null ? "tf-natt" : "tf-neatt", ed != null) + '<div class="tf-nmeta">' + meta + "</div></div>";
  }
  /* ---- end markup ---- */
  function render() {
    const list = $("tfList");
    const rows = clientsShown();
    const withFiles = new Set(files.map((f) => f.ck));
    $("tfSummary").textContent = rows.length
      ? rows.filter(([k]) => withFiles.has(k)).length + " of " + rows.length + " clients have files · " + files.length + " file" + (files.length === 1 ? "" : "s") + " in total"
      : "";
    if (!rows.length) {
      list.innerHTML = '<div class="hint" style="padding:14px;">' + ($("tfSearch").value ? "No client matches that search." : "No clients found yet. Open the dashboard once so your tasks load, or tick “All workspace clients”.") + "</div>";
      return;
    }
    const act = document.activeElement;
    // The list is redrawn on every state change (attaching a file, pinning), so
    // whatever was being typed has to come back with its caret where it was.
    let caret = null;
    if (act && act.closest) {
      const ta = act.closest(".tf-nein") || act.closest(".tf-nin");
      if (ta) {
        const box = ta.closest(".tf-client");
        caret = {
          sel: ta.classList.contains("tf-nein")
            ? '.tf-note[data-nid="' + (ta.dataset.nid || "") + '"] .tf-nein'
            : '.tf-client[data-ck="' + ((box && box.dataset.ck) || "") + '"] .tf-nin',
          start: ta.selectionStart, end: ta.selectionEnd,
        };
      }
    }
    list.innerHTML = rows.map(([k, name]) => {
      const fs = files.filter((f) => f.ck === k).sort((a, b) => a.addedAt - b.addedAt);
      const ns = (notes[k] || []).slice().sort((a, b) => b.at - a.at);
      const isOpen = open.has(k);
      const isPin = pinned.indexOf(k) >= 0;
      const count = (fs.length ? fs.length + " file" + (fs.length === 1 ? "" : "s") : "no files") + (ns.length ? " · " + ns.length + " note" + (ns.length === 1 ? "" : "s") : "");
      let body = "";
      if (isOpen) {
        body = '<div class="tf-body">' +
          '<div class="tf-sec"><div class="tf-sech">📎 Files <span class="hint">Drop files here or use + Add files. Kept on this computer; their text is backed up to Drive (hidden app data).</span>' +
          (fs.length ? '<button type="button" class="tf-btn tf-drive" title="Copy these files to My Drive &gt; Personal ClickUp Manager &gt; Clients &gt; ' + esc(name) + ' (files already copied are skipped)">☁ Copy to Drive</button>' : "") + "</div>" +
          (fs.length ? fs.map(fileRow).join("") : '<div class="hint" style="padding:4px 2px;">No files yet.</div>') + "</div>" +
          '<div class="tf-sec"><div class="tf-sech">📝 Notes <span class="hint">What you were told, what to watch out for. Task details and "Explain this task" show them.</span></div>' +
          ns.map(noteHtml).join("") +
          '<div class="tf-nadd"><textarea class="tf-nin" maxlength="20000" placeholder="Add a note about ' + esc(name) + '… Paste a screenshot with Ctrl+V or drop files here. Ctrl+Enter saves.">' + esc(drafts[k] || "") + "</textarea>" +
          attHtml(noteFiles[k], "tf-npf", true) +
          '<div class="tf-nrow"><button type="button" class="tf-btn tf-nattach" title="Attach screenshots or files to this note">📎 Attach</button>' +
          '<label title="Also get a reminder about this note"><input type="checkbox" class="tf-nremon"' + (remindAt[k] ? " checked" : "") + " /> ⏰ Remind me at</label>" +
          '<input type="datetime-local" class="tf-nremat" value="' + esc(remindAt[k] || "") + '"' + (remindAt[k] ? "" : " disabled") + " />" +
          '<span class="sp"></span><button type="button" class="tf-btn pri tf-nsave">Save note</button></div></div>' +
          "</div></div>";
      }
      return '<div class="tf-client' + (isOpen ? " open" : "") + (isPin ? " pinned" : "") + (fs.length || ns.length ? "" : " empty") + '" data-ck="' + esc(k) + '" data-name="' + esc(name) + '">' +
        '<div class="tf-head"><button type="button" class="tf-tog" aria-expanded="' + isOpen + '">' + (isOpen ? "▾" : "▸") + "</button>" +
        '<span class="tf-name">' + esc(name) + "</span>" +
        '<span class="tf-count">' + count + "</span>" +
        '<button type="button" class="tf-pin' + (isPin ? " on" : "") + '" aria-pressed="' + isPin + '" title="' + (isPin ? "Unpin " + esc(name) : "Pin " + esc(name) + " to the top of the list") + '">📌</button>' +
        '<button type="button" class="tf-btn tf-add">+ Add files</button>' +
        (added.some((c) => F.key(c) === k) && !myClients.some((c) => F.key(c) === k) ? '<button type="button" class="tf-unadd" title="Take ' + esc(name) + ' off your list (its files and notes are kept, and keep it in the list while it has any)">✕</button>' : "") +
        "</div>" + body + "</div>";
    }).join("");
    if (focusNid) {
      const ta = list.querySelector('.tf-note[data-nid="' + focusNid + '"] .tf-nein');
      focusNid = "";
      if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; }
    } else if (caret) {
      const ta = list.querySelector(caret.sel);
      if (ta) { ta.focus(); try { ta.setSelectionRange(caret.start, caret.end); } catch (e) { ta.selectionStart = ta.selectionEnd = ta.value.length; } }
    }
    fillThumbs();
  }

  // ---- image thumbnails ----
  // The file behind a thumbnail, when this page already has it in memory: a
  // client file, a file waiting to go with the next note, or one just attached
  // to a note that is being edited.
  function blobFor(id) {
    const f = files.find((x) => x.id === id);
    if (f && f.blob) return f.blob;
    for (const bag of [noteFiles, editFiles]) {
      for (const k of Object.keys(bag)) {
        const p = (bag[k] || []).find((x) => x.id === id);
        if (p && p.blob) return p.blob;
      }
    }
    return null;
  }
  // One object URL per image, made once and reused across redraws. A note
  // attachment that isn't on this computer (they aren't backed up to Drive)
  // shows that on the tile instead of a broken image.
  async function fillThumbs() {
    for (const img of [...$("tfList").querySelectorAll("img[data-thumb]")]) {
      const id = img.getAttribute("data-thumb");
      const had = thumbs.get(id);
      if (had) { img.src = had; continue; }
      const blob = blobFor(id) || await F.attBlob({ id }).catch(() => null);
      if (!blob) {
        const tile = img.closest(".tf-shot");
        if (tile) tile.classList.add("gone"); else img.remove();
        continue;
      }
      const url = URL.createObjectURL(blob);
      thumbs.set(id, url);
      if (img.isConnected) img.src = url;
    }
  }
  function dropThumbs(ids) {
    for (const id of ids || []) { const u = thumbs.get(id); if (u) { URL.revokeObjectURL(u); thumbs.delete(id); } }
  }

  const say = (text, color) => { const msg = $("tfMsg"); msg.hidden = false; msg.style.color = color || ""; msg.textContent = text; };

  // ---- click a thumbnail to see the image full size ----
  const light = document.createElement("div");
  light.className = "tf-light";
  light.hidden = true;
  light.innerHTML = '<div class="tf-lbox"><img alt="" /><div class="tf-lbar"><span class="tf-lname"></span>' +
    '<button type="button" class="tf-btn tf-ltab" title="Open this image in its own browser tab">Open in a new tab</button>' +
    '<button type="button" class="tf-btn tf-lx" title="Close (Esc)">✕ Close</button></div></div>';
  document.body.appendChild(light);
  let lightUrl = "", lightFile = null;
  function closeLight() {
    light.hidden = true;
    light.querySelector("img").removeAttribute("src");
    if (lightUrl) { URL.revokeObjectURL(lightUrl); lightUrl = ""; }
    lightFile = null;
  }
  // Its own object URL, not the thumbnail's: closing revokes this one and the
  // thumbnail behind it has to survive that.
  function showLight(blob, name) {
    closeLight();
    lightUrl = URL.createObjectURL(blob);
    lightFile = { blob, name };
    const img = light.querySelector("img");
    img.src = lightUrl;
    img.alt = name || "";
    light.querySelector(".tf-lname").textContent = name || "";
    light.hidden = false;
  }
  // Show the image behind a thumbnail, wherever it is stored.
  async function expand(id, name) {
    const blob = blobFor(id) || await F.attBlob({ id }).catch(() => null);
    if (!blob) { say("“" + name + "” isn't on this computer (note attachments aren't backed up to Drive).", "var(--amber, #d97706)"); return; }
    showLight(blob, name);
  }
  light.addEventListener("click", (e) => {
    if (e.target.closest(".tf-ltab")) {
      if (lightFile) { try { F.openFile(lightFile); } catch (err) { say(String((err && err.message) || err), "var(--red)"); } }
      return;
    }
    if (e.target.closest(".tf-lx") || e.target === light) closeLight();
  });
  // Capture, so Escape closes the image instead of whatever else is listening.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !light.hidden) { e.preventDefault(); e.stopPropagation(); closeLight(); }
  }, true);

  // ---- adding files ----
  const picker = $("tfPicker");
  let pickFor = null;
  async function addTo(ck, name, list) {
    if (!list || !list.length) return;
    open.add(ck);
    say("Reading " + list.length + " file" + (list.length === 1 ? "" : "s") + " for " + name + "…");
    try {
      const added = await F.add(name, list);
      const bad = added.filter((r) => r.kind === "unreadable");
      say("Added " + added.length + " file" + (added.length === 1 ? "" : "s") + " to " + name + "." +
        (bad.length ? " Couldn't read: " + bad.map((r) => r.name + " (" + r.why + ")").join(", ") + "." : ""), bad.length ? "var(--amber, #d97706)" : "");
    } catch (e) { say("Couldn't add: " + (e && e.message ? e.message : e), "var(--red)"); }
    await load();
  }
  picker.onchange = () => { if (pickFor) addTo(pickFor.ck, pickFor.name, [...picker.files]); picker.value = ""; };
  // Replace one file: the new one is added first, then the old one removed, so
  // a file that can't be read never leaves the client without its audit.
  const replacePicker = document.createElement("input");
  replacePicker.type = "file"; replacePicker.hidden = true; replacePicker.accept = picker.accept;
  document.body.appendChild(replacePicker);
  let replaceFor = null;
  replacePicker.onchange = async () => {
    const file = replacePicker.files[0], old = replaceFor;
    replacePicker.value = ""; replaceFor = null;
    if (!file || !old) return;
    open.add(old.ck);
    say("Reading " + file.name + "…");
    try {
      const [rec] = await F.add(old.client, [file]);
      if (!rec || rec.kind === "unreadable") { say("Couldn't read " + file.name + (rec && rec.why ? " (" + rec.why + ")" : "") + ", so " + old.name + " was kept.", "var(--amber, #d97706)"); if (rec) await F.remove(rec.id); }
      else { await F.remove(old.id); say("Replaced " + old.name + " with " + file.name + " for " + old.client + "."); }
    } catch (e) { say("Couldn't replace: " + (e && e.message ? e.message : e), "var(--red)"); }
    await load();
  };

  // ---- files for a note: the next one, or the one being edited ----
  const noteInput = document.createElement("input");
  noteInput.type = "file"; noteInput.multiple = true; noteInput.hidden = true;
  document.body.appendChild(noteInput);
  const editInput = document.createElement("input");
  editInput.type = "file"; editInput.multiple = true; editInput.hidden = true;
  document.body.appendChild(editInput);
  let noteFor = "", editFor = "";
  // A file picked, pasted or dropped. A screenshot off the clipboard arrives as
  // "image.png", which would say nothing on a note a month from now.
  function newPending(f) {
    const d = new Date();
    const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".png";
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name, type: f.type || "application/octet-stream", size: f.size, blob: f };
  }
  // The same limits either way, so attaching to a new note and attaching while
  // editing an old one can't drift apart.
  function takeFiles(cur, list) {
    for (const f of [...list].slice(0, 10)) {
      if (cur.length >= 10) { say("Up to 10 files per note.", "var(--amber, #d97706)"); break; }
      if (f.size > 20 * 1048576) { say(f.name + " is over 20 MB.", "var(--amber, #d97706)"); continue; }
      cur.push(newPending(f));
    }
  }
  function addNoteFiles(ck, list) {
    takeFiles(noteFiles[ck] || (noteFiles[ck] = []), list);
    open.add(ck);
    render();
  }
  // Attached while editing: held in editFiles until Save, so Cancel undoes it.
  function addEditFiles(nid, list) {
    takeFiles(editFiles[nid] || (editFiles[nid] = []), list);
    render();
  }
  // Leaving the editor. Files that were added but never saved can let go of
  // their thumbnails; the ones Save just wrote keep theirs for the redraw.
  function endEdit(nid, dropPending) {
    if (dropPending) dropThumbs((editFiles[nid] || []).filter((f) => f.blob).map((f) => f.id));
    delete editing[nid];
    delete editFiles[nid];
  }
  noteInput.onchange = () => { if (noteFor) addNoteFiles(noteFor, [...noteInput.files]); noteInput.value = ""; };
  editInput.onchange = () => { if (editFor) addEditFiles(editFor, [...editInput.files]); editInput.value = ""; };

  async function saveNote(box, ck, name) {
    const ta = box.querySelector(".tf-nin");
    const text = String((ta && ta.value) || "").trim();
    const pend = noteFiles[ck] || [];
    if (!text && !pend.length) { if (ta) ta.focus(); return; }
    const remOn = box.querySelector(".tf-nremon"), remAtEl = box.querySelector(".tf-nremat");
    const when = remOn && remOn.checked && remAtEl && remAtEl.value ? new Date(remAtEl.value).getTime() : 0;
    if (remOn && remOn.checked && !(when > Date.now())) { say("Pick a reminder time that hasn't passed (or untick ⏰ Remind me at).", "var(--red)"); return; }
    try {
      if (pend.length) await F.attPut(pend.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size, blob: p.blob, at: Date.now() })));
    } catch (e) { say("Couldn't save the files (is the disk full?).", "var(--red)"); return; }
    const meta = pend.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size }));
    const list = (notes[ck] || []).slice();
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: (text || pend.map((p) => p.name).join(", ")).slice(0, 20000), at: Date.now(), client: name, files: meta });
    await F.saveNotes(name, list);
    let msg = "Note saved for " + name + ".";
    if (when) {
      try { msg += " Reminder set for " + (await window.PcmReminders.add({ text: name + ": " + (text || "note"), at: when, files: meta })) + "."; }
      catch (e) { msg += " The reminder wasn't set: " + e.message; }
    }
    delete drafts[ck]; delete noteFiles[ck]; delete remindAt[ck];
    say(msg);
    await load();
  }

  $("tfList").addEventListener("click", async (e) => {
    const box = e.target.closest(".tf-client");
    if (!box) return;
    const ck = box.dataset.ck, name = box.dataset.name;
    if (e.target.closest(".tf-add")) { e.stopPropagation(); pickFor = { ck, name }; picker.click(); return; }
    // Before the .tf-head branch below: the pin sits in the header, and a click
    // on it must not also open or shut the client.
    if (e.target.closest(".tf-unadd")) {
      e.stopPropagation();
      added = added.filter((c) => F.key(c) !== ck);
      send({ type: "SET_SETTINGS", patch: { tfAdded: added } });
      say(name + " is off your list" + ((files.some((f) => f.ck === ck) || (notes[ck] || []).length) ? " (it still shows while it has files or notes)." : "."));
      render();
      return;
    }
    if (e.target.closest(".tf-pin")) {
      e.stopPropagation();
      const i = pinned.indexOf(ck);
      if (i < 0) pinned.unshift(ck); else pinned.splice(i, 1);
      pinned = pinned.slice(0, 50);
      send({ type: "SET_SETTINGS", patch: { tfPinned: pinned } });
      say(i < 0 ? name + " is pinned to the top." : name + " is no longer pinned.");
      render();
      return;
    }
    if (e.target.closest(".tf-nin, .tf-nein, .tf-nremat")) return; // typing
    if (e.target.closest(".tf-nremon")) {
      const c = e.target.closest(".tf-nremon");
      if (c.checked) { const d = new Date(Date.now() + 24 * 3600000); d.setHours(9, 0, 0, 0); remindAt[ck] = toLocalInput(d.getTime()); } else remindAt[ck] = "";
      const at = box.querySelector(".tf-nremat");
      if (at) { at.disabled = !c.checked; at.value = remindAt[ck]; }
      return;
    }
    if (e.target.closest(".tf-nattach")) { noteFor = ck; noteInput.click(); return; }
    if (e.target.closest(".tf-npf-x")) {
      const i = Number(e.target.closest(".tf-npf").dataset.i);
      const gone = (noteFiles[ck] || [])[i];
      if (gone) dropThumbs([gone.id]);
      (noteFiles[ck] || []).splice(i, 1);
      render();
      return;
    }
    if (e.target.closest(".tf-npf")) {
      const m = (noteFiles[ck] || []).find((x) => x.id === e.target.closest(".tf-npf").dataset.fid);
      if (m && isImage(m)) expand(m.id, m.name);
      return;
    }
    if (e.target.closest(".tf-nsave")) { await saveNote(box, ck, name); return; }
    if (e.target.closest(".tf-drive")) {
      const b = e.target.closest(".tf-drive");
      b.disabled = true; b.textContent = "Copying…";
      say("Copying " + name + "'s files to your Google Drive… (Google may ask for access the first time)");
      const r = await send({ type: "TF_DRIVE_COPY", client: name }, 300000);
      b.disabled = false; b.textContent = "☁ Copy to Drive";
      if (!r || !r.ok) { say("Couldn't copy to Drive: " + ((r && r.error) || "no answer"), "var(--red)"); return; }
      say("In your Drive: Personal ClickUp Manager › Clients › " + name + " - " + r.uploaded + " copied" + (r.skipped ? ", " + r.skipped + " already there" : "") + (r.textOnly ? " (" + r.textOnly + " as text only - added before originals were kept)" : "") + ".");
      window.open(r.url, "_blank", "noopener");
      return;
    }
    const fileEl = e.target.closest(".tf-file");
    if (fileEl) {
      const f = files.find((x) => x.id === fileEl.dataset.id);
      if (!f) return;
      try {
        if (e.target.closest(".tf-fthumb")) { expand(f.id, f.name); }
        else if (e.target.closest(".tf-open")) { const orig = F.openFile(f); if (!orig) say("Only the text of “" + f.name + "” was kept (it was added before originals were kept) - that's what opened. Add the file again to keep the original."); }
        else if (e.target.closest(".tf-show")) {
          const r = await F.showInFolder(f);
          say(r.reused ? "Opened the copy in Downloads › Personal ClickUp Manager › Clients › " + f.client + "." : "Saved a copy to Downloads › Personal ClickUp Manager › Clients › " + f.client + (r.original ? "" : " (as text - the original wasn't kept)") + " - next time it just opens that copy.");
        }
        else if (e.target.closest(".tf-replace")) { replaceFor = f; replacePicker.click(); }
        else if (e.target.closest(".tf-rm")) { if (confirm("Remove “" + f.name + "” from " + name + "?")) { dropThumbs([f.id]); await F.remove(f.id); await load(); } }
      } catch (err) { say(String((err && err.message) || err), "var(--red)"); }
      return;
    }
    const nEl = e.target.closest(".tf-note");
    if (nEl) {
      const list = (notes[ck] || []).slice();
      const n = list.find((x) => x.id === nEl.dataset.nid);
      if (!n) return;
      const att = e.target.closest(".tf-natt");
      if (att) {
        const m = (n.files || []).find((x) => x.id === att.dataset.fid);
        if (m) { if (att.classList.contains("tf-shot")) expand(m.id, m.name); else F.openAttachment(m).catch((err) => say(err.message, "var(--red)")); }
        return;
      }
      // The attachments while the note is being edited: one more, or one fewer.
      // Both only reach storage when Save is pressed.
      if (e.target.closest(".tf-neattach")) { editFor = n.id; editInput.click(); return; }
      const exEl = e.target.closest(".tf-neatt-x");
      if (exEl) {
        const cur = editFiles[n.id] || (editFiles[n.id] = (n.files || []).slice());
        const [gone] = cur.splice(Number(exEl.closest(".tf-neatt").dataset.i), 1);
        if (gone && gone.blob) dropThumbs([gone.id]); // never saved, so its URL can go now
        render();
        return;
      }
      const eatt = e.target.closest(".tf-neatt");
      if (eatt) {
        const m = (editFiles[n.id] || n.files || []).find((x) => x.id === eatt.dataset.fid);
        if (m) { if (isImage(m)) expand(m.id, m.name); else if (!m.blob) F.openAttachment(m).catch((err) => say(err.message, "var(--red)")); }
        return;
      }
      // Tick / untick a checkbox in the shown note - saved at once, no Edit needed.
      const mbox = e.target.closest(".tf-nt .md-box");
      if (mbox && window.PcmMd) {
        const idx = [...nEl.querySelectorAll(".tf-nt .md-box")].indexOf(mbox);
        const txt = window.PcmMd.toggleTask(n.text, idx);
        if (txt !== n.text) { n.text = txt; await F.saveNotes(name, list); await load(); }
        return;
      }
      if (e.target.closest(".tf-ndel")) {
        if (confirm("Delete this note about " + name + "?")) { const ids = (n.files || []).map((x) => x.id); endEdit(n.id, true); await F.saveNotes(name, list.filter((x) => x !== n)); await F.attCleanup(ids); dropThumbs(ids); await load(); }
        return;
      }
      // Editing happens in place, in a textarea where the note's text was.
      if (e.target.closest(".tf-nedit")) { editing[n.id] = n.text; editFiles[n.id] = (n.files || []).slice(); focusNid = n.id; render(); return; }
      if (e.target.closest(".tf-necancel")) { endEdit(n.id, true); render(); return; }
      if (e.target.closest(".tf-nesave")) {
        const ta = nEl.querySelector(".tf-nein");
        const v = String(ta ? ta.value : editing[n.id] || "").trim();
        const work = editFiles[n.id] || (n.files || []).slice();
        if (!v && !work.length) { say("A note needs some text (or a file attached). Use ✕ to delete it instead.", "var(--amber, #d97706)"); if (ta) ta.focus(); return; }
        const pend = work.filter((f) => f.blob);          // attached since Edit was pressed
        const kept = new Set(work.map((f) => f.id));
        const gone = (n.files || []).filter((f) => !kept.has(f.id)).map((f) => f.id);
        if (pend.length) {
          try { await F.attPut(pend.map((p) => ({ id: p.id, name: p.name, type: p.type, size: p.size, blob: p.blob, at: Date.now() }))); }
          catch (err) { say("Couldn't save the files (is the disk full?).", "var(--red)"); return; }
        }
        endEdit(n.id, false);
        if (v === n.text && !pend.length && !gone.length) { render(); return; }
        n.text = v.slice(0, 20000);
        n.files = work.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size }));
        n.editedAt = Date.now();
        await F.saveNotes(name, list);
        // After the note is written, never before: attCleanup keeps anything a
        // note or a reminder still points at, and this note is one of them.
        if (gone.length) { await F.attCleanup(gone); dropThumbs(gone); }
        await load();
        return;
      }
      // The page's outside-click would close the reminder card at once.
      if (e.target.closest(".tf-nrem")) { e.stopPropagation(); if (window.PcmReminders) window.PcmReminders.open({ text: (name + ": " + n.text).slice(0, 200), files: n.files || [] }, e.target); return; }
      return;
    }
    if (e.target.closest(".tf-head")) { if (open.has(ck)) open.delete(ck); else open.add(ck); render(); }
  });
  $("tfList").addEventListener("input", (e) => {
    const ta = e.target.closest(".tf-nin"); if (ta) drafts[ta.closest(".tf-client").dataset.ck] = ta.value;
    const ed = e.target.closest(".tf-nein"); if (ed) editing[ed.dataset.nid] = ed.value;
    const at = e.target.closest(".tf-nremat"); if (at) remindAt[at.closest(".tf-client").dataset.ck] = at.value;
  });
  $("tfList").addEventListener("keydown", (e) => {
    const ta = e.target.closest(".tf-nin");
    if (ta && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const box = ta.closest(".tf-client"); saveNote(box, box.dataset.ck, box.dataset.name); return; }
    const ed = e.target.closest(".tf-nein");
    if (!ed) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const b = ed.closest(".tf-note").querySelector(".tf-nesave"); if (b) b.click(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endEdit(ed.dataset.nid, true); render(); }
  });
  // Paste a screenshot into a note - the one being written, or one being edited.
  $("tfList").addEventListener("paste", (e) => {
    const ed = e.target.closest(".tf-nein");
    const ta = ed || e.target.closest(".tf-nin");
    if (!ta) return;
    const fl = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!fl.length) return;
    e.preventDefault();
    if (ed) addEditFiles(ed.dataset.nid, fl);
    else addNoteFiles(ta.closest(".tf-client").dataset.ck, fl);
  });
  // Drop: on a note being edited = attach to it; on the note box = attach to
  // the next note; anywhere else on a client = add files to the client.
  const dropTarget = (e) => e.target.closest(".tf-note.editing") || e.target.closest(".tf-nadd") || e.target.closest(".tf-client");
  $("tfList").addEventListener("dragover", (e) => { const b = dropTarget(e); if (b) { e.preventDefault(); b.classList.add("over"); } });
  $("tfList").addEventListener("dragleave", (e) => { const b = dropTarget(e); if (b && !b.contains(e.relatedTarget)) b.classList.remove("over"); });
  $("tfList").addEventListener("drop", (e) => {
    const b = e.target.closest(".tf-client");
    if (!b) return;
    e.preventDefault();
    document.querySelectorAll("#tfList .over").forEach((x) => x.classList.remove("over"));
    const fl = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    const en = e.target.closest(".tf-note.editing");
    if (en) addEditFiles(en.dataset.nid, fl);
    else if (e.target.closest(".tf-nadd")) addNoteFiles(b.dataset.ck, fl);
    else addTo(b.dataset.ck, b.dataset.name, fl);
  });

  // ---- add a client from ClickUp (also one you aren't assigned to) ----
  // A list of every client in the workspace (the same list as "All workspace
  // clients", read from ClickUp once a day) opens as soon as the box is clicked;
  // typing narrows it. Only real ClickUp clients can be added.
  let wsState = "idle", wsErr = ""; // idle | loading | ok | error
  async function workspaceClients(force) {
    if (allClients.length && !force) return allClients;
    wsState = "loading"; paintPop();
    const r = await send({ type: "CLICKUP_CLIENT_NAMES", force: !!force }, 90000).catch(() => null);
    allClients = (r && Array.isArray(r.names) ? r.names : []).map((n) => (typeof n === "string" ? n : n && n.name) || "").filter(Boolean);
    wsState = allClients.length ? "ok" : "error";
    wsErr = allClients.length ? "" : !r ? "the extension's background didn't answer - reload the extension (chrome://extensions › ⟳) and try again."
      : (r.reason === "not-configured" ? "Connect ClickUp first (ClickUp setup)." : r.error) || "ClickUp didn't send any clients.";
    paintPop();
    return allClients;
  }
  const inList = (ck) => myClients.some((c) => F.key(c) === ck) || added.some((c) => F.key(c) === ck);
  let hi = 0, popItems = [];
  function paintPop() {
    const pop = $("tfAddPop"), inp = $("tfAddClient");
    if (!pop || pop.hidden) return;
    pop.textContent = "";
    const msg = (html) => { const d = document.createElement("div"); d.className = "msg"; d.innerHTML = html; pop.appendChild(d); return d; };
    if (wsState === "loading" && !allClients.length) { msg("Loading every client from ClickUp… (the first time takes a few seconds)"); return; }
    if (wsState === "error" && !allClients.length) {
      const d = msg("Couldn't read the clients from ClickUp: " + esc(wsErr) + " <a data-retry>Try again</a>");
      d.querySelector("[data-retry]").onclick = (e) => { e.preventDefault(); workspaceClients(true); };
      return;
    }
    const q = F.key(inp.value);
    popItems = allClients.slice().sort((a, b) => sortName(a).localeCompare(sortName(b))).filter((c) => !q || F.key(c).includes(q));
    if (!popItems.length) { msg("No ClickUp client matches “" + esc(inp.value.trim()) + "”."); return; }
    hi = Math.min(hi, popItems.length - 1);
    popItems.slice(0, 300).forEach((c, i) => {
      const there = inList(F.key(c));
      const b = document.createElement("button");
      b.type = "button"; b.className = "it" + (i === hi ? " on" : ""); b.setAttribute("role", "option");
      b.disabled = there;
      b.innerHTML = '<span class="nm">' + esc(c) + "</span>" + (there ? '<span class="tag">in your list</span>' : "");
      b.onmousedown = (e) => e.preventDefault(); // keep the box focused
      b.onclick = () => addClient(c);
      pop.appendChild(b);
    });
  }
  function openPop() {
    const pop = $("tfAddPop");
    pop.hidden = false; $("tfAddClient").setAttribute("aria-expanded", "true");
    hi = 0;
    paintPop();
    if (!allClients.length && wsState !== "loading") workspaceClients();
  }
  function closePop() { $("tfAddPop").hidden = true; $("tfAddClient").setAttribute("aria-expanded", "false"); }
  async function addClient(pick) {
    let name = pick;
    if (!name) {
      // Add button / Enter: the highlighted client, or the one exact match.
      const all = await workspaceClients();
      const typed = F.key($("tfAddClient").value);
      name = all.find((c) => F.key(c) === typed) || (popItems.length && !$("tfAddPop").hidden ? popItems[hi] : "");
      if (!name) { openPop(); if (typed) say("Pick a client from the list - only clients in your ClickUp workspace can be added.", "var(--amber, #d97706)"); return; }
    }
    const ck = F.key(name);
    $("tfAddClient").value = "";
    closePop();
    open.add(ck);
    if (inList(ck)) { say(name + " is already in your list."); render(); return; }
    added = [name].concat(added).slice(0, 200);
    send({ type: "SET_SETTINGS", patch: { tfAdded: added } });
    say(name + " added to your list - add its files and notes below. Its tasks pick them up automatically (Explain, Ask with, Verify).");
    render();
    const el = [...document.querySelectorAll("#tfList .tf-client")].find((b) => b.dataset.ck === ck);
    if (el) try { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
  }
  $("tfAddClient").addEventListener("focus", openPop);
  $("tfAddClient").addEventListener("click", openPop);
  $("tfAddClient").addEventListener("input", () => { hi = 0; if ($("tfAddPop").hidden) openPop(); else paintPop(); });
  $("tfAddClient").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if ($("tfAddPop").hidden) { openPop(); return; }
      const n = Math.min(popItems.length, 300);
      if (!n) return;
      hi = (hi + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      paintPop();
      const on = $("tfAddPop").querySelector(".it.on"); if (on) on.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") { e.preventDefault(); addClient(); }
    else if (e.key === "Escape") closePop();
  });
  $("tfAddClient").addEventListener("blur", () => setTimeout(closePop, 150));
  $("tfAddClientBtn").onclick = () => addClient();

  // ---- filters ----
  $("tfSearch").oninput = render;
  $("tfAll").onchange = async () => {
    if ($("tfAll").checked && !allClients.length) {
      $("tfSummary").textContent = "Loading every client in the workspace…";
      await workspaceClients().catch(() => []);
    }
    render();
  };

  // ---- Drive backup ----
  chrome.storage.local.get("settings").then((g) => { $("tfDrive").checked = !(g.settings && g.settings.taskFilesDrive === false); }).catch(() => {});
  $("tfDrive").onchange = () => {
    send({ type: "SET_SETTINGS", patch: { taskFilesDrive: $("tfDrive").checked } });
    if ($("tfDrive").checked) send({ type: "TASKFILES_SYNC" }, 120000);
  };

  // Load when the tab is first opened; a fresh install signed in to Drive gets
  // its files back from the backup first.
  let loaded = false;
  const panel = document.querySelector('.panel[data-panel="files"]');
  const maybeLoad = async () => {
    if (loaded || !panel || !panel.classList.contains("on")) return;
    loaded = true;
    await load();
    if (!files.length) {
      const r = await send({ type: "TASKFILES_SYNC" }, 120000);
      if (r && r.restored) { say("Restored " + r.restored + " file" + (r.restored === 1 ? "" : "s") + " from your Drive backup."); await load(); }
    }
  };
  new MutationObserver(maybeLoad).observe(panel, { attributes: true, attributeFilter: ["class"] });
  maybeLoad();
  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.taskFilesChangedAt || ch.clientNotes) && loaded) load(); });
})();
