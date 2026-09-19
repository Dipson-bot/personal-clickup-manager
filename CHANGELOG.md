# Changelog

## v3.4.0
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
