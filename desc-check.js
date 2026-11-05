// Insights > Descriptions: are the closing fields of my open tasks filled in?
// Every task description carries one of two formats (lib-descfmt.js):
//   Format 1: Client Description, Pre Description, Pre File, Description, File
//   Format 2: Pre Description, Pre File, Description, File
// The tasks are sorted into Not formatted / Missing client description /
// Missing description / Missing file / File not formatted. Opening a row (▸)
// prepares its fix: it reads that task's own description and comments (links
// for File, wording for the text), asks the AI (window.PcmAI, task-panel.js)
// for the empty fields only, and shows the whole description Now and After fix
// side by side. The fields can be edited by hand; Apply writes it to ClickUp,
// one task at a time or every ticked one (Prepare fixes, then Apply selected).
// Painted by options.js renderInsights into its own #insDescView (not the
// shared #insPlusView, which Plan / Performance repaint on their own timers).
(() => {
  "use strict";
  const F = globalThis.PcmDescFmt;
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const ask = (msg, ms) => new Promise((res) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res({ ok: false, error: "No answer from the extension (timed out)." }); } }, ms || 60000);
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (done) return;
        done = true; clearTimeout(t);
        res(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r || { ok: false, error: "No answer" });
      });
    } catch (e) { done = true; clearTimeout(t); res({ ok: false, error: String(e && e.message ? e.message : e) }); }
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 90) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    return Math.round(s / 3600) + "h ago";
  };
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : /(x|s|ch|sh)$/.test(w) ? "es" : "s");
  const CATS = [
    ["problems", "Needs fixing"],
    ["notFormatted", "Not formatted"],
    ["missingClientDescription", "Missing client description"],
    ["missingDescription", "Missing description"],
    ["missingFile", "Missing file"],
    ["fileNotFormatted", "File not formatted"],
    ["missingPreDescription", "Missing pre description"],
    ["missingPreFile", "Missing pre file"],
    ["good", "All good"],
  ];
  const TONE = { notFormatted: "bad", missingClientDescription: "warn", missingDescription: "warn", missingFile: "warn", fileNotFormatted: "warn", missingPreDescription: "warn", missingPreFile: "warn" };
  // Format 1 / 2 by name: the old format has Client Description, the new one doesn't.
  const FMT_NAME = { 1: "Old format", 2: "New format" };

  // Which checks count (Checks ▾, kept in settings.descChecks so it follows Drive
  // sync). Not formatted is always checked.
  const CHECKS = [
    ["clientDescription", "Client Description", "old-format tasks only", true],
    ["description", "Description", "", true],
    ["file", "File", "", true],
    ["fileStrict", "File must be links only, separated by commas", "", true],
    ["preDescription", "Pre Description", "", false],
    ["preFile", "Pre File", "", false],
    ["warm", "Prepare fixes in the background while Options is open", "Chrome's built-in AI only", true],
  ];
  let prefs = Object.fromEntries(CHECKS.map((c) => [c[0], c[3]]));
  let checksOpen = false;
  const on = (k) => prefs[k] !== false;
  const PREF_OF = { missingClientDescription: "clientDescription", missingDescription: "description", missingFile: "file", fileNotFormatted: "fileStrict", missingPreDescription: "preDescription", missingPreFile: "preFile" };
  // The problems that count with the checks switched on.
  const counted = (list) => (list || []).filter((p) => p === "notFormatted" || (on(PREF_OF[p]) && (p !== "fileNotFormatted" || on("file"))));
  const probs = (t) => counted(t.problems);
  let aiNotes = ""; // Checks ▾ › Your instructions for the AI (settings.descAiNotes)
  function readPrefs(st) {
    if (st && typeof st.descAiNotes === "string") aiNotes = st.descAiNotes;
    const d = st && st.descChecks;
    if (d && typeof d === "object") for (const c of CHECKS) if (typeof d[c[0]] === "boolean") prefs[c[0]] = d[c[0]];
  }
  try {
    chrome.storage.local.get("settings").then((g) => { readPrefs(g && g.settings); paint(); }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.settings && ch.settings.newValue) { const before = JSON.stringify(prefs); const notesBefore = aiNotes; readPrefs(ch.settings.newValue); if (JSON.stringify(prefs) !== before || (aiNotes !== notesBefore && !(document.activeElement && document.activeElement.id === "dcAiNotes"))) paint(); } });
  } catch (e) {}

  let rows = null, at = 0, loading = false, error = "";
  let cat = "problems", client = "", query = "", shown = 30;
  let host = null;
  const eds = new Map(); // taskId -> fix state (kept while the page is open)
  const picked = new Set(); // ticked rows
  const notes = new Map(); // taskId -> "Applied" / failure note
  let bulk = null; // { what: "prepare" | "apply", done, total, stop }
  let bulkMsg = "", noOnline = false, hydrated = false;
  let warming = false; // fixes being prepared in the background
  const scrolledTo = new Set(); // fixes whose Now / After boxes were opened at the first change
  // 💬 Comments: the extension's task panel (task-panel.js) opened on its Comments
  // tab under the task - the same comments, replies, files and reply box as
  // everywhere else. One at a time (the panel is one); it follows its slot when
  // the list is drawn again.
  let cmtOpen = "";
  function toggleComments(id) {
    const P = window.PcmTaskPanel;
    if (!P || !P.openIn) return;
    if (cmtOpen === id) { cmtOpen = ""; try { P.close(); } catch (e) {} paint(); return; }
    if (cmtOpen) { try { P.close(); } catch (e) {} }
    cmtOpen = id;
    paint();
    const slot = host && host.querySelector('.dc-cmtslot[data-id="' + CSS.escape(id) + '"]');
    if (!slot) { cmtOpen = ""; return; }
    try { P.wantTab("cmt"); } catch (e) {}
    if (!P.openIn(slot, id)) { cmtOpen = ""; paint(); return; }
    const panel = slot.nextElementSibling;
    if (panel) { panel.dataset.host = "#insDescView .dc-cmtslot"; try { panel.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {} }
    if (P.showTab) P.showTab("cmt");
  }
  // Open all: the tasks without a prepared fix are prepared one after another.
  const openQueue = [];
  let openRunning = false;
  async function runOpenQueue() {
    if (openRunning) return;
    openRunning = true;
    try {
      while (openQueue.length) {
        const id = openQueue.shift();
        const e = eds.get(id);
        if (!e || !e.open || e.before != null || e.busy) continue; // closed again, or already done
        await prepare(id);
        await sleep(400);
      }
    } finally { openRunning = false; }
  }
  let aiChain = Promise.resolve(), aiPending = 0; // one AI request at a time

  // ---------- prepared fixes, kept on this computer ----------
  // A fix (the description it was made from, the values, the ticked links) is
  // kept per task, so coming back shows it ready at once. It is used again only
  // while the task's description is exactly the same (descHash from the list).
  let fixCache = {}, fixTimer = 0;
  const fixP = chrome.storage.local.get("descFixes2").then((g) => { if (g && g.descFixes2 && typeof g.descFixes2 === "object") fixCache = g.descFixes2; try { chrome.storage.local.remove("descFixes"); } catch (e) {} }).catch(() => {});
  function writeFixes() {
    clearTimeout(fixTimer);
    fixTimer = setTimeout(() => {
      const keys = Object.keys(fixCache);
      if (keys.length > 300) keys.sort((a, b) => (fixCache[a].at || 0) - (fixCache[b].at || 0)).slice(0, keys.length - 300).forEach((k) => delete fixCache[k]);
      try { chrome.storage.local.set({ descFixes2: fixCache }); } catch (e) {}
    }, 600);
  }
  function saveFix(id, ed) {
    if (!ed || ed.before == null) return;
    fixCache[id] = { h: F.hash(ed.before), before: ed.before, vals: ed.vals, orig: ed.orig, links: ed.links, pick: ed.pick, addFormat: ed.addFormat, edited: !!ed.edited, movedNote: !!ed.movedNote, use: ed.use || null, manual: ed.manual == null ? null : ed.manual, at: Date.now() };
    writeFixes();
  }
  function dropFix(id) { if (fixCache[id]) { delete fixCache[id]; writeFixes(); } }
  // Put the kept fixes back on the rows whose description hasn't changed.
  function restoreFixes() {
    if (!rows) return;
    let dropped = false;
    for (const t of rows) {
      const c = fixCache[t.id];
      if (!c || eds.has(t.id)) continue;
      if (!t.descHash || c.h !== t.descHash) { delete fixCache[t.id]; dropped = true; continue; }
      eds.set(t.id, { addFormat: c.addFormat || 2, open: false, editing: false, vals: Object.assign({}, c.vals), orig: Object.assign({}, c.orig), links: c.links || [], pick: c.pick || [], before: c.before, edited: !!c.edited, movedNote: !!c.movedNote, use: c.use || null, manual: c.manual == null ? null : c.manual, ctx: null, msg: "Prepared earlier. Check the After fix, change it there if needed, then Apply.", tone: "" });
    }
    const ids = new Set(rows.map((t) => t.id));
    for (const k of Object.keys(fixCache)) if (!ids.has(k)) { delete fixCache[k]; dropped = true; }
    if (dropped) writeFixes();
  }
  // The list from the last visit (a few ms), so nothing waits on ClickUp.
  let hydrateP = null;
  function hydrate() {
    if (!hydrateP) hydrateP = Promise.all([chrome.storage.local.get("descCheckLast").catch(() => null), fixP]).then(([g]) => {
      const k = g && g.descCheckLast;
      if (!rows && k && Array.isArray(k.rows)) { rows = k.rows; at = Number(k.at) || 0; }
      restoreFixes();
    });
    return hydrateP;
  }
  // Chrome's built-in AI is ready on this computer (not just downloadable: the
  // background work must never start a model download on its own).
  async function builtinReady() {
    try {
      if (typeof LanguageModel === "undefined") return false;
      return (await LanguageModel.availability({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] })) === "available";
    } catch (e) { return false; }
  }
  // Prepare the fixes of the tasks that need one, one at a time, while the page
  // is open - so the Descriptions tab has them ready whenever it is opened.
  async function warm() {
    if (warming || !on("warm") || !rows) return;
    warming = true;
    paint();
    try {
      for (const t of rows.slice()) {
        if (!on("warm")) break;
        if (!probs(t).length) continue;
        const ed = eds.get(t.id);
        if (ed && (ed.before != null || ed.busy)) continue;
        while (bulk) await sleep(2000); // a Prepare fixes / Apply selected run goes first
        await prepare(t.id, false, true, true);
        await sleep(1500); // gentle on ClickUp (2 calls a task)
      }
    } finally { warming = false; paint(); }
  }

  const css = document.createElement("style");
  css.textContent = `
  #insDescView { font-size: 13px; }
  #insDescView h2 { margin: 0; font-size: 18px; }
  #insDescView .ip-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 4px; }
  #insDescView .ip-head .sp { flex: 1; }
  #insDescView .ip-sub { color: var(--muted); margin: 0 0 16px; line-height: 1.5; max-width: 760px; }
  #insDescView .ip-btn { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); cursor: pointer; }
  #insDescView .ip-btn:hover { border-color: var(--indigo); color: var(--indigo); }
  #insDescView .ip-card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px; margin: 0 0 14px; }
  #insDescView .ip-card h3 { margin: 0 0 4px; font-size: 14px; }
  #insDescView .ip-card .hint { color: var(--muted); font-size: 12px; line-height: 1.5; margin: 0 0 12px; }
  #insDescView .ip-meta { color: var(--muted); font-size: 11.5px; }
  /* Own tone names (c-*): the settings page has a global .warn (border, padding, 18px margin) that pushed "Missing ..." chips out of line. */
  #insDescView .chip { display: inline-flex; align-items: center; box-sizing: border-box; height: 22px; margin: 0; font-size: 11px; line-height: 1; font-weight: 600; padding: 0 9px; border: 1px solid transparent; border-radius: 999px; white-space: nowrap; vertical-align: middle; }
  #insDescView .chip.c-good { background: rgba(22,163,74,.14); color: var(--green); }
  #insDescView .chip.c-warn { background: rgba(217,119,6,.15); color: var(--amber); }
  #insDescView .chip.c-bad { background: rgba(220,38,38,.13); color: var(--red); }
  #insDescView .chip.c-mut { background: var(--bg2, rgba(0,0,0,.06)); color: var(--muted); font-weight: 500; }
  #insDescView .chip.c-blue { background: rgba(37,99,235,.13); color: #2563eb; }
  #insDescView .chip.c-purple { background: rgba(124,58,237,.13); color: #7c3aed; }
  #insDescView a { color: var(--indigo); text-decoration: none; }
  #insDescView a:hover { text-decoration: underline; }
  #insDescView .dc-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
  #insDescView .dc-chips button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--text); cursor: pointer; }
  #insDescView .dc-chips button.on { background: var(--indigo); border-color: var(--indigo); color: #fff; }
  #insDescView .dc-chips button b { font-weight: 700; margin-left: 4px; }
  #insDescView .dc-tools { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 10px; align-items: center; }
  #insDescView .dc-tools input[type="search"], #insDescView .dc-tools select { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); }
  #insDescView .dc-tools input[type="search"] { min-width: 220px; width: auto; }
  #insDescView .dc-tools select { width: auto; max-width: 260px; }
  #insDescView .dc-tools .cu-filter { position: relative; }
  #insDescView .dc-menu { left: 0; right: auto; min-width: 240px; max-width: 320px; }
  #insDescView .dc-menu label { display: flex; gap: 7px; align-items: center; margin: 0; padding: 3px 4px; font-size: 12.5px; font-weight: 400; cursor: pointer; }
  #insDescView .cu-filter-btn.on { border-color: var(--indigo); color: var(--indigo); }
  #insDescView .dc-cap { text-transform: capitalize; }
  #insDescView .dc-link { font: inherit; font-size: 12px; border: 0; background: none; color: var(--indigo); cursor: pointer; padding: 2px 4px; }
  #insDescView .dc-link:hover { text-decoration: underline; }
  #insDescView .dc-st-acts { display: flex; gap: 8px; margin-top: 4px; border-top: 1px solid var(--border); padding-top: 6px; }
  #insDescView .dc-ainotes { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); resize: vertical; }
  #insDescView .dc-ask { font: inherit; font-size: 12px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); min-width: 220px; flex: 1 1 220px; max-width: 360px; }
  /* .dc-ed .dc-use: more specific than the editor's ".dc-ed label" (block, 8px margin), which pushed the ticks down. */
  #insDescView .dc-ed .dc-use { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin: 0 0 10px; font-size: 12.5px; line-height: 1.4; }
  #insDescView .dc-ed .dc-use > .dc-msg { font-size: 12.5px; }
  #insDescView .dc-ed .dc-use label { display: inline-flex; gap: 6px; align-items: center; margin: 0; font-size: 12.5px; font-weight: 600; line-height: 1.4; cursor: pointer; }
  #insDescView .dc-ed .dc-use input { margin: 0; vertical-align: middle; }
  #insDescView .dc-col h4 { display: flex; align-items: center; gap: 8px; min-height: 28px; }
  #insDescView .dc-h4btns { margin-left: auto; display: inline-flex; gap: 6px; text-transform: none; letter-spacing: 0; }
  /* The After box tools: real buttons, not text that blends into the heading. */
  #insDescView .dc-hbtn { font: inherit; font-size: 12px; font-weight: 600; text-transform: none; letter-spacing: 0; padding: 4px 11px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; line-height: 1.3; }
  #insDescView .dc-hbtn:hover { border-color: var(--indigo); color: var(--indigo); }
  #insDescView .dc-hbtn.main { background: var(--indigo); border-color: var(--indigo); color: #fff; }
  #insDescView .dc-hbtn.main:hover { color: #fff; opacity: .9; }
  #insDescView .dc-afterview { cursor: text; }
  #insDescView .dc-afterview:hover .dc-doc { border-color: var(--indigo); }
  #insDescView .dc-after-ed { font-size: 12.5px; }
  #insDescView .dc-after-ed .md-area { min-height: 180px; max-height: 420px; overflow: auto; background: var(--card); }
  #insDescView .dc-plain { width: 100%; box-sizing: border-box; min-height: 200px; font: inherit; font-size: 12.5px; padding: 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--card); color: var(--text); }
  #insDescView .dc-cmtslot { height: 0; }
  #insDescView .ip-btn.on { border-color: var(--indigo); color: var(--indigo); }
  #insDescView .dc-cmtslot + * { margin: 6px 0 4px 28px; }
  #insDescView .dc-row > .dc-line { cursor: pointer; border-radius: 8px; }
  #insDescView .dc-row > .dc-line:hover { background: var(--bg2, rgba(0,0,0,.035)); }
  #insDescView .dc-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 10px; font-size: 12.5px; }
  #insDescView .dc-meta .dc-msg { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  #insDescView .dc-late { color: var(--red); font-weight: 600; }
  #insDescView .dc-checks { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; margin: 6px 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); max-width: 520px; }
  #insDescView .dc-checks label { display: flex; gap: 7px; align-items: center; margin: 0; font-size: 12.5px; }
  #insDescView .dc-bulk { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 10px; margin: 0 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 12px; }
  #insDescView .dc-bulk label { display: inline-flex; gap: 6px; align-items: center; margin: 0; font-weight: 600; }
  #insDescView .dc-row { border-top: 1px solid var(--border); padding: 9px 0; }
  #insDescView .dc-row:first-child { border-top: 0; }
  #insDescView .dc-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  #insDescView .dc-tw { font: inherit; font-size: 16px; line-height: 1; width: 30px; height: 30px; flex: 0 0 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 7px; background: none; color: var(--muted); cursor: pointer; padding: 0; }
  #insDescView .dc-tw:hover { color: var(--indigo); background: var(--bg2, rgba(0,0,0,.06)); border-color: var(--border); }
  #insDescView .dc-name { font-weight: 600; flex: 1 1 260px; min-width: 0; }
  #insDescView .dc-title { font: inherit; font-weight: 600; color: var(--indigo); background: none; border: 0; padding: 2px 0; margin: 0; text-align: left; cursor: pointer; }
  #insDescView .dc-title:hover { text-decoration: underline; }
  #insDescView .dc-cu { text-decoration: none; }
  #insDescView .dc-cu:hover { text-decoration: none; }
  #insDescView .dc-client { font-size: 11px; color: var(--muted); font-weight: 400; }
  #insDescView .dc-ed { margin: 8px 0 4px 28px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2, rgba(0,0,0,.03)); }
  #insDescView .dc-cmp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  @media (max-width: 760px) { #insDescView .dc-cmp { grid-template-columns: 1fr; } }
  #insDescView .dc-col h4 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  #insDescView .dc-doc { position: relative; font-size: 12px; line-height: 1.5; border: 1px solid var(--border); border-radius: 8px; background: var(--card); padding: 6px 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  #insDescView .dc-doc div { padding: 0 10px; min-height: 1.5em; }
  #insDescView .dc-doc .add { background: rgba(22,163,74,.14); }
  #insDescView .dc-doc .del { background: rgba(220,38,38,.12); text-decoration: line-through; text-decoration-color: rgba(220,38,38,.5); }
  #insDescView .dc-doc .gap { color: var(--muted); font-style: italic; }
  #insDescView .dc-ed label { display: block; font-size: 12px; font-weight: 600; margin: 8px 0 4px; }
  #insDescView .dc-ed label .hint { font-weight: 400; color: var(--muted); }
  #insDescView .dc-ed textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 7px; background: var(--card); color: var(--text); resize: vertical; min-height: 54px; }
  #insDescView .dc-ed textarea.miss { border-color: var(--amber); }
  #insDescView .dc-links { display: flex; flex-direction: column; gap: 3px; margin: 8px 0 2px; font-size: 12px; max-height: 160px; overflow: auto; }
  #insDescView .dc-links b { font-size: 12px; }
  #insDescView .dc-links label { font-weight: 400; margin: 0; display: flex; gap: 6px; align-items: flex-start; word-break: break-all; }
  #insDescView .dc-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
  #insDescView .dc-btn-primary { background: var(--indigo); color: #fff; border-color: var(--indigo); }
  #insDescView .dc-btn-primary:hover { color: #fff; opacity: .9; }
  #insDescView .ip-btn[disabled] { opacity: .5; cursor: default; }
  #insDescView .dc-msg { font-size: 12px; color: var(--muted); }
  #insDescView .dc-msg.err { color: var(--red); }
  #insDescView .dc-msg.good { color: var(--green); }
  #insDescView .dc-fmt { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; margin: 0 0 10px; }
  #insDescView .dc-fmt label { font-weight: 400; display: inline-flex; gap: 5px; align-items: center; margin: 0; }
  `;
  document.head.appendChild(css);

  // A task with no fields gets the new format unless the old one was picked last.
  const lastFormat = () => { try { return localStorage.getItem("pcm.descFormat") === "1" ? 1 : 2; } catch (e) { return 2; } };
  const rememberFormat = (n) => { try { localStorage.setItem("pcm.descFormat", String(n)); } catch (e) {} };

  async function load(force) {
    if (loading) return;
    loading = true; error = "";
    paint();
    const r = await ask({ type: "DESC_CHECK_LIST", force: !!force }, 120000);
    loading = false;
    if (r && r.ok) {
      rows = r.data || []; at = r.at || Date.now();
      // Kept on this computer, so opening the tab again draws at once (then refreshes).
      try { chrome.storage.local.set({ descCheckLast: { at, rows: rows.map((t) => Object.assign({}, t, { briefText: "" })) } }); } catch (e) {}
      // A prepared fix stays only while the task still reads the same.
      const ids = new Set(rows.map((t) => t.id));
      for (const id of [...eds.keys()]) if (!ids.has(id)) eds.delete(id);
      for (const id of [...picked]) if (!ids.has(id)) picked.delete(id);
      // A fix made from an older description is dropped (the task changed).
      for (const t of rows) { const ed = eds.get(t.id); if (ed && !ed.busy && ed.before != null && t.descHash && F.hash(ed.before) !== t.descHash) eds.delete(t.id); }
      await fixP;
      restoreFixes();
      setTimeout(warm, 1000);
    } else error = r && r.reason === "not-configured" ? "Connect ClickUp first (ClickUp setup)." : (r && r.error) || "Couldn't read your tasks.";
    paint();
  }

  const inCat = (t, c) => c === "problems" ? probs(t).length > 0 : c === "good" ? !probs(t).length : probs(t).includes(c);
  // A category chip shows only while its check is on.
  const catOn = (k) => k === "problems" || k === "good" || k === "notFormatted" || (on(PREF_OF[k]) && (k !== "fileNotFormatted" || on("file")));
  // ---------- ▾ Clients and ▾ Filter (like the Dashboard's Tasks card) ----------
  // fClients: [] = every client, else the ticked ones.
  // fDue: ticked due ranges (none ticked = any due date); "custom" = fFrom..fTo (day starts).
  // fStatus: null = every status, finished ones (last 30 days) included; else the ticked ones.
  let fClients = [], fDue = [], fFrom = 0, fTo = 0, fStatus = null, menu = "", cliQ = "";
  try {
    const f = JSON.parse(localStorage.getItem("pcm.descFilter2") || "null");
    if (f && typeof f === "object") {
      fClients = Array.isArray(f.clients) ? f.clients : [];
      fDue = Array.isArray(f.due) ? f.due : [];
      fFrom = Number(f.from) || 0; fTo = Number(f.to) || 0;
      fStatus = Array.isArray(f.status) ? f.status : null;
    }
  } catch (e) {}
  const saveFilter = () => { try { localStorage.setItem("pcm.descFilter2", JSON.stringify({ clients: fClients, due: fDue, from: fFrom, to: fTo, status: fStatus })); } catch (e) {} };
  const day0 = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const addD = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
  // Weeks start where "A week runs" (ClickUp setup) says: Sunday unless a Monday mode.
  let weekStart = 0;
  try { chrome.storage.local.get("settings").then((g) => { const m = g && g.settings && g.settings.clickupWeekMode; weekStart = /^mon/.test(String(m || "")) ? 1 : 0; }).catch(() => {}); } catch (e) {}
  const wk0 = (ms) => addD(day0(ms), -((new Date(ms).getDay() - weekStart + 7) % 7));
  const mo0 = (ms, n) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth() + (n || 0), 1).getTime(); };
  const shortD = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const DUE_OPTS = [
    ["overdue", "Overdue", "Due before today and not finished"],
    ["prevWeek", "Previous week", "Due any day last week"],
    ["week", "This week", "Due any day this week"],
    ["nextWeek", "Next week", "Due any day next week"],
    ["prevMonth", "Previous month", "Due any day last month"],
    ["month", "This month", "Due any day this month"],
    ["nextMonth", "Next month", "Due any day next month"],
    ["none", "No due date", "Tasks without a due date"],
    ["custom", "Custom date / range", "Pick days in the calendar"],
  ];
  function dueIn(k, t) {
    const due = Number(t.dueDateMs) || 0;
    if (k === "none") return !due;
    if (!due) return false;
    const now = Date.now();
    const range = (a, z) => due >= a && due < z;
    if (k === "overdue") return due < day0(now) && !t.done;
    if (k === "prevWeek") return range(addD(wk0(now), -7), wk0(now));
    if (k === "week") return range(wk0(now), addD(wk0(now), 7));
    if (k === "nextWeek") return range(addD(wk0(now), 7), addD(wk0(now), 14));
    if (k === "prevMonth") return range(mo0(now, -1), mo0(now));
    if (k === "month") return range(mo0(now), mo0(now, 1));
    if (k === "nextMonth") return range(mo0(now, 1), mo0(now, 2));
    if (k === "custom") return !fFrom || range(fFrom, addD(fTo || fFrom, 1));
    return false;
  }
  const dueOk = (t) => !fDue.length || fDue.some((k) => dueIn(k, t));
  const stKey = (t) => String(t.status || "").toLowerCase();
  const statusOk = (t) => fStatus ? fStatus.includes(stKey(t)) : true;
  const clientOk = (t) => !fClients.length || fClients.includes(t.client || "");
  // Every filter but the category chips.
  const filtered = () => (rows || []).filter((t) => dueOk(t) && statusOk(t) && clientOk(t));
  function visible() {
    const q = query.trim().toLowerCase();
    return filtered().filter((t) => inCat(t, cat) && (!q || (t.name + " " + (t.client || "")).toLowerCase().includes(q)));
  }
  // Every status in the list, open ones first, each with its count.
  function statusList() {
    const m = new Map();
    for (const t of rows || []) { const k = stKey(t); if (!k) continue; const e = m.get(k) || { k, n: 0, done: !!t.done }; e.n++; m.set(k, e); }
    return [...m.values()].sort((a, b) => (a.done - b.done) || a.k.localeCompare(b.k));
  }
  // A click outside an open menu closes it.
  document.addEventListener("click", (e) => {
    // A tick inside the menu redraws it first, so its old element is gone by now: not an outside click.
    if (!e.target || !e.target.isConnected) return;
    if (menu && host && !(e.target.closest && e.target.closest("#insDescView .cu-filter"))) { menu = ""; paint(); }
  });
  const byId = (id) => (rows || []).find((t) => t.id === id);

  // ---------- the fix of one task ----------
  const KEY = { "Client Description": "clientDescription", "Pre Description": "preDescription", "Pre File": "preFile", "Description": "description", "File": "file" };
  const HINT = {
    "Pre Description": "what the task is meant to do (the plan)",
    "Pre File": "the file or links the work starts from",
    "Client Description": "what the client asked for, kept as the reference for doing the task",
    "Description": "the closing statement: what was done, where, and how it was checked",
    "File": "links only, separated by commas",
  };
  const fmtOf = (t, ed) => t.format || ed.addFormat;
  // The fields the editor offers: the ones switched on in Checks ▾ (Client
  // Description only in the old format).
  const fieldsFor = (t, ed) => [
    fmtOf(t, ed) === 1 && on("clientDescription") ? "Client Description" : "",
    on("preDescription") ? "Pre Description" : "",
    on("preFile") ? "Pre File" : "",
    on("description") ? "Description" : "",
    on("file") ? "File" : "",
  ].filter(Boolean);
  // The File value as ClickUp should get it: "a.com,b.com". Links written any
  // other way are pulled out; text with no link at all is left as it is.
  function fileOf(v) {
    v = String(v || "").trim();
    if (!v) return "";
    if (F.fileState(v) === "ok") return F.fileValue(v.split(/["“”']?\s*,\s*["“”']?/));
    const l = F.linksIn(v);
    return l.length ? F.fileValue(l) : v;
  }
  // The words of a File value without its links: markdown links, plain and bare
  // addresses and the labels left empty by them (Before:, After:) go. Kept only
  // when it reads like a sentence (4+ words).
  function noteOf(raw) {
    let t = String(raw || "").replace(/\[[^\]]*\]\([^)]*\)/g, " ");
    for (const u of F.linksIn(t)) t = t.split(u).join(" ");
    t = t.split("\n").map((x) => x.replace(/^\s*[-*•]?\s*(before|after|proof|screenshots?|links?|files?)\s*:\s*[,;]*\s*$/i, "").trim()).filter(Boolean).join(" ");
    t = t.replace(/\(\s*\)|\[\s*\]/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/[,;:\s]+$/, "").replace(/\s{2,}/g, " ").trim();
    return (t.match(/[A-Za-z]{2,}/g) || []).length >= 4 ? t : "";
  }
  // What would be written: only fields that change (all of them for a task with no format).
  function changesOf(t, ed, all) {
    const set = {};
    for (const label of fieldsFor(t, ed)) {
      if (!all && ed.use && ed.use[label] === false) continue; // unticked: this part stays as it is
      const k = KEY[label];
      let v = String(ed.vals[k] || "").replace(/["“”]/g, "'").replace(/\s+\n/g, "\n").trim();
      if (label === "File") v = fileOf(v);
      if (t.format && v === String(ed.orig[k] || "").trim()) continue;
      set[label] = v;
    }
    return set;
  }
  function afterOf(t, ed) {
    const set = changesOf(t, ed);
    if (!Object.keys(set).length && t.format) return ed.before;
    return F.apply(ed.before, set, t.format ? undefined : ed.addFormat);
  }
  // What Apply writes: the After text typed by hand, else the ticked parts put in.
  const finalOf = (t, ed) => (ed.manual != null ? ed.manual : afterOf(t, ed));
  const isReady = (t, ed) => !!(ed && ed.before != null && !ed.busy && finalOf(t, ed).trim() !== ed.before.trim());
  // Rebuilding After from the ticks / links / a new suggestion throws away what
  // was typed in it: asked first.
  function dropManual(ed) {
    if (ed.manual == null) return true;
    if (!confirm("Rebuild the After fix text from the ticked parts? What you typed in it will be lost.")) return false;
    ed.manual = null; ed.edEl = null; ed.editingAfter = false;
    return true;
  }

  // Line diff (longest common subsequence) for the Now / After columns.
  function diffLines(a, b) {
    const A = a.split("\n"), B = b.split("\n");
    const n = A.length, m = B.length;
    if (n * m > 250000) return { left: A.map((x) => ({ x, k: "" })), right: B.map((x) => ({ x, k: "" })) };
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const left = [], right = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { left.push({ x: A[i], k: "" }); right.push({ x: B[j], k: "" }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) left.push({ x: A[i++], k: "del" });
      else right.push({ x: B[j++], k: "add" });
    }
    while (i < n) left.push({ x: A[i++], k: "del" });
    while (j < m) right.push({ x: B[j++], k: "add" });
    return { left, right };
  }
  const docHtml = (lines, empty) => '<div class="dc-doc">' + (lines.length && lines.some((l) => l.x.trim())
    ? lines.map((l) => '<div class="' + l.k + '">' + (esc(l.x) || "&nbsp;") + "</div>").join("")
    : '<div class="gap">' + esc(empty) + "</div>") + "</div>";

  const AI_SYSTEM = "You fill in the closing fields of a ClickUp task for an SEO and website agency. Use only the facts in the task details and in the task's own comments. Never invent results, numbers, links, names or dates. " +
    "Write confident, plain English in the past tense: say what was done, not what it may do. Name the site by its domain or the business by its name instead of vague words such as 'the website' or 'the site'. Avoid hedging words (may, might, could, helps to, aims to). " +
    "These texts can be sent to the business itself in reports, so NEVER use the words client, clients, customer, customers or any word for them (account, the business owner, the company we work for); write about the work, the pages and the site or business by name. " +
    "No em dashes, no emojis, no markdown, no quotation marks around the text. If the user gives instructions, follow them as long as they don't ask you to invent facts.";
  // Words that must not reach a text the business itself may read.
  const BANNED_RE = /\b(client|clients|client's|clients'|customer|customers|customer's)\b/i;
  const AI_SCHEMA = { type: "object", properties: { clientDescription: { type: "string" }, description: { type: "string" }, preDescription: { type: "string" } }, required: ["clientDescription", "description", "preDescription"] };
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  // The client's site(s): the domains in the task's description and comments
  // (not ClickUp, Google Docs/Drive, screenshot or Slack links).
  function sitesOf(t, ctx) {
    const text = String(ctx.description || t.briefText || "") + "\n" + (ctx.comments || []).map((c) => c.text || "").join("\n");
    const seen = [];
    for (const u of F.linksIn(text)) {
      const host = String(u).replace(/^https?:\/\//i, "").split(/[/?#]/)[0].replace(/^www\./i, "").toLowerCase();
      if (!host || /(^|\.)(clickup\.com|google\.com|googleusercontent\.com|imgur\.com|snag\.gy|slack\.com|loom\.com|dropbox\.com|github\.com|figma\.com|canva\.com|youtube\.com|youtu\.be)$/.test(host)) continue;
      if (!seen.includes(host)) seen.push(host);
    }
    return seen.slice(0, 3);
  }
  const clientName = (t) => String(t.client || "").replace(/[^\p{L}\p{N}&' .-]/gu, "").replace(/\s+(SEO|Web|Website)\s*$/i, "").trim();
  function aiPrompt(t, ctx, extra) {
    const comments = (ctx.comments || []).slice(0, 12).map((c) => "- " + c.who + ", " + fmtDate(c.at) + ": " + String(c.text || "").replace(/\s+/g, " ").slice(0, 700)).join("\n");
    const brief = String(ctx.description || t.briefText || "").replace(/\s+/g, " ").slice(0, 1800);
    const sites = sitesOf(t, ctx);
    return "Task title: " + t.name + "\n" +
      (clientName(t) ? "Business: " + clientName(t) + "\n" : "") +
      (sites.length ? "Site: " + sites.join(", ") + "\n" : "") +
      (t.status ? "Status: " + t.status + "\n" : "") +
      (brief ? "Task description: " + brief + "\n" : "") +
      ((ctx.fields || []).length ? "Other fields: " + ctx.fields.join("; ") + "\n" : "") +
      "\nThis task's own comments (newest first):\n" + (comments || "(none)") + "\n\n" +
      "Write three things:\n" +
      "clientDescription: the request this task came from, as the reference for doing it - the business's own request restated as an instruction (e.g. 'Make the phone number clickable on every city page.'). Take it only from where the details show their own request (a forwarded message, an email, 'client said', 'client asked', 'as per client'). It is NOT a summary of the work, and must not contain the word client or customer. If the details don't contain their request, return an empty string.\n" +
      "description: the closing statement in 1 to 3 sentences: what was done, on which pages or URLs of the site (by domain), and how it was checked. Confident and specific.\n" +
      "preDescription: 1 or 2 sentences on what the task is meant to do (the plan), from its title and description.\n" +
      "If the details don't say something, leave it out rather than guessing.\n" +
      (aiNotes.trim() ? "\nThe user's standing instructions (follow them):\n" + aiNotes.trim().slice(0, 1500) + "\n" : "") +
      (extra && extra.trim() ? "\nFor this task the user asks: " + extra.trim().slice(0, 500) + "\n" : "") +
      'Return JSON: {"clientDescription": "...", "description": "...", "preDescription": "..."}';
  }
  function readJson(s) {
    s = String(s || "");
    try { return JSON.parse(s); } catch (e) {}
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return null;
  }
  const clean = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").replace(/^["“”\s]+|["“”\s]+$/g, "").replace(/\s{2,}/g, " ").trim();

  // Read the task (description + its own comments), fill in what's missing:
  // File from the comments' links, the text fields from the AI. `again` asks
  // the AI again even for fields that already have a suggestion.
  // The After fix editor: the notes editor (window.PcmMd, md-notes.js) - pasting
  // from an AI keeps its formatting, tables, lists, links; pasted or dropped
  // files are attached to the task and their links put in.
  function makeEditor(id, ed, t) {
    const start = finalOf(t, ed);
    const onInput = (md) => { ed.manual = md; ed.edited = true; clearTimeout(ed._st); ed._st = setTimeout(() => saveFix(id, ed), 500); };
    let box;
    if (window.PcmMd && window.PcmMd.editor) box = window.PcmMd.editor(start, { maxLength: 60000, onInput, placeholder: "The description as it will be in ClickUp" });
    else {
      box = document.createElement("textarea");
      box.value = start; box.className = "dc-plain";
      box.oninput = () => onInput(box.value);
      box.getMarkdown = () => box.value; box.insertText = (x) => { box.setRangeText(x, box.selectionStart, box.selectionEnd, "end"); onInput(box.value); };
      box.focusEnd = () => box.focus(); box.contentEl = () => box;
    }
    box.classList.add("dc-after-ed");
    const area = box.contentEl ? box.contentEl() : box;
    const filesOf = (dt) => (dt && dt.files ? [...dt.files] : []);
    area.addEventListener("paste", (e) => { const f = filesOf(e.clipboardData); if (f.length) { e.preventDefault(); e.stopImmediatePropagation(); attachFiles(id, f); } }, true);
    area.addEventListener("dragover", (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    area.addEventListener("drop", (e) => { const f = filesOf(e.dataTransfer); if (f.length) { e.preventDefault(); attachFiles(id, f); } });
    return box;
  }
  const readB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(f); });
  async function attachFiles(id, files) {
    const ed = eds.get(id);
    const say = (m, tone) => { const el = host && host.querySelector('[data-upmsg="' + CSS.escape(id) + '"]'); if (el) { el.textContent = m; el.className = "dc-msg" + (tone ? " " + tone : ""); } };
    const list = [...files].slice(0, 10).filter((f) => f.size <= 10 * 1024 * 1024);
    if (!list.length) { say("Files over 10 MB: attach them in ClickUp.", "err"); return; }
    say("Uploading " + plural(list.length, "file") + " to the task…");
    const payload = [];
    for (const f of list) {
      const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
      payload.push({ name, type: f.type || "application/octet-stream", b64: await readB64(f) });
    }
    const r = await ask({ type: "CLICKUP_TASK_ATTACH", taskId: id, files: payload, noComment: true }, 120000);
    if (!r || !r.ok) { say("Upload failed: " + ((r && r.error) || "no answer"), "err"); return; }
    const links = (r.files || []).filter((f) => f.url).map((f) => "[" + String(f.name || "file").replace(/[\[\]]/g, "") + "](" + f.url + ")");
    if (ed && ed.edEl && ed.edEl.insertText && links.length) ed.edEl.insertText(" " + links.join(" ") + " ");
    say("Attached to the task ✓ - the link" + (links.length === 1 ? " is" : "s are") + " in the text. Apply to save it.", "good");
  }
  async function prepare(id, again, quiet, bg, extra) {
    const t = byId(id);
    if (!t) return false;
    if (again) { scrolledTo.delete(id); const e0 = eds.get(id); if (e0 && !e0.busy && !dropManual(e0)) return false; }
    let ed = eds.get(id);
    if (!ed) { ed = { addFormat: lastFormat(), open: false, editing: false, vals: {}, orig: {}, links: [], pick: [], before: null, msg: "", tone: "" }; eds.set(id, ed); }
    if (ed.busy) return false;
    ed.busy = true; ed.msg = "Reading this task and its comments…"; ed.tone = "";
    if (!quiet) paint();
    if (ed.before == null || again) {
      const ctx = await ask({ type: "DESC_CHECK_CONTEXT", taskId: id }, 60000);
      if (!ctx || !ctx.ok) { ed.busy = false; ed.msg = "Couldn't read the task: " + ((ctx && ctx.error) || "no answer"); ed.tone = "err"; paint(); return false; }
      ed.ctx = ctx;
      ed.before = String(ctx.description || "").replace(/\r\n?/g, "\n");
      const v = F.check(ed.before, { pre: true });
      // The row follows the description just read (it may have changed since the list was read).
      t.format = v.format; t.problems = v.problems;
      ed.orig = { clientDescription: v.values.clientDescription || "", preDescription: v.values.preDescription || "", preFile: v.values.preFile || "", description: v.values.description || "", file: v.values.file || "" };
      if (!again || !ed.edited) {
        ed.vals = Object.assign({}, ed.orig);
        // A File with links written the wrong way is tidied to links only.
        if (ed.vals.file && F.fileState(ed.vals.file) === "bad") {
          const raw = ed.vals.file;
          const l = F.linksIn(raw);
          if (l.length) ed.vals.file = F.fileValue(l);
          // A closing note written into File ("Fixed the ... Screenshot attached.
          // Before: <link>") is somebody's own words: it moves to an empty
          // Description instead of being dropped and rewritten by the AI.
          const note = noteOf(raw);
          if (note && on("description") && !String(ed.vals.description || "").trim()) { ed.vals.description = note; ed.movedNote = true; }
        }
      }
      // Links from the task's own comments, for File (ticked = in the value).
      const links = [];
      for (const c of ctx.comments || []) for (const u of c.links || []) if (!links.includes(u) && !/app\.clickup\.com\/t\//i.test(u)) links.push(u);
      ed.links = links;
      if (!String(ed.vals.file || "").trim() && links.length) { ed.pick = links.slice(); ed.vals.file = F.fileValue(links); }
      else ed.pick = links.filter((u) => F.linksIn(ed.vals.file || "").includes(u));
    }
    // With a note ("make it shorter") the AI rewrites its own text even after an edit; a field
    // that was already filled in ClickUp (orig) is never touched, nor a note moved from File.
    const redo = again && (!ed.edited || !!(extra && extra.trim()));
    const needPre = on("preDescription") && (redo || !String(ed.vals.preDescription || "").trim()) && !String(ed.orig.preDescription || "").trim();
    const needClient = on("clientDescription") && fmtOf(t, ed) === 1 && (redo || !String(ed.vals.clientDescription || "").trim()) && !String(ed.orig.clientDescription || "").trim();
    const needDesc = on("description") && (redo || !String(ed.vals.description || "").trim()) && !String(ed.orig.description || "").trim() && !(ed.movedNote && !(extra && extra.trim()));
    let note = "";
    // In the background only Chrome's built-in AI is used (nothing is sent anywhere unasked).
    const useAi = (needClient || needDesc || needPre) && window.PcmAI && (!bg || await builtinReady());
    if (useAi && !ed.ctx) {
      // A fix kept from an earlier visit has no comments with it: read them for the AI.
      const ctx = await ask({ type: "DESC_CHECK_CONTEXT", taskId: id }, 60000);
      if (ctx && ctx.ok) ed.ctx = ctx;
    }
    if (useAi && ed.ctx) {
      // One AI request at a time: the others wait their turn and say so.
      const ahead = aiPending;
      aiPending++;
      ed.msg = ahead ? "Waiting for the AI (" + ahead + " ahead)…" : "Writing the missing text with AI…";
      paint();
      const run = () => window.PcmAI.generate(AI_SYSTEM, aiPrompt(t, ed.ctx, extra), { schema: AI_SCHEMA });
      const turn = aiChain.then(() => { ed.msg = "Writing the missing text with AI…"; paint(); return run(); });
      aiChain = turn.catch(() => {}).then(() => { aiPending--; });
      let out = null;
      try {
        out = readJson(await turn);
        // "client" / "customer" slipped in: asked once more to reword it.
        if (out && BANNED_RE.test([out.clientDescription, out.description, out.preDescription].join(" "))) {
          const again2 = await window.PcmAI.generate(AI_SYSTEM, aiPrompt(t, ed.ctx, ((extra || "") + " Reword it: do not use the words client, clients, customer or customers (or any word for them) anywhere - name the business or site, or just describe the work.").trim()), { schema: AI_SCHEMA }).catch(() => "");
          const o2 = readJson(again2);
          if (o2) out = o2;
        }
      }
      catch (e) {
        if (bg) note = "";
        else if (e && e.code === "consent" && !noOnline) {
          if (confirm("This computer can't run Chrome's built-in AI, so the free online AI would read the task's name, description and comments. Use it?")) {
            window.PcmAI.allowOnline();
            try { out = readJson(await run()); } catch (e2) { note = "The AI didn't answer: " + (e2 && e2.message ? e2.message : e2); }
          } else { noOnline = true; note = "Not sent to the online AI: write the text with ✎ Edit."; }
        } else note = e && e.code === "consent" ? "Write the text with ✎ Edit (online AI declined)." : "The AI didn't answer: " + (e && e.message ? e.message : e);
      }
      if (out) {
        if (needClient) {
          let cd = clean(out.clientDescription || "");
          // Not the client's request: the description's own fields copied back
          // (labels like "Pre Description:" in it, or the Pre Description's text).
          const pre = String(ed.orig.preDescription || "").replace(/\s+/g, " ").trim().toLowerCase();
          const flat = cd.replace(/\s+/g, " ").toLowerCase();
          if (/\b(client description|pre description|pre file|description|file)\s*:/i.test(cd) || (pre.length > 30 && (flat.includes(pre.slice(0, 40)) || pre.includes(flat.slice(0, 40))))) cd = "";
          ed.vals.clientDescription = cd; ed.noClientAsk = !cd;
        }
        if (needDesc && out.description) ed.vals.description = clean(out.description);
        if (needPre && out.preDescription) ed.vals.preDescription = clean(out.preDescription);
      } else if (!note && !bg) note = "The AI's answer couldn't be read: try Suggest again or ✎ Edit.";
    }
    ed.busy = false;
    saveFix(id, ed);
    // Already explained when the client's request wasn't found: not repeated below.
    const left = counted(F.check(afterOf(t, ed), { pre: true }).problems).filter((p) => !(ed.noClientAsk && p === "missingClientDescription"));
    const slipped = ["clientDescription", "description", "preDescription"].some((k) => ed.vals[k] && ed.vals[k] !== ed.orig[k] && BANNED_RE.test(ed.vals[k]));
    ed.msg = (slipped && !note ? "⚠ The AI still used the word client or customer: reword it in After fix before applying. " : "") + (ed.movedNote && !note ? "The note written in File was moved to Description. " : "") + (ed.noClientAsk && !note && on("clientDescription") && fmtOf(t, ed) === 1 ? "The client's request isn't in this task or its comments, so Client Description is left empty: paste it with ✎ Edit. " : "") + (note || (left.length ? "After this fix it would still be: " + left.map((p) => F.PROBLEM_LABEL[p].toLowerCase()).join(", ") + ". Use ✎ Edit to fill it in." : "Check the After column, change anything with ✎ Edit, then Apply."));
    ed.tone = note ? "err" : "";
    paint();
    return true;
  }

  async function apply(id, quiet) {
    const t = byId(id), ed = eds.get(id);
    if (!t || !ed || ed.busy || ed.before == null) return false;
    const set = changesOf(t, ed);
    const text = finalOf(t, ed);
    if (text.trim() === ed.before.trim()) { ed.msg = "Nothing to change."; ed.tone = ""; paint(); return false; }
    if (ed.manual == null && set.File && F.fileState(set.File) === "bad") { ed.msg = "File must be links only, separated by commas."; ed.tone = "err"; ed.open = true; paint(); return false; }
    ed.busy = true; ed.msg = "Saving to ClickUp…"; ed.tone = "";
    if (!quiet) paint();
    // expected = the description the preview was made from: if it changed in
    // ClickUp since, nothing is written.
    const r = await ask({ type: "DESC_CHECK_SAVE", taskId: id, text, expected: ed.before }, 60000);
    ed.busy = false;
    if (!r || !r.ok) {
      ed.msg = r && r.changed ? "This description was changed in ClickUp after the preview, so nothing was written. Press Suggest again to see the new one." : "Not saved: " + ((r && r.error) || "no answer");
      ed.tone = "err"; ed.open = true;
      notes.set(id, "Not applied");
      paint();
      return false;
    }
    // ClickUp confirmed: the row shows the new verdict.
    t.format = r.format; t.problems = r.problems || [];
    t.values = Object.assign({}, r.values || {});
    eds.delete(id);
    dropFix(id);
    picked.delete(id);
    notes.set(id, probs(t).length ? "Applied. Still: " + probs(t).map((p) => F.PROBLEM_LABEL[p].toLowerCase()).join(", ") : "Applied ✓");
    paint();
    return true;
  }

  // ---------- several at once ----------
  async function runBulk(what) {
    if (bulk) return;
    const ids = (rows || []).filter((t) => picked.has(t.id)).map((t) => t.id);
    let list = what === "apply" ? ids.filter((id) => isReady(byId(id), eds.get(id))) : ids;
    if (!list.length) { bulkMsg = what === "apply" ? "None of the ticked tasks has a fix ready: press Prepare fixes first." : "Tick some tasks first."; paint(); return; }
    if (what === "apply" && !confirm("Write the fixes to " + plural(list.length, "task") + " in ClickUp? Each is written exactly as its After column shows.")) return;
    bulk = { what, done: 0, total: list.length, stop: false, ok: 0, failed: 0 };
    bulkMsg = "";
    paint();
    for (const id of list) {
      if (bulk.stop) break;
      const ok = what === "apply" ? await apply(id, true) : await prepare(id, false, true);
      bulk.done++;
      if (ok) bulk.ok++; else bulk.failed++;
      paint();
      await sleep(what === "apply" ? 250 : 150); // ClickUp allows about 100 calls a minute
    }
    const b = bulk;
    bulk = null;
    bulkMsg = (b.stop ? "Stopped. " : "") + (what === "apply"
      ? plural(b.ok, "fix") + " applied" + (b.failed ? ", " + b.failed + " not (open them to see why)" : "") + "."
      : plural(b.ok, "fix") + " prepared" + (b.failed ? ", " + b.failed + " couldn't be read" : "") + ". Open a task (▸) to see Now and After, or Apply selected.");
    paint();
  }

  // ---------- drawing ----------
  function paint() {
    if (!host) return;
    if (!rows) {
      host.innerHTML = '<div class="ip-head"><h2>Descriptions</h2></div>' +
        (error ? '<p class="dc-msg err">' + esc(error) + '</p><button type="button" class="ip-btn" id="dcRetry">Try again</button>'
          : '<div class="ip-card"><div class="dc-msg">Loading your open tasks and their descriptions from ClickUp…</div></div>');
      const rt = host.querySelector("#dcRetry");
      if (rt) rt.onclick = () => load(true);
      return;
    }
    if (!catOn(cat)) cat = "problems";
    const counts = {};
    const base = filtered();
    for (const [k] of CATS) counts[k] = base.filter((t) => inCat(t, k)).length;
    const clients = [...new Set(rows.map((t) => t.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const list = visible();
    const checked = CHECKS.filter((c) => c[0] !== "warm" && on(c[0]) && (c[0] !== "fileStrict" || on("file"))).map((c) => c[1].replace(/, separated by commas$/, "")).join(", ");
    const head = '<div class="ip-head"><h2>Descriptions</h2><span class="sp"></span><span class="ip-meta">' +
      (loading ? "Refreshing…" : "Updated " + ago(at)) + " · " + rows.filter((t) => !t.done).length + " open tasks checked" + (rows.some((t) => t.done) ? " (+ " + rows.filter((t) => t.done).length + " finished in 30 days)" : "") +
      (() => { const need = filtered().filter((t) => probs(t).length); const ready = need.filter((t) => isReady(t, eds.get(t.id))).length; return need.length ? " · " + ready + " of " + need.length + " fixes ready" + (warming ? ", preparing more…" : "") : ""; })() + "</span>" +
      '<button type="button" class="ip-btn" id="dcChecks" aria-expanded="' + checksOpen + '">Checks ' + (checksOpen ? "▴" : "▾") + "</button></div>" +
      (checksOpen ? '<div class="dc-checks"><div class="dc-msg">Switch off what your team doesn\'t use. A task is flagged only for the checks that are on.</div>' +
        CHECKS.map((c) => '<label><input type="checkbox" data-check="' + c[0] + '"' + (on(c[0]) ? " checked" : "") + (c[0] === "fileStrict" && !on("file") ? " disabled" : "") + "> " + esc(c[1]) + (c[2] ? ' <span class="dc-msg">(' + esc(c[2]) + ")</span>" : "") + "</label>").join("") +
        '<div class="dc-msg">Not formatted (none of the fields) is always checked.</div>' +
        '<label for="dcAiNotes" style="display:block;margin-top:8px;font-weight:600">Your instructions for the AI <span class="dc-msg" style="font-weight:400">- used for every suggestion</span></label>' +
        '<textarea id="dcAiNotes" class="dc-ainotes" rows="3" placeholder="e.g. Name the site, never write &quot;the client\'s website&quot;. Short, confident past tense. Mention the pages that were changed.">' + esc(aiNotes) + "</textarea>" +
        '<div class="dc-msg">Saved as you type. Fixes already prepared keep their wording until you press ✨ Suggest again.</div></div>' : "") +
      '<p class="ip-sub">Checks the fields in each task\'s description: <b>' + esc(checked || "none") + "</b>. " + (on("file") && on("fileStrict") ? 'File must hold only links, separated by commas: <code>File: "abc.com,ab.com"</code>. ' : "") + 'Old format has Client Description, the new format doesn\'t. Open a task (▸) to see its description <b>Now</b> and <b>After fix</b>: the fix reads only that task\'s own comments and the AI writes only the empty fields. Untick a part you do not want, or edit the After fix right in its box (✎ Edit here: pasting from an AI, tables, links and files work), then Apply - or tick several tasks and apply them together.</p>' +
      (error ? '<p class="dc-msg err">' + esc(error) + "</p>" : "");
    const chips = '<div class="dc-chips" role="tablist">' + CATS.filter(([k]) => catOn(k)).map(([k, label]) =>
      '<button type="button" data-cat="' + k + '" class="' + (k === cat ? "on" : "") + '">' + esc(label) + "<b>" + counts[k] + "</b></button>").join("") + "</div>";
    const cliCount = new Map();
    for (const t of rows) if (t.client) cliCount.set(t.client, (cliCount.get(t.client) || 0) + 1);
    const cq = cliQ.trim().toLowerCase();
    const cliMenu = '<div class="cu-filter-menu cu-client-menu dc-menu"><input type="search" id="dcCliSearch" class="cu-client-search" placeholder="Search clients…" value="' + esc(cliQ) + '" autocomplete="off">' +
      '<div class="cu-filter-group"><div class="cu-filter-h">Clients' + (fClients.length ? ' <button type="button" class="dc-link" data-cliall>All clients</button>' : "") + "</div>" +
      clients.filter((c) => !cq || c.toLowerCase().includes(cq)).map((c) => '<label><input type="checkbox" data-cli="' + esc(c) + '"' + (fClients.includes(c) ? " checked" : "") + "> <span>" + esc(c) + ' <small class="dc-msg">' + (cliCount.get(c) || 0) + "</small></span></label>").join("") +
      "</div></div>";
    const sts = statusList();
    const fCount = fDue.length + (fStatus ? 1 : 0);
    const fltMenu = '<div class="cu-filter-menu dc-menu"><div class="cu-filter-bar"><div class="cu-filter-clear cu-filter-defaults"><button type="button" data-fclearall>Clear all</button></div></div>' +
      '<div class="cu-filter-group"><div class="cu-filter-h">Due <small>(nothing ticked = any due date)</small></div>' +
      DUE_OPTS.map(([k, l, tip]) => '<label title="' + esc(tip) + '"><input type="checkbox" data-due="' + k + '"' + (fDue.includes(k) ? " checked" : "") + "> <span>" + esc(k === "custom" && fDue.includes("custom") && fFrom ? l + ": " + shortD(fFrom) + (fTo && fTo !== fFrom ? " - " + shortD(fTo) : "") : l) + "</span></label>").join("") +
      (fDue.includes("custom") ? '<button type="button" class="dc-link" data-pickdates>📅 Change dates</button>' : "") + "</div>" +
      '<div class="cu-filter-group"><div class="cu-filter-h">Status <small>(finished = last 30 days)</small></div>' +
      sts.map((s) => '<label><input type="checkbox" data-st="' + esc(s.k) + '"' + ((fStatus ? fStatus.includes(s.k) : true) ? " checked" : "") + '> <span class="dc-cap">' + esc(s.k) + ' <small class="dc-msg">' + s.n + (s.done ? " · finished" : "") + "</small></span></label>").join("") +
      '<div class="dc-st-acts"><button type="button" class="dc-link" data-stset="open">Open only</button><button type="button" class="dc-link" data-stset="all">All</button></div></div></div>';
    const tools = '<div class="dc-tools"><input type="search" id="dcSearch" placeholder="Search task or client" value="' + esc(query) + '">' +
      '<div class="cu-filter"><button type="button" class="cu-filter-btn' + (fClients.length ? " on" : "") + '" data-menu="clients" aria-expanded="' + (menu === "clients") + '">▾ Clients' + (fClients.length ? " · " + fClients.length : "") + "</button>" + (menu === "clients" ? cliMenu : "") + "</div>" +
      '<div class="cu-filter"><button type="button" class="cu-filter-btn' + (fCount ? " on" : "") + '" data-menu="filter" aria-expanded="' + (menu === "filter") + '">▾ Filter' + (fCount ? " · " + fCount : "") + "</button>" + (menu === "filter" ? fltMenu : "") + "</div>" +
      (fClients.length || fCount ? '<button type="button" class="dc-link" id="dcClearF">Clear filters</button>' : "") + "</div>";
    const sel = list.filter((t) => picked.has(t.id));
    const selAll = (rows || []).filter((t) => picked.has(t.id));
    const ready = selAll.filter((t) => isReady(t, eds.get(t.id))).length;
    const allOn = list.length > 0 && sel.length === list.length;
    const page = list.slice(0, shown);
    const allOpen = page.length > 0 && page.every((t) => { const e = eds.get(t.id); return e && e.open; });
    const bar = list.length ? '<div class="dc-bulk">' +
      '<button type="button" class="ip-btn" id="dcOpenAll" title="' + (allOpen ? "Close every task shown" : "Open every task shown (" + page.length + "): fixes not prepared yet are prepared one after another") + '">' + (allOpen ? "▴ Close all" : "▾ Open all " + page.length) + "</button>" +
      (cat !== "good" ?
      '<label><input type="checkbox" id="dcAll"' + (allOn ? " checked" : "") + (bulk ? " disabled" : "") + "> Select all " + list.length + "</label>" +
      '<span class="dc-msg">' + selAll.length + " selected" + (selAll.length ? " · " + ready + " ready" : "") + "</span>" +
      '<button type="button" class="ip-btn" id="dcPrep"' + (bulk || !selAll.length ? " disabled" : "") + ">✨ Prepare fixes</button>" +
      '<button type="button" class="ip-btn dc-btn-primary" id="dcApplySel"' + (bulk || !ready ? " disabled" : "") + ">Apply selected (" + ready + ")</button>" : "") +
      (bulk ? '<span class="dc-msg">' + (bulk.what === "apply" ? "Applying " : "Preparing ") + Math.min(bulk.done + 1, bulk.total) + " of " + bulk.total + "…</span>" +
        '<button type="button" class="ip-btn" id="dcStop">Stop</button>' : "") +
      (bulkMsg && !bulk ? '<span class="dc-msg">' + esc(bulkMsg) + "</span>" : "") +
      "</div>" : bulkMsg ? '<p class="dc-msg">' + esc(bulkMsg) + "</p>" : "";
    const body = list.length
      ? list.slice(0, shown).map(rowHtml).join("") + (list.length > shown ? '<div style="margin-top:10px"><button type="button" class="ip-btn" id="dcMore">Show 30 more (' + (list.length - shown) + " left)</button></div>" : "")
      : '<p class="dc-msg">' + (cat === "good" ? "No task has all its fields filled in yet." : "Nothing here: every task in this view has its fields filled in.") + "</p>";
    // Keep the search box's focus and caret, and a textarea's, across the repaint.
    const a = document.activeElement;
    const keep = a && host.contains(a) && (a.id === "dcSearch" || a.id === "dcCliSearch" || a.id === "dcAiNotes" || a.matches("textarea[data-k]") || a.matches("input[data-ask]")) ? { id: a.id, ask: a.getAttribute("data-ask"), k: a.getAttribute("data-k"), ed: a.closest(".dc-ed") && a.closest(".dc-ed").getAttribute("data-ed"), pos: a.selectionStart } : null;
    // Where each Now / After box was scrolled, and the page itself: a repaint (a
    // background fix finishing, a tick) must not throw the reader back to the top.
    const docScroll = {};
    host.querySelectorAll(".dc-ed[data-ed]").forEach((el) => {
      const d = el.querySelectorAll(".dc-doc");
      if (d.length === 2 && el.querySelector(".dc-doc .add, .dc-doc .del, .dc-doc div")) docScroll[el.getAttribute("data-ed")] = [d[0].scrollTop, d[1].scrollTop];
    });
    const pageY = window.scrollY;
    // An After editor being typed in: remember where the caret is.
    let edFocus = null;
    for (const ed of eds.values()) {
      if (!ed.edEl || !ed.edEl.contains(document.activeElement)) continue;
      const sel = window.getSelection();
      edFocus = { el: ed.edEl, area: document.activeElement, range: sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null };
    }
    host.innerHTML = head + chips + tools + bar + '<div class="ip-card">' + body + "</div>";
    host.querySelectorAll(".dc-ed[data-ed]").forEach((el) => {
      const id = el.getAttribute("data-ed");
      const d = el.querySelectorAll(".dc-doc");
      if (d.length !== 2) return;
      const ready = !!el.querySelector(".dc-cmp[data-diff]");
      if (ready && !scrolledTo.has(id)) {
        // First time this fix is shown: open both boxes at the first change,
        // not at the unchanged top of a long description.
        scrolledTo.add(id);
        const first = (box) => box.querySelector(".add, .del");
        const a1 = first(d[0]), a2 = first(d[1]);
        const top = Math.max(0, Math.min(a1 ? a1.offsetTop : Infinity, a2 ? a2.offsetTop : Infinity) - 30);
        if (isFinite(top)) { d[0].scrollTop = a1 ? a1.offsetTop - 30 : top; d[1].scrollTop = a2 ? a2.offsetTop - 30 : top; }
      } else if (docScroll[id]) { d[0].scrollTop = docScroll[id][0]; d[1].scrollTop = docScroll[id][1]; }
      // The two boxes scroll together, so Now and After stay side by side.
      let syncing = false;
      const follow = (from, to) => from.addEventListener("scroll", () => {
        if (syncing) return;
        syncing = true;
        const r = from.scrollHeight > from.clientHeight ? from.scrollTop / (from.scrollHeight - from.clientHeight) : 0;
        to.scrollTop = r * (to.scrollHeight - to.clientHeight);
        requestAnimationFrame(() => { syncing = false; });
      }, { passive: true });
      follow(d[0], d[1]); follow(d[1], d[0]);
    });
    // The After editor survives repaints: the same element goes back in, with its
    // caret (a background fix finishing must not interrupt typing).
    host.querySelectorAll("[data-edhost]").forEach((slot) => {
      const id = slot.getAttribute("data-edhost"), ed = eds.get(id), t = byId(id);
      if (!ed || !t) return;
      if (!ed.edEl) ed.edEl = makeEditor(id, ed, t);
      slot.replaceWith(ed.edEl);
    });
    if (edFocus && edFocus.el.isConnected) {
      try { edFocus.area.focus(); if (edFocus.range) { const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(edFocus.range); } } catch (e) {}
    }
    if (Math.abs(window.scrollY - pageY) > 2) window.scrollTo(0, pageY);
    if (keep) {
      const el = keep.id === "dcSearch" || keep.id === "dcCliSearch" || keep.id === "dcAiNotes" ? host.querySelector("#" + keep.id) : keep.ask ? host.querySelector('input[data-ask="' + CSS.escape(keep.ask) + '"]') : host.querySelector('.dc-ed[data-ed="' + CSS.escape(keep.ed || "") + '"] textarea[data-k="' + keep.k + '"]');
      if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) {} }
    }
    wire();
  }

  function rowHtml(t) {
    const ed = eds.get(t.id);
    const chips = probs(t).length
      ? probs(t).map((p) => '<span class="chip c-' + (TONE[p] || "warn") + '">' + esc(F.PROBLEM_LABEL[p]) + "</span>").join(" ")
      : '<span class="chip c-good">All good</span>';
    const fmt = t.format ? '<span class="chip c-mut" title="' + (t.format === 1 ? "Has a Client Description line" : "No Client Description line") + '">' + FMT_NAME[t.format] + "</span>" : "";
    const note = notes.get(t.id);
    const ready = isReady(t, ed);
    const isOpen = ed && ed.open;
    return '<div class="dc-row" data-id="' + esc(t.id) + '"><div class="dc-line">' +
      '<input type="checkbox" data-pick="' + esc(t.id) + '"' + (picked.has(t.id) ? " checked" : "") + (bulk ? " disabled" : "") + ' title="Select for Prepare fixes / Apply selected">' +
      '<button type="button" class="dc-tw" data-open="' + esc(t.id) + '" title="' + (isOpen ? "Hide" : "Show the description now and after the fix") + '">' + (isOpen ? "▾" : "▸") + "</button>" +
      '<span class="dc-name"><button type="button" class="dc-title" data-open="' + esc(t.id) + '" title="' + (isOpen ? "Hide" : "Show the description now and after the fix") + '">' + esc(t.name) + "</button>" +
      (t.client ? ' <span class="dc-client">· ' + esc(t.client) + "</span>" : "") + "</span>" +
      fmt + chips +
      (ed && ed.busy ? ' <span class="dc-msg">' + esc(ed.msg) + "</span>" : ready ? ' <span class="chip c-good">Fix ready</span>' : "") +
      (note ? ' <span class="dc-msg ' + (/^Applied/.test(note) ? "good" : "err") + '">' + esc(note) + "</span>" : "") +
      (ready ? ' <button type="button" class="ip-btn dc-btn-primary" data-apply="' + esc(t.id) + '"' + (bulk ? " disabled" : "") + ">Apply</button>" : "") +
      "</div>" + (isOpen ? editorHtml(t, ed) + '<div class="dc-cmtslot" data-id="' + esc(t.id) + '"></div>' : "") + "</div>";
  }

  // The task's status in ClickUp's colours, roughly: done green, review purple,
  // in progress blue, blocked red, the rest grey.
  function statusChip(st) {
    const s0 = String(st || "").toLowerCase();
    if (!s0) return "";
    const tone = /complete|done|closed|approved|published|live/.test(s0) ? "good" : /block|roadblock|hold|stuck|waiting/.test(s0) ? "bad" : /review|qa|check/.test(s0) ? "purple" : /progress|doing|working|started/.test(s0) ? "blue" : "mut";
    return '<span class="chip c-' + tone + ' dc-cap">' + esc(st) + "</span>";
  }
  function metaHtml(t) {
    const due = Number(t.dueDateMs) || 0;
    const late = due && due < day0(Date.now()) && !t.done;
    return '<div class="dc-meta"><span class="dc-msg">Status</span>' + (statusChip(t.status) || '<span class="dc-msg">-</span>') +
      '<span class="dc-msg">Due</span><span class="' + (late ? "dc-late" : "") + '">' + (due ? esc(new Date(due).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })) + (late ? " · overdue" : "") : "no due date") + "</span>" +
      (t.client ? '<span class="dc-msg">Client</span><span>' + esc(t.client) + "</span>" : "") + "</div>";
  }
  function editorHtml(t, ed) {
    let h = '<div class="dc-ed" data-ed="' + esc(t.id) + '">' + metaHtml(t);
    if (ed.before == null) return h + '<div class="dc-msg' + (ed.tone ? " " + ed.tone : "") + '">' + esc(ed.msg || "Reading this task…") + "</div></div>";
    if (!t.format) {
      h += '<div class="dc-fmt"><span>This task has no fields yet. Add:</span>' +
        '<label><input type="radio" name="dcf_' + esc(t.id) + '" value="1"' + (ed.addFormat === 1 ? " checked" : "") + "> Old format (with Client Description)</label>" +
        '<label><input type="radio" name="dcf_' + esc(t.id) + '" value="2"' + (ed.addFormat === 2 ? " checked" : "") + "> New format (without Client Description)</label></div>";
    }
    if (ed.busy) {
      // Still preparing: the After column says so instead of showing the
      // unchanged text and then filling in under the reader's eyes.
      const now = ed.before.split(/\n/).map((x) => ({ x, k: "" }));
      h += '<div class="dc-cmp"><div class="dc-col"><h4>Now</h4>' + docHtml(now, "(the description is empty)") + "</div>" +
        '<div class="dc-col"><h4>After fix</h4><div class="dc-doc"><div class="gap">' + esc(ed.msg || "Preparing the fix…") + "</div></div></div></div>";
    } else {
      // Which parts of the fix to use (untick one to leave that part as it is).
      const parts = Object.keys(changesOf(t, ed, true));
      if (parts.length) {
        h += '<div class="dc-use"><span class="dc-msg">Use in the fix:</span>' + parts.map((l) =>
          '<label title="Untick to leave ' + esc(l) + ' as it is now"><input type="checkbox" data-use="' + esc(l) + '"' + (!ed.use || ed.use[l] !== false ? " checked" : "") + "> " + esc(l) + "</label>").join("") +
          (ed.manual != null ? '<span class="dc-msg">· edited by hand</span>' : "") + "</div>";
      }
      const d = diffLines(ed.before, finalOf(t, ed));
      h += '<div class="dc-cmp" data-diff><div class="dc-col"><h4>Now</h4>' + docHtml(d.left, "(the description is empty)") + "</div>" +
        '<div class="dc-col"><h4>After fix <span class="dc-h4btns">' +
        (ed.editingAfter
          ? '<button type="button" class="dc-hbtn" data-attach="' + esc(t.id) + '" title="Attach screenshots or files to the task and put their links here (you can also paste or drop them in the box)">📎 Attach</button>' +
            (ed.manual != null ? '<button type="button" class="dc-hbtn" data-unedit="' + esc(t.id) + '" title="Throw away what you typed and show the fix again">↺ Undo my edits</button>' : "") +
            '<button type="button" class="dc-hbtn main" data-edit="' + esc(t.id) + '">✓ Done</button>'
          : '<button type="button" class="dc-hbtn main" data-edit="' + esc(t.id) + '" title="Edit the After fix text right here (pasting from an AI, tables, links and files work)">✎ Edit here</button>') +
        "</span></h4>" +
        (ed.editingAfter ? '<div class="dc-edhost" data-edhost="' + esc(t.id) + '"></div>' : '<div class="dc-afterview" data-edit="' + esc(t.id) + '" title="Click to edit">' + docHtml(d.right, "(empty)") + "</div>") +
        '<div class="dc-msg" data-upmsg="' + esc(t.id) + '"></div>' +
        "</div></div>";
    }
    if (ed.links.length) {
      h += '<div class="dc-links"><b>Links in this task\'s comments</b> <span class="dc-msg">tick the ones that belong in File</span>' + ed.links.map((u, i) =>
        '<label><input type="checkbox" data-link="' + i + '"' + (ed.pick.includes(u) ? " checked" : "") + "> " + esc(u) + "</label>").join("") + "</div>";
    } else h += '<div class="dc-msg" style="margin-top:8px">No links in this task\'s comments.</div>';
    const ready = isReady(t, ed);
    h += '<div class="dc-acts">' +
      '<button type="button" class="ip-btn dc-btn-primary" data-apply="' + esc(t.id) + '"' + (ed.busy || !ready || bulk ? " disabled" : "") + ">Apply this fix</button>" +
      '<a class="ip-btn dc-cu" href="' + esc(t.url) + '" target="_blank" rel="noopener" title="Open this task in ClickUp">Open in ClickUp ↗</a>' +
      (window.PcmTaskPanel && window.PcmTaskPanel.openIn ? '<button type="button" class="ip-btn' + (cmtOpen === t.id ? " on" : "") + '" data-cmt="' + esc(t.id) + '" title="' + (cmtOpen === t.id ? "Hide the comments" : "Read and reply to this task's comments right here") + '">💬 ' + (cmtOpen === t.id ? "Hide comments" : "Comments" + (ed.ctx && ed.ctx.comments ? " (" + ed.ctx.comments.length + ")" : "")) + "</button>" : "") +
      '<input type="text" class="dc-ask" data-ask="' + esc(t.id) + '" maxlength="300" placeholder="Tell the AI what to change (optional)" value="' + esc(ed.ask || "") + '"' + (ed.busy || bulk ? " disabled" : "") + ">" +
      '<button type="button" class="ip-btn" data-again="' + esc(t.id) + '"' + (ed.busy || bulk ? " disabled" : "") + ">✨ Suggest again</button>" +
      '<span class="dc-msg' + (ed.tone ? " " + ed.tone : "") + '">' + esc(ed.busy ? ed.msg : ready ? ed.msg : ed.msg || "Nothing would change.") + "</span></div></div>";
    return h;
  }

  function wire() {
    host.querySelectorAll("[data-cat]").forEach((b) => { b.onclick = () => { cat = b.getAttribute("data-cat"); shown = 30; paint(); }; });
    const s = host.querySelector("#dcSearch");
    if (s) s.oninput = () => { query = s.value; shown = 30; paint(); };
    host.querySelectorAll("[data-menu]").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); const m = b.getAttribute("data-menu"); menu = menu === m ? "" : m; paint(); }; });
    const cs = host.querySelector("#dcCliSearch");
    if (cs) cs.oninput = () => { cliQ = cs.value; paint(); };
    host.querySelectorAll("[data-cli]").forEach((x) => {
      x.onchange = () => { const k = x.getAttribute("data-cli"); fClients = x.checked ? [...new Set(fClients.concat(k))] : fClients.filter((y) => y !== k); saveFilter(); shown = 30; paint(); };
    });
    const ca = host.querySelector("[data-cliall]");
    if (ca) ca.onclick = () => { fClients = []; saveFilter(); shown = 30; paint(); };
    const pickDates = () => {
      if (!window.PcmCalendar || !window.PcmCalendar.open) return;
      const use = (a, z) => { if (!fDue.includes("custom")) fDue = fDue.concat("custom"); fFrom = day0(a); fTo = day0(z || a); saveFilter(); shown = 30; paint(); };
      window.PcmCalendar.open(host.querySelector('[data-menu="filter"]'), {
        title: "Due dates for Descriptions",
        onRange: (a, z) => use(a, z),
        onDays: (list) => { const s = list.slice().sort((x, y) => x - y); use(s[0], s[s.length - 1]); },
      });
    };
    host.querySelectorAll("[data-due]").forEach((x) => {
      x.onchange = () => {
        const k = x.getAttribute("data-due");
        fDue = x.checked ? [...new Set(fDue.concat(k))] : fDue.filter((y) => y !== k);
        if (k === "custom" && !x.checked) fFrom = fTo = 0;
        saveFilter(); shown = 30; paint();
        if (k === "custom" && x.checked) pickDates();
      };
    });
    const pd = host.querySelector("[data-pickdates]");
    if (pd) pd.onclick = (e) => { e.stopPropagation(); pickDates(); };
    host.querySelectorAll("[data-st]").forEach((x) => {
      x.onchange = () => {
        const cur = fStatus ? fStatus.slice() : statusList().map((s) => s.k);
        const k = x.getAttribute("data-st");
        fStatus = x.checked ? [...new Set(cur.concat(k))] : cur.filter((y) => y !== k);
        saveFilter(); shown = 30; paint();
      };
    });
    host.querySelectorAll("[data-stset]").forEach((b) => {
      b.onclick = () => { fStatus = b.getAttribute("data-stset") === "all" ? null : statusList().filter((s) => !s.done).map((s) => s.k); saveFilter(); shown = 30; paint(); };
    });
    const fca = host.querySelector("[data-fclearall]");
    if (fca) fca.onclick = () => { fDue = []; fFrom = fTo = 0; fStatus = null; saveFilter(); shown = 30; paint(); };
    const cf = host.querySelector("#dcClearF");
    if (cf) cf.onclick = () => { fClients = []; fDue = []; fFrom = fTo = 0; fStatus = null; menu = ""; saveFilter(); shown = 30; paint(); };
    const more = host.querySelector("#dcMore");
    if (more) more.onclick = () => { shown += 30; paint(); };
    const all = host.querySelector("#dcAll");
    if (all) all.onchange = () => { const list = visible(); if (all.checked) list.forEach((t) => picked.add(t.id)); else list.forEach((t) => picked.delete(t.id)); bulkMsg = ""; paint(); };
    const cb = host.querySelector("#dcChecks");
    if (cb) cb.onclick = () => { checksOpen = !checksOpen; paint(); };
    host.querySelectorAll("[data-check]").forEach((x) => {
      x.onchange = () => {
        prefs[x.getAttribute("data-check")] = x.checked;
        paint();
        if (x.getAttribute("data-check") === "warm" && x.checked) warm();
        ask({ type: "SET_SETTINGS", patch: { descChecks: Object.assign({}, prefs) } }, 15000);
      };
    });
    const prep = host.querySelector("#dcPrep");
    if (prep) prep.onclick = () => runBulk("prepare");
    const aps = host.querySelector("#dcApplySel");
    if (aps) aps.onclick = () => runBulk("apply");
    const stop = host.querySelector("#dcStop");
    if (stop) stop.onclick = () => { if (bulk) bulk.stop = true; stop.disabled = true; };
    host.querySelectorAll("[data-pick]").forEach((cb) => { cb.onchange = () => { const id = cb.getAttribute("data-pick"); if (cb.checked) picked.add(id); else picked.delete(id); bulkMsg = ""; paint(); }; });
    const oa = host.querySelector("#dcOpenAll");
    if (oa) oa.onclick = () => {
      const page = visible().slice(0, shown);
      const allOpen = page.length > 0 && page.every((t) => { const e = eds.get(t.id); return e && e.open; });
      if (allOpen) { for (const t of page) { const e = eds.get(t.id); if (e) { e.open = false; scrolledTo.delete(t.id); } } if (cmtOpen) { cmtOpen = ""; try { window.PcmTaskPanel.close(); } catch (e) {} } paint(); return; }
      for (const t of page) {
        let e = eds.get(t.id);
        if (!e) {
          // Not prepared yet: it waits its turn (one at a time, gentle on ClickUp and the AI).
          e = { addFormat: lastFormat(), open: true, editing: false, vals: {}, orig: {}, links: [], pick: [], before: null, msg: "Waiting its turn to be prepared…", tone: "" };
          eds.set(t.id, e);
          openQueue.push(t.id);
        }
        e.open = true; notes.delete(t.id);
      }
      paint();
      runOpenQueue();
    };
    // Anywhere on a task's bar opens / closes it - except its own controls
    // (tick box, Apply, a link) and text being selected.
    host.querySelectorAll(".dc-row > .dc-line").forEach((line) => {
      line.onclick = (e) => {
        if (e.target.closest("input, button, a, select, textarea, label")) return;
        const sel = window.getSelection && window.getSelection();
        if (sel && String(sel).trim()) return;
        const row = line.closest(".dc-row");
        const btn = row && row.querySelector(":scope > .dc-line [data-open]");
        if (btn) btn.click();
      };
    });
    host.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = () => {
        const id = b.getAttribute("data-open");
        let ed = eds.get(id);
        if (ed && ed.open) { ed.open = false; scrolledTo.delete(id); if (cmtOpen === id) { cmtOpen = ""; try { window.PcmTaskPanel.close(); } catch (e) {} } paint(); return; }
        if (!ed || (ed.before == null && !ed.busy)) { prepare(id).then(() => {}); ed = eds.get(id); }
        if (ed) { ed.open = true; notes.delete(id); paint(); }
      };
    });
    host.querySelectorAll("[data-apply]").forEach((b) => { b.onclick = () => apply(b.getAttribute("data-apply")); });
    host.querySelectorAll("[data-again]").forEach((b) => { b.onclick = () => { const id = b.getAttribute("data-again"); const ed = eds.get(id); prepare(id, true, false, false, ed && ed.ask); }; });
    host.querySelectorAll("[data-ask]").forEach((x) => {
      const id = x.getAttribute("data-ask");
      x.oninput = () => { const ed = eds.get(id); if (ed) ed.ask = x.value; };
      x.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); const ed = eds.get(id); prepare(id, true, false, false, ed && ed.ask); } };
    });
    const an = host.querySelector("#dcAiNotes");
    if (an) an.oninput = () => {
      aiNotes = an.value;
      clearTimeout(an._t);
      an._t = setTimeout(() => ask({ type: "SET_SETTINGS", patch: { descAiNotes: aiNotes.slice(0, 1500) } }, 15000), 600);
    };
    host.querySelectorAll("[data-edit]").forEach((b) => {
      b.onclick = (e) => {
        if (e.target.closest && e.target.closest("a")) return; // a link in the After text opens as a link
        const id = b.getAttribute("data-edit"), ed = eds.get(id);
        if (!ed || ed.busy) return;
        ed.editingAfter = !ed.editingAfter;
        if (!ed.editingAfter) ed.edEl = null; // Done: back to the highlighted view (of the edited text)
        paint();
        if (ed.editingAfter && ed.edEl && ed.edEl.focusEnd) ed.edEl.focusEnd();
      };
    });
    host.querySelectorAll("[data-use]").forEach((x) => {
      x.onchange = () => {
        const id = x.closest(".dc-ed").getAttribute("data-ed"), ed = eds.get(id);
        if (!ed || !dropManual(ed)) { x.checked = !x.checked; return; }
        ed.use = Object.assign({}, ed.use || {}, { [x.getAttribute("data-use")]: x.checked });
        saveFix(id, ed); paint();
      };
    });
    host.querySelectorAll("[data-cmt]").forEach((b) => { b.onclick = () => toggleComments(b.getAttribute("data-cmt")); });
    host.querySelectorAll("[data-unedit]").forEach((b) => {
      b.onclick = () => { const id = b.getAttribute("data-unedit"), ed = eds.get(id); if (!ed) return; ed.manual = null; ed.edEl = null; saveFix(id, ed); paint(); if (ed.edEl && ed.edEl.focusEnd) ed.edEl.focusEnd(); };
    });
    host.querySelectorAll("[data-attach]").forEach((b) => {
      b.onclick = () => {
        const id = b.getAttribute("data-attach");
        const inp = document.createElement("input");
        inp.type = "file"; inp.multiple = true;
        inp.onchange = () => { if (inp.files && inp.files.length) attachFiles(id, inp.files); };
        inp.click();
      };
    });
    host.querySelectorAll(".dc-ed").forEach((el) => {
      const id = el.getAttribute("data-ed");
      const ed = eds.get(id);
      if (!ed) return;
      // What is typed is kept as it is typed; the After column follows it.
      el.querySelectorAll("textarea[data-k]").forEach((ta) => {
        ta.oninput = () => {
          ed.vals[ta.getAttribute("data-k")] = ta.value; ed.edited = true; saveFix(id, ed);
          if (ta.getAttribute("data-k") === "file") ed.pick = ed.links.filter((u) => F.linksIn(ta.value).includes(u));
          clearTimeout(ed._t); ed._t = setTimeout(paint, 250);
        };
      });
      el.querySelectorAll('input[type="radio"]').forEach((r) => { r.onchange = () => { ed.addFormat = Number(r.value) === 1 ? 1 : 2; rememberFormat(ed.addFormat); if (ed.addFormat === 1 && !String(ed.vals.clientDescription || "").trim()) prepare(id, false); else paint(); }; });
      el.querySelectorAll("input[data-link]").forEach((cb) => {
        cb.onchange = () => {
          if (!dropManual(ed)) { cb.checked = !cb.checked; return; }
          const u = ed.links[Number(cb.getAttribute("data-link"))];
          ed.pick = cb.checked ? ed.pick.concat(u) : ed.pick.filter((x) => x !== u);
          // The ticked links are the File value; links typed by hand stay.
          const typed = F.linksIn(ed.vals.file || "").filter((x) => !ed.links.includes(x));
          ed.vals.file = F.fileValue(typed.concat(ed.pick));
          ed.edited = true; saveFix(id, ed);
          paint();
        };
      });
    });
  }

  window.PcmDescCheck = {
    render(el) {
      host = el;
      if (!hydrated) {
        // The last result first (a few ms), then a fresh read if it's old.
        hydrated = true;
        paint();
        hydrate().then(() => {
          if (!rows || Date.now() - at > 3 * 60000) load(false);
          else { paint(); warm(); }
        });
        return;
      }
      if (!rows && !loading) load(false);
      else if (rows && !loading && !bulk && Date.now() - at > 5 * 60000) load(false);
      paint();
    },
    refresh() { return load(true); },
  };
  // Ready before it's opened: a few seconds after Options opens (on any tab),
  // the list is brought up to date and the fixes are prepared in the background.
  setTimeout(() => {
    if (hydrated) return; // the tab was opened meanwhile: render() does it
    hydrated = true;
    hydrate().then(() => {
      if (!rows || Date.now() - at > 3 * 60000) load(false);
      else warm();
    });
  }, 4000);
  // options.js may have drawn Insights before this file loaded (the tab opens
  // on Descriptions when it was the last one used): draw now.
  try {
    const box = document.getElementById("insDescView");
    if (box && typeof insSub !== "undefined" && insSub === "descriptions" && typeof renderInsights === "function") renderInsights();
  } catch (e) {}
})();
