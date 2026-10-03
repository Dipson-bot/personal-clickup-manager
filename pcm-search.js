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
      keys: "multiple several all today tasks reschedule postpone move deadline status priority estimate missing dates batch tag tagged label comment note reason why teammate someone else's others assignee owner admin workspace search find people person name",
      a: "Open Bulk edit, pick the tasks (search, or tick them), choose what to change - due date, status, priority or estimate - and apply it to all of them in one go. It can also fill in missing dates. The filters are off until you use them: \"Filter missing\" is unticked to start with, so a range lists every task in it, and you only narrow it to the tasks with no due date, no start date or no estimate when you tick it and say which. Pick \"By tag\" to load every open task carrying a tag, chosen from a list of all the tags in your ClickUp workspace (so the spelling always matches), tick only the ones you want, and give a reason (e.g. \"the client asked to push it a week\"): the same comment is then added to every task you change, and \"Select none\" clears the ticks. \"Whose tasks\" switches the whole card to a colleague: type part of a name (or an email) in the search box, click the person, and every range and the tag filter then list only their tasks, the confirmation says whose they are, and the comment starts with who made the change. It appears for workspace Owners and Admins (a plain member sees a note instead); if your own role is member-level, save a workspace Owner or Admin token in ClickUp setup to unlock it. If a colleague is not in the list at all, keep typing their name - the extension asks ClickUp who that is and offers them if any of their tasks name them; anyone they add stays in the list, so you can keep searching for other people afterwards. While it is asking, the box says \"Asking ClickUp for ...\" rather than claiming nobody matches, and a name that matches nobody still shows you the people who are there. The list is never emptied by a search or by a re-read: if ClickUp is slow, refuses the request or is still building the list, the names you already had are kept and a note beside the search box says so. The ↻ next to the search box re-reads the whole member list." },
    { id: "clientfiles", title: "Keep files and attachments organised by client", tab: "files", card: "Clients - files & notes",
      keys: "organize sort folder documents audit pdf screenshot upload store client name list drive copy preview thumbnail image picture view enlarge",
      a: "Open Clients: every client (its ClickUp List name) has its own card. Add files there (audits, PDFs, screenshots). Pictures show a thumbnail you can click to see them big over the page (with \"Open in a new tab\", and Esc or a click outside to close); other files keep their icon. Each file has Open and Show in folder (saves a copy to Downloads › Personal ClickUp Manager › Clients › client), and ☁ Copy to Drive puts a client's files in My Drive › Personal ClickUp Manager › Clients." },
    { id: "clientnotes", title: "Write notes about a client", tab: "files", card: "Clients - files & notes",
      keys: "note memo remember client instructions told watch out edit change correct fix typo rewrite update note inline screenshot preview image thumbnail attach add remove delete file link url clickable google doc sheet paste",
      a: "Open Clients, open the client's card and write a note. You can paste screenshots, attach files and tick ⏰ Remind me at to get reminded. Screenshots on a note show as thumbnails - click one to see it big (Esc or a click outside closes it, or open it in a new tab). A web address you paste into a note becomes a link you can click (a Google Doc, a Sheet, anything http or https) - here and in a task's details. To change a note, press Edit on it: the note becomes a text box right where it is, with Save and Cancel under it (Ctrl+Enter saves, Esc cancels), and what you type is kept if the list redraws while you are typing. While it is open you can also change its files - 📎 Attach, or paste with Ctrl+V, or drop files on the note to add more, and ✕ on a file to take it off. Nothing is written until you press Save, so Cancel puts the files back as they were. A task's details show its client's notes." },
    { id: "clientpin", title: "Pin the clients you work with most", tab: "files", card: "Clients - files & notes",
      keys: "pin pinned favourite favorite important top star priority order sort stick client",
      a: "Open Clients and press the 📌 on a client's row: it moves to the top of the list with a marked edge. Press it again to unpin. Pin several and the newest pin sits on top, the rest of the clients stay in their usual order underneath. Pins are saved with your settings, so they follow you to your other computers." },
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
    { id: "replaceaudit", title: "Replace a client's old audit with a new one", tab: "files", card: "Clients - files & notes",
      keys: "replace audit new month august september update file client files swap old audit keep both",
      a: "Clients › open the client › press Replace next to the old file and pick the new one. Or attach the new audit in any of the client's tasks (📎 Attach) and press Replace <old file> (or Keep both - the newest counts as current)." },
    { id: "verify", title: "Verify a task in OpenCode, Claude Code, Codex or any AI", tab: "dashboard", here: true,
      keys: "verify review check done fixed developer opencode claude code codex audit dependencies where change code resolve cache nocache",
      a: "Open the task's details (the ▸ at the start of its row) and press 🧪 Verify in OpenCode. It copies the whole task (description, subtasks, comments, links) with the client's audit and the verify rules; paste it with Ctrl+V into OpenCode, Claude Code, Codex or any AI. Attach the client's audit HTML once (📎 Attach in any of the client's tasks, or Clients) - it's saved to the client, otherwise the AI asks you for it first." },
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
    { id: "trktoday", title: "See how much of the tracked time is from today", tab: "dashboard", here: true,
      keys: "today tracked today only cumulative all time how much tracked today bar chip share of bar daily total earlier days per task task row pill tracking now floating tracker float pip window bar colour color lighter band multiple days several days extra task recurring task confusing total",
      a: "When your filter reaches further than today (This week, Due tomorrow, a custom range, or Deadline crossed, which counts all the time ever tracked on those tasks), the Tracked Time bar says how much of that total is from today: a small \"31m today\" chip sits next to the label, and the light part at the start of the bar is today's share. The darker part is the rest of the filter. On Due today there is no chip, because that bar is already today only. Each task says the same thing on its own: a task you have worked on across more than one day shows a \"31m today\" pill beside its tracked total - in \"Tracking now\", on the task row and in the floating tracker, on the Options page, in the popup and in the side panel - so the bigger figure is plainly everything ever tracked on that task rather than today's. The floating tracker's own bar shows it too: the lighter band at the start of the fill is today's share of that task's tracked time, and pointing at it says it in words (\"Today 1h 2m of 6h 50m on this task\"). A task you started and finished today has nothing to tell apart, so it gets no pill and no band." },
    { id: "chartday", title: "See one day's tasks from the weekly chart", tab: "dashboard",
      keys: "chart bar graph day monday click tasks completed that day",
      a: "On the dashboard, click a day in the This week chart: the Tasks card below lists that day's tasks. Use Back to my filter to return." },
    { id: "plan", title: "Plan my week: reach my weekly target and order my tasks", tab: "insights/plan",
      keys: "review reviews dev developer incoming review task plan week planner weekly target 35 hours capacity estimate suggestion fill week day by day order dependencies what to do first schedule next week",
      a: "Insights › Plan: how full this or next week is against your target (working days × daily target, holidays left out), realistic estimates for tasks without one (from how long similar finished tasks took), tasks you could start early to fill the week, and a day-by-day order that puts dependencies and earlier audit steps first. Developers' dev tasks count as the short review that comes back to you (expected on their due day). It changes nothing in ClickUp." },
    { id: "asktasks", title: "Find tasks by asking in plain words (who, client, when, done or due)", tab: "dashboard", here: true,
      keys: "find search tasks completed last month previous week client person user teammate colleague someone else upcoming week due done finished show me what did yesterday last friday next tuesday since overdue quarter weekend recently",
      a: "Press Ctrl+K and type a sentence such as \"tasks I completed last month for Acme Dental\" or \"Sam's tasks due next week for Bright Roofing\". The first result says what it understood; press Enter to list the tasks (with estimate and tracked time). Remove a chip (✕) to widen it. Someone else's tasks need a workspace Admin token in ClickUp setup." },
    { id: "applyplan", title: "Show one day of my plan in my task list", tab: "insights/plan",
      keys: "apply plan day tuesday task list filter order today plan show planned tasks back to my filter",
      a: "Insights › Plan › Day by day: press Apply to my task list on a day. The dashboard, popup and side panel show exactly that day's tasks in the plan's order; Back to my filter (in the bar above the list) returns. Nothing changes in ClickUp." },
    { id: "themes", title: "Change the theme or colours (light, dark, palettes)", tab: "dashboard", here: true,
      keys: "theme dark light mode colour color palette ocean forest rose lavender slate midnight pine plum mocha appearance",
      a: "Click the moon / sun button at the top: switch light or dark and pick a palette for each (Ocean, Forest, Rose, Lavender, Slate; Midnight, Pine, Plum, Mocha). The popup, side panel and dashboard follow." },
    { id: "performance", title: "See my performance: 7-hour days, deadlines met, workload", tab: "insights/performance",
      keys: "performance analytics stats graph chart deadlines met late on time 7 hours per day target days tracked per week workload overloaded estimate accuracy time by client history",
      a: "Insights › Performance (only you see it): days you reached your daily target, average per day, deadlines met, how long tasks take against their estimates, tasks finished per week, workload ahead (overloaded over 110%), and where your time went per client - over the last 12 weeks. Click any number, bar or day to see the tasks and hours behind it." },
    { id: "insights", title: "See overdue, unestimated, blocked and upcoming work (Insights)", tab: "insights",
      keys: "insights overview health overdue missing estimate no due date blocked waiting subtasks dependency workload outlook by client problem clients analytics performance filter by client narrow search a list clickable number drill down worth a look health strip jump from dashboard only one client",
      a: "Open the Insights tab in Options: it shows how many of your tasks are overdue, due this week, missing an estimate or a due date, or blocked and waiting, plus a workload outlook for the coming weeks and a by-client table. Click any number to list the exact tasks behind it. In the By client table every count is a button: click a client's \"No est.\", Overdue or Blocked number and the list below opens showing only that client's tasks, and clicking the client name (or its Open count) narrows all four lists to them. Above the lists, a client picker and a search box let you pick a client and search within what's listed - task name, client and the reason a task is blocked are all searchable - and each heading says how much you're looking at, like \"Missing an estimate (30 of 55)\"; press Clear to see everything again. On the Dashboard the \"Worth a look\" counts are clickable too: press \"3 blocked\" or \"55 no estimate\" and you land in Insights with that list already open. Tasks blocked by their own open subtasks are flagged too, and the Dashboard shows a short health strip when you have overdue or blocked work." },
    { id: "extraclose", title: "Close the weekly Extra Task automatically on Friday", tab: "clickup", card: "Reminders",
      keys: "extra task close friday weekly recurring next week new extra task complete automatically end of week",
      a: "On by default: if your Extra Task is still open at 5 PM on its due day (Friday), it's marked complete so ClickUp creates next week's one (it waits while its timer runs). Switch it off in ClickUp setup with \"Close my weekly Extra Task at 5 PM…\"." },
    { id: "tidyreminder", title: "Get a daily reminder of overdue, unestimated or blocked tasks", tab: "clickup", card: "Reminders",
      keys: "tidy needs tidying daily reminder summary overdue unestimated no estimate no due date blocked dependency resolved remind 2pm nudge notify",
      a: "In Options > ClickUp setup > Reminders, tick \"Daily 'needs tidying' summary at\" and pick the time (2:00 PM by default), the days (weekdays by default) and which of the four lists to mention - overdue, no estimate, no due date, blocked. \"Name up to\" caps how many tasks each line lists, and you can also be told when a dependency was resolved so a blocked task can be finished. It sends one short summary a day that stays on screen until you click or close it; clicking opens Insights with the lists it mentions opened, stays quiet when there's nothing to tidy, and can be switched off from the bell menu too. Use Preview now to see it before it arrives." },
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
      keys: "agent router login account daily credit retry retries stopped failed wrong password not logging in needs you next try tries again backoff flagged rejected",
      a: "Open Agent Router, add your accounts, and it logs them in once a day by itself. A login that fails is tried again later, waiting longer each time - an hour, then six, then a day, then three days at most - so repeated failed sign-ins cannot get the GitHub account flagged. The account says when the next try is due. When the saved sign-in itself is the problem (wrong password, a 2FA code GitHub will not accept, a missing or invalid TOTP secret) it stops trying on its own and says so, because no amount of retrying would help: fix the account in Manage and press Run, or log in yourself in the tab it left open and press \"I logged in\"." },
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
          : it.type === "task" ? [it.client, it.due ? new Date(it.due).toLocaleDateString([], { month: "short", day: "numeric" }) : ""].filter(Boolean).join(" · ")
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
  window.PcmSearch = { open, _parse: parseSmart, _label: smartLabel };
})();
