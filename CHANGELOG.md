# Changelog

## v3.10.2
- Fixed: Explore tasks with a custom date (for example one day) also listed multi-day tasks due days later, because they were in progress on that date, which looked like a wrong filter. A new "Due in this range only" tick box (on by default) now shows only tasks due inside the dates you pick, with their full estimates. Untick it to also see tasks that are in progress on those dates (with the part of their estimate that falls inside the range). Your choice is remembered.
- Improved: "Explain this task" with the free AI (Chrome's built-in one, and the online fallback) sticks much closer to the client's files. Every step now says where it came from (the task, or which file), steps follow the order the files give ("first... then..."), warnings and things to do beforehand (like "confirm with the client") get their own "Before you start" part, "Done when" is taken from the files, and "Not in the files" only lists what really isn't there. If the files name the site's platform (WordPress, Rank Math, Shopify and so on), the AI is told so it won't call it unknown. The built-in AI also answers less randomly. For the most precise answers, "Ask with" Claude or ChatGPT is still the best choice.
- New: write in a task's description, not just read it. In the task details (the ▶ next to any task in the popup, side panel or dashboard) click the ✎ Edit description button (or double-click the description); in the floating tracker's bigger view (⤢) the description is now a normal text box. Fill in things like File: "" with links or notes and Save (Ctrl+S). 📎 Add file (or paste a screenshot, or drop a file on the box) uploads it to the task and puts its link right where your cursor is, for example inside the quotes. Formatting is kept. If someone changed the description in ClickUp while you were writing, nothing is overwritten: you see their version and choose. In the floating tracker, unsaved changes survive shrinking it and are saved when you press Stop, Done or ⇄ Extra.

## v3.10.1
- New: Task files tab. Add each client's audit and reference files once (HTML, Word, Excel, PowerPoint, PDF, CSV, Markdown, text or screenshots; drop them on the client or use + Add files). "Explain this task" then automatically uses the parts of that client's files that are about the task - shown as 📁 chips in the task details, so you can see what's used and leave one out - and names the file its answer comes from instead of guessing. The client report uses a client's HTML audit from here too. The files' text is backed up to your Google Drive (hidden app data), so a new computer or a reinstall gets them back; screenshots stay on the computer. Clients with no files yet are marked.
- New: PDF files can now be read for "Explain this task" (Attach, and Task files).
- Fixed: "Install updates automatically" could stay ticked while nothing ever installed, with no message. It needs a one-time setup on each computer (choose the extension's folder and pick "Allow on every visit"), and without it every try quietly waited. Now, when a new version can't install for that reason, you get one notification with "Set up automatic updates" and "Install this update now".
- New: Bulk edit finds what's missing. Choose "Any date (all open tasks)" to see tasks with no due date too, then the new "Missing" filter shows only tasks with no due date, no start date or no estimate (for example, pick a client and "No due date"). Every row now shows its start date, due date and estimate; click any of them to set it for that one task ("+ start", "+ due", "+ est" mark what's missing). Start date can also be changed in bulk, and Undo covers it.
- New: new-comment alert on the floating tracker. While a timer runs, the tracker checks that task's comments every 3 minutes; when someone else comments, a red 💬 badge with the count appears on its corner. Click it to open the bigger view, where the new comments are marked NEW. Your own comments, and comments from before you started, don't count.
- New: comment with screenshots and files right from the small floating tracker. Point at it, type a comment and press Enter; paste a screenshot with Ctrl+V, drop files on the tracker or use the paperclip (it shows how many are attached, ✕ clears them). Anything still waiting is posted when you press Stop or Done. No need to expand it (Compact size keeps the comment box in the ⤢ view).
- New: bigger floating tracker. Click ⤢ in the floating tracker and it grows into a task view: a comment box (paste screenshots with Ctrl+V, drop files or click Attach; the files are added to the task and linked in the comment), the time-entry note, the latest comments and the description. Click any blank space or ⤡ Smaller to shrink it back to where it was.
- Improved: a warmer, softer light mode. Cream "paper" backgrounds and softer brown-toned text instead of cool blue-grey and near-black, and off-white boxes instead of bright white, easier on the eyes over a long day. Everywhere: popup, side panel, dashboard, wrap-up, update page and the floating tracker. Dark mode is unchanged.
- New: Compact floating tracker. Options > General > Floating tracker > Size: Compact makes it shorter and narrower so it covers less of your screen (the comment box and client name move to the ⤢ view). Takes effect the next time you open the tracker.
- New: Google Drive full warning. If your Drive doesn't have room, the Task files backup pauses and you get one notification a day (also when any Drive sync is refused because the Drive is full), with a button to Google Drive's storage page. Drive Sync > "Where is it saved?" shows how much of your Drive is used.
- Improved: with no timer running, the floating tracker suggests your next tasks due today (most urgent first) with a ▶ to start each, besides Start Extra Task and Resume last.
- Fixed: the "Time tracking hasn't started yet" reminder could offer to start a task that isn't due today (it followed whatever Filter you had on). It now only suggests tasks due today.
- Fixed: keeping the side panel open all day blocked automatic updates completely. They now install once you've been away from the computer for a few minutes, the same as with an open dashboard tab.

## v3.10.0
- Fixed: the task you're tracking could show a different time in its list row (for example 5m) than in the Tracking now bar and the floating tracker (20m), because the row kept the number from when the list was last loaded. The row now keeps counting by itself, with no extra ClickUp requests, and the floating tracker rounds minutes the same way as the dashboard.
- New: "↩ Back to task" in the floating tracker. After switching to the Extra Task (for a meeting, a client call or anything else), one click stops the Extra Task and restarts the task you were on. "Resume last" also goes back to that task instead of the Extra Task.
- New: Bulk edit tab. Pick tasks by range (overdue, today, tomorrow, this week, next week or your own dates), client, status or name, tick the ones you want, and change their due date (set a day, move by a number of days, or clear it), status, priority or estimate in one go. You confirm first, each task shows ✓ or ✗, and Undo puts the old values back. To change just one task, click its date: the same calendar as on the dashboard opens (keeps the time of day; Clear removes the date).
- New: search everything with Ctrl+K (⌘K on a Mac), the Search button at the top of the Options sidebar, or 🔍 in the popup. It finds any section or setting (and takes you straight to it), your loaded tasks, and quick actions like the wrap-up, the floating tracker and bulk edit. It's forgiving: spaces don't matter ("agentrouter"), small typos are fine ("agnet router"), and short forms work ("blkedt").
- New: the floating tracker's full view (point at it) shows the task's client and has a note box, the same as "Add a note to this time entry" in the popup: the note goes into your ClickUp Timesheet's Description. It saves on Enter and is saved automatically when you press Stop, Done or Back to task, so you can leave a note on a task before completing it, or on the Extra Task (for example what the meeting was about) before stopping it. The window opens a little taller to make room.
- Improved: the floating tracker never shows Done for the Extra Task (recognised by its name as well), so it can't be completed by mistake and make ClickUp create next week's copy early.
- New: "Move all to date…" on the end-of-day wrap-up, next to "Move all to Tomorrow". Pick any day and every task still open today moves there, keeping its time of day.
- Improved: with clients ticked in the Filter, each client's tasks now sit in their own card (with the client's estimate and tracked time at the top), so the groups are easy to tell apart in the dashboard, popup and side panel. Custom order dragging still works inside each card.

## v3.9.9
- Improved: the ClickUp setup page is much easier to read. Tracking settings are grouped into Daily goal, Reminders, Celebrations, Weeks and syncing, and Tasks and clients, with each setting on one short line and its number right in the sentence (for example "Warn me 10 minutes before a running task reaches its estimate"). Long explanations now sit behind small "How does this work?" links.
- New: floating tracker. Click "⧉ Float" in the Tracking now bar (popup, side panel or dashboard) and a small window stays on top of every app: the task you're tracking, a bar towards its estimate and a face that goes from sad when you start, to happy right on the estimate, to grumpy once you go over. Point at it for the task name, today's total and Stop / Done; with no timer running it offers Start Extra Task or Resume last. Drag it by its top bar and resize it from a corner. Chrome needs one click in a small pinned tab to show it, and keeps it while that tab is open. Settings in Options > General > Floating tracker. Works in Chrome and Edge 116 or newer.
- New: switch to the Extra Task straight from the floating tracker. Point at it and click "⇄ Extra": one click on Meeting starts the Extra Task with the note "Meeting", or type a quick note and press Enter. Your current timer stops first. "Start Extra Task" (when no timer is running) opens the same quick note.
- New: Drive Sync > "Where is it saved?" explains that your synced data lives in your Google Drive's hidden app data (a private area only this extension can open, not a folder in My Drive), lists exactly what is saved with sizes and dates, and opens Google Drive settings, where you can see or delete it.

## v3.9.8
- New: the team's client websites are added to everyone's Site monitor automatically. Monitoring stays off until you tick "Enable site monitoring", so only people who turn it on get site-down alerts. Delete any site you don't need; deleted sites don't come back, and your choices are kept in Drive when Drive sync is on. Auto-detect now uses the same list, so each client gets its correct website. The list is managed in Admin ("Client sites for everyone") and is stored encrypted, so only people connected to the team's ClickUp workspace can read it.
- Improved: in the popup's full-size task details, clicking anywhere outside the task card goes back, just like the Back button and Esc.
- Improved: the update page now shows exactly what to click before Chrome asks about the extension's folder (Select Folder, Edit files, then "Allow on every visit"), so it's done once and updates install by themselves after that. If Chrome forgot the permission (usually because "Allow this time" was picked), the page says so and a new "Allow folder access" button fixes it without choosing the folder again.
- New: setup checklist. Until everything is ready, the dashboard shows "Setup: 3 of 5 done" (connect ClickUp, Drive sync, automatic updates, notifications, pin to the toolbar) with a button for each missing step, and the popup shows a one-line reminder. It disappears once you're done, or hide it yourself.
- New: Copy diagnostics (Options > General > Help & diagnostics). Copies a short report of what's set up and the last errors, without passwords, tokens, emails, links or client names, to paste to whoever helps you.
- New: keyboard shortcuts. Alt+Shift+1 starts or stops the timer (it resumes the task you stopped last, or the Extra Task), Alt+Shift+2 opens the popup, Alt+Shift+3 opens the dashboard (on a Mac: Control+Shift+1/2/3). Change them with "Change shortcuts" in Options > General.

## v3.9.7
- New: "Rewrite each line in plain language with AI" in the Export menu's Client report. Each line of the report is rewritten into a short title and a 1-3 sentence summary a client understands (what was done and why it helps), without task codes, staff names, tool or file names, or links. Works for CSV, Excel, Markdown, Google Sheets and Google Docs. It uses Chrome's built-in AI when your computer can run it, otherwise the free online AI after asking once; any line the AI can't rewrite keeps the normal report wording. Pick which AI does it from the list under the option: Automatic, Chrome's built-in AI, the free online AI, or your own AI (ChatGPT, Claude, Perplexity, Copilot, Gemini, OpenCode or any other). With your own AI, the report file is saved as usual and that AI opens with the report and the rewrite instructions ready (or copied for Ctrl+V when it's long); your choice is remembered.
- New: livelier visuals. The Estimated and Tracked bars rise smoothly and a soft light flows along them (a little faster once a target is met); the This week chart grows in day by day and a day lifts with a small card (estimated, tracked, % of target) when you point at it; totals count up to their new value; and the toolbar icon shows a progress ring of today's tracked time (green when you hit your target). Each can be turned off in Options > General > Animations and effects, or all at once with "Turn all animations off" for slower computers.
- Fixed: "Reload extension" reopened the page in the background, so you landed on a different tab. It now comes back in front, on the same section. After installing an update from the update page, that page now closes and the dashboard opens.
- New: milestone animations. Fireworks when you reach halfway, almost there, and a bigger show when you hit your daily target; a little rain cloud when the day falls short (the late-afternoon "under your estimate" and end-of-day warnings). They play in the popup, side panel or options page, and when none of them is open a small notification-style card pops up in the bottom-right corner (it doesn't take the keyboard) and closes itself. They last 3 seconds by default; choose 2 to 10 seconds in Options. Milestone notifications now carry a matching picture. There's also a new end-of-day notice when your estimate is met but your tracked time is still short. With the side panel open, the animation plays inside it; the pop-up card still appears when you're working in another program or another Chrome window. Turn the animations or the pop-up card off in Options, and preview both with the new buttons there (previews also play in an open side panel).
- Improved: in the popup, a task's details now open in a full-size view with a Back button, so you can read them without stretching or scrolling a small box. In the side panel and options page the list grows by itself to show the open details, and goes back to its size when you close them.
- New: automatic updates. New versions now install by themselves in the background (Options > General > "Install updates automatically", on by default), at a moment you're not using the extension, and any open extension pages reopen afterwards. It needs a one-time setup on each computer: choose the extension's folder once and pick "Allow on every visit" when Chrome asks. The Admin panel sets how long after a release it waits before installing (1 hour by default; important releases go straight away).
- Fixed: while "Explain this task" was writing its answer, the task list could scroll down by itself. It now stays where you left it, in the popup, side panel and options page.
- Improved: every Export menu (popup, side panel, the options Tasks card and Explore tasks) can be dragged anywhere by its title bar, and it opens above the button when there isn't room below, so it's never cut off at the bottom of the window.
- Improved: an "Explain this task" answer is remembered for that task and shows straight away in the popup, side panel and options page, with when it was made. If the task has changed in ClickUp since, it says so, so you can explain it again.

## v3.9.6
- Fixed: Custom order dragging and the stretch bar didn't work when a client was ticked in the Filter (the list grouped by client). Tasks can now be dragged within their own client's group, and the options page shows the stretch bar for the grouped list too.
- New: "Explain this task" now also works on computers that can't run Chrome's built-in AI. It uses Pollinations.ai, a free public AI with no key or sign-in, and asks once before sending the task text online.
- Improved: in a client report, a task without a code that names one of the audit's actions (for example a "Review ..." task) is now counted as a step of that action instead of getting its own line.

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
