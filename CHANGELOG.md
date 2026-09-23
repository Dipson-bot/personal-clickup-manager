# Changelog

## v3.9.5
- Fixed: the Tasks card's Export could send the Explore tasks list instead (for example a "Due this week" export came out with Explore's "Today" tasks). Each section now exports its own list.
- New: Client report. Turn on "Client report" in any Export menu (Tasks or Explore tasks) to get a version you can send to the client: internal work like the Extra Task and monthly container tasks is left out, task codes (ACT-054) become the plain-language titles and explanations from the client's audit file, subtasks roll up into one line per piece of work with progress (for example "2 of 4 steps done"), and each line shows the page, status (Completed, In progress, Planned) and date. Each report is for one client ("Report for" picks which), so other clients' work never goes into it; attach that client's audit once and it is remembered. Works for CSV, Excel, Markdown, Google Sheets and Google Docs, and follows the filters you applied.
- Improved: the task details AI uses the client's remembered audit automatically.
- Improved: "Ask with" no longer gets stuck on a long question. Long questions are copied and the AI site opens ready for Ctrl+V.
- Fixed: exports dropped subtasks of subtasks (for example ACT-025.S1 under ACT-025 under a monthly task). They are now included.
- New: task details dropdown. Click the small arrow at the left of any task to see its ClickUp description (with clickable links), attachments and comments, and post a comment to the task without opening ClickUp. "Explain this task" uses Chrome's built-in AI, which runs on your own computer: free, no key, no limits, and the task text stays on your computer. Attach files for more detail (Word, Excel, PowerPoint, CSV, HTML, Markdown, text and screenshots) with the Attach button, Ctrl+V or drag and drop. "Ask with" sends the question to ChatGPT, Claude, Perplexity or Copilot, or copies it for Gemini, OpenCode Desktop or any other AI, and remembers your choice. A big audit file is not sent whole: only the parts about the task are used, found by the task code in its name (for example ACT-066) or, without a code, by the words in its name.
- New: Custom order. Turn on the "Custom order" switch at the top of the Filter menu and drag tasks by the handle on the left into the order you want to work on them. Each date filter (due today, due tomorrow, due next week and so on) remembers its own arrangement. Works in the popup, side panel and options page.
- Fixed: false "Site down" alerts. The site monitor now checks your own internet connection first, so a PC that just woke up or lost Wi-Fi no longer reports every client site as down. It waits up to 30 seconds for a site to answer and tries 3 times, 20 seconds apart, before counting a failure (the same approach as UptimeRobot and Pingdom), and failures only count when they happen back to back.
- New: "Check all now" and a Check button per site in Site monitor, plus Add, Edit and Delete buttons. Each site shows how fast it answered, or why it failed.
- Changed: in the tracking bar, Stop now comes before Complete, and Complete is hidden while the Extra Task is being tracked, so the recurring Extra Task can't be completed by mistake. It can still be completed from its row in the task list.
- Improved: task lists are resized with a drag bar under the list instead of the small corner handle, and can't be stretched taller than their tasks. Double-click the bar to reset.
- Improved: the Filter menu header is compact and stays at the top while you scroll the menu. "Clear all" no longer turns Custom order off.
- Improved: the Due today card shows one short summary line instead of three long ones, and the This week card shows a Mon-Fri chart of estimated vs tracked time.
- Improved: "Reload extension" and "Set version & reload" reopen the page you were on after the restart.
- Improved: Admin release notes are filled in automatically from the changelog.

## v3.9.4
- Fixed: the end-of-day wrap-up now opens by itself at your wrap-up time (4:45 PM by default) instead of only showing a notification that was easy to miss. If the computer was asleep or Chrome was closed at that time, it opens as soon as Chrome is running again (up to 4 hours late). It still runs once per weekday and never twice.
Fixed: the wrap-up reminder could be skipped for the day when the extension woke up just after the wrap-up time. It now always fires.
Improved: updating in Brave. Instead of the error "showDirectoryPicker is not a function", the update page now explains that Brave has folder access turned off and gives an "Open Brave setting" button. Choose Enabled, click Relaunch, then Install.
Improved: on computers where folder access is blocked (for example by a work or school IT policy), or in browsers without it, the update page now says so plainly and points to "Download the zip instead".

## v3.9.3
- Fixed sync issues in options page estimate time

## v3.9.2
- Fixed tracking buttons i.e Stop and Complete button in all panels

## v3.9.1
- **Fixed: the Site monitor looked like it had stopped.** It was checking every 5 minutes all along, but only saved its result when a site changed between up and down, so a site that stayed up kept showing an old "last check" time. Every check is now saved, and a check can no longer be cut off halfway.
- **Changed: a ClickUp rate limit no longer shows as a red error.** It now reads "ClickUp is busy. Showing totals from HH:MM, refreshing automatically." and the task list stays on screen. Real problems, like a bad token, still show in red.
- **New: the version number** is shown next to the title in the popup and the options page.
- Task times on each row are now in bold, so they are easier to scan.

## v3.9.0
- **New: Daily Tasks Update on the wrap-up page** (replaces the old standup). It lists every task you closed today, in every project, grouped under "Project Name" with "Complete (N)", and puts the links from each task's description after it as "Click Here 1, Click Here 2". Copy keeps those links clickable when pasted into Slack; Refresh reads today's completed tasks again.
- **New: exports include each task's links.** CSV and Google Sheets get Link 1, Link 2 ... columns (one clickable address per cell), Excel shows them as "Click Here" links, and Google Docs and Markdown get a Links line under each task.
- **New: stretch the task list.** Drag the bottom-right corner of the task list in the popup, side panel, options page or Explore to make it taller or shorter; each remembers its height, and a double-click on that corner puts it back.
- **Fixed: a link could appear twice, once broken.** Links written with underscores came through with backslashes in them from ClickUp; they are now cleaned up, so each link appears once and works.

## v3.8.10
- fixed the uploading new version buffer timings to all users

## v3.8.9
- Fixed search functionality and calendar on due dates

## v3.8.8
- **New: see who each task is assigned to.** Every task shows its assignees as small initials in coloured circles next to the name; hover a circle for the full name. Two people show as two circles, three or more as one circle plus "+2" (hover lists the rest). Each person keeps the same colour everywhere, and the columns stay lined up.
- **New: "Only tasks shared by everyone ticked" in Explore's Pick people.** By default you see tasks assigned to any of the people you tick; tick this to see only the tasks they are all assigned to together. Totals, export and the title follow.
- **New: an "All" box under Client in the Filter menu** ticks or clears every client at once.
- **Changed: tasks with more than one assignee show a dimmed Start button.** They can only be started in ClickUp; hovering or clicking the button says so instead of trying.
- **Fixed: the options page Dashboard list didn't follow the filter.** With clients ticked it now groups tasks under each client like the popup does, and its heading names the chosen dates instead of always saying "Tasks today".
- **Fixed: more space between clients** in the grouped list (popup, side panel and options), with a divider, so it's clear which tasks belong to which client.
- **Fixed: finished tasks were out of line with the rest of the list.** They had no button column, so their client, due date and time shifted right; they now line up.

## v3.8.7
- **Fixed: an Agent Router login could freeze, and Stop didn't stop it.** If a request to Agent Router stalled, the login waited forever: the page sat still, the extension kept saying it was running, Stop only changed its own label, and the Run buttons stayed greyed out even after the tab was closed. Every step now has a time limit, Stop ends a run within about a second, closing the tab ends it straight away, and Run all no longer moves on to the next account after Stop. If Agent Router's page stops responding, the run ends with a message saying so.
- **Fixed: Pick people seemed to do nothing when you ticked someone.** Ticks only counted after pressing a "Show tasks" button, and clicking anywhere else threw them away. A tick now takes effect straight away, the tasks load a moment after you stop ticking (or as soon as you close the list), and "Show tasks" is now "Done".
- **Fixed: the Explore Client list only showed the clients in the current results.** It now lists every client in the workspace, refreshed once a day, with no duplicates for the same client spelled slightly differently.
- **Fixed: the Extra Task could briefly drop out of today's total** (6h 48m instead of 8h 12m) when a single request to ClickUp failed. If it loaded fine earlier in the day, that result is kept; if not, the card now says it couldn't load the task instead of showing an unnamed row.
- The popup header now reads "Personal ClickUp Manager".

## v3.8.6
- **New: pick any mix of people in Explore.** Choose "Pick people…" in the Department menu, tick people from any departments, then press Show tasks. Export takes exactly those people, and the title shows who is included.
- **Fixed: hitting the ClickUp rate limit much less often.** The Due today list asked ClickUp about every task separately on each refresh; those answers are now remembered for two minutes, and anything you change from the extension still shows immediately. Department views no longer search each teammate's entire task list when they have no Extra Task. If the limit is ever hit, the service worker console now says how many requests were made and where.
- **Fixed: Group subtasks did nothing under Due today.** It worked for every other date filter; now it works for all of them.
- **Fixed: the Explore Client list only showed some clients.** It now lists every client in the date range and department, and the checkboxes narrow the tasks rather than the list.
- **Fixed: the popup scrolled sideways while a task with a long name was being tracked.** The name now ends in "…" instead of widening the popup.
- **Fixed: the "can't start, assigned to multiple users" message squashed the task row.** It now sits on its own line under the task, with an Open in ClickUp link and a button to dismiss it.
- **Fixed: a harmless "Department Creator: No users found" warning showed up as an extension error.**

## v3.8.5
- **Fixed: the wrong copy of the recurring Extra Task could be shown.** A recurring task exists as one occurrence at a time and ClickUp rolls it forward, so several copies are visible at once. The extension searched a fixed current-week window and took whichever copy it saw first, which is how an occurrence from the previous week, already marked complete, ended up listed against tomorrow with the right hours but the wrong link. It now looks at every copy around the day in question and picks the one whose own dates actually cover that day, preferring one that is not finished.
- **Fixed: a task that has already been completed can no longer carry hours for a future day.** When no copy covers the day yet, the weekly share is still filled in from the most recent unfinished copy, and swaps to the real one as soon as ClickUp creates it.
- **Fixed: v3.8.4 could fail to start on some installs** ("Service worker registration failed"). A stray fragment was left in one of the files.

## v3.8.4
- **Fixed: the recurring Extra Task's daily share really does show everywhere now.** v3.8.2 and v3.8.3 fixed the plumbing around it but not the cause: the share was read out of the dates of the one occurrence ClickUp had created, so any weekday outside those dates came back as zero. Because a recurring task rolls forward one occurrence at a time, that hid the task from "Due tomorrow" whenever tomorrow fell in the next week, and from the week and range views with it. A recurring Extra Task is a weekly allowance, so every weekday now gets its share. A one-off task you configure by URL still counts only inside its own start-to-due dates.
- **Fixed: ClickUp reminders fired at night and at weekends.** "Under your daily estimate", halfway, almost there, target reached and the end-of-day warning had no day or hour check at all, so one could arrive at 10:30pm on a Sunday. They now follow the same Office hours as the "are you working?" reminder: Monday to Friday, between the start and end hours in Tracking settings (8am to 5pm by default).
- **Fixed: the "Due tomorrow" card blanked to 0m for a couple of seconds every time you opened the popup,** and the toolbar badge disagreed with it. Tomorrow's numbers were fetched by the popup itself, so they started empty on every open, and the badge, which cannot see that, was reading a different figure. They are now worked out once in the background and shared, so the card appears straight away and the badge always matches.
- **Fixed: "ClickUp rate limit hit" after opening the popup a few times.** Each open rebuilt the weekly, this-week, next-week and tomorrow figures from scratch. Opening still picks up anything you just changed in ClickUp, but at most once a minute.

## v3.8.3
- **Fixed properly: the recurring Extra Task (and any multi-day task) was missing from every view except Today.** Those tasks carry a share of their estimate on each day they run, but "Due tomorrow", "Due this week", "Due next week" and custom ranges filtered strictly by due date and dropped them. "Due tomorrow" is now its own one-day query, so it shows the same share Today does, and the week and range views keep them as well.

## v3.8.2
- **Fixed: "Due tomorrow" left out the recurring Extra Task** (and anything else that starts tomorrow but is due later). Those tasks are due another day, so the due-date rule skipped them, even though their estimate is divided per day and tomorrow owns a share. That share is now included, as it already was for today.

## v3.8.1
- **Fixed: changes made in ClickUp took up to an hour to show in "Due tomorrow", "This week" and "Due next week".** Those views were behind a 60-minute cache that the automatic 5-minute sync never refreshed. The cache is now 15 minutes, and opening the popup, the side panel or the options page rebuilds them immediately.

## v3.8.0
- **New filter: "Group subtasks under their parent"** - each parent is followed by its own subtasks, indented, in ClickUp's order (S1, S2, S3). It rearranges only the tasks already listed; a subtask whose parent is not in view stays where it is. Off by default.
- **Your own default filters:** "Save as my default" remembers the ticked filters and the One at a time / Multiple mode, and "Use my default" brings them back in one click. A new install (or another computer, via Drive) starts from that default.
- Tasks with the same priority AND the same estimate now sort by name, so ACT-025.S1 comes before ACT-025.S3 instead of following ClickUp's arbitrary order.

## v3.7.5
Markdown export now shows a suggested working order, ClickUp dependencies (waiting for / blocks), who is holding a task up, priority and estimate, and warns when two tasks share a name.

## v3.7.4
- Publishing now updates the repository too

## v3.7.3
- First release published from the extension itself, using the new Admin panel.
- Admin: **Choose folder…** right in the panel, so setting the version no longer sends you to another page.
- Admin: refuses to package a version that does not match the one running, instead of warning and carrying on.
- Admin: the version box now shows the installed version, since that is what gets published.

## v3.7.2
- The admin GitHub token is now part of the Google Drive backup, so a reinstall or a second computer restores it instead of asking for it again. It travels inside the same encrypted file as your other logins, and there is a switch in Admin > GitHub access to keep it on this computer only.

## v3.7.1
- Fixed: clicking **Admin** in the sidebar went to the Dashboard instead of opening the Admin panel.

## v3.7.0
- **Admin tools** (Options > General > Features > "Show Admin tools", off by default): publish a new version straight from the extension. It packages the files it is running, then either uploads the release with your GitHub token or opens GitHub's new-release page with the tag, title and notes filled in. "Set version & reload" writes the new version into manifest.json, and "Mark as important" makes everyone's update reminder come back every 4 hours instead of daily.
- **Markdown export** next to CSV, Excel, Sheets and Docs: saves a .md file and copies it to the clipboard. Available from the popup, the side panel, the options ClickUp card and Explore tasks.

## v3.6.2
- **You decide what a week is** (Options > ClickUp setup > Tracking settings > "A week runs"): Sunday to Saturday (default), Monday to Sunday, Monday to Friday or Sunday to Thursday. It drives "Due this week", "Due next week", Explore's week view and the Week column in exports.
- **Week views now show their dates**, e.g. "this week - Sep 20 to Sep 26", so there is no guessing which days are included.

## v3.6.1
- **Fixed: "Due tomorrow" always showed nothing.** It searched the today list, which by definition holds no tasks due tomorrow; it now reads this week and next week (so it also works on a Saturday). On the options page the same filter was additionally forgotten on reload, missing from the filter count and skipped by Clear all, and the toolbar badge ignored it. All fixed.

## v3.6.0
- **Clear all filters** in one click: in the Filter menu (popup, side panel, options) and a Clear filters button in Explore tasks.
- **Export the tasks you're looking at.** An "⤓ Export" button next to Filter (popup, side panel, options and Explore tasks) writes whatever the list currently shows, with your filters applied: **CSV**, **Excel**, **Google Sheets** or **Google Docs**. The sheet uses the team layout: column A "main" / "sub task", column B the task, main rows bold. Optional "include subtasks" and "include details" (client, due, estimate, tracked, status, link).
- **Edit a due date from the list**, the same way estimates work: click the date chip, pick a date, Enter. Rows with no due date show "+ due"; clearing the box removes the date.
- **Explore tasks: Client filter**, alongside department and teammate, with totals that follow the choice.
- Subtasks now carry their Task info too (ClickUp does not send descriptions with a subtask list, so each is fetched), a rate-limited task is retried once, and the export says if any task could not be read.
- Google Docs export reads as a document: title, a heading per task with status and week, its info as paragraphs, subtasks as bullets, with spacing between tasks.
- **Export layout is now fixed and complete:** main / sub task · Task · Task info · Status · Week. Task info, status and due date are read from ClickUp itself at export time, subtasks sit under their real parent,. Google Sheets exports are plain (Google converts CSV without carrying formatting); the Excel export keeps its styled header and bold main rows.
- Export refuses to write an empty file: if the view has no tasks it says so, with the view name, instead of producing a header-only sheet.
- Google exports can be shared straight away: "anyone with the link can view" is ticked by default (untick it to keep the file private).
- The Agent Router schedule notification now shows your local time next to Beijing time (e.g. "10:00 & 19:00 Beijing = 7:45 AM & 4:45 PM Kathmandu").
- Google Sheets export now really is a Sheet: Drive can only turn HTML into a Doc, so Sheets exports upload CSV instead (Docs keeps the formatting). The export also fails loudly instead of leaving an empty file.
- Drive sync remembers which Google account you connected and renews quietly for that account, instead of asking you to sign in again when several accounts are signed in.
- The site list shows when it was last saved to Google Drive.
- **Roll back to an older version.** The updater page lists every published version with its date, and installs the one you pick. Your settings are kept.

## v3.5.1
- **Fixed: Agent Router "last credit" not updating.** After a reinstall the extension lost the balance it compares against, so a successful login after the 24-hour window was not recorded as the credit. Now such a login always counts, and records affected by this are repaired automatically.

## v3.5.0
- **Side panel.** Click ⇥ in the popup header (or right-click the extension icon > Open side panel) to keep your task list open next to any website. It no longer closes when you click elsewhere.
- **Away time protection.** Come back after 15+ minutes away from the computer (idle or locked) with a timer still running, and one notification asks: *Remove away time* or *Keep it*. Removing ends the entry when you left and restarts the same task now (same note). Ignoring it keeps the time.
- **Smarter "not tracking" reminder.** It stays quiet while you are away from the computer, and has a *▶ Start* button for your most important open task due today.
- **End-of-day wrap-up** (weekdays, default 16:45). One notification opens a small page with tracked vs target, today's open tasks with a one-click *→ Tomorrow* (Fridays: → Mon, same time of day), and a Slack-ready standup (Done / Next / Blocked) you can edit and copy. A 📋 button in the popup opens it after that time.
- **Notification bell 🔔** next to the dark/light button (popup, side panel, options): turn all notifications off, **Pause 1 hour** (lunch, meetings; resumes by itself), or switch single reminders on/off. Shows 🔕 while muted or paused.
- **Note on the task you're tracking.** The "Tracking now" strip has a note box: type e.g. "task completed" or "meeting time" and press Enter. It becomes that time entry's Description in ClickUp, so it's saved before you stop, complete or switch tasks. The Extra Task note can now be edited while it runs, too.
- **Choose how often it syncs with ClickUp** (Options > ClickUp setup > Tracking settings): 2, 3, 5 (default), 10, 15 or 30 minutes. 2 minutes is the safe minimum for ClickUp's rate limit.
- **Wrap-up is always one click away:** the 📋 button shows all the time, and the wrap-up page has its own reminder on/off and time.
- Dark/light switch on the options page is now a clean pill button (no underline), with a matching round 🔔.
- **Fixed: Agent Router skipped a day.** A login inside the 24-hour window (for example a manual run late in the evening) pushed the next automatic login 24 hours past itself. Now only the last credited login counts.
- **Google Drive now also backs up the client site list**, theme, filter choices and custom sounds, so a reinstall brings them back. Each item keeps its own timestamp, so the newest copy wins. Changes are pushed to Drive within seconds.
- **Paste your whole client site list at once:** one per line as `Client name | website` (or `Client, website`, or just the website). Names match your ClickUp client spelling.
- ⇥ (side panel) and 📋 (wrap-up) buttons also on the options page; ⇥ now comes before 📋.
- **Softer light mode:** grey-tinted background and cards instead of pure white.
- In the side panel, **⇄** opens Chrome's setting to show the panel on the left or right.
- New settings under Options > ClickUp setup > Settings: away minutes, wrap-up on/off and time, plus an *Open now* link.

## v3.4.0
- **Start Extra Task: Custom or Meeting.** Pick "Meeting" for a one-click meeting timer, or "Custom" with an optional note; it's saved as the time entry's description in ClickUp. The choice and note stay in sync between the popup and the options page.
- **Your own notification sounds** (Options > General > Notifications and sound): a file (MP3, WAV, OGG, M4A/AAC, WebM, up to 1 MB) or a direct link, for each of the three sounds, with preview; falls back to the default if it can't play.
- **Agent Router is optional**: hidden unless you turn it on (Options > General > Features); existing users with accounts keep seeing it.
- **"Waiting on others"**: a task whose part is done by you but has a subtask assigned to someone else that's still open gets an amber "Waiting: Name" chip; it turns red "Blocked: Name late" once that subtask is overdue. Hover for details, click to open the blocking subtask in ClickUp. New "Waiting on others" filter in the Filter menu.
- **"Tracking now" strip** above the task list while a timer runs: task name, live time and a Stop button (hidden when nothing is running).
- Fixed subtask lookup (the old request returned unrelated tasks), which also powers the "subtasks of due-today tasks" list.
- Cleaner rows: fixed client, due-date and status columns (the task title takes the rest), and time shown as "tracked / estimate" (red past the estimate, dot while the timer runs).

## v3.3.1
- Maintenance release (used to verify one-click updates end to end). No functional changes.

## v3.3.0
- **One-click updates.** Choose the extension's folder once (offered right after install, or in Options → General → *One-click updates…*); after that every update is **Update now → Install**: the extension downloads the new version, replaces its own files and restarts, keeping all your settings.
- Safe by design: before writing anything it proves the chosen folder is the one Chrome is running (so a moved or copied folder is detected and you're asked for the new one), checks the package is the right version of this extension, and restores the previous files if anything fails.
- Update notifications stay available (re-shown after "What's new", daily reminder until installed) and confirm "Updated to vX" after restarting.
- Manual route still available: "Download the zip instead" on the update page.

## v3.2.0 — first GitHub release
- Options page redesigned: sidebar with Dashboard, ClickUp setup, Agent Router, Site monitor, General; status strip.
- Filters: custom due date / range, Missing due date, Deadline crossed (all overdue, not complete), One at a time / Multiple selection.
- Tasks sorted by priority with U / H / N / L badges, client and due-date chips.
- Click-to-edit estimates in popup and options with a sync spinner.
- Agent Router: background login tabs (no focus stealing), tabs closed after runs, correct daily-credit checkpoint, schedule auto-sync, optional access token for tab-less balance checks.
- Client site uptime monitor with "Auto-detect from ClickUp".
- Built-in update check against GitHub Releases.
