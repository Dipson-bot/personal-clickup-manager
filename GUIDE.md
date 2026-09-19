# Your Daily Helper — Simple Guide

This little browser add-on does two helpful things for you every day:

1. 📊 **Keeps an eye on your ClickUp work hours** — so you always know if you've
   hit your daily target.
2. 🔑 **Logs you into Agent Router automatically** — so you keep getting your
   free daily credit without lifting a finger.

You can use just one part, or both. Here's what each does, in plain language.

---

## 📊 Part 1: ClickUp time tracker (the main feature)

**The problem it solves:** In ClickUp, it's hard to see *"how many hours of work
am I supposed to do today, and how much have I actually done?"* Normally only
managers can see that easily. This add-on adds it up for you.

**What it shows you:**

- All the tasks **due today** that are **assigned to you**, added together.
- How that compares to your **daily goal** (for example, 7 hours).
- A **progress bar** that turns green when you've hit your goal.
- Your **tracked time** (the hours you've actually logged) next to each task.

It only *reads* your ClickUp — it never changes, moves, or deletes anything.

### Friendly reminders during the day

The add-on can gently nudge you with a small pop-up message:

- ⏳ **Halfway there** — when you're at 50% of your goal.
- 🎯 **Almost done** — when you're close to your goal.
- ✅ **Goal reached** — the moment you hit your target.
- 🔔 **Still behind** — a nudge later in the day if you're running short.
- 🕔 **Winding down** — a final heads-up near the end of your workday.

You can turn any of these on or off. There's also a handy alert when a task you're
actively timing is **about to reach its estimate** (e.g. "10 minutes left on your
1-hour task") — you don't even have to stop the timer for it to notice.

### How to set up ClickUp (one time only)

1. In ClickUp, click your **profile picture** (top-right) → **Settings** → **Apps**.
2. Under **API Token**, click **Generate**, then **Copy**. (It's a long code
   starting with `pk_`. Think of it as a read-only pass that lets the add-on peek
   at your task hours.)
3. Click this add-on's icon → **Manage** → find the **ClickUp** card → paste the
   code → **Save & connect**.
4. Pick your **Workspace**, set your **daily target hours**, and you're done.

The numbers refresh on their own every 5 minutes, or you can hit the **↻ refresh**
button any time.

---

## 🔑 Part 2: Agent Router auto-login

**The problem it solves:** Agent Router gives you a free credit each day, but only
if you log in. Logging in every single day gets tedious — especially with more
than one account. This add-on does it for you.

**What it does:** Once a day, for each account you've saved, it quietly opens
Agent Router, signs in with your GitHub account (including the 6-digit
authenticator code), and confirms you're in — all on its own, in the background.

**Three simple choices per account:**

- 🟣 **Auto login** — the add-on logs in for you automatically.
- 🟡 **Reminder** — it just opens the login page and lets you finish by hand.
- ⚪ **Off** — skip this account entirely.

You can change any account's choice with one click on the Manage page or set it
per account.

### What you'll see

Open the add-on's popup to see each account at a glance:

- A colored dot: **green** = done today, **amber** = waiting, **red** = needs your
  help, **blue** = logging in now.
- **"Credited 12:16 PM"** — the exact time your daily credit landed, so you know
  when it'll renew tomorrow.
- Your current **balance**, kept fresh in the background.
- A **Run** button to log in right now, and a **trash** button to remove the account.

### How to add an account

1. Click the add-on icon → **Manage**.
2. Fill in a **label** (any nickname), your **GitHub email/username** and
   **password**, and your **2FA setup key** (if the account uses an authenticator
   app).
3. Set the **Mode** (Auto login / Reminder / Off) and **Save**.

---

## A few honest notes

- **Your passwords stay on your computer.** They're scrambled, but not bank-grade
  secure — so please use throwaway-style accounts, not your important ones.
- **Only app-based 2FA works** (the 6-digit authenticator kind). Text-message
  codes, passkeys, and physical security keys can't be automated — the add-on will
  pause and let you finish those by hand.
- **GitHub might occasionally ask you to verify** (a "is this you?" email or a
  puzzle). When that happens, the add-on stops, leaves the tab open, and marks the
  account **"Needs you"** — just finish it in the open tab.
- **Automating logins is at your own risk.** It may go against GitHub's or Agent
  Router's rules. If that worries you, use **Reminder** mode instead of Auto login.

---

## Handy extras

- **Backup & restore** — move your accounts to another computer using a
  password-protected file. (Manage page → Backup & restore.)
- **Google Drive sync** *(optional)* — remembers across your browsers that today's
  login already happened. It only touches a tiny hidden file, never your real
  Drive documents.
- **Something not working?** The Manage page has a **Debug** section where you can
  test a login step-by-step and see exactly where it stops.

---

*This is a personal-use browser add-on. If a website changes its design and login
stops working, the more detailed [README.md](README.md) explains how to fix it.*
