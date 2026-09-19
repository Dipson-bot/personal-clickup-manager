# Personal ClickUp Manager

A Chrome / Edge extension that turns ClickUp into a **daily time-budget coach**: it
knows how many hours of work are due today, how much you've actually tracked, and
nudges you before the day gets away from you — without keeping a ClickUp tab open.
It also keeps optional side-jobs on autopilot: an **Agent Router daily-login
helper** and a **client-site uptime monitor**.

> Built for people who live in ClickUp all day (agencies, freelancers, SEO / dev
> teams) and want answers to *"am I on track today?"* in one glance.

---

## Why use this instead of just ClickUp?

ClickUp is where the work lives. This extension answers the questions ClickUp makes
you dig for, **from your toolbar**:

| You want to know… | In ClickUp alone | With this extension |
|---|---|---|
| How many hours of work are due **today** vs my daily target | Build a filtered view, add up estimates yourself | Headline number + progress bars, always current |
| How much have I **tracked today** vs estimated | Open timesheets, compare manually | Estimated vs tracked bars side by side |
| Multi-day tasks: how much of a 5-day task is **today's share** | Not shown | Estimate split across the task's working days automatically |
| Am I falling behind? | You notice at 6 PM | Desktop nudge in the afternoon if you're under target, chime when you hit it, **danger alarm** when a running timer passes its own estimate |
| What's **overdue and still not complete**, across every date | Custom view + filters | One tick: "Deadline crossed" |
| Tasks due on a **specific day or date range** | Rebuild filters each time | Custom date / range picker in the filter menu |
| Start / stop / complete a task, or **edit its estimate** | Open the task | One click on the row, synced back to ClickUp |
| Which **client** a task belongs to, **priority**, **due date** at a glance | Open each task | Client chip, colour-coded priority badge (U / H / N / L), due-date chip |
| Week at a glance: estimated vs tracked, day by day | Reports / dashboards | "This week" bars + a collapsible day-by-day breakdown |

Everything is computed from your own ClickUp data with **your personal API token**;
nothing is sent anywhere except ClickUp (and, if you turn it on, your own Google
Drive).

---

## Features

**ClickUp time tracking (main feature)**
- Today's estimate vs daily target, tracked vs target, "target met" badge on the toolbar icon.
- Filter menu: Due today / tomorrow / this week / next week / **custom date or range**,
  Client, Status, Priority, Missing estimate, **Missing due date**, Has time tracked,
  **Deadline crossed** (overdue and not complete, all dates). Switch between
  **One at a time** and **Multiple** selection.
- Tasks sorted by **priority** (Urgent → High → Normal → Low), with client, due-date and
  priority badges.
- Click any estimate to edit it; the change is saved to ClickUp with a sync spinner.
- Per-task Start / Stop / Complete; the auto-detected "Extra Tasks" timer.
- Weekly totals (to today / to Friday) and a day-by-day breakdown.
- Reminders during office hours, idle nudges, milestone chime, over-estimate danger alarm.

**Agent Router daily-login helper (optional)**
- Logs each of your accounts in once every 24 hours (GitHub + 2FA/TOTP) in a background
  tab that never steals focus, closes its tabs when done, and tracks each account's
  $25 daily-credit checkpoint.
- Quota-batch reminders, with the release schedule **auto-synced** from Agent Router's
  own announcement.

**Client site uptime monitor (optional)**
- Checks your client sites every 5 minutes and notifies you once when one goes down.
- "Auto-detect from ClickUp" suggests each client's website for you to confirm.

**Everything else**
- Options page with a sidebar: Dashboard, ClickUp setup, Agent Router, Site monitor, General.
- Light / dark theme, optional Google Drive sync, passphrase-protected backup and restore.
- **Built-in update check**: you're notified when a new version is released.

---

## Install

1. Download the latest **`personal-clickup-manager-vX.Y.Z.zip`** from the
   [Releases page](../../releases/latest) and unzip it into a folder you'll keep
   (for example `Documents\personal-clickup-manager`).
2. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the unzipped folder.
4. Click the extension's icon → **Manage**, open **ClickUp setup**, paste your ClickUp
   personal API token (ClickUp → avatar → Settings → Apps → API Token) and pick your workspace.

## Updating to a new version

The extension checks GitHub for new releases about twice a day. When one is out you get
a notification, an **"Update available"** banner in the popup and a chip on the options
page (Options → General → *Version and updates* also has a **Check for updates** button).

1. Download the new zip from the release.
2. Unzip it **over the same folder** (replace the files).
3. In `chrome://extensions`, click the reload icon on the extension.

Your accounts, settings and ClickUp connection are stored in the browser, not in the
folder, so they are kept.

> Chrome only updates extensions *fully automatically* when they come from the Chrome
> Web Store. Publishing there is possible later; until then, updates are the two-minute
> "download, unzip, reload" above.

---

## Privacy and security

- Your ClickUp token, Agent Router account passwords and 2FA secrets are stored **only in
  your browser**, encrypted at rest (AES-GCM). They are never in this repository.
- Network calls go only to ClickUp, Agent Router / GitHub (for the login helper), your
  monitored sites, GitHub's release API (update check) and — only if you sign in — your
  own Google Drive.
- Google Drive sync is tied to the author's Google Cloud project. If you install your own
  copy and want Drive sync, create your own OAuth client and put its client ID in
  `lib-drive.js` (and remove the `key` field from `manifest.json`).

## Agent Router helper — please read

The login helper automates *your own* accounts with *your own* credentials. Automating
logins or claiming credits across several accounts may be against Agent Router's or
GitHub's terms of service and could get accounts restricted. It is off unless you add
accounts; use it at your own risk.

---

## For maintainers: releasing a new version

1. Bump `"version"` in `manifest.json` (for example `3.2.0` → `3.3.0`) and add a line to
   `CHANGELOG.md`.
2. Commit and push.
3. Run `./release.ps1` in PowerShell. It checks the JavaScript, builds
   `dist/personal-clickup-manager-vX.Y.Z.zip` with only the files the extension needs,
   tags the commit and publishes a GitHub Release with the zip attached (requires the
   GitHub CLI: `gh auth login`).

Installed copies see the new release within ~12 hours (or immediately with *Check for
updates*).

More detail on every feature: [docs/DETAILED-GUIDE.md](docs/DETAILED-GUIDE.md) ·
simple walkthrough: [GUIDE.md](GUIDE.md).
