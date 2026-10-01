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
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtSize = (n) => n < 1024 ? n + " B" : n < 1048576 ? Math.round(n / 1024) + " KB" : (n / 1048576).toFixed(1) + " MB";
  const day = (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const icon = (r) => r.kind === "image" ? "\u{1F5BC}" : r.kind === "unreadable" ? "⚠" : /\.pdf$/i.test(r.name) ? "\u{1F4D5}" : /\.(xlsx|csv|tsv)$/i.test(r.name) ? "\u{1F4CA}" : /\.html?$/i.test(r.name) ? "\u{1F310}" : "\u{1F4C4}";
  const pad = (n) => String(n).padStart(2, "0");
  const toLocalInput = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes()); };

  let myClients = [];     // from my tasks
  let allClients = [];    // whole workspace (loaded on demand)
  let files = [];         // every stored file
  let notes = {};         // client key -> [{ id, text, at, editedAt, client, files }]
  const drafts = {};      // client key -> note text being typed (kept across redraws)
  const noteFiles = {};   // client key -> files waiting to go with the next note
  const remindAt = {};    // client key -> "" | datetime-local value for the next note
  const open = new Set(); // expanded client keys

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

  async function load() {
    files = await F.all().catch(() => []);
    notes = await F.allNotes().catch(() => ({}));
    myClients = await mine();
    render();
  }

  function clientsShown() {
    const byKey = new Map();
    const src = $("tfAll").checked && allClients.length ? allClients : myClients;
    for (const c of src) byKey.set(F.key(c), c);
    for (const f of files) if (!byKey.has(f.ck)) byKey.set(f.ck, f.client); // clients with files always show
    for (const k of Object.keys(notes)) if (!byKey.has(k) && (notes[k] || []).length) byKey.set(k, notes[k][0].client || k); // and clients with notes
    const q = $("tfSearch").value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [...byKey.entries()].filter(([k]) => !q || k.includes(q)).sort((a, b) => a[1].replace(/^[^a-z0-9]+/i, "").localeCompare(b[1].replace(/^[^a-z0-9]+/i, "")));
  }

  function fileRow(f) {
    const kept = !!(f.blob || f.html);
    const what = f.kind === "text" ? (f.text || "").length.toLocaleString() + " characters read" : f.kind === "image" ? "image" : esc(f.why || "can't be read");
    return '<div class="tf-file' + (f.kind === "unreadable" ? " bad" : "") + '" data-id="' + esc(f.id) + '"><span>' + icon(f) + "</span>" +
      '<div style="min-width:0"><div class="tf-fn" title="' + esc(f.name) + '">' + esc(f.name) + '</div><div class="tf-fm">' + fmtSize(f.size || 0) + " · added " + day(f.addedAt) + " · " + what + (kept ? "" : " · only its text is kept") + "</div></div>" +
      '<div class="tf-facts"><button type="button" class="tf-btn tf-open" title="' + (kept ? "Open it (images, PDF, web pages and text open in a tab; other files download)" : "Open the text that was read from it (the original wasn't kept - it was added before files were kept)") + '">Open</button>' +
      '<button type="button" class="tf-btn tf-show" title="Opens the folder with this file. The first time, a copy is saved to Downloads &gt; Personal ClickUp Manager &gt; Clients &gt; ' + esc(f.client) + ' (the file itself is stored inside Chrome, not in a folder); after that the same copy is shown.">Show in folder</button>' +
      '<button type="button" class="tf-btn tf-replace" title="Swap this file for a newer one (for example August\'s audit for September\'s). To keep both, use + Add files instead.">Replace</button>' +
      '<button type="button" class="tf-btn tf-rm" title="Remove this file">✕</button></div></div>';
  }
  function chipsHtml(list, cls, removable) {
    if (!list || !list.length) return "";
    return '<div class="tf-chips">' + list.map((f, i) => '<span class="tf-chip ' + cls + '" data-i="' + i + '" data-fid="' + esc(f.id) + '" title="' + esc(f.name) + '"><span>📎 ' + esc(f.name) + "</span>" +
      (removable ? '<button type="button" class="tf-npf-x" title="Remove">✕</button>' : "") + "</span>").join("") + "</div>";
  }
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
    const focused = act && act.closest && act.closest(".tf-nin") ? act.closest(".tf-client").dataset.ck : "";
    list.innerHTML = rows.map(([k, name]) => {
      const fs = files.filter((f) => f.ck === k).sort((a, b) => a.addedAt - b.addedAt);
      const ns = (notes[k] || []).slice().sort((a, b) => b.at - a.at);
      const isOpen = open.has(k);
      const count = (fs.length ? fs.length + " file" + (fs.length === 1 ? "" : "s") : "no files") + (ns.length ? " · " + ns.length + " note" + (ns.length === 1 ? "" : "s") : "");
      let body = "";
      if (isOpen) {
        body = '<div class="tf-body">' +
          '<div class="tf-sec"><div class="tf-sech">📎 Files <span class="hint">Drop files here or use + Add files. Kept on this computer; their text is backed up to Drive (hidden app data).</span>' +
          (fs.length ? '<button type="button" class="tf-btn tf-drive" title="Copy these files to My Drive &gt; Personal ClickUp Manager &gt; Clients &gt; ' + esc(name) + ' (files already copied are skipped)">☁ Copy to Drive</button>' : "") + "</div>" +
          (fs.length ? fs.map(fileRow).join("") : '<div class="hint" style="padding:4px 2px;">No files yet.</div>') + "</div>" +
          '<div class="tf-sec"><div class="tf-sech">📝 Notes <span class="hint">What you were told, what to watch out for. Task details and "Explain this task" show them.</span></div>' +
          ns.map((n) => '<div class="tf-note" data-nid="' + esc(n.id) + '"><div class="tf-nt">' + esc(n.text) + "</div>" + chipsHtml(n.files, "tf-natt", false) +
            '<div class="tf-nmeta"><span class="hint">' + day(n.at) + (n.editedAt ? " · edited" : "") + "</span>" +
            '<button type="button" class="tf-btn tf-nrem" title="Set a reminder about this note (any date and time)">⏰ Remind me</button><button type="button" class="tf-btn tf-nedit">Edit</button><button type="button" class="tf-btn tf-ndel" title="Delete this note">✕</button></div></div>').join("") +
          '<div class="tf-nadd"><textarea class="tf-nin" maxlength="2000" placeholder="Add a note about ' + esc(name) + '… Paste a screenshot with Ctrl+V or drop files here. Ctrl+Enter saves.">' + esc(drafts[k] || "") + "</textarea>" +
          chipsHtml(noteFiles[k], "tf-npf", true) +
          '<div class="tf-nrow"><button type="button" class="tf-btn tf-nattach" title="Attach screenshots or files to this note">📎 Attach</button>' +
          '<label title="Also get a reminder about this note"><input type="checkbox" class="tf-nremon"' + (remindAt[k] ? " checked" : "") + " /> ⏰ Remind me at</label>" +
          '<input type="datetime-local" class="tf-nremat" value="' + esc(remindAt[k] || "") + '"' + (remindAt[k] ? "" : " disabled") + " />" +
          '<span class="sp"></span><button type="button" class="tf-btn pri tf-nsave">Save note</button></div></div>' +
          "</div></div>";
      }
      return '<div class="tf-client' + (isOpen ? " open" : "") + (fs.length || ns.length ? "" : " empty") + '" data-ck="' + esc(k) + '" data-name="' + esc(name) + '">' +
        '<div class="tf-head"><button type="button" class="tf-tog" aria-expanded="' + isOpen + '">' + (isOpen ? "▾" : "▸") + "</button>" +
        '<span class="tf-name">' + esc(name) + "</span>" +
        '<span class="tf-count">' + count + "</span>" +
        '<button type="button" class="tf-btn tf-add">+ Add files</button></div>' + body + "</div>";
    }).join("");
    if (focused) { const ta = list.querySelector('.tf-client[data-ck="' + focused + '"] .tf-nin'); if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; } }
  }

  const say = (text, color) => { const msg = $("tfMsg"); msg.hidden = false; msg.style.color = color || ""; msg.textContent = text; };

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

  // ---- files for the next note ----
  const noteInput = document.createElement("input");
  noteInput.type = "file"; noteInput.multiple = true; noteInput.hidden = true;
  document.body.appendChild(noteInput);
  let noteFor = "";
  function addNoteFiles(ck, list) {
    const cur = noteFiles[ck] || (noteFiles[ck] = []);
    for (const f of [...list].slice(0, 10)) {
      if (cur.length >= 10) { say("Up to 10 files per note.", "var(--amber, #d97706)"); break; }
      if (f.size > 20 * 1048576) { say(f.name + " is over 20 MB.", "var(--amber, #d97706)"); continue; }
      const d = new Date();
      const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".png";
      cur.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), name, type: f.type || "application/octet-stream", size: f.size, blob: f });
    }
    open.add(ck);
    render();
  }
  noteInput.onchange = () => { if (noteFor) addNoteFiles(noteFor, [...noteInput.files]); noteInput.value = ""; };

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
    list.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: (text || pend.map((p) => p.name).join(", ")).slice(0, 2000), at: Date.now(), client: name, files: meta });
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
    if (e.target.closest(".tf-nin, .tf-nremat")) return; // typing
    if (e.target.closest(".tf-nremon")) {
      const c = e.target.closest(".tf-nremon");
      if (c.checked) { const d = new Date(Date.now() + 24 * 3600000); d.setHours(9, 0, 0, 0); remindAt[ck] = toLocalInput(d.getTime()); } else remindAt[ck] = "";
      const at = box.querySelector(".tf-nremat");
      if (at) { at.disabled = !c.checked; at.value = remindAt[ck]; }
      return;
    }
    if (e.target.closest(".tf-nattach")) { noteFor = ck; noteInput.click(); return; }
    if (e.target.closest(".tf-npf-x")) { const i = Number(e.target.closest(".tf-npf").dataset.i); (noteFiles[ck] || []).splice(i, 1); render(); return; }
    if (e.target.closest(".tf-npf")) return;
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
        if (e.target.closest(".tf-open")) { const orig = F.openFile(f); if (!orig) say("Only the text of “" + f.name + "” was kept (it was added before originals were kept) - that's what opened. Add the file again to keep the original."); }
        else if (e.target.closest(".tf-show")) {
          const r = await F.showInFolder(f);
          say(r.reused ? "Opened the copy in Downloads › Personal ClickUp Manager › Clients › " + f.client + "." : "Saved a copy to Downloads › Personal ClickUp Manager › Clients › " + f.client + (r.original ? "" : " (as text - the original wasn't kept)") + " - next time it just opens that copy.");
        }
        else if (e.target.closest(".tf-replace")) { replaceFor = f; replacePicker.click(); }
        else if (e.target.closest(".tf-rm")) { if (confirm("Remove “" + f.name + "” from " + name + "?")) { await F.remove(f.id); await load(); } }
      } catch (err) { say(String((err && err.message) || err), "var(--red)"); }
      return;
    }
    const nEl = e.target.closest(".tf-note");
    if (nEl) {
      const list = (notes[ck] || []).slice();
      const n = list.find((x) => x.id === nEl.dataset.nid);
      if (!n) return;
      const att = e.target.closest(".tf-natt");
      if (att) { const m = (n.files || []).find((x) => x.id === att.dataset.fid); if (m) F.openAttachment(m).catch((err) => say(err.message, "var(--red)")); return; }
      if (e.target.closest(".tf-ndel")) {
        if (confirm("Delete this note about " + name + "?")) { const ids = (n.files || []).map((x) => x.id); await F.saveNotes(name, list.filter((x) => x !== n)); await F.attCleanup(ids); await load(); }
        return;
      }
      if (e.target.closest(".tf-nedit")) { const v = prompt("Edit the note", n.text); if (v == null || !v.trim()) return; n.text = v.trim().slice(0, 2000); n.editedAt = Date.now(); await F.saveNotes(name, list); await load(); return; }
      // The page's outside-click would close the reminder card at once.
      if (e.target.closest(".tf-nrem")) { e.stopPropagation(); if (window.PcmReminders) window.PcmReminders.open({ text: (name + ": " + n.text).slice(0, 200), files: n.files || [] }, e.target); return; }
      return;
    }
    if (e.target.closest(".tf-head")) { if (open.has(ck)) open.delete(ck); else open.add(ck); render(); }
  });
  $("tfList").addEventListener("input", (e) => {
    const ta = e.target.closest(".tf-nin"); if (ta) drafts[ta.closest(".tf-client").dataset.ck] = ta.value;
    const at = e.target.closest(".tf-nremat"); if (at) remindAt[at.closest(".tf-client").dataset.ck] = at.value;
  });
  $("tfList").addEventListener("keydown", (e) => {
    const ta = e.target.closest(".tf-nin");
    if (ta && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const box = ta.closest(".tf-client"); saveNote(box, box.dataset.ck, box.dataset.name); }
  });
  // Paste a screenshot into a note.
  $("tfList").addEventListener("paste", (e) => {
    const ta = e.target.closest(".tf-nin");
    if (!ta) return;
    const fl = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (fl.length) { e.preventDefault(); addNoteFiles(ta.closest(".tf-client").dataset.ck, fl); }
  });
  // Drop: on the note box = attach to the note; anywhere else on a client = add files.
  $("tfList").addEventListener("dragover", (e) => { const b = e.target.closest(".tf-nadd") || e.target.closest(".tf-client"); if (b) { e.preventDefault(); b.classList.add("over"); } });
  $("tfList").addEventListener("dragleave", (e) => { const b = e.target.closest(".tf-nadd") || e.target.closest(".tf-client"); if (b && !b.contains(e.relatedTarget)) b.classList.remove("over"); });
  $("tfList").addEventListener("drop", (e) => {
    const b = e.target.closest(".tf-client");
    if (!b) return;
    e.preventDefault();
    document.querySelectorAll("#tfList .over").forEach((x) => x.classList.remove("over"));
    const fl = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (e.target.closest(".tf-nadd")) addNoteFiles(b.dataset.ck, fl);
    else addTo(b.dataset.ck, b.dataset.name, fl);
  });

  // ---- filters ----
  $("tfSearch").oninput = render;
  $("tfAll").onchange = async () => {
    if ($("tfAll").checked && !allClients.length) {
      $("tfSummary").textContent = "Loading every client in the workspace…";
      const r = await send({ type: "CLICKUP_CLIENT_NAMES" }, 60000);
      allClients = (r && Array.isArray(r.names) ? r.names : []).map((n) => (typeof n === "string" ? n : n && n.name) || "").filter(Boolean);
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
