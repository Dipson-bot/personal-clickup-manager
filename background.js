// background.js  (ES module service worker)
// -----------------------------------------------------------------------------
// Wiring: encrypted account storage, per-account status, the once-per-day
// trigger, the toolbar badge, and all messages from popup.js / options.js.
// -----------------------------------------------------------------------------

import { encryptJSON, decryptJSON, encryptWithPassphrase, decryptWithPassphrase, generateTOTP, totpSecondsRemaining } from "./lib-crypto.js";
import {
  getValidToken,
  signOut as driveSignOut,
  isSignedIn,
  mirrorToDrive,
  pullFromDrive,
  pushAccountsToDrive,
  pullAccountsFromDrive,
} from "./lib-drive.js";
import { runAllAccounts, runAccountLogin, URLS, GITHUB_KEEP_COOKIES } from "./lib-automation.js";
import { verifyToken, getTeams, fetchTodayEstimate, fetchWeeklySummary, fetchDateRangeEstimate, createTaskCache, fetchTeamMembers, fmtDuration, findExtraTaskByName, parseTaskIdFromUrl, getCurrentTimeEntry, getRunningTaskProgress, startTimer, stopTimer, getTaskById, setTaskStatus, taskUrlFor, clientLabelFromContainer, resolveSpaceNamesFor, taskContainer, cuPriorityName, isTaskDone } from "./lib-clickup.js";
import { resolveRelayKey, pickProbeModel, probeRelay } from "./lib-availability.js";

const CHECK_ALARM = "dailyLoginCheck";
const CLICKUP_ALARM = "clickupRefresh";
const SYNC_ALARM = "driveAutoSync";
const BALANCE_ALARM = "balancePoll";
const SITE_MONITOR_ALARM = "siteMonitor";

// ---------- Client site uptime monitoring ----------
// Lightweight, low-stress site monitoring. Only notifies on state CHANGE
// (up→down), never on "still up". Uses a debounce: a site must fail
// SITE_MONITOR_FAILURES consecutive checks before it's declared "down".
// Config lives in chrome.storage.local under "siteMonitorConfig".
const SITE_MONITOR_FAILURES = 2; // 2 consecutive failures = ~10 min at 5-min interval
const SITE_MONITOR_CHECK_TIMEOUT_MS = 5000; // 5s max per fetch
const SITE_MONITOR_PERIOD_MIN = 5; // check interval

async function getSiteMonitorConfig() {
  const { siteMonitorConfig } = await chrome.storage.local.get("siteMonitorConfig");
  return siteMonitorConfig && typeof siteMonitorConfig === "object" ? siteMonitorConfig : { sites: [], enabled: false };
}

async function setSiteMonitorConfig(cfg) {
  await chrome.storage.local.set({ siteMonitorConfig: cfg });
}

async function checkOneSite(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITE_MONITOR_CHECK_TIMEOUT_MS);
  try {
    // no-cors: the extension has no host permission for client sites, so a
    // normal (CORS) fetch fails for EVERY site and would report it "down". An
    // opaque no-cors response still proves the server answered; a real outage
    // (DNS/connect/TLS failure, timeout) rejects and lands in the catch.
    const res = await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store", redirect: "follow", signal: controller.signal });
    clearTimeout(timer);
    if (res.type === "opaque" || res.type === "opaqueredirect") return { ok: true, status: 0 };
    return { ok: res.status < 500, status: res.status };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String(e && e.message ? e.message : e) };
  }
}

async function checkSites() {
  const cfg = await getSiteMonitorConfig();
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.sites) || cfg.sites.length === 0) return;
  const now = Date.now();
  const state = (await chrome.storage.local.get("siteMonitorState"))["siteMonitorState"] || {};
  let changed = false;
  for (const site of cfg.sites) {
    if (!site || !site.url) continue;
    const key = site.url;
    const prev = state[key] || { up: null, fails: 0, lastCheck: 0, lastDownNotified: 0 };
    const result = await checkOneSite(site.url);
    prev.lastCheck = now;
    if (result.ok) {
      prev.fails = 0;
      if (prev.up === false) {
        // Site came back up - don't notify (user only wants down alerts)
        prev.up = true;
        changed = true;
      } else if (prev.up === null) {
        prev.up = true;
        changed = true;
      }
    } else {
      prev.fails = (prev.fails || 0) + 1;
      if (prev.fails >= SITE_MONITOR_FAILURES && prev.up !== false) {
        // Site went down - notify ONCE
        prev.up = false;
        prev.lastDownNotified = now;
        changed = true;
        await notify(
          "site-down-" + key + "-" + now,
          "Site down: " + (site.name || site.url),
          (site.name || site.url) + " is not responding (failed " + prev.fails + " consecutive checks).",
          "danger"
        );
      }
    }
    state[key] = prev;
  }
  if (changed) {
    await chrome.storage.local.set({ siteMonitorState: state });
  }
}

// ---------- existing alarm constants ----------
// Workspace list resolved from the saved token (options page), cached like the
// members roster so opening Options a few times doesn't chew the rate limit.
const TEAMS_CACHE_MS = 10 * 60 * 1000;
let teamsCache = { at: 0, teams: null };
// Roster build is deliberately ASYNC (one at a time): a message handler that
// awaits a multi-page ClickUp scan can outlive an MV3 service worker, which
// drops the reply and surfaces "No response from the extension." Instead the
// handler answers instantly from cache and this builder fills the state while
// the UI waits briefly and re-reads.
let rosterBuildPromise = null;
const MEMBERS_TTL = 3600000; // 1 hour
const EMPTY_MEMBERS_TTL = 2 * 60 * 1000; // retry soon when the roster was empty
// Auto-detected "Extra(s) Task(s)" per user, cached 1h so filtered department /
// all-user views don't re-scan every render. userId (string) -> { at, task }.
const EXTRA_TASK_CACHE_MS = 3600000;
const extraTaskCache = new Map();
// Filter queries can be expensive (per-user Extra Task discovery + a wide scope),
// so they run in the background with a keepalive; the CLICKUP_FILTER handler
// answers instantly with "" building "" and the UI polls for the cached result.
const FILTER_CACHE_MS = 5 * 60 * 1000;
const filterCache = new Map(); // key -> { at, data? , error? }
const filterBuilds = new Map(); // key -> in-flight promise
function startKeepAlive() {
  const iv = setInterval(() => { try { chrome.runtime.getPlatformInfo(); } catch (e) {} }, 8000);
  return () => clearInterval(iv);
}
function filterKey(assigneeIds, fromTs, toTs) {
  return [...assigneeIds].sort().join(",") + "|" + fromTs + "|" + toTs;
}
function cacheFilterResult(key, data) {
  filterCache.set(key, { at: Date.now(), data });
  if (filterCache.size > 40) {
    let oldest = null;
    for (const [k, v] of filterCache) if (!oldest || v.at < oldest.at) oldest = { key: k, at: v.at };
    if (oldest) filterCache.delete(oldest.key);
  }
  persistFilterCache();
}

// A few recent filter results also live in chrome.storage.local so a just-asked
// scope (e.g. a department user) is instant the next time the popup/options page
// asks, even if this service worker restarted in between. Bounded in size and
// gated by the same few-minute TTL at read time; "Refresh now" clears it all.
const FILTER_STORE_KEY = "cuFilterCache";
const FILTER_STORE_MAX = 6;
const FILTER_STORE_MAX_BYTES = 200 * 1024;
async function hydrateFilterCache() {
  try {
    const got = await chrome.storage.local.get(FILTER_STORE_KEY);
    const stored = got[FILTER_STORE_KEY];
    if (!stored || typeof stored !== "object") return;
    for (const [k, v] of Object.entries(stored)) {
      if (!k || !v || !v.data || filterCache.has(k)) continue;
      filterCache.set(k, { at: v.at || 0, data: v.data });
    }
  } catch (e) {}
}
async function persistFilterCache() {
  try {
    const entries = [];
    for (const [k, v] of filterCache) {
      if (!v || !v.data) continue;
      const s = JSON.stringify(v.data);
      if (s.length > FILTER_STORE_MAX_BYTES) continue;
      entries.push({ key: k, at: v.at, data: v.data });
    }
    entries.sort((a, b) => b.at - a.at);
    const trimmed = entries.slice(0, FILTER_STORE_MAX);
    const payload = {};
    for (const e of trimmed) payload[e.key] = { at: e.at, data: e.data };
    await chrome.storage.local.set({ [FILTER_STORE_KEY]: payload });
  } catch (e) {}
}
// "Deadline crossed" source: every task assigned to me that is past its due
// date and not complete, across ALL dates (see CLICKUP_OVERDUE). 5-min cache.
let overdueCache = null;
function clearFilterCache() {
  filterCache.clear();
  overdueCache = null;
  chrome.storage.local.set({ [FILTER_STORE_KEY]: {} }).catch(() => {});
}
hydrateFilterCache();
async function buildRoster(cfg) {
  try {
    const members = await fetchTeamMembers(cfg.token, cfg.teamId);
    const note = members && members.length ? null : "No users found in this workspace's accessible tasks.";
    console.log("[ClickUp] member roster:", members ? members.length : 0, "users" + (note ? " - " + note : ""));
    const st = (await getClickupState()) || {};
    st.members = members || [];
    st.membersAt = Date.now();
    st.membersNote = note;
    await setClickupState(st);
  } catch (e) {
    const reason = "Couldn't load the member list: " + String(e && e.message ? e.message : e);
    console.warn("[ClickUp] roster build failed:", reason);
    const st = (await getClickupState()) || {};
    st.membersNote = reason;
    st.membersAt = Date.now(); // gate the empty-retry so we don't rebuild in a tight loop
    await setClickupState(st);
  } finally {
    rosterBuildPromise = null;
  }
}
// mode: "auto" | "reminder"
// slowNetwork: wait proportionally longer on each navigation (unreliable/slow links).
//   Defaults ON - being patient rarely hurts, and it prevents a fast logout/login
//   race from breaking a switch on a momentarily slow connection.
// notify: show a desktop notification after a daily run finishes
const DEFAULT_SETTINGS = {
  targetUrl: URLS.agentRouterLogin,
  mode: "auto",
  slowNetwork: true,
  arCloseTabs: true, // close each Agent Router tab after a successful login (manual runs too)
  notify: true,
  notifySound: true, // play a chime when any notification/reminder pops up
  // ---- ClickUp "estimate due today" tracker (all opt-in; off until a token is saved) ----
  clickupTargetHours: 7, // daily goal to compare the summed estimate against
  clickupBadge: true, // tint the toolbar badge by ClickUp progress (login "needs you" still wins)
  clickupNotify: true, // desktop nudge if under target late in the day + a "target reached" ping
  clickupNudgeHour: 15, // local hour (0-23) after which the "still under target" nudge may fire
  // ---- Deadline task URLs (weekly Mon-Fri tasks, estimate divided by 5) ----
  clickupDeadlineTaskUrls: [], // array of ClickUp task URLs
  // ---- Extended / multi-day tasks ----
  // For a task that spans a start..due date range, "days" divides its estimate
  // equally across all days in the span; "excl0" divides across ONLY the days
  // with >0 tracked minutes (skipping untracked days and re-spreading the share).
  clickupExtendedMode: "days", // "days" | "excl0"
  // ---- Client label ----
  // Which level of the ClickUp hierarchy names the "client" a task belongs to.
  // "auto" = Folder (when not hidden) → Space → List; or force one level.
  cuClientLevel: "auto", // "auto" | "space" | "folder" | "list"
  // ---- Filter Tasks card defaults ----
  clickupFilter: "today", // "today" | "week" | "custom"
  clickupWeekFilter: "all", // "all" (Mon-Fri) | "day" (single day)
  clickupWeekDay: 1, // 1=Mon..5=Fri (used when weekFilter === "day")
  clickupCustomStart: "", // ISO date string for custom filter start
  clickupCustomDue: "", // ISO date string for custom filter due
  // ---- Weekly totals toggle ----
  // Show the Mon→today/Fri accumulated estimate+tracked total view.
  clickupWeeklyTo: "today", // "today" | "friday"
  // ---- Progressive notifications ----
  clickupHalfwayNotify: true, // notify at 50% of target (halfway)
  clickupAlmostThereNotify: true, // notify at ~86% of target (e.g. 6h of 7h)
  clickupWorkdayEndHour: 16, // local hour (0-23) for end-of-day warning if under target
  // ---- "You're not tracking!" reminder ----
  // Nudge if NO ClickUp timer is running during office hours (Mon-Fri) - for
  // when you start working but forget to start the timer. Re-nudges at most once
  // per clickupIdleRepeatMin while idle, so it can't spam.
  clickupIdleNotify: true, // master on/off for the "are you working?" reminder
  clickupIdleStartHour: 8, // office hours start (local hour 0-23), default 8am
  clickupIdleEndHour: 17, // office hours end (local hour 0-23), default 5pm
  clickupIdleRepeatMin: 60, // minutes between re-nudges while still not tracking
  // ---- Departments (Department Creator) ----
  // Each department holds a name + a list of ClickUp users { id, name }. The
  // Filter Tasks card can then scope its task queries to a department's users.
  clickupDepartments: [], // [{ id, name, users: [{ id, name }] }]
};

// Agent Router grants the daily credit only after a full ~24h gap between
// logins, so we gate on a rolling 24h window (NOT the calendar day). Running
// again just after midnight would be too soon and wouldn't earn the credit.
const RESET_HOURS = 24;
const RESET_MS = RESET_HOURS * 60 * 60 * 1000;
const RETRY_COOLDOWN_MS = 60 * 60 * 1000; // after a failed/attention attempt, wait before retrying

// ---------- date helpers ----------
function todayString(ts) {
  const d = ts ? new Date(ts) : new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function isToday(ts) {
  return ts ? todayString(ts) === todayString() : false;
}

// When a successful login effectively happened. Falls back to older status
// records that only stored lastDone (date) + lastRunAt, so upgrading the
// extension doesn't make it misfire on already-completed accounts.
function effectiveDoneAt(st) {
  const s = st || {};
  if (s.lastDoneAt) return s.lastDoneAt;
  if (s.lastDone && s.lastRunAt) return s.lastRunAt;
  return 0;
}
function isDoneWithinWindow(st) {
  const at = effectiveDoneAt(st);
  return at > 0 && Date.now() < at + RESET_MS;
}
// Should the daily runner attempt this account right now?
function shouldRun(st) {
  const s = st || {};
  const now = Date.now();
  if (s.lastResult === "running") return false;
  if (isDoneWithinWindow(s)) return false; // succeeded within the 24h window - wait it out
  // After ANY successful login, wait out the 24h window even if the credit
  // hasn't been confirmed yet — prevents re-login loops while the balance
  // poll (no tab) catches the credit and anchors lastDoneAt.
  if (s.lastResult === "success" && s.lastRunAt && now - s.lastRunAt < RESET_MS) return false;
  if (s.lastResult && s.lastResult !== "success" && s.lastRunAt && now - s.lastRunAt < RETRY_COOLDOWN_MS)
    return false; // back off briefly after a failed / needs-attention attempt
  return true;
}

// ---------- accounts (encrypted at rest) ----------
async function getAccounts() {
  const { accountsEnc } = await chrome.storage.local.get("accountsEnc");
  const arr = await decryptJSON(accountsEnc, []);
  return Array.isArray(arr) ? arr : [];
}
async function setAccounts(arr) {
  const enc = await encryptJSON(arr);
  // Mirror a plaintext count alongside the encrypted blob. The options page reads
  // this (it can't decrypt) to decide the Agent Router cards' default collapse
  // "show once you have accounts" without waiting for a full GET_STATE round-trip.
  await chrome.storage.local.set({ accountsEnc: enc, acctCount: Array.isArray(arr) ? arr.length : 0 });
}

// Merge two account lists: incoming accounts are matched by id or username.
// Whichever side has the newer _updatedAt stamp wins the conflict; legacy
// accounts with no stamp are treated as oldest so a stamped edit always beats
// an unstamped one. This is what stops a sync pull from silently reverting a
// just-made local edit (e.g. changing sign-in method) back to a stale remote
// copy - previously "incoming" always won outright, timestamp or not.
function mergeAccounts(local, incoming) {
  const result = [...local];
  for (const inc of incoming) {
    const idx = result.findIndex(
      (a) => a.id === inc.id || (inc.username && a.username === inc.username)
    );
    if (idx >= 0) {
      const cur = result[idx];
      const curAt = Number(cur._updatedAt) || 0;
      const incAt = Number(inc._updatedAt) || 0;
      const base = incAt >= curAt ? inc : cur;
      const other = base === inc ? cur : inc;
      result[idx] = {
        ...base,
        id: cur.id,
        _updatedAt: Math.max(curAt, incAt) || undefined,
        detectedLogin: base.detectedLogin || other.detectedLogin || "",
        detectedEmail: base.detectedEmail || other.detectedEmail || "",
      };
    } else {
      result.push(inc);
    }
  }
  return result;
}
// The one authority for what a daily run does with an account:
//   "auto"     -> fill credentials + TOTP and log in
//   "reminder" -> just open the login page (no automation)
//   "off"      -> skip entirely
// Legacy accounts predate the per-account field, so fall back to the GLOBAL
// settings.mode (never a hardcoded "auto" - that would flip old reminder users
// into auto-login on upgrade). An old enabled:false account resolves to "off".
function effectiveMode(a, settings) {
  if (a.mode === "auto" || a.mode === "reminder" || a.mode === "off") return a.mode;
  return a.enabled === false ? "off" : (settings.mode || "auto");
}

// Valid sign-in methods and their canonical spelling. Anything not in the list
// (legacy backup files, hand-edited imports) is normalized to "password".
const AUTH_METHODS = ["password", "google", "google-passkey"];
function normAuthMethod(m) {
  return AUTH_METHODS.includes(m) ? m : "password";
}

// Public (safe) view of accounts - never leaks passwords/secrets to the UI.
function publicAccount(a, settings) {
  return {
    id: a.id,
    label: a.label || a.username || "(account)",
    username: a.username || "",
    enabled: a.enabled !== false,
    authMethod: normAuthMethod(a.authMethod),
    hasPassword: !!a.password,
    hasTotp: !!a.totpSecret,
    mode: effectiveMode(a, settings), // resolved "auto" | "reminder" | "off"
    modeExplicit: a.mode || null, // whether the user pinned it (vs inherited default)
    // Identity captured on the last successful login (best-effort).
    detectedLogin: a.detectedLogin || "",
    detectedEmail: a.detectedEmail || "",
    // Whether we hold a session token for this account (needed to probe
    // availability). The token itself is NOT exposed - only this boolean.
    hasSession: a.arId != null && !!a.arToken,
    hasArToken: !!a.arToken,
    arId: a.arId != null ? a.arId : null, // not a secret: the numeric Agent Router user id
  };
}

// Persist the identity captured during a successful login onto the account, so
// the UI can show which GitHub handle / email actually signed in.
async function applyDetected(accountId, detected) {
  if (!detected) return;
  const login = detected.githubLogin || detected.arUsername || "";
  const email = detected.githubEmail || detected.arEmail || "";
  const arUser = detected.arUsername || "";
  if (!login && !email && !arUser) return;
  const accounts = await getAccounts();
  const idx = accounts.findIndex((a) => a.id === accountId);
  if (idx < 0) return;
  const cur = accounts[idx];
  let changed = false;
  if (login && cur.detectedLogin !== login) {
    cur.detectedLogin = login;
    changed = true;
  }
  if (email && cur.detectedEmail !== email) {
    cur.detectedEmail = email;
    changed = true;
  }
  // The Agent Router username (github_<id>) is the strongest identity signal for
  // the ⟳ balance refresh: it's exactly what /api/user/self returns. Keep it
  // separate from detectedLogin (which prefers the GitHub handle for display).
  if (arUser && cur.detectedArUsername !== arUser) {
    cur.detectedArUsername = arUser;
    changed = true;
  }
  // Cache the numeric AR user id + access token so the service worker can poll
  // this account's balance in the background (no tab) - /api/user/self needs the
  // New-API-User header (the id) and accepts a bearer token. Stored inside the
  // encrypted accounts blob (same at-rest protection as passwords/TOTP).
  if (detected.arId != null && cur.arId !== detected.arId) {
    cur.arId = detected.arId;
    changed = true;
  }
  if (detected.arToken && cur.arToken !== detected.arToken) {
    cur.arToken = detected.arToken;
    changed = true;
  }
  if (changed) await setAccounts(accounts);
}

// ---------- settings ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function setSettings(patch) {
  const s = await getSettings();
  // Stamp the write time so Drive sync can tell whether the local or the remote
  // settings are newer (last-writer-wins) instead of blindly clobbering.
  const next = { ...s, ...patch, _updatedAt: Date.now() };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// ---------- status ----------
async function getStatus() {
  const { status } = await chrome.storage.local.get("status");
  return status || {};
}
async function setStatusFor(id, patch) {
  const status = await getStatus();
  status[id] = { ...(status[id] || {}), ...patch };
  await chrome.storage.local.set({ status });
  updateBadge().catch(() => {});
  mirrorToDrive(status).catch(() => {}); // best-effort, silent
  return status;
}
async function resetStatus(id) {
  const status = await getStatus();
  if (id) delete status[id];
  else for (const k of Object.keys(status)) delete status[k];
  await chrome.storage.local.set({ status });
  updateBadge().catch(() => {});
  return status;
}

// ---------- balances (LOCAL ONLY - never mirrored to Drive) ----------
// Agent Router balance is server-side truth: identical on every machine, so it
// needs no sync. Keeping it OUT of `status` also protects it from Drive's
// whole-record status replace (which would otherwise wipe it). Shape:
//   balances = { [accountId]: { value: <raw number from the API>, at: <ts> } }
async function getBalances() {
  const { balances } = await chrome.storage.local.get("balances");
  return balances && typeof balances === "object" ? balances : {};
}
async function setBalanceFor(id, value) {
  if (value == null || !Number.isFinite(Number(value))) return;
  const balances = await getBalances();
  balances[id] = { value: Number(value), at: Date.now() };
  await chrome.storage.local.set({ balances });
}
async function clearBalanceFor(id) {
  const balances = await getBalances();
  if (id in balances) {
    delete balances[id];
    await chrome.storage.local.set({ balances });
  }
}

// ---------- availability (LOCAL ONLY - never mirrored to Drive) ----------
// Whether Agent Router will actually accept a Claude relay call for this account
// right now, or is in a "blocked till the next quota window" state that the
// balance number can't reveal (the user keeps positive balance yet gets a
// "billing issue" until the next schedule). Determined by lib-availability's
// active probe. Local-only for the same reasons balances are: it's not a machine
// preference and must not ride Drive's status replace. Shape:
//   availability = { [accountId]: { ok: true|false|null, reason: <string>, at: <ts> } }
async function getAvailability() {
  const { availability } = await chrome.storage.local.get("availability");
  return availability && typeof availability === "object" ? availability : {};
}
async function setAvailabilityFor(id, ok, reason) {
  const availability = await getAvailability();
  availability[id] = {
    ok: ok === true ? true : ok === false ? false : null,
    reason: reason ? String(reason) : "",
    at: Date.now(),
  };
  await chrome.storage.local.set({ availability });
  return availability[id];
}
async function clearAvailabilityFor(id) {
  const availability = await getAvailability();
  if (id in availability) {
    delete availability[id];
    await chrome.storage.local.set({ availability });
  }
}

// ---------- arCredits (balance-credit detection, LOCAL ONLY) ----------
// Tracks the balance baseline per account so a fresh daily $25 credit is detected
// by its balance increase. Drives both the ONE-shot quota notification and the
// checkpoint (`lastDoneAt`) that anchors the 24h re-login window to the moment
// the credit actually lands — not the moment the login run finished.
async function getCredits() {
  const { arCredits } = await chrome.storage.local.get("arCredits");
  return arCredits && typeof arCredits === "object" ? arCredits : {};
}
async function setCredits(obj) {
  await chrome.storage.local.set({ arCredits: obj });
}
async function clearCreditsFor(id) {
  const credits = await getCredits();
  if (id in credits) { delete credits[id]; await setCredits(credits); }
}

// Minimum raw-quota increase that qualifies as a fresh credit. A daily batch is
// $25; we set the threshold slightly below to tolerate rounding. The default
// unit is 500000 quota = $1, configurable via settings.quotaPerUnit.
const CREDIT_MIN_DOLLARS = 24;

// Compare a freshly-read balance against the stored baseline. If the balance
// rose by ≥ CREDIT_MIN_DOLLARS worth of raw units → a fresh credit landed.
//   credited  = true when a real increase was detected.
//   firstSeen = true on the very first balance observation for this account
//               (baseline was missing) — no notification is fired.
//   lastCreditAt = timestamp of the detected credit (or whatever was stored).
async function refreshArCredit(accountId, balance, settings) {
  const credits = await getCredits();
  const rec = credits[accountId] || {};
  const prev = Number.isFinite(rec.baseline) ? rec.baseline : null;
  const bal = Number(balance);
  if (prev == null) {
    credits[accountId] = { ...rec, baseline: bal };
    await setCredits(credits);
    return { credited: false, firstSeen: true, lastCreditAt: rec.lastCreditAt || null };
  }
  const per = Number(settings && settings.quotaPerUnit) > 0 ? Number(settings.quotaPerUnit) : 500000;
  const delta = bal - prev;
  if (delta >= CREDIT_MIN_DOLLARS * per) {
    credits[accountId] = { ...rec, baseline: bal, lastCreditAt: Date.now() };
    await setCredits(credits);
    return { credited: true, delta, lastCreditAt: Date.now() };
  }
  // Not a credit — still update baseline so consumption deltas don't pile up.
  if (Number.isFinite(bal) && bal !== prev) {
    credits[accountId] = { ...rec, baseline: bal };
    await setCredits(credits);
  }
  return { credited: false, delta, lastCreditAt: rec.lastCreditAt || null };
}

// Emit the ONE desktop notification per fresh credit. A credit is "un-notified"
// when lastCreditAt > notifiedAt in the credits record. At most one notification
// fires per sweep — collapses all un-notified credits into a single toast.
async function maybeNotifyQuotaCredit() {
  const settings = await getSettings();
  if (settings.arQuotaNotify === false) return;
  const credits = await getCredits();
  const accounts = (await getAccounts()).filter(a => effectiveMode(a, settings) !== "off");
  let anyNew = false;
  for (const a of accounts) {
    const r = credits[a.id];
    if (!r || !r.lastCreditAt) continue;
    if (r.lastCreditAt > (r.notified || 0)) { anyNew = true; break; }
  }
  if (!anyNew) return;
  await notify(
    "ar-quota-credit-" + Date.now(),
    "Agent Router - quota batch released 🚀",
    "A fresh Claude/GPT batch just opened up on Agent Router. Click to jump in before it runs out."
  );
  for (const a of accounts) {
    const r = credits[a.id];
    if (r && r.lastCreditAt > (r.notified || 0)) r.notified = Date.now();
  }
  await setCredits(credits);
}

// Anchor the account's earning checkpoint to the detected credit time. Used by
// the balance poll when a credit lands AFTER a login that succeeded but showed
// no balance increase yet — the poll (no tab) confirms the credit and flips the
// account to "Done · credited" at the real credit moment. Preserves any existing
// in-window checkpoint (an earlier credit in the same 24h window stays the anchor).
async function anchorCreditCheckpoint(accountId) {
  const status = await getStatus();
  const rec = status[accountId] || {};
  const lastDone = effectiveDoneAt(rec);
  if (lastDone > 0 && Date.now() < lastDone + RESET_MS) return;
  const credits = await getCredits();
  const r = credits[accountId];
  if (!r || !r.lastCreditAt) return;
  await setStatusFor(accountId, { lastDone: todayString(), lastDoneAt: r.lastCreditAt, creditSource: "balance" });
}

// ---------- background balance polling (no tabs) ----------
// Silently refresh live balances from the service worker, like the ClickUp
// 5-minute poll - NO tabs opened. new-api's /api/user/self accepts token auth:
// an "Authorization: Bearer <access_token>" + "New-API-User: <id>" pair
// authenticates as THAT specific user, independent of whichever account owns the
// current session cookie. So any account whose id + token we cached at its last
// login can be polled on its own, and we identity-match the response before
// writing so a balance is never mislabeled. Accounts without a cached token are
// skipped here (they still update on the next daily login and via the tab ⟳).
let balancePollInFlight = false;
async function pollBalancesInBackground() {
  if (balancePollInFlight) return;
  balancePollInFlight = true;
  try {
    if (!(await isOnline())) return;
    // Keep the quota-batch schedule in sync with Agent Router (self-throttled to 30 min).
    syncArScheduleFromPage().catch(() => {});
    const settings = await getSettings();
    const accounts = await getAccounts();
    const norm = (x) => String(x || "").trim().toLowerCase();
    for (const acc of accounts) {
      // Only poll accounts still in play and with a cached token to auth with.
      if (effectiveMode(acc, settings) === "off") continue;
      if (acc.arId == null || !acc.arToken) continue;
      try {
        const res = await fetch("https://agentrouter.org/api/user/self", {
          method: "GET",
          credentials: "include",
          headers: {
            "New-API-User": String(acc.arId),
            Authorization: "Bearer " + acc.arToken,
          },
        });
        if (!res || !res.ok) continue; // 401 = token rotated; refreshed on next login
        const j = await res.json().catch(() => null);
        const d = j && j.data ? j.data : j;
        if (!d || typeof d !== "object") continue;
        let balance = d.quota ?? d.balance ?? d.credits ?? d.remaining ?? null;
        if (typeof balance === "string" && balance.trim() !== "") balance = Number(balance);
        if (!Number.isFinite(balance)) continue;
        // Identity guard: the token is user-scoped, but verify the response is
        // actually this account before attributing the balance.
        const idUser = norm(d.username);
        const idEmail = norm(d.email);
        const matches =
          (idUser && idUser === norm(acc.detectedArUsername)) ||
          (idEmail && idEmail === norm(acc.detectedEmail)) ||
          (idUser && idUser === norm(acc.detectedLogin)) ||
          (idEmail && idEmail === norm(acc.username)) ||
          (idUser && idUser === norm(acc.username));
        if (!matches) continue;
        await setBalanceFor(acc.id, balance);
        // Detect fresh daily credit via balance increase, and anchor the
        // checkpoint to the credit moment (covers logins that ran early).
        const credit = await refreshArCredit(acc.id, balance, settings);
        if (credit.credited) {
          await anchorCreditCheckpoint(acc.id);
        }
      } catch (e) {
        // Network/auth hiccup for one account shouldn't stop the rest.
      }
    }
    // Emit ONE desktop notification if any account received a fresh credit.
    // Checked every poll (not just on new credits) so a credit first detected
    // elsewhere - e.g. a manual balance refresh - is notified on the next poll.
    await maybeNotifyQuotaCredit();
    // Nudge any open popup to repaint with the fresh balances.
    chrome.runtime.sendMessage({ type: "BALANCES_UPDATED" }).catch(() => {});
  } finally {
    balancePollInFlight = false;
  }
}

// ---------- availability probing (active, throttled, no tabs) ----------
// A probe makes a real (tiny) relay call, so it both costs a token and can only
// be run so often. We throttle to once / 10 min per account and cache the result
// locally; the popup renders the cache instantly and a background refresh nudges
// it when a newer verdict lands (mirroring the balance-poll pattern above).
const AVAIL_THROTTLE_MS = 10 * 60 * 1000;
let availabilityPollInFlight = false;
const availInFlight = new Set(); // account ids currently being probed

// Persist the resolved relay key / chosen model / probe-token id back onto the
// (encrypted) account record so we don't re-mint or re-list on every probe.
async function cacheAccountProbe(id, patch) {
  const accounts = await getAccounts();
  const idx = accounts.findIndex((a) => a.id === id);
  if (idx < 0) return;
  let changed = false;
  for (const k of ["arRelayKey", "arProbeModel", "arProbeTokenId"]) {
    if (patch[k] != null && accounts[idx][k] !== patch[k]) {
      accounts[idx][k] = patch[k];
      changed = true;
    }
  }
  if (changed) await setAccounts(accounts);
}

// Probe ONE account. Reuse-first: use the cached sk- key if present, else resolve
// one from the account's existing tokens. allowCreate (a user-initiated "Enable"
// click) is the ONLY path that may mint a new token on the account. Returns the
// stored availability entry. Never throws; any failure lands as ok:null.
async function probeAccountAvailability(acc, opts) {
  const force = !!(opts && opts.force);
  const allowCreate = !!(opts && opts.allowCreate);
  if (!acc) return { ok: null, reason: "not-found", at: Date.now() };
  if (acc.arId == null || !acc.arToken) return await setAvailabilityFor(acc.id, null, "no-session");

  const cur = (await getAvailability())[acc.id];
  if (!force && cur && cur.at && Date.now() - cur.at < AVAIL_THROTTLE_MS) return cur; // cache still fresh
  if (availInFlight.has(acc.id)) return cur || { ok: null, reason: "in-flight", at: Date.now() };
  availInFlight.add(acc.id);
  try {
    const auth = { arId: acc.arId, arToken: acc.arToken };
    let key = acc.arRelayKey && /^sk-/.test(acc.arRelayKey) ? acc.arRelayKey : null;
    const usedCachedKey = !!key; // a cached key can be stale; a freshly-resolved one isn't
    let model = acc.arProbeModel || null;

    if (!key) {
      const r = await resolveRelayKey(auth, { allowCreate });
      if (!r || !r.key) return await setAvailabilityFor(acc.id, null, (r && r.reason) || "no-key");
      key = r.key;
      await cacheAccountProbe(acc.id, { arRelayKey: key, arProbeTokenId: r.tokenId != null ? String(r.tokenId) : null });
    }
    if (!model) {
      model = await pickProbeModel(key);
      if (model) await cacheAccountProbe(acc.id, { arProbeModel: model });
    }
    if (!model) return await setAvailabilityFor(acc.id, null, "no-model");

    let res = await probeRelay(key, model);
    // A CACHED key can be stale (rotated/deleted server-side) -> 401. Re-resolve
    // ONCE (reuse-only, no create) and retry before giving up. A freshly-resolved
    // key that 401s is a deployment issue, not staleness, so we don't loop.
    if (res.status === 401 && usedCachedKey) {
      const r2 = await resolveRelayKey(auth, { allowCreate: false });
      if (r2 && r2.key && r2.key !== key) {
        key = r2.key;
        await cacheAccountProbe(acc.id, { arRelayKey: key, arProbeTokenId: r2.tokenId != null ? String(r2.tokenId) : null });
        res = await probeRelay(key, model);
      }
    }
    return await setAvailabilityFor(acc.id, res.ok, res.reason);
  } catch (e) {
    return await setAvailabilityFor(acc.id, null, "probe-error");
  } finally {
    availInFlight.delete(acc.id);
  }
}

// Refresh availability for every in-play account with cached session creds, in
// the background (like pollBalancesInBackground). Reuse-only: this never mints a
// token, so a fresh account with no key stays "Unknown" until the user enables it
// explicitly. Skips accounts whose cached verdict is still fresh.
async function probeAvailabilityInBackground(opts) {
  const force = !!(opts && opts.force);
  if (availabilityPollInFlight) return;
  availabilityPollInFlight = true;
  try {
    if (!(await isOnline())) return;
    const settings = await getSettings();
    const accounts = await getAccounts();
    const avail = await getAvailability();
    let touched = false;
    for (const acc of accounts) {
      if (effectiveMode(acc, settings) === "off") continue;
      if (acc.arId == null || !acc.arToken) continue;
      const cur = avail[acc.id];
      if (!force && cur && cur.at && Date.now() - cur.at < AVAIL_THROTTLE_MS) continue;
      await probeAccountAvailability(acc, { force: true, allowCreate: false });
      touched = true;
    }
    if (touched) chrome.runtime.sendMessage({ type: "AVAILABILITY_UPDATED" }).catch(() => {});
  } finally {
    availabilityPollInFlight = false;
  }
}

// ---------- ClickUp (estimate due today) ----------
// The token + chosen workspace + cached user id are a SECRET blob, so they're
// obfuscated at rest like accounts (encryptJSON). Non-secret prefs (target hours,
// badge/notify toggles) live in `settings`. The computed result is cached in
// `clickupState` so the popup and badge render instantly with no network wait.
async function getClickupConfig() {
  const { clickupEnc } = await chrome.storage.local.get("clickupEnc");
  const cfg = await decryptJSON(clickupEnc, null);
  return cfg && typeof cfg === "object" ? cfg : null;
}
async function setClickupConfig(patch) {
  const cur = (await getClickupConfig()) || {};
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ clickupEnc: await encryptJSON(next) });
  return next;
}
async function clearClickupConfig() {
  await chrome.storage.local.remove(["clickupEnc", "clickupState", "clickupNotified"]);
}

// Push accounts AND the ClickUp config (encrypted token etc.) together so a new
// machine signed in with the same Google account gets both.
async function pushAllToDrive(tok, accounts) {
  const ccfg = await getClickupConfig().catch(() => null);
  const settings = await getSettings().catch(() => null);
  const departments = (settings && Array.isArray(settings.clickupDepartments)) ? settings.clickupDepartments : null;
  await pushAccountsToDrive(tok, accounts, ccfg && ccfg.token ? ccfg : null, departments, settings);
}

// Adopt synced settings (target hours, deadline task URLs, notification prefs,
// Agent Router URL, all ClickUp prefs) from Drive. Last-writer-wins by the
// _updatedAt stamp so we never overwrite fresher local prefs with a stale remote
// copy. departments are already handled by adoptRemoteDepartments (kept separate
// so a locally-created department isn't lost), so we don't force them here.
async function adoptRemoteSettings(remoteSettings, remoteSettingsAt) {
  if (!remoteSettings || typeof remoteSettings !== "object") return;
  const local = await getSettings().catch(() => null);
  const localAt = local && Number(local._updatedAt) ? Number(local._updatedAt) : 0;
  const remoteAt = Number(remoteSettingsAt) || Number(remoteSettings._updatedAt) || 0;
  // Only take the remote when it's strictly newer than what we have locally.
  if (remoteAt <= localAt) return;
  // Don't let the remote _updatedAt get re-stamped to "now" (setSettings stamps
  // it) or we'd lose the ability to compare - carry the remote stamp forward.
  const merged = { ...remoteSettings };
  await chrome.storage.local.set({ settings: { ...(local || {}), ...merged, _updatedAt: remoteAt } });
}

// One full two-way sync (accounts + ClickUp config + status). Shared by the
// manual "Sync now" button and the periodic auto-sync alarm. Silent (interactive
// = false) so the background alarm never pops a Google prompt; getValidToken now
// self-heals an expired token via silent re-auth, and driveFetch retries on 401,
// so this keeps working across the ~1h implicit-token lifetime without a manual
// re-sign-in. Returns { ok, reason? }.
async function syncNow() {
  const tok = await getValidToken(false);
  if (!tok) return { ok: false, reason: "not signed in" };
  let statusOk = false;
  try {
    // Pull remote accounts first (another machine may have updated them).
    const remote = await pullAccountsFromDrive(tok);
    if (remote && Array.isArray(remote.accounts) && remote.accounts.length) {
      const local = await getAccounts();
      await setAccounts(mergeAccounts(local, remote.accounts));
    }
    if (remote) await adoptRemoteClickup(remote.clickup);
    if (remote) await adoptRemoteDepartments(remote.departments);
    if (remote) await adoptRemoteSettings(remote.settings, remote.settingsAt);
    if (remote) await scheduleAgentRouterAlarms().catch(() => {});
    // Push our accounts + settings so other machines see them.
    await pushAllToDrive(tok, await getAccounts()).catch(() => {});
    // Two-way status sync.
    const pulled = await pullFromDrive(await getStatus());
    if (pulled.ok) {
      await chrome.storage.local.set({ status: pulled.status });
      await updateBadge();
      statusOk = true;
    }
    await mirrorToDrive(await getStatus()).catch(() => {});
    // Also pull fresh ClickUp numbers right now (rather than waiting for the
    // next 5-minute poll) - this is what makes a sign-in or a manual sync show
    // up-to-date ClickUp data immediately instead of looking "stuck" until the
    // alarm next fires.
    const ccfg = await getClickupConfig().catch(() => null);
    if (ccfg && ccfg.token && ccfg.teamId) {
      await refreshClickup({ includeTasks: false }).catch(() => {});
    }
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
  // Stamp "last synced at" regardless of the status-sync sub-result above, since
  // reaching here means the sync ran to completion without throwing.
  const syncedAt = Date.now();
  await chrome.storage.local.set({ driveLastSync: syncedAt }).catch(() => {});
  return { ok: statusOk, syncedAt };
}

// If a sync'ed ClickUp config came from Drive and this machine has none yet,
// adopt it so the API keys travel between machines. Also merges the Admin API
// token (and other admin fields) from the remote when this machine only has a
// personal token - so the Filter Tasks card picks up the admin token on another
// browser too.
async function adoptRemoteClickup(remoteClickup) {
  if (!remoteClickup || !remoteClickup.token) return;
  const local = await getClickupConfig().catch(() => null);
  if (!local || !local.token) {
    await setClickupConfig(remoteClickup).catch(() => {});
    return;
  }
  // Local already has a personal token - fill in only the admin fields that the
  // remote carries and the local is missing.
  const remoteAdmin = (remoteClickup.adminToken && String(remoteClickup.adminToken).trim()) || null;
  const localAdmin = (local.adminToken && String(local.adminToken).trim()) || null;
  if (remoteAdmin && !localAdmin) {
    await setClickupConfig({
      adminToken: remoteAdmin,
      adminUserId: remoteClickup.adminUserId || null,
      adminUsername: remoteClickup.adminUsername || "",
      adminEmail: remoteClickup.adminEmail || "",
    }).catch(() => {});
  }
}

// Restore the synced ClickUp departments into settings on this machine (only
// fills them if there's currently nothing, so a locally-created department on a
// different browser wins).
async function adoptRemoteDepartments(remoteDepartments) {
  if (!Array.isArray(remoteDepartments) || !remoteDepartments.length) return;
  const settings = await getSettings().catch(() => null);
  const local = (settings && Array.isArray(settings.clickupDepartments)) ? settings.clickupDepartments : [];
  if (local.length) return;
  await setSettings({ clickupDepartments: remoteDepartments }).catch(() => {});
}
async function getClickupState() {
  const { clickupState } = await chrome.storage.local.get("clickupState");
  return clickupState && typeof clickupState === "object" ? clickupState : null;
}
async function setClickupState(state) {
  await chrome.storage.local.set({ clickupState: state });
  updateBadge().catch(() => {});
  return state;
}

// Safe view for the UI - reports whether a token is configured, never the token.
async function clickupPublic() {
  const cfg = await getClickupConfig();
  const settings = await getSettings();
  const state = await getClickupState();
  return {
    configured: !!(cfg && cfg.token),
    adminConfigured: !!(cfg && cfg.adminToken && String(cfg.adminToken).trim()),
    adminUser: cfg && cfg.adminToken && String(cfg.adminToken).trim()
      ? { id: cfg.adminUserId || null, username: cfg.adminUsername || "", email: cfg.adminEmail || "" }
      : null,
    teamId: (cfg && cfg.teamId) || null,
    teamName: (cfg && cfg.teamName) || null,
    user: cfg ? { id: cfg.userId || null, username: cfg.username || "", email: cfg.email || "" } : null,
    targetHours: Number(settings.clickupTargetHours) || 0,
    badge: settings.clickupBadge !== false,
    notify: settings.clickupNotify !== false,
    nudgeHour: Number(settings.clickupNudgeHour) || 0,
    deadlineTaskUrls: Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : [],
    halfwayNotify: settings.clickupHalfwayNotify !== false,
    almostThereNotify: settings.clickupAlmostThereNotify !== false,
    runningNotify: settings.clickupRunningNotify !== false,
    runningThresholdMin: Number(settings.clickupRunningThresholdMin) || 10,
    idleNotify: settings.clickupIdleNotify !== false,
    idleStartHour: Number.isFinite(Number(settings.clickupIdleStartHour)) ? Number(settings.clickupIdleStartHour) : 8,
    idleEndHour: Number.isFinite(Number(settings.clickupIdleEndHour)) ? Number(settings.clickupIdleEndHour) : 17,
    idleRepeatMin: Number(settings.clickupIdleRepeatMin) || 60,
    workdayEndHour: Number(settings.clickupWorkdayEndHour) || 0,
    extendedMode: settings.clickupExtendedMode === "excl0" ? "excl0" : "days",
    weeklyTo: settings.clickupWeeklyTo === "friday" ? "friday" : "today",
    state: state || null,
  };
}

// Pull the latest number from ClickUp and cache it. The per-task breakdown IS
// always stored (so the popup can render each task's estimate/tracked time),
// but the returned `data` only carries it when `includeTasks` is set (used by
// the options-page preview which wants a rich immediate response). `viaAlarm`
// enables the once-a-day desktop nudges; manual refreshes stay quiet except for
// the self-limiting "target reached" ping.
// Discover the single "Extra(s) Task(s)" task for the current user (by name
// pattern from lib-clickup) and remember it on the state so the UIs can show it
// and CLICKUP_FILTER can fold it in. Scans the CURRENT week's due tasks (the
// same query the "Filter → This Week" card uses) plus a fallback scan. Returns
// the found task or null.
// Detect the "Extra(s) Task(s)" task for a SPECIFIC member (not just the signed-in
// user). This is what lets a department/Jack-scoped filter list Jack's own extra
// task instead of the viewer's. Cached per user for an hour. `hint` (name/email)
// sharpens which match is preferred when someone has several Extra-named tasks.
async function discoverExtraTaskFor(cfg, userId, hint) {
  const key = String(userId);
  const hit = extraTaskCache.get(key);
  if (hit && Date.now() - hit.at < EXTRA_TASK_CACHE_MS) return hit.value;
  let value = null;
  try {
    const nowDate = new Date();
    const monday = new Date(nowDate);
    monday.setHours(0, 0, 0, 0);
    monday.setDate(nowDate.getDate() - ((nowDate.getDay() + 6) % 7));
    const friEnd = new Date(monday);
    friEnd.setDate(monday.getDate() + 4);
    friEnd.setHours(23, 59, 59, 999);
    value = await findExtraTaskByName({
      token: cfg.token,
      teamId: cfg.teamId,
      userId: userId != null ? userId : cfg.userId,
      usernameHint: hint || (key === String(cfg.userId) ? (cfg.username || cfg.email || "") : ""),
      fromTs: monday.getTime(),
      toTs: friEnd.getTime(),
    });
  } catch (e) {
    value = null;
  }
  extraTaskCache.set(key, { at: Date.now(), value });
  return value;
}

async function discoverExtraTask(cfg) {
  return discoverExtraTaskFor(cfg, cfg.userId, cfg.username || cfg.email || "");
}

// The effective configured-task URL list = the URLs the user entered PLUS the
// auto-detected extra task (deduped by task id). Never mutates the saved list.
function mergeExtraTaskUrl(deadlineTaskUrls, extraTask) {
  if (!extraTask || !extraTask.url) return deadlineTaskUrls;
  const urls = Array.isArray(deadlineTaskUrls) ? deadlineTaskUrls.filter(Boolean) : [];
  if (urls.some((u) => parseTaskIdFromUrl(u) === parseTaskIdFromUrl(extraTask.url))) return urls;
  return urls.concat(extraTask.url);
}

// Full filtered-view computation for the "Filter Tasks" card. Runs in the
// BACKGROUND (with a keepalive) so a slow first load - discovering each scoped
// user's Extra Task across many API pages - can never drop the message reply.
// Semantics:
//  - Scope = selected users (department / single member / all) else signed-in.
//  - Personal configured URLs count only when the viewer is IN the scope.
//  - Every user in scope contributes their OWN auto-detected "Extra(s) Task(s)".
async function computeFilterData(cfg, settings, assigneeIds, fromTs, toTs) {
  const myId = String(cfg.userId);
  const scopeIds = assigneeIds.length ? assigneeIds : [myId];
  const includeSelf = scopeIds.includes(myId);
  const configuredUrls = includeSelf
    ? (Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : [])
    : [];
  // Build name/email hints for extra-task discovery from the roster cache.
  const stx = await getClickupState();
  const membersList = (stx && Array.isArray(stx.members)) ? stx.members : [];
  const memberHint = new Map();
  for (const m of membersList) {
    if (!m || m.id == null) continue;
    const nm = String(m.name || "").trim();
    const hint = (nm && !/^User \d+$/.test(nm)) ? nm : (String(m.email || "").trim() || "");
    memberHint.set(String(m.id), hint);
  }
  memberHint.set(myId, (cfg.username || cfg.email || "") || memberHint.get(myId) || "");
  // Each in-scope user's own Extra Task (cached per user ~1h).
  const extraUrls = [];
  for (const u of scopeIds) {
    const ex = await discoverExtraTaskFor(cfg, u, memberHint.get(u) || "");
    if (ex && ex.url) extraUrls.push(ex.url);
  }
  const deadlineTaskUrls = [];
  for (const u of configuredUrls.concat(extraUrls)) {
    const tid = parseTaskIdFromUrl(u);
    if (tid && !deadlineTaskUrls.some((x) => parseTaskIdFromUrl(x) === tid)) deadlineTaskUrls.push(u);
  }
  const extendedMode = settings.clickupExtendedMode === "excl0" ? "excl0" : "days";
  // "My tasks" (no scope) keeps the historical userId-based path; any real
  // multi-someone scope sends the member ids explicitly.
  const isSelfOnly = scopeIds.length === 1 && scopeIds[0] === myId;
  const passIds = isSelfOnly ? undefined : scopeIds;
  // Tracked time policy: the PERSONAL token is the accurate source for the
  // signed-in user's own hours (including manually added entries), so it is used
  // for self-only / "My tasks" scope. The ADMIN token is only used when the scope
  // covers OTHER users (department / all / a teammate), where reading their
  // entries requires it. Using admin for a self scope was silently returning wrong
  // tracked minutes.
  const admin = (cfg.adminToken && String(cfg.adminToken).trim()) || undefined;
  const data = await fetchDateRangeEstimate({
    token: cfg.token, teamId: cfg.teamId, userId: cfg.userId,
    fromTs, toTs, deadlineTaskUrls, extendedMode,
    assigneeIds: passIds,
    adminToken: isSelfOnly ? undefined : admin,
    taskCache: createTaskCache(),
  });
  // Stamp each row with its client name (used by the client tag + client filter).
  await annotateClients(cfg.token, data, settings.cuClientLevel || "auto");
  return data;
}

// Today's "My tasks" filter data - the SAME computation the popup's Filter card
// produces for its default "Today + My tasks" view - so the upper (today) stats
// card and the filter card always agree on numbers AND task listing. Reuses the
// shared filterCache (popup default uses assigneeIds=[]) to avoid recompute.
async function getTodayFilterData(cfg, settings) {
  const now = new Date();
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const end = new Date(now); end.setHours(23, 59, 59, 999);
  const fromTs = start.getTime();
  const toTs = end.getTime();
  const key = filterKey([], fromTs, toTs);
  const hit = filterCache.get(key);
  if (hit && Date.now() - hit.at < FILTER_CACHE_MS) return hit.data || null;
  try {
    const data = await computeFilterData(cfg, settings, [], fromTs, toTs);
    filterCache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    return null;
  }
}

// ---------- client-name annotation ----------
// Every ClickUp task object built in lib-clickup carries a `.container`
// ({folderName, listName, spaceId}). We resolve that into a display `.client`
// name here (in the worker, which owns settings + the space-name cache) so the
// popup and options can render a client tag and filter by client without any
// extra work of their own. Space names need a /space/{id} lookup, so they're
// cached (in-memory + persisted) and only fetched when the chosen level needs
// them - at most once per distinct space for the life of the cache.
const cuSpaceNames = new Map();
let cuSpaceNamesLoaded = false;
async function loadSpaceNames() {
  if (cuSpaceNamesLoaded) return;
  cuSpaceNamesLoaded = true;
  try {
    const { cuSpaceNames: saved } = await chrome.storage.local.get("cuSpaceNames");
    if (saved && typeof saved === "object") {
      for (const k of Object.keys(saved)) cuSpaceNames.set(String(k), saved[k]);
    }
  } catch (e) {}
}
async function saveSpaceNames() {
  try {
    const obj = {};
    for (const [k, v] of cuSpaceNames) obj[k] = v;
    await chrome.storage.local.set({ cuSpaceNames: obj });
  } catch (e) {}
}
// Gather every task-row object (anything with a `.container`) reachable from a
// fetch bundle - tasks / deadlineTasks / trackedTasks, and each weekly perDay.
function collectContainerObjs(bundle, acc) {
  if (!bundle || typeof bundle !== "object") return acc;
  for (const key of ["tasks", "deadlineTasks", "trackedTasks"]) {
    const arr = bundle[key];
    if (Array.isArray(arr)) for (const o of arr) if (o && o.container) acc.push(o);
  }
  if (Array.isArray(bundle.perDay)) for (const p of bundle.perDay) collectContainerObjs(p, acc);
  return acc;
}
// Collapse client-name spelling variants to ONE canonical label per client, and
// display the client's PRIMARY identity - its List name - for all of them.
// The same client reaches us as different strings: a task with a hand-typed
// "Client Name" custom field carries that ("AcmeHVAC"), while a task with an
// empty field falls back to its List name ("🔥 Acme HVAC"). These differ by
// emoji/icon, spacing and case, so the popup/options Client filter (which dedupes
// rows into checkboxes by EXACT string) showed the client TWICE and picking one
// missed the other's tasks. We match variants by a strong key (letters+digits
// only, lower-cased - so emoji/spaces/punctuation never split a client), then
// re-stamp every row with ONE display spelling: the List name (always present -
// the "primary"; the custom field is only a fallback that may be missing) when we
// can see it, else the most common spelling. One client = one checkbox, and it
// matches ALL its tasks. List preference applies to the default "auto"/"list"
// levels; an explicit field/folder/space choice keeps its own spelling.
function canonicalizeClientLabels(objs, level) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const preferList = level === "auto" || level === "list" || !level;
  const groups = new Map(); // key -> { counts:Map(spelling->n), lists:Map(spelling->n) }
  for (const o of objs) {
    const raw = clean(o && o.client);
    const k = key(raw);
    if (!k) continue;
    let g = groups.get(k);
    if (!g) { g = { counts: new Map(), lists: new Map() }; groups.set(k, g); }
    g.counts.set(raw, (g.counts.get(raw) || 0) + 1);
    const ln = clean(o.container && o.container.listName);
    if (ln && key(ln) === k) g.lists.set(ln, (g.lists.get(ln) || 0) + 1);
  }
  const pickMost = (m) => {
    let best = "", bestN = -1;
    for (const [s, n] of m) if (n > bestN || (n === bestN && s.localeCompare(best) < 0)) { best = s; bestN = n; }
    return best;
  };
  const canonical = new Map();
  for (const [k, g] of groups) {
    canonical.set(k, (preferList && g.lists.size) ? pickMost(g.lists) : pickMost(g.counts));
  }
  for (const o of objs) {
    if (!o || !o.client) continue;
    const c = canonical.get(key(o.client));
    if (c) o.client = c;
  }
}
// Resolve + stamp `.client` on every task row in a fetch result (today / filter /
// weekly bundle). Idempotent and cache-backed, so re-annotating costs no API call.
async function annotateClients(token, result, level) {
  try {
    if (!result || typeof result !== "object") return result;
    const objs = [];
    collectContainerObjs(result, objs);
    if (result.weekly) collectContainerObjs(result.weekly, objs);
    if (result.todayFilter) collectContainerObjs(result.todayFilter, objs);
    if (result.thisWeek) collectContainerObjs(result.thisWeek, objs);
    if (result.nextWeek) collectContainerObjs(result.nextWeek, objs);
    if (!objs.length) return result;
    const lvl = level || "auto";
    await loadSpaceNames();
    const before = cuSpaceNames.size;
    await resolveSpaceNamesFor(token, objs.map((o) => o.container), lvl, cuSpaceNames);
    if (cuSpaceNames.size > before) saveSpaceNames().catch(() => {});
    for (const o of objs) o.client = clientLabelFromContainer(o.container, lvl, cuSpaceNames);
    canonicalizeClientLabels(objs, lvl);
    return result;
  } catch (e) {
    return result;
  }
}

// ---------- Client site auto-discovery (Uptime Monitor "Auto-detect") ----------
// Builds the client list from open ClickUp tasks (client name resolved exactly
// like the task-row client pill) and GUESSES each client's website from:
//   1. a URL-type / "Website"-"Domain"-"Site"-named custom field (strongest),
//   2. links and bare domains in the task name + description,
//   3. a bonus when the domain resembles the client name (acmehvac.com ~ "Acme HVAC").
// Returns every client - with url "" when nothing was found - so the options page
// can show the full list for the user to verify / correct before adding.
const SITE_DISCOVERY_BLOCK = [
  "clickup.com", "google.com", "googleapis.com", "gstatic.com", "goo.gl", "g.co", "youtube.com", "youtu.be",
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "pinterest.com",
  "github.com", "gitlab.com", "loom.com", "figma.com", "canva.com", "semrush.com", "ahrefs.com", "moz.com",
  "screamingfrog.co.uk", "schema.org", "wordpress.org", "wordpress.com", "w3.org", "microsoft.com", "clarity.ms",
  "hotjar.com", "bing.com", "yahoo.com", "apple.com", "slack.com", "notion.so", "notion.site", "dropbox.com",
  "gmail.com", "outlook.com", "office.com", "zoom.us", "calendly.com", "bit.ly", "lookerstudio.google.com",
  "web.dev", "gtmetrix.com", "pagespeed.web.dev", "agentrouter.org", "openai.com", "chatgpt.com", "anthropic.com",
  "claude.ai", "grammarly.com", "trello.com", "asana.com", "airtable.com", "typeform.com", "wix.com",
  "squarespace.com", "shopify.com", "godaddy.com", "cloudflare.com", "amazonaws.com", "gravatar.com",
  "yoast.com", "rankmath.com", "elementor.com", "archive.org", "wikipedia.org", "example.com",
];
const SITE_DISCOVERY_FILE_EXT = /\.(html?|php|aspx?|jsp|js|css|png|jpe?g|gif|webp|svg|ico|pdf|docx?|xlsx?|pptx?|csv|txt|json|xml|zip|mp4|mov|md)$/i;

function siteHostBlocked(host) {
  return SITE_DISCOVERY_BLOCK.some((b) => host === b || host.endsWith("." + b));
}
// Pull candidate hosts out of free text: full URLs and bare domains.
function extractSiteHosts(text) {
  const out = [];
  const re = /(^|[^@\w.-])(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\w-])/gi;
  let m;
  const src = String(text || "");
  while ((m = re.exec(src))) {
    let host = m[2].toLowerCase().replace(/^www\./, "");
    if (SITE_DISCOVERY_FILE_EXT.test(host)) continue;
    if (!/\.[a-z]{2,24}$/.test(host) || siteHostBlocked(host)) continue;
    out.push(host);
  }
  return out;
}
function siteNameKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
// Does the domain look like the client's name? Compares the registrable label
// (acmehvac in acmehvac.com) with the client's letters+digits.
function hostMatchesClient(host, clientKey) {
  if (!clientKey || clientKey.length < 3) return false;
  const labels = host.split(".");
  const root = siteNameKey(labels.length >= 2 ? labels[labels.length - 2] : labels[0]);
  if (root.length < 3) return false;
  return root.includes(clientKey) || clientKey.includes(root) ||
    (root.length >= 5 && clientKey.length >= 5 && root.slice(0, 5) === clientKey.slice(0, 5));
}

// Words that describe the SERVICE, not the client - stripped before guessing a
// domain from the client name ("Acme Law SEO" -> "acmelaw").
const SITE_NAME_STOPWORDS = new Set([
  "seo", "ppc", "sem", "smm", "gbp", "gmb", "web", "website", "site", "marketing", "digital", "client", "clients",
  "project", "projects", "account", "retainer", "monthly", "services", "service", "tasks", "task", "the", "and",
  "llc", "inc", "ltd", "co", "company", "group", "team", "local", "ads", "social", "content", "dev", "design",
]);
function siteNameGuesses(name) {
  const words = String(name || "").toLowerCase().replace(/[^a-z0-9\s&-]+/g, " ").split(/[\s&-]+/).filter(Boolean);
  const core = words.filter((w) => !SITE_NAME_STOPWORDS.has(w));
  const out = new Set();
  const add = (w) => { if (w.join("").length >= 4) { out.add(w.join("") + ".com"); if (w.length > 1) out.add(w.join("-") + ".com"); } };
  if (core.length) add(core);
  if (words.length && words.length !== core.length) add(words); // e.g. brand really contains "Law"/"HVAC"
  return [...out].slice(0, 4);
}
// Reachability probe for a guessed domain (no-cors: resolves when a server
// answers, rejects on DNS/connect failure). Never used for a confident match.
async function siteReachable(host) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    await fetch("https://" + host, { method: "GET", mode: "no-cors", cache: "no-store", signal: ctl.signal });
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
// Run fn over items with limited concurrency.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k).catch(() => null); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function discoverClientSitesBg() {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId) return { ok: false, reason: "not-configured" };
  const settings = await getSettings();
  const level = settings.cuClientLevel || "auto";
  await loadSpaceNames().catch(() => {});
  const cuGet = async (path) => {
    const res = await fetch("https://api.clickup.com/api/v2" + path, { headers: { Authorization: cfg.token } });
    if (res.status === 429) { const e = new Error("rate-limited"); e.status = 429; throw e; }
    if (!res.ok) { const e = new Error("http-" + res.status); e.status = res.status; throw e; }
    return res.json();
  };

  // 1) Tasks - open AND closed (closed ones often hold the "set up GA for
  //    https://client.com" style tasks that name the site).
  const tasks = [];
  let rateLimited = false;
  for (let page = 0; page < 8; page++) {
    let j;
    try {
      j = await cuGet("/team/" + encodeURIComponent(cfg.teamId) + "/task?include_closed=true&subtasks=true&page=" + page);
    } catch (e) {
      if (e.status === 429) { rateLimited = true; break; }
      if (page === 0) return { ok: false, reason: e.message };
      break;
    }
    const batch = j && Array.isArray(j.tasks) ? j.tasks : [];
    tasks.push(...batch);
    if (batch.length < 100 || j.last_page === true) break;
  }

  const clients = new Map(); // key -> { name, key, taskCount, openCount, listIds:Set, hosts: Map(host -> {score, from:Set}) }
  const bumpHost = (c, host, pts, from) => {
    const h = c.hosts.get(host) || { score: 0, from: new Set() };
    h.score += pts;
    h.from.add(from);
    c.hosts.set(host, h);
  };
  for (const t of tasks) {
    let name = "";
    try { name = String(clientLabelFromContainer(taskContainer(t), level, cuSpaceNames) || "").trim(); } catch (e) {}
    if (!name || /^(all |template)/i.test(name)) continue;
    const key = siteNameKey(name);
    if (!key) continue;
    let c = clients.get(key);
    if (!c) { c = { name, key, taskCount: 0, openCount: 0, listIds: new Set(), hosts: new Map() }; clients.set(key, c); }
    c.taskCount++;
    if (!(t.status && /closed|done|complete/i.test(String(t.status.type || t.status.status || "")))) c.openCount++;
    if (t.list && t.list.id != null) c.listIds.add(String(t.list.id));
    for (const cf of Array.isArray(t.custom_fields) ? t.custom_fields : []) {
      const fname = String((cf && cf.name) || "");
      const isUrlField = cf && (cf.type === "url" || /web ?site|domain|\bsite\b|\burl\b|homepage/i.test(fname));
      if (!isUrlField || cf.value == null || typeof cf.value === "object") continue;
      for (const host of extractSiteHosts(String(cf.value))) bumpHost(c, host, 8, "ClickUp field \"" + fname + "\"");
    }
    const text = [t.name, t.text_content || t.description || ""].join("\n");
    for (const host of new Set(extractSiteHosts(text))) bumpHost(c, host, 1, "task text");
  }

  // 2) List descriptions - agencies commonly put the client's site there.
  const listJobs = [];
  for (const c of clients.values()) for (const id of [...c.listIds].slice(0, 3)) listJobs.push({ c, id });
  if (!rateLimited) {
    await mapLimit(listJobs.slice(0, 60), 4, async ({ c, id }) => {
      try {
        const l = await cuGet("/list/" + encodeURIComponent(id));
        const text = [l && l.name, l && l.content, l && l.folder && l.folder.name].filter(Boolean).join("\n");
        for (const host of new Set(extractSiteHosts(text))) bumpHost(c, host, 6, "List description");
      } catch (e) {
        if (e.status === 429) rateLimited = true;
      }
    });
  }

  // 3) A domain mentioned under MANY clients is the agency's own site or a
  //    tool - never a specific client's website.
  const hostClientCount = new Map();
  for (const c of clients.values()) for (const h of c.hosts.keys()) hostClientCount.set(h, (hostClientCount.get(h) || 0) + 1);
  const generic = (h) => {
    const n = hostClientCount.get(h) || 0;
    return n >= 3 && n >= clients.size * 0.2;
  };

  const out = [];
  for (const c of clients.values()) {
    const ranked = [...c.hosts.entries()]
      .filter(([host]) => !generic(host))
      .map(([host, h]) => {
        const nameHit = hostMatchesClient(host, c.key);
        return { host, score: h.score + (nameHit ? 5 : 0), from: [...h.from], nameHit };
      })
      .sort((a, b) => b.score - a.score);
    const best = ranked[0] || null;
    let confidence = "none";
    if (best) confidence = best.score >= 5 || best.nameHit ? "high" : best.score >= 2 ? "medium" : "low";
    out.push({
      name: c.name,
      key: c.key,
      taskCount: c.taskCount,
      url: best ? "https://" + best.host : "",
      confidence,
      source: best ? best.from.join(", ") + (best.nameHit ? " · matches client name" : "") : "",
      candidates: ranked.slice(0, 5).map((r) => "https://" + r.host),
    });
  }

  // 4) Nothing in ClickUp for a client: try domains built from its name and keep
  //    the first one that actually answers. Clearly marked as a guess.
  const missing = out.filter((c) => !c.url).slice(0, 40);
  await mapLimit(missing, 6, async (c) => {
    for (const host of siteNameGuesses(c.name)) {
      if (await siteReachable(host)) {
        c.url = "https://" + host;
        c.confidence = "guess";
        c.source = "guessed from client name (site responds) - please verify";
        c.candidates = [c.url];
        return;
      }
    }
  });
  for (const c of out) if (!c.url) c.source = "no website found - please type it";

  out.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, clients: out, scanned: tasks.length, rateLimited };
}

// Coalescing wrapper around the actual refresh. Prevents the ClickUp API from
// being hammered into a 429: (1) auto (alarm) refreshes honour a persisted 429
// cooldown and a minimum spacing; (2) a single in-flight refresh is shared by
// all concurrent callers (alarm + popup-open + task action) instead of stacking.
let clickupRefreshInFlight = null;
const AUTO_REFRESH_MIN_MS = 4 * 60 * 1000; // CLICKUP_ALARM is 5 min - collapse overlaps

async function refreshClickup(opts = {}) {
  const { viaAlarm = false } = opts;
  if (viaAlarm) {
    const prev = await getClickupState().catch(() => null);
    if (prev) {
      // Backed off after a 429 - don't touch the API until the window elapses.
      if (prev.rateLimitedUntil && Date.now() < prev.rateLimitedUntil) {
        return { ok: false, reason: "rate-limited" };
      }
      // Overlapping alarms / a refresh moments ago - skip, keep last-good numbers.
      if (prev.at && Date.now() - prev.at < AUTO_REFRESH_MIN_MS) {
        return { ok: false, reason: "too-soon" };
      }
    }
  }
  // Share one in-flight refresh across concurrent triggers.
  if (clickupRefreshInFlight) return clickupRefreshInFlight;
  clickupRefreshInFlight = (async () => {
    try {
      return await refreshClickupImpl(opts);
    } finally {
      clickupRefreshInFlight = null;
    }
  })();
  return clickupRefreshInFlight;
}

// forceWeeks: also bypass the due-this/next-week bundles' 60-min TTL. Only set by
// an estimate edit or an explicit Refresh click - never by popup-open/alarms.
async function refreshClickupImpl({ includeTasks = false, viaAlarm = false, forceWeekly = false, forceWeeks = false } = {}) {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token) return { ok: false, reason: "not-configured" };
  if (!cfg.teamId || cfg.userId == null) return { ok: false, reason: "incomplete-setup" };
  const settings = await getSettings();
  const targetHours = Number(settings.clickupTargetHours) || 0;
  // Auto-detect the "Extra(s) Task(s)" task by name (no manual URL needed) and
  // fold it into the configured-task set, so today / weekly / filter all see it.
  const extraTask = await discoverExtraTask(cfg);
  const deadlineTaskUrls = mergeExtraTaskUrl(
    Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : [],
    extraTask
  );
  const extendedMode = settings.clickupExtendedMode === "excl0" ? "excl0" : "days";
  // One shared cache for configured-task fetches across today + weekly, so each
  // by-URL task is fetched from the API at most once per refresh.
  const taskCache = createTaskCache();
  try {
    const data = await fetchTodayEstimate({ token: cfg.token, teamId: cfg.teamId, userId: cfg.userId, targetHours, deadlineTaskUrls, extendedMode, taskCache });

    // Weekly accumulation (current week Mon→Fri). fetchWeeklySummary computes BOTH
    // the Mon→today and Mon→Friday aggregates in one pass, so the popup's
    // ToToday/ToFriday toggle just re-renders from the cached state - no network.
    // The week recompute is throttled (~30 min TTL): the popup/options only read
    // the cached state, and "today's" freshness already comes from the 5-min
    // fetchTodayEstimate above. It also re-runs when the week rolls over.
    let weekly = null;
    try {
      const nowDate = new Date();
      const monday = new Date(nowDate);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(nowDate.getDate() - ((nowDate.getDay() + 6) % 7));
      const friEnd = new Date(monday);
      friEnd.setDate(monday.getDate() + 4);
      friEnd.setHours(23, 59, 59, 999);
      const mondayTs = monday.getTime();
      const friEndTs = friEnd.getTime();
      const prev = (await getClickupState().catch(() => null)) || null;
      const prevWeekly = prev && prev.weekly;
      const WEEKLY_TTL = 30 * 60000;
      const weekChanged = !prevWeekly ||
        prevWeekly.fromTs !== mondayTs || prevWeekly.toTs !== friEndTs;
      if (!forceWeekly && !weekChanged && prevWeekly.at && Date.now() - prevWeekly.at < WEEKLY_TTL) {
        weekly = prevWeekly; // still fresh - reuse without extra API calls
      } else {
        weekly = await fetchWeeklySummary({
          token: cfg.token,
          teamId: cfg.teamId,
          userId: cfg.userId,
          taskUrls: deadlineTaskUrls,
          fromTs: mondayTs,
          toTs: friEndTs,
          extendedMode,
          taskCache,
        });
        weekly.at = Date.now();
      }
      // Remember which slice the user last picked so the popup can settle its toggle.
      weekly.weeklyToView = settings.clickupWeeklyTo === "friday" ? "friday" : "today";
    } catch (e) {
      weekly = null;
    }

    // Carry over the cached member directory (used by Department Creator) - the
    // per-cycle refresh below replaces the whole state object.
    const prevSt = await getClickupState();
    const members = (prevSt && Array.isArray(prevSt.members)) ? prevSt.members : null;
    const membersAt = (prevSt && prevSt.membersAt) || 0;

    // "Due this week" and "Due next week" scopes, each the full Sunday→Saturday of
    // its calendar week. Both are ADDITIONAL fan-outs (computeFilterData over a date
    // range), so each carries its own longer TTL (~60 min) and, unlike weekly,
    // deliberately IGNORES forceWeekly: opening the popup must not re-pay these costs.
    // A bundle refetches only when its hour elapses or the week rolls over (range
    // bounds change). Best-effort: a failure leaves whichever bundle already built and
    // the rest of the refresh proceeds. (This is DUE-date bounded, distinct from the
    // Mon→Fri `weekly` summary card, which is tracked-time accumulated and untouched.)
    let thisWeek = null;
    let thisWorkweek = null;
    let nextWeek = null;
    try {
      const nowD = new Date();
      const sun = new Date(nowD);
      sun.setHours(0, 0, 0, 0);
      sun.setDate(nowD.getDate() - nowD.getDay()); // this week's Sunday (getDay 0=Sun)
      const sat = new Date(sun); sat.setDate(sun.getDate() + 6); sat.setHours(23, 59, 59, 999);
      const nSun = new Date(sun); nSun.setDate(sun.getDate() + 7);
      const nSat = new Date(nSun); nSat.setDate(nSun.getDate() + 6); nSat.setHours(23, 59, 59, 999);
      const WEEK_TTL = 60 * 60000;
      const buildWeek = async (prev, fromTs, toTs) => {
        const rangeChanged = !prev || prev.fromTs !== fromTs || prev.toTs !== toTs;
        if (!forceWeeks && !rangeChanged && prev.at && Date.now() - prev.at < WEEK_TTL) return prev; // fresh - no API calls
        const w = await computeFilterData(cfg, settings, [], fromTs, toTs);
        // "Due this week" / "Due next week" / "Due Mon-Fri" are STRICTLY
        // due-bounded scopes: a task belongs to a week bundle only when its DUE
        // date falls inside [fromTs, toTs]. computeFilterData's span-overlap rule
        // (an extended single-day task shows on every day it spans - correct for
        // the Today/Tomorrow cards) would also pull in an extended task whose DUE
        // is beyond the week's end (e.g. a Sun 9/20-Sat 9/26 "Due next week" next
        // bundle erroneously listing a task due Mon 9/28). Prune those rows here,
        // at the single chokepoint all three week surfaces read, and recompute the
        // estimate total from the surviving rows so the badge/headline match the
        // listing. trackedTasks (time spent IN the range) are intentionally kept -
        // they reflect tracked time, not a due claim.
        const prune = (rows) => (Array.isArray(rows) ? rows : []).filter((t) => {
          const d = Number(t && t.dueDateMs) || 0;
          if (!d) return true;            // no due → not a due-bound claim to prune
          return d >= fromTs && d <= toTs;
        });
        const tasks = prune(w.tasks);
        const deadlineTasks = prune(w.deadlineTasks);
        const sumEst = (arr, k) => arr.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
        return {
          estimateMs: sumEst(tasks, "estimateMs") + sumEst(deadlineTasks, "dayEstimateMs"),
          spentMs: w.spentMs,
          fromTs,
          toTs,
          tasks,
          deadlineTasks,
          trackedTasks: Array.isArray(w.trackedTasks) ? w.trackedTasks : [],
          taskCount: tasks.length + deadlineTasks.length,
          noEstimateCount: tasks.filter((t) => !Number(t.estimateMs)).length
            + deadlineTasks.filter((t) => !Number(t.dayEstimateMs)).length,
          at: Date.now(),
        };
      };
      thisWeek = await buildWeek((prevSt && prevSt.thisWeek) || null, sun.getTime(), sat.getTime());
      nextWeek = await buildWeek((prevSt && prevSt.nextWeek) || null, nSun.getTime(), nSat.getTime());
      // "Due Mon-Fri" = the current week's workday slice. Subset of thisWeek
      // (Sun→Sat): filter its rows by dueDateMs in [Mon 00:00, Fri 23:59] purely
      // in-memory, so it never triggers another ClickUp fetch and rides thisWeek's
      // TTL/refresh cycle (rebuilt alongside it on every pass).
      if (thisWeek) {
        const mon = new Date(sun); mon.setDate(sun.getDate() + 1);
        const fri = new Date(sun); fri.setDate(sun.getDate() + 5); fri.setHours(23, 59, 59, 999);
        const monTs = mon.getTime();
        const friTs = fri.getTime();
        const inRange = (t) => {
          const d = Number(t && t.dueDateMs) || 0;
          return d >= monTs && d <= friTs;
        };
        const wwTasks = (Array.isArray(thisWeek.tasks) ? thisWeek.tasks : []).filter(inRange);
        const wwDeadline = (Array.isArray(thisWeek.deadlineTasks) ? thisWeek.deadlineTasks : []).filter(inRange);
        const wwTracked = (Array.isArray(thisWeek.trackedTasks) ? thisWeek.trackedTasks : []).filter(inRange);
        const sum = (arr, key) => arr.reduce((n, t) => n + (Number(t && t[key]) || 0), 0);
        const estMs = sum(wwTasks, "estimateMs") + sum(wwDeadline, "dayEstimateMs");
        const spentMs = sum(wwTasks, "spentMs") + sum(wwDeadline, "spentMs") + sum(wwTracked, "spentMs");
        thisWorkweek = {
          estimateMs: estMs,
          spentMs,
          fromTs: monTs,
          toTs: friTs,
          tasks: wwTasks,
          deadlineTasks: wwDeadline,
          trackedTasks: wwTracked,
          taskCount: wwTasks.length,
          noEstimateCount: wwTasks.filter((t) => !t.hasEstimate).length,
          at: thisWeek.at,
        };
      }
    } catch (e) {
      // Leave whichever bundle already built (thisWeek runs first); the other stays null.
    }

    // The currently-running timer (if any) so the popup/options can render the
    // right Start/Stop toggle. Best-effort: a failure here must not abort the
    // whole refresh, so default to null.
    let running = null;
    try { running = await getCurrentTimeEntry(cfg.token, cfg.teamId); } catch (e) { running = null; }
    const state = {
      estimateMs: data.estimateMs,
      spentMs: data.spentMs,
      targetMs: data.targetMs,
      targetHours: data.targetHours,
      taskCount: data.taskCount,
      noEstimateCount: data.noEstimateCount,
      targetMet: data.targetMet,
      deadlineTasks: data.deadlineTasks,
      deadlineEstimateMs: data.deadlineEstimateMs,
      deadlineSpentMs: data.deadlineSpentMs,
      tasks: data.tasks, // always stored so the popup can show the breakdown
      weekly, // Mon→today/Fri accumulated estimate + tracked
      thisWeek, // this Sun→Sat "due this week" bundle (own ~60-min TTL)
      thisWorkweek, // this Mon→Fri "due Mon-Fri" bundle (in-memory subset of thisWeek)
      nextWeek, // next Sun→Sat "due next week" bundle (own ~60-min TTL)
      extraTask: extraTask || null, // auto-detected "Extra(s) Task(s)"
      running: running || null, // live timer (taskId/taskName/startMs) or null
      at: data.at,
      error: null,
      rateLimitedUntil: 0, // a clean fetch clears any prior 429 backoff
      members,
      membersAt,
    };
    // The upper today card mirrors the Filter "Today + My tasks" default: attach
    // the identical computation so its numbers and task list match the filter.
    state.todayFilter = await getTodayFilterData(cfg, settings);
    // Stamp client names on every row (today tasks / deadline / weekly / filter)
    // so the popup + options can show a client tag and filter by client.
    await annotateClients(cfg.token, state, settings.cuClientLevel || "auto");
    await setClickupState(state);
    await maybeNotifyClickup(state, { viaAlarm });
    await maybeNotifyRunningTask(cfg).catch(() => {});
    await maybeNotifyNotTracking(cfg, { viaAlarm }).catch(() => {});
    return { ok: true, data: includeTasks ? { ...state, tasks: data.tasks } : state };
  } catch (e) {
    // Keep the last good numbers (if any) and just annotate the error, so the UI
    // can say "couldn't refresh" without blanking the panel.
    const prev = (await getClickupState()) || {};
    const state = { ...prev, error: String(e && e.message ? e.message : e), errorAt: Date.now() };
    // On a 429, back off: park a cooldown so auto-refreshes stop hitting the API
    // until ClickUp's own Retry-After window elapses (default ~1 min).
    if (e && e.status === 429) {
      state.rateLimitedUntil = Date.now() + (Number(e.retryAfterMs) || 60000);
    }
    await setClickupState(state);
    return { ok: false, reason: "fetch-failed", error: state.error };
  }
}

// Progressive desktop nudges, at most once each per calendar day:
//   • "halfway" - the moment the summed estimate crosses 50% of the goal.
//   • "almost there" - the moment it crosses ~86% of the goal (e.g. 6h of 7h).
//   • "target reached ✓" - the moment the summed estimate crosses the goal.
//   • "still under target" - only from the alarm path AND after clickupNudgeHour,
//     so it can't fire first thing in the morning.
//   • "workday ending" - only from the alarm path AND after clickupWorkdayEndHour,
//     as a final end-of-day warning if the target still isn't met.
async function maybeNotifyClickup(state, { viaAlarm }) {
  const settings = await getSettings();
  if (settings.clickupNotify === false) return;
  if (!state || !(Number(state.targetMs) > 0)) return;
  const { clickupNotified } = await chrome.storage.local.get("clickupNotified");
  const seen = clickupNotified && typeof clickupNotified === "object" ? clickupNotified : {};
  const today = todayString();
  const estMs = Number(state.estimateMs) || 0;
  const spentMs = Number(state.spentMs) || 0;
  const tgtMs = Number(state.targetMs) || 0;
  const estTxt = fmtDuration(estMs);
  const spentTxt = fmtDuration(spentMs);
  const tgtTxt = fmtDuration(tgtMs);

  // --- Estimate-based milestones (fire only while UNDER 100% of target) ---

  // Halfway milestone - fires only inside the 40%-60% window so the user
  // sees it right around the midpoint, not at 86% or 107%.
  const halfLo = tgtMs * 0.4;
  const halfHi = tgtMs * 0.6;
  if (settings.clickupHalfwayNotify !== false && estMs >= halfLo && estMs <= halfHi && seen.halfway !== today) {
    await notify("clickup-halfway-" + Date.now(), "ClickUp - halfway to your daily estimate ⏳",
      "Estimated " + estTxt + " (" + Math.round((estMs / tgtMs) * 100) + "% of " + tgtTxt + ")" +
      (spentMs > 0 ? " · tracked " + spentTxt : "") + ".");
    await chrome.storage.local.set({ clickupNotified: { ...seen, halfway: today } });
  }

  // "Almost there" - fires at ~86% (i.e. 6h of 7h) up to <100%.
  const almostMs = tgtMs * 0.857;
  if (settings.clickupAlmostThereNotify !== false && estMs >= almostMs && estMs < tgtMs && seen.almost !== today) {
    await notify("clickup-almost-" + Date.now(), "ClickUp - almost at your daily estimate 🎯",
      "Just " + fmtDuration(Math.max(0, tgtMs - estMs)) + " to go (estimated " + estTxt + " of " + tgtTxt + ")" +
      (spentMs > 0 ? " · tracked " + spentTxt : "") + ".");
    await chrome.storage.local.set({ clickupNotified: { ...seen, almost: today } });
  }

  // Target reached (>= 100%) - the day's estimate goal is met, so celebrate.
  if (state.targetMet) {
    if (seen.met !== today) {
      await notify("clickup-met-" + Date.now(), "ClickUp - daily estimate reached ✓",
        estTxt + " estimated for today (target " + tgtTxt + ")" +
        (spentMs > 0 ? " · tracked " + spentTxt : "") + ".",
        "winner");
      await chrome.storage.local.set({ clickupNotified: { ...seen, met: today } });
    }
    return; // past target: no nudge / end-of-day nags
  }

  // --- Tracked-time milestones (independent of estimate; same thresholds) ---

  if (spentMs >= halfLo && spentMs <= halfHi && seen.spentHalfway !== today) {
    await notify("clickup-spent-half-" + Date.now(), "ClickUp - tracked halfway ⏳",
      "Tracked " + spentTxt + " (" + Math.round((spentMs / tgtMs) * 100) + "% of " + tgtTxt + ")" +
      " · estimated " + estTxt + ".");
    await chrome.storage.local.set({ clickupNotified: { ...seen, spentHalfway: today } });
  }

  if (spentMs >= almostMs && spentMs < tgtMs && seen.spentAlmost !== today) {
    await notify("clickup-spent-almost-" + Date.now(), "ClickUp - almost there (tracked) 🎯",
      "Tracked " + spentTxt + " of " + tgtTxt + " - just " + fmtDuration(Math.max(0, tgtMs - spentMs)) + " to go" +
      " · estimated " + estTxt + ".");
    await chrome.storage.local.set({ clickupNotified: { ...seen, spentAlmost: today } });
  }

  if (spentMs >= tgtMs && seen.spentMet !== today) {
    // Tracked time crossed the day's goal - same celebration as the estimate win.
    await notify("clickup-spent-met-" + Date.now(), "ClickUp - tracked target reached ✓",
      "Tracked " + spentTxt + " (target " + tgtTxt + ") · estimated " + estTxt + ".",
      "winner");
    await chrome.storage.local.set({ clickupNotified: { ...seen, spentMet: today } });
  }

  if (!viaAlarm) return; // don't nudge on manual refresh
  const hour = new Date().getHours();
  const nudgeHour = Number(settings.clickupNudgeHour);
  if (Number.isFinite(nudgeHour) && hour >= nudgeHour && seen.nudge !== today) {
    const shortMs = Math.max(0, tgtMs - estMs);
    // Still under the day's target late in the day - the urgent alarm is right.
    await notify("clickup-nudge-" + Date.now(), "ClickUp - under your daily estimate",
      "Estimated " + estTxt + " / " + tgtTxt + " · tracked " + spentTxt + " · " + fmtDuration(shortMs) + " short.",
      "danger");
    await chrome.storage.local.set({ clickupNotified: { ...seen, nudge: today } });
  }
  // End-of-day warning - fires once after workdayEndHour if still under target.
  const endHour = Number(settings.clickupWorkdayEndHour);
  if (Number.isFinite(endHour) && hour >= endHour && seen.endOfDay !== today) {
    const shortMs = Math.max(0, tgtMs - estMs);
    await notify("clickup-endofday-" + Date.now(), "ClickUp - workday winding down 🕔",
      "Estimated " + estTxt + " of " + tgtTxt + " · tracked " + spentTxt + " · " + fmtDuration(shortMs) + " short.",
      "danger");
    await chrome.storage.local.set({ clickupNotified: { ...seen, endOfDay: today } });
  }
}

// Per-task nudge: fires once per task per day when the CURRENTLY RUNNING
// ClickUp timer's tracked time (today's closed entries on that task + the live
// segment since the timer started) comes within `clickupRunningThresholdMin`
// minutes of that task's own time_estimate - e.g. "50 of 60 min tracked, wrap
// up soon." Fires a separate one-time "reached" nudge once it's actually hit
// or passed the estimate. Independent of the daily-aggregate nudges above.
// Best-effort: this only runs on the 5-minute ClickUp poll, so a task whose
// remaining time crosses the whole threshold window between two polls just
// gets the "reached" notification instead of "almost up" - it still fires.
async function maybeNotifyRunningTask(cfg) {
  if (!cfg || !cfg.token || !cfg.teamId) return;
  const settings = await getSettings();
  if (settings.clickupRunningNotify === false) return;
  let entry;
  try {
    entry = await getCurrentTimeEntry(cfg.token, cfg.teamId);
  } catch (e) {
    return; // best-effort - don't let a failed lookup break the rest of the refresh
  }
  if (!entry) return;
  let progress;
  try {
    progress = await getRunningTaskProgress(cfg.token, cfg.teamId, entry.taskId, entry.startMs);
  } catch (e) {
    return;
  }
  if (!progress) return; // task has no estimate set - nothing to compare against
  const { clickupNotified } = await chrome.storage.local.get("clickupNotified");
  const seen = clickupNotified && typeof clickupNotified === "object" ? clickupNotified : {};
  const runningNear = (seen.runningNear && typeof seen.runningNear === "object") ? seen.runningNear : {};
  const runningMet = (seen.runningMet && typeof seen.runningMet === "object") ? seen.runningMet : {};
  const today = todayString();
  const key = String(entry.taskId);
  const thresholdMs = Math.max(1, Number(settings.clickupRunningThresholdMin) || 10) * 60000;
  const remainingMs = progress.estimateMs - progress.trackedMs;
  const name = progress.taskName || entry.taskName || "this task";
  if (remainingMs <= 0) {
    if (runningMet[key] !== today) {
      // Tracked time has crossed the task's OWN estimate - alert with the
      // urgent "danger" sound so the user notices even if they miss the toast.
      const overMs = progress.trackedMs - progress.estimateMs;
      const exceeded = overMs >= 60000; // more than a minute past the estimate
      const taskUrl = taskUrlFor(entry.taskId);
      await notify(
        "clickup-running-met-" + Date.now(),
        exceeded ? "ClickUp - estimate exceeded ⚠️" : "ClickUp - estimate reached ⚠️",
        "\"" + name + "\" has " + (exceeded ? "gone " + fmtDuration(overMs) + " over" : "reached") +
          " its " + fmtDuration(progress.estimateMs) + " estimate (tracked " + fmtDuration(progress.trackedMs) + ").",
        "danger",
        taskUrl
      );
      await chrome.storage.local.set({ clickupNotified: { ...seen, runningMet: { ...runningMet, [key]: today } } });
    }
  } else if (remainingMs <= thresholdMs) {
    if (runningNear[key] !== today) {
      // Tracked time is about to reach the task's own estimate - warn with the
      // urgent alarm so the user wraps up in time (not just after crossing).
      const taskUrl = taskUrlFor(entry.taskId);
      await notify("clickup-running-near-" + Date.now(), "ClickUp - estimate almost up ⏳",
        "\"" + name + "\" has " + fmtDuration(remainingMs) + " left of its " + fmtDuration(progress.estimateMs) + " estimate - wrap up soon.",
        "danger",
        taskUrl);
      await chrome.storage.local.set({ clickupNotified: { ...seen, runningNear: { ...runningNear, [key]: today } } });
    }
  }
}

// "Are you working?" reminder: fires when NO ClickUp timer is running during
// office hours (Mon-Fri, configurable start/end hour), for when you start work
// but forget to start the timer. Re-nudges at most once per clickupIdleRepeatMin
// so it can't spam. As soon as a timer IS running, the idle-nudge memory resets
// so the next idle stretch nudges again. Only runs on the 5-minute alarm poll.
async function maybeNotifyNotTracking(cfg, { viaAlarm = false } = {}) {
  if (!viaAlarm) return; // never nudge on a manual refresh - only the background poll
  if (!cfg || !cfg.token || !cfg.teamId) return;
  const settings = await getSettings();
  if (settings.clickupIdleNotify === false) return;

  const now = new Date();
  const dow = now.getDay(); // 0=Sun..6=Sat
  if (dow === 0 || dow === 6) return; // office hours are Mon-Fri only

  const startHour = Number.isFinite(Number(settings.clickupIdleStartHour)) ? Number(settings.clickupIdleStartHour) : 8;
  const endHour = Number.isFinite(Number(settings.clickupIdleEndHour)) ? Number(settings.clickupIdleEndHour) : 17;
  const hour = now.getHours();
  // Inside office hours [start, end). If misconfigured (start >= end), skip.
  if (!(startHour < endHour && hour >= startHour && hour < endHour)) return;

  // Is a timer running right now?
  let entry;
  try {
    entry = await getCurrentTimeEntry(cfg.token, cfg.teamId);
  } catch (e) {
    return; // best-effort - a failed lookup shouldn't nudge OR break the refresh
  }

  const { clickupNotified } = await chrome.storage.local.get("clickupNotified");
  const seen = clickupNotified && typeof clickupNotified === "object" ? clickupNotified : {};

  if (entry) {
    // A timer is running - clear the idle marker so the next idle stretch (e.g.
    // after they stop for a break) nudges again.
    if (seen.idleNudgeAt) {
      await chrome.storage.local.set({ clickupNotified: { ...seen, idleNudgeAt: 0 } });
    }
    return;
  }

  // No timer running. Honor the re-nudge interval so we don't fire every poll.
  const repeatMs = Math.max(5, Number(settings.clickupIdleRepeatMin) || 60) * 60000;
  const lastAt = Number(seen.idleNudgeAt) || 0;
  if (lastAt && Date.now() - lastAt < repeatMs) return;

  await notify("clickup-idle-" + Date.now(), "Time tracking hasn't started yet ⏱️",
    "No ClickUp timer is running. Are you working? Start your timer so today's time gets tracked.",
    "danger");
  await chrome.storage.local.set({ clickupNotified: { ...seen, idleNudgeAt: Date.now() } });
}

// ---------- badge ----------
// Resolve the badge's estimate to the SAME widest-checked date scope the popup/
// options headline uses. Date scopes are nested (today ⊂ this-week ⊂ Friday), so
// the widest checked wins; the refine boxes (missingEst/deadlineCrossed) narrow
// only the task list, never the badge. Nothing checked = the extended "active
// today" view (state.todayFilter), matching the prior default. Falls back to
// todayFilter/st when a chosen weekly slice isn't in state yet.
function cuScopeEstimateMs(st, f) {
  st = st || {};
  f = f || {};
  const wk = st.weekly || null;
  if (f.dueNextWeek && st.nextWeek) return Number(st.nextWeek.estimateMs) || 0;
  if (f.dueWeek && st.thisWeek) return Number(st.thisWeek.estimateMs) || 0;
  if (f.dueWorkweek && st.thisWeek) return Number(st.thisWeek.estimateMs) || 0; // legacy "Due Mon-Fri" -> this week
  if (f.dueToday) return Number(st.estimateMs) || 0;
  const tf = st.todayFilter || st;
  return Number(tf.estimateMs) || 0;
}

async function updateBadge() {
  const settings = await getSettings();
  const accounts = (await getAccounts()).filter((a) => effectiveMode(a, settings) !== "off");
  const status = await getStatus();
  let done = 0;
  let attention = 0;
  let pending = 0;
  for (const a of accounts) {
    const st = status[a.id] || {};
    if (isDoneWithinWindow(st)) done++;
    else if (st.lastResult && st.lastResult !== "success" && isToday(st.lastRunAt)) attention++;
    else pending++;
  }
  let text = "";
  let color = "#6b7280";
  if (accounts.length === 0) text = "";
  else if (attention > 0) {
    text = "!";
    color = "#ef4444";
  } else if (pending > 0) {
    text = String(pending);
    color = "#f59e0b";
  } else if (done > 0) {
    text = "✓";
    color = "#22c55e";
  }
  // ClickUp progress rides the same badge, but a login that "needs you" keeps
  // priority (it's time-sensitive and actionable). Otherwise show the day's
  // estimate: "✓" once the target is met, else whole hours accumulated so far.
  if (settings.clickupBadge !== false && attention === 0) {
    const cfg = await getClickupConfig();
    const st = await getClickupState();
    if (cfg && cfg.token && st && Number(st.targetMs) > 0 && !st.error) {
      // Mirror the popup/options headline exactly: the estimate follows the
      // WIDEST checked date scope in the shared cuFilter (refine boxes don't
      // affect the badge). See cuScopeEstimateMs above.
      let cuFilter = { dueToday: true }; // same default as the popup/options filter
      try {
        const g = await chrome.storage.local.get("cuFilter");
        if (g && g.cuFilter && typeof g.cuFilter === "object") cuFilter = g.cuFilter;
      } catch (e) {}
      const estMs = cuScopeEstimateMs(st, cuFilter);
      const targetMs = Number(st.targetMs) || 0;
      const met = targetMs > 0 && estMs >= targetMs;
      if (met) {
        const h = Math.floor(estMs / 3600000);
        text = "✓" + (h >= 1 ? h + "h" : "");
        color = "#22c55e";
      } else {
        const h = Math.floor(estMs / 3600000);
        text = h >= 1 ? h + "h" : "<1";
        color = "#f59e0b";
      }
    }
  }
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {}
}

// ---------- online check ----------
async function isOnline() {
  try {
    await fetch("https://www.gstatic.com/generate_204", { method: "GET", mode: "no-cors", cache: "no-store" });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- notifications ----------
// Offscreen-document audio: MV3 service workers have no DOM/Audio, so the chime
// is played by offscreen.html. We keep a single offscreen document alive between
// plays (notifications are infrequent) to avoid create/close races.
let offscreenCreating = null; // in-flight createDocument promise (guards concurrency)
async function hasOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      return Array.isArray(ctx) && ctx.length > 0;
    }
  } catch (e) {}
  try {
    if (chrome.offscreen && chrome.offscreen.hasDocument) return await chrome.offscreen.hasDocument();
  } catch (e) {}
  return false;
}
async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (offscreenCreating) { await offscreenCreating; return; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a chime when a reminder notification appears.",
  });
  try {
    await offscreenCreating;
  } catch (e) {
    // A concurrent create may have already made one - ignore "already exists".
  } finally {
    offscreenCreating = null;
  }
}
// Play the notification sound. Respects the notifySound setting unless force
// (the Options "Test sound" button always previews). `sound` selects which clip
// the offscreen document plays: "danger" = the urgent alarm, "winner" = the
// celebration clip, else the default chime.
async function playNotificationSound(force, sound) {
  try {
    if (!force) {
      const s = await getSettings();
      if (!s.notifySound) return;
    }
    await ensureOffscreenDocument();
    // A nonce tags THIS logical play (shared across retries so a lost ack isn't
    // re-queued, but distinct from any other notification even with the same clip).
    const nonce = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    // Send with an ack + retry: right after createDocument() resolves, the
    // offscreen page's onMessage listener can be a beat behind, so the first
    // send may reach no receiver. Retry a few times until it acks. Awaiting
    // this (see notify) also keeps the service worker alive long enough for a
    // cold-start create + play to finish - the reason the chime used to be
    // dropped on some notifications.
    for (let attempt = 0; attempt < 6; attempt++) {
      const ok = await sendPlaySound(sound, nonce);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 70));
    }
  } catch (e) {}
}
// One PLAY_SOUND round-trip. Resolves true only if the offscreen doc acked.
function sendPlaySound(sound, nonce) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "PLAY_SOUND", target: "offscreen", sound: sound || "notify", nonce },
        (resp) => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          resolve(!!(resp && resp.ok));
        }
      );
    } catch (e) {
      resolve(false);
    }
  });
}

// Notification target URLs (in-memory map of notification id -> URL to open on click).
const notifTargetUrls = new Map();

// Show a desktop notification AND play its sound. Awaiting the returned promise
// keeps the MV3 worker alive through playback (callers in the alarm/refresh
// chain do await it), so the chime is no longer dropped on a cold worker.
// `sound` = "danger" for the urgent alarm, "winner" for a milestone celebration,
// or omitted for the default chime. `targetUrl` = optional link to open on click.
async function notify(id, title, message, sound, targetUrl) {
  if (targetUrl) {
    notifTargetUrls.set(id, targetUrl);
  } else if (id.startsWith("clickup-") || id.startsWith("cu-")) {
    notifTargetUrls.set(id, "https://app.clickup.com");
  }
  try {
    chrome.notifications.create(
      id,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title,
        message,
        priority: 0,
      },
      () => void chrome.runtime.lastError // swallow "no icon"/permission edge cases
    );
  } catch (e) {}
  // Chime alongside the toast (gated by the notifySound setting).
  await playNotificationSound(false, sound);
}

// Summarize a finished batch (from runAccounts) into one desktop notification,
// only if the user has notifications enabled and something actually happened.
async function maybeNotifyBatch(results) {
  const settings = await getSettings();
  if (!settings.notify) return;
  if (!results || typeof results !== "object") return;
  const entries = Object.values(results).filter(Boolean);
  if (!entries.length) return;
  let ok = 0;
  let attn = 0;
  let fail = 0;
  for (const r of entries) {
    if (r.result === "success") ok++;
    else if (r.result === "needs-attention") attn++;
    else fail++;
  }
  const parts = [];
  if (ok) parts.push(`${ok} logged in`);
  if (attn) parts.push(`${attn} need${attn === 1 ? "s" : ""} you`);
  if (fail) parts.push(`${fail} failed`);
  if (!parts.length) return;
  const title = attn || fail ? "Daily login - action needed" : "Daily login complete";
  await notify("daily-login-batch-" + Date.now(), title, parts.join(" · "));
}

// ---------- run orchestration ----------
let isRunning = false;
let cancelRequested = false;

// Drive sign-in / sync progress, surfaced via GET_STATE so the popup shows the
// right phase EVEN AFTER it closes. (Interactive Google sign-in opens a separate
// window, which makes the toolbar popup lose focus and close - so any "Signing
// in…" text set locally in the popup is lost. Tracking it here means whenever
// the popup reopens it reads the true phase.) "" = idle.
let driveBusy = ""; // "" | "signin" | "sync"
function setDriveBusy(phase) {
  driveBusy = phase || "";
  // Nudge any open popup/options to re-read state and repaint the sync line.
  chrome.runtime.sendMessage({ type: "DRIVE_BUSY", phase: driveBusy }).catch(() => {});
}

// Cancel checker passed into the login automator so the state loop can bail out
// immediately when the user hits Debug → Stop (instead of running to timeout).
function isCancelledFn() {
  return cancelRequested;
}

// One-time-per-session hydration of local `status` from Drive. On a fresh install
// / new browser / reinstall, local `status` is empty, so a manual Run's done
// callback would read an empty `prev`, treat it as a FIRST login, and stamp a new
// lastDoneAt - overwriting the real (earlier) earning checkpoint that already
// lives in Drive. Pulling first means `prev` carries the true checkpoint, so the
// run preserves it (isDoneWithinWindow(prev) is true) instead of resetting the
// 24h countdown. Silent + best-effort: if not signed in, we simply proceed with
// whatever local status we have (unchanged behavior for non-Drive users).
let statusHydrated = false;
async function ensureStatusHydrated() {
  if (statusHydrated) return;
  statusHydrated = true; // set first so a failure doesn't retry-storm every run
  try {
    if (!(await isSignedIn())) return;
    const pulled = await pullFromDrive(await getStatus());
    if (pulled && pulled.ok) {
      await chrome.storage.local.set({ status: pulled.status });
      await updateBadge().catch(() => {});
    }
  } catch (e) {}
}

// A `lastResult: "running"` status only makes sense inside one live worker
// (isRunning is an in-memory flag). Seeing it at worker startup means the worker
// that set it was suspended/crashed mid-login, so it's stale - and shouldRun()
// treats "running" as "skip", which would wedge that account out of the daily
// auto-login forever. Clear it back to a neutral, runnable state (keeping the
// earning checkpoint lastDone/lastDoneAt) exactly once per worker.
let staleRunningCleared = false;
async function clearStaleRunningOnce() {
  if (staleRunningCleared) return;
  staleRunningCleared = true;
  try {
    const status = await getStatus();
    let changed = false;
    for (const id of Object.keys(status)) {
      const rec = status[id];
      if (rec && rec.lastResult === "running") {
        status[id] = { ...rec, lastResult: "", note: "" };
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.local.set({ status });
      updateBadge().catch(() => {});
    }
  } catch (e) {}
}

async function runAccounts(accountsToRun, { active, manual = false }) {
  // Make sure the earning checkpoint from Drive is in place before we stamp any
  // new status, so a post-reinstall Run doesn't look like a first-time login.
  await ensureStatusHydrated();
  const settings = await getSettings();
  // Slow/unreliable connection: give every navigation step twice as long.
  const timeoutScale = settings.slowNetwork ? 2 : 1;
  const results = await runAllAccounts(
    accountsToRun,
    // Successful logins close their Agent Router tab (auto runs always did; manual
    // runs now do too unless the user turned arCloseTabs off). Tabs that need the
    // user - CAPTCHA, 2FA, failures - are always left open.
    { targetUrl: settings.targetUrl, active, keepTabs: manual && settings.arCloseTabs === false, timeoutScale, isCancelled: isCancelledFn },
    async ({ accountId, phase, result, note, detected }) => {
      if (phase === "start") {
        setStatusFor(accountId, { lastRunAt: Date.now(), lastResult: "running", note: "" });
      } else if (phase === "done") {
        const patch = { lastRunAt: Date.now(), lastResult: result, note: note || "" };
        if (result === "success") {
          const status = await getStatus();
          const prev = status[accountId] || {};
          if (isDoneWithinWindow(prev)) {
            // Already credited this window - preserve the earning checkpoint.
            patch.lastDone = prev.lastDone || todayString();
            patch.lastDoneAt = effectiveDoneAt(prev);
          } else {
            // No confirmed credit yet. Anchor the earning checkpoint ONLY when
            // refreshArCredit confirms a genuine balance RISE (>= the daily
            // amount). A first-ever sighting plants a BASELINE only - it never
            // counts leftover balance as a credited day (that's
            // exactly the false-positive you flagged on a fresh install where
            // the account already holds $30). The balance poll then anchors
            // lastDoneAt the exact moment a REAL daily credit lands (delta on
            // the current baseline), so a same-day leftover balance is ignored
            // and a genuine batch release is still caught and notified.
            // The previous 24h window has expired (checked above), so Agent
            // Router grants the daily credit on THIS login. Anchor the new
            // checkpoint at:
            //   - the detected credit moment when the balance shows a >= $24 rise;
            //   - this login's time when the balance is unreadable - marked
            //     creditSource "login";
            //   - nothing when a readable balance shows NO rise (genuinely not
            //     credited yet -> "awaiting credit"; the balance poll may anchor it).
            // A late login (e.g. 8:00 AM after a 10:58 PM reset) therefore moves
            // the checkpoint to 8:00 AM, matching Agent Router's own 24h clock.
            let checkpoint = 0;
            let source = "";
            if (detected && detected.balance != null) {
              const credit = await refreshArCredit(accountId, detected.balance, settings);
              if (credit.credited && credit.lastCreditAt) {
                checkpoint = credit.lastCreditAt;
                source = "balance";
              }
              // First balance ever seen (no baseline): just plant it. Treating it
              // as a credit mis-anchored a manual run made inside the real window.
            } else {
              checkpoint = Date.now();
              source = "login";
            }
            if (checkpoint) {
              patch.lastDone = todayString();
              patch.lastDoneAt = checkpoint;
              patch.creditSource = source;
            }
            // else: login succeeded but no confirmed credit yet; leave
            // lastDoneAt untouched. shouldRun() backs off 24h from lastRunAt
            // for successes (preventing re-login loops), and the balance poll
            // will anchor lastDoneAt the moment the credit lands.
          }
        }
        // Surface why the balance couldn't be read (diagnosis for the credit check).
        if (result === "success" && detected && detected.balance == null) {
          patch.note = (patch.note || "Logged in.") + " (balance unreadable" + (detected.balanceErr ? ": " + detected.balanceErr : "") + ")";
        }
        setStatusFor(accountId, patch);
        if (detected) applyDetected(accountId, detected).catch(() => {});
        // Balance rides in a separate local key (never mirrored to Drive).
        if (result === "success" && detected && detected.balance != null)
          setBalanceFor(accountId, detected.balance).catch(() => {});
      }
      chrome.runtime.sendMessage({ type: "RUN_PROGRESS", accountId, phase, result, note }).catch(() => {});
    }
  );
  return results;
}

// The daily auto path: only touches accounts not already attempted today, so it
// never re-opens tabs for an account that already succeeded or needs the user.
async function checkAndMaybeRun() {
  if (isRunning) return { ok: false, reason: "already running" };
  // Self-heal a status left as "running" by a worker that died mid-login (once
  // per worker), so a crashed run doesn't permanently block this account.
  await clearStaleRunningOnce();
  const settings = await getSettings();
  const accounts = await getAccounts();
  if (accounts.length === 0) return { ok: false, reason: "no accounts" };
  if (!(await isOnline())) return { ok: false, reason: "offline" };

  // Pull the earning checkpoint from Drive before deciding what's pending, so a
  // reinstall / new browser doesn't re-run (and re-stamp) an account another
  // machine already credited within this 24h window.
  await ensureStatusHydrated();

  // Reminder accounts: open the login page once per calendar day. A single
  // shared tab covers them all (they point at the same targetUrl), so we don't
  // track this per account. reminderOpenedDate is a standalone local key and is
  // deliberately NOT part of the Drive-mirrored status.
  const hasReminder = accounts.some((a) => effectiveMode(a, settings) === "reminder");
  if (hasReminder) {
    const { reminderOpenedDate } = await chrome.storage.local.get("reminderOpenedDate");
    if (reminderOpenedDate !== todayString()) {
      await chrome.tabs.create({ url: settings.targetUrl });
      await chrome.storage.local.set({ reminderOpenedDate: todayString() });
    }
  }

  // Auto accounts: log in the ones due within the rolling 24h window.
  const status = await getStatus();
  const pending = accounts.filter(
    (a) => effectiveMode(a, settings) === "auto" && shouldRun(status[a.id])
  );
  if (pending.length === 0)
    return { ok: true, reason: hasReminder ? "reminder handled; no auto pending" : "all done within the 24h window" };

  isRunning = true;
  cancelRequested = false;
  try {
    const results = await runAccounts(pending, { active: false });
    await maybeNotifyBatch(results);
  } finally {
    isRunning = false;
    cancelRequested = false;
  }
  return { ok: true, reason: "ran", count: pending.length };
}

// ---------- lifecycle ----------
// Best-effort silent Drive sync: only runs when we can get a token WITHOUT
// prompting. Keeps the implicit-flow token warm (each silent refresh resets the
// ~1h clock) and mirrors accounts/status so you don't have to keep re-signing-in
// or hitting "Sync now" by hand.
async function autoSyncIfSignedIn() {
  try {
    if (!(await isSignedIn())) return; // no valid/silently-refreshable token
    await syncNow();
  } catch (e) {}
}

// ---------- Update check (GitHub Releases) ----------
// The extension is distributed as GitHub Releases (a zip per version). About
// twice a day it asks GitHub for the latest release; when that is newer than the
// installed manifest version it stores `updateInfo` (the popup/options show an
// "Update available" link) and shows ONE notification per new version.
// UPDATE_REPO is "<github-user>/<repo>" - set when the repository is created.
const UPDATE_REPO = "Dipson-bot/personal-clickup-manager";
const UPDATE_CHECK_MS = 12 * 3600 * 1000;
function cmpVersion(a, b) {
  const pa = String(a || "").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
// force: fetch now (ignore the 12h throttle). forceNotify: show the
// notification even if already shown (only for the user's own "Check for updates").
async function checkForUpdate(force, forceNotify = false) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(UPDATE_REPO) || UPDATE_REPO === "OWNER/REPO") return { ok: false, reason: "not-configured" };
  const current = chrome.runtime.getManifest().version;
  const { updateInfo: prev } = await chrome.storage.local.get("updateInfo");
  if (!force && prev && prev.current === current && Date.now() - (prev.checkedAt || 0) < UPDATE_CHECK_MS) return { ok: true, ...prev };
  try {
    const res = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest", {
      headers: { Accept: "application/vnd.github+json" }, cache: "no-store",
    });
    if (!res.ok) throw new Error("GitHub HTTP " + res.status);
    const j = await res.json();
    const latest = String(j.tag_name || "").replace(/^v/i, "");
    const zip = (Array.isArray(j.assets) ? j.assets : []).find((a) => /\.zip$/i.test(a.name || ""));
    const info = {
      checkedAt: Date.now(), current, latest,
      newer: !!latest && cmpVersion(latest, current) > 0,
      url: j.html_url || "https://github.com/" + UPDATE_REPO + "/releases/latest",
      zip: zip ? zip.browser_download_url : "",
      notifiedFor: prev && prev.notifiedFor,
      notifiedAt: prev && prev.notifiedAt,
    };
    // Notify when a version is new to us, again every 24h until its zip is
    // downloaded (a dismissed or "What's new"-clicked toast is not lost), and
    // whenever the user presses "Check for updates" themselves.
    const { updateDownload: dl } = await chrome.storage.local.get("updateDownload");
    const downloaded = dl && dl.version === latest;
    const due = info.notifiedFor !== latest || Date.now() - (info.notifiedAt || 0) >= 24 * 3600 * 1000;
    if (info.newer && (forceNotify || (due && !downloaded))) {
      info.notifiedFor = latest;
      info.notifiedAt = Date.now();
      await chrome.storage.local.set({ updateInfo: info });
      await showUpdateNotification(info);
    }
    await chrome.storage.local.set({ updateInfo: info });
    return { ok: true, ...info };
  } catch (e) {
    const info = { ...(prev || {}), current, checkedAt: Date.now(), error: String(e && e.message ? e.message : e) };
    if (info.latest) info.newer = cmpVersion(info.latest, current) > 0;
    await chrome.storage.local.set({ updateInfo: info });
    return { ok: false, reason: info.error };
  }
}

// Update notification: stays until dismissed; buttons = download / what's new.
// Button + click targets are read back from storage (updateInfo), because the
// service worker may have been restarted by the time the user clicks.
async function showUpdateNotification(info) {
  try {
    await chrome.notifications.create("update-available-" + info.latest, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Update available: v" + info.latest,
      message: "You have v" + info.current + ". Click Update now to install it.",
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: "Update now" }, { title: "What's new" }],
    });
  } catch (e) {}
  await playNotificationSound(false).catch(() => {});
}
// Runs on every install/reload. If the user downloaded an update, tell them
// plainly whether it is now installed, or exactly what is still missing.
async function confirmUpdateApplied() {
  const { updateDownload: d } = await chrome.storage.local.get("updateDownload");
  if (!d || !d.done || !d.version) return;
  const current = chrome.runtime.getManifest().version;
  const base = { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), priority: 2 };
  if (cmpVersion(current, d.version) >= 0) {
    await chrome.storage.local.remove("updateDownload");
    await chrome.notifications.create("update-applied", { ...base,
      title: "Updated to v" + current + " ✓", message: "The new version is installed. Your settings and accounts were kept." });
  } else {
    await chrome.notifications.create("update-pending", { ...base, requireInteraction: true,
      title: "Update not installed yet (still v" + current + ")",
      message: "Right-click personal-clickup-manager-v" + d.version + ".zip in Downloads > Extract All > pick THIS extension’s folder (chrome://extensions > Details > Source) > Replace files. Then click here to reload.",
      buttons: [{ title: "Reload extension now" }, { title: "Show the zip" }] });
  }
}

// The one-click updater page (update.html). setup=true opens the first-run
// "choose this extension's folder" step.
function openUpdater(setup) {
  chrome.tabs.create({ url: chrome.runtime.getURL("update.html" + (setup ? "?setup=1" : "")) }).catch(() => {});
}

// Download the release zip straight into the Downloads folder.
async function downloadUpdate() {
  const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
  if (!ui || !ui.latest) return { ok: false, reason: "no-update" };
  if (!ui.zip) { await chrome.tabs.create({ url: ui.url }); return { ok: true, openedPage: true }; }
  const id = await chrome.downloads.download({
    url: ui.zip,
    filename: "personal-clickup-manager-v" + ui.latest + ".zip",
    conflictAction: "overwrite",
    saveAs: false,
  });
  await chrome.storage.local.set({ updateDownload: { id, version: ui.latest, at: Date.now(), done: false } });
  return { ok: true, downloadId: id };
}
// When OUR update zip finishes: show it in the folder + a "click to reload" notification.
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta || !delta.state || delta.state.current !== "complete") return;
  (async () => {
    const { updateDownload: d } = await chrome.storage.local.get("updateDownload");
    if (!d || d.id !== delta.id) return;
    await chrome.storage.local.set({ updateDownload: { ...d, done: true } });
    try { chrome.downloads.show(delta.id); } catch (e) {}
    try {
      await chrome.notifications.create("update-downloaded", {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "v" + d.version + " downloaded",
        message: "Next: right-click the zip > Extract All > choose THIS extension’s folder > Replace the files. THEN click here to reload.",
        priority: 2,
        requireInteraction: true,
        buttons: [{ title: "Reload extension now" }],
      });
    } catch (e) {}
  })().catch(() => {});
});
chrome.notifications.onButtonClicked.addListener((id, btn) => {
  (async () => {
    if (id.startsWith("update-available-")) {
      chrome.notifications.clear(id).catch(() => {});
      if (btn === 0) openUpdater();
      else {
        const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
        if (ui && ui.url) chrome.tabs.create({ url: ui.url }).catch(() => {});
        // Keep the Download button one click away after reading the notes.
        if (ui && ui.newer) setTimeout(() => showUpdateNotification(ui).catch(() => {}), 1500);
      }
    } else if (id === "update-downloaded" || (id === "update-pending" && btn === 0)) {
      chrome.runtime.reload(); // picks up the unzipped files
    } else if (id === "update-pending" && btn === 1) {
      const { updateDownload: d } = await chrome.storage.local.get("updateDownload");
      if (d && d.id != null) { try { chrome.downloads.show(d.id); } catch (e) {} }
    }
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  checkForUpdate().catch(() => {});
  checkAndMaybeRun().catch(() => {});
  updateBadge().catch(() => {});
  refreshClickup({ viaAlarm: true }).catch(() => {});
  autoSyncIfSignedIn();
  migrateAgentRouterQuotaTimes().then(() => scheduleAgentRouterAlarms()).catch(() => {});
  pollBalancesInBackground().catch(() => {});
});
const AR_ALARM_PREFIX = "arQuota:";
// Agent Router's live schedule: two daily quota batches (Beijing/UTC+8 wall clock).
// 10:00 / 19:00 Beijing == 02:00 / 11:00 UTC == 07:45 / 16:45 Kathmandu.
// The schedule also auto-syncs from Agent Router's announcement (see
// syncArScheduleFromPage), so a future change needs no code edit.
const AR_QUOTA_DEFAULT_TIMES = ["10:00", "19:00"];
// Previous built-in defaults, kept only so users who never customized their
// times are migrated onto the live schedule (see below).
const AR_QUOTA_LEGACY_DEFAULTS = [
  ["07:00", "19:00"],
  ["00:00", "08:00", "16:00"],
];

// Migration: anyone whose stored times exactly equal an OLD built-in default is
// moved to the current default. Custom times are left untouched.
async function migrateAgentRouterQuotaTimes() {
  const { settings } = await chrome.storage.local.get("settings");
  const t = settings && settings.arQuotaTimes;
  if (!Array.isArray(t)) return;
  const isLegacy = AR_QUOTA_LEGACY_DEFAULTS.some(
    (d) => d.length === t.length && d.every((v, i) => v === t[i])
  );
  if (isLegacy) await setSettings({ arQuotaTimes: AR_QUOTA_DEFAULT_TIMES.slice() });
}

// ---- Agent Router schedule auto-sync ----
// Agent Router announces schedule changes in a notice modal, e.g.
//   "新的投放时间为🕙北京时间10:00和19:00（对应UTC时间02:00和11:00）"
//   "The new allocation times are 10:00 AM and 7:00 PM Beijing Time
//    (corresponding to 02:00 and 11:00 UTC)."
// Parse the Beijing batch times out of such text -> sorted ["10:00","19:00"],
// or null when no schedule is found.
function parseArScheduleText(text) {
  if (!text) return null;
  const src = String(text).replace(/：/g, ":");
  const pad = (h, m) => String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
  const timesIn = (s, shiftH = 0) => {
    const out = [];
    const re = /(\d{1,2}):(\d{2})\s*(AM|PM|a\.m\.|p\.m\.)?/gi;
    let m;
    while ((m = re.exec(s))) {
      let h = Number(m[1]);
      const mm = Number(m[2]);
      const ap = (m[3] || "").toLowerCase().replace(/\./g, "");
      if (h > 23 || mm > 59) continue;
      if (ap === "pm" && h < 12) h += 12;
      if (ap === "am" && h === 12) h = 0;
      h = (h + shiftH + 24) % 24;
      out.push(pad(h, mm));
    }
    return out;
  };
  const clean = (arr) => {
    const u = [...new Set(arr)].sort();
    return u.length >= 1 && u.length <= 6 ? u : null;
  };
  // Prefer the part announcing the NEW schedule when the page holds older notices.
  const newIdx = src.search(/新的投放时间|new allocation time|new release time|new schedule/i);
  const scopes = newIdx >= 0 ? [src.slice(newIdx, newIdx + 400), src] : [src];
  for (const s of scopes) {
    // Chinese: 北京时间10:00和19:00
    const zh = /北京时间\s*((?:\d{1,2}:\d{2}\s*(?:和|、|,|，|及|与|\/)?\s*)+)/.exec(s);
    if (zh) { const r = clean(timesIn(zh[1])); if (r) return r; }
    // English: "... 10:00 AM and 7:00 PM Beijing Time"
    const en = /((?:\d{1,2}:\d{2}\s*(?:AM|PM|a\.m\.|p\.m\.)?[\s,]*(?:and|&|,)?\s*)+)\s*(?:\(?\s*)Beijing/i.exec(s);
    if (en) { const r = clean(timesIn(en[1])); if (r) return r; }
    // UTC-only fallback: UTC时间02:00和11:00 / "02:00 and 11:00 UTC" -> +8h
    const zu = /UTC\s*时间\s*((?:\d{1,2}:\d{2}\s*(?:和|、|,|，|及|与|\/)?\s*)+)/i.exec(s);
    if (zu) { const r = clean(timesIn(zu[1], 8)); if (r) return r; }
    const eu = /((?:\d{1,2}:\d{2}\s*(?:AM|PM)?[\s,]*(?:and|&|,)?\s*)+)\s*UTC/i.exec(s);
    if (eu) { const r = clean(timesIn(eu[1], 8)); if (r) return r; }
  }
  return null;
}

const AR_SCHEDULE_SYNC_MIN_MS = 30 * 60 * 1000;
let arScheduleSyncInFlight = null;
// Read Agent Router's announcement (notice API + any open agentrouter.org tab),
// and if it announces a schedule we haven't applied yet, save it, reschedule the
// batch alarms and notify. An announcement is applied ONCE (tracked by
// arScheduleSeen), so a manual edit in Options isn't overwritten every poll -
// only a genuinely NEW announcement replaces the times again.
function syncArScheduleFromPage(opts = {}) {
  if (arScheduleSyncInFlight) return arScheduleSyncInFlight;
  arScheduleSyncInFlight = (async () => {
    const { arScheduleCheckedAt = 0, arScheduleSeen = "" } =
      await chrome.storage.local.get(["arScheduleCheckedAt", "arScheduleSeen"]);
    if (!opts.force && Date.now() - arScheduleCheckedAt < AR_SCHEDULE_SYNC_MIN_MS) {
      return { ok: true, skipped: "too-soon" };
    }
    await chrome.storage.local.set({ arScheduleCheckedAt: Date.now() });

    const texts = [];
    // 1) Notice API (new-api serves the announcement modal's markdown here) -
    //    works without any tab open.
    try {
      const r = await fetch("https://agentrouter.org/api/notice", { credentials: "include" });
      if (r && r.ok) {
        const j = await r.json().catch(() => null);
        const d = j && (j.data ?? j.notice ?? j.content);
        if (typeof d === "string") texts.push(d);
      }
    } catch (e) {}
    // 2) Visible page text of an open Agent Router tab (modal, banners).
    try {
      const tabs = await chrome.tabs.query({ url: "https://agentrouter.org/*" });
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (tabs[0]) {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: () => (document.body && document.body.innerText) || "",
        });
        const t = res && res[0] && res[0].result;
        if (t) texts.push(t);
      }
    } catch (e) {}

    let times = null;
    for (const t of texts) {
      times = parseArScheduleText(t);
      if (times) break;
    }
    if (!times) return { ok: true, found: false };

    const sig = times.join(",");
    if (sig === arScheduleSeen) return { ok: true, found: true, times, changed: false };
    await chrome.storage.local.set({ arScheduleSeen: sig });

    const settings = await getSettings();
    const cur = Array.isArray(settings.arQuotaTimes) ? settings.arQuotaTimes.slice().sort() : [];
    if (cur.join(",") === sig) return { ok: true, found: true, times, changed: false };

    const next = await setSettings({ arQuotaTimes: times });
    await scheduleAgentRouterAlarms(next).catch(() => {});
    await notify(
      "ar-schedule-changed",
      "Agent Router schedule updated",
      "New batch times: " + times.join(" & ") + " Beijing (auto-synced)",
      undefined,
      "https://agentrouter.org"
    );
    return { ok: true, found: true, times, changed: true };
  })()
    .catch((e) => ({ ok: false, reason: String(e) }))
    .finally(() => { arScheduleSyncInFlight = null; });
  return arScheduleSyncInFlight;
}

// Agent Router releases its Claude/GPT quota batches on a fixed Beijing-time
// (UTC+8, no DST - so this never drifts) schedule. Given a "HH:MM" Beijing wall
// clock string, return the next UTC timestamp that time occurs at, so a plain
// chrome.alarm fires at the right instant for the user regardless of their own
// timezone (Nepal, etc.) - the OS/notification layer converts it to local time
// for display automatically.
function nextBeijingTimeUTC(hhmm, fromMs = Date.now()) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || "").trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  const now = new Date(fromMs);
  let target = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hh - 8, mm, 0, 0);
  if (target <= fromMs) target += 24 * 60 * 60 * 1000;
  return target;
}

// (Re)schedule the Agent Router quota-batch alarms from current settings.
// Safe to call anytime settings change - clears old alarms first so a changed
// time or a disabled toggle takes effect immediately instead of waiting for
// today's already-scheduled (stale) alarm to fire.
async function scheduleAgentRouterAlarms(settingsArg) {
  const settings = settingsArg || (await getSettings());
  const all = await chrome.alarms.getAll();
  await Promise.all(
    all.filter((a) => a.name.startsWith(AR_ALARM_PREFIX)).map((a) => chrome.alarms.clear(a.name))
  );
  if (settings.arQuotaNotify === false) return;
  const times = (Array.isArray(settings.arQuotaTimes) && settings.arQuotaTimes.length)
    ? settings.arQuotaTimes : AR_QUOTA_DEFAULT_TIMES;
  times.forEach((t, i) => {
    const when = nextBeijingTimeUTC(t);
    if (when) chrome.alarms.create(AR_ALARM_PREFIX + i, { when, periodInMinutes: 1440 });
  });
}

async function notifyAgentRouterQuota() {
  const settings = await getSettings();
  if (settings.arQuotaNotify === false) return;
  // At the batch minute: run a fresh balance poll (detection runs inside it)
  // then emit the ONE notification if a new credit was found.
  await pollBalancesInBackground().catch(() => {});
  await maybeNotifyQuotaCredit();
}

chrome.runtime.onInstalled.addListener((details) => {
  // Brand-new install: offer one-click update setup while the folder is fresh in mind.
  if (details && details.reason === "install") openUpdater(true);
  // After a reload: confirm a downloaded update actually got installed, then
  // refresh update info (no "Update available" pop-up on a plain reload).
  confirmUpdateApplied().catch(() => {}).finally(() => checkForUpdate(true, false).catch(() => {}));
  ensurePeriodicAlarms();
  updateBadge().catch(() => {});
  autoSyncIfSignedIn();
  migrateAgentRouterQuotaTimes().then(() => scheduleAgentRouterAlarms()).catch(() => {});
});


// Create the periodic alarms ONCE and DON'T reset them on later worker wakes.
// This is the crux of the "daily auto-login never fired" bug: chrome.alarms.create
// with periodInMinutes RESETS the alarm's countdown, and calling it unconditionally
// at the top level meant every 5-minute ClickUp/balance wake recreated the 30-minute
// dailyLoginCheck (and the 15-minute Drive sync) before they could ever reach their
// period - so those two fired essentially never, while the 5-minute pair (which do
// the waking) kept updating balances. Guard with alarms.get so a matching alarm is
// left running untouched; only (re)create when it's missing or its period changed
// (a version update) - the only time a reset is actually wanted.
async function ensureAlarm(name, info) {
  try {
    const existing = await chrome.alarms.get(name);
    if (existing && existing.periodInMinutes === info.periodInMinutes) return;
    await chrome.alarms.create(name, info);
  } catch (e) {}
}
async function ensurePeriodicAlarms() {
  // daily login check - expensive (opens tabs), so only every 30 min.
  await ensureAlarm(CHECK_ALARM, { periodInMinutes: 30 });
  // ClickUp estimate refresh - cheap API-only fetch; keeps numbers near-live.
  await ensureAlarm(CLICKUP_ALARM, { periodInMinutes: 5 });
  // Drive auto-sync every 15 min - well inside the ~1h token lifetime.
  await ensureAlarm(SYNC_ALARM, { periodInMinutes: 15 });
  // Live balance poll every 5 min - cheap API-only fetch, no tabs.
  await ensureAlarm(BALANCE_ALARM, { periodInMinutes: 5 });
  // Client site uptime monitor - only fires if a site goes down.
  await ensureAlarm(SITE_MONITOR_ALARM, { periodInMinutes: SITE_MONITOR_PERIOD_MIN });
}
ensurePeriodicAlarms();
// Clear stale "running" flags + backfill login checkpoints once per worker start,
// so the popup shows the right status without waiting for the 30-min check.
clearStaleRunningOnce().catch(() => {});
// Agent Router's twice-daily Claude/GPT quota-batch reminders (converted from
// Beijing time to whatever moment that is for this user). These are absolute
// `when` alarms (not a countdown), so re-deriving them each wake is harmless.
scheduleAgentRouterAlarms().catch(() => {});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CHECK_ALARM) {
    checkForUpdate().catch(() => {}); // self-throttled to ~12h
    checkAndMaybeRun().catch(() => {});
    // No ClickUp refresh here: CLICKUP_ALARM already refreshes every 5 min, so
    // adding one on the 30-min check only guarantees an overlapping burst.
    autoSyncIfSignedIn();
  } else if (alarm.name === CLICKUP_ALARM) {
    refreshClickup({ viaAlarm: true }).catch(() => {});
  } else if (alarm.name === BALANCE_ALARM) {
    pollBalancesInBackground().catch(() => {});
  } else if (alarm.name === SYNC_ALARM) {
    autoSyncIfSignedIn();
  } else if (alarm.name === SITE_MONITOR_ALARM) {
    checkSites().catch(() => {});
  } else if (alarm.name.startsWith(AR_ALARM_PREFIX)) {
    // Awaited so the worker stays alive long enough to play the chime - unlike
    // the refresh branches above, this path has no in-flight fetch to hold it.
    await notifyAgentRouterQuota().catch(() => {});
  }
});

// Clicking any desktop notification opens the relevant task or service URL.
chrome.notifications.onClicked.addListener((id) => {
  (async () => {
    if (id === "update-downloaded" || id === "update-pending") { chrome.runtime.reload(); return; }
    if (id === "update-applied") { chrome.notifications.clear(id).catch(() => {}); return; }
    if (id.startsWith("update-available-")) {
      chrome.notifications.clear(id).catch(() => {});
      openUpdater();
      return;
    }
    let url = notifTargetUrls.get(id);
    if (!url) {
      if (id.startsWith("ar-quota-") || id.startsWith("daily-login-")) {
        const settings = await getSettings().catch(() => null);
        url = (settings && settings.targetUrl) || URLS.agentRouterLogin;
      } else if (id.startsWith("clickup-") || id.startsWith("cu-")) {
        url = "https://app.clickup.com";
      }
    }
    if (url) {
      chrome.tabs.create({ url }).catch(() => {});
    }
    chrome.notifications.clear(id).catch(() => {});
    notifTargetUrls.delete(id);
  })();
});

// ---------- messaging ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
      case "GET_STATE": {
        const settings = await getSettings();
        const accounts = (await getAccounts()).map((a) => publicAccount(a, settings));
        const status = await getStatus();
        const balances = await getBalances();
        const availability = await getAvailability();
        const signedIn = await isSignedIn();
        const clickup = await clickupPublic();
        const { driveLastSync } = await chrome.storage.local.get("driveLastSync");
        sendResponse({ accounts, status, balances, availability, settings, signedIn, clickup, running: isRunning, driveBusy, driveLastSync: driveLastSync || null, today: todayString(), resetHours: RESET_HOURS, now: Date.now() });
        break;
      }
      case "OPEN_UPDATER": {
        openUpdater(!!msg.setup);
        sendResponse({ ok: true });
        break;
      }
      case "DOWNLOAD_UPDATE": {
        try { sendResponse(await downloadUpdate()); } catch (e) { sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "RELOAD_EXTENSION": {
        sendResponse({ ok: true });
        setTimeout(() => chrome.runtime.reload(), 150);
        break;
      }
      case "CHECK_UPDATE": {
        sendResponse(await checkForUpdate(!!msg.force, !!msg.force));
        break;
      }
      case "GET_SITE_MONITOR_CONFIG": {
        const cfg = await getSiteMonitorConfig();
        sendResponse({ ok: true, cfg });
        break;
      }
      case "SET_SITE_MONITOR_CONFIG": {
        const cfg = msg.cfg || { enabled: false, sites: [] };
        await setSiteMonitorConfig(cfg);
        // Re-schedule the alarm based on new config
        if (cfg.enabled && Array.isArray(cfg.sites) && cfg.sites.length) {
          await ensureAlarm(SITE_MONITOR_ALARM, { periodInMinutes: SITE_MONITOR_PERIOD_MIN });
        } else {
          chrome.alarms.clear(SITE_MONITOR_ALARM).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "GET_SITE_MONITOR_STATE": {
        const state = (await chrome.storage.local.get("siteMonitorState"))["siteMonitorState"] || {};
        sendResponse({ ok: true, state });
        break;
      }
      case "DISCOVER_CLIENT_SITES": {
        // Client list + best-guess website per client, for the user to verify
        // and edit in Options before anything is added to the monitor.
        try { sendResponse(await discoverClientSitesBg()); }
        catch (e) { sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "SET_CLICKUP_ESTIMATE": {
        // msg: { taskId, estimateMs }. Uses background's own (single) ClickUp
        // config so neither the popup nor options page ever touches the token;
        // this is the one PUT path used for editing a task's time estimate.
        try {
          const cfg = await getClickupConfig();
          if (!cfg || !cfg.token || !msg.taskId) { sendResponse({ ok: false }); break; }
          const res = await fetch(
            "https://api.clickup.com/api/v2/task/" + encodeURIComponent(String(msg.taskId)),
            {
              method: "PUT",
              headers: { "Authorization": cfg.token, "Content-Type": "application/json" },
              body: JSON.stringify({ time_estimate: Math.round(Number(msg.estimateMs) || 0) })
            }
          );
          if (res.ok) {
            clearFilterCache();
            // Patch the edited task's rows in the stored state right away so the
            // popup's post-save load() doesn't repaint the OLD value while the
            // full recompute below is still running.
            try {
              const tid = String(msg.taskId);
              const newEst = Math.round(Number(msg.estimateMs) || 0);
              const st = await getClickupState();
              if (st) {
                const seen = new Set();
                const walk = (o) => {
                  if (!o || typeof o !== "object" || seen.has(o)) return;
                  seen.add(o);
                  if (Array.isArray(o)) { o.forEach(walk); return; }
                  const oid = o.id != null ? o.id : o.taskId;
                  if (oid != null && String(oid) === tid) {
                    // Rows whose estimateMs is a per-day SHARE (spread across a
                    // date span, the Extra task, configured tasks) keep their
                    // share until the recompute below; only full-estimate rows
                    // take the new value directly.
                    const isShare = "dayEstimateMs" in o || o.extended || o.type === "cfg" ||
                      ("totalEstimateMs" in o && Number(o.totalEstimateMs) !== Number(o.estimateMs));
                    if ("totalEstimateMs" in o) o.totalEstimateMs = newEst;
                    if (!isShare && "estimateMs" in o) o.estimateMs = newEst;
                    if ("hasEstimate" in o) o.hasEstimate = newEst > 0;
                  }
                  for (const k in o) if (o[k] && typeof o[k] === "object") walk(o[k]);
                };
                walk(st);
                await setClickupState(st);
              }
            } catch (e) {}
          }
          sendResponse({ ok: res.ok, status: res.status });
          if (res.ok) {
            // Clearing the filter cache alone isn't enough: the stored today card,
            // weekly summary and the due-this/next-week bundles (30-60 min TTLs)
            // still hold the old estimate. Recompute everything now; popup/options
            // repaint on the clickupState storage change. Wait out any refresh
            // already in flight first - it fetched BEFORE this PUT, and
            // refreshClickup would otherwise hand back that stale result.
            if (clickupRefreshInFlight) await clickupRefreshInFlight.catch(() => {});
            // Tell open popup/options pages when the recompute has landed so they
            // can drop the row's "syncing" spinner and repaint the real totals.
            const syncedId = String(msg.taskId);
            refreshClickup({ includeTasks: true, forceWeekly: true, forceWeeks: true })
              .catch(() => {})
              .finally(() => {
                chrome.runtime.sendMessage({ type: "CLICKUP_EST_SYNCED", taskId: syncedId }).catch(() => {});
              });
          }
        } catch (e) { sendResponse({ ok: false }); }
        break;
      }
      case "SAVE_ACCOUNT": {
        // msg.account: { id?, label, username, password?, totpSecret?, enabled?, mode? }
        const settings = await getSettings();
        const accounts = await getAccounts();
        const incoming = msg.account || {};
        const idx = incoming.id ? accounts.findIndex((a) => a.id === incoming.id) : -1;
        if (idx >= 0) {
          const cur = accounts[idx];
          // Keep the pin as-is unless the form sent one. Do NOT default to
          // "auto" here - that would flip a legacy (unpinned) account into
          // auto-login the first time it's edited.
          const nextMode = incoming.mode ?? cur.mode;
          accounts[idx] = {
            ...cur,
            label: incoming.label ?? cur.label,
            username: incoming.username ?? cur.username,
            mode: nextMode,
            authMethod: incoming.authMethod ? normAuthMethod(incoming.authMethod) : normAuthMethod(cur.authMethod),
            // `enabled` is now derived from mode (kept for badge/backup/merge).
            enabled: incoming.mode ? incoming.mode !== "off" : (incoming.enabled ?? cur.enabled),
            // keep existing secret if the field was left blank
            password: incoming.password ? incoming.password : cur.password,
            totpSecret:
              incoming.totpSecret !== undefined && incoming.totpSecret !== ""
                ? incoming.totpSecret.replace(/\s+/g, "")
                : cur.totpSecret,
            // Agent Router access token + user id for the tab-less 5-min balance
            // poll. Blank token keeps the current one; "-" clears it.
            arToken: incoming.arToken === "-" ? "" : (incoming.arToken ? String(incoming.arToken).trim() : cur.arToken),
            arId: incoming.arId !== undefined && String(incoming.arId).trim() !== "" ? Number(incoming.arId) : cur.arId,
            _updatedAt: Date.now(),
          };
        } else {
          const createMode = incoming.mode || settings.mode || "auto";
          accounts.push({
            id: incoming.id || crypto.randomUUID(),
            label: incoming.label || incoming.username || "Account",
            username: incoming.username || "",
            password: incoming.password || "",
            totpSecret: (incoming.totpSecret || "").replace(/\s+/g, ""),
            arToken: incoming.arToken && incoming.arToken !== "-" ? String(incoming.arToken).trim() : "",
            arId: incoming.arId !== undefined && String(incoming.arId).trim() !== "" ? Number(incoming.arId) : null,
            mode: createMode,
            authMethod: normAuthMethod(incoming.authMethod),
            enabled: createMode !== "off",
            _updatedAt: Date.now(),
          });
        }
        await setAccounts(accounts);
        await updateBadge();
        // A token/id may have just been added: poll balances now (no tabs).
        if (incoming.arToken || incoming.arId !== undefined) pollBalancesInBackground().catch(() => {});
        // Silently push to Drive so other machines see the new/updated account.
        getValidToken(false).then((tok) => {
          if (tok) pushAllToDrive(tok, accounts).catch(() => {});
        });
        sendResponse({ ok: true });
        break;
      }
      case "DELETE_ACCOUNT": {
        const accounts = (await getAccounts()).filter((a) => a.id !== msg.id);
        await setAccounts(accounts);
        await resetStatus(msg.id);
        await clearBalanceFor(msg.id);
        await clearAvailabilityFor(msg.id);
        await clearCreditsFor(msg.id);
        // Silently push updated list to Drive.
        getValidToken(false).then((tok) => {
          if (tok) pushAllToDrive(tok, accounts).catch(() => {});
        });
        sendResponse({ ok: true });
        break;
      }
      case "SET_ACCOUNT_MODE": {
        // msg = { id, mode: "auto" | "reminder" | "off" }
        const mode = msg.mode;
        if (mode !== "auto" && mode !== "reminder" && mode !== "off") {
          sendResponse({ ok: false, reason: "bad mode" });
          break;
        }
        const accounts = await getAccounts();
        const idx = accounts.findIndex((a) => a.id === msg.id);
        if (idx >= 0) {
          accounts[idx].mode = mode;
          accounts[idx].enabled = mode !== "off"; // keep legacy flag coherent
          await setAccounts(accounts);
          await updateBadge();
          getValidToken(false).then((tok) => {
            if (tok) pushAllToDrive(tok, accounts).catch(() => {});
          });
        }
        sendResponse({ ok: true });
        break;
      }
      case "FETCH_BALANCE": {
        // Refresh ONE account's live balance from an open Agent Router tab.
        // Only one AR account is logged in at a time, so we must confirm the
        // open tab is actually THIS account before attributing the balance -
        // otherwise account A's tab would mislabel account B's row.
        const acc = (await getAccounts()).find((a) => a.id === msg.id);
        if (!acc) {
          sendResponse({ ok: false, reason: "not-found" });
          break;
        }
        // Fast path: if we cached this account's id + token at its last login,
        // fetch its balance directly (no tab needed, works for any account).
        if (acc.arId != null && acc.arToken) {
          try {
            const r = await fetch("https://agentrouter.org/api/user/self", {
              method: "GET",
              credentials: "include",
              headers: {
                "New-API-User": String(acc.arId),
                Authorization: "Bearer " + acc.arToken,
              },
            });
            if (r && r.ok) {
              const j = await r.json().catch(() => null);
              const d = j && j.data ? j.data : j;
              if (d && typeof d === "object") {
                let b = d.quota ?? d.balance ?? d.credits ?? d.remaining ?? null;
                if (typeof b === "string" && b.trim() !== "") b = Number(b);
                const norm = (x) => String(x || "").trim().toLowerCase();
                const idUser = norm(d.username), idEmail = norm(d.email);
                const matched =
                  (idUser && idUser === norm(acc.detectedArUsername)) ||
                  (idEmail && idEmail === norm(acc.detectedEmail)) ||
                  (idUser && idUser === norm(acc.detectedLogin)) ||
                  (idEmail && idEmail === norm(acc.username)) ||
                  (idUser && idUser === norm(acc.username));
                if (matched && Number.isFinite(b)) {
                  syncArScheduleFromPage().catch(() => {});
                  await setBalanceFor(msg.id, b);
                  const s = await getSettings();
                  const credit = await refreshArCredit(msg.id, b, s).catch(() => null);
                  if (credit && credit.credited) await anchorCreditCheckpoint(msg.id);
                  sendResponse({ ok: true, matched: true, balance: b, at: Date.now(), via: "token" });
                  break;
                }
              }
            }
            // token stale/rotated -> fall through to the tab path below
          } catch (e) {}
        }
        // Also pick up any Agent Router schedule announcement (throttled, non-blocking).
        syncArScheduleFromPage().catch(() => {});
        let payload = null;
        try {
          const tabs = await chrome.tabs.query({ url: "https://agentrouter.org/*" });
          if (!tabs || !tabs.length) {
            sendResponse({ ok: false, matched: false, reason: "no-tab" });
            break;
          }
          tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
          const res = await chrome.scripting.executeScript({
            target: { tabId: tabs[0].id },
            func: async () => {
              // Mirror the new-api SPA's auth: session cookie + a "New-API-User"
              // header (the user id from localStorage.user) + a bearer token when
              // present. Without the header the API returns 401, which we'd
              // otherwise misread as "not logged in" and never show a balance.
              const headers = {};
              try {
                const raw = localStorage.getItem("user");
                if (raw) {
                  const u = JSON.parse(raw);
                  if (u && u.id != null) headers["New-API-User"] = String(u.id);
                  if (u && u.access_token) headers["Authorization"] = "Bearer " + u.access_token;
                }
              } catch (e) {}
              try {
                const r = await fetch("/api/user/self", { credentials: "include", headers });
                if (!r.ok) return { ok: false, status: r.status };
                const j = await r.json();
                return { ok: true, data: j && j.data ? j.data : j };
              } catch (e) {
                return { ok: false, reason: String(e) };
              }
            },
          });
          payload = res && res[0] && res[0].result;
        } catch (e) {
          sendResponse({ ok: false, matched: false, reason: "inject-failed" });
          break;
        }
        if (!payload || !payload.ok || !payload.data) {
          sendResponse({ ok: false, matched: false, reason: "not-logged-in" });
          break;
        }
        const d = payload.data;
        const balance = d.quota ?? d.balance ?? d.credits ?? d.remaining ?? null;
        const norm = (x) => String(x || "").trim().toLowerCase();
        const idEmail = norm(d.email);
        const idUser = norm(d.username);
        // Match the open tab's identity to THIS account. The AR username
        // (github_<id>) is strongest - it's what this endpoint returns - then
        // email, then the GitHub handle / entered username.
        const matched =
          (idUser && idUser === norm(acc.detectedArUsername)) ||
          (idEmail && idEmail === norm(acc.detectedEmail)) ||
          (idUser && idUser === norm(acc.detectedLogin)) ||
          (idEmail && idEmail === norm(acc.username)) ||
          (idUser && idUser === norm(acc.username));
        if (matched && balance != null) {
          await setBalanceFor(msg.id, balance);
          const s = await getSettings();
          const credit = await refreshArCredit(msg.id, balance, s).catch(() => null);
          if (credit && credit.credited) await anchorCreditCheckpoint(msg.id);
          sendResponse({ ok: true, matched: true, balance, at: Date.now() });
        } else {
          sendResponse({
            ok: false,
            matched: false,
            reason: "identity-mismatch",
            loggedInAs: d.display_name || d.username || d.email || null,
          });
        }
        break;
      }
      case "PROBE_AVAILABILITY": {
        // Active availability probe (see lib-availability.js). Shapes:
        //   { id, force?, create? } -> probe that one account and return its
        //       verdict. create=true (a user "Enable" click) is the only path
        //       allowed to mint a probe token on the account.
        //   { force? } with no id   -> kick a throttled background sweep of every
        //       eligible account (reuse-only, never creates); popup repaints on
        //       the AVAILABILITY_UPDATED nudge.
        if (!msg.id) {
          probeAvailabilityInBackground({ force: !!msg.force }).catch(() => {});
          sendResponse({ ok: true, started: true });
          break;
        }
        const acc = (await getAccounts()).find((a) => a.id === msg.id);
        if (!acc) {
          sendResponse({ ok: false, reason: "not-found" });
          break;
        }
        const entry = await probeAccountAvailability(acc, { force: !!msg.force, allowCreate: !!msg.create });
        chrome.runtime.sendMessage({ type: "AVAILABILITY_UPDATED" }).catch(() => {});
        sendResponse({ ok: true, availability: entry });
        break;
      }
      case "RUN_ALL": {
        if (isRunning) {
          sendResponse({ ok: false, reason: "already running" });
          break;
        }
        const settings = await getSettings();
        const accounts = (await getAccounts()).filter((a) => effectiveMode(a, settings) !== "off");
        if (!accounts.length) {
          sendResponse({ ok: false, reason: "no accounts" });
          break;
        }
        isRunning = true;
        cancelRequested = false;
        sendResponse({ ok: true, started: accounts.length }); // respond immediately
        runAccounts(accounts, { active: false, manual: true }) // background tabs: never steals focus
          .then((results) => maybeNotifyBatch(results))
          .catch(() => {})
          .finally(() => {
            isRunning = false;
            cancelRequested = false;
            // A fresh login refreshed the session token, so refresh availability
            // too (reuse-only + throttled - cheap, and never mints a token).
            probeAvailabilityInBackground({}).catch(() => {});
          });
        break;
      }
      case "RUN_ONE": {
        if (isRunning) {
          sendResponse({ ok: false, reason: "already running" });
          break;
        }
        const acc = (await getAccounts()).find((a) => a.id === msg.id);
        if (!acc) {
          sendResponse({ ok: false, reason: "not found" });
          break;
        }
        isRunning = true;
        cancelRequested = false;
        sendResponse({ ok: true, started: 1 });
        runAccounts([acc], { active: false, manual: true }) // background tab: never steals focus
          .then((results) => maybeNotifyBatch(results))
          .catch(() => {})
          .finally(() => {
            isRunning = false;
            cancelRequested = false;
            // A fresh login refreshed the session token, so refresh availability
            // too (reuse-only + throttled - cheap, and never mints a token).
            probeAvailabilityInBackground({}).catch(() => {});
          });
        break;
      }
      case "MARK_DONE": {
        const now = Date.now();
        await setStatusFor(msg.id, { lastDone: todayString(), lastDoneAt: now, lastRunAt: now, lastResult: "success", note: "marked manually" });
        sendResponse({ ok: true });
        break;
      }
      case "RESET_STATUS": {
        await resetStatus(msg.id || null);
        sendResponse({ ok: true });
        break;
      }
      case "SET_SETTINGS": {
        const prevSettings = await getSettings();
        const next = await setSettings(msg.patch || {});
        await scheduleAgentRouterAlarms(next).catch(() => {});
        // If the client-label level changed, re-stamp the already-cached ClickUp
        // data in place (every row keeps its `.container`, so this only relabels -
        // no network refetch) and drop the filter cache so the next filter fetch
        // relabels too. Gives the client tag/filter instant feedback on save.
        if (prevSettings.cuClientLevel !== next.cuClientLevel) {
          try {
            filterCache.clear();
            const ccfg = await getClickupConfig();
            const st = await getClickupState();
            if (ccfg && ccfg.token && st) {
              await annotateClients(ccfg.token, st, next.cuClientLevel || "auto");
              await setClickupState(st);
            }
          } catch (e) {}
        }
        sendResponse({ ok: true, settings: next });
        break;
      }
      case "CLICKUP_SAVE_TOKEN": {
        // Verify a freshly-entered personal token, then remember it + the user id
        // (needed for the assignees[] filter) + which workspace to read.
        const token = (msg.token || "").trim();
        if (!token) {
          sendResponse({ ok: false, reason: "empty" });
          break;
        }
        try {
          const { user, teams } = await verifyToken(token);
          if (!user || user.id == null) {
            sendResponse({ ok: false, reason: "no-user" });
            break;
          }
          // Keep an already-chosen workspace if it's still valid; else auto-pick
          // the first one so data loads immediately. Previously we only auto-picked
          // when there was exactly one workspace, so a token that could see several
          // left teamId null -> refreshClickup bailed "incomplete-setup" and nothing
          // showed until the user hand-picked a workspace. They can still switch via
          // the workspace dropdown (CLICKUP_SET_TEAM).
          const prev = await getClickupConfig();
          let teamId = prev && prev.teamId ? String(prev.teamId) : null;
          if (teamId && !teams.some((t) => t.id === teamId)) teamId = null;
          if (!teamId && teams.length) teamId = teams[0].id;
          let teamName = null;
          if (teamId) {
            const mt = teams.find((t) => t.id === teamId);
            if (mt) teamName = mt.name || null;
          }
          await setClickupConfig({ token, userId: user.id, username: user.username, email: user.email, teamId, teamName });
          // Reply IMMEDIATELY after saving so the sender never waits on ClickUp's
          // network (a slow refresh + a service-worker restart used to drop the
          // reply entirely - options showed "No response" even though the token
          // had saved). The caller then asks for the first refresh explicitly, so
          // Weekly Totals / the preview are guaranteed fresh on first connect.
          sendResponse({ ok: true, user, teams, teamId });
          break;
        } catch (e) {
          sendResponse({ ok: false, reason: "verify-failed", error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_SAVE_ADMIN_TOKEN": {
        // Optional SECOND token (Owner/Admin-level) used ONLY for the Filter
        // Tasks card's scoped time entries, so a department/single-user filter
        // can read others' per-day tracked time accurately. Personal prefs and
        // weekly totals keep using the personal token. Empty clears it.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const admin = (msg.token || "").trim();
        try {
          let adminUser = null;
          if (admin) {
            // Verify it can identify a ClickUp user before saving.
            const v = await verifyToken(admin);
            if (!v.user || v.user.id == null) { sendResponse({ ok: false, reason: "no-user" }); break; }
            adminUser = v.user;
          }
          await setClickupConfig({
            adminToken: admin || null,
            adminUserId: admin ? (adminUser.id ?? null) : null,
            adminUsername: admin ? (adminUser.username || "") : null,
            adminEmail: admin ? (adminUser.email || "") : null,
          });
          // The filter cache may have been computed without this scope; drop it.
          clearFilterCache();
          // Silently push the updated ClickUp config (tokens + departments) to Drive.
          getValidToken(false).then((tok) => {
            if (tok) {
              getAccounts().then((accs) => pushAllToDrive(tok, accs).catch(() => {})).catch(() => {});
            }
          });
          sendResponse({ ok: true, adminConfigured: !!admin, adminUser });
          break;
        } catch (e) {
          sendResponse({ ok: false, reason: "verify-failed", error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_SET_TEAM": {
        const teamId = msg.teamId ? String(msg.teamId) : null;
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) {
          sendResponse({ ok: false, reason: "not-configured" });
          break;
        }
        await setClickupConfig({ teamId, teamName: msg.teamName || null });
        const r = teamId ? await refreshClickup({ includeTasks: true }) : { ok: true, data: null };
        sendResponse({ ok: true, data: r.data || null, refreshError: r.ok ? null : r.error || r.reason });
        break;
      }
      case "CLICKUP_START_TIMER": {
        // Start (or switch to) a timer on a task - defaults to the auto-detected
        // "Extra(s) Task(s)" when no taskId is given. ClickUp starts it for the
        // token owner. Sets the task to "in progress", stops & reverts any other
        // active task back to "to do", and starts the timer.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        try {
          let taskId = msg.taskId ? String(msg.taskId) : null;
          if (!taskId) {
            const st = await getClickupState().catch(() => null);
            taskId = st && st.extraTask && st.extraTask.id ? String(st.extraTask.id) : null;
          }
          if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
          const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          const st = (await getClickupState().catch(() => null)) || {};
          const toRevert = new Set();
          if (st.activeTaskId && String(st.activeTaskId) !== taskId) toRevert.add(String(st.activeTaskId));
          if (cur && cur.taskId && String(cur.taskId) !== taskId) toRevert.add(String(cur.taskId));

          if (cur) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
          for (const rid of toRevert) await setTaskStatus(cfg.token, rid, "to do").catch(() => {});

          // Set this task to "in progress" and start its timer
          await setTaskStatus(cfg.token, taskId, "in progress").catch(() => {});
          await startTimer(cfg.token, cfg.teamId, taskId);

          await setClickupState({ ...st, activeTaskId: taskId });
          clearFilterCache();

          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          const running = (r.data && r.data.running) || await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          sendResponse({ ok: true, running: running || null, data: r.data || null });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_STOP_TIMER": {
        // Stop the token owner's currently-running timer (no-op if nothing runs).
        // Also reverts the task's status back to "to do" so it doesn't stay
        // stuck on "in progress" after the extra-track session ends.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        try {
          const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          const st = (await getClickupState().catch(() => null)) || {};
          const stoppedTaskId = (cur && cur.taskId) ? String(cur.taskId) : (st.activeTaskId ? String(st.activeTaskId) : (st.extraTask && st.extraTask.id ? String(st.extraTask.id) : null));
          if (cur) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
          if (stoppedTaskId) {
            await setTaskStatus(cfg.token, stoppedTaskId, "to do").catch(() => {});
            if (String(st.activeTaskId || "") === stoppedTaskId) {
              await setClickupState({ ...st, activeTaskId: null });
            }
          }
          clearFilterCache();
          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          sendResponse({ ok: true, running: null, data: r.data || null });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_SYNC_RUNNING": {
        // Cheap two-way sync of the Start/Stop button: fetch ONLY the currently
        // running timer (one GET, no today/weekly recompute) so a timer the user
        // started or stopped directly in ClickUp is reflected here. We rewrite
        // clickupState - firing the popup/options storage listeners so their
        // button flips - ONLY when the running entry actually changed, so an idle
        // poll is silent and never causes a render storm.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          const running = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          const prev = (await getClickupState()) || {};
          const keyOf = (x) => (x ? String(x.taskId || "") + ":" + String(x.startMs || "") : "");
          const changed = keyOf(prev.running) !== keyOf(running);
          if (changed) await setClickupState({ ...prev, running: running || null });
          sendResponse({ ok: true, running: running || null, changed });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_TASK_START": {
        // Per-task Start: set the task "in progress" in ClickUp AND start its
        // timer. Only ONE task may be in progress at a time, so we first revert
        // whatever was active (the last task WE set + any task with a live timer)
        // back to "to do" and stop its timer. Tasks with more than one assignee
        // are refused (a shared task shouldn't be individually started).
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
        try {
          const task = await getTaskById(cfg.token, taskId);
          if (task && task.assigneeCount > 1) {
            const names = (task.assignees || []).map((a) => a.username).filter(Boolean);
            await notify(
              "cu-multi-assignee-" + taskId,
              "Can't start this task",
              "“" + (task.name || "This task") + "” has " + task.assigneeCount +
                " people assigned" + (names.length ? " (" + names.join(", ") + ")" : "") +
                ". Only single-assignee tasks can be started.",
              "danger",
              task.url || taskUrlFor(taskId)
            );
            sendResponse({ ok: false, reason: "multi-assignee", assignees: task.assignees || [], taskName: task.name || "" });
            break;
          }
          // Revert the previously-active task(s) back to "to do" + stop the timer.
          const st = (await getClickupState().catch(() => null)) || {};
          const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          const toRevert = new Set();
          if (st.activeTaskId && String(st.activeTaskId) !== taskId) toRevert.add(String(st.activeTaskId));
          if (cur && cur.taskId && String(cur.taskId) !== taskId) toRevert.add(String(cur.taskId));
          // Confirmation gate: if ANOTHER task is currently in progress and/or its
          // timer is running, don't switch silently. Return needs-confirm with the
          // active task's name so the UI can warn ("X is in progress - switch?").
          // The caller re-sends with force:true once the user confirms. The live
          // ClickUp timer (cur) is authoritative, so this also catches a timer the
          // user started directly in ClickUp - not just ones WE set.
          if (!msg.force && toRevert.size) {
            const activeId = (cur && cur.taskId && String(cur.taskId) !== taskId)
              ? String(cur.taskId) : Array.from(toRevert)[0];
            const trackingActive = !!(cur && String(cur.taskId) === activeId);
            // Always resolve the blocking task's details so the UI can show a
            // clickable link and the precise state (in progress / tracking / both).
            const at = await getTaskById(cfg.token, activeId).catch(() => null);
            let activeName = trackingActive && cur.taskName ? cur.taskName : "";
            if (!activeName) activeName = (at && at.name) || "";
            const activeStatus = (at && (at.status || "")).toLowerCase();
            sendResponse({
              ok: false,
              reason: "needs-confirm",
              activeTaskId: activeId,
              activeTaskName: activeName,
              activeTaskUrl: (at && at.url) || taskUrlFor(activeId),
              activeInProgress: activeStatus === "in progress",
              tracking: trackingActive,
            });
            break;
          }
          if (cur) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
          for (const rid of toRevert) await setTaskStatus(cfg.token, rid, "to do").catch(() => {});
          // Set this task in progress + start its timer.
          await setTaskStatus(cfg.token, taskId, "in progress");
          await startTimer(cfg.token, cfg.teamId, taskId);
          const st2 = (await getClickupState().catch(() => null)) || {};
          await setClickupState({ ...st2, activeTaskId: taskId });
          // Bust the filter cache so the today/filter views recompute with the
          // new status instead of serving the pre-change snapshot.
          clearFilterCache();
          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          const running = (r.data && r.data.running) || await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          sendResponse({ ok: true, running: running || null, data: r.data || null });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_TASK_STOP": {
        // Per-task Stop: set the task back to "to do" and stop its timer.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
        try {
          const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          if (cur) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
          await setTaskStatus(cfg.token, taskId, "to do");
          const st = (await getClickupState().catch(() => null)) || {};
          if (String(st.activeTaskId || "") === taskId) await setClickupState({ ...st, activeTaskId: null });
          clearFilterCache();
          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          sendResponse({ ok: true, running: (r.data && r.data.running) || null, data: r.data || null });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_TASK_COMPLETE": {
        // Per-task Complete: set the task "complete" and stop its timer if it was
        // the one running (completed = no reason to keep tracking). No assignee
        // gate - anyone assigned may mark a shared task done.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
        try {
          await setTaskStatus(cfg.token, taskId, "complete");
          const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          if (cur && String(cur.taskId) === taskId) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
          const st = (await getClickupState().catch(() => null)) || {};
          if (String(st.activeTaskId || "") === taskId) await setClickupState({ ...st, activeTaskId: null });
          clearFilterCache();
          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          sendResponse({ ok: true, running: (r.data && r.data.running) || null, data: r.data || null });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_GET_TEAMS": {
        // Resolve the real workspace names with the saved token so the Workspace
        // dropdown shows e.g. "Acme Corp" instead of a "Current workspace" stub
        // after a reload. Cached for 10 minutes so every options re-open is free.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) {
          sendResponse({ ok: false, reason: "not-configured" });
          break;
        }
        try {
          if (!teamsCache.teams || Date.now() - teamsCache.at > TEAMS_CACHE_MS) {
            teamsCache = { at: Date.now(), teams: await getTeams(cfg.token) };
          }
          const cur = await getClickupConfig();
          const mt = cur && cur.teamId ? teamsCache.teams.find((t) => t.id === String(cur.teamId)) : null;
          const teamName = ((mt && mt.name) || (cur && cur.teamName) || null);
          if (teamName && (!cur.teamName || cur.teamName !== teamName)) {
            await setClickupConfig({ teamName });
          }
          sendResponse({ ok: true, teams: teamsCache.teams, teamId: (cur && cur.teamId) || null, teamName });
        } catch (e) {
          teamsCache = { at: 0, teams: null };
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_SET": {
        // Non-secret prefs: target hours, badge/notify toggles, nudge hour, and
        // the deadline-task configuration + progressive-notification toggles.
        const p = msg.patch || {};
        const patch = {};
        if (p.clickupTargetHours !== undefined) {
          const n = Number(p.clickupTargetHours);
          if (Number.isFinite(n) && n >= 0 && n <= 24) patch.clickupTargetHours = n;
        }
        if (p.clickupBadge !== undefined) patch.clickupBadge = !!p.clickupBadge;
        if (p.clickupNotify !== undefined) patch.clickupNotify = !!p.clickupNotify;
        if (p.clickupNudgeHour !== undefined) {
          const n = Number(p.clickupNudgeHour);
          if (Number.isFinite(n) && n >= 0 && n <= 23) patch.clickupNudgeHour = Math.floor(n);
        }
        if (p.clickupHalfwayNotify !== undefined) patch.clickupHalfwayNotify = !!p.clickupHalfwayNotify;
        if (p.clickupAlmostThereNotify !== undefined) patch.clickupAlmostThereNotify = !!p.clickupAlmostThereNotify;
        if (p.clickupRunningNotify !== undefined) patch.clickupRunningNotify = !!p.clickupRunningNotify;
        if (p.clickupRunningThresholdMin !== undefined) {
          const n = Number(p.clickupRunningThresholdMin);
          if (Number.isFinite(n) && n >= 1 && n <= 180) patch.clickupRunningThresholdMin = Math.floor(n);
        }
        if (p.clickupIdleNotify !== undefined) patch.clickupIdleNotify = !!p.clickupIdleNotify;
        if (p.clickupIdleStartHour !== undefined) {
          const n = Number(p.clickupIdleStartHour);
          if (Number.isFinite(n) && n >= 0 && n <= 23) patch.clickupIdleStartHour = Math.floor(n);
        }
        if (p.clickupIdleEndHour !== undefined) {
          const n = Number(p.clickupIdleEndHour);
          if (Number.isFinite(n) && n >= 0 && n <= 23) patch.clickupIdleEndHour = Math.floor(n);
        }
        if (p.clickupIdleRepeatMin !== undefined) {
          const n = Number(p.clickupIdleRepeatMin);
          if (Number.isFinite(n) && n >= 5 && n <= 480) patch.clickupIdleRepeatMin = Math.floor(n);
        }
        if (p.clickupWorkdayEndHour !== undefined) {
          const n = Number(p.clickupWorkdayEndHour);
          if (Number.isFinite(n) && n >= 0 && n <= 23) patch.clickupWorkdayEndHour = Math.floor(n);
        }
        if (p.clickupExtendedMode !== undefined) {
          patch.clickupExtendedMode = p.clickupExtendedMode === "excl0" ? "excl0" : "days";
        }
        if (p.clickupWeeklyTo !== undefined) {
          patch.clickupWeeklyTo = p.clickupWeeklyTo === "friday" ? "friday" : "today";
        }
        if (p.clickupDeadlineTaskUrls !== undefined) {
          // Normalize: trim whitespace, drop empties, keep non-empty strings.
          const arr = Array.isArray(p.clickupDeadlineTaskUrls)
            ? p.clickupDeadlineTaskUrls.map((u) => String(u).trim()).filter(Boolean)
            : [];
          patch.clickupDeadlineTaskUrls = arr;
        }
        const next = await setSettings(patch);
        // Deadline config, extended-mode, or extended-mode changes recompute the
        // estimate itself, so refetch from the API. The weeklyTo toggle is cheap:
        // it just re-renders from the cached Mon→today / Mon→Friday aggregates
        // (fetchWeeklySummary already computed both), so no network here.
        if (patch.clickupDeadlineTaskUrls !== undefined || patch.clickupExtendedMode !== undefined) {
          await refreshClickup({ includeTasks: false });
          sendResponse({ ok: true, settings: next });
          break;
        }
        // A changed target flips targetMet, so recompute against the cached estimate
        // (no network needed) and refresh the badge.
        const st = await getClickupState();
        if (st && !st.error && Number.isFinite(Number(st.estimateMs))) {
          const targetMs = (Number(next.clickupTargetHours) || 0) * 3600000;
          st.targetMs = targetMs;
          st.targetHours = Number(next.clickupTargetHours) || 0;
          st.targetMet = targetMs > 0 && st.estimateMs >= targetMs;
          await setClickupState(st);
        } else {
          await updateBadge();
        }
        sendResponse({ ok: true, settings: next });
        break;
      }
      case "CLICKUP_REFRESH": {
        clearFilterCache();
        const r = await refreshClickup({ includeTasks: !!msg.includeTasks, forceWeekly: !!msg.forceWeekly, forceWeeks: !!msg.forceWeeks });
        sendResponse(r);
        break;
      }
      case "CLICKUP_FILTER": {
        // Compute a filtered view of tasks/estimates for an arbitrary date range,
        // used by the popup's "Filter Tasks" card (Today / This Week / Custom).
        // msg = { fromTs, toTs } in ms. Because a fresh scope (esp. "All users")
        // has to discover each member's Extra Task across API pages, this NEVER
        // blocks on that work: we reply instantly ("building") and the compute
        // runs in the background; the UI polls and gets the cached result.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId || cfg.userId == null) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        const settings = await getSettings();
        const assigneeIds = Array.isArray(msg.assigneeIds)
          ? msg.assigneeIds.map((x) => String(x)).filter(Boolean)
          : [];
        const fromTs = Number(msg.fromTs) || Date.now();
        const toTs = Number(msg.toTs) || (fromTs + 86399999);
        const key = filterKey(assigneeIds, fromTs, toTs);
        const hit = filterCache.get(key);
        const forceFresh = !!msg.force;
        if (!forceFresh && hit && Date.now() - hit.at < FILTER_CACHE_MS) {
          if (hit.data) sendResponse({ ok: true, data: hit.data });
          else sendResponse({ ok: false, reason: "fetch-failed", error: hit.error || "unknown" });
          break;
        }
        if (filterBuilds.has(key)) { sendResponse({ ok: true, data: null, building: true }); break; }
        const run = (async () => {
          const stop = startKeepAlive();
          try {
            const data = await computeFilterData(cfg, settings, assigneeIds, fromTs, toTs);
            cacheFilterResult(key, data);
          } catch (e) {
            const err = String(e && e.message ? e.message : e);
            filterCache.set(key, { at: Date.now(), data: null, error: err });
          } finally {
            stop();
            filterBuilds.delete(key);
          }
        })();
        filterBuilds.set(key, run);
        sendResponse({ ok: true, data: null, building: true });
        break;
      }
      case "CLICKUP_OVERDUE": {
        // Deadline crossed = due date on a day BEFORE today AND status not complete
        // (isTaskDone: closed/done type or complete/completed/done/closed/resolved/
        // shipped/approved). Not limited to the Due selection: overdue tasks are,
        // by definition, never "due today", so they need their own query.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!msg.force && overdueCache && Date.now() - overdueCache.at < 5 * 60000) { sendResponse({ ok: true, data: overdueCache.data }); break; }
        try {
          const todayStart = new Date().setHours(0, 0, 0, 0);
          const raw = [];
          for (let page = 0; page < 6; page++) {
            const url = "https://api.clickup.com/api/v2/team/" + encodeURIComponent(cfg.teamId) + "/task?page=" + page +
              "&subtasks=true&include_closed=false&assignees[]=" + encodeURIComponent(cfg.userId) + "&due_date_lt=" + todayStart;
            const res = await fetch(url, { headers: { Authorization: cfg.token } });
            if (res.status === 429) { if (page === 0) throw new Error("ClickUp rate limit - try again in a minute"); break; }
            if (!res.ok) { if (page === 0) throw new Error("ClickUp HTTP " + res.status); break; }
            const j = await res.json().catch(() => null);
            const batch = j && Array.isArray(j.tasks) ? j.tasks : [];
            raw.push(...batch);
            if (batch.length < 100 || j.last_page === true) break;
          }
          const tasks = raw
            .filter((t) => {
              const due = Number(t.due_date) || 0;
              return due && new Date(due).setHours(0, 0, 0, 0) < todayStart && !isTaskDone(t);
            })
            .map((t) => {
              const est = Number(t.time_estimate) || 0;
              return {
                id: t.id, name: t.name || "(untitled task)", url: taskUrlFor(t.id),
                estimateMs: est, totalEstimateMs: est, spentMs: Number(t.time_spent) || 0,
                startDateMs: Number(t.start_date) || null, dueDateMs: Number(t.due_date) || null,
                status: (t.status && t.status.status) || "", priority: cuPriorityName(t),
                done: false, hasEstimate: est > 0, container: taskContainer(t),
                isSubtask: !!t.parent, parentId: t.parent || undefined,
              };
            });
          const data = { tasks, deadlineTasks: [], trackedTasks: [],
            estimateMs: tasks.reduce((n, t) => n + t.estimateMs, 0), spentMs: tasks.reduce((n, t) => n + t.spentMs, 0) };
          const settings = await getSettings();
          await annotateClients(cfg.token, data, settings.cuClientLevel || "auto");
          overdueCache = { at: Date.now(), data };
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_DEPT_DATA": {
        // Supplies the Department Creator + Filter cards with BOTH the workspace
        // member directory (for autocomplete) and the saved departments. Members
        // are cached in state for ~1h; pass force to refresh the roster now.
        // IMPORTANT: reply immediately from cache - the roster build runs in the
        // background (see buildRoster) so the service worker can never be killed
        // while an expensive scan is awaiting, which would drop this response.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        const settings = await getSettings();
        const st = await getClickupState();
        let members = (st && Array.isArray(st.members)) ? st.members : null;
        const membersAt = (st && st.membersAt) || 0;
        const note = (st && st.membersNote) || null;
        const stale = members && members.length
          ? Date.now() - membersAt > MEMBERS_TTL
          : Date.now() - membersAt > EMPTY_MEMBERS_TTL;
        if ((msg.force || !members || stale) && !rosterBuildPromise) {
          rosterBuildPromise = buildRoster(cfg);
        }
        sendResponse({
          ok: true,
          members: members || [],
          note: note || undefined,
          building: !!rosterBuildPromise,
          departments: Array.isArray(settings.clickupDepartments) ? settings.clickupDepartments : [],
          userId: cfg.userId != null ? String(cfg.userId) : null,
        });
        break;
      }
      case "CLICKUP_DEPARTMENTS_SAVE": {
        // Persist the Department Creator config. Validation is light: each entry
        // needs a non-empty name and its users are reduced to {id, name} pairs.
        const depts = Array.isArray(msg.departments) ? msg.departments : [];
        const clean = depts
          .map((d, i) => ({
            id: String(d && d.id ? d.id : "dept_" + i + "_" + Date.now()),
            name: String((d && d.name) || "").trim() || "Department " + (i + 1),
            users: Array.isArray(d && d.users)
              ? d.users
                  .map((u) => ({ id: String((u && u.id) || ""), name: String((u && u.name) || "").trim() }))
                  .filter((u) => u.id)
              : [],
          }))
          .filter((d) => d.users.length > 0);
        const next = await setSettings({ clickupDepartments: clean });
        // Silently push the updated ClickUp settings to Drive (tokens + depts).
        getValidToken(false).then((tok) => {
          if (tok) {
            getAccounts().then((accs) => pushAllToDrive(tok, accs).catch(() => {})).catch(() => {});
          }
        });
        sendResponse({ ok: true, departments: next.clickupDepartments });
        break;
      }
      case "CLICKUP_CLEAR": {
        await clearClickupConfig();
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case "EXPORT_ACCOUNTS": {
        // Bundle the FULL account records (incl. password + TOTP secret) and
        // encrypt them with the user's passphrase, so the file is safe to move
        // to another browser/machine. The passphrase is never stored.
        const passphrase = msg.passphrase || "";
        const accounts = await getAccounts();
        if (!accounts.length) {
          sendResponse({ ok: false, reason: "no accounts" });
          break;
        }
        const settings = await getSettings();
        // Include the ClickUp secret config (personal token, workspace, admin
        // token) so a restore brings back the full ClickUp setup, not just
        // accounts + prefs. null when no token is saved.
        const clickup = await getClickupConfig().catch(() => null);
        const backup = await encryptWithPassphrase(
          { accounts, settings, clickup: clickup && clickup.token ? clickup : null },
          passphrase
        );
        sendResponse({ ok: true, backup, count: accounts.length });
        break;
      }
      case "IMPORT_ACCOUNTS": {
        // Decrypt a passphrase-protected backup and merge (default) or replace
        // the local accounts. A wrong passphrase throws a clear error below.
        const passphrase = msg.passphrase || "";
        const data = await decryptWithPassphrase(msg.backup, passphrase);
        const incoming = Array.isArray(data && data.accounts) ? data.accounts : [];
        if (!incoming.length) {
          sendResponse({ ok: false, reason: "This backup has no accounts in it." });
          break;
        }
        const replace = msg.mode === "replace";
        let accounts = replace ? [] : await getAccounts();
        let added = 0;
        let updated = 0;
        for (const inc of incoming) {
          const clean = {
            id: inc.id || crypto.randomUUID(),
            label: inc.label || inc.username || "Account",
            username: inc.username || "",
            password: inc.password || "",
            totpSecret: (inc.totpSecret || "").replace(/\s+/g, ""),
            authMethod: normAuthMethod(inc.authMethod),
            enabled: inc.enabled !== false,
            detectedLogin: inc.detectedLogin || "",
            detectedEmail: inc.detectedEmail || "",
          };
          // Preserve an explicit per-account mode from the backup, if present.
          // (undefined is fine - effectiveMode falls back to settings.mode.)
          if (inc.mode === "auto" || inc.mode === "reminder" || inc.mode === "off") {
            clean.mode = inc.mode;
          }
          const idx = accounts.findIndex(
            (a) => a.id === clean.id || (clean.username && a.username === clean.username)
          );
          if (idx >= 0) {
            accounts[idx] = { ...accounts[idx], ...clean, id: accounts[idx].id };
            updated++;
          } else {
            accounts.push(clean);
            added++;
          }
        }
        await setAccounts(accounts);
        // Restore settings (target hours, deadline URLs, notification prefs,
        // Agent Router URL, all ClickUp prefs + departments) if the backup
        // carries them. This is an explicit user-initiated restore, so we apply
        // the backup's prefs directly (setSettings re-stamps _updatedAt so the
        // restored values then propagate on the next Drive sync).
        let settingsRestored = false;
        if (data && data.settings && typeof data.settings === "object") {
          const { _updatedAt, ...prefs } = data.settings;
          await setSettings(prefs);
          settingsRestored = true;
        }
        // Restore the ClickUp secret config (token / workspace / admin token) if
        // present in the backup.
        let clickupRestored = false;
        if (data && data.clickup && typeof data.clickup === "object" && data.clickup.token) {
          await setClickupConfig(data.clickup);
          clickupRestored = true;
        }
        await updateBadge();
        sendResponse({
          ok: true,
          added,
          updated,
          total: accounts.length,
          settingsRestored,
          clickupRestored,
        });
        break;
      }
      case "GOOGLE_SIGN_IN": {
        // Always use interactive prompt for explicit sign-in.
        setDriveBusy("signin");
        let token, syncedAt = null;
        try {
          token = await getValidToken(true);
          if (token) {
            // Full restore: pull+merge accounts, adopt ClickUp/departments/settings,
            // push ours back, sync status, AND refresh live ClickUp numbers - all in
            // one shared routine (also used by the manual Sync button and the alarm)
            // so signing in shows everything immediately, with no separate "now click
            // Sync" step needed.
            const r = await syncNow();
            syncedAt = r.syncedAt || null;
          }
          sendResponse({ ok: !!token, syncedAt });
        } finally {
          setDriveBusy("");
        }
        break;
      }
      case "GOOGLE_SIGN_OUT": {
        // Sign-out is destructive LOCALLY on purpose: we wipe this identity's
        // synced accounts so a DIFFERENT Google account can sign in and show ITS
        // accounts instead of a merge of both (mergeAccounts is last-writer-wins,
        // so without this the old identity's accounts would linger and reappear).
        // Best-effort checkpoint to Drive first so nothing unsynced is lost and
        // re-signing into this same account restores everything.
        try { await syncNow(); } catch (e) {}
        await driveSignOut();
        // Clear this identity's local footprint: the encrypted accounts, the
        // plaintext count, and everything derived from them (login status, live
        // balances, credit-detection baselines, availability chips). The ClickUp
        // connection is a separate credential with its own Sign out, so it's
        // deliberately left untouched.
        await chrome.storage.local.remove([
          "accountsEnc",
          "acctCount",
          "status",
          "balances",
          "arCredits",
          "availability",
        ]);
        statusHydrated = false; // re-hydrate from the next identity's Drive on sign-in
        await updateBadge().catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "SYNC_NOW": {
        setDriveBusy("sync");
        try {
          const r = await syncNow();
          sendResponse({ ok: r.ok, statusOk: r.ok, accountsPushed: r.ok, reason: r.reason, syncedAt: r.syncedAt || null });
        } finally {
          setDriveBusy("");
        }
        break;
      }
      case "PUSH_ACCOUNTS": {
        // Explicit push of current accounts to Drive (best-effort).
        const tok = await getValidToken(false);
        if (!tok) {
          sendResponse({ ok: false, reason: "not signed in" });
          break;
        }
        try {
          const accounts = await getAccounts();
          await pushAllToDrive(tok, accounts);
          sendResponse({ ok: true, count: accounts.length });
        } catch (e) {
          sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "PREVIEW_TOTP": {
        // Compute the CURRENT authenticator code so the user can compare it
        // against their phone and confirm the stored secret matches GitHub.
        // Returns ONLY the 6-digit code + seconds left - never the secret, so
        // this keeps the "secrets never leave the background" rule intact.
        // Source: a freshly-typed secret (msg.secret) if given, else the saved
        // account's secret (msg.id).
        let secret = "";
        if (typeof msg.secret === "string" && msg.secret.trim() !== "") {
          secret = msg.secret;
        } else if (msg.id) {
          const acc = (await getAccounts()).find((a) => a.id === msg.id);
          secret = acc && acc.totpSecret ? acc.totpSecret : "";
        }
        if (!secret) {
          sendResponse({ ok: false, reason: "no-secret" });
          break;
        }
        try {
          const code = await generateTOTP(secret);
          sendResponse({ ok: true, code, secondsRemaining: totpSecondsRemaining() });
        } catch (e) {
          sendResponse({ ok: false, reason: "invalid" });
        }
        break;
      }
      case "DEBUG_GITHUB_LOGIN": {
        // Manual "Test login" from the Debug section: run the full automation
        // flow for ONE account and stream step-by-step status back to the UI.
        const acc = (await getAccounts()).find((a) => a.id === msg.id);
        if (!acc) {
          sendResponse({ ok: false, reason: "not-found" });
          break;
        }
        if (isRunning) {
          sendResponse({ ok: false, reason: "already running" });
          break;
        }
        isRunning = true;
        cancelRequested = false;
        sendResponse({ ok: true, started: true }); // respond immediately, stream below
        const settings = await getSettings();
        runAccountLogin(acc, {
          targetUrl: settings.targetUrl,
          active: true,
          keepTabs: true,
          timeoutScale: settings.slowNetwork ? 2 : 1,
          isCancelled: isCancelledFn,
        })
          .then((outcome) => {
            chrome.runtime.sendMessage({
              type: "DEBUG_PROGRESS",
              ok: outcome.result === "success",
              result: outcome.result,
              note: outcome.note,
              detected: outcome.detected || {},
              done: true,
            }).catch(() => {});
          })
          .catch((e) => {
            chrome.runtime.sendMessage({
              type: "DEBUG_PROGRESS",
              ok: false,
              result: "failed",
              note: String(e && e.message ? e.message : e),
              done: true,
            }).catch(() => {});
          })
          .finally(() => {
            isRunning = false;
            cancelRequested = false;
            // A fresh login refreshed the session token, so refresh availability
            // too (reuse-only + throttled - cheap, and never mints a token).
            probeAvailabilityInBackground({}).catch(() => {});
          });
        break;
      }
      case "RUN_CANCEL": {
        // Force-stop a running login (Debug → Stop). Sets a flag the running
        // login loop checks each iteration; it bails out as "Stopped by user."
        cancelRequested = true;
        sendResponse({ ok: true });
        break;
      }
      case "DEBUG_GITHUB_LOGOUT": {
        // Manual "Test logout": clear GitHub + Agent Router session state but
        // KEEP github.com's device-trust cookie, mirroring the flow used between
        // accounts. Returns a summary of what was cleared.
        const domains = ["github.com", "agentrouter.org"];
        const kept = { "github.com": GITHUB_KEEP_COOKIES || ["_device_id"] };
        const summary = {};
        for (const domain of domains) {
          const keepSet = new Set(kept[domain] || []);
          let keptCount = 0;
          let clearedCount = 0;
          let cookies = [];
          try {
            cookies = await chrome.cookies.getAll({ domain });
          } catch (e) {}
          for (const c of cookies) {
            if (keepSet.has(c.name)) { keptCount++; continue; }
            const prefix = c.secure ? "https://" : "http://";
            const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
            const url = `${prefix}${host}${c.path}`;
            try {
              await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId });
              clearedCount++;
            } catch (e) {}
          }
          summary[domain] = { cleared: clearedCount, kept: keptCount };
        }
        sendResponse({ ok: true, summary });
        break;
      }
      case "PLAY_TEST_SOUND": {
        // Options "Test sound" / "Test danger sound" buttons - preview the clip
        // even if the toggle is off. msg.sound picks which one ("danger" or chime).
        await playNotificationSound(true, msg.sound);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, reason: "unknown message" });
    }
    } catch (e) {
      // Always answer, even on error, so the options/popup page never hangs
      // on "Loading…" waiting for a reply that isn't coming.
      try {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      } catch (_) {}
    }
  })();
  return true; // async
});

// keep the badge fresh if status changes from elsewhere - or when the ClickUp
// filter is toggled in the popup/options (the badge follows the active scope).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.status || changes.accountsEnc || changes.cuFilter)) updateBadge().catch(() => {});
});
