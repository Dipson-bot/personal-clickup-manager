// Universal search (Ctrl+K / ⌘K, or the search button) for the options page and
// the popup / side panel. Finds:
//  - settings: every card title, label and setting line of the options page,
//    read from the page itself so the list never goes out of date. Picking one
//    opens that section and highlights the setting.
//  - tasks already loaded (today, this/next week, filters): opens them in ClickUp.
//  - a few actions (wrap-up, floating tracker, bulk edit, updates, diagnostics).
(() => {
  "use strict";
  const isOptions = !!document.querySelector('.panel[data-panel="dashboard"]');
  const TAB_NAMES = { dashboard: "Dashboard", clickup: "ClickUp setup", agent: "Agent Router", sites: "Site monitor", files: "Clients", reminders: "Reminders", hub: "Help & issues", bulk: "Bulk edit", admin: "Admin", general: "General" };
  const optUrl = (q, tab) => chrome.runtime.getURL("options.html") + (q ? "?find=" + encodeURIComponent(q) : "") + "#" + tab;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

  // ---------- settings index ----------
  function textOf(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll(".hint, select, option, button, input, textarea, svg").forEach((x) => x.remove());
    return c.textContent.replace(/\s+/g, " ").replace(/[:\-–]\s*$/, "").trim();
  }
  function buildSettings(doc, live) {
    const out = [];
    for (const panel of doc.querySelectorAll(".panel[data-panel]")) {
      const tab = panel.dataset.panel;
      if (tab === "dashboard") continue;
      if (live) {
        const nav = document.querySelector('#sideNav [data-tab="' + tab + '"]');
        if (nav && getComputedStyle(nav).display === "none") continue; // Admin / Agent Router hidden for this user
      } else if (tab === "admin") continue;
      const seen = new Set();
      // The section itself ("Agent Router", "Bulk edit") - ranked above its settings.
      out.push({ type: "setting", section: true, text: TAB_NAMES[tab] || tab, tab, where: "Section", el: null });
      for (const el of panel.querySelectorAll("h2, label, .set-line > span.grow, summary")) {
        const t = textOf(el);
        if (!t || t.length < 3 || t.length > 110 || seen.has(t.toLowerCase())) continue;
        seen.add(t.toLowerCase());
        const card = el.closest(".card");
        const cardTitle = card && card.querySelector("h2") ? textOf(card.querySelector("h2")) : "";
        out.push({ type: "setting", text: t, tab, where: TAB_NAMES[tab] + (cardTitle && cardTitle !== t ? " › " + cardTitle : ""), el: live ? el : null });
      }
    }
    return out;
  }
  let settingsIdx = null;
  async function settings() {
    if (settingsIdx) return settingsIdx;
    if (isOptions) settingsIdx = buildSettings(document, true);
    else {
      try {
        const html = await (await fetch(chrome.runtime.getURL("options.html"))).text();
        settingsIdx = buildSettings(new DOMParser().parseFromString(html, "text/html"), false);
      } catch (e) { settingsIdx = []; }
    }
    return settingsIdx;
  }

  // ---------- tasks index (what's already loaded; no ClickUp request) ----------
  async function taskIdx() {
    let st = null;
    try { st = (await chrome.storage.local.get("clickupState")).clickupState; } catch (e) {}
    const out = [];
    const seen = new Set();
    const add = (arr) => {
      for (const t of Array.isArray(arr) ? arr : []) {
        if (!t || !t.id || seen.has(String(t.id))) continue;
        seen.add(String(t.id));
        out.push({ type: "task", text: t.name || "(task)", client: t.client || "", due: t.dueDateMs || null, url: t.url || "https://app.clickup.com/t/" + encodeURIComponent(t.id) });
      }
    };
    if (st) for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) if (b) { add(b.tasks); add(b.deadlineTasks); add(b.trackedTasks); }
    return out;
  }

  // ---------- actions ----------
  const ACTIONS = [
    { text: "Open the end-of-day wrap-up", keys: "wrap up standup tomorrow move", run: () => chrome.tabs.create({ url: chrome.runtime.getURL("wrapup.html") }) },
    { text: "Float the tracker over all apps", keys: "floating tracker picture pip", run: () => chrome.runtime.sendMessage({ type: "FLOAT_TRACKER_OPEN" }, () => void chrome.runtime.lastError) },
    { text: "Bulk edit tasks (due dates, status, priority, estimate)", keys: "bulk edit change due dates many tasks", run: () => go("bulk") },
    { text: "Check for updates", keys: "update version install", run: () => chrome.tabs.create({ url: chrome.runtime.getURL("update.html") }) },
    { text: "Copy diagnostics for support", keys: "help diagnostics bug problem support", run: () => go("general", "helpCard") },
    { text: "Change keyboard shortcuts", keys: "shortcut keys hotkey", run: () => go("general", "shortcutsCard") },
  ].map((a) => ({ ...a, type: "action" }));

  // ---------- "How to" answers ----------
  // Plain questions ("I want to change the due dates of many tasks, where?") are
  // matched to these by meaning-ish word matching (below), no AI needed. The
  // optional "Ask AI" only ever PICKS one of these, so it can't invent features.
  // here: true = it's on the popup too (the popup just closes the search).
  const GUIDES = [
    { id: "bulk", title: "Change due dates (or status, priority, estimate) of many tasks at once", tab: "bulk", card: "Bulk edit tasks",
      keys: "multiple several all today tasks reschedule postpone move deadline status priority estimate missing dates batch",
      a: "Open Bulk edit, pick the tasks (search, or tick them), choose what to change - due date, status, priority or estimate - and apply it to all of them in one go. It can also fill in missing dates." },
    { id: "clientfiles", title: "Keep files and attachments organised by client", tab: "files", card: "Clients - files & notes",
      keys: "organize sort folder documents audit pdf screenshot upload store client name list drive copy",
      a: "Open Clients: every client (its ClickUp List name) has its own card. Add files there (audits, PDFs, screenshots). Each file has Open and Show in folder (saves a copy to Downloads › Personal ClickUp Manager › Clients › client), and ☁ Copy to Drive puts a client's files in My Drive › Personal ClickUp Manager › Clients." },
    { id: "clientnotes", title: "Write notes about a client", tab: "files", card: "Clients - files & notes",
      keys: "note memo remember client instructions told watch out",
      a: "Open Clients, open the client's card and write a note. You can paste screenshots, attach files and tick ⏰ Remind me at to get reminded. A task's details show its client's notes." },
    { id: "reminder", title: "Set a reminder", tab: "reminders", card: "Reminders", here: true,
      keys: "remind alarm later tomorrow repeat daily weekly weekday duplicate copy clone check in check out rigo office attendance cup kitchen edit pause sound",
      a: "Click ⏰ next to the bell (or use the Reminders tab), write what it's about, pick a time and optionally repeat it. A task's details also have ⏰ Remind me. In the Reminders tab each reminder has Edit, Pause, Duplicate and Delete, and the card lets you pick its sound. \"Check in? Rigo\" (8:10 AM), the cup reminder (2:00 PM) and \"Check out? Rigo\" (5:00 PM) on weekdays are there by default." },
    { id: "issue", title: "Report a problem or ask a question", tab: "hub", card: "Help & issues",
      keys: "problem bug error broken not working question support ask admin feedback idea",
      a: "Open Help & issues: search whether it's already reported (press Me too if so), otherwise post it with a screenshot. The admin replies there and you get notified." },
    { id: "start", title: "Start, stop or complete a task's timer", tab: "dashboard", here: true,
      keys: "timer track tracking start stop pause complete done finish clock",
      a: "In the task list, press ▶ to start (sets it in progress and starts the ClickUp timer), ⏸ to stop, ✓ to complete. Only one task runs at a time. An amber ▶ means more than one person is assigned." },
    { id: "extra", title: "Track time for a meeting or work that isn't a task", tab: "dashboard", here: true,
      keys: "meeting call extra custom other untracked misc",
      a: "In the Due today card, under Extra task, choose Custom or Meeting, type what it's for (optional) and press Start tracking." },
    { id: "explain", title: "Get an AI explanation of a task", tab: "dashboard", here: true,
      keys: "explain ai understand summarize summary chatgpt gemini claude",
      a: "Open the task's details (the ▸ at the start of its row) and press ✨ Explain this task, or Ask with to send it to ChatGPT, Gemini and others." },
    { id: "desc", title: "Edit a task's description or attach files to it", tab: "dashboard", here: true,
      keys: "description edit write attach file link details",
      a: "Open the task's details (▸) and press ✎ Edit description. 📎 uploads a file and puts its link where your cursor is." },
    { id: "estimate", title: "Change one task's time estimate", tab: "dashboard", here: true,
      keys: "estimate hours minutes time change edit",
      a: "Click the estimate in the task's row (the number after the /) and type the new one. For many tasks at once, use Bulk edit." },
    { id: "export", title: "Export tasks or make a client report", tab: "dashboard",
      keys: "export csv excel report download client report weekly work report plain language client ready sheet doc",
      a: "On the Dashboard, the Tasks card has Export. For a report you can send a client, filter the list (client, due this week, and so on), tick Client work report, pick the client and the AI, then choose a format (Markdown, CSV, Excel, Google Sheets or Docs). Done tasks are written as done, the rest as planned work; read it before sending." },
    { id: "filter", title: "Filter tasks by client, due next week and more", tab: "dashboard", here: true,
      keys: "filter client due next week this week show only hide",
      a: "Press Filter above the task list and tick what you want (client, due next week, and so on)." },
    { id: "sort", title: "Sort the task list by name, assignee, client, due date or time", tab: "dashboard", here: true,
      keys: "sort order arrange ascending descending column header client due date assignee count how many tasks",
      a: "Click a label above the task list (Task, Assignee, Client, Due, Time): once for A to Z / earliest / smallest first, again for the other way, a third time for the normal order. The number next to Task is how many tasks are in the list." },
    { id: "breakdown", title: "See which tasks make up the estimated or tracked time", tab: "dashboard", here: true,
      keys: "why tracked different estimate difference breakdown which tasks missing time explain numbers where did time go",
      a: "Click the Estimated or Tracked number on the Today card: it lists the tasks behind it and explains the difference (time on tasks not due in these dates, over the estimate, no estimate, nothing tracked yet)." },
    { id: "chartday", title: "See one day's tasks from the weekly chart", tab: "dashboard",
      keys: "chart bar graph day monday click tasks completed that day",
      a: "On the dashboard, click a day in the This week chart: the Tasks card below lists that day's tasks. Use Back to my filter to return." },
    { id: "calendar", title: "Calendar with Nepali dates, holidays and work-from-home days", tab: "dashboard", here: true,
      keys: "calendar nepali date bikram sambat bs holiday dashain tihar festival wfh work from home office leave month",
      a: "Click the date chip (dashboard: next to the status chips; popup and side panel: under the header). It shows the month in English and Nepali dates, company holidays (red), work-from-home days (blue) and how many tasks are due each day. Click a day to list its tasks. Use Today or pick a date at the top to jump to any day; days with your reminders show a ⏰." },
    { id: "notices", title: "Notices from the admin (maintenance, sudden holiday)", tab: "hub",
      keys: "notice announcement maintenance break sudden holiday office closed admin message banner post notice",
      a: "Admin notices pop up once and then show as a banner at the top of the dashboard, popup and side panel until their end time (click ✕ to hide one). All active notices are listed in Help & issues. Admins post and end them there." },
    { id: "target", title: "Change my daily target hours", tab: "clickup", card: "Tracking settings",
      keys: "target goal daily hours day",
      a: "ClickUp setup › Tracking settings › Daily target." },
    { id: "overest", title: "Get warned before a task goes over its estimate", tab: "clickup", card: "Tracking settings",
      keys: "warn alert estimate over exceeded almost up minutes before",
      a: "ClickUp setup › Tracking settings: turn on the running-task alert and set how many minutes before the estimate it warns you." },
    { id: "idle", title: "Remind me when no timer is running", tab: "clickup", card: "Tracking settings",
      keys: "idle forgot timer not tracking remind office hours",
      a: "ClickUp setup › Tracking settings › Remind me when no timer is running, with your office hours." },
    { id: "mute", title: "Mute notifications or change the volume", tab: "general", card: "Notifications and sound", here: true,
      keys: "mute silence quiet pause notifications sound volume loud do not disturb dnd focus meeting lunch",
      a: "Click the 🔔 bell at the top: pause for 30 min, 1 or 2 hours, until tomorrow morning or until a time you pick, turn everything off, or set the volume. Your own reminders still show while paused. More options: General › Notifications and sound." },
    { id: "float", title: "Keep a small timer on top of other apps", tab: "general", card: "Floating tracker", here: true, action: "float",
      keys: "float floating tracker picture pip always on top window",
      a: "Press Float in Tracking now (or use this result) to open the floating tracker. Its settings are in General › Floating tracker." },
    { id: "shortcuts", title: "Change keyboard shortcuts", tab: "general", card: "Keyboard shortcuts",
      keys: "shortcut keyboard hotkey keys",
      a: "General › Keyboard shortcuts." },
    { id: "backup", title: "Back up settings or move them to another computer", tab: "general", card: "Drive Sync",
      keys: "backup sync google drive restore another computer new laptop transfer",
      a: "General › Drive Sync keeps your settings in your Google Drive (sign in on the other computer too). Backup & restore saves or loads a file instead." },
    { id: "update", title: "Update the extension or turn on automatic updates", tab: "general", card: "Version and updates",
      keys: "update version upgrade automatic install new",
      a: "General › Version and updates: Check for updates, and set up automatic updates once." },
    { id: "rollback", title: "Go back to an older version", tab: "general", card: "Version and updates",
      keys: "older version rollback downgrade previous",
      a: "General › Version and updates › Other versions…, pick one and press Install this version. Your settings are kept." },
    { id: "ar", title: "Log in to Agent Router accounts automatically every day", tab: "agent", card: "Your accounts",
      keys: "agent router login account daily credit",
      a: "Open Agent Router, add your accounts, and it logs them in once a day by itself." },
    { id: "sites", title: "Check whether client websites are up", tab: "sites", card: "Client Site Uptime Monitor",
      keys: "website site uptime down monitor",
      a: "Open Site monitor and add the sites (Auto-detect finds your clients' sites)." },
    { id: "wrapup", title: "End-of-day wrap-up (plan tomorrow)", tab: "dashboard", action: "wrapup",
      keys: "wrap up end day tomorrow plan standup",
      a: "Opens the wrap-up: what you did today and what moves to tomorrow." },
    { id: "dept", title: "See a team's or department's tasks", tab: "clickup", card: "Department Creator",
      keys: "team department people others colleagues members",
      a: "ClickUp setup › Department Creator: make a department, then pick it in the task filter." },
    { id: "connect", title: "Connect ClickUp or change the workspace", tab: "clickup", card: "ClickUp connection",
      keys: "connect clickup token workspace sign login",
      a: "ClickUp setup › ClickUp connection." },
    { id: "theme", title: "Switch between light and dark mode", tab: "dashboard", here: true,
      keys: "theme dark light mode colour color",
      a: "Press the Light / Dark button at the top right." },
    { id: "diag", title: "Copy diagnostics for support", tab: "general", card: "Help & diagnostics",
      keys: "diagnostics debug log support",
      a: "General › Help & diagnostics › Copy diagnostics (no passwords or tokens are included)." },
  ].map((g) => ({ ...g, type: "guide", text: g.title }));

  // ---------- understanding plain sentences ----------
  const STOP = new Set(("i me my mine we our you your it its this that these those a an the to of for from in on at by with and or but so if " +
    "is are was were be been being am do does did done can could would should will shall may might must have has had want wanted wanna need " +
    "needs like how what where which when why who there here any some just only also about into out up over again then than too very really " +
    "please possible possibly extension app tool thing things way ways know dont don't doesnt doesn't not no yes able get got let use using " +
    "used inside within something anything someone option options feature features according").split(" "));
  const SYN = { organise: "organize", organize: "organize", sort: "organize", arrange: "organize", group: "organize", categorize: "organize", folder: "organize",
    attachment: "file", document: "file", doc: "file", pdf: "file", upload: "file", screenshot: "file", image: "file",
    edit: "change", update: "change", modify: "change", set: "change", move: "change", reschedule: "change", shift: "change", postpone: "change", adjust: "change",
    deadline: "due", date: "due", multiple: "many", several: "many", all: "many", bulk: "many", batch: "many", lot: "many", every: "many", each: "many",
    customer: "client", timer: "track", clock: "track", log: "track", call: "meeting", bug: "problem", issue: "problem", error: "problem", broken: "problem", crash: "problem",
    silence: "mute", quiet: "mute", volume: "sound", sync: "backup", restore: "backup", transfer: "backup", summarize: "explain", summary: "explain", understand: "explain",
    noise: "sound", sounds: "sound", alarm: "remind", reminder: "remind", memo: "note", warn: "alert", warning: "alert", notification: "notify", estimation: "estimate", colour: "color", website: "site" };
  function stem(w) {
    if (SYN[w]) return SYN[w];
    let s = w.replace(/'s$/, "");
    if (s.length >= 7) s = s.replace(/is(e|ed|es|ing)$/, "iz$1"); // organise -> organize (not "noise")
    if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
    else if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
    else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
    else if (s.length > 4 && /(s|x|ch|sh)es$/.test(s)) s = s.slice(0, -2);
    else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
    return SYN[s] || s;
  }
  const toks = (s) => String(s || "").toLowerCase().split(/[^a-z0-9']+/).filter((w) => w && !STOP.has(w)).map(stem).filter((w) => w.length > 1 && !STOP.has(w));
  function tokMap(parts) { // [[text, weight], ...] -> Map(token -> best weight)
    const m = new Map();
    for (const [txt, w] of parts) for (const t of toks(txt)) if ((m.get(t) || 0) < w) m.set(t, w);
    return m;
  }
  function tokHit(qt, map) {
    let best = map.get(qt) || 0;
    if (best < 3 && qt.length >= 5) for (const [t, w] of map) if (w > best && t.length >= 5 && (t.startsWith(qt) || qt.startsWith(t))) best = w;
    return best;
  }
  // 0..100: how many of the meaningful words match, and how strongly (title 3, keys 2, text 1).
  function nlScore(qts, map) {
    if (!qts.length) return 0;
    let sum = 0, hits = 0, strong = 0;
    for (const qt of qts) { const w = tokHit(qt, map); sum += w; if (w) hits++; if (w >= 2) strong++; }
    if (!strong || hits < Math.min(2, qts.length)) return 0;
    // Tie-break: the more specific answer (more of its title matched) wins.
    let title = 0, titleHit = 0;
    for (const [t, w] of map) if (w === 3) { title++; if (qts.includes(t)) titleHit++; }
    return Math.round((sum / (qts.length * 3)) * 60 + (hits / qts.length) * 40 + (title ? (titleHit / title) * 5 : 0));
  }
  const guideMap = (g) => g._m || (g._m = tokMap([[g.title, 3], [g.keys, 2], [g.a, 1]]));
  const itemMap = (x) => x._m || (x._m = tokMap([[x.text, 3], [x.where || "", 1], [x.keys || "", 2]]));

  function go(tab, cardId) {
    if (!isOptions) { chrome.tabs.create({ url: optUrl("", tab) }); window.close(); return; }
    location.hash = "#" + tab;
    if (cardId) setTimeout(() => flash(document.getElementById(cardId)), 80);
  }
  // Open a tab and point at a card by its title (from the popup: via ?find=).
  function goCard(tab, title) {
    if (!isOptions) { chrome.tabs.create({ url: optUrl(title || "", tab) }); window.close(); return; }
    location.hash = "#" + tab;
    if (!title) { window.scrollTo({ top: 0 }); return; }
    setTimeout(() => {
      const h = [...document.querySelectorAll('.panel[data-panel="' + tab + '"] h2')].find((x) => textOf(x) === title);
      flash(h ? h.closest(".card") || h : null);
    }, 80);
  }
  function flash(el) {
    if (!el) return;
    const target = el.closest(".set-line, .checkbox, .card") || el;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("pcm-flash");
    setTimeout(() => target.classList.remove("pcm-flash"), 1700);
    const input = target.querySelector("input:not([type=hidden]), select, textarea");
    if (input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) {} }, 400);
  }

  // ---------- matching ----------
  // Forgiving on purpose: spaces and punctuation don't matter ("agentrouter" =
  // "Agent Router"), small typos are fine ("agnet"), and letters in order match
  // ("agrt"). Exact and early matches still rank first.
  const compact = (s) => norm(s).replace(/[^a-z0-9]+/g, "");
  function typoOk(a, b) {
    // Levenshtein distance within 1 (2 for longer words), with an early exit.
    const max = a.length >= 7 ? 2 : 1;
    if (Math.abs(a.length - b.length) > max) return false;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return false;
      prev = cur;
    }
    return prev[b.length] <= max;
  }
  // Letters of q in order inside h, close together (an abbreviation like "blkedt"),
  // not scattered across unrelated words.
  function inOrder(q, h) {
    for (let s = h.indexOf(q[0]); s >= 0; s = h.indexOf(q[0], s + 1)) {
      let i = 1, j = s + 1;
      for (; j < h.length && i < q.length; j++) if (h[j] === q[i]) i++;
      if (i === q.length && j - s <= q.length * 2 + 1) return true;
    }
    return false;
  }
  function score(hay, q) {
    if (!q) return 0;
    const h = norm(hay);
    if (h.startsWith(q)) return 100;
    const i = h.indexOf(q);
    if (i >= 0) return 85 - Math.min(35, i);
    const cq = compact(q), ch = compact(hay);
    if (!cq) return 0;
    const ci = ch.indexOf(cq);
    if (ci >= 0) return 75 - Math.min(30, ci);
    const qw = q.split(/[^a-z0-9]+/).filter(Boolean);
    const hw = h.split(/[^a-z0-9]+/).filter(Boolean);
    if (qw.every((w) => h.includes(w))) return 55;
    // Every typed word close to (or the start of) some word: small typos.
    if (qw.every((w) => hw.some((x) => x.startsWith(w) || (w.length >= 4 && (typoOk(w, x) || typoOk(w, x.slice(0, w.length))))))) return 45;
    // A typo in a run-together query: compare against the joined words too.
    if (cq.length >= 5 && hw.length > 1) {
      for (let a = 0; a < hw.length - 1; a++) if (typoOk(cq, hw[a] + hw[a + 1])) return 42;
    }
    if (cq.length >= 3 && inOrder(cq, ch)) return 25;
    return 0;
  }

  // ---------- UI ----------
  const css = document.createElement("style");
  css.textContent = `
    .pcs-back { position: fixed; inset: 0; z-index: 3000; background: rgba(0,0,0,.35); display: flex; justify-content: center; align-items: flex-start; padding-top: 10vh; }
    .pcs-box { width: min(600px, calc(100vw - 24px)); background: var(--card); color: var(--text); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 18px 40px rgba(0,0,0,.3); overflow: hidden; }
    .pcs-in { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .pcs-in input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 15px; padding: 4px 2px; }
    .pcs-in kbd { font: 11px ui-monospace, monospace; color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 5px; }
    .pcs-res { max-height: min(60vh, 440px); overflow: auto; padding: 4px 0 6px; }
    .pcs-grp { padding: 8px 14px 3px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .pcs-it { display: flex; align-items: baseline; gap: 10px; padding: 7px 14px; cursor: pointer; font-size: 13.5px; }
    .pcs-it .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pcs-it .w { flex: none; font-size: 11.5px; color: var(--muted); max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pcs-it.on { background: var(--bg2, rgba(99,102,241,.12)); }
    .pcs-empty { padding: 16px 14px; color: var(--muted); font-size: 13px; }
    .pcs-btn, .sidenav .pcs-btn { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 13px; color: var(--muted); background: var(--bg2, transparent); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; cursor: pointer; margin-bottom: 8px; text-align: left; }
    .pcs-btn:hover, .sidenav .pcs-btn:hover { color: var(--text); border-color: var(--indigo, #6366f1); }
    .pcs-btn kbd, .sidenav .pcs-btn kbd { margin-left: auto; font: 11px ui-monospace, monospace; border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; }
    .pcs-icon { font-size: 13px; }
    .pcs-it.g { display: block; }
    .pcs-it.g .t { display: block; white-space: normal; font-weight: 600; }
    .pcs-a { font-size: 12.5px; color: var(--muted); line-height: 1.45; margin-top: 2px; white-space: normal; }
    .pcs-it.g:not(.on) .pcs-a { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .pcs-it.ai .t { color: var(--indigo, #6366f1); font-weight: 600; }
    .pcs-ai { margin: 6px 10px 4px; padding: 10px 12px; border: 1px solid var(--indigo, #6366f1); border-radius: 10px; font-size: 13.5px; line-height: 1.45; }
    .pcs-aig + .pcs-aig { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
    .pcs-sm { font-size: 12px; color: var(--muted); margin: 2px 0 4px; }
    .pcs-row { display: flex; gap: 8px; margin-top: 8px; }
    .pcs-b { font: inherit; font-size: 12.5px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; margin-top: 6px; }
    .pcs-b.pri { background: var(--indigo, #6366f1); border-color: var(--indigo, #6366f1); color: #fff; }
  `;
  document.head.appendChild(css);

  let back = null, input = null, resBox = null, items = [], sel = 0;
  async function open() {
    if (back) { input.focus(); return; }
    back = document.createElement("div");
    back.className = "pcs-back";
    back.innerHTML = '<div class="pcs-box" role="dialog" aria-label="Search"><div class="pcs-in"><span aria-hidden="true">🔍</span>' +
      '<input type="text" placeholder="Search, or ask: how do I change due dates of many tasks?" aria-label="Search" /><kbd>Esc</kbd></div><div class="pcs-res"></div></div>';
    document.body.appendChild(back);
    input = back.querySelector("input");
    resBox = back.querySelector(".pcs-res");
    back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
    input.addEventListener("input", () => { sel = 0; search(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paintSel(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(0, sel - 1); paintSel(); }
      else if (e.key === "Enter") { e.preventDefault(); if (items[sel]) pick(items[sel]); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    input.focus();
    search();
  }
  function close() { if (aiAbort) aiAbort.abort(); if (back) { back.remove(); back = null; } }
  async function search() {
    const q = norm(input.value);
    const [sets, tasks] = await Promise.all([settings(), taskIdx()]);
    if (!back) return;
    // A sentence ("I want to change the due dates of many tasks") is matched by its
    // meaningful words; a word or two by the forgiving matcher below.
    const qts = toks(q);
    const sentence = qts.length >= 2;
    const rank = (arr, key, max, mapOf, nlMin, minS = 1) => arr.map((x) => {
      let s = q ? Math.max(score(key(x), q), x.keys ? score(x.keys, q) - 10 : 0) : 0;
      if (sentence && mapOf) { const n = nlScore(qts, mapOf(x)); if (n >= nlMin) s = Math.max(s, n); }
      if (s > 0 && x.section) s += 15; // "Agent Router" the section before its settings
      return { x, s };
    })
      .filter((r) => !q || r.s >= minS).sort((a, b) => b.s - a.s).slice(0, max).map((r) => r.x);
    const guides = q ? rank(GUIDES, (x) => x.title, 3, guideMap, 35, 40) : []; // min 40: no loose letter matches on long titles
    const groups = q
      ? [["How to", guides], ["Settings", rank(sets, (x) => x.text + " " + x.where, 8, itemMap, 45)], ["Tasks", rank(tasks, (x) => x.text + " " + x.client, 8)], ["Actions", rank(ACTIONS, (x) => x.text, 4, itemMap, 45)]]
      : [["Actions", ACTIONS]];
    // Not it? Ask the AI (only when clicked).
    if (q.split(" ").length >= 3) groups.push([guides.length ? "Not it?" : "Ask", [{ type: "ai", text: "✨ Ask AI: “" + input.value.trim() + "”" }]]);
    items = [];
    let html = "";
    for (const [name, list] of groups) {
      if (!list.length) continue;
      html += '<div class="pcs-grp">' + name + "</div>";
      for (const it of list) {
        const idx = items.push(it) - 1;
        const where = it.type === "setting" ? it.where
          : it.type === "task" ? [it.client, it.due ? new Date(it.due).toLocaleDateString([], { month: "short", day: "numeric" }) : ""].filter(Boolean).join(" · ")
          : "";
        if (it.type === "guide") html += '<div class="pcs-it g" data-i="' + idx + '"><span class="t">' + esc(it.title) + '</span><div class="pcs-a">' + esc(it.a) + "</div></div>";
        else html += '<div class="pcs-it' + (it.type === "ai" ? " ai" : "") + '" data-i="' + idx + '"><span class="t">' + esc(it.text) + '</span><span class="w">' + esc(where) + "</span></div>";
      }
    }
    resBox.innerHTML = html || '<div class="pcs-empty">Nothing found for “' + esc(input.value) + "”.</div>";
    resBox.querySelectorAll(".pcs-it").forEach((el) => {
      el.onmousemove = () => { sel = Number(el.dataset.i); paintSel(); };
      el.onclick = () => pick(items[Number(el.dataset.i)]);
    });
    paintSel();
  }
  function paintSel() {
    if (!resBox) return;
    resBox.querySelectorAll(".pcs-it").forEach((el) => el.classList.toggle("on", Number(el.dataset.i) === sel));
    const on = resBox.querySelector(".pcs-it.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  }
  function pick(it) {
    if (it.type === "ai") { askAI(input.value.trim()); return; }
    if (it.type === "guide") {
      const act = it.action && ACTIONS.find((a) => (it.action === "float" ? /Float/ : /wrap-up/).test(a.text));
      close();
      if (act) { act.run(); return; }
      if (it.here && !isOptions) return; // it's right here in the popup
      goCard(it.tab, it.card);
      return;
    }
    close();
    if (it.type === "action") { it.run(); return; }
    if (it.type === "task") { chrome.tabs.create({ url: it.url }).catch(() => {}); return; }
    if (!isOptions) { chrome.tabs.create({ url: optUrl(it.section ? "" : it.text, it.tab) }); window.close(); return; }
    location.hash = "#" + it.tab;
    if (it.section) window.scrollTo({ top: 0 });
    else setTimeout(() => flash(it.el), 80);
  }

  // Opened from the popup with ?find=: highlight that setting once the page is ready.
  if (isOptions) {
    const find = new URLSearchParams(location.search).get("find");
    if (find) setTimeout(async () => {
      const hit = (await settings()).find((s) => s.text === find);
      if (hit) flash(hit.el);
      history.replaceState(null, "", location.pathname + location.hash);
    }, 600);
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
  });

  // Entry points: top of the options sidebar, and an icon in the popup header.
  const mac = /Mac/i.test(navigator.platform);
  if (isOptions) {
    const nav = document.getElementById("sideNav");
    if (nav) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pcs-btn";
      b.innerHTML = '<span class="pcs-icon" aria-hidden="true">🔍</span><span>Search</span><kbd>' + (mac ? "⌘K" : "Ctrl K") + "</kbd>";
      b.onclick = open;
      nav.prepend(b);
    }
  } else {
    const acts = document.querySelector(".header .header-actions");
    if (acts) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "themeBtn";
      b.title = "Search settings, tasks and actions (" + (mac ? "⌘K" : "Ctrl+K") + ")";
      b.setAttribute("aria-label", "Search");
      b.textContent = "🔍";
      b.onclick = open;
      acts.prepend(b);
    }
  }

  // ---------- "Ask AI" (only when clicked) ----------
  // Chrome's built-in AI if this computer runs it, else the free online AI (after
  // the same consent as "Explain this task"). It only gets the question and the
  // list of answer titles, and must reply with ids from that list.
  let aiAbort = null;
  async function askAI(question) {
    const box = document.createElement("div");
    box.className = "pcs-ai";
    resBox.prepend(box);
    const say = (html) => { box.innerHTML = html; };
    if (!window.PcmAI) { say("The AI helper isn't loaded on this page."); return; }
    let engine = "online";
    try { engine = await window.PcmAI.engine(); } catch (e) {}
    if (engine === "online" && !window.PcmAI.onlineAllowed()) {
      say('<b>Use the free online AI?</b><div class="pcs-sm">This computer can\'t run Chrome\'s built-in AI, so your question (only the question) is sent to Pollinations.ai, a free public AI.</div>' +
        '<div class="pcs-row"><button type="button" class="pcs-b pri" data-ok>Yes, ask it</button><button type="button" class="pcs-b" data-no>Cancel</button></div>');
      const ok = await new Promise((res) => { box.querySelector("[data-ok]").onclick = () => res(true); box.querySelector("[data-no]").onclick = () => res(false); });
      if (!ok) { box.remove(); input.focus(); return; }
      window.PcmAI.allowOnline();
    }
    say("✨ Thinking… <span class=\"pcs-sm\">(" + (engine === "builtin" ? "Chrome's built-in AI" : "free online AI") + ")</span>");
    if (aiAbort) aiAbort.abort();
    aiAbort = new AbortController();
    const stopT = setTimeout(() => aiAbort && aiAbort.abort(), 30000);
    const ids = GUIDES.map((g) => g.id);
    const system = "You match a user's question to the features of a Chrome extension for ClickUp time tracking. " +
      "Reply ONLY with JSON like {\"ids\":[\"id1\"]}: up to 2 ids from the list, best first. If nothing in the list fits, reply {\"ids\":[]}. Never invent ids.";
    const prompt = "Question: " + question.slice(0, 300) + "\n\nFeatures (id: what it does):\n" + GUIDES.map((g) => g.id + ": " + g.title).join("\n");
    let picked = [];
    try {
      const text = await window.PcmAI.generate(system, prompt, { signal: aiAbort.signal,
        schema: { type: "object", properties: { ids: { type: "array", maxItems: 2, items: { type: "string", enum: ids } } }, required: ["ids"] } });
      let got = [];
      try { const j = JSON.parse((String(text).match(/\{[\s\S]*\}/) || ["{}"])[0]); got = Array.isArray(j.ids) ? j.ids : []; } catch (e) {}
      if (!got.length) got = ids.filter((id) => new RegExp("\\b" + id + "\\b").test(String(text)));
      picked = [...new Set(got.map(String))].map((id) => GUIDES.find((g) => g.id === id)).filter(Boolean).slice(0, 2);
    } catch (e) {
      if (!back) return;
      say("The AI couldn't answer (" + esc((e && e.message) || e) + "). Try other words, or ask in Help &amp; issues.");
      return;
    } finally { clearTimeout(stopT); aiAbort = null; }
    if (!back) return;
    if (!picked.length) {
      say("<b>✨ Nothing in this extension does that yet.</b><div class=\"pcs-sm\">If you think it should, suggest it in Help &amp; issues.</div>" +
        '<div class="pcs-row"><button type="button" class="pcs-b pri" data-hub>Open Help &amp; issues</button></div>');
      box.querySelector("[data-hub]").onclick = () => pick(GUIDES.find((g) => g.id === "issue"));
      return;
    }
    say("<div class=\"pcs-sm\">✨ Best match</div>" + picked.map((g, i) =>
      '<div class="pcs-aig"><b>' + esc(g.title) + '</b><div class="pcs-a">' + esc(g.a) + '</div><button type="button" class="pcs-b pri" data-g="' + i + '">Go there</button></div>').join(""));
    box.querySelectorAll("[data-g]").forEach((b) => { b.onclick = () => pick(picked[Number(b.dataset.g)]); });
  }
  window.PcmSearch = { open };
})();
