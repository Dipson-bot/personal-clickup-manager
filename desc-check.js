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
  ];
  let prefs = Object.fromEntries(CHECKS.map((c) => [c[0], c[3]]));
  let checksOpen = false;
  const on = (k) => prefs[k] !== false;
  const PREF_OF = { missingClientDescription: "clientDescription", missingDescription: "description", missingFile: "file", fileNotFormatted: "fileStrict", missingPreDescription: "preDescription", missingPreFile: "preFile" };
  // The problems that count with the checks switched on.
  const counted = (list) => (list || []).filter((p) => p === "notFormatted" || (on(PREF_OF[p]) && (p !== "fileNotFormatted" || on("file"))));
  const probs = (t) => counted(t.problems);
  function readPrefs(st) {
    const d = st && st.descChecks;
    if (d && typeof d === "object") for (const c of CHECKS) if (typeof d[c[0]] === "boolean") prefs[c[0]] = d[c[0]];
  }
  try {
    chrome.storage.local.get("settings").then((g) => { readPrefs(g && g.settings); paint(); }).catch(() => {});
    chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.settings && ch.settings.newValue) { const before = JSON.stringify(prefs); readPrefs(ch.settings.newValue); if (JSON.stringify(prefs) !== before) paint(); } });
  } catch (e) {}

  let rows = null, at = 0, loading = false, error = "";
  let cat = "problems", client = "", query = "", shown = 30;
  let host = null;
  const eds = new Map(); // taskId -> fix state (kept while the page is open)
  const picked = new Set(); // ticked rows
  const notes = new Map(); // taskId -> "Applied" / failure note
  let bulk = null; // { what: "prepare" | "apply", done, total, stop }
  let bulkMsg = "", noOnline = false, hydrated = false;

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
  #insDescView .chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
  #insDescView .chip.good { background: rgba(22,163,74,.14); color: var(--green); }
  #insDescView .chip.warn { background: rgba(217,119,6,.15); color: var(--amber); }
  #insDescView .chip.bad { background: rgba(220,38,38,.13); color: var(--red); }
  #insDescView .chip.mut { background: var(--bg2, rgba(0,0,0,.06)); color: var(--muted); font-weight: 500; }
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
  #insDescView .dc-checks { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; margin: 6px 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); max-width: 520px; }
  #insDescView .dc-checks label { display: flex; gap: 7px; align-items: center; margin: 0; font-size: 12.5px; }
  #insDescView .dc-bulk { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 10px; margin: 0 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); font-size: 12px; }
  #insDescView .dc-bulk label { display: inline-flex; gap: 6px; align-items: center; margin: 0; font-weight: 600; }
  #insDescView .dc-row { border-top: 1px solid var(--border); padding: 9px 0; }
  #insDescView .dc-row:first-child { border-top: 0; }
  #insDescView .dc-line { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  #insDescView .dc-tw { font: inherit; font-size: 12px; width: 22px; height: 22px; border: 0; background: none; color: var(--muted); cursor: pointer; padding: 0; }
  #insDescView .dc-tw:hover { color: var(--indigo); }
  #insDescView .dc-name { font-weight: 600; flex: 1 1 260px; min-width: 0; }
  #insDescView .dc-client { font-size: 11px; color: var(--muted); font-weight: 400; }
  #insDescView .dc-ed { margin: 8px 0 4px 28px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2, rgba(0,0,0,.03)); }
  #insDescView .dc-cmp { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
  @media (max-width: 760px) { #insDescView .dc-cmp { grid-template-columns: 1fr; } }
  #insDescView .dc-col h4 { margin: 0 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  #insDescView .dc-doc { font-size: 12px; line-height: 1.5; border: 1px solid var(--border); border-radius: 8px; background: var(--card); padding: 6px 0; max-height: 320px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
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
    } else error = r && r.reason === "not-configured" ? "Connect ClickUp first (ClickUp setup)." : (r && r.error) || "Couldn't read your tasks.";
    paint();
  }

  const inCat = (t, c) => c === "problems" ? probs(t).length > 0 : c === "good" ? !probs(t).length : probs(t).includes(c);
  // A category chip shows only while its check is on.
  const catOn = (k) => k === "problems" || k === "good" || k === "notFormatted" || (on(PREF_OF[k]) && (k !== "fileNotFormatted" || on("file")));
  function visible() {
    const q = query.trim().toLowerCase();
    return (rows || []).filter((t) => inCat(t, cat) && (!client || t.client === client) && (!q || (t.name + " " + (t.client || "")).toLowerCase().includes(q)));
  }
  const byId = (id) => (rows || []).find((t) => t.id === id);

  // ---------- the fix of one task ----------
  const KEY = { "Client Description": "clientDescription", "Pre Description": "preDescription", "Pre File": "preFile", "Description": "description", "File": "file" };
  const HINT = {
    "Pre Description": "what the task is meant to do (the plan)",
    "Pre File": "the file or links the work starts from",
    "Client Description": "a client-ready summary: what was done and why it helps, in plain words",
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
  function changesOf(t, ed) {
    const set = {};
    for (const label of fieldsFor(t, ed)) {
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
  const isReady = (t, ed) => !!(ed && ed.before != null && !ed.busy && afterOf(t, ed) !== ed.before);

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

  const AI_SYSTEM = "You fill in the closing fields of a ClickUp task for an SEO and website agency. Use only the facts in the task details and in the task's own comments. Never invent results, numbers, links, names or dates. Write plain English. No em dashes, no emojis, no markdown, no quotation marks around the text.";
  const AI_SCHEMA = { type: "object", properties: { clientDescription: { type: "string" }, description: { type: "string" }, preDescription: { type: "string" } }, required: ["clientDescription", "description", "preDescription"] };
  const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  function aiPrompt(t, ctx) {
    const comments = (ctx.comments || []).slice(0, 12).map((c) => "- " + c.who + ", " + fmtDate(c.at) + ": " + String(c.text || "").replace(/\s+/g, " ").slice(0, 700)).join("\n");
    const brief = String(ctx.description || t.briefText || "").replace(/\s+/g, " ").slice(0, 1800);
    return "Task title: " + t.name + "\n" +
      (t.client ? "Client: " + t.client + "\n" : "") +
      (t.status ? "Status: " + t.status + "\n" : "") +
      (brief ? "Task description: " + brief + "\n" : "") +
      ((ctx.fields || []).length ? "Other fields: " + ctx.fields.join("; ") + "\n" : "") +
      "\nThis task's own comments (newest first):\n" + (comments || "(none)") + "\n\n" +
      "Write three things:\n" +
      "clientDescription: a client-ready summary in 1 to 3 short sentences for the business owner: what was done and how it helps them. No technical jargon, no internal tool or team names.\n" +
      "description: a closing statement in 1 to 3 sentences for the team: what was done, where, and how it was checked.\n" +
      "preDescription: 1 or 2 sentences on what the task is meant to do (the plan), from its title and description.\n" +
      "If the details don't say something, leave it out rather than guessing.\n" +
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
  async function prepare(id, again, quiet) {
    const t = byId(id);
    if (!t) return false;
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
    const needPre = on("preDescription") && (again ? !ed.edited : !String(ed.vals.preDescription || "").trim()) && !String(ed.orig.preDescription || "").trim();
    const needClient = on("clientDescription") && fmtOf(t, ed) === 1 && (again ? !ed.edited : !String(ed.vals.clientDescription || "").trim()) && !String(ed.orig.clientDescription || "").trim();
    const needDesc = on("description") && (again ? !ed.edited : !String(ed.vals.description || "").trim()) && !String(ed.orig.description || "").trim();
    let note = "";
    if ((needClient || needDesc || needPre) && window.PcmAI) {
      ed.msg = "Writing the missing text with AI…";
      if (!quiet) paint();
      const run = () => window.PcmAI.generate(AI_SYSTEM, aiPrompt(t, ed.ctx), { schema: AI_SCHEMA });
      let out = null;
      try { out = readJson(await run()); }
      catch (e) {
        if (e && e.code === "consent" && !noOnline) {
          if (confirm("This computer can't run Chrome's built-in AI, so the free online AI would read the task's name, description and comments. Use it?")) {
            window.PcmAI.allowOnline();
            try { out = readJson(await run()); } catch (e2) { note = "The AI didn't answer: " + (e2 && e2.message ? e2.message : e2); }
          } else { noOnline = true; note = "Not sent to the online AI: write the text with ✎ Edit."; }
        } else note = e && e.code === "consent" ? "Write the text with ✎ Edit (online AI declined)." : "The AI didn't answer: " + (e && e.message ? e.message : e);
      }
      if (out) {
        if (needClient && out.clientDescription) ed.vals.clientDescription = clean(out.clientDescription);
        if (needDesc && out.description) ed.vals.description = clean(out.description);
        if (needPre && out.preDescription) ed.vals.preDescription = clean(out.preDescription);
      } else if (!note) note = "The AI's answer couldn't be read: try Suggest again or ✎ Edit.";
    }
    ed.busy = false;
    const left = counted(F.check(afterOf(t, ed), { pre: true }).problems);
    ed.msg = (ed.movedNote && !note ? "The note written in File was moved to Description. " : "") + (note || (left.length ? "After this fix it would still be: " + left.map((p) => F.PROBLEM_LABEL[p].toLowerCase()).join(", ") + ". Use ✎ Edit to fill it in." : "Check the After column, change anything with ✎ Edit, then Apply."));
    ed.tone = note ? "err" : "";
    paint();
    return true;
  }

  async function apply(id, quiet) {
    const t = byId(id), ed = eds.get(id);
    if (!t || !ed || ed.busy || ed.before == null) return false;
    const set = changesOf(t, ed);
    if (!Object.keys(set).length && t.format) { ed.msg = "Nothing to change."; ed.tone = ""; paint(); return false; }
    if (set.File && F.fileState(set.File) === "bad") { ed.msg = "File must be links only, separated by commas."; ed.tone = "err"; ed.open = true; paint(); return false; }
    ed.busy = true; ed.msg = "Saving to ClickUp…"; ed.tone = "";
    if (!quiet) paint();
    // expected = the description the preview was made from: if it changed in
    // ClickUp since, nothing is written.
    const r = await ask({ type: "DESC_CHECK_SAVE", taskId: id, set, addFormat: t.format ? undefined : ed.addFormat, expected: ed.before }, 60000);
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
    for (const [k] of CATS) counts[k] = rows.filter((t) => inCat(t, k)).length;
    const clients = [...new Set(rows.map((t) => t.client).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const list = visible();
    const checked = CHECKS.filter((c) => on(c[0]) && (c[0] !== "fileStrict" || on("file"))).map((c) => c[1].replace(/, separated by commas$/, "")).join(", ");
    const head = '<div class="ip-head"><h2>Descriptions</h2><span class="sp"></span><span class="ip-meta">' +
      (loading ? "Refreshing…" : "Updated " + ago(at)) + " · " + rows.length + " open tasks checked</span>" +
      '<button type="button" class="ip-btn" id="dcChecks" aria-expanded="' + checksOpen + '">Checks ' + (checksOpen ? "▴" : "▾") + "</button></div>" +
      (checksOpen ? '<div class="dc-checks"><div class="dc-msg">Switch off what your team doesn\'t use. A task is flagged only for the checks that are on.</div>' +
        CHECKS.map((c) => '<label><input type="checkbox" data-check="' + c[0] + '"' + (on(c[0]) ? " checked" : "") + (c[0] === "fileStrict" && !on("file") ? " disabled" : "") + "> " + esc(c[1]) + (c[2] ? ' <span class="dc-msg">(' + esc(c[2]) + ")</span>" : "") + "</label>").join("") +
        '<div class="dc-msg">Not formatted (none of the fields) is always checked.</div></div>' : "") +
      '<p class="ip-sub">Checks the fields in each task\'s description: <b>' + esc(checked || "none") + "</b>. " + (on("file") && on("fileStrict") ? 'File must hold only links, separated by commas: <code>File: "abc.com,ab.com"</code>. ' : "") + 'Old format has Client Description, the new format doesn\'t. Open a task (▸) to see its description <b>Now</b> and <b>After fix</b>: the fix reads only that task\'s own comments and the AI writes only the empty fields. Change anything with ✎ Edit, then Apply, or tick several and apply them together.</p>' +
      (error ? '<p class="dc-msg err">' + esc(error) + "</p>" : "");
    const chips = '<div class="dc-chips" role="tablist">' + CATS.filter(([k]) => catOn(k)).map(([k, label]) =>
      '<button type="button" data-cat="' + k + '" class="' + (k === cat ? "on" : "") + '">' + esc(label) + "<b>" + counts[k] + "</b></button>").join("") + "</div>";
    const tools = '<div class="dc-tools"><input type="search" id="dcSearch" placeholder="Search task or client" value="' + esc(query) + '">' +
      '<select id="dcClient"><option value="">All clients</option>' + clients.map((c) => '<option value="' + esc(c) + '"' + (c === client ? " selected" : "") + ">" + esc(c) + "</option>").join("") + "</select></div>";
    const sel = list.filter((t) => picked.has(t.id));
    const selAll = (rows || []).filter((t) => picked.has(t.id));
    const ready = selAll.filter((t) => isReady(t, eds.get(t.id))).length;
    const allOn = list.length > 0 && sel.length === list.length;
    const bar = list.length && cat !== "good" ? '<div class="dc-bulk">' +
      '<label><input type="checkbox" id="dcAll"' + (allOn ? " checked" : "") + (bulk ? " disabled" : "") + "> Select all " + list.length + "</label>" +
      '<span class="dc-msg">' + selAll.length + " selected" + (selAll.length ? " · " + ready + " ready" : "") + "</span>" +
      '<button type="button" class="ip-btn" id="dcPrep"' + (bulk || !selAll.length ? " disabled" : "") + ">✨ Prepare fixes</button>" +
      '<button type="button" class="ip-btn dc-btn-primary" id="dcApplySel"' + (bulk || !ready ? " disabled" : "") + ">Apply selected (" + ready + ")</button>" +
      (bulk ? '<span class="dc-msg">' + (bulk.what === "apply" ? "Applying " : "Preparing ") + Math.min(bulk.done + 1, bulk.total) + " of " + bulk.total + "…</span>" +
        '<button type="button" class="ip-btn" id="dcStop">Stop</button>' : "") +
      (bulkMsg && !bulk ? '<span class="dc-msg">' + esc(bulkMsg) + "</span>" : "") +
      "</div>" : bulkMsg ? '<p class="dc-msg">' + esc(bulkMsg) + "</p>" : "";
    const body = list.length
      ? list.slice(0, shown).map(rowHtml).join("") + (list.length > shown ? '<div style="margin-top:10px"><button type="button" class="ip-btn" id="dcMore">Show 30 more (' + (list.length - shown) + " left)</button></div>" : "")
      : '<p class="dc-msg">' + (cat === "good" ? "No task has all its fields filled in yet." : "Nothing here: every task in this view has its fields filled in.") + "</p>";
    // Keep the search box's focus and caret, and a textarea's, across the repaint.
    const a = document.activeElement;
    const keep = a && host.contains(a) && (a.id === "dcSearch" || a.matches("textarea[data-k]")) ? { id: a.id, k: a.getAttribute("data-k"), ed: a.closest(".dc-ed") && a.closest(".dc-ed").getAttribute("data-ed"), pos: a.selectionStart } : null;
    host.innerHTML = head + chips + tools + bar + '<div class="ip-card">' + body + "</div>";
    if (keep) {
      const el = keep.id === "dcSearch" ? host.querySelector("#dcSearch") : host.querySelector('.dc-ed[data-ed="' + CSS.escape(keep.ed || "") + '"] textarea[data-k="' + keep.k + '"]');
      if (el) { el.focus(); try { el.setSelectionRange(keep.pos, keep.pos); } catch (e) {} }
    }
    wire();
  }

  function rowHtml(t) {
    const ed = eds.get(t.id);
    const chips = probs(t).length
      ? probs(t).map((p) => '<span class="chip ' + (TONE[p] || "warn") + '">' + esc(F.PROBLEM_LABEL[p]) + "</span>").join(" ")
      : '<span class="chip good">All good</span>';
    const fmt = t.format ? '<span class="chip mut" title="' + (t.format === 1 ? "Has a Client Description line" : "No Client Description line") + '">' + FMT_NAME[t.format] + "</span>" : "";
    const note = notes.get(t.id);
    const ready = isReady(t, ed);
    const isOpen = ed && ed.open;
    return '<div class="dc-row" data-id="' + esc(t.id) + '"><div class="dc-line">' +
      '<input type="checkbox" data-pick="' + esc(t.id) + '"' + (picked.has(t.id) ? " checked" : "") + (bulk ? " disabled" : "") + ' title="Select for Prepare fixes / Apply selected">' +
      '<button type="button" class="dc-tw" data-open="' + esc(t.id) + '" title="' + (isOpen ? "Hide" : "Show the description now and after the fix") + '">' + (isOpen ? "▾" : "▸") + "</button>" +
      '<span class="dc-name"><a href="' + esc(t.url) + '" target="_blank" rel="noopener">' + esc(t.name) + "</a>" +
      (t.client ? ' <span class="dc-client">· ' + esc(t.client) + "</span>" : "") + "</span>" +
      fmt + chips +
      (ed && ed.busy ? ' <span class="dc-msg">' + esc(ed.msg) + "</span>" : ready ? ' <span class="chip good">Fix ready</span>' : "") +
      (note ? ' <span class="dc-msg ' + (/^Applied/.test(note) ? "good" : "err") + '">' + esc(note) + "</span>" : "") +
      (ready ? ' <button type="button" class="ip-btn dc-btn-primary" data-apply="' + esc(t.id) + '"' + (bulk ? " disabled" : "") + ">Apply</button>" : "") +
      "</div>" + (isOpen ? editorHtml(t, ed) : "") + "</div>";
  }

  function editorHtml(t, ed) {
    let h = '<div class="dc-ed" data-ed="' + esc(t.id) + '">';
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
      const d = diffLines(ed.before, afterOf(t, ed));
      h += '<div class="dc-cmp"><div class="dc-col"><h4>Now</h4>' + docHtml(d.left, "(the description is empty)") + "</div>" +
        '<div class="dc-col"><h4>After fix</h4>' + docHtml(d.right, "(empty)") + "</div></div>";
    }
    if (ed.links.length) {
      h += '<div class="dc-links"><b>Links in this task\'s comments</b> <span class="dc-msg">tick the ones that belong in File</span>' + ed.links.map((u, i) =>
        '<label><input type="checkbox" data-link="' + i + '"' + (ed.pick.includes(u) ? " checked" : "") + "> " + esc(u) + "</label>").join("") + "</div>";
    } else h += '<div class="dc-msg" style="margin-top:8px">No links in this task\'s comments.</div>';
    if (ed.editing) {
      for (const label of fieldsFor(t, ed)) {
        const k = KEY[label];
        const missing = !String(ed.vals[k] || "").trim() || (label === "File" && F.fileState(fileOf(ed.vals[k])) !== "ok");
        h += "<label>" + esc(label) + ' <span class="hint">- ' + esc(HINT[label]) + "</span></label>" +
          '<textarea data-k="' + k + '" rows="' + (label === "File" ? 2 : 3) + '" class="' + (missing ? "miss" : "") + '">' + esc(ed.vals[k] || "") + "</textarea>";
      }
    }
    const ready = isReady(t, ed);
    h += '<div class="dc-acts">' +
      '<button type="button" class="ip-btn dc-btn-primary" data-apply="' + esc(t.id) + '"' + (ed.busy || !ready || bulk ? " disabled" : "") + ">Apply this fix</button>" +
      '<button type="button" class="ip-btn" data-edit="' + esc(t.id) + '"' + (ed.busy ? " disabled" : "") + ">" + (ed.editing ? "Done editing" : "✎ Edit") + "</button>" +
      '<button type="button" class="ip-btn" data-again="' + esc(t.id) + '"' + (ed.busy || bulk ? " disabled" : "") + ">✨ Suggest again</button>" +
      '<span class="dc-msg' + (ed.tone ? " " + ed.tone : "") + '">' + esc(ed.busy ? ed.msg : ready ? ed.msg : ed.msg || "Nothing would change.") + "</span></div></div>";
    return h;
  }

  function wire() {
    host.querySelectorAll("[data-cat]").forEach((b) => { b.onclick = () => { cat = b.getAttribute("data-cat"); shown = 30; paint(); }; });
    const s = host.querySelector("#dcSearch");
    if (s) s.oninput = () => { query = s.value; shown = 30; paint(); };
    const c = host.querySelector("#dcClient");
    if (c) c.onchange = () => { client = c.value; shown = 30; paint(); };
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
    host.querySelectorAll("[data-open]").forEach((b) => {
      b.onclick = () => {
        const id = b.getAttribute("data-open");
        let ed = eds.get(id);
        if (ed && ed.open) { ed.open = false; paint(); return; }
        if (!ed) { prepare(id).then(() => {}); ed = eds.get(id); }
        if (ed) { ed.open = true; notes.delete(id); paint(); }
      };
    });
    host.querySelectorAll("[data-apply]").forEach((b) => { b.onclick = () => apply(b.getAttribute("data-apply")); });
    host.querySelectorAll("[data-again]").forEach((b) => { b.onclick = () => prepare(b.getAttribute("data-again"), true); });
    host.querySelectorAll("[data-edit]").forEach((b) => { b.onclick = () => { const ed = eds.get(b.getAttribute("data-edit")); if (ed) { ed.editing = !ed.editing; paint(); } }; });
    host.querySelectorAll(".dc-ed").forEach((el) => {
      const id = el.getAttribute("data-ed");
      const ed = eds.get(id);
      if (!ed) return;
      // What is typed is kept as it is typed; the After column follows it.
      el.querySelectorAll("textarea[data-k]").forEach((ta) => {
        ta.oninput = () => {
          ed.vals[ta.getAttribute("data-k")] = ta.value; ed.edited = true;
          if (ta.getAttribute("data-k") === "file") ed.pick = ed.links.filter((u) => F.linksIn(ta.value).includes(u));
          clearTimeout(ed._t); ed._t = setTimeout(paint, 250);
        };
      });
      el.querySelectorAll('input[type="radio"]').forEach((r) => { r.onchange = () => { ed.addFormat = Number(r.value) === 1 ? 1 : 2; rememberFormat(ed.addFormat); if (ed.addFormat === 1 && !String(ed.vals.clientDescription || "").trim()) prepare(id, false); else paint(); }; });
      el.querySelectorAll("input[data-link]").forEach((cb) => {
        cb.onchange = () => {
          const u = ed.links[Number(cb.getAttribute("data-link"))];
          ed.pick = cb.checked ? ed.pick.concat(u) : ed.pick.filter((x) => x !== u);
          // The ticked links are the File value; links typed by hand stay.
          const typed = F.linksIn(ed.vals.file || "").filter((x) => !ed.links.includes(x));
          ed.vals.file = F.fileValue(typed.concat(ed.pick));
          ed.edited = true;
          paint();
        };
      });
    });
  }

  window.PcmDescCheck = {
    render(el) {
      host = el;
      if (!rows && !hydrated) {
        // The last result first (a few ms), then a fresh read if it's old.
        hydrated = true;
        paint();
        chrome.storage.local.get("descCheckLast").then((g) => {
          const k = g && g.descCheckLast;
          if (!rows && k && Array.isArray(k.rows)) { rows = k.rows; at = Number(k.at) || 0; }
        }).catch(() => {}).then(() => {
          if (!rows || Date.now() - at > 3 * 60000) load(false);
          else paint();
        });
        return;
      }
      if (!rows && !loading) load(false);
      else if (rows && !loading && !bulk && Date.now() - at > 5 * 60000) load(false);
      paint();
    },
    refresh() { return load(true); },
  };
  // options.js may have drawn Insights before this file loaded (the tab opens
  // on Descriptions when it was the last one used): draw now.
  try {
    const box = document.getElementById("insDescView");
    if (box && typeof insSub !== "undefined" && insSub === "descriptions" && typeof renderInsights === "function") renderInsights();
  } catch (e) {}
})();
