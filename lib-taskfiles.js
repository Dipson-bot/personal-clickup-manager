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
      }
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
  window.PcmFiles = { key, all, forClient, add, remove, counts, auditHtml };
})();
