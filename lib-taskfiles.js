// Task files: each client's audit / reference files (Options > Task files),
// kept in IndexedDB "pcm-taskfiles" and shared by every extension page and the
// background (which backs them up to Drive). Files are read once when added -
// HTML, Markdown, text, CSV, Word, Excel, PowerPoint, PDF, screenshots - and
// their text is what "Explain this task" and the client report use.
// Loaded after task-panel.js (it reads files with PcmTaskPanel.readFile).
(() => {
  "use strict";
  const key = (c) => String(c || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const MAX_TEXT = 2000000, MAX_HTML = 4000000, MAX_IMAGE = 8 * 1048576;
  const MAX_ORIGINAL = 25 * 1048576; // the file itself is kept so it can be opened (not backed up)
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open("pcm-taskfiles", 1);
      r.onupgradeneeded = () => {
        const s = r.result.createObjectStore("files", { keyPath: "id" });
        s.createIndex("ck", "ck");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => { dbp = null; rej(r.error); };
    });
    return dbp;
  }
  const req = (q) => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  async function all() {
    const d = await db();
    return (await req(d.transaction("files").objectStore("files").getAll())) || [];
  }
  async function forClient(client) {
    const ck = key(client);
    if (!ck) return [];
    const d = await db();
    return ((await req(d.transaction("files").objectStore("files").index("ck").getAll(ck))) || []).sort((a, b) => a.addedAt - b.addedAt);
  }
  async function put(rec) {
    const d = await db();
    await new Promise((res, rej) => { const tx = d.transaction("files", "readwrite"); tx.objectStore("files").put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }
  const changed = () => { try { chrome.storage.local.set({ taskFilesChangedAt: Date.now() }); } catch (e) {} };
  // Read and save files for a client. onEach(rec) after each one.
  async function add(client, list, onEach) {
    const ck = key(client);
    if (!ck) throw new Error("Pick a client first.");
    if (!window.PcmTaskPanel || !window.PcmTaskPanel.readFile) throw new Error("File reader not loaded.");
    const out = [];
    for (const file of [...list].slice(0, 30)) {
      const r = await window.PcmTaskPanel.readFile(file);
      const rec = {
        id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random().toString(36).slice(2),
        ck, client: String(client), name: r.name || file.name || "file", type: file.type || "", size: file.size || 0, addedAt: Date.now(),
        kind: r.kind === "skip" ? "unreadable" : r.kind, why: r.why || "",
      };
      if (r.kind === "text") {
        rec.text = String(r.text || "").slice(0, MAX_TEXT);
        if (r.doc && /\.html?$/i.test(rec.name)) { try { const h = await file.text(); if (h.length <= MAX_HTML) rec.html = h; } catch (e) {} }
      }
      if (r.kind === "image") {
        if (file.size <= MAX_IMAGE) rec.blob = file; else { rec.kind = "unreadable"; rec.why = "image over 8 MB"; }
      } else if (file.size <= MAX_ORIGINAL) rec.blob = file; // keep the original to open it later
      await put(rec);
      out.push(rec);
      if (onEach) onEach(rec);
    }
    changed();
    return out;
  }
  async function remove(id) {
    const d = await db();
    await new Promise((res, rej) => { const tx = d.transaction("files", "readwrite"); tx.objectStore("files").delete(id); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    changed();
  }
  async function counts() {
    const m = new Map();
    for (const r of await all()) m.set(r.ck, (m.get(r.ck) || 0) + 1);
    return m;
  }
  // The newest HTML audit of a client (for the client report's audit parser).
  async function auditHtml(client) {
    const recs = (await forClient(client)).filter((r) => r.html);
    return recs.length ? recs[recs.length - 1] : null;
  }
  // Client notes (Options > Clients): { [client key]: [{ id, text, at, editedAt }] }
  // in local storage - small text, so it's backed up to Drive with the settings.
  async function allNotes() {
    try { const g = await chrome.storage.local.get("clientNotes"); return g.clientNotes && typeof g.clientNotes === "object" ? g.clientNotes : {}; } catch (e) { return {}; }
  }
  async function notesFor(client) { const all = await allNotes(); return Array.isArray(all[key(client)]) ? all[key(client)] : []; }
  async function saveNotes(client, list) {
    const all = await allNotes();
    const k = key(client);
    if (list && list.length) all[k] = list.slice(0, 200); else delete all[k];
    await chrome.storage.local.set({ clientNotes: all });
  }
  // ---- open a stored file / save a copy and show it in the folder ----
  const safeName = (s) => String(s || "file").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
  // The best thing we have for a file: the original, else its HTML, else its text.
  function fileBlob(rec) {
    if (rec.blob) return { blob: rec.blob, name: rec.name, original: true };
    if (rec.html) return { blob: new Blob([rec.html], { type: "text/html" }), name: rec.name, original: true };
    if (rec.text) return { blob: new Blob([rec.text], { type: "text/plain" }), name: rec.name.replace(/\.[a-z0-9]+$/i, "") + " (text).txt", original: false };
    return null;
  }
  const VIEWABLE = /^(image\/|application\/pdf|text\/)/;
  function openFile(rec) {
    const b = fileBlob(rec);
    if (!b) throw new Error("Nothing is kept for this file.");
    const url = URL.createObjectURL(b.blob);
    const a = document.createElement("a");
    a.href = url;
    if (VIEWABLE.test(b.blob.type || "") || /\.(pdf|png|jpe?g|gif|webp|svg|html?|txt|csv|md)$/i.test(b.name)) a.target = "_blank"; else a.download = safeName(b.name);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    return b.original;
  }
  // Saves a copy to Downloads > Personal ClickUp Manager > Clients > <client>
  // and opens File Explorer (Finder) with it selected.
  // The files live inside Chrome (IndexedDB), not in a folder, so the first time
  // a copy is saved; after that the same copy is just shown again (saved again
  // only if it was deleted or moved). Returns { original, reused }.
  async function showInFolder(rec) {
    const b = fileBlob(rec);
    if (!b) throw new Error("Nothing is kept for this file.");
    let shown = {};
    try { const g = await chrome.storage.local.get("tfShown"); shown = g.tfShown && typeof g.tfShown === "object" ? g.tfShown : {}; } catch (e) {}
    const prev = shown[rec.id];
    if (prev != null) {
      // search() makes Chrome re-check that the file is still there.
      const [item] = await chrome.downloads.search({ id: prev }).catch(() => []);
      if (item && item.exists && item.state === "complete") { chrome.downloads.show(prev); return { original: b.original, reused: true }; }
    }
    const url = URL.createObjectURL(b.blob);
    try {
      const id = await chrome.downloads.download({ url, filename: "Personal ClickUp Manager/Clients/" + safeName(rec.client) + "/" + safeName(b.name), conflictAction: "overwrite", saveAs: false });
      shown[rec.id] = id;
      try { await chrome.storage.local.set({ tfShown: shown }); } catch (e) {}
      await new Promise((res) => {
        const done = (d) => { if (d.id === id && d.state && d.state.current !== "in_progress") { chrome.downloads.onChanged.removeListener(done); res(); } };
        chrome.downloads.onChanged.addListener(done);
        setTimeout(() => { chrome.downloads.onChanged.removeListener(done); res(); }, 8000);
      });
      chrome.downloads.show(id);
      return { original: b.original, reused: false };
    } finally { setTimeout(() => URL.revokeObjectURL(url), 60000); }
  }

  // ---- files attached to notes (and reminders): IndexedDB "pcm-remfiles" ----
  function attDb() {
    return new Promise((ok, bad) => {
      const rq = indexedDB.open("pcm-remfiles", 1);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains("files")) rq.result.createObjectStore("files", { keyPath: "id" }); };
      rq.onsuccess = () => ok(rq.result); rq.onerror = () => bad(rq.error);
    });
  }
  async function attDo(mode, fn) { const d = await attDb(); return new Promise((ok, bad) => { const tx = d.transaction("files", mode); const r = fn(tx.objectStore("files")); tx.oncomplete = () => { d.close(); ok(r && r.result); }; tx.onerror = () => { d.close(); bad(tx.error); }; }); }
  const attPut = (recs) => attDo("readwrite", (s) => { for (const r of recs) s.put(r); });
  const attGet = (id) => attDo("readonly", (s) => s.get(id));
  // Remove attachment files nothing uses any more (notes and reminders share them).
  async function attCleanup(ids) {
    if (!ids || !ids.length) return;
    const used = new Set();
    const g = await chrome.storage.local.get(["reminders", "clientNotes"]).catch(() => ({}));
    for (const r of Array.isArray(g.reminders) ? g.reminders : []) for (const f of (r && r.files) || []) used.add(f.id);
    for (const list of Object.values((g.clientNotes && typeof g.clientNotes === "object") ? g.clientNotes : {})) for (const n of list || []) for (const f of (n && n.files) || []) used.add(f.id);
    const gone = ids.filter((id) => !used.has(id));
    if (gone.length) await attDo("readwrite", (s) => { for (const id of gone) s.delete(id); }).catch(() => {});
  }
  async function openAttachment(meta) {
    const rec = await attGet(meta.id).catch(() => null);
    if (!rec || !rec.blob) throw new Error("That file isn't on this computer (attachments aren't backed up to Drive).");
    return openFile({ blob: rec.blob, name: rec.name || meta.name });
  }

  window.PcmFiles = { key, all, forClient, add, remove, counts, auditHtml, allNotes, notesFor, saveNotes, openFile, showInFolder, attPut, attCleanup, openAttachment };
})();
