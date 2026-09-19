# Daily Login — Auto-Login + Reminder (multi-account)

A Manifest V3 browser extension (Chrome / Edge) that keeps your **daily Agent
Router login** going for **one or more GitHub accounts**, so you keep getting the
daily free credit without doing it by hand.

It can run in two modes:

- **Auto-login** — for each saved account it opens Agent Router, clicks **Sign in
  with GitHub**, fills your username + password, generates your **2FA (TOTP)**
  code, clicks **Authorize**, and confirms you're logged in. Between accounts it
  clears the GitHub/Agent Router session and repeats.
- **Reminder only** — just opens the login page once a day and lets you finish by
  hand (this is what the original version did).

Per-account status (done / pending / needs-you) is shown in the popup, and can
optionally be mirrored to a tiny hidden file in your Google Drive.

---

## ⚠️ Please read before using auto-login

- **Your credentials are stored on this machine.** To log in unattended, the
  extension must keep each account's GitHub **password** and **TOTP secret** in a
  form it can decrypt by itself. They are AES-obfuscated at rest, but because the
  key lives beside the data this is **obfuscation, not real security** — anyone
  with access to this browser profile could recover them. Don't reuse important
  passwords; treat these as throwaway-ish accounts.
- **2FA support is TOTP only.** Authenticator-app (6-digit) codes work because the
  extension can generate them from the secret. **SMS, passkeys, and security keys
  cannot be automated** — those will pause for you to finish.
- **GitHub may still block automation.** A "verify your device" email prompt, a
  CAPTCHA, or a new-device challenge can appear, especially when logging several
  accounts in and out quickly from one IP. When that happens the extension
  **stops on that account, leaves the tab open, and marks it "Needs you."**
- **Terms of service / ban risk.** Automating logins and farming a daily credit
  across multiple accounts may violate GitHub's or Agent Router's terms and could
  get accounts flagged or suspended. Use at your own risk. If you're not
  comfortable with any of the above, use **Reminder only** mode.

---

## Install

1. Open `chrome://extensions` (or `edge://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select this `daily-reminder-extension` folder.
3. The extension keeps a fixed ID via the `key` field in `manifest.json` — don't
   remove that field.

## Add your accounts

1. Click the extension icon → **Manage** (opens the options page).
2. For each GitHub account, fill in:
   - **Label** — any name for you (e.g. "Work GitHub").
   - **GitHub username or email**.
   - **Sign-in method** — how this account logs into GitHub:
     - **GitHub password** — the extension auto-fills the username/password (and
       TOTP, if present).
      - **Sign in with Google** — the account has no GitHub password; GitHub signs
        in via Google. The extension can **not** automate Google's login page, so
        on each run it clicks the "Continue with Google" button, then **waits**
        while you finish the Google sign-in in the open tab (the only manual
        step). Once you land back on GitHub, the extension **auto-continues**:
        it fills the GitHub 2FA code (if a TOTP secret is saved) and clicks
        Authorize. Leave **password** blank for these accounts.
   - **GitHub password** (only for the *GitHub password* method above).
   - **TOTP secret** — the authenticator "setup key". This is the base32 string
     GitHub shows when you set up an authenticator app (see below). Leave blank if
     the account has no 2FA.
3. Make sure **Mode** is set to **Auto-login** and the **Agent Router login URL**
   is correct (default `https://agentrouter.org/login`), then **Save settings**.

### Getting the TOTP secret for an account

The extension needs the same secret your authenticator app uses:

- When setting up 2FA on GitHub (**Settings → Password and authentication →
  Authenticator app**), click **"enter this text code"** (or "setup key")
  instead of scanning the QR. Copy that base32 string into the **TOTP secret**
  field.
- If 2FA is already set up and you didn't save the secret, you can't read it back
  from GitHub — reconfigure the authenticator app to get a fresh secret, and save
  it in both your authenticator and here.

## Daily behavior

- On browser startup and every ~30 minutes, the extension checks whether each
  enabled account is still inside its **24-hour window** from the last successful
  login. Agent Router only grants the daily credit after a full ~24h gap, so an
  account becomes eligible again 24 hours after it last logged in — not at
  midnight. If an account is eligible (and you're online), it runs the login flow
  in a background tab, on its own, with no button press.
- After the counter ("Resets in 22h 25m") reaches zero, expect it to run within
  about half an hour. To run sooner, use **Run** (one account) or **Run all now**
  in the popup.
- If **Notify me when a daily login finishes** is on (Settings), you'll get a
  short desktop notification summarizing the run (e.g. "2 logged in · 1 needs
  you").
- On a slow or unreliable connection, turn on **Slow / unreliable connection**
  in Settings — it waits longer on each step and adds a buffer between logging out
  and back in, so a switch doesn't fail just because the network was momentarily
  slow.
- Extensions only run while the browser is open — if the browser is closed at
  the moment an account becomes eligible, the run happens the next time you open
  it.

## The popup

- A row per account with a status dot: **green** = done today, **amber** = not yet,
  **red** = needs you (finish in the open tab), **blue** = logging in now.
- Under each account's label it shows which identity signed in — the username you
  entered, and once a login succeeds, the **email GitHub reports for that account**
  (captured automatically) so you can tell multiple accounts apart at a glance.
- **Run all now** / per-account **Run** — trigger a login immediately.
- **Manage** — open the accounts & settings page.
- **Drive sync** — optionally sign in with Google to mirror status across
  browsers/machines (see below).
- **Reset status** — clears the recorded login status for all accounts, so they
  become eligible to run again right away (useful for testing or forcing a re-run).
- **Time estimate · due today** — once you've connected ClickUp (see below), a
  panel shows the summed **time estimate + tracked time of your tasks due today**
  versus your daily goal, with a progress bar and a ⟳ to refresh on demand. Polls
  every 5 minutes for near real-time numbers.

## ClickUp — daily time estimate & tracking (optional)

If you track work in ClickUp, the extension can add up the **time estimate on the
tasks due today that are assigned to you** and tell you whether you've reached a
daily goal (default **7 hours**) — the total that ClickUp itself only surfaces to
admins and team leads. It's **read-only**: it never creates, edits, or moves
anything in ClickUp.

**Connect it (one-time):**

1. In ClickUp, click your avatar (top-right) → **Settings** → **Apps**. Under
   **API Token**, click **Generate**, then **Copy** — it starts with `pk_`.
2. In the extension, open **Manage** → the **ClickUp — daily time estimate &
   tracking** card, paste the token, and click **Save & connect**.
3. Pick your **Workspace** (auto-selected if you only have one), set your **daily
   target**, optionally add **weekly deadline task URL(s)**, and set the **nudge
   hour**, **workday end hour**, and notification toggles, then **Save settings**.
   **Refresh now** pulls the current numbers and shows the per-task breakdown.

**What "today" means:** tasks whose **due date is today** (your local day) and
which are **assigned to you**. Closed tasks and subtasks are included so the total
matches what you'd get adding them up by hand. Tasks with no estimate are counted
and called out separately ("2 without an estimate").

**Weekly deadline tasks (÷5):** a single task that spans the whole work week (e.g.
a "weekly standup prep" or an ongoing Monday–Friday commitment) can count toward
every weekday. Paste its **ClickUp task URL** (e.g.
`https://app.clickup.com/t/36162007/86eyrpk3c`) — one per line — in the *Weekly
deadline task URL(s)* field. The task's total estimate is **divided by 5** and
added to **each weekday's** (Mon–Fri) daily total; on weekends it counts as 0.
The deadline task's tracked time also adds to the "tracked" figure on weekdays.

**Where you see it:**

- **Popup panel** — "Time · estimate & tracked" shows total estimate vs. target,
  a progress bar (amber → green when met), a summary line (task count, est/target,
  tracked total, deadline-task contribution, last-updated clock), and a scrollable
  per-task list showing **each task's estimated AND tracked time** (deadline tasks
  shown in their own ÷5 section).
- **Toolbar badge** — shows progress (e.g. `5h`, or a green `✓` when the goal is
  met). A login that **needs you** always takes priority over the estimate; you
  can turn the badge off in the card.
- **Progressive desktop reminders** — each fires at most once a day, in order:
  1. **Halfway** — at 50% of target (e.g. 3.5h of 7h).
  2. **Almost there** — at ~86% of target (e.g. 6h of 7h).
  3. **Target reached** — the moment you hit 100% of target.
  4. **Under target** — after your chosen **nudge hour** if still short.
  5. **Workday ending** — after your chosen **workday end hour** (default 16:00 /
     4 PM) if still short, as a final end-of-day warning.
  All are optional and individually toggleable in the card.

The numbers refresh on browser startup and every **5 minutes** for near real-time
tracking, or on demand with the ⟳ in the popup / **Refresh now** on the options
page.

**Notes & limits:**

- The token is stored **obfuscated on this machine** (same as your other secrets)
  and is only ever sent to `api.clickup.com`. **Disconnect** on the card wipes it;
  you can also revoke it anytime from ClickUp's API Token page.
- For a task with **multiple assignees**, ClickUp's API returns the task's full
  estimate (not a per-person split), so shared tasks count their whole estimate.
- The token is **not** included in Drive sync or the encrypted backup — it lives
  only in the browser where you entered it.

## Import 2FA secrets from authenticator apps

Tired of typing base32 setup keys by hand? Import them straight from your
authenticator app's JSON export. On the options page, the **Import 2FA secrets**
card accepts:

- **Aegis** — the `.json` backup/export (TOTP entries only). Use a **plaintext**
  export (no password): a password-protected Aegis export is re-encrypted and
  can't be read here.
- **Ente Auth** — its `.json` export (OTP-auth URIs).
- **Google Authenticator** — its `.json` export.

Pick the file, **Parse file** to preview what was found, choose a **default mode**
(Auto-login or Reminder) that applies to the imported entries, then **Import**.
Entries are matched to existing accounts by username **or** by TOTP secret to
avoid duplicates; new ones are added as new accounts (you'll need to add a
password for Auto-login). You can also toggle each account's mode afterward.

If auto-detection misses an entry, each preview row has an **Assign to** dropdown:
pick an existing account to attach that secret to it, or **Create new account** to
force a fresh one. The import then applies your choice instead of guessing.

> **Microsoft Authenticator** doesn't allow exporting TOTP secrets, so there's no
> file to import. To move such an account, re-enable GitHub's authenticator 2FA
> once to reveal a fresh setup key, then paste it manually.

## Debug — GitHub login / logout

The **Debug** card on the options page lets you test the GitHub auto-login and
logout flows on demand (no waiting for the daily run):

- Pick an account (accounts with a TOTP secret are listed first), then **Test
  login** — it runs the full flow in a visible tab and streams each step
  (navigate → fill username → fill password → 2FA → authorize → verify) with the
  captured GitHub handle / email / Agent Router user as a checklist.
- **Test logout** clears the GitHub + Agent Router session cookies (keeping
  GitHub's device-trust cookie) and reports exactly what was cleared.

This is handy for verifying a freshly-imported 2FA secret or a new account before
you rely on it for the daily run.

## Moving your accounts to another browser: Backup & restore

Google Drive sync (below) only mirrors **status**, never your credentials — so a
second browser knows a login already happened but can't perform one itself. To
actually move your accounts (username + password + TOTP secret) to another
browser or computer without retyping them, use **Backup & restore** on the
options page:

- **Export** — pick a passphrase (6+ characters) and click **Export backup…**.
  You get a `.json` file whose secrets are encrypted with that passphrase using
  PBKDF2 + AES-GCM. The passphrase is **never stored anywhere** — if you lose it,
  the file can't be opened, so keep both safe.
- **Restore** — on the other browser, open the options page, choose the file,
  enter the same passphrase, and click **Restore backup**. **Merge** (default)
  adds new accounts and updates matching ones; **Replace all current accounts**
  wipes the local list first. A wrong passphrase or a non-backup file is rejected
  with a clear message.

Because the backup contains real credentials, treat the file like a password:
don't email it to yourself in plain sight, and delete it once you've restored.

## Optional: Google Drive sync

The extension works fully without this. If you sign in with Google, per-account
status is mirrored to a tiny hidden file in your Drive's **appData** area (it
cannot see or touch your real Drive files). This is handy if you run the same
setup in more than one browser.

Setup (one-time, ~5 min): create a Google Cloud project, enable the **Drive API**,
configure an **OAuth consent screen** (External, in Testing, add your own email as
a test user), and create an **OAuth client ID** of type **Web application** with
this authorized redirect URI:

```
https://<your-extension-id>.chromiumapp.org/
```

Then put the client ID into `GOOGLE_CLIENT_ID` at the top of `lib-drive.js`.
(The current file already contains a client ID; replace it with your own if you
want sync tied to your own Google project.)

---

## Files

| File | What it does |
|------|--------------|
| `manifest.json` | Permissions, module service worker, options page. |
| `background.js` | Account storage (encrypted), status, daily trigger, badge, messaging, ClickUp estimate refresh + notifications. |
| `lib-automation.js` | The login state machine + the page selectors (edit here if sites change). |
| `lib-crypto.js` | TOTP generation (RFC 6238), AES-GCM at-rest obfuscation, and passphrase-based (PBKDF2) encryption for backup export/import. |
| `lib-drive.js` | Optional Google Drive status sync. |
| `lib-clickup.js` | Read-only ClickUp API v2 client: verifies the token, sums the time estimate of tasks due today, and handles weekly deadline tasks (estimate ÷ 5). |
| `popup.html` / `popup.js` | Status overview + run buttons + ClickUp estimate/tracked panel. |
| `options.html` / `options.js` | Add / edit / remove accounts, settings, ClickUp setup, 2FA import, and GitHub login/logout debug. |

## When a site changes its page (fixing selectors)

Auto-login depends on the structure of GitHub's and Agent Router's pages. If a
site is redesigned and login stops working, open `lib-automation.js`:

- **`SELECTORS`** — CSS selectors for the GitHub username/password/submit fields,
  the 2FA code field, and the **Authorize** button. Add or adjust selectors here.
- **`classifyUrl()`** — how the extension recognizes which page it's on by URL.
- **`inj_getAndNavigateToGithubOAuth()`** — builds the GitHub OAuth URL directly
  (fetches the `state` token from Agent Router's API and reads `github_client_id`
  from the page's global state), then navigates the tab directly — this avoids
  Chrome's popup blocker that would block `window.open()` from an injected script.
- **`inj_clickAgentRouterGitHub()`** — fallback that clicks the "Sign in with GitHub"
  button; may be blocked by Chrome's popup blocker.

Each step also has a timeout and falls back to leaving the tab open, so a broken
selector degrades to "finish it manually" rather than hanging.

## Troubleshooting

- **"Needs you" on an account** — open the extension's open tab and complete
  whatever GitHub is asking (device code, CAPTCHA, etc.), then it's marked done.
- **2FA code rejected** — check the TOTP secret is correct and your computer's
  clock is accurate (TOTP is time-based).
- **Nothing happens on schedule** — the browser must be open; also confirm the
  account is enabled and Mode is Auto-login.
- **Reset for testing** — use **Reset status** in the popup to force a re-run.
- **ClickUp says "Couldn't reach ClickUp" / token rejected** — regenerate the
  token in ClickUp (Settings → Apps → API Token) and paste it again; make sure you
  copied the whole `pk_...` string. If the total looks wrong, click **Refresh now**
  and check the per-task list — only tasks **due today** and **assigned to you**
  are counted, and shared tasks count their full estimate.

## Remove / disable

- **Disable:** toggle it off in `chrome://extensions` / `edge://extensions`.
- **Remove:** click **Remove** on the card. This deletes locally stored (obfuscated)
  credentials with it.
- **Revoke Google Drive access (if you used sync):**
  https://myaccount.google.com/permissions
