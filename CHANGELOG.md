# Changelog

## v3.6.0
- **Export the tasks you're looking at.** An "⤓ Export" button next to Filter (popup, side panel, options and Explore tasks) writes whatever the list currently shows, with your filters applied: **CSV**, **Excel**, **Google Sheets** or **Google Docs**. The sheet uses the team layout: column A "main" / "sub task", column B the task, main rows bold. Optional "include subtasks" and "include details" (client, due, estimate, tracked, status, link).
- **Edit a due date from the list**, the same way estimates work: click the date chip, pick a date, Enter. Rows with no due date show "+ due"; clearing the box removes the date.
- **Explore tasks: Client filter**, alongside department and teammate, with totals that follow the choice.
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
