# ClickUp Tracker (desktop)

A small always-on-top timer window for ClickUp, the desktop companion to the
Personal ClickUp Manager extension. It does what the extension's floating
tracker does, without the browser's limits: it stays exactly where you put it,
can be see-through, and keeps running with the browser closed.

- The running task, the mood face, time against the estimate, today's total.
- Point at it for the task name, client, Stop / Done, ⇄ Extra and a comment box
  (Enter posts; Ctrl+V pastes a screenshot; drop files or use the paperclip).
- ⤢ opens a bigger view: time-entry note, comment box, the latest comments
  (new ones from others marked NEW). Click blank space or ⤡ to shrink it back.
- A red 💬 badge when someone else comments on the running task (checked every 3 minutes).
- No timer: your next tasks due today, Start Extra Task, Resume last.
- Tray icon: show/hide, size (Normal / Compact), see-through level, daily target,
  start with the computer, change token, quit.

The ClickUp token is encrypted by the operating system (Windows DPAPI, macOS
Keychain, Linux keyring) and only sent to ClickUp. The window never sees it.

## Run from source

```
cd desktop-tracker
npm install
npm start
```

## Build

- Windows: `npm run dist` → `release/ClickUp Tracker Setup <version>.exe`
- macOS / Linux: run the "Desktop tracker build" GitHub Action by hand, or
  `npm run dist:mac` / `npm run dist:linux` on that system.

The builds aren't code-signed, so Windows SmartScreen shows "Windows protected
your PC" (More info → Run anyway) and macOS needs right-click → Open the first time.

If `npm run dist` on Windows fails with "Cannot create symbolic link", turn on
Developer Mode, or unpack electron-builder's winCodeSign archive once into
`%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0` (the two
macOS link errors can be ignored).

## Updates

The app checks this repo's GitHub releases tagged `desktop-v<version>` and adds
"Update available" to the tray menu.
