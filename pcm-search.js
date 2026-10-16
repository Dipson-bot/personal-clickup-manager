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
  const TAB_NAMES = { dashboard: "Dashboard", insights: "Insights", clickup: "ClickUp setup", agent: "Agent Router", sites: "Site monitor", files: "Clients", reminders: "Reminders", hub: "Help & issues", bulk: "Bulk edit", admin: "Admin", general: "General" };
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

  // ---------- tasks index (what's already on this computer; no ClickUp request) ----------
  // Every task of yours, whatever its status or dates: the dashboard's lists, the
  // open tasks Insights keeps, and the ClickUp task index (IndexedDB
  // "pcm-taskindex", built once by Explore › Find or from here) - your own
  // assigned tasks from it, open or closed, dated or not, any list or department.
  let ixMemo = null; // { key, rows }
  function readTaskIndex(meta) {
    const key = meta ? [meta.count, meta.lastSync, meta.read].join("|") : "";
    if (ixMemo && ixMemo.key === key && key) return Promise.resolve(ixMemo.rows);
    return new Promise((resolve) => {
      let r;
      try { r = indexedDB.open("pcm-taskindex", 1); } catch (e) { resolve([]); return; }
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("tasks")) r.result.createObjectStore("tasks", { keyPath: "id" }); };
      r.onerror = () => resolve([]);
      r.onsuccess = () => {
        try {
          const q = r.result.transaction("tasks").objectStore("tasks").getAll();
          q.onsuccess = () => { ixMemo = { key, rows: q.result || [] }; resolve(ixMemo.rows); };
          q.onerror = () => resolve([]);
        } catch (e) { resolve([]); }
      };
    });
  }
  let ixMeta = null; // cuTaskIndex: { state, count, read, me, ... }
  async function taskIdx() {
    let g = {};
    try { g = await chrome.storage.local.get(["clickupState", "insOpenCache", "cuTaskIndex"]); } catch (e) {}
    const st = g.clickupState || null;
    ixMeta = g.cuTaskIndex || null;
    const out = [];
    const seen = new Set();
    const add = (arr, mine) => {
      for (const t of Array.isArray(arr) ? arr : []) {
        if (!t || !t.id || seen.has(String(t.id))) continue;
        if (mine && !mine(t)) continue;
        seen.add(String(t.id));
        out.push({ type: "task", id: String(t.id), text: t.name || "(task)", client: t.client || "", due: t.dueDateMs || null, status: t.status || "", done: !!t.done,
          url: t.url || "https://app.clickup.com/t/" + encodeURIComponent(t.id) });
      }
    };
    if (st) for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) if (b) { add(b.tasks); add(b.deadlineTasks); add(b.trackedTasks); }
    add(g.insOpenCache && g.insOpenCache.tasks);
    if (ixMeta && (ixMeta.state === "ready" || ixMeta.read > 0)) {
      const me = String(ixMeta.me || "");
      const rows = await readTaskIndex(ixMeta);
      // Yours: assigned to you. (The index holds every task you can see, anyone's.)
      add(rows, me ? (t) => Array.isArray(t.assignees) && t.assignees.some((a) => String(a && a.id) === me) : null);
    }
    return out;
  }
  // The index, kept fresh while searching (one "changed since" request at most
  // every 5 minutes - the background decides), or built on request.
  let ixAsked = 0;
  function freshenIndex(build) {
    if (!build && !(ixMeta && ixMeta.state === "ready")) return;
    if (!build && Date.now() - ixAsked < 5 * 60000) return;
    ixAsked = Date.now();
    try { chrome.runtime.sendMessage({ type: "CLICKUP_TASK_INDEX" }, () => void chrome.runtime.lastError); } catch (e) {}
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === "local" && ch.cuTaskIndex && back && input && input.value.trim()) { clearTimeout(ixRepaint); ixRepaint = setTimeout(search, 600); }
    });
  } catch (e) {}
  let ixRepaint = 0;
  // Best matches first (rank's order); among the top ones, open tasks before done
  // ones, so last month's finished copy doesn't hide the one you're on.
  function taskHits(list) {
    return list.slice(0, 10).map((x, i) => ({ x, i })).sort((a, b) => (a.x.done ? 1 : 0) - (b.x.done ? 1 : 0) || a.i - b.i).map((r) => r.x);
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
    { id: "loadtasks", title: "Why Bulk edit or Explore tasks shows nothing until I press a button", tab: "bulk", card: "Bulk edit tasks",
      keys: "bulk edit explore tasks empty nothing loads load tasks show tasks button filters api limit requests",
      a: "To save ClickUp's request allowance (shared by the whole office), Bulk edit and the Dashboard's Explore tasks read nothing until you ask. Choose the range, people, client and the rest, then press Load tasks (in Bulk edit and in Explore). Changing a filter waits for the button again; pressing it twice with the same choices reads the tasks again." },
    { id: "bulk", title: "Change due dates (or status, priority, estimate) of many tasks at once", tab: "bulk", card: "Bulk edit tasks",
      keys: "multiple several all today tasks reschedule postpone move deadline status priority estimate missing dates batch tag tagged label comment note reason why teammate someone else's others assignee owner admin workspace search find people person name",
      a: "Open Bulk edit, pick the tasks (search, or tick them), choose what to change - due date, status, priority or estimate - and apply it to all of them in one go. It can also fill in missing dates. The filters are off until you use them: \"Filter missing\" is unticked to start with, so a range lists every task in it, and you only narrow it to the tasks with no due date, no start date or no estimate when you tick it and say which. Pick \"By tag\" to load every open task carrying a tag, chosen from a list of all the tags in your ClickUp workspace (so the spelling always matches), tick only the ones you want, and give a reason (e.g. \"the client asked to push it a week\"): the same comment is then added to every task you change, and \"Select none\" clears the ticks. \"Whose tasks\" switches the whole card to a colleague: type part of a name (or an email) in the search box, click the person, and every range and the tag filter then list only their tasks, the confirmation says whose they are, and the comment starts with who made the change. It appears for workspace Owners and Admins (a plain member sees a note instead); if your own role is member-level, save a workspace Owner or Admin token in ClickUp setup to unlock it. If a colleague is not in the list at all, keep typing their name - the extension asks ClickUp who that is and offers them if any of their tasks name them; anyone they add stays in the list, so you can keep searching for other people afterwards. While it is asking, the box says \"Asking ClickUp for ...\" rather than claiming nobody matches, and a name that matches nobody still shows you the people who are there. The list is never emptied by a search or by a re-read: if ClickUp is slow, refuses the request or is still building the list, the names you already had are kept and a note beside the search box says so. The ↻ next to the search box re-reads the whole member list." },
    { id: "clientfiles", title: "Keep files and attachments organised by client", tab: "files", card: "Clients - files & notes",
      keys: "organize sort folder documents audit pdf screenshot upload store client name list drive copy preview thumbnail image picture view enlarge",
      a: "Open Clients: every client (its ClickUp List name) has its own card. Add files there (audits, PDFs, screenshots). Pictures show a thumbnail you can click to see them big over the page (with \"Open in a new tab\", and Esc or a click outside to close); other files keep their icon. Each file has Open and Show in folder (into the client's own folder when the ClickUp Tracker app is running - see Client folders at the top - otherwise a copy in Downloads › Personal ClickUp Manager › Clients › client), and ☁ Copy to Drive puts a client's files in My Drive › Personal ClickUp Manager › Clients." },
    { id: "createdby", title: "See who created (assigned) a task", tab: "dashboard", card: "Tasks",
      keys: "who assigned this task assigned by created by creator manager dev gave me task from arrow initials who column",
      a: "In the Who column, a circle followed by › is the person who created the task, then the people it's on - \"AP › DT\" means Aashraya Pokhrel created it and it's assigned to Dipson Thapa. Point at it for the full names. ClickUp only records who created a task, not who assigned it; usually that's the same person. Tasks you created yourself show just the assignees." },
    { id: "unassign", title: "Remove someone from a task (take a person off it)", tab: "dashboard", card: "Tasks",
      keys: "remove unassign assignee assigned person people teammate take off delete user who cross x avatar initials",
      a: "In a task list, click the coloured initials in the task's WHO column: a small list of everyone on the task opens. Press ✕ next to a person to take them off the task in ClickUp, the same as the ✕ in ClickUp itself. Taking yourself off asks first, because the task then leaves your list. Esc or a click elsewhere closes the list." },
    { id: "addtime", title: "Add time I forgot to track (a missed meeting or extra work)", tab: "dashboard", card: "Today",
      keys: "add time manually missed forgot track tracking meeting extra past earlier log time entry backfill retroactive afterwards hours minutes timesheet",
      a: "Under the Extra task's Start tracking button, press + Add missed time. Say what it was (Meeting by default), pick the day and the From and To times - the length is shown - and press Add to ClickUp. It is added as a time entry on your Extra task in ClickUp, the same as ClickUp's own Add time, and today's tracked total updates a moment later." },
    { id: "teamusers", title: "See who uses the extension, remove duplicates or notify someone (Admin)", tab: "admin", card: "Team hub",
      keys: "admin team hub users people version older duplicate twice same person reinstall remove delete notify message ping refresh who updated outdated notify all everyone bulk broadcast not updated role make admin user promote demote",
      a: "Admin › Team hub lists everyone who uses the extension, once per person (a reinstall or a second Chrome profile no longer shows them twice - the leftover rows sit behind an \"older copies\" note you can open and remove). Above the list, Notify everyone / Notify those not on the latest version / Choose people… send one message to many at once. Each row has ↻ to re-read that person's version, 🔔 Notify to send them a short message that pops up on their computer, and ✕ Remove. A copy reports its version when it is opened, at least once a day and right after it updates, so a just-updated person can show the old version for a little while. Removing and notifying need the latest Team hub script deployed in Apps Script." },
    { id: "nudge", title: "Remind a teammate about a task we share", tab: "dashboard", card: "Tasks",
      keys: "remind teammate colleague coworker nudge ping poke tell ask someone else assignee notify message bell follow up chase do this task",
      a: "Click the coloured initials in the task's WHO column, then 🔔 next to the person. Write a short message if you like and press Send reminder (Ctrl+Enter): if they use this extension too, a notice pops up on their computer within a few minutes and opens the task when clicked. If they don't, press Send as ClickUp comment - it is posted on the task assigned to them, so ClickUp notifies them. Reminders between teammates need the Team hub (Admin › Team hub) with its latest script." },
    { id: "notesend", title: "Send my note about a task to the other person on it", tab: "dashboard", here: true,
      keys: "send share note notes task teammate assignee colleague coworker co-assignee other person hand over pass on reminder bell screenshot file attachment image doesn't transfer hub 300 characters",
      a: "Write your note on the task first (the 📝 at the start of its row, or the Notes block in its details), then press 🔔 Send on that note and pick the person - only the people assigned to the task are offered. The note appears in their extension as a reminder from you, with a desktop notification and the task's name to open, and the chip on the note (🔔 their name) records who you sent it to. Two things to know: only the first 300 characters of the note travel (a longer note is cut, and the picker says so before you send), and screenshots or files attached to the note are never sent - they stay on your computer, because the Team hub carries text only. Nothing is posted in ClickUp and nobody else on the task sees it; the picker explains this too. If 🔔 Send isn't on the note, nobody else is assigned to that task yet." },
    { id: "fromteammates", title: "See the reminders teammates sent me", tab: "reminders", card: "From teammates", here: true,
      keys: "received incoming from teammate colleague coworker sent me reminder nudge inbox notification unread new dismiss clear list who asked me",
      a: "Reminders someone sent you from a task show up in two places: on the task itself, in a From teammates section under its notes, and all together in the Reminders tab under From teammates. Each one says who sent it, what they wrote, when, and the task it's about - click the task to open it in ClickUp. New ones are flagged and counted; reading the list clears the flags a moment later. ✕ takes one off the list, Clear all empties it, and neither affects the sender's copy. They are only delivered while your extension is running, so leave Chrome open to be sure of seeing them, and a reminder more than a week old is no longer collected." },
    { id: "tasksearch", title: "Search the tasks in my dashboard list", tab: "dashboard", card: "Tasks",
      keys: "search find task filter narrow look for name client status assignee box type magnifier lookup locate which task where is dashboard list table rate limit free offline",
      a: "The Tasks card has a Search these tasks box in its heading. Type any part of a task's name, its client, its status or the name of someone on it and the lists below narrow to the tasks that match - including the deadline and tracked sections. It only filters the tasks already on the page, so it never asks ClickUp for anything and costs none of your rate limit, and it answers as you type. If something is hidden, a line under the list says how many. Press Esc (or clear the box) for the full list again. Export gives you exactly what you can see, so a search narrows the export too. It is deliberately forgotten when you reload the page, so a box you left filled in can never hide tasks from you later." },
    { id: "donehistory", title: "See the tasks I completed recently (completed history)", tab: "dashboard", card: "Recently completed",
      keys: "completed done finished history recent past closed yesterday last week what did i do record log archive list how long took tracked estimate search clear forget rate limit",
      a: "On the Dashboard, open the Recently completed card (press ▸ Show). It lists the tasks that were finished - newest first - with the client, when it was done, the estimate and the time tracked, and the name opens the task in ClickUp. It fills itself from the refreshes the extension already makes, so a task counts as soon as it comes back completed, whether you pressed ✓ Complete here or closed it in ClickUp itself; it never makes a request of its own, so neither looking at it nor searching it spends any of your ClickUp rate limit. Its own search box narrows the saved list the same way. Up to 200 tasks are kept for 60 days, and Clear forgets them (nothing changes in ClickUp - the list just fills up again)." },
    { id: "addclient", title: "Add a client I'm not assigned to (Clients tab)", tab: "files", card: "Clients - files & notes",
      keys: "add client new client folder not assigned other client missing client search workspace clients add folder",
      a: "Clients tab: type in + Add a client… - it suggests every client in the workspace (or type any name) - and press Add. The client stays in your list with its own files and notes. ✕ next to it takes it off your list (files and notes are kept). All workspace clients shows every client for a quick look." },
    { id: "reports", title: "Keep a client's weekly or monthly reports (Reports folder)", tab: "files", card: "Clients - files & notes",
      keys: "report reports weekly monthly folder client report file pdf screenshot keep store save organise share send teammate remind report month week",
      a: "Clients › open the client › 📊 Reports › + New report. Pick Weekly (the week, in the calendar), Monthly (the month) or Other (a date), add a title, write the report or notes about it and attach the file or screenshots (📎 Attach, paste with Ctrl+V or drop them in). Tick ⏰ Remind me at for a reminder. Each report has ⏰ Remind me, Edit, ✕ and 🔔 Send to a teammate - it shows a notification about the report in their extension (the files stay on your computer). Reports are kept apart from the client's notes and backed up with them." },
    { id: "clientnotes", title: "Write notes about a client", tab: "files", card: "Clients - files & notes",
      keys: "note memo remember client instructions told watch out edit change correct fix typo rewrite update note inline screenshot preview image thumbnail attach add remove delete file link url clickable google doc sheet paste format formatting claude chatgpt markdown table checklist",
      a: "Open Clients, open the client's card and write a note. You can paste screenshots, attach files and tick ⏰ Remind me at to get reminded. Screenshots on a note show as thumbnails - click one to see it big (Esc or a click outside closes it, or open it in a new tab). A web address you paste into a note becomes a link you can click (a Google Doc, a Sheet, anything http or https) - here and in a task's details. To change a note, press Edit on it: the note becomes a text box right where it is, with Save and Cancel under it (Ctrl+Enter saves, Esc cancels), and what you type is kept if the list redraws while you are typing. While it is open you can also change its files - 📎 Attach, or paste with Ctrl+V, or drop files on the note to add more, and ✕ on a file to take it off. Nothing is written until you press Save, so Cancel puts the files back as they were. A task's details show its client's notes." },
    { id: "clientpin", title: "Pin the clients you work with most", tab: "files", card: "Clients - files & notes",
      keys: "pin pinned favourite favorite important top star priority order sort stick client",
      a: "Open Clients and press the 📌 on a client's row: it moves to the top of the list with a marked edge. Press it again to unpin. Pin several and the newest pin sits on top, the rest of the clients stay in their usual order underneath. Pins are saved with your settings, so they follow you to your other computers." },
    { id: "reminder", title: "Set a reminder", tab: "reminders", card: "Reminders", here: true,
      keys: "remind alarm later tomorrow repeat daily weekly weekday duplicate copy clone check in check out rigo office attendance cup kitchen edit pause sound",
      a: "Click ⏰ next to the bell (or use the Reminders tab), write what it's about, pick a time and optionally repeat it. A task's details also have ⏰ Remind me. In the Reminders tab each reminder has Edit, Pause, Duplicate and Delete, and the card lets you pick its sound. \"Check in? Rigo\" (8:10 AM), \"Return your cup to the kitchen\" (12:00 PM) and \"Check out? Rigo\" (5:00 PM) on weekdays are there by default." },
    { id: "remindertime", title: "Set the TIME on a reminder (the hour and minutes, not just the day)", tab: "reminders", card: "Reminders", here: true,
      keys: "reminder time hour minute hh mm am pm set time cant change time impossible to set time time picker clock popup side panel no cursor cant click time stuck on 9 am 09:00 only lets me pick the day",
      a: "Click the \"Remind me at\" box and the calendar opens with a time row along the bottom: an hour box, a minutes box, AM/PM, and one-tap 9:00 AM, 12:00 PM, 2:00 PM and 5:00 PM. Click the day you want first - it only moves the selection, nothing is saved yet - then set the time and press Set, which spells out what it will use (\"Set 16 Oct, 1:25 PM\"). Minutes go in fives; a time already set to something else (6:37 PM) is kept as it is. It works the same in the popup, the side panel and the options page, and on every other date-and-time box - how long a notice shows, a task's dates. Typing still works too if you prefer the keyboard." },
    { id: "pickeddays", title: "Set one reminder for several days (tick them in the calendar)", tab: "reminders", card: "Reminders", here: true,
      keys: "reminder several days multiple days pick days tick days checkbox ctrl click calendar dates 17 19 21 25 gatey nepali bs specific days custom days different days same time any month",
      a: "Open a new reminder and click its date box. In the calendar every day has a small tick box in its corner: tick the days you want (or Ctrl+click them) - any month, in AD or BS (Nepali) view - and the line under the month lists them. Set the time once and press \"Set 4 days, 3:05 PM\". The repeat menu switches to \"On picked days\" by itself, and the reminder goes off on each of those days at that time, then moves to Past after the last one. Click the date box again to tick or untick days. For the same days EVERY month (the 17th and 25th of each month), pick \"Every month on set dates\" instead." },
    { id: "repeatdates", title: "Repeat a reminder on set days of the month (the 17th, 19th, 21st, 25th)", tab: "reminders", card: "Reminders", here: true,
      keys: "repeat custom dates days of the month monthly twice a month several days 17th 19th 21st 25th specific dates pick days invoice payday 1st 15th every month on the not weekly not daily 31st february skipped",
      a: "In the repeat menu pick \"Every month on set dates\", and a month of days 1 to 31 appears under it - tap the ones you want (17, 19, 21, 25) and tap again to take one off. Under the days it reads back what you chose, \"Every month on the 17th, 19th, 21st and 25th.\", and your reminders list says \"17th, 19th, 21st and 25th of the month\" so you can see it at a glance. The time comes from the Remind me at box and is used on every one of those days. A month that has no such day is skipped, not moved: the 31st does nothing in February and goes off again on 31 March, and the card warns you when you pick a day past the 28th. Save won't let you leave the days empty, since that reminder could never go off. An admin sending a reminder to everyone can use it too - the days travel with it." },
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
    { id: "replaceaudit", title: "Replace a client's old audit with a new one", tab: "files", card: "Clients - files & notes",
      keys: "replace audit new month august september update file client files swap old audit keep both",
      a: "Clients › open the client › press Replace next to the old file and pick the new one. Or attach the new audit in any of the client's tasks (📎 Attach) and press Replace <old file> (or Keep both - the newest counts as current)." },
    { id: "copy-for-ai", title: "Get AI help on a task: check it's done, or how to do it (Claude Code, ChatGPT…)", tab: "dashboard", here: true,
      keys: "copy for ai verify check done fixed send claude code desktop cowork chatgpt opencode codex brief task folder files wait go audit slack wordpress where safe live site cache nocache prompt",
      a: "Open the task's details (▸) and press 📋 Copy for AI: everything about the task is copied with what to ask - is it already done (checked live, normally and with the cache bypassed), wait or go, hints from the comments, the audit (or to check Slack for a newer one), exactly where it's done, and the live-site safety rules. Paste it into Claude Code, ChatGPT or any AI. With the ClickUp Tracker app it's also saved, with the task's files, in the client's folder (tasks › <task>). Ask with ↗ opens the chosen AI with it." },
    { id: "remind-others", title: "Remind a teammate (or me and them) about a task", tab: "dashboard", here: true,
      keys: "remind teammate other person assignee colleague reminder for them us both send reminder someone else nudge",
      a: "In a task's details press ⏰ Remind me. Under For, keep Me ticked or not, and click the task's other assignees or add anyone with + person. When it goes off it reaches their extension (or, if they don't use it, a ClickUp comment assigned to them on that task). Now sends it straight away. Your Chrome has to be open at that time for it to go out." },
    { id: "week-drag", title: "Move tasks to another day (drag in This week by day)", tab: "dashboard", here: true,
      keys: "drag drop move reschedule task another day balance week due date monday friday several many group pick select ctrl tasks list bulk",
      a: "Drag a task onto a day in This week by day - from that card or from the Tasks list above: its due date moves there in ClickUp (same time of day; a start date that would come after it moves too). Pick several (from any day) with Ctrl+click, or hold Ctrl and drag a box over them; Esc or ✕ Clear unpicks. Then drag one of them to move them all. The Extra Task, configured tasks and multi-day tasks spread over days stay put. Wrong day? ↶ Undo next to \"Moved ✓\" (for a minute) puts them back." },
    { id: "task-family", title: "Is this task a subtask, a parent or on its own?", tab: "dashboard", here: true,
      keys: "subtask parent task independent child family which parent belongs to open parent siblings hierarchy",
      a: "A subtask shows its parent's name in small grey before its own name; a parent shows ▾ and how many of its subtasks are in your lists; a task on its own shows nothing extra. Open ▸ for the Family line: Subtask of … / Parent task with every subtask / Independent - Open here shows that task in the same place (← Back returns), ClickUp ↗ opens it there." },
    { id: "over-estimate", title: "Notice when a running task goes over its estimate", tab: "clickup",
      keys: "over estimate exceeded crossed went past time ran over notice alert remind every 15 minutes red pulse badge ! sound timer strip taskbar today share 2m 1h wrong small",
      a: "When the task you're tracking passes its estimate, the floating timer and the taskbar strip turn red and pulse with \"+12m over\", the toolbar icon shows a red \"!\", and a \"Still running - X over the estimate\" reminder (with the alarm sound) repeats every 15 minutes until you stop it, complete it or raise its estimate. ClickUp setup › \"Keep reminding me while it's over the estimate\" sets the minutes (0 = once). The strip's \"today\" share is what's left of the estimate over the working days from today to the due date - due today means all of it." },
    { id: "tab-group", title: "Open a week's (or day's, client's) tasks together in a tab group", tab: "dashboard", here: true,
      keys: "open tab group grouped tabs all tasks at once week day client open in clickup tabs together chrome group",
      a: "Press ⧉ Tab group on a week heading of the Tasks list, a day of This week by day, a client card, the Tasks list's \"Shown:\" line (whatever filter is on) or Explore tasks: every task in it opens in ClickUp as tabs in one Chrome tab group named after it (\"Week of Oct 5 - 9\", \"Tue Oct 13\", the client…). More than 15 tabs asks you to click once more; at most 60 open." },
    { id: "split-weeks", title: "See which week each task falls in (this month / a range)", tab: "dashboard", here: true,
      keys: "split by week weekly group weeks month range which week this month next month heading per week separate weekly breakdown",
      a: "Pick a Due choice that covers several weeks (This month, Next month, a range) in the Tasks card's ▾ Filter (Dashboard, popup or side panel): the list is split by week, each under \"Week of Oct 5 - 9\" with its number of tasks, estimate and tracked time; this week is highlighted and tasks with no date come last. Weeks follow ClickUp setup › A week runs, and the filter's \"Dates by\" (start date puts a task in the week it starts). Turn it off with \"Split by week\" in the filter menu." },
    { id: "est-guess", title: "Guess the estimates of tasks that have none (to reach 7h a day)", tab: "dashboard", here: true,
      keys: "guess estimate suggest estimate no est missing estimate 7h day target fill usual time similar tasks finished apply",
      a: "A task with no estimate shows a dashed ~45m? in front of no est (Tasks list and This week by day): the time your similar finished tasks took, else your usual for that client, else your usual time. A subtask of an estimated parent gets its share of the parent's estimate; a parent whose subtasks are listed gets none. Click a guess to keep it (45m ✎) and press Apply to ClickUp (the day's, Apply all, or on the Tasks card) to set it; click it again to drop it. Day headers and the Tasks list show the total with guesses." },
    { id: "week-apply", title: "Rearrange the week, then apply the due dates to ClickUp", tab: "dashboard", here: true,
      keys: "move tasks days week plan apply to clickup staged not applied discard balance 7h due date drag later apply all",
      a: "In This week by day, drag tasks between days as often as you like: they show ✎ not applied yet and each day's estimate updates, but ClickUp isn't changed. When a day looks right press its Apply to ClickUp, or Apply all at the top; Discard puts everything back. Dragging a task back to its day undoes the move, and the plan is kept after a reload." },
    { id: "reorder", title: "Arrange tasks in my own order (drag within a list)", tab: "dashboard", here: true,
      keys: "drag reorder arrange order move up down together keep next to custom order sort within day list rearrange position",
      a: "Grab a task anywhere except its buttons and its name link, and drop it on another task of the same list: it goes above or below it (a line shows where). Works in each day of This week by day (every day keeps its own order), the Tasks list (kept per view - Custom order turns on, and the popup follows) and Explore tasks. Subtasks stay under their parent. Dropping on a different day moves the due date instead. If a column sort (Who ▲, Due ▲ …) was on, it switches off so your order shows - click the column to sort again." },
    { id: "client-dropdown", title: "Show one client's tasks (or find any client)", tab: "dashboard", here: true,
      keys: "client dropdown pick client filter only one client several clients search client all clients workspace other clients",
      a: "On the Tasks card press ▾ Client: tick All, or one or more of your clients (every client you have open tasks for, any date). Type in its search box to find any other client in the workspace. The Tasks list shows your own tasks, so for a client you aren't on it says so - Explore tasks shows everyone's." },
    { id: "others-time", title: "A task someone else already tracked time on (handed over to you)", tab: "dashboard", here: true,
      keys: "handed over reassigned colleague teammate already tracked before me estimate left remaining others time tracking same task at the same time parallel two people",
      a: "The estimate is for the whole task, so time a teammate already tracked on it counts: start the timer and it goes on from there (15m of a 30m task shows 15m / 30m). Tracking now, the floating tracker and the taskbar app say \"15m tracked by others before you · 15m left\" (striped part of the bar). If someone is tracking the same task right now you get a notification and a red line (seen when your ClickUp role can list their time). Your own daily totals still count only your time." },
    { id: "three-months", title: "Plan three months (or any long stretch) at once", tab: "dashboard", here: true,
      keys: "3 months three months quarter plan quarterly next two months long range month headings",
      a: "In the Tasks card's ▾ Filter (or Explore's), tick Due › Custom date / range and pick the first and last day on the calendar (e.g. Oct 1 to Dec 31). With Split by week on, the list shows a heading per month with the weeks under it." },
    { id: "explore-filter", title: "Explore tasks: pick dates, status, priority (its own filter)", tab: "dashboard", here: true,
      keys: "explore tasks filter dates this month next month previous week custom range dates by start date status priority missing estimate incomplete deadline crossed teammate department load",
      a: "In Explore tasks press ▾ Filter: Due (today, this / next / previous week or month, or a custom date or range on the calendar), Dates by (due or start date), Due in the range only, Status and Priority (from the tasks loaded), and Refine (missing estimate, start or due date, incomplete, deadline crossed, start ≠ due). It is Explore's own - the Tasks card's filter, the popup and the badge don't change. Pick the Client and Department / People in the card and press Load tasks; once a list is shown, changing the filter updates it." },
    { id: "find-many", title: "Find many tasks at once by pasting their names (bulk search)", tab: "dashboard", here: true,
      keys: "find bulk search many tasks paste list names lines action items report client which done status clickup match explore filter export headings",
      a: "In Explore tasks, paste task names into Find these tasks - one per line, with or without bullets; headings like \"Technical\" are optional (a heading that is really a task's name is searched as a task). Press Load tasks: every task you can see in ClickUp is searched - any client, anyone's, open or closed - and the tasks found show as the list, like a filter, so ⤓ Export, ▸ details and the rest work on them. Client, people, the tick boxes and (with \"Only within the dates above\") the dates narrow it only when set. Above the rows, Your list shows each line ✅ done / 🔄 in progress / ⏳ to do / ❓ not found; \"close match\" means check it, Not this one? picks another task, and Copy table / Copy for report copy it. The first search reads all your ClickUp tasks once (a few minutes, shown as it goes); after that only changes are read. The list and results stay after Hide/Show or a reload; Clear filters clears them." },
    { id: "plan-shown", title: "Plan all the tasks I'm looking at with AI (any filter)", tab: "dashboard", here: true,
      keys: "plan with ai all tasks shown filter calendar day picked range month week client search copy everything at once ai order wait",
      a: "Press 🧭 Plan with AI at the top of the Tasks card (🧭 Plan in the popup): every task the list shows under the current filter - a day picked in the calendar, a range, a month, a client, Only me, your search - is copied with questions for any AI: the order, what can be done now or must wait, whether it fits the time, what to do together, the audit check and what to ask for. Related tasks come along." },
    { id: "day-plan", title: "Plan one day's tasks with AI", tab: "dashboard", here: true,
      keys: "plan day with ai order today monday which first fits the day schedule arrange",
      a: "In This week by day, press 🧭 Plan with AI on a day: its tasks (with subtasks, dependencies, comments, notes and each client's audit) are copied with questions - the order for the day, what must wait, whether it fits the day and what to move, what to do together. Paste it into any AI." },
    { id: "only-me", title: "Show only tasks assigned to just me (or only shared ones)", tab: "dashboard", here: true,
      keys: "only me alone solo single assignee shared others multi assignee co-assignee filter assigned to mine my own",
      a: "Tasks card › Filter › Assigned to: Only me shows the tasks you alone are assigned to; Shared with others shows the ones a teammate is on too. Untick both to see everything. This week by day has its own All · Only me · Shared switch, with totals for the tasks shown." },
    { id: "sort-columns", title: "Sort a task list by a column (and get my own order back)", tab: "dashboard", here: true,
      keys: "sort column heading client due time who task sort by client order lost my order arranged order back your order",
      a: "Click a heading above a task list (Task, Who, Client, Due, Time): that list only is sorted (click again for the other way, a third time for your order). ↺ Your order next to the headings puts it back at once. Your own arranged order (drag to reorder) is never changed by sorting, and a reload shows it again." },
    { id: "ai-proof", title: "Get the proof screenshot and closing comment for a task", tab: "dashboard", here: true,
      keys: "proof screenshot what to screenshot evidence closing comment close task comment copy for ai plan with ai how to prove done",
      a: "Use Copy for AI in the task's ▸ details (or Plan with AI for a day, a client or the Tasks list): the answer ends with Proof screenshot - the URL to open, where to look (the page, view-source and the text to find, DevTools, a tool such as Rich Results Test, or the dashboard screen) and what must be visible - and ClickUp comment, the short comment to post when you close the task." },
    { id: "related-tasks", title: "Why does the AI brief list related or finished tasks?", tab: "clickup",
      keys: "related tasks finished closed complete dependency parent sibling mentioned id q-8 answer client already answered waiting pending wrong brief ai copy plan",
      a: "Copy for AI, Ask with and Plan with AI add each task's related tasks, finished ones included - dependencies, task links, parent, siblings, and tasks it mentions or that share its ID (Q-8, AP-20…) - with their status and last comments, and an Answer line for questions, so the AI sees an answer already given in a closed task. ClickUp setup › AI briefs look up related tasks: on/off, how many per task, and your own ID patterns. Per client: Clients › 🔗 Related tasks: on/off." },
    { id: "client-plan", title: "Plan all of a client's tasks with AI (what first, what must wait)", tab: "dashboard", here: true,
      keys: "plan all tasks client order first priority wait dependency blocked access audit duplicate overlap which task first claude chatgpt copy",
      a: "Group the dashboard (or popup) by client - tick clients in the Client filter - and press 🧭 Plan with AI on a client's heading: all its tasks there (with subtasks, dependencies, comments, notes and the audit for each) are copied with questions: what to do first, GO or WAIT for each task and what for, where a task differs from the audit, duplicates, and what to ask for before starting. Paste into any AI. With the ClickUp Tracker app it's saved in the client's folder instead and a short prompt for Claude Code is copied (📋 Copy full plan for other AIs)." },
    { id: "client-folders", title: "Keep each client's files in their own folder", tab: "files",
      keys: "client folders folder location explorer finder open folder files saved where downloads change root documents",
      a: "Clients › Client folders (at the top): Change… picks the folder that holds your client folders (default Documents › Personal ClickUp Manager › Clients). A client's folder is found by its name, ignoring capitals and spaces, or made. Each client has 📂 Open folder and Use a different folder…, and 📂 In folder lists the files already there (Open, Show in folder) - the AI buttons read the documents in it, and + Add files saves into it, so nothing is kept twice. Show in folder and Copy for AI save into it too. Needs the ClickUp Tracker app (v0.3.4 or later) running." },
    { id: "desc", title: "Edit a task's description or attach files to it", tab: "dashboard", here: true,
      keys: "description edit write attach file link details",
      a: "Open the task's details (▸) and press ✎ Edit description. 📎 uploads a file and puts its link where your cursor is." },
    { id: "estimate", title: "Change one task's time estimate", tab: "dashboard", here: true,
      keys: "estimate hours minutes time change edit",
      a: "Click the estimate in the task's row (the number after the /) and type the new one. For many tasks at once, use Bulk edit." },
    { id: "duedate", title: "Change or clear a task's due date", tab: "dashboard", here: true,
      keys: "due date deadline change move clear remove no due date reschedule push calendar holiday festival busy day",
      a: "Click the due date in the task's row (or + due if it has none). The extension's own calendar opens, so you can see the Nepali date, company holidays, work-from-home days, your reminders and how many tasks are already due on each day before you choose. Click a day to set it, or use Today, Tomorrow or No due date; Esc leaves the date as it was. The time of day on the task is kept, and it saves to ClickUp straight away." },
    { id: "complete-empty", title: "Why am I asked before completing a task?", tab: "clickup",
      keys: "complete done warning ask nothing to show description file comment completion note evidence turn off confirm",
      a: "When a task has no filled Description: \"…\" or File: \"…\" in its description and no comment, Complete (or the timer's Done) asks first, so work isn't closed without a note or a file. Press OK to complete it anyway, or Cancel and add one. Turn it off in ClickUp setup: untick \"Ask before completing a task with nothing to show for it\" (the taskbar timer follows it)." },
    { id: "copy-text", title: "Copy a task's description, a comment or a note", tab: "dashboard",
      keys: "copy clipboard description comment note my notes paste text formatting duplicate",
      a: "Open the task's details (▶). The description has ⧉ Copy next to Edit description, every comment has ⧉ Copy on its name line, and each of My notes has ⧉ Copy next to Remind me. It keeps the formatting when you paste into Docs, Slack or an email." },
    { id: "day-off-due", title: "Tasks due on a weekend or a holiday", tab: "clickup",
      keys: "due date weekend saturday sunday holiday day off dashain tihar move due date reminder needs tidying non working day",
      a: "The daily needs-tidying reminder lists your open tasks due on a weekend (the days outside your working week, set in A week runs) or on a company holiday from the team calendar, today or in the next 30 days, so you can ask your senior to move the date (or move it yourself) before the work is missed. Turn it on or off in ClickUp setup with the daily summary's \"due on a day off\" tick box." },
    { id: "time-entries", title: "Fix or delete time I tracked by mistake", tab: "dashboard",
      keys: "time entry entries tracked wrong mistake forgot to stop edit delete remove change duration start end fix time",
      a: "Click the task's tracked time in any list (or open its details ▶ and click Time tracked): your entries on the task are listed. Edit changes the day, start and end time or the note; ✕ deletes one. Fill in \"Why?\" to post the change and your reason as a comment on the task. Your totals update right after." },
    { id: "extra-dates", title: "My Extra Task has the wrong dates", tab: "dashboard",
      keys: "extra task dates wrong monday friday fix dates recurring repeat week start due",
      a: "When your Extra Task isn't Monday to Friday of one week, a notice offers Fix dates and the dashboard's Extra task line shows ⚠ Fix dates - one click sets Monday to Friday of the week it's due. Its repeat rule in ClickUp should be: every 1 week on Friday, on status change Complete, Sync recurrence to due date." },
    { id: "holiday-heads-up", title: "Heads-up before an office holiday", tab: "clickup",
      keys: "holiday heads up reminder before dashain tihar office closed tasks due move dates notice",
      a: "From 2 PM on the last working day before an office holiday, a notice lists your tasks due while the office is closed so you can move them in time (or says nothing is due). Turn it off in ClickUp setup: Heads-up the working day before an office holiday." },
    { id: "export", title: "Export tasks or make a client report", tab: "dashboard",
      keys: "client workbook rows tasks sheet department on-page technical development category preview columns week by week weekly blocks formatted wrap work file choose pick select untick exclude leave out skip some tasks checkbox export csv excel report download client report weekly work report plain language client ready sheet doc link links link 1 link columns empty columns useless columns five columns plain export task info",
      a: "For rows to paste into the client workbook (Date, Task, Task Info, Category, Assignee, Status, Work File, Task Description, Due Date, Priority - week by week), filter the list (client, this month…), open Export, tick Client workbook rows, untick the departments you don't want (e.g. keep only Technical; remembered per client), check the preview and choose Google Sheets or Excel - every sheet export comes out in Lexend, wrapped, with a blue header (white bold text) and clickable links. Each week's label is on its first row with a blank row between weeks; a subtask's row shows its task in Task and itself in Task Info. Untick Client work report so the built-in AI isn't used. With nothing ticked at all you get the team's sheet: Date (Range), Task, Task Info, Category, Status and Work File, week by week. Work File holds Description: \"...\" and File: \"...\" - the task's own File: text, or your latest comment on the task when that is empty, so the proof screenshots you left in a comment end up there. Links stay clickable in Excel, Google Sheets and Drive. To leave some tasks out, open Export: each task in the list gets a tick box before its ▶ - untick the ones to leave out (All / None in the menu); their subtasks go with them, and they stay unticked next time. On the Dashboard, the Tasks card has Export. For a report you can send a client, filter the list (client, due this week, and so on), tick Client work report, pick the client and the AI, then choose a format (Markdown, CSV, Excel, Google Sheets or Docs). Done tasks are written as done, the rest as planned work; read it before sending." },
    { id: "filter", title: "Filter tasks by client, due next week and more", tab: "dashboard", here: true,
      keys: "filter client due next week this week previous week this month next month previous month last month start date both custom range show only hide",
      a: "Press Filter above the task list and tick what you want. Due: nothing ticked shows today; or This week, Next week, Previous week, This month, Next month, Previous month or a Custom range. Dates by picks which date counts - the due date, the start date, or both. Ranges are only loaded from ClickUp when you tick them." },
    { id: "sort", title: "Sort the task list by name, assignee, client, due date or time", tab: "dashboard", here: true,
      keys: "sort order arrange ascending descending column header client due date assignee count how many tasks",
      a: "Click a label above the task list (Task, Assignee, Client, Due, Time): once for A to Z / earliest / smallest first, again for the other way, a third time for the normal order. The number next to Task is how many tasks are in the list." },
    { id: "breakdown", title: "See which tasks make up the estimated or tracked time", tab: "dashboard", here: true,
      keys: "why tracked different estimate difference breakdown which tasks missing time explain numbers where did time go",
      a: "Click the Estimated or Tracked number on the Today card: it lists the tasks behind it and explains the difference (time on tasks not due in these dates, over the estimate, no estimate, nothing tracked yet)." },
    { id: "trktoday", title: "See how much of the tracked time is from today", tab: "dashboard", here: true,
      keys: "today tracked today only cumulative all time how much tracked today bar chip share of bar daily total earlier days per task task row pill tracking now floating tracker float pip window bar colour color lighter band multiple days several days extra task recurring task confusing total",
      a: "When your filter reaches further than today (This week, a month, a custom range, or Deadline crossed, which counts all the time ever tracked on those tasks), the Tracked Time bar says how much of that total is from today: a small \"31m today\" chip sits next to the label, and the light part at the start of the bar is today's share. The darker part is the rest of the filter. On Due today there is no chip, because that bar is already today only. Each task says the same thing on its own: a task you have worked on across more than one day shows a \"31m today\" pill beside its tracked total - in \"Tracking now\", on the task row and in the floating tracker, on the Options page, in the popup and in the side panel - so the bigger figure is plainly everything ever tracked on that task rather than today's. The floating tracker's own bar shows it too: the lighter band at the start of the fill is today's share of that task's tracked time, and pointing at it says it in words (\"Today 1h 2m of 6h 50m on this task\"). A task you started and finished today has nothing to tell apart, so it gets no pill and no band." },
    { id: "chartday", title: "See one day's tasks from the weekly chart", tab: "dashboard",
      keys: "chart bar graph day monday click tasks completed that day",
      a: "On the dashboard, click a day in the This week chart: the Tasks card below lists that day's tasks. Use Back to my filter to return." },
    { id: "departments", title: "Pick a department (team) of people", tab: "clickup", card: "Departments",
      keys: "department departments team teams group groups dev offpage onpage technical clickup teams pick people explore filter",
      a: "Departments are your workspace's Teams from ClickUp (ClickUp › Settings › Teams) - pick one in Explore tasks, Bulk edit or the Admin pickers to get everyone in it. They're read from ClickUp every few hours; change a team in ClickUp itself. You can still make your own in ClickUp setup › Departments (choosing a ClickUp team there and saving makes your own copy)." },
    { id: "latefinished", title: "See the tasks I finished after their deadline", tab: "insights", card: "Health",
      keys: "deadline missed late finished after due date not met overdue finished late tasks still open done late",
      a: "Insights › Health › Deadlines missed lists both kinds, marked: \"open · 5d over\" = still not done and past its due date; \"done · 2d late\" = finished after its due date (last 4 weeks). The Extra Task never counts. The dashboard's Deadline crossed filter shows only the open ones - finished tasks aren't in the task list." },
    { id: "unreadcomments", title: "See comments I haven't read (and @mentions)", tab: "insights", card: "Health",
      keys: "comments unread missed comment mention mentioned me @ reply teammate wrote why task moved transferred notification 💬",
      a: "Tasks with comments from others you haven't opened show 💬 N next to the name (red @ = someone mentioned you) - click it to read them in the task's details, which marks them read. Insights › Health › Comments you haven't read lists them all with Mark read, and a new comment that @mentions you pops up a notification. The extension checks your open tasks' comments a few at a time in the background." },
    { id: "blockedwhy", title: "Why is a task blocked / waiting?", tab: "insights", card: "Health",
      keys: "blocked waiting why reason held dependency teammate subtask schedule waiting on",
      a: "Insights › Health › Blocked / waiting labels each task: teammate (waiting on someone's subtask - whose, which, due when, late or not), subtasks (its own subtasks still open while it's overdue), schedule (subtasks due after it) or dependency (it waits on another task in ClickUp that is still open)." },
    { id: "insdue", title: "Narrow the Insights lists by due date (December / January work)", tab: "insights", card: "Health",
      keys: "due date filter insights health narrow lists overdue due today this week next week no due date by month december january dec jan order sort soonest first out of order wrong order jumbled not in order too many rows show all missing an estimate",
      a: "Insights › Health: the due date menu next to the client one narrows every list at once - Overdue, Due today, Due this week, Due next week, No due date, or By month, which offers only the months your tasks are actually in (December 2026, January 2027…) and how many fall in each. It works together with the client menu and the search box, and the sections you have open stay open. Every list is in due date order, soonest first, with undated tasks last. Clear puts all three back." },
    { id: "setstatus", title: "Change a task's status (roadblock, in progress, review...)", tab: "dashboard", here: true,
      keys: "status change roadblock blocked on hold review in progress to do set mark stuck halt stopped red",
      a: "Open the task's details (the ▸ at the start of its row) and click its status at the top - pick the new one from the list and it is saved in ClickUp. A task that is stopped (roadblock, blocked, on hold, waiting) shows a red ⛔ chip on its row. For many tasks at once use Bulk edit." },
    { id: "holidaydue", title: "Move tasks that are due on a holiday (Dashain, Tihar)", tab: "insights", to: 'details[data-drill="holiday"]',
      keys: "holiday dashain tihar festival leave due date move push shift next week office closed",
      a: "Insights > Health lists every open task of yours that is due on an office holiday (from the company calendar), each with the same weekday of the next working week - Oct 19 becomes Oct 26. Press Move to ... on a task to move just that one; nothing moves by itself. The calendar (the date at the top) shows how many tasks are due on each day, in any month." },
    { id: "simpleview", title: "Make the extension look simpler (less text and buttons)", tab: "general", to: "#simpleViewOn",
      keys: "simple view simpler clean less text clutter cluttered busy congested minimal intimidating hide hints plain easy",
      a: "Press the ≡ button at the top of the page (next to light / dark), or tick Simple view in General > Appearance. It hides the explanation text, summary lines, the setup and status strips and extra controls, and a task's details show only Details, Comments and My notes. Nothing is switched off - press it again for the full view. It is remembered on every page (dashboard, popup and side panel)." },
    { id: "navcounts", title: "What the red numbers in the sidebar mean (and how to clear them)", tab: "dashboard", to: "#sideNav",
      keys: "badge count number red sidebar new unseen unread notification missed down archived mention reply reminder agent router",
      a: "A red number on a section means something new happened there that you haven't looked at yet: a client site went down (Site monitor), a task was archived in ClickUp or someone @mentioned you (Insights), Agent Router accounts need you, the admin replied in Help & issues, or a reminder went off while you were away. Hover it to see what, click the section to go straight to it (highlighted). It clears once that section has been open for a couple of seconds." },
    { id: "archived", title: "A task disappeared from my list - was it archived? Who archived it?", tab: "insights", card: "Health",
      keys: "archived archive task disappeared gone missing vanished not showing who archived unarchive restore subtasks weekly production schedule hidden",
      a: "A task archived in ClickUp no longer shows in any list here, so the extension tells you: a notification (“📦 Archived in ClickUp: ...”, one per parent when its subtasks went with it) and the Insights › Health list Archived recently, with when it was archived and its parent. Who archived it isn't something ClickUp shares with other apps: click the task name, and in ClickUp open the Activity icon (the small zigzag line beside the comments) - the last lines say “[name] archived this task”. Unarchive (in the list, or at the top of the task in ClickUp) brings it back, subtasks and all, and it reappears in your lists on the next refresh." },
    { id: "dupetasks", title: "Is this the same task twice? (duplicate tasks)", tab: "insights", card: "Health",
      keys: "duplicate duplicates duplicated same task twice two copies copy repeated already did this did i do this have i seen this before same name twice two of the same not a duplicate dismiss ignore wasting time",
      a: "A task sitting in your lists twice for the same client shows a ⧉ Duplicate chip next to its name - amber when the copies are on different days (the one nobody spots), red when both are due the same day. Hover it for how many copies there are, when each is due and where each sits (on its own, or under which parent task); click it to open the other copy so you can close whichever you don't need. Insights › Health › Possible duplicates lists every group, and Not a duplicate dismisses one for good - for the work that genuinely carries the same name every week. Never flagged: the same name for two different clients, a task and its own subtask of that name, the same step under two different parent tasks (a \"Live & Schema Placement\" for each blog page is two pages' work), a finished task, a paused client, or the weekly Extra Task(s). The chip sits right after the task name, so the Who, Client and Due columns stay in line." },
    { id: "plansearch", title: "Find a task in my week's plan (search, client, show more)", tab: "insights/plan",
      keys: "plan search filter client too many tasks long list show more find task overdue no estimate many",
      a: "Insights › Plan: the search box and client menu at the top narrow every list on the page (the totals stay the whole week's). Long lists show 10 tasks at a time - press Show 10 more for the next ones. Apply all sets estimates only for the tasks shown. Clear brings everything back." },
    { id: "todaychips", title: "See today's tasks behind the \"today\" figure", tab: "dashboard", card: "Due today",
      keys: "today chip 11h today estimated today tracked today breakdown where did my time go today tasks click",
      a: "When the view covers more than today (this week, a custom range…), Estimated Time and Tracked Time show a small \"… today\" chip. Click it: the estimate one lists the tasks due today behind that number, the tracked one shows where today's time went, task by task." },
    { id: "plan", title: "Plan my week: reach my weekly target and order my tasks", tab: "insights/plan",
      keys: "review reviews dev developer incoming review task plan week planner weekly target 35 hours capacity estimate suggestion fill week day by day order dependencies what to do first schedule next week change edit time planned override my time adjust estimate expected review day refresh reload apply suggested estimate set estimate bulk apply all",
      a: "Insights › Plan: how full this or next week is against your target (working days × daily target, holidays left out), realistic estimates for tasks without one (from how long similar finished tasks took), tasks you could start early to fill the week, and a day-by-day order that puts dependencies and earlier audit steps first. Developers' dev tasks count as the short review that comes back to you (expected on their due day). Click any time (in the groups or in Day by day) to type your own, e.g. 45m or 1h 30m - the totals and days update, ↺ goes back to the automatic time. Under Tasks without an estimate, Apply (or Apply all) makes the suggested time the task's real estimate in ClickUp. ↻ Refresh (next to Health / Plan / Performance) re-reads your tasks. It changes nothing in ClickUp." },
    { id: "tasknotes", title: "Keep personal notes on a task, or pin it to the top", tab: "dashboard", here: true,
      keys: "note notes task personal private remember pin pinned top keep track screenshot attach memo reminder not clickup paste format formatting claude chatgpt grok markdown table checklist tick checkbox tickbox bold italic toolbar edit formatted remind me alarm later",
      a: "Point at a task row: 📌 pins it to the top of the list, 📝 opens its details at My notes - write, paste screenshots (Ctrl+V), attach or drop files, edit or delete. Click a ☐ in a note to tick it (no Edit needed); Edit shows the note formatted with a toolbar (B, I, lists, ☐ box) and a Markdown switch. ⏰ Remind me on a note sets a reminder about it, linked to the task. Notes and pins stay in this extension and are never sent to ClickUp; the note text is backed up with Drive sync, attached files stay on this computer." },
    { id: "findanytask", title: "Find any of my tasks by part of its name (done, undated, another department's)", tab: "dashboard", here: true,
      keys: "find search task name part of the name can't find cannot find lost task old task completed done closed no due date undated another department assigned to me ctrl k search box any status any date",
      a: "Press Ctrl+K and type any words from the task's name, in any order (\"gbp categories\", \"schema blog 7\"). The Tasks results cover every task assigned to you - to do, in progress or complete, with a due date or without one, in any list or department - and show its client, due date and status; Enter opens it in ClickUp. The first time, choose \"Search ALL your tasks\" at the bottom of the Tasks results: the extension reads your ClickUp tasks once (it says how far it has got and the results fill in as it goes), and after that it only picks up what changed." },
    { id: "asktasks", title: "Find tasks by asking in plain words (who, client, when, done or due)", tab: "dashboard", here: true,
      keys: "find search tasks completed last month previous week client person user teammate colleague someone else upcoming week due done finished show me what did yesterday last friday next tuesday since overdue quarter weekend recently",
      a: "Press Ctrl+K and type a sentence such as \"tasks I completed last month for Acme Dental\" or \"Sam's tasks due next week for Bright Roofing\". The first result says what it understood; press Enter to list the tasks (with estimate and tracked time). Remove a chip (✕) to widen it. Someone else's tasks need a workspace Admin token in ClickUp setup." },
    { id: "formatcomment", title: "Paste an AI answer into a comment or note and keep its formatting", tab: "dashboard", here: true,
      keys: "comment comments format formatting paste claude chatgpt grok ai answer bold list checklist heading markdown clickup comment rich text keep formatting note client note",
      a: "Every note box (task notes, client notes, draft tasks) and the comment box in a task's ▸ details write formatted, with a small toolbar (B, I, lists, ☐ box) and a Markdown switch. Paste from Claude, ChatGPT or Grok and the headings, bold, lists, checkboxes, code and links stay. Comments are posted to ClickUp formatted too, so they look the same there; comments already on a task are shown formatted. The floating tracker's comment box keeps pasted formatting as well." },
    { id: "newtask", title: "Create a new task (a draft first, then Apply to ClickUp)", tab: "dashboard", here: true,
      keys: "create new task add task make task draft local offline plan later apply to clickup list where it goes write task new item",
      a: "Press ＋ New task just above the task list (dashboard, popup or side panel). Give it a name, pick the client (type to find it - your clients come first, and any other client in the workspace comes up as you type), the assignees (type a name to add people - you're there to begin with, ✕ removes anyone), a start and a due date (the extension's calendar), estimate, priority and a description. To make it a subtask, search one of your open tasks under \"Make it a subtask of…\" - it then goes to that task's client. It's kept as a Draft in this extension - with ▸ details, notes and pins like any task - and goes to ClickUp when you press Apply to ClickUp, or by itself at the day and time you set under \"Send to ClickUp\" (the row shows ⏰ and the time; you get a notification). Its notes, pin and reminders move to the real task. Drafts don't count in your totals." },
    { id: "multiday", title: "Count multi-day tasks by due date, or spread over the days", tab: "dashboard", here: true,
      keys: "multi day multiday spread split divide estimate across days start due date span extended this week due today whole week weekend saturday sunday by due date different numbers cards disagree",
      a: "On the This week card, Multi-day tasks: By due date (default) counts a task's whole estimate on its due date; Spread over days divides a task with a start and a due date over the working days it covers, also before it's due. The same choice applies to Due today, This week and the date filters, so they agree. ClickUp setup › Advanced has the same setting, plus spreading over only the days you tracked time. The week runs Sunday to Saturday, so weekend due dates count too." },
    { id: "applyplan", title: "Show one day of my plan in my task list", tab: "insights/plan",
      keys: "apply plan day tuesday task list filter order today plan show planned tasks back to my filter",
      a: "Insights › Plan › Day by day: press Apply to my task list on a day. The dashboard, popup and side panel show exactly that day's tasks in the plan's order; Back to my filter (in the bar above the list) returns. Nothing changes in ClickUp." },
    { id: "themes", title: "Change the theme or colours (light, dark, palettes)", tab: "dashboard", here: true,
      keys: "theme dark light mode colour color palette ocean forest rose lavender slate midnight pine plum mocha appearance",
      a: "Click the moon / sun button at the top: switch light or dark and pick a palette for each (Ocean, Forest, Rose, Lavender, Slate; Midnight, Pine, Plum, Mocha). The popup, side panel and dashboard follow." },
    { id: "reviewperiod", title: "My rating for a 6-month or 1-year performance review", tab: "insights/performance", card: "Your rating",
      keys: "performance review 6 months six months 1 year one year 12 months annual half yearly rating period appraisal evaluation not available yet dropdown",
      a: "Insights \u203a Performance \u203a Your rating has a Period menu: This week, This month, Last 12 weeks, Last 6 months and Last 12 months. Picking 6 or 12 months reads that much of your history from ClickUp once (kept for a day) and rates the whole period the same way - time tracked, deadlines met, estimates held - with By client for that period too. If you have not been working here that long yet (your tracked time starts less than 6 or 12 months ago), it says \"Not available yet\" with the date your history starts, and opens once you have. The charts below always show the last 12 weeks." },
    { id: "performance", title: "See my performance: 7-hour days, deadlines met, workload", tab: "insights/performance",
      keys: "performance analytics stats graph chart deadlines met late on time 7 hours per day target days tracked per week workload overloaded estimate accuracy time by client history refresh reload update",
      a: "Insights › Performance (only you see it): a rating out of 100 in rings at the top - This week, This month or All (the 12 weeks kept) - from time tracked against your working days, deadlines met and estimates held, with a ring per client (click one for its tasks). Below: days you reached your daily target, average per day, deadlines met, how long tasks take against their estimates, tasks finished per week, workload ahead (overloaded over 110%), and where your time went per client - over the last 12 weeks. Click any number, bar or day to see the tasks and hours behind it." },
    { id: "insights", title: "See overdue, unestimated, blocked and upcoming work (Insights)", tab: "insights",
      keys: "insights overview health overdue missing estimate no due date blocked waiting subtasks dependency workload outlook by client problem clients analytics performance filter by client narrow search a list clickable number drill down worth a look health strip jump from dashboard only one client add estimate set due date change due date fix here open task in clickup",
      a: "In the Insights lists, a task's name opens it in ClickUp, and the fix happens right there: \"Add estimate\" opens a small box (type 1h 30m, Enter), \"Set due date\" and \"Change due date\" open the calendar - the row then says it was saved and leaves the list. Open the Insights tab in Options: it shows how many of your tasks are overdue, due this week, missing an estimate or a due date, or blocked and waiting, plus a workload outlook for the coming weeks and a by-client table. Click any number to list the exact tasks behind it. In the By client table every count is a button: click a client's \"No est.\", Overdue or Blocked number and the list below opens showing only that client's tasks, and clicking the client name (or its Open count) narrows all four lists to them. Above the lists, a client picker and a search box let you pick a client and search within what's listed - task name, client and the reason a task is blocked are all searchable - and each heading says how much you're looking at, like \"Missing an estimate (30 of 55)\"; press Clear to see everything again. On the Dashboard the \"Worth a look\" counts are clickable too: press \"3 blocked\" or \"55 no estimate\" and you land in Insights with that list already open. Tasks blocked by their own open subtasks are flagged too, and the Dashboard shows a short health strip when you have overdue or blocked work." },
    { id: "extraclose", title: "Close the weekly Extra Task automatically on Friday", tab: "clickup", card: "Reminders",
      keys: "extra task close friday weekly recurring next week new extra task complete automatically end of week",
      a: "On by default: if your Extra Task is still open at 5 PM on its due day (Friday), it's marked complete so ClickUp creates next week's one (it waits while its timer runs). Switch it off in ClickUp setup with \"Close my weekly Extra Task at 5 PM…\"." },
    { id: "tidyreminder", title: "Get a daily reminder of overdue, unestimated or blocked tasks", tab: "clickup", card: "Reminders",
      keys: "tidy needs tidying daily reminder summary overdue unestimated no estimate no due date blocked dependency resolved remind 2pm nudge notify",
      a: "In Options > ClickUp setup > Reminders, tick \"Daily 'needs tidying' summary at\" and pick the time (2:00 PM by default), the days (weekdays by default) and which of the four lists to mention - overdue, no estimate, no due date, blocked. \"Name up to\" caps how many tasks each line lists, and you can also be told when a dependency was resolved so a blocked task can be finished. It sends one short summary a day that stays on screen until you click or close it; clicking opens Insights with the lists it mentions opened, stays quiet when there's nothing to tidy, and can be switched off from the bell menu too. Use Preview now to see it before it arrives." },
    { id: "calday", title: "I clicked a day in the calendar and my task list changed", tab: "dashboard", here: true,
      keys: "calendar click day date filter changed task list tasks of that day back to my filter undo remove filter where did my tasks go oct 13",
      a: "Clicking a day in the calendar lists that day's tasks: the extension takes you to the dashboard's task list (in the popup and side panel it scrolls to it), and a bar over the list says \"Showing Tue, Oct 13 (picked in the calendar)\". Press \u2715 Back to my filter on that bar to return to the filter you had before." },
    { id: "colwidth", title: "Make a task list column wider (Task, Time, Client, Who, Due)", tab: "dashboard", here: true,
      keys: "column width wider narrower resize drag cut off truncated hidden text task column name time column client column who due see whole text can not read cut",
      a: "Point at the column headings above a task list: a thin line shows at the edge of Who, Client and Due (their right edge) and of Time (its LEFT edge, because Time is the last column). The line between Task and Who sets the Task column: drag it right for a wider Task column, left for a narrower one. Drag it to make that column wider or narrower - drag Time's line to the left to widen it so nothing is cut off. Double-click a line to put that column back to its normal width. Widths are remembered, separately for the dashboard and for the popup and side panel." },
    { id: "rollup", title: "Why does a parent task show less time here than in ClickUp? (the ? next to its time)", tab: "dashboard", here: true,
      keys: "parent task subtasks estimate tracked different from clickup 2h 30m rollup adds up includes subtasks question mark ? why less double counted totals",
      a: "ClickUp adds a task's subtasks into its own estimate and tracked time: a 30m task with 1h and 30m subtasks reads 2h there. The extension lists those subtasks as rows of their own, so the parent counts only its own part (30m) - otherwise your day's estimate would count the subtasks twice. Click the ? next to the parent's time to see ClickUp's numbers, each subtask's share and this reasoning." },
    { id: "calendar", title: "Calendar with Nepali dates, holidays and work-from-home days", tab: "dashboard", here: true,
      keys: "calendar nepali date bikram sambat bs ad english month switch holiday dashain tihar festival ghatasthapana fulpati tika laxmi puja bhai tika kukur tihar janai purnima raksha bandhan wfh work from home office leave month due date deadline pick a date",
      a: "Click the date chip (dashboard: next to the status chips; popup and side panel: under the header). AD | BS under the month's name switches between English and Nepali months (remembered). Festival days (Ghatasthapana, Tika, Laxmi Puja, Bhai Tika…) are named on their day. It shows the month in English and Nepali dates, company holidays (red), work-from-home days (blue) and how many tasks are due each day. Click a day to list its tasks. Use Today or pick a date at the top to jump to any day; days with your reminders show a ⏰. The same calendar opens when you click a task's due date, so you can move a deadline onto a free day instead of guessing." },
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
    { id: "extraweek", title: "How much of my weekly Extra task time is used or left", tab: "dashboard", card: "Due today",
      keys: "extra task weekly 7 hours used left remaining over budget allowance how much tracked extra meeting time this week",
      a: "Under the Extra task in the Due today card (and in the popup) a line shows \"This week: 3h 12m of 7h used · 3h 48m left\" with a thin bar; it turns red with \"… over\" once you've tracked more than the Extra task's estimate this week. The daily share (7h ÷ 5 = 1h 24m) is what each day's numbers use." },
    { id: "inall", title: "Why a task shows 0m tracked although ClickUp shows time on it", tab: "dashboard", card: "Tasks",
      keys: "0m zero tracked wrong time missing tracked time clickup shows tomorrow filter in all total previous day sync",
      a: "A list counts only the time tracked on its own dates - in \"Next week\" a task you worked on today reads 0m, because nothing is tracked next week yet. When there's more on the task than that, the row adds \"… in all\" (the total tracked on any day, as ClickUp shows it); point at it for the explanation." },
    { id: "auto-update-app", title: "Updates install by themselves (no click) - how", tab: "general",
      keys: "automatic update auto update stuck update tab click to finish permission update didn't install taskbar app updates extension no click",
      a: "Keep the taskbar app (ClickUp Tracker 0.3.9 or later) running: it installs each new version of the extension itself - no browser permission, no click, no tab. Without it, the extension updates its own folder (General › Version and updates › set up once, pick Allow on every visit); if the browser ever needs a click, the update tab says Click to finish the update." },
    { id: "mac-damaged", title: "Mac says ClickUp Tracker is damaged and can't be opened", tab: "general",
      keys: "mac macbook damaged can't be opened move to trash taskbar app clickup tracker apple silicon m1 m2 m3 unidentified developer open anyway gatekeeper xattr",
      a: "The app isn't really damaged - macOS blocks apps that aren't from the App Store or a paid Apple developer. Press Cancel, open Terminal and run:  xattr -cr \"/Applications/ClickUp Tracker.app\"  - then open it again. Newer downloads (0.3.9 and later) ask instead whether to open an app from an unidentified developer: right-click it › Open, or System Settings › Privacy & Security › Open Anyway." },
    { id: "site-monitor-off", title: "Stop monitoring one client's website (or turn it back on)", tab: "sites", here: true,
      keys: "site monitor turn off one site stop checking site disable monitoring for a client untick site monitor tick enable disable site alerts one site",
      a: "Site monitor › Current status: each site has a Monitor tick. Untick it and that site isn't checked any more (no down / blank alerts); tick it again to start. It works whether or not the client is with us - a paused client's sites stop being checked on their own." },
    { id: "related-tasks", title: "See a task's related tasks (and what it waits on)", tab: "dashboard", here: true,
      keys: "related task linked task relationship dependency waiting on blocking blocked by open related task independent task",
      a: "Open the task's ▸ details: under its name you see its parent and subtasks, its Related (linked) tasks from ClickUp, and the tasks it is Waiting on or Blocking - each with its status, who it's on and when it's due. Open here shows that task in the same panel (← Back returns); ClickUp ↗ opens it in ClickUp. Copy for AI and Plan with AI include them too - their descriptions and comments (subtasks' comments as well), so a review task linked to the dev task gets the dev task's details." },
    { id: "full-task-name", title: "See a task's full name (and copy it)", tab: "dashboard", here: true,
      keys: "full task name long name cut off truncated hidden title copy task name copy title see whole name",
      a: "Open the task's ▸ details (the arrow at the start of its row): its full name is at the top, with ⧉ Copy next to it. Works in every list, the popup and the side panel. Pointing at the name in the row also shows it." },
    { id: "paused-clients", title: "A client stopped working with us: strike their tasks (and bring them back)", tab: "admin", card: "Paused clients",
      keys: "paused client discontinued client my paused clients resume for me pause for me settings stopped client on hold client left strikethrough cross out tasks resume client came back continue client",
      a: "Admin › Paused clients: type the client (suggestions come from the workspace), add a note if you like, and press Pause client. For everyone, that client's tasks are struck through with a ⏸ Paused pill in every list (dashboard, popup, side panel), and ▶ Start asks before tracking. Nothing changes in ClickUp. When they come back, press Resume and their tasks are normal again. Their sites stop being checked in Site monitor (no down / blank alerts), and they get no tidy-up reminders and leave Insights. Everyone can also do it just for themselves in General › Paused clients: Resume for me on a team client, Pause for me on any client, or click a ⏸ Paused pill on a task to show that client as usual again." },
    { id: "live-weather", title: "Task weather background (the timer as the weather), and solid or glassy cards", tab: "general", card: "Appearance",
      keys: "task weather cards solid glassy see-through opacity weather strength hard to read readability text contrast faint calmer weather background night moon stars ufo snow sun rain storm thunder volcano live weather scene theme animated background timer estimate sky switch off plain background video wallpaper live wallpaper moving gif mp4 webm",
      a: "The background follows the task you are tracking: snow when it starts, the sky clears and the sun comes out as you near its estimate, perfect weather on it, then clouds, rain, heavy rain and wind, a thunderstorm and at last a volcano erupting the further past the estimate it runs. No timer: a full moon night with stars (and a UFO now and then); starting a timer rolls clouds in and the snow begins, completing or stopping it clears back to the night. The forecast shows under the sidebar menu (and at the bottom of the popup / side panel). It is off by default (it is animated). Switch it on in the ☀ button at the top › Background: Task weather, Plain or Wallpaper - or in Options › General › Appearance, where Preview ▶ Play runs the whole cycle (❚❚ Pause to stop on a stage) or its slider shows any stage. Your wallpaper can be a picture, a moving GIF or a video (MP4 / WebM, plays muted on a loop). To keep the weather but stop it moving, untick Moving weather under Animations and effects. Text hard to read? Slide Cards toward solid (in the ☀ menu under Background, or Cards in Appearance - also for wallpapers), and lower Weather strength for a calmer scene." },
    { id: "appearance", title: "Change the colours, make my own palette or set a wallpaper", tab: "general", card: "Appearance",
      keys: "theme colour color palette custom own colors saved save look looks switch wallpaper theme my palettes background accent dark light wallpaper picture image photo background image dim blur see through transparent cards look appearance personalise",
      a: "Save the look you have on (light / dark, palettes and wallpaper together) with ＋ Save current look… in the ☀ menu at the top, then switch between your looks there in one click (up to 8). The Default tile goes back to plain (no wallpaper, Classic colours). The ☀ button at the top switches light / dark and picks a ready-made palette (Classic, Ocean, Forest, Rose, Lavender, Slate, Sand, Mint, Coral, Mono; dark: Classic, Midnight, Pine, Plum, Mocha, Graphite, Deep sea, Wine, Nord). For your own colours open Options › General › Appearance (or \"Custom colours & wallpaper…\" in the ☀ menu): pick a background, card and accent colour for light and for dark mode - the page changes as you pick, and text and borders are worked out to stay readable. Wallpaper: Choose a picture… (any size; it's shrunk to fit and kept only on this computer), then Fit (fill the screen or show the whole picture), Dim, Blur, See-through cards, and whether it also shows in the popup and side panel. Reset / Remove put things back." },
    { id: "float", title: "Keep a small timer on top of other apps", tab: "general", card: "Floating tracker", here: true, action: "float",
      keys: "float floating tracker picture pip always on top window today total hover point small view auto open automatic start task by itself taskbar hidden behind off screen dock slim strip one line small thin size",
      a: "It opens by itself as soon as a timer starts - in the dashboard or side panel right in your click, and from the toolbar popup, ClickUp or the keyboard shortcut through its small pinned Tracker tab, which the extension clicks for you in the background (Chrome shows a \"started debugging this browser\" bar for a moment then). If you close it, it stays closed until the next timer. Dragged partly behind the taskbar (or off the screen), it puts itself back in the visible corner of the screen. By default it is a Slim strip - one line (bar + time) that opens just above the taskbar; General › Floating tracker › Size switches it to Normal or Compact. General › Floating tracker › Strip style picks how the slim strip (and the taskbar timer) shows the task's time and today's total: batteries (default), Task | Today halves, two thin bars, two rings or edge lines; the colours go from light blue to green as you reach the estimate and to red past it, and the face moves with its mood; untick Animate the bars to keep them still. Switch either off in General › Floating tracker. You can also press Float in Tracking now. Small, it shows the task's bar, how it is going, and today's total (\"Today 26m/7h\") without pointing at it; point at it for the task name, a comment box and Stop. Its settings are in General › Floating tracker - including Show today's total and the compact size." },
    { id: "taskbar", title: "Put the timer in my Windows taskbar (or Mac menu bar)", tab: "general", card: "Floating tracker",
      keys: "taskbar task bar strip style battery rings bars animation animate moving bubbles extra task hover windows mac menu bar desktop app install download tracker app clickup tracker pin always visible strip start with computer both floating window turn off disable hide where the timer shows",
      a: "Press \"Get the taskbar timer\" (Dashboard card, or General › Floating tracker) and run the download once. Windows: open ClickUp-Tracker-Setup.exe - if Windows says it protected your PC, click More info › Run anyway. Mac: open the .dmg, drag ClickUp Tracker into Applications and open it (the first time: right-click › Open). It sits in the taskbar (Mac: the menu bar) as a slim strip with the task's time and today's total (look picked in General › Floating tracker › Strip style), Stop and Done; point at it for the task name and ⇄ Extra Task, starts with your computer and signs in by itself through the extension. General › Floating tracker › \"Where the timer shows\" picks Floating window, Taskbar, Both or Neither and is remembered; the app's own tray menu can hide it or stop it starting with the computer." },
    { id: "togglefloat", title: "Show or hide the floating timer with a shortcut", tab: "general", card: "Keyboard shortcuts",
      keys: "shortcut hide show toggle floating timer window alt shift 4 keyboard open close float",
      a: "Press Alt+Shift+4 (Mac: Control+Shift+4) - it opens the floating timer whether or not a task is running, and closes it if it's open. It reopens where you last had it. Change the keys in General › Keyboard shortcuts › Change shortcuts." },
    { id: "shortcuts", title: "Change keyboard shortcuts", tab: "general", card: "Keyboard shortcuts",
      keys: "shortcut keyboard hotkey keys",
      a: "General › Keyboard shortcuts." },
    { id: "backup", title: "Back up settings or move them to another computer", tab: "general", card: "Drive Sync",
      keys: "backup sync google drive restore another computer new laptop transfer",
      a: "General › Drive Sync keeps your settings in your Google Drive (sign in on the other computer too). Backup & restore saves or loads a file instead." },
    { id: "sitedownme", title: "A site shows as down only for me (it works for others)", tab: "sites", card: "Site monitor",
      keys: "site down only me just me false alarm works for others wordfence firewall blocked ip security plugin imunify sucuri cloudflare captcha bot check rate limit notification repeatedly frequent",
      a: "Site monitor fetches each site every few minutes, which a site's security (Wordfence, Imunify360, Sucuri, a firewall, Cloudflare or SiteGround's bot check) can mistake for a bot and block - for your computer only. With the blank-page check turned on for that site, the extension recognises the block page and shows a note like \"Wordfence blocked this computer (site is up - not an outage)\" instead of an alarm. If the firewall drops the connection without a page, it looks the same as an outage from your computer: ask whoever manages the site to allow your office's IP." },
    { id: "mention", title: "Mention someone in a comment (@name)", tab: "dashboard", card: "Tasks",
      keys: "mention at @ tag notify someone teammate comment name ping floating window task details exact name spelling suggestions list pick choose right person",
      a: "Type @ and the start of their name in a comment - in a task's details, a waiting comment, Bulk edit or the floating window - for example @sam. A list of the matching people (with their email) opens: ↑/↓ and Enter, Tab or a click puts in their full name, so you can be sure it's the right person. You don't need the exact name or spacing: it becomes a real ClickUp mention of the one person it can mean, so they get ClickUp's notification. In the floating window, typing @swa shows who it matches and Tab fills in the full name; after posting it says who was mentioned, or that a name matched no one or more than one person (then type more of it)." },
    { id: "defender", title: "Windows Defender says the download is a virus", tab: "general", card: "Version and updates",
      keys: "virus trojan defender antivirus windows security threat blocked quarantine fauppod malware unsafe flagged zip download warning false positive sha256 hash",
      a: "A newly published zip that nobody has downloaded before, and that isn't code-signed, is sometimes flagged by Windows Defender by guesswork - a name ending in !cl (like Trojan:Win32/Fauppod.A!cl) is a cloud guess, not a known virus. Check your file is the real one: in PowerShell run Get-FileHash on the zip with -Algorithm SHA256 and compare it with the SHA-256 printed at the bottom of that version on the GitHub Releases page. If they match, it is exactly what was published. Only download it from the Releases page, or let the extension update itself." },
    { id: "update", title: "Update the extension or turn on automatic updates", tab: "general", card: "Version and updates",
      keys: "update version upgrade automatic install new auto update not working background tab tab opens closes by itself notification notifications annoying update available pop up stop",
      a: "With automatic updates on (the default) you get no \"Update available\" pop-ups - it installs by itself; only a click Chrome needs to finish an install, or an Important update still not installed a day later, notifies you. General › Version and updates: Check for updates, and set up automatic updates once (choose the extension's folder, pick Allow on every visit). After that a new version installs by itself - if Chrome only allows it from a tab, a tab opens in the background (your own tab stays in front), installs, and closes by itself." },
    { id: "rollback", title: "Go back to an older version", tab: "general", card: "Version and updates",
      keys: "older version rollback downgrade previous",
      a: "General › Version and updates › Other versions…, pick one and press Install this version. Your settings are kept." },
    { id: "ar", title: "Log in to Agent Router accounts automatically every day", tab: "agent", card: "Your accounts",
      keys: "agent router login account daily credit retry retries stopped failed wrong password not logging in needs you next try tries again backoff flagged rejected",
      a: "Open Agent Router, add your accounts, and it logs them in once a day by itself. A login that fails is tried again later, waiting longer each time - an hour, then six, then a day, then three days at most - so repeated failed sign-ins cannot get the GitHub account flagged. The account says when the next try is due. When the saved sign-in itself is the problem (wrong password, a 2FA code GitHub will not accept, a missing or invalid TOTP secret) it stops trying on its own and says so, because no amount of retrying would help: fix the account in Manage and press Run, or log in yourself in the tab it left open and press \"I logged in\"." },
    { id: "arbatch", title: "When does the Agent Router \"batch is open\" notification come?", tab: "agent", card: "Notifications",
      keys: "agent router batch quota notification claude ready usable release window 7:45 4:45 beijing wrong time false fresh quota credit",
      a: "Only inside a release window: Agent Router hands out Claude and GPT in two batches a day (10:00 and 19:00 Beijing time, 7:45 AM and 4:45 PM in Nepal; the notice shows your own time). Quota credited at another hour - whenever the daily login ran - waits and is announced at the next batch, so the notification never says Claude is ready when it is not. Turn it off with \"Notify me when a new Agent Router Claude/GPT quota batch opens\"." },
    { id: "heldcomment", title: "Send a comment automatically when I complete a task", tab: "dashboard", card: "Tasks",
      keys: "comment later send when complete completed done remind forget unsent draft comment pending waiting queue schedule comment auto send mention finish task",
      a: "Open the task's ▸ details, write the comment (an @name works) and press \"Send when I complete it\" instead of Comment. It waits there (amber box) with Send now, Edit and Delete. When you start the task you get a reminder that it's waiting; when you press Complete you're asked Send & complete / Complete without it / Cancel - or pick \"Send it automatically\" in its box and it's posted just before the task is completed. A comment you left unsent in ClickUp itself can't be seen by the extension: copy it into the task's comment box here once." },
    { id: "sitestale", title: "Site monitor says \"Not checked for 4h 25m\" (or didn't warn me a site was down)", tab: "sites", card: "Site monitor",
      keys: "site monitor stopped checking not checked for hours last check old stale no alert didn't notify missed outage monitor dead useless frozen last checked 12:59 behind out of date catch up stalled",
      a: "A row in amber (\"⌛ Not checked for 4h 25m · was Up at 12:59 PM\") means exactly that: the status next to it is from the last real check, not from now, so the site could have gone down since. Opening Site monitor while it says that starts a fresh check on its own. It happens when Chrome was closed or the computer was asleep - nothing is checked then - and the extension catches up quietly on waking. If it had stopped while you were actually using the computer, you also get one \"Site monitor had stopped checking\" notification saying how long for, and it checks again straight away; you don't have to reload anything. Press \"Check all now\" any time you want an answer this second." },
    { id: "sitesnooze", title: "Stop alerts for one unstable site for a while", tab: "sites", card: "Site monitor",
      keys: "snooze mute pause silence site alerts notifications unstable flapping down up again one site temporarily stop annoying open site link url",
      a: "In Site monitor, each site has a Snooze… menu: 1 hour, 4 hours, until tomorrow 9 AM, 3 days or a week. The site is still checked and shown (\"🔕 alerts snoozed until …\"), it just doesn't notify you; Unsnooze brings the alerts back. Click a site's address to open it." },
    { id: "companyevents", title: "Add a company event or holiday that reminds everyone (Admin)", tab: "admin", card: "Company calendar & events",
      keys: "event program meeting notice announcement holiday work from home company calendar remind everyone broadcast all users dashain party admin schedule",
      a: "Admin › Company calendar & events: pick Event / notice, Holiday or Work from home, a title and the day (the extension's calendar); for an event also a time, a note and when to remind everyone (a day before, 1 hour before, 15 minutes before, at the time). Add & publish saves it to the shared settings file - everyone's calendar shows it within a few minutes and their reminders go off at those times. Edit or Remove it from the list the same way (needs the Admin GitHub token)." },
    { id: "sites", title: "Check whether client websites are up", tab: "sites", card: "Client Site Uptime Monitor",
      keys: "website site uptime down monitor",
      a: "Open Site monitor and add the sites (Auto-detect finds your clients' sites)." },
    { id: "blankpage", title: "Detect a site that's up but shows a blank or error page", tab: "sites", card: "Client Site Uptime Monitor",
      keys: "blank page white screen empty site 200 but blank broken critical error database error fatal error site looks up but empty",
      a: "Nothing to switch on: every automatic Site monitor check (every 5 minutes) also looks at the page. A site that answers but sends an empty page, a WordPress critical error or a database error then shows ⚠️ Blank page and you get a notification." },
    { id: "wrapup", title: "End-of-day wrap-up (plan tomorrow)", tab: "dashboard", action: "wrapup",
      keys: "wrap up end day tomorrow plan standup",
      a: "Opens the wrap-up: what you did today and what moves to tomorrow." },
    { id: "dept", title: "See a team's or department's tasks", tab: "clickup", card: "Department Creator",
      keys: "team department people others colleagues members",
      a: "ClickUp setup › Department Creator: make a department, then pick it in the task filter." },
    { id: "connect", title: "Connect ClickUp or change the workspace", tab: "clickup", card: "ClickUp connection",
      keys: "connect clickup token workspace sign login",
      a: "ClickUp setup › ClickUp connection." },
    { id: "phonetimer", title: "Start or stop the timer from my phone", tab: "clickup", card: "Start or stop the timer from your phone",
      keys: "phone mobile shortcut home screen iphone ios android shortcuts macrodroid http shortcuts timer start stop extra task token api key clickup direct home screen icon widget",
      a: "ClickUp setup › Start or stop the timer from your phone. The card shows your workspace id and the Extra Task id and gives you two ready-to-paste sets of steps: \"Copy iPhone steps\" builds a start and a stop shortcut in Apple's Shortcuts app, \"Copy Android steps\" builds the same two in the free HTTP Shortcuts app. The phone sends the request to ClickUp itself, so nothing has to be open on your computer, and the extension picks the change up on its next sync (or as soon as you open the popup). \"Copy my token\" puts your ClickUp token on the clipboard for the Authorization header, and \"Test the connection\" checks the token and workspace against ClickUp before you build anything. The phone shortcuts only start and stop the timer, so the task's ClickUp status is not changed: the keyboard shortcut Alt+Shift+1 does that too." },
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
  // Exact spot for a How-to entry (options page). Entries not listed here find
  // the best-matching control in their tab by their own words (locate()).
  const D = '.panel[data-panel="dashboard"] ', DR = D + "#dashTasks .cu-task ";
  const GUIDE_TO = {
    overest: "#cuRunningNotify", idle: "#cuIdleNotify", target: "#cuTarget",
    extraclose: "#cuExtraAutoClose", tidyreminder: "#cuTidyNotify", update: "#autoUpdate", multiday: "#optWeekMode",
    addclient: "#tfAddClient", newtask: "#ltBox .lt-new", filter: "#optCuFilterBtn", export: "#optCuExportBtn",
    shortcuts: "#shortcutsCard", dept: "#deptCard", diag: "#diagCopy", sites: "#siteMonitorUrls",
    tasksearch: "#dashSearch", donehistory: "#dashDoneCard", fromteammates: "#nudgeList",
    // Things done on a task row: the first task in the dashboard list (several
    // choices = first one on the page wins).
    createdby: DR + ".cu-who", unassign: DR + ".cu-who", nudge: DR + ".cu-who", "remind-others": DR + ".cu-who",
    notesend: DR + ".tn-note", tasknotes: DR + ".tn-note", "full-task-name": DR + ".nm",
    explain: DR + ".pcm-chev", "copy-for-ai": DR + ".pcm-chev", "ai-proof": DR + ".pcm-chev", desc: DR + ".pcm-chev",
    "copy-text": DR + ".pcm-chev", formatcomment: DR + ".pcm-chev", mention: DR + ".pcm-chev", "related-tasks": DR + ".pcm-chev",
    "task-family": DR + ".pcm-chev", estimate: DR + ".est", duedate: DR + ".cu-due", start: DR + ".cu-actions",
    heldcomment: DR + ".cu-iconbtn.done", rollup: [DR + ".cu-rollq", DR + ".estpairs"],
    sort: D + ".pcs-sorthead", "sort-columns": D + ".pcs-sorthead", colwidth: D + ".pcs-sorthead",
    "find-many": "#optFindText", findanytask: "#optFindText", "explore-filter": "#exFilterBtn",
    chartday: "#optWeekChart", calday: "#pcmCalChip", calendar: "#pcmCalChip", extraweek: "#cuExtraWeek",
    themes: "#themeToggle", theme: "#themeToggle",
    latefinished: 'details[data-drill="late"]', unreadcomments: 'details[data-drill="unread"]',
    archived: 'details[data-drill="archived"]', holidaydue: 'details[data-drill="holiday"]', dupetasks: 'details[data-drill="dupe"]', blockedwhy: 'details[data-drill="blocked"]',
    insdue: "#insFDue", notices: "#hubNotices", teamusers: "#hubAdminCard", "mac-damaged": "#floatCard", taskbar: "#floatCard",
    "site-monitor-off": ["[data-sm-row]", "#siteMonitorStatus"], sitesnooze: ["[data-sm-row]", "#siteMonitorStatus"],
    blankpage: ["#smBlankLine", "#siteMonitorStatus"], sitestale: "#siteMonitorStatus", sitedownme: "#siteMonitorStatus",
    "day-off-due": "#cuTidyNotify", asktasks: "#dashTasksCard", insights: "#insSubNav",
  };
  // Insights lists live on its Health sub-tab: switch there before looking.
  const GUIDE_SUB = { holidaydue: "health", latefinished: "health", unreadcomments: "health", archived: "health", dupetasks: "health", blockedwhy: "health", insdue: "health" };
  const GSTOP = new Set("task tasks with when your that this from what into them their each have about change make show turn more then also only just like does need want".split(" "));
  const wordsOf = (t) => (String(t || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !GSTOP.has(w));
  // The control in the tab that best matches a How-to entry's title (and keys).
  function locate(g) {
    if (!isOptions) return null;
    const sel = g.to || GUIDE_TO[g.id];
    if (GUIDE_SUB[g.id] && typeof window.insSetSub === "function" && !(document.querySelector([].concat(sel)[0]) || {}).offsetParent) { try { window.insSetSub(GUIDE_SUB[g.id]); } catch (e) {} }
    const tabPanel = document.querySelector('.panel[data-panel="' + String(g.tab).split("/")[0] + '"]');
    for (const one of sel ? [].concat(sel) : []) {
      // only in the guide's own section (two entries can share an id)
      const all = [...document.querySelectorAll(one)].filter((x) => !tabPanel || tabPanel.contains(x) || !x.closest(".panel[data-panel]"));
      const el = all.find((x) => x.offsetParent) || all[0];
      if (el) return el;
    }
    // "insights/plan" -> the Insights section (its sub-tab is drawn inside it).
    const panel = document.querySelector('.panel[data-panel="' + String(g.tab).split("/")[0] + '"]');
    if (!panel) return null;
    const want = new Set(wordsOf(g.title));
    const extra = new Set(wordsOf(g.keys));
    let best = null, bestScore = 0;
    for (const el of panel.querySelectorAll("label, .set-line > span.grow, .set-line > span, summary, h2, h3, .dash-h h3, .bar-label > span, button")) {
      const t = textOf(el);
      if (!t || t.length < 3 || t.length > 170) continue;
      const tw = wordsOf(t);
      if (!tw.length) continue;
      let sc = 0;
      for (const w of tw) sc += want.has(w) ? 1 : extra.has(w) ? 0.35 : 0;
      const score = sc / Math.sqrt(tw.length);
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (best && bestScore >= 1) return best;
    if (g.card) { const h = [...panel.querySelectorAll("h2")].find((x) => textOf(x) === g.card); if (h) return h.closest(".card") || h; }
    return null;
  }
  // Open the tab, wait until it has drawn the spot, then show it.
  function goGuide(g) {
    if (!isOptions) { chrome.tabs.create({ url: chrome.runtime.getURL("options.html") + "?guide=" + encodeURIComponent(g.id) + "#" + g.tab }); window.close(); return; }
    if (location.hash !== "#" + g.tab) location.hash = "#" + g.tab;
    let n = 0;
    const tryIt = () => {
      const el = locate(g);
      if (el && (el.offsetParent || el.closest("details:not([open])") || ++n > 12)) { flash(el, g.title); return; }
      if (++n <= 20) setTimeout(tryIt, 150);
      else { // never the page top: the section itself, highlighted
        const p = document.querySelector('.panel[data-panel="' + String(g.tab).split("/")[0] + '"] .card');
        if (p) flash(p, g.title); else window.scrollTo({ top: 0 });
      }
    };
    setTimeout(tryIt, 60);
  }
  function goCard(tab, title) {
    if (!isOptions) { chrome.tabs.create({ url: optUrl(title || "", tab) }); window.close(); return; }
    location.hash = "#" + tab;
    if (!title) { window.scrollTo({ top: 0 }); return; }
    setTimeout(() => {
      const h = [...document.querySelectorAll('.panel[data-panel="' + tab + '"] h2')].find((x) => textOf(x) === title);
      flash(h ? h.closest(".card") || h : null);
    }, 80);
  }
  // A setting found again by its section and its words at the moment it's
  // picked: a section that redraws itself (Insights' lists, Site monitor) has
  // new elements by then, and the one remembered when the search was built is
  // gone - that's why some results went nowhere. Counts like "(7)" are ignored.
  const normT = (s) => String(s || "").replace(/\(\d+\)/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  function findSetting(tab, text) {
    const panel = document.querySelector('.panel[data-panel="' + tab + '"]');
    if (!panel) return null;
    const want = normT(text);
    let loose = null;
    for (const el of panel.querySelectorAll("h2, h3, label, .set-line > span.grow, summary, .card .cu-subhead")) {
      const t = normT(textOf(el));
      if (t === want) return el;
      if (!loose && want.length > 6 && (t.startsWith(want) || want.startsWith(t) && t.length > 6)) loose = el;
    }
    return loose;
  }
  // Open the tab, then wait (up to ~3 s) for the spot to be drawn, then show it.
  function goSetting(tab, text, el0) {
    if (location.hash !== "#" + tab) location.hash = "#" + tab;
    let n = 0;
    const tryIt = () => {
      const el = (el0 && el0.isConnected && el0.offsetParent) ? el0 : findSetting(tab, text);
      if (el && (el.offsetParent || el.closest("details") || n > 8)) { flash(el, text); return; }
      if (++n <= 16) setTimeout(tryIt, 180);
      else { const p = document.querySelector('.panel[data-panel="' + tab + '"] .card'); if (p) flash(p, text); else window.scrollTo({ top: 0 }); }
    };
    setTimeout(tryIt, 60);
  }
  // A task: its row on this page (the dashboard's lists, the popup's list),
  // scrolled to and highlighted - ClickUp only when it isn't listed here.
  function taskRow(id) {
    const rows = [...document.querySelectorAll(".cu-task")].filter((r) => r._cuTask && String(r._cuTask.id != null ? r._cuTask.id : r._cuTask.taskId) === String(id));
    return rows.find((r) => r.offsetParent && r.closest('.panel[data-panel="dashboard"], #cuTaskList, body:not(:has(.panel))')) ||
      rows.find((r) => r.closest('.panel[data-panel="dashboard"]')) || rows[0] || null;
  }
  function goTask(it) {
    const row = it.id ? taskRow(it.id) : null;
    if (!row) { chrome.tabs.create({ url: it.url }).catch(() => {}); return; }
    const inPanel = row.closest(".panel[data-panel]");
    if (inPanel && location.hash !== "#" + inPanel.dataset.panel) location.hash = "#" + inPanel.dataset.panel;
    setTimeout(() => {
      const r = row.isConnected ? row : taskRow(it.id);
      if (r && r.offsetParent) flash(r, it.text + " - open it with \u25B8, or the name to open it in ClickUp");
      else chrome.tabs.create({ url: it.url }).catch(() => {});
    }, 120);
  }
  // Something inside a folded card ("▸ Show") or a closed dropdown (the Filter
  // menu): unfold / open it, so the highlight lands on something you can see.
  function reveal(el) {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.classList.contains("collapsed") && p.id) {
        const b = document.querySelector('[data-optcolltarget="' + p.id + '"]');
        if (b) b.click();
        if (p.classList.contains("collapsed")) p.classList.remove("collapsed");
      } else if (p.hidden && p.id && /Menu$/.test(p.id)) {
        const b = document.getElementById(p.id.replace(/Menu$/, "Btn"));
        if (b) b.click();
        if (p.hidden) p.hidden = false;
      }
    }
  }
  function flash(el, label) {
    if (!el) return;
    // A closed "More" / Advanced section: open it first.
    for (let d = el.closest("details"); d; d = d.parentElement && d.parentElement.closest("details")) d.open = true;
    reveal(el);
    const target = el.closest(".set-line, .checkbox, .tf-addc, .wk-mode") || (el.matches("input, select, textarea, button") ? el.parentElement || el : el);
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("pcm-flash", "pcs-here");
    setTimeout(() => target.classList.remove("pcm-flash", "pcs-here"), 3600);
    if (label) {
      const tip = document.createElement("div");
      tip.className = "pcs-tip";
      tip.textContent = "Here: " + label;
      document.body.appendChild(tip);
      const place = () => {
        const r = target.getBoundingClientRect();
        tip.style.top = Math.max(8, r.top - tip.offsetHeight - 8) + "px";
        tip.style.left = Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 8, r.left)) + "px";
      };
      place();
      const iv = setInterval(place, 60); // follows the smooth scroll
      setTimeout(() => { clearInterval(iv); tip.remove(); }, 3600);
    }
    const input = el.matches("input:not([type=hidden]), select, textarea") ? el : target.querySelector("input:not([type=hidden]), select, textarea");
    if (input) setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) {} }, 500);
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

  // ---------- smart task search ----------
  // "tasks I completed last month for acmedental clinic", "sam's tasks for the
  // upcoming week for bright roofing": who + client + when + done/due, read from the
  // sentence right here (no AI service, nothing sent anywhere). People come from
  // the workspace member list, clients from every task the extension has loaded,
  // so a name or client is only picked when it really exists. The background then
  // runs one filtered ClickUp query (SMART_TASKS).
  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const ckey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const dStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const dEnd = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x.getTime(); };
  // Weeks run Sunday to Saturday, like the calendar and the dashboard's "Due this
  // week" / "Due next week" (owner's call): on Sunday Oct 4, this week is Oct 4-10.
  const weekStartOf = (d) => { const x = new Date(dStart(d)); x.setDate(x.getDate() - x.getDay()); return x; };
  const shortDay = (ts) => new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  let known = null;
  async function knownLists() {
    if (known && Date.now() - known.at < 60000) return known;
    const g = await chrome.storage.local.get(["clickupState", "insOpenCache", "perfHistory", "devPipeline", "clientNotes", "siteMonitorConfig"]).catch(() => ({}));
    const st = g.clickupState || {};
    const clients = new Map();
    const addC = (c) => { const k = ckey(c); if (k.length >= 3 && !clients.has(k)) clients.set(k, String(c).trim()); };
    const rows = (b) => b ? [].concat(b.tasks || [], b.deadlineTasks || [], b.trackedTasks || []) : [];
    for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek, st.custom, st.tomorrow]) for (const t of rows(b)) if (t && t.client) addC(t.client);
    for (const t of (g.insOpenCache && g.insOpenCache.tasks) || []) if (t && t.client) addC(t.client);
    for (const t of (g.perfHistory && g.perfHistory.done) || []) if (t && t.client) addC(t.client);
    for (const t of (g.devPipeline && g.devPipeline.tasks) || []) if (t && t.client) addC(t.client);
    for (const s of ((g.siteMonitorConfig && g.siteMonitorConfig.sites) || [])) if (s && s.name && !/^https?:/i.test(s.name)) addC(s.name);
    const members = (Array.isArray(st.members) ? st.members : []).filter((m) => m && m.id != null && m.name && !/^User \d+$/.test(m.name));
    known = { at: Date.now(), clients: [...clients.values()], members };
    return known;
  }
  // ---- when: every way people say a period ----
  // Returns candidate periods, best first; a second one is offered as "Or: …"
  // when the words can fairly mean two things ("last week" on a Saturday: the
  // week just worked, or the one before it). Each: { fromTs, toTs, label, past, mode? }.
  const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const PREV = "(?:last|previous|past|prior|preceding)";
  const NEXT = "(?:next|upcoming|coming|following)";
  // Small typos in the date words ("previos", "upcomming", "nxt wek") are fixed
  // first; names of clients and people are never touched (they aren't near these).
  const VOCAB = ["previous", "last", "next", "upcoming", "coming", "following", "week", "weeks", "month", "months", "today", "yesterday", "tomorrow",
    "completed", "finished", "weekend", "quarter", "overdue", "recently", "since", "between", "remaining", "pending"]
    .concat(WEEKDAYS, MONTHS);
  const SHORT = { prev: "previous", prv: "previous", nxt: "next", wk: "week", wks: "weeks", wek: "week", weeek: "week", mnt: "month", mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday", thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", mth: "month", mnth: "month", tmrw: "tomorrow", tmr: "tomorrow", tdy: "today", yday: "yesterday", sept: "september" };
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }
  function fixWords(q) {
    return q.replace(/[a-z]+/g, (w) => {
      if (SHORT[w]) return SHORT[w];
      // Only longer words: a short real word ("many") must not turn into "may".
      if (w.length < 5 || VOCAB.includes(w)) return w;
      let best = null, bd = 9;
      for (const v of VOCAB) { const d = lev(w, v); if (d < bd) { bd = d; best = v; } }
      return bd <= (w.length >= 8 ? 2 : 1) ? best : w;
    });
  }
  // "sep 28", "28 sep", "september 28 2025", "28/9", "2026-09-28", "monday" -> a day (ms) or 0.
  function parseDay(s, now, preferPast) {
    s = String(s || "").trim();
    let m;
    const year = now.getFullYear();
    const mi = (name) => MONTHS.findIndex((x) => x.startsWith(name.slice(0, 3)));
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    if ((m = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?$/.exec(s))) return new Date(m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : year, +m[2] - 1, +m[1]).getTime();
    const pick = (mo, day, y) => {
      if (y) return new Date(y, mo, day).getTime();
      let t = new Date(year, mo, day).getTime();
      // No year: the nearest one in the direction the sentence points to.
      if (preferPast && t > dEnd(now) + 7 * 864e5) t = new Date(year - 1, mo, day).getTime();
      if (!preferPast && t < dStart(now) - 60 * 864e5) t = new Date(year + 1, mo, day).getTime();
      return t;
    };
    if ((m = /^([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?$/.exec(s)) && mi(m[1]) >= 0) return pick(mi(m[1]), +m[2], m[3] ? +m[3] : 0);
    if ((m = /^(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]{3,9})\.?(?:,? (\d{4}))?$/.exec(s)) && mi(m[2]) >= 0) return pick(mi(m[2]), +m[1], m[3] ? +m[3] : 0);
    const wd = WEEKDAYS.indexOf(s);
    if (wd >= 0) {
      const t = new Date(dStart(now));
      const diff = (wd - t.getDay() + 7) % 7;
      t.setDate(t.getDate() + (preferPast ? (diff === 0 ? 0 : diff - 7) : diff));
      return t.getTime();
    }
    if (s === "today") return dStart(now);
    if (s === "yesterday") return dStart(now) - 864e5;
    if (s === "tomorrow") return dStart(now) + 864e5;
    return 0;
  }
  // Month words only (so "completed 28 sep" isn't read as a date "completed 28").
  const MON_RX = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*";
  const DATE_RX = "(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.]\\d{1,2}(?:[/.]\\d{2,4})?|" + MON_RX + "\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?|\\d{1,2}(?:st|nd|rd|th)? (?:of )?" + MON_RX + "(?:,? \\d{4})?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)";
  function parsePeriod(q) {
    const now = new Date();
    const today = dStart(now);
    const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
    const r = (from, to, label, past, extra) => ({ fromTs: dStart(from), toTs: dEnd(to), label, past, ...(extra || {}) });
    const cap = (s) => s.replace(/^./, (c) => c.toUpperCase());
    const mon = weekStartOf(now); // the Sunday this week started (name kept from the Monday days)
    const dow = now.getDay();
    // The work week is over: Saturday, Sunday, or Friday after 5 PM.
    // The work week is over: Saturday (the week's last day), or Friday after 5 PM.
    // Sunday is the first day of a new week.
    const weekDone = dow === 6 || (dow === 5 && now.getHours() >= 17);
    const monthStart = (y, m) => new Date(y, m, 1);
    const monthEnd = (y, m) => new Date(y, m + 1, 0);
    const pastHint = /\b(did|done|complet\w*|finish\w*|closed|was|were|worked|ago|last|previous|past|since|recently)\b/.test(q);
    const one = (x) => [x];
    let m;

    if (/\boverdue\b|\blate tasks?\b|\bmissed (?:deadline|due)/.test(q)) return one({ fromTs: 0, toTs: today - 1, label: "overdue (due before today)", past: false, mode: "due" });

    // Explicit ranges: "from sep 1 to sep 15", "between 1/9 and 15/9", "sep 1 - sep 15"
    if ((m = new RegExp("(?:from|between) " + DATE_RX + " (?:to|and|till|until|-) " + DATE_RX).exec(q)) || (m = new RegExp(DATE_RX + " ?(?:-|to|till|until) ?" + DATE_RX).exec(q))) {
      const a = parseDay(m[1], now, pastHint), b = parseDay(m[2], now, pastHint);
      if (a && b) { const lo = Math.min(a, b), hi = Math.max(a, b); return one(r(lo, hi, shortDay(lo) + " – " + shortDay(hi), hi < today)); }
    }
    if ((m = new RegExp("\\bsince " + DATE_RX).exec(q))) { const a = parseDay(m[1], now, true); if (a) return one(r(a, now, "since " + shortDay(a), true)); }

    if (/\bday after tomorrow\b/.test(q)) return one(r(add(now, 2), add(now, 2), "day after tomorrow", false));
    if (/\bday before yesterday\b/.test(q)) return one(r(add(now, -2), add(now, -2), "day before yesterday", true));
    if (/\btoday and tomorrow\b/.test(q)) return one(r(now, add(now, 1), "today and tomorrow", false));

    // "3 days ago", "2 weeks ago", "a month ago"
    if ((m = /\b(\d{1,2}|a|an|one|two|three) (day|week|month)s? ago\b/.exec(q))) {
      const n = { a: 1, an: 1, one: 1, two: 2, three: 3 }[m[1]] || +m[1];
      if (m[2] === "day") return one(r(add(now, -n), add(now, -n), n + " day" + (n > 1 ? "s" : "") + " ago", true));
      if (m[2] === "week") { const s = add(mon, -7 * n); return one(r(s, add(s, 6), n + " week" + (n > 1 ? "s" : "") + " ago", true)); }
      const s = monthStart(now.getFullYear(), now.getMonth() - n); return one(r(s, monthEnd(s.getFullYear(), s.getMonth()), cap(MONTHS[s.getMonth()]) + " (" + n + " month" + (n > 1 ? "s" : "") + " ago)", true));
    }
    // Rolling: "last 10 days", "past 2 weeks", "next 3 months"
    if ((m = new RegExp("\\b" + PREV + " (\\d{1,3}|two|three|few) (day|week|month)s?\\b").exec(q))) {
      const n = { two: 2, three: 3, few: 3 }[m[1]] || +m[1], days = m[2] === "day" ? n : m[2] === "week" ? 7 * n : 30 * n;
      return one(r(add(now, -days), now, "last " + n + " " + m[2] + "s", true));
    }
    if ((m = new RegExp("\\b" + NEXT + " (\\d{1,3}|two|three|few) (day|week|month)s?\\b").exec(q))) {
      const n = { two: 2, three: 3, few: 3 }[m[1]] || +m[1], days = m[2] === "day" ? n : m[2] === "week" ? 7 * n : 30 * n;
      return one(r(now, add(now, days), "next " + n + " " + m[2] + "s", false));
    }
    if (/\bfortnight\b/.test(q)) return new RegExp("\\b" + PREV).test(q) ? one(r(add(now, -14), now, "last 2 weeks", true)) : one(r(now, add(now, 14), "next 2 weeks", false));

    // Weekends
    if (/\bweekend\b/.test(q)) {
      // A weekend is Saturday + the Sunday after it (it spans two calendar weeks).
      // "This weekend" on a Sunday is the one we're in (yesterday + today).
      const sat = dow === 0 ? add(mon, -1) : add(mon, 6);
      if (new RegExp("\\b" + PREV + " weekend").test(q)) { const s = add(sat, -7); return one(r(s, add(s, 1), "last weekend", true)); }
      if (new RegExp("\\b" + NEXT + " weekend").test(q)) { const s = add(sat, 7); return one(r(s, add(s, 1), "next weekend", false)); }
      return one(r(sat, add(sat, 1), "this weekend", false));
    }

    // "week of oct 12" = the Mon-Sun week that day is in.
    if ((m = new RegExp("\\bweek of " + DATE_RX).exec(q))) {
      const d = parseDay(m[1], now, pastHint);
      if (d) { const s = weekStartOf(d); return one(r(s, add(s, 6), "week of " + shortDay(s.getTime()), add(s, 6).getTime() < today)); }
    }
    // Weeks
    if (new RegExp("\\b" + PREV + " (?:work ?)?week\\b").test(q)) {
      const before = r(add(mon, -7), add(mon, -1), "the week before", true);
      if (weekDone) return [r(mon, add(mon, 6), "last week (just ended)", true), before];
      return [r(add(mon, -7), add(mon, -1), "last week", true), r(add(now, -7), add(now, -1), "last 7 days", true)];
    }
    if (/\b(?:this week and next|this and next week)\b/.test(q)) return one(r(weekDone ? add(mon, 7) : mon, add(mon, 13), "this week and next", false));
    if (/\brest of (?:the|this) week\b/.test(q)) return one(r(now, add(mon, 6), "rest of this week", false));
    if (new RegExp("\\b" + NEXT + " (?:work ?)?week\\b").test(q)) {
      return [r(add(mon, 7), add(mon, 13), "next week", false), r(now, add(now, 7), "next 7 days", false)];
    }
    if (/\b(?:this|current) (?:work ?)?week\b|\bthis wk\b/.test(q) || /\bweek\b/.test(q)) {
      if (weekDone) return [r(mon, add(mon, 6), "this week (ending)", pastHint), r(add(mon, 7), add(mon, 13), "the coming week", false)];
      return one(r(mon, add(mon, 6), "this week", false));
    }

    // Weekdays: "last friday", "next tuesday", "on monday", "friday"
    if ((m = new RegExp("\\b(" + PREV.slice(3, -1) + "|" + NEXT.slice(3, -1) + "|this|on)? ?(" + WEEKDAYS.join("|") + ")\\b").exec(q))) {
      const w = WEEKDAYS.indexOf(m[2]);
      const isPrev = m[1] && new RegExp("^" + PREV + "$").test(m[1]);
      const isNext = m[1] && new RegExp("^" + NEXT + "$").test(m[1]);
      const t = new Date(today);
      let diff = (w - dow + 7) % 7;
      if (isPrev) diff = diff === 0 ? -7 : diff - 7;
      else if (isNext) diff = diff === 0 ? 7 : diff; // "next tuesday" = the coming one
      else if (pastHint && diff > 0) diff -= 7;
      t.setDate(t.getDate() + diff);
      return one(r(t, t, cap((isPrev ? "last " : isNext ? "next " : "") + m[2]) + " " + shortDay(t.getTime()), t.getTime() < today));
    }

    // Months
    if (new RegExp("\\b" + PREV + " month\\b").test(q)) {
      const s = monthStart(now.getFullYear(), now.getMonth() - 1);
      return [r(s, monthEnd(s.getFullYear(), s.getMonth()), "last month (" + cap(MONTHS[s.getMonth()]) + ")", true), r(add(now, -30), now, "last 30 days", true)];
    }
    if (new RegExp("\\b" + NEXT + " month\\b").test(q)) {
      const s = monthStart(now.getFullYear(), now.getMonth() + 1);
      return [r(s, monthEnd(s.getFullYear(), s.getMonth()), "next month (" + cap(MONTHS[s.getMonth()]) + ")", false), r(now, add(now, 30), "next 30 days", false)];
    }
    if (/\b(?:end of (?:the |this )?month|rest of (?:the |this )?month)\b/.test(q)) return one(r(now, monthEnd(now.getFullYear(), now.getMonth()), "rest of " + cap(MONTHS[now.getMonth()]), false));
    if (/\b(?:this|current) month\b|\bmonth\b/.test(q)) {
      const c = r(monthStart(now.getFullYear(), now.getMonth()), monthEnd(now.getFullYear(), now.getMonth()), "this month (" + cap(MONTHS[now.getMonth()]) + ")", pastHint);
      // In the first days of a month, "this month" might still mean the one just ended.
      if (now.getDate() <= 3) { const s = monthStart(now.getFullYear(), now.getMonth() - 1); return [c, r(s, monthEnd(s.getFullYear(), s.getMonth()), cap(MONTHS[s.getMonth()]) + " (just ended)", true)]; }
      return one(c);
    }

    // Quarters and years
    if (/\bquarter\b/.test(q)) {
      const qi = Math.floor(now.getMonth() / 3) + (new RegExp("\\b" + PREV + " quarter").test(q) ? -1 : new RegExp("\\b" + NEXT + " quarter").test(q) ? 1 : 0);
      const s = monthStart(now.getFullYear(), qi * 3);
      return one(r(s, monthEnd(s.getFullYear(), s.getMonth() + 2), "Q" + (((qi % 4) + 4) % 4 + 1) + " " + s.getFullYear(), s.getTime() < today && qi <= Math.floor(now.getMonth() / 3) - 1));
    }
    if (new RegExp("\\b" + PREV + " year\\b").test(q)) { const y = now.getFullYear() - 1; return one(r(new Date(y, 0, 1), new Date(y, 11, 31), String(y), true)); }
    if (/\b(?:this|current) year\b/.test(q)) return one(r(new Date(now.getFullYear(), 0, 1), new Date(now.getFullYear(), 11, 31), String(now.getFullYear()), pastHint));

    // One day by date: "on sep 28", "28 sep", "28/9"
    // Every date-looking phrase is tried ("task 12" before "sep 28" must not hide it).
    for (const mm of q.matchAll(new RegExp("\\b(?:on )?" + DATE_RX + "\\b", "g"))) {
      if (WEEKDAYS.includes(mm[1]) || ["today", "yesterday", "tomorrow"].includes(mm[1])) continue;
      const d = parseDay(mm[1], now, pastHint);
      if (d) return one(r(d, d, shortDay(d), d < today));
    }

    // Month names: "september", "sept 2025", "last september"
    for (let i = 0; i < 12; i++) {
      const mm = new RegExp("\\b(" + PREV.slice(3, -1) + "|" + NEXT.slice(3, -1) + "|this)? ?(?:" + MONTHS[i] + "|" + MONTHS[i].slice(0, 3) + ")\\b(?: (\\d{4}))?").exec(q);
      if (!mm) continue;
      let y = mm[2] ? +mm[2] : now.getFullYear();
      if (!mm[2]) {
        if (mm[1] && new RegExp("^" + PREV + "$").test(mm[1])) y = i >= now.getMonth() ? y - 1 : y;
        else if (mm[1] && new RegExp("^" + NEXT + "$").test(mm[1])) y = i <= now.getMonth() ? y + 1 : y;
        else if (i > now.getMonth() && pastHint) y -= 1; // "completed in november" (it's October) = last year's
      }
      const end = monthEnd(y, i);
      return one(r(monthStart(y, i), end, cap(MONTHS[i]) + (y !== now.getFullYear() ? " " + y : ""), end.getTime() < today));
    }

    if (/\b(?:recently|lately|recent)\b/.test(q)) return one(r(add(now, -14), now, "last 2 weeks", true));
    if (/\b(?:upcoming|coming up|soon)\b/.test(q)) return [r(now, add(now, 14), "next 2 weeks", false), r(add(mon, 7), add(mon, 13), "next week", false)];
    if (/\byesterday\b/.test(q)) return one(r(add(now, -1), add(now, -1), "yesterday", true));
    if (/\btoday\b/.test(q)) return one(r(now, now, "today", false));
    if (/\btomorrow\b/.test(q)) return one(r(add(now, 1), add(now, 1), "tomorrow", false));
    return [];
  }
  function bestClient(q, clients) {
    const words = q.split(/[^a-z0-9]+/).filter(Boolean);
    const skip = new Set(["task", "tasks", "the", "for", "client", "of", "my", "me", "and", "week", "month", "last", "next", "this", "that", "completed", "done", "due", "show", "see", "want"]);
    let best = null;
    for (let n = 3; n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        const span = words.slice(i, i + n);
        if (span.every((w) => skip.has(w))) continue;
        const g = span.join("");
        if (g.length < 4) continue;
        for (const c of clients) {
          const k = ckey(c);
          const hit = k === g || k.includes(g) || (g.includes(k) && k.length >= 5) || (k.replace(/seo$/, "").length >= 5 && g.startsWith(k.replace(/seo$/, "")));
          if (hit && (!best || g.length > best.len)) best = { name: c, len: g.length };
        }
      }
      if (best) break;
    }
    return best ? best.name : "";
  }
  function bestMember(q, members) {
    let best = null;
    for (const m of members) {
      const parts = m.name.toLowerCase().split(/[\s._@-]+/).filter((p) => p.length >= 3);
      if (!parts.length) continue;
      const full = parts.join(" ");
      let s = 0;
      if (q.includes(full)) s = 100;
      else if (parts.length > 1 && parts.every((p) => new RegExp("\\b" + p).test(q))) s = 90;
      else if (new RegExp("\\b" + parts[0] + "(?:'?s)?\\b").test(q)) s = 60;
      if (s && (!best || s > best.s)) best = { m, s, n: 1 }; else if (s && best && s === best.s) best.n++;
    }
    // A first name two people share is ambiguous - better ask than guess.
    return best && best.n === 1 ? best.m : null;
  }
  // A sentence -> the readings of it, best first (the second is the "Or: …" one).
  async function parseSmart(raw) {
    const q0 = " " + norm(raw).replace(/[’']s\b/g, "s") + " ";
    if (q0.trim().split(" ").length < 3) return null;
    const q = fixWords(q0); // date / status words with small typos fixed; names read from q0
    const k = await knownLists();
    const periods = parsePeriod(q);
    const client = bestClient(q0, k.clients);
    const person = bestMember(q0, k.members);
    const doneW = /\b(complet\w*|done|finish\w*|closed|did|worked on|delivered|wrapped up)\b/.test(q);
    const dueW = /\b(due|upcoming|pending|open|todo|to do|left|remaining|planned|scheduled|coming|overdue|outstanding)\b/.test(q);
    const taskW = /\btasks?\b|\bwork\b|\bjobs?\b|\bassignments?\b/.test(q);
    const mine = /\b(my|mine)\b/.test(q) && taskW && (doneW || dueW);
    if (!(taskW || doneW || dueW) || !(periods.length || client || person || mine)) return null;
    const now = new Date();
    const base = { assignee: person ? String(person.id) : "", personName: person ? person.name : "you", client }; // a named teammate wins over "I"/"my"
    const modeFor = (p) => p && p.mode ? p.mode : doneW ? "done" : dueW ? "due" : p && p.past ? "done" : "due";
    const list = periods.length ? periods : [null];
    return list.slice(0, 2).map((p) => {
      const mode = modeFor(p);
      const pp = p || (mode === "done" ? { fromTs: dStart(new Date(now.getTime() - 30 * 864e5)), toTs: dEnd(now), label: "last 30 days" } : { fromTs: dStart(now), toTs: dEnd(new Date(now.getTime() + 30 * 864e5)), label: "next 30 days" });
      return { ...base, mode, fromTs: pp.fromTs, toTs: pp.toTs, periodLabel: pp.label };
    });
  }
  const rangeText = (s) => !s.fromTs ? "until " + shortDay(s.toTs) : shortDay(s.fromTs) + (s.fromTs !== dStart(s.toTs) ? " – " + shortDay(s.toTs) : "");
  function smartLabel(s) {
    return (s.mode === "done" ? "completed" : "due") + " · " + s.periodLabel + " (" + rangeText(s) + ")" + (s.client ? " · " + s.client : "") + " · " + s.personName;
  }
  const fmtH = (ms) => { const m = Math.round((Number(ms) || 0) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
  async function runSmart(s) {
    resBox.innerHTML = '<div class="pcs-empty">Finding ' + esc(smartLabel(s)) + "…</div>";
    let r = null;
    try { r = await new Promise((res) => chrome.runtime.sendMessage({ type: "SMART_TASKS", q: s }, (x) => { void chrome.runtime.lastError; res(x || null); })); } catch (e) {}
    if (!back) return;
    const chip = (key, text) => '<span class="pcs-chip">' + esc(text) + (key ? ' <button type="button" data-drop="' + key + '" title="Remove this filter">✕</button>' : "") + "</span>";
    let h = '<div class="pcs-smart"><div class="pcs-chips">' + chip("", s.mode === "done" ? "Completed" : "Due") + chip("period", s.periodLabel + " · " + rangeText(s)) +
      (s.client ? chip("client", s.client) : "") + chip(s.assignee ? "person" : "", s.personName === "you" ? "Your tasks" : s.personName) + "</div>";
    if (!r || !r.ok) { h += '<div class="pcs-empty" style="color:var(--red)">' + esc((r && r.error) || "No answer from the extension.") + "</div></div>"; resBox.innerHTML = h; wireSmart(s); return; }
    const list = (r.tasks || []).slice().sort((a, b) => (s.mode === "done" ? b.doneAt - a.doneAt : (a.dueDateMs || 9e15) - (b.dueDateMs || 9e15)));
    const est = list.reduce((a, t) => a + (Number(t.estimateMs) || 0), 0), spent = list.reduce((a, t) => a + (Number(t.spentMs) || 0), 0);
    h += '<div class="pcs-sm" style="margin:6px 14px">' + list.length + " task" + (list.length === 1 ? "" : "s") + " · estimated " + fmtH(est) + " · tracked " + fmtH(spent) +
      (!r.isMe && !r.viaAdmin ? " · only what your own ClickUp access can see (save a workspace admin token in ClickUp setup to see everything)" : "") + "</div>";
    if (!list.length) h += '<div class="pcs-empty">No tasks match. Remove a filter above (✕) to widen it.</div>';
    for (const t of list.slice(0, 200)) {
      const when = s.mode === "done" ? (t.doneAt ? "done " + shortDay(t.doneAt) : "done") : (t.dueDateMs ? "due " + shortDay(t.dueDateMs) : "no due date");
      h += '<a class="pcs-it pcs-trow" href="' + esc(t.url) + '" target="_blank" rel="noopener"><span class="t" title="' + esc(t.name) + '">' + esc(t.name) + '</span><span class="w">' + esc([t.client, when, t.status].filter(Boolean).join(" · ")) + '</span><span class="w pcs-tm">' + (t.spentMs ? fmtH(t.spentMs) : "0m") + (t.estimateMs ? " / " + fmtH(t.estimateMs) : "") + "</span></a>";
    }
    if (list.length > 200) h += '<div class="pcs-sm" style="margin:6px 14px">…and ' + (list.length - 200) + " more.</div>";
    h += "</div>";
    items = []; sel = 0;
    resBox.innerHTML = h;
    wireSmart(s);
  }
  function wireSmart(s) {
    resBox.querySelectorAll("[data-drop]").forEach((b) => {
      b.onclick = () => {
        const k = b.getAttribute("data-drop");
        const n = { ...s };
        if (k === "client") n.client = "";
        if (k === "person") { n.assignee = ""; n.personName = "you"; }
        if (k === "period") { const now = new Date(); if (n.mode === "done") { n.fromTs = dStart(new Date(now.getTime() - 90 * 864e5)); n.toTs = dEnd(now); n.periodLabel = "last 90 days"; } else { n.fromTs = dStart(now); n.toTs = dEnd(new Date(now.getTime() + 90 * 864e5)); n.periodLabel = "next 90 days"; } }
        runSmart(n);
      };
    });
  }

  // ---------- UI ----------
  const css = document.createElement("style");
  css.textContent = `
    .pcs-here { position: relative; outline: 3px solid var(--indigo, #6366f1) !important; outline-offset: 4px; border-radius: 8px; animation: pcs-pulse 1.1s ease-in-out 3; }
    @keyframes pcs-pulse { 0%, 100% { outline-color: var(--indigo, #6366f1); } 50% { outline-color: rgba(99,102,241,.25); } }
    .pcs-tip { position: fixed; z-index: 3100; max-width: min(420px, calc(100vw - 16px)); padding: 6px 10px; border-radius: 8px; background: var(--indigo, #6366f1); color: #fff; font-size: 12px; font-weight: 600; box-shadow: 0 8px 20px rgba(0,0,0,.25); pointer-events: none; }
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
    .pcs-it.smart .t { color: var(--indigo, #6366f1); font-weight: 600; }
    .pcs-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 14px 4px; }
    .pcs-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; background: rgba(99,102,241,.12); color: var(--indigo, #6366f1); }
    .pcs-chip button { border: 0; background: none; color: inherit; cursor: pointer; font-size: 11px; padding: 0 2px; opacity: .7; }
    .pcs-chip button:hover { opacity: 1; }
    a.pcs-it.pcs-trow { color: var(--text); text-decoration: none; }
    a.pcs-it.pcs-trow:hover { background: var(--bg2, rgba(99,102,241,.08)); }
    .pcs-it .pcs-tm { flex: none; min-width: 64px; text-align: right; font-weight: 600; color: var(--text); }
  `;
  document.head.appendChild(css);

  let back = null, input = null, resBox = null, items = [], sel = 0;
  async function open() {
    if (back) { input.focus(); return; }
    if (isOptions) settingsIdx = null; // fresh: Insights' lists, Site monitor rows... change
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
      else if (e.key === "Enter") {
        e.preventDefault();
        // A sentence or a question (5+ words, or ending in "?") and nothing picked
        // with the arrows: the AI finds it and takes you there. A "find my tasks"
        // sentence still runs the task search, which it is built for.
        const q = input.value.trim();
        const long = q.split(/\s+/).filter(Boolean).length >= 5 || /\?\s*$/.test(q);
        // (a pasted task name that matches a result as typed still opens that result)
        const exact = items[0] && items[0].text && compact(items[0].text).includes(compact(q));
        if (long && sel === 0 && !exact && !(items[0] && items[0].type === "smart")) { askAI(q, true); return; }
        if (items[sel]) pick(items[sel]);
      }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    input.focus();
    search().then(() => freshenIndex(false)).catch(() => {});
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
      ? [["How to", guides], ["Settings", rank(sets, (x) => x.text + " " + x.where, 8, itemMap, 45)], ["Tasks", taskHits(rank(tasks, (x) => x.text + " " + x.client, 40))], ["Actions", rank(ACTIONS, (x) => x.text, 4, itemMap, 45)]]
      : [["Actions", ACTIONS]];
    // Your other tasks (any status, any dates) live in the task index: offer to
    // read it once when it isn't there yet, and say how far it has got.
    if (q && !(ixMeta && ixMeta.state === "ready")) {
      const tg = groups.find((x) => x[0] === "Tasks");
      const building = ixMeta && ixMeta.state === "building" && !ixMeta.error;
      tg[1] = tg[1].concat([{ type: "ixbuild", text: building ? "⏳ Reading all your ClickUp tasks… " + Number(ixMeta.read || 0).toLocaleString() + " so far - results appear here as they come in"
        : "🔎 Not here? Search ALL your tasks - any status, any date, done or not (reads them from ClickUp once)" }]);
    }
    // Not it? Ask the AI (only when clicked).
    if (q.split(" ").length >= 3) groups.push([guides.length ? "Not it?" : "Ask", [{ type: "ai", text: "✨ Ask AI: “" + input.value.trim() + "”" }]]);
    // A question about tasks ("what I completed last month for Acme Dental") goes first.
    const smart = q ? await parseSmart(input.value) : null;
    if (!back) return;
    if (smart && smart.length) groups.unshift(["Find tasks", smart.map((s, i) => ({ type: "smart", s, text: (i ? "Or: " : "🔎 Show tasks ") + smartLabel(s) }))]);
    items = [];
    let html = "";
    for (const [name, list] of groups) {
      if (!list.length) continue;
      html += '<div class="pcs-grp">' + name + "</div>";
      for (const it of list) {
        const idx = items.push(it) - 1;
        const where = it.type === "setting" ? it.where
          : it.type === "task" ? [it.client, it.due ? new Date(it.due).toLocaleDateString([], { month: "short", day: "numeric", year: new Date(it.due).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }) : "no date", it.status].filter(Boolean).join(" · ")
          : "";
        if (it.type === "guide") html += '<div class="pcs-it g" data-i="' + idx + '"><span class="t">' + esc(it.title) + '</span><div class="pcs-a">' + esc(it.a) + "</div></div>";
        else html += '<div class="pcs-it' + (it.type === "ai" ? " ai" : it.type === "smart" ? " smart" : "") + '" data-i="' + idx + '"><span class="t">' + esc(it.text) + '</span><span class="w">' + esc(where) + "</span></div>";
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
    if (it.type === "smart") { runSmart(it.s); return; }
    if (it.type === "ixbuild") { freshenIndex(true); ixMeta = { ...(ixMeta || {}), state: "building", read: (ixMeta && ixMeta.read) || 0, error: "" }; search(); return; }
    if (it.type === "guide") {
      const act = it.action && ACTIONS.find((a) => (it.action === "float" ? /Float/ : /wrap-up/).test(a.text));
      close();
      if (act) { act.run(); return; }
      if (it.here && !isOptions && !GUIDE_TO[it.id] && !it.to) return; // it's right here in the popup
      goGuide(it);
      return;
    }
    close();
    if (it.type === "action") { it.run(); return; }
    if (it.type === "task") { goTask(it); return; }
    if (!isOptions) { chrome.tabs.create({ url: optUrl(it.section ? "" : it.text, it.tab) }); window.close(); return; }
    if (it.section) { location.hash = "#" + it.tab; window.scrollTo({ top: 0 }); return; }
    goSetting(it.tab, it.text, it.el);
  }

  // Opened from the popup with ?guide= (a How-to entry) or ?find= (a setting):
  // go to that spot once the page is ready.
  if (isOptions) {
    const gid = new URLSearchParams(location.search).get("guide");
    const g = gid && GUIDES.find((x) => x.id === gid);
    if (g) setTimeout(() => { goGuide(g); history.replaceState(null, "", location.pathname + location.hash); }, 500);
  }
  if (isOptions) {
    const find = new URLSearchParams(location.search).get("find");
    if (find) setTimeout(async () => {
      const hit = (await settings()).find((s) => s.text === find);
      if (hit) goSetting(hit.tab, hit.text, hit.el);
      history.replaceState(null, "", location.pathname + location.hash);
    }, 600);
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); open(); }
  });
  window.PcmSearch = { open, flash };

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
  let guideDf = null;
  async function askAI(question, autoGo) {
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
    // Your tasks that match the words best are offered too, so "where's the GA4
    // alert task for that client" can land on the task itself.
    let taskCands = [];
    try {
      const qn = norm(question);
      taskCands = (await taskIdx()).map((t) => ({ t, s: Math.max(score(t.text + " " + t.client, qn), nlScore(toks(qn), tokMap([[t.text, 3], [t.client, 1]]))) }))
        .filter((x) => x.s >= 35).sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.t);
    } catch (e) {}
    // Only the closest ~25 How-to entries go to the AI: all of them is more than
    // Chrome's built-in AI takes in one go ("The input is too large").
    const qts = toks(question);
    // Rare words count more ("archived" says more than "task").
    if (!guideDf) { guideDf = new Map(); for (const g of GUIDES) for (const t of guideMap(g).keys()) guideDf.set(t, (guideDf.get(t) || 0) + 1); }
    const idf = (t) => Math.log((GUIDES.length + 1) / (1 + (guideDf.get(t) || 0)));
    const gRank = GUIDES.map((g) => { const m = guideMap(g); return { g, s: qts.reduce((a, t) => a + tokHit(t, m) * idf(t), 0) * 10 + nlScore(qts, m) / 10 }; })
      .sort((a, b) => b.s - a.s);
    const gCands = gRank.slice(0, 25).map((x) => x.g);
    // If the AI can't answer: the closest match by its words.
    const closest = taskCands[0] && !(gRank[0] && gRank[0].s >= 120) ? taskCands[0] : gRank[0] && gRank[0].s > 0 ? gRank[0].g : null;
    const ids = gCands.map((g) => g.id).concat(taskCands.map((t, i) => "task" + (i + 1)));
    const system = "You match a user's question to the features of a Chrome extension for ClickUp time tracking. " +
      "Reply ONLY with JSON like {\"ids\":[\"id1\"]}: up to 2 ids from the list, best first. If nothing in the list fits, reply {\"ids\":[]}. Never invent ids.";
    const prompt = "Question: " + question.slice(0, 300) + "\n\nFeatures (id: what it does):\n" + gCands.map((g) => g.id + ": " + g.title).join("\n") +
      (taskCands.length ? "\n\nThe person's own tasks (id: task name - client) - pick one of these when the question is about finding a particular task:\n" + taskCands.map((t, i) => "task" + (i + 1) + ": " + t.text + (t.client ? " - " + t.client : "")).join("\n") : "");
    let picked = [];
    try {
      const text = await window.PcmAI.generate(system, prompt, { signal: aiAbort.signal,
        schema: { type: "object", properties: { ids: { type: "array", maxItems: 2, items: { type: "string", enum: ids } } }, required: ["ids"] } });
      let got = [];
      try { const j = JSON.parse((String(text).match(/\{[\s\S]*\}/) || ["{}"])[0]); got = Array.isArray(j.ids) ? j.ids : []; } catch (e) {}
      if (!got.length) got = ids.filter((id) => new RegExp("\\b" + id + "\\b").test(String(text)));
      picked = [...new Set(got.map(String))].map((id) => /^task\d+$/.test(id) ? taskCands[Number(id.slice(4)) - 1] || null : GUIDES.find((g) => g.id === id)).filter(Boolean).slice(0, 2);
    } catch (e) {
      if (!back) return;
      const nm = closest ? (closest.type === "task" ? "Task: " + closest.text : closest.title) : "";
      say("The AI couldn't answer (" + esc((e && e.message) || e) + ")." + (closest
        ? (autoGo ? " Taking you to the closest match: <b>" + esc(nm) + "</b>…" : ' Closest match: <button type="button" class="pcs-b pri" data-cl>' + esc(nm) + "</button>")
        : " Try other words, or ask in Help &amp; issues."));
      const cl = box.querySelector("[data-cl]"); if (cl) cl.onclick = () => pick(closest);
      if (autoGo && closest) setTimeout(() => { if (back) pick(closest); }, 1200);
      return;
    } finally { clearTimeout(stopT); aiAbort = null; }
    if (!back) return;
    if (!picked.length) {
      say("<b>✨ Nothing in this extension does that yet.</b><div class=\"pcs-sm\">If you think it should, suggest it in Help &amp; issues.</div>" +
        '<div class="pcs-row"><button type="button" class="pcs-b pri" data-hub>Open Help &amp; issues</button></div>');
      box.querySelector("[data-hub]").onclick = () => pick(GUIDES.find((g) => g.id === "issue"));
      return;
    }
    say("<div class=\"pcs-sm\">✨ Best match" + (autoGo ? " - taking you there\u2026" : "") + "</div>" + picked.map((g, i) =>
      '<div class="pcs-aig"><b>' + esc(g.type === "task" ? "Task: " + g.text : g.title) + '</b><div class="pcs-a">' + esc(g.type === "task" ? [g.client, g.status].filter(Boolean).join(" \u00b7 ") : g.a) + '</div><button type="button" class="pcs-b pri" data-g="' + i + '">Go there</button></div>').join(""));
    box.querySelectorAll("[data-g]").forEach((b) => { b.onclick = () => pick(picked[Number(b.dataset.g)]); });
    // Enter on a question: straight to the best match after a moment to read it.
    if (autoGo) setTimeout(() => { if (back && picked[0]) pick(picked[0]); }, 900);
  }
  window.PcmSearch = { open, flash, _parse: parseSmart, _label: smartLabel, _guides: GUIDES, _locate: locate };
})();
