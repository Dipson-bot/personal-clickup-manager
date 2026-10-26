// background.js  (ES module service worker)
// -----------------------------------------------------------------------------
// Wiring: encrypted account storage, per-account status, the once-per-day
// trigger, the toolbar badge, and all messages from popup.js / options.js.
// -----------------------------------------------------------------------------

import { encryptJSON, decryptJSON, encryptWithPassphrase, decryptWithPassphrase, generateTOTP, totpSecondsRemaining } from "./lib-crypto.js";
import {
  getFileToken,
  getExportToken,
  driveFolder,
  uploadDriveFile,
  createGoogleFile,
  shareAnyoneWithLink,
  getValidToken,
  signOut as driveSignOut,
  isSignedIn,
  mirrorToDrive,
  pullFromDrive,
  pushAccountsToDrive,
  pullAccountsFromDrive,
  listDriveFiles,
  getDriveAccount,
  pushTaskFiles,
  pullTaskFiles,
  driveQuota,
  linkifySheet,
} from "./lib-drive.js";
import { runAllAccounts, runAccountLogin, readAgentRouterLogin, URLS, GITHUB_KEEP_COOKIES } from "./lib-automation.js";
import { getTaskHoldInfo, fetchArchivedMine, unarchiveTask, getLatestCommentBy, getTaskCommentsLite, getTaskTimeEntries, deleteTimeEntry, getUserGroups, getUser, verifyToken, getTeams, fetchTodayEstimate, fetchWeeklySummary, fetchDateRangeEstimate, createTaskCache, fetchTeamMembers, fetchWorkspaceTags, cuTagNames, fmtDuration, findExtraTaskByName, parseTaskIdFromUrl, getCurrentTimeEntry, getRunningTaskProgress, startTimer, stopTimer, getTaskById, setTaskStatus, setTaskDates, taskUrlFor, clientLabelFromContainer, resolveSpaceNamesFor, taskContainer, cuPriorityName, isTaskDone, getSubtasksOfParent, getTaskTree, getTaskDetail, updateTimeEntry, setTaskDueDate, clearTaskTreeCache, listWorkspaceClients, cuRowAssignees, fetchDoneBetween, fetchDoneLite, fetchTrackedHistory, getTaskPanel, addTaskComment, postTaskComment, setTaskDescription, getTaskCommentLinks, createTask, relateTasks, removeTaskAssignee, addTaskAssignee, postAssignedComment, addTimeEntry, weeklyWithToday, listClientFieldOptions, listReachableClients, bgToken, patientToken, cuRawFetch, getRelatedTasks, slimIndexTask, fetchTeamTasksPage, listAllLists, setPausedClients } from "./lib-clickup.js";
import { resolveRelayKey, pickProbeModel, probeRelay } from "./lib-availability.js";
import { tidyCollect, tidyLines, tidyResolved, tidyDayOk, tidyUrgent, tidyDateShort } from "./lib-tidy.js";
import "./lib-rules.js"; // globalThis.PcmRules - the Automation tab's rule blocks
import "./lib-dailyupdate.js"; // globalThis.PcmDailyUpdate - the Daily Tasks Update text (wrap-up page + scheduled send)

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
// Timeouts / retries follow the big uptime services: UptimeRobot and Pingdom wait
// 30s before calling a request timed out, and UptimeRobot re-tries a connection
// failure up to 3 times, 20s apart, before a check counts as failed. A cold,
// uncached WordPress page (managed WordPress host behind Cloudflare) can take several
// seconds to wake - a 5s limit flagged live sites as down.
const SITE_MONITOR_CHECK_TIMEOUT_MS = 30000;
const SITE_MONITOR_PERIOD_MIN = 5; // check interval
const SITE_MONITOR_RETRIES = 2; // extra tries after the first (3 in total)
const SITE_MONITOR_RETRY_GAP_MS = 20000;
const SITE_MONITOR_PARALLEL = 6; // sites checked at the same time
const SITE_MONITOR_PROBE_TIMEOUT_MS = 8000; // "is this PC online" probes
// A failure only counts as CONSECUTIVE when the previous check was recent;
// a fail from just before the PC slept + the first check after waking is not
// an outage. Anything older than this resets the count.
const SITE_MONITOR_STALE_MS = 15 * 60000;
// The same alert for the same site inside this window is a duplicate, not news
// (two runs that overlapped, or an alarm Chrome replayed on waking).
const SITE_NOTE_REPEAT_MS = 10 * 60000;
// Known-good addresses used to tell "the site is down" from "this PC is
// offline" (Chrome up before Wi-Fi / VPN, DNS hiccup). Only probed when a
// site check failed, so a quiet run costs nothing extra.
const SITE_MONITOR_PROBES = ["https://www.gstatic.com/generate_204", "https://www.cloudflare.com/cdn-cgi/trace"];

async function getSiteMonitorConfig() {
  const { siteMonitorConfig } = await chrome.storage.local.get("siteMonitorConfig");
  return siteMonitorConfig && typeof siteMonitorConfig === "object" ? siteMonitorConfig : { sites: [], enabled: false };
}

async function setSiteMonitorConfig(cfg) {
  await chrome.storage.local.set({ siteMonitorConfig: cfg });
}

// ---------- Team client sites (Admin > "Client sites for everyone") ----------
// The Admin publishes the agency's client websites to client-sites.json in the
// repository. The repository is public, so the list is encrypted with the ClickUp
// workspace ID: only copies connected to that workspace can read it. Each copy
// adds every listed site ONCE (siteDirSeen remembers them, also kept in Drive),
// so a site the user deletes never comes back. The first list also switches
// monitoring on once (unticking it later sticks). update-policy.json carries sitesAt, so copies
// download the file only when it has changed.
const TEAM_SITES_PATH = "client-sites.json";
const teamSitesPass = (teamId) => "pcm-team-sites:" + String(teamId);
function siteHostKey(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return ""; }
}
function cleanTeamSites(list) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    let url = String((s && s.url) || "").trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;
    let u;
    try { u = new URL(url); } catch (e) { continue; }
    if (!/\.[a-z]{2,}$/i.test(u.hostname)) continue;
    const k = siteHostKey(u.origin);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name: String((s && s.name) || "").trim().slice(0, 120), url: u.origin });
  }
  return out.slice(0, 300);
}
// jsDelivr first (no request limits); GitHub's own copy when jsDelivr is older
// than the change the settings file announced.
async function readTeamSitesFile(wantAt) {
  let best = null;
  for (const base of ["https://cdn.jsdelivr.net/gh/" + UPDATE_REPO + "@main/", "https://raw.githubusercontent.com/" + UPDATE_REPO + "/main/"]) {
    try {
      const r = await fetch(base + TEAM_SITES_PATH + "?t=" + Date.now(), { cache: "no-store" });
      const j = r.ok ? await r.json() : null;
      if (j && (!best || (Number(j.updatedAt) || 0) > (Number(best.updatedAt) || 0))) best = j;
    } catch (e) {}
    if (best && (Number(best.updatedAt) || 0) >= wantAt) break;
  }
  return best;
}
async function decryptTeamSites(file, teamId) {
  const p = await decryptTeamPayload(file, teamId);
  return p ? p.sites : null;
}
// The whole published list: the sites, how copies take them ("add": only sites
// they don't have; "match": also update changed addresses and drop the team
// sites the admin removed) and who it is for (ClickUp user ids; empty = everyone).
async function decryptTeamPayload(file, teamId) {
  if (!file || !file.enc || !teamId) return null;
  try {
    const o = await decryptWithPassphrase(file.enc, teamSitesPass(teamId));
    return { sites: cleanTeamSites(o && o.sites), mode: o && o.mode === "match" ? "match" : "add", to: Array.isArray(o && o.to) ? o.to.map(String).filter((x) => /^\d{1,15}$/.test(x)) : [] };
  } catch (e) {
    return null; // another workspace (or a damaged file)
  }
}
// "Make their list match mine": every team site's address is updated (matched by
// name, else by host), team sites no longer on the list are dropped, and sites
// this person added themselves are left alone.
async function matchTeamSites(sites) {
  const got = await chrome.storage.local.get("siteDirSeen");
  const seen = new Set(Array.isArray(got.siteDirSeen) ? got.siteDirSeen : []);
  const cfg = await getSiteMonitorConfig();
  const list = Array.isArray(cfg.sites) ? cfg.sites.slice() : [];
  const nameKey = (s) => String((s && s.name) || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const want = new Set(sites.map((s) => siteHostKey(s.url)));
  const used = new Set();
  let changed = 0;
  for (const s of sites) {
    const hk = siteHostKey(s.url), nk = nameKey(s);
    let i = list.findIndex((x, j) => !used.has(j) && siteHostKey(x && x.url) === hk);
    if (i < 0 && nk) i = list.findIndex((x, j) => !used.has(j) && nameKey(x) === nk);
    if (i >= 0) {
      if (list[i].url !== s.url || (s.name && list[i].name !== s.name)) { list[i] = { ...list[i], url: s.url, name: s.name || list[i].name }; changed++; }
      used.add(i);
    } else { list.push({ url: s.url, name: s.name }); used.add(list.length - 1); changed++; }
    seen.add(hk);
  }
  // Team sites (handed out before) that the admin took off: gone here too.
  const kept = list.filter((x, j) => used.has(j) || !seen.has(siteHostKey(x && x.url)) || want.has(siteHostKey(x && x.url)));
  changed += list.length - kept.length;
  if (changed) await setSiteMonitorConfig({ ...cfg, sites: kept });
  await chrome.storage.local.set({ siteDirSeen: [...seen] });
  return changed;
}
// Add the team's sites this copy hasn't added before.
async function applyTeamSites(sites) {
  const got = await chrome.storage.local.get("siteDirSeen");
  const seen = new Set(Array.isArray(got.siteDirSeen) ? got.siteDirSeen : []);
  const cfg = await getSiteMonitorConfig();
  const list = Array.isArray(cfg.sites) ? cfg.sites.slice() : [];
  const have = new Set(list.map((s) => siteHostKey(s && s.url)));
  let added = 0;
  for (const s of sites) {
    const k = siteHostKey(s.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    if (!have.has(k)) { list.push({ url: s.url, name: s.name }); have.add(k); added++; }
  }
  // The first time the team list arrives, monitoring is switched on too (as the
  // Admin card promises) - ONCE: whoever unticks "Enable site monitoring"
  // afterwards keeps it off (siteMonTeamEnabled remembers it was done).
  const { siteMonTeamEnabled } = await chrome.storage.local.get("siteMonTeamEnabled");
  const enableNow = !siteMonTeamEnabled && list.length > 0;
  if (added || enableNow) await setSiteMonitorConfig({ ...cfg, sites: list, enabled: enableNow ? true : cfg.enabled });
  await chrome.storage.local.set({ siteDirSeen: [...seen], ...(enableNow ? { siteMonTeamEnabled: Date.now() } : {}) });
  return added;
}
// Run from the once-a-minute update check. Cheap when nothing changed: one
// storage read.
async function maybeApplyTeamSites(policy) {
  const want = Number(policy && policy.sitesAt) || 0;
  if (!want) return;
  const cfg = await getClickupConfig().catch(() => null);
  const teamId = cfg && cfg.teamId;
  if (!teamId) return; // not connected to ClickUp yet: tried again once it is
  const { teamSites } = await chrome.storage.local.get("teamSites");
  const key = want + ":" + teamId;
  if (teamSites && teamSites.key === key) {
    if (teamSites.status !== "fetch-failed" || Date.now() - (teamSites.triedAt || 0) < 5 * 60000) return;
  }
  // A fresh install signed in to Drive takes its own saved sites (and the ones it
  // deleted) from Drive first, so deleted sites don't come back.
  const { driveLastSync } = await chrome.storage.local.get("driveLastSync");
  if (!driveLastSync && (await isSignedIn().catch(() => false))) return;
  const file = await readTeamSitesFile(want);
  if (!file) { await chrome.storage.local.set({ teamSites: { key, status: "fetch-failed", triedAt: Date.now() } }); return; }
  const pay = await decryptTeamPayload(file, teamId);
  if (!pay) { await chrome.storage.local.set({ teamSites: { key, status: "other-workspace", triedAt: Date.now() } }); return; }
  const sites = pay.sites;
  // Sent to chosen people only, and this isn't one of them.
  if (pay.to.length && !pay.to.includes(String(cfg.userId || ""))) { await chrome.storage.local.set({ teamSites: { key, status: "not-for-me", triedAt: Date.now() } }); return; }
  const added = pay.mode === "match" ? await matchTeamSites(sites) : await applyTeamSites(sites);
  await chrome.storage.local.set({ teamSites: { key, status: "ok", triedAt: Date.now(), at: Number(file.updatedAt) || want, list: sites, added } });
}

// ---------- Task files backup (Options > Task files) ----------
// The files live in IndexedDB "pcm-taskfiles" (lib-taskfiles.js). Their text
// (not screenshots) is mirrored to Drive's hidden app data; a computer with no
// files yet takes the backup. Runs a few seconds after files change, and on the
// regular Drive sync.
function tfDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pcm-taskfiles", 1);
    r.onupgradeneeded = () => { const s = r.result.createObjectStore("files", { keyPath: "id" }); s.createIndex("ck", "ck"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tfAll() {
  const d = await tfDb();
  return new Promise((res, rej) => { const q = d.transaction("files").objectStore("files").getAll(); q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error); });
}
async function tfPutMany(recs) {
  const d = await tfDb();
  await new Promise((res, rej) => { const tx = d.transaction("files", "readwrite"); const s = tx.objectStore("files"); for (const r of recs) s.put(r); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
// ---- ClickUp task index (Explore › Find these tasks) ----
// Every task the user can see, one slim row each (slimIndexTask), so a pasted
// list of task names can be found without ClickUp text search (it has none).
// Built once through the slow lane (100 tasks a request, resumable: the page
// reached is saved), then kept fresh with "changed since" reads. Built only when
// someone uses Find - never on a timer. Meta in storage cuTaskIndex.
const TIX_DB = "pcm-taskindex";
function tixDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(TIX_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("tasks")) r.result.createObjectStore("tasks", { keyPath: "id" }); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tixPut(rows) {
  if (!rows.length) return;
  const d = await tixDb();
  await new Promise((res, rej) => { const tx = d.transaction("tasks", "readwrite"); const st = tx.objectStore("tasks"); for (const r of rows) st.put(r); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function tixClear() {
  const d = await tixDb();
  await new Promise((res, rej) => { const tx = d.transaction("tasks", "readwrite"); tx.objectStore("tasks").clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
// A task by its code ("ACT-025", "AP-14.S2"): the index row whose name starts with
// it. Kept per code for the session. "" when there's no index or no such task.
const tixCodeMemo = new Map();
async function tixFindByCode(code) {
  code = String(code || "").toUpperCase();
  if (!code) return "";
  if (tixCodeMemo.has(code)) return tixCodeMemo.get(code);
  const { cuTaskIndex: m } = await chrome.storage.local.get("cuTaskIndex");
  if (!m || m.state !== "ready") return "";
  const d = await tixDb();
  const re = new RegExp("^\\s*" + code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w.])", "i");
  const id = await new Promise((res) => {
    const q = d.transaction("tasks").objectStore("tasks").openCursor();
    q.onsuccess = () => { const c = q.result; if (!c) return res(""); const v = c.value; if (v && re.test(String(v.name || v.n || ""))) return res(String(v.id)); c.continue(); };
    q.onerror = () => res("");
  });
  tixCodeMemo.set(code, id);
  return id;
}
async function tixCount() {
  const d = await tixDb();
  return new Promise((res) => { const q = d.transaction("tasks").objectStore("tasks").count(); q.onsuccess = () => res(q.result || 0); q.onerror = () => res(0); });
}
function tixNeedsBuild(m, cfg, settings) {
  return !m || m.v !== 1 || m.teamId !== String(cfg.teamId) || m.level !== ((settings && settings.cuClientLevel) || "auto") || m.state !== "ready";
}
let tixRun = null;
function syncTaskIndex(opts = {}) {
  if (tixRun) return tixRun;
  tixRun = (async () => {
    const cfg = await getClickupConfig();
    if (!cfg || !cfg.token || !cfg.teamId) return { ok: false, reason: "not-configured" };
    const settings = await getSettings();
    const level = settings.cuClientLevel || "auto";
    const tok = bgToken(cfg.token);
    const save = (x) => chrome.storage.local.set({ cuTaskIndex: x }).catch(() => {});
    let { cuTaskIndex: m } = await chrome.storage.local.get("cuTaskIndex");
    if (opts.rebuild || !m || m.v !== 1 || m.teamId !== String(cfg.teamId) || m.level !== level) {
      await tixClear();
      m = { v: 1, teamId: String(cfg.teamId), level, state: "building", page: 0, read: 0, count: 0, lastSync: 0, startedAt: Date.now() };
      await save(m);
    }
    // Whose index it is: Ctrl+K search keeps the tasks assigned to you from it.
    const me = cfg.userId != null ? String(cfg.userId) : "";
    if (m.me !== me) { m = { ...m, me }; await save(m); }
    try {
      if (m.state === "building") {
        // Carries on from the page reached (a restarted service worker resumes).
        for (;;) {
          const r = await fetchTeamTasksPage(tok, cfg.teamId, m.page, 0);
          await tixPut(r.tasks.map((x) => slimIndexTask(x, level)));
          m = { ...m, page: m.page + 1, read: m.read + r.tasks.length, error: "" };
          await save(m);
          if (r.last || m.page >= 3000) break;
        }
        // What changed while it was reading is picked up just below.
        m = { ...m, state: "ready", lastSync: (m.startedAt || Date.now()) - 120000, count: await tixCount() };
        await save(m);
      }
      const maxAge = opts.maxAgeMs != null ? opts.maxAgeMs : 5 * 60000;
      if (Date.now() - (m.lastSync || 0) > maxAge) {
        const start = Date.now();
        for (let page = 0; page < 100; page++) {
          const r = await fetchTeamTasksPage(tok, cfg.teamId, page, (m.lastSync || 0) - 60000);
          await tixPut(r.tasks.map((x) => slimIndexTask(x, level)));
          if (r.last) break;
        }
        m = { ...m, lastSync: start, count: await tixCount(), error: "" };
        await save(m);
      }
      return { ok: true, meta: m };
    } catch (e) {
      const rateLimited = !!(e && e.status === 429);
      m = { ...m, error: rateLimited ? "rate-limited" : String((e && e.message) || e) };
      await save(m);
      return { ok: false, reason: rateLimited ? "rate-limited" : "error", error: m.error, meta: m };
    } finally { tixRun = null; }
  })();
  return tixRun;
}
// The Drive "signed in" dot for GET_STATE. Checking it may need a silent Google
// re-sign-in (the token lasts an hour), which can take a while - the pages gave
// up after 8 s with "No response from the extension", on every reload. Answer
// with what's known within 1.5 s; the check carries on and the next poll has it.
let lastSignedIn = null;
async function signedInQuick() {
  if (lastSignedIn === null) { try { lastSignedIn = !!(await getDriveAccount()); } catch (e) { lastSignedIn = false; } }
  const p = isSignedIn().then((v) => { lastSignedIn = !!v; return lastSignedIn; }).catch(() => lastSignedIn);
  return Promise.race([p, new Promise((r) => setTimeout(() => r(lastSignedIn), 1500))]);
}
let tfSyncing = null;
function syncTaskFiles() {
  if (tfSyncing) return tfSyncing;
  tfSyncing = (async () => {
    const settings = await getSettings().catch(() => ({}));
    if (settings.taskFilesDrive === false) return { ok: true, off: true };
    const tok = await getValidToken(false).catch(() => null);
    if (!tok) return { ok: false, reason: "signed-out" };
    const local = await tfAll();
    const { taskFilesChangedAt = 0, taskFilesPushedAt = 0 } = await chrome.storage.local.get(["taskFilesChangedAt", "taskFilesPushedAt"]);
    // Restore only on a computer that has never changed its Task files (a new
    // install / second computer) - if the user deleted them all here, the empty
    // list is pushed instead, so deleted files don't come back.
    if (!local.length && !taskFilesChangedAt) {
      const remote = await pullTaskFiles(tok).catch(() => null);
      const recs = remote && Array.isArray(remote.files) ? remote.files.filter((r) => r && r.id && r.ck) : [];
      if (recs.length) {
        await tfPutMany(recs);
        await chrome.storage.local.set({ taskFilesPushedAt: Date.now(), taskFilesChangedAt: Date.now() });
        return { ok: true, restored: recs.length };
      }
      if (!taskFilesChangedAt) return { ok: true, nothing: true }; // never had any: don't write an empty backup
    }
    if (taskFilesChangedAt <= taskFilesPushedAt) return { ok: true, upToDate: true };
    const files = local.map(({ blob, ...rest }) => rest); // text only - screenshots stay on this computer
    const payload = { v: 1, at: Date.now(), files };
    // Not enough room in the user's Google Drive: pause the backup and say so.
    const q = await driveQuota(tok).catch(() => null);
    const need = JSON.stringify(payload).length + 20 * 1048576; // the backup + a safety margin
    if (q && q.limit && q.limit - q.usage < need) {
      await notifyDriveFull(q, "Task files backup is paused");
      return { ok: false, reason: "drive-full" };
    }
    await pushTaskFiles(tok, payload);
    await chrome.storage.local.set({ taskFilesPushedAt: Date.now() });
    return { ok: true, pushed: files.length };
  })().catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) })).finally(() => { tfSyncing = null; });
  return tfSyncing;
}
// Google Drive (almost) full: one notification a day, whichever sync hit it.
async function notifyDriveFull(q, what) {
  // Off / paused in the bell menu: no pop-up (the Drive card still shows it).
  if (notificationsMuted(await getSettings())) return;
  const { driveFullNotifiedAt = 0 } = await chrome.storage.local.get("driveFullNotifiedAt");
  if (Date.now() - driveFullNotifiedAt < 24 * 3600000) return;
  await chrome.storage.local.set({ driveFullNotifiedAt: Date.now() });
  const gb = (n) => (n / 1073741824).toFixed(1) + " GB";
  chrome.notifications.create("drive-full-" + Date.now(), {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), priority: 2,
    title: "Google Drive is almost full",
    message: (what ? what + ": " : "Drive sync can't save: ") + (q && q.limit ? gb(q.usage) + " of " + gb(q.limit) + " used. " : "") +
      "Free up space in Google Drive (or turn off the backup in Options) so your settings and files keep syncing.",
    buttons: [{ title: "Open Google Drive storage" }],
  }, () => void chrome.runtime.lastError);
}
chrome.notifications.onButtonClicked.addListener((id) => {
  if (id.startsWith("drive-full-")) { chrome.notifications.clear(id).catch(() => {}); chrome.tabs.create({ url: "https://drive.google.com/settings/storage" }).catch(() => {}); }
});
chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith("drive-full-")) { chrome.notifications.clear(id).catch(() => {}); chrome.tabs.create({ url: "https://drive.google.com/settings/storage" }).catch(() => {}); }
});

// ---------- personal reminders (Options > Reminders, the ⏰ button) ----------
// Stored as `reminders` [{ id, text, at, repeat, taskId, taskName, taskUrl,
// active, done, firedAt }] and backed up to Drive with the other extras. One
// alarm per upcoming reminder; the every-minute check also fires anything
// overdue (asleep / Chrome closed -> shown as "Missed reminder"). Reminders the
// user set themselves still show during "Pause 1 hour"; "All notifications off"
// still silences them. The sound follows the Sound switch and the volume.
const REM_PREFIX = "rem-";
async function remList() {
  const { reminders } = await chrome.storage.local.get("reminders");
  return Array.isArray(reminders) ? reminders.filter((r) => !(r && REM_RETIRED.has(r.id))) : [];
}
// Days of the month an "On set dates" reminder goes off ([17, 19, 21, 25]).
const remDates = (list) => [...new Set((Array.isArray(list) ? list : []).map((n) => Math.round(Number(n))).filter((n) => n >= 1 && n <= 31))].sort((a, b) => a - b);
// "On picked days": the calendar days ticked for it ["2026-10-17", ...].
const remDays = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)))].sort();
// The next picked day after `now`, at the reminder's time of day - 0 when none is left.
function remNextDay(at, days, now) {
  const t = new Date(Number(at) || now);
  for (const k of remDays(days)) {
    const [y, m, d] = k.split("-").map(Number);
    const ts = new Date(y, m - 1, d, t.getHours(), t.getMinutes(), 0, 0).getTime();
    if (ts > now) return ts;
  }
  return 0;
}
// Next time a repeating reminder is due, after `now` (local time kept).
function remNext(at, repeat, now, dates) {
  const t = new Date(at);
  let guard = 0;
  if (repeat === "dates") {
    const days = remDates(dates);
    // A month without that day (the 31st of February) is skipped, not moved -
    // walking a day at a time, so the longest wait is Jan 31 -> Mar 31. With no
    // days at all it falls through to daily rather than never firing again.
    if (days.length) {
      do { t.setDate(t.getDate() + 1); } while ((t.getTime() <= now || !days.includes(t.getDate())) && ++guard < 800);
      return t.getTime();
    }
  }
  do {
    t.setDate(t.getDate() + (repeat === "weekly" ? 7 : 1));
    if (repeat === "weekdays") while (t.getDay() === 0 || t.getDay() === 6) t.setDate(t.getDate() + 1);
  } while (t.getTime() <= now && ++guard < 800);
  return t.getTime();
}
// Office reminders everyone starts with: check-in / check-out (the team uses
// the Rigo app) and returning your cup to the kitchen at noon. Ordinary weekday
// reminders, each added once: they show in Options > Reminders, where they can
// be edited, paused or deleted like any other; a deleted one isn't added back.
// A new entry here reaches existing users too (tracked per id).
// Office reminders stay quiet on company days off: check-in/out on holidays
// (work from home still checks in), the cup reminder on holidays and WFH days.
const REM_SKIP = { "default-checkin": ["holiday"], "default-checkout": ["holiday"], "default-cups-noon": ["holiday", "wfh"] };
const REM_DEFAULTS = [
  { id: "default-checkin", text: "Check in? Rigo", h: 8, m: 10, sound: "danger" },
  { id: "default-checkout", text: "Check out? Rigo", h: 17, m: 0, sound: "danger" },
  // A NEW id (the 2:00 PM "default-cups" is retired below), so everyone gets
  // the 12:00 PM one once; deleting it keeps it deleted, like the others.
  { id: "default-cups-noon", text: "Return your cup to the kitchen", h: 12, m: 0, sound: "normal" },
];
// Office reminders that were handed out once and are now withdrawn for
// everyone: taken off every copy's list on update (and if a Drive restore
// brings one back), and never fired again.
const REM_RETIRED = new Set(["default-cups"]);
async function retireOldReminders() {
  const { reminders } = await chrome.storage.local.get("reminders");
  if (!Array.isArray(reminders) || !reminders.some((r) => r && REM_RETIRED.has(r.id))) return;
  await chrome.storage.local.set({ reminders: reminders.filter((r) => !(r && REM_RETIRED.has(r.id))) });
  for (const id of REM_RETIRED) await chrome.alarms.clear(REM_PREFIX + id).catch(() => {});
}
// The next weekday at h:m that's still ahead.
function remNextWeekdayAt(h, m, now = Date.now()) {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  while (d.getTime() <= now || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.getTime();
}
// ---- Reminders the admin sends to everyone (update-policy.json "teamReminders") ----
// [{ id, text, h, m, repeat: daily|weekdays|weekly|dates, dow, dates, sound, v, force, removed }]
// Each copy updates its reminder with that id (or adds it). Someone who changed
// or deleted it themselves keeps their choice - unless the admin ticked "also
// for people who changed it" (force). teamRemApplied { id: { v, sig } } remembers
// what was last set here, which is how a personal change is recognised.
function normTeamRems(list) {
  return (Array.isArray(list) ? list : []).filter((t) => t && /^[\w-]{3,60}$/.test(String(t.id || ""))).map((t) => {
    const dates = remDates(t.dates);
    const days = remDays(t.days);
    const repeat = ["daily", "weekdays", "weekly", "dates", "days"].includes(t.repeat) ? t.repeat : "weekdays";
    return {
      id: String(t.id), text: String(t.text || "").trim().slice(0, 300),
      h: Math.max(0, Math.min(23, Number(t.h) || 0)), m: Math.max(0, Math.min(59, Number(t.m) || 0)),
      // "On set dates" with no dates could never fire: treat it as weekdays
      // rather than hand everyone a reminder that sits there doing nothing.
      repeat: (repeat === "dates" && !dates.length) || (repeat === "days" && !days.length) ? "weekdays" : repeat,
      dates, days,
      dow: Math.max(0, Math.min(6, Number(t.dow) || 0)), sound: ["normal", "danger", "winner"].includes(t.sound) ? t.sound : "normal",
      v: Number(t.v) || 0, force: !!t.force, removed: !!t.removed,
    };
  }).filter((t) => t.removed || t.text);
}
const remHm = (at) => { const d = new Date(Number(at) || 0); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
// The fingerprint that says whether this person has changed the reminder since
// the admin last set it - so the set of dates has to count as part of it.
const remSig = (r) => String((r && r.text) || "").trim() + "|" + remHm(r && r.at) + "|" + String((r && r.repeat) || "") + (r && r.repeat === "dates" ? "|" + remDates(r.dates).join(",") : "") + (r && r.repeat === "days" ? "|" + remDays(r.days).join(",") : "");
function remDefaultSig(id) {
  const d = REM_DEFAULTS.find((x) => x.id === id);
  return d ? d.text + "|" + String(d.h).padStart(2, "0") + ":" + String(d.m).padStart(2, "0") + "|weekdays" : "";
}
function teamRemNextAt(t, now = Date.now()) {
  if (t.repeat === "weekdays") return remNextWeekdayAt(t.h, t.m, now);
  const d = new Date(now); d.setHours(t.h, t.m, 0, 0);
  // Picked days: the next one still ahead (none left: the last one, already past).
  if (t.repeat === "days") { const days = remDays(t.days); const nx = remNextDay(d.getTime(), days, now); if (nx) return nx; if (days.length) { const [y, m, dd] = days[days.length - 1].split("-").map(Number); return new Date(y, m - 1, dd, t.h, t.m).getTime(); } }
  if (t.repeat === "dates") {
    // Days of the month: the first one still ahead. A month without that day is
    // skipped, so a 31st-only reminder waits for the next 31-day month.
    const days = remDates(t.dates);
    if (days.length) { let guard = 0; while ((d.getTime() <= now || !days.includes(d.getDate())) && ++guard < 800) d.setDate(d.getDate() + 1); return d.getTime(); }
  }
  if (t.repeat === "weekly") { while (d.getDay() !== t.dow || d.getTime() <= now) d.setDate(d.getDate() + 1); }
  else while (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function applyTeamReminders(policy) {
  const list = normTeamRems(policy && policy.teamReminders);
  if (!list.length) return false;
  const g = await chrome.storage.local.get(["teamRemApplied", "remDefaultsDone", "reminders"]);
  const applied = g.teamRemApplied && typeof g.teamRemApplied === "object" ? { ...g.teamRemApplied } : {};
  if (list.every((t) => applied[t.id] && applied[t.id].v >= t.v)) return false; // nothing new: one storage read
  const rems = Array.isArray(g.reminders) ? g.reminders.slice() : [];
  const seeded = new Set(Array.isArray(g.remDefaultsDone) ? g.remDefaultsDone : []);
  let changed = false;
  for (const t of list) {
    const a = applied[t.id];
    if (a && a.v >= t.v) continue;
    const i = rems.findIndex((r) => r && r.id === t.id);
    const r = i >= 0 ? rems[i] : null;
    if (t.removed) {
      if (r) { rems.splice(i, 1); changed = true; }
      applied[t.id] = { v: t.v, sig: "" };
      continue;
    }
    const base = a ? a.sig : remDefaultSig(t.id);
    if (r) {
      if (!t.force && base && remSig(r) !== base) { applied[t.id] = { v: t.v, sig: base }; continue; } // changed by this person: kept
      Object.assign(r, { text: t.text, repeat: t.repeat, dates: t.dates, days: t.days, sound: t.sound, at: teamRemNextAt(t), active: t.repeat !== "days" || teamRemNextAt(t) > Date.now(), done: false });
      applied[t.id] = { v: t.v, sig: remSig(r) };
      changed = true;
    } else {
      // Not here: deleted by this person (it was handed out before) unless forced.
      if (!t.force && (a || seeded.has(t.id))) { applied[t.id] = { v: t.v, sig: a ? a.sig : "" }; continue; }
      const nr = { id: t.id, text: t.text, at: teamRemNextAt(t), repeat: t.repeat, dates: t.dates, days: t.days, sound: t.sound, taskId: "", taskName: "", taskUrl: "", files: [], active: true, createdAt: Date.now(), team: true };
      rems.push(nr);
      applied[t.id] = { v: t.v, sig: remSig(nr) };
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ reminders: rems });
  await chrome.storage.local.set({ teamRemApplied: applied });
  if (changed) await scheduleReminders().catch(() => {});
  return changed;
}

// Copies from before the office reminders said "Rigo" still show "Check in?" /
// "Check out?": bring those up to date. Only that exact old text is changed - a
// reminder someone rewrote themselves is left as it is.
async function renameOldCheckReminders() {
  const { reminders } = await chrome.storage.local.get("reminders");
  if (!Array.isArray(reminders)) return;
  const want = { "check in?": "Check in? Rigo", "check out?": "Check out? Rigo" };
  let changed = false;
  for (const r of reminders) {
    const t = String((r && r.text) || "").trim().toLowerCase();
    if (r && want[t]) { r.text = want[t]; changed = true; }
  }
  if (changed) await chrome.storage.local.set({ reminders });
}
async function ensureDefaultReminders() {
  await retireOldReminders().catch(() => {});
  await renameOldCheckReminders().catch(() => {});
  // Which defaults were already added here (older copies kept one yes/no flag,
  // which covered only the check-in / check-out pair).
  const { remDefaultsSeeded, remDefaultsDone } = await chrome.storage.local.get(["remDefaultsSeeded", "remDefaultsDone"]);
  const done = new Set(Array.isArray(remDefaultsDone) ? remDefaultsDone : remDefaultsSeeded ? ["default-checkin", "default-checkout"] : []);
  if (REM_DEFAULTS.every((d) => done.has(d.id))) return false;
  const list = await remList();
  const have = new Set(list.map((r) => r && r.id).concat(list.map((r) => r && String(r.text || "").trim().toLowerCase())));
  let added = 0;
  for (const d of REM_DEFAULTS) {
    if (done.has(d.id)) continue;
    done.add(d.id);
    const short = d.text.replace(/\s+Rigo$/, "").toLowerCase(); // an older copy said just "Check in?"
    if (have.has(d.id) || have.has(d.text.toLowerCase()) || have.has(short)) continue; // already there (e.g. restored from Drive)
    list.push({ id: d.id, text: d.text, at: remNextWeekdayAt(d.h, d.m), repeat: "weekdays", sound: d.sound || "normal", taskId: "", taskName: "", taskUrl: "", files: [], active: true, createdAt: Date.now() });
    added++;
  }
  if (added) await chrome.storage.local.set({ reminders: list });
  await chrome.storage.local.set({ remDefaultsDone: [...done], remDefaultsSeeded: Date.now() });
  return added > 0;
}
async function scheduleReminders() {
  const list = await remList();
  const now = Date.now();
  const alarms = await chrome.alarms.getAll().catch(() => []);
  for (const a of alarms) if (a.name.startsWith(REM_PREFIX)) await chrome.alarms.clear(a.name).catch(() => {});
  for (const r of list) {
    if (!r || r.done || r.active === false || r.paused || !(Number(r.at) > 0)) continue;
    chrome.alarms.create(REM_PREFIX + r.id, { when: Math.max(Number(r.at), now + 1000) });
  }
}
// First attached image, shrunk to a small JPEG data URL for the notification.
async function remImageUrl(r) {
  const img = (Array.isArray(r.files) ? r.files : []).find((f) => /^image\//.test(f.type || ""));
  if (!img) return "";
  try {
    const db = await new Promise((ok, bad) => { const rq = indexedDB.open("pcm-remfiles", 1); rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains("files")) rq.result.createObjectStore("files", { keyPath: "id" }); }; rq.onsuccess = () => ok(rq.result); rq.onerror = () => bad(rq.error); });
    const rec = await new Promise((ok) => { const g = db.transaction("files").objectStore("files").get(img.id); g.onsuccess = () => ok(g.result); g.onerror = () => ok(null); });
    db.close();
    if (!rec || !rec.blob) return "";
    const bmp = await createImageBitmap(rec.blob);
    const scale = Math.min(1, 720 / bmp.width, 400 / bmp.height);
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * scale)), Math.max(1, Math.round(bmp.height * scale)));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    const u8 = new Uint8Array(await out.arrayBuffer());
    let bin = ""; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return "data:image/jpeg;base64," + btoa(bin);
  } catch (e) { return ""; }
}
async function showReminder(r, missed) {
  const s = await getSettings().catch(() => ({}));
  if (s.notifyAll === false) return; // "All notifications off" silences reminders too (pause doesn't)
  const nFiles = Array.isArray(r.files) ? r.files.length : 0;
  const imageUrl = nFiles ? await remImageUrl(r) : "";
  const when = new Date(Number(r.at)).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const id = REM_PREFIX + r.id + "-" + Date.now();
  // With files, a click opens the reminder (files + task link); else the task.
  if (r.taskUrl && !nFiles) notifTargetUrls.set(id, r.taskUrl);
  const ctx = [r.taskName ? "Task: " + String(r.taskName).slice(0, 100) : "", nFiles ? "\uD83D\uDCCE " + nFiles + " file" + (nFiles === 1 ? "" : "s") : ""].filter(Boolean).join(" \u00b7 ");
  try {
    await chrome.notifications.create(id, {
      type: imageUrl ? "image" : "basic",
      ...(imageUrl ? { imageUrl } : {}),
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: missed ? "Missed reminder (" + when + ")" : "\u23F0 Reminder",
      message: String(r.text || "Reminder").slice(0, 300),
      contextMessage: ctx || undefined,
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: "Snooze 10 min" }, { title: "Done" }],
    });
  } catch (e) {}
  // The reminder's own sound: Normal chime (default), Alarm, Celebration or Silent.
  const snd = r.sound === "danger" ? "danger" : r.sound === "winner" ? "winner" : null;
  if (s.notifySound !== false && r.sound !== "none") await playNotificationSound(true, snd).catch(() => {});
}
// Fire every reminder that is due (alarm, the minute check, or Chrome start).
let remBusy = Promise.resolve();
function fireDueReminders() {
  remBusy = remBusy.then(async () => {
    const list = await remList();
    const now = Date.now();
    let changed = false, shown = 0;
    for (const r of list) {
      if (!r || r.done || r.active === false || r.paused || !(Number(r.at) > 0) || Number(r.at) > now + 15000) continue;
      const missed = now - Number(r.at) > 5 * 60000;
      const offToday = (REM_SKIP[r.id] || []).some((k) => (k === "holiday" ? isCompanyHoliday : isCompanyWfh)(Number(r.at)));
      if (shown < 5 && !offToday) {
        if (r.forMe !== false) await showReminder(r, missed);
        if (missed && r.forMe !== false) r.missedAt = now; // the sidebar counts it on Reminders
        if (Array.isArray(r.to) && r.to.length) await remSendToPeople(r).catch(() => {});
        shown++;
      }
      r.firedAt = now;
      if (r.repeat === "daily" || r.repeat === "weekdays" || r.repeat === "weekly" || r.repeat === "dates") r.at = remNext(Number(r.at), r.repeat, now, r.dates);
      else if (r.repeat === "days" && remNextDay(r.at, r.days, now)) r.at = remNextDay(r.at, r.days, now); // the next picked day
      else r.active = false; // one-time (or the last picked day): moves to "Past" in the list
      changed = true;
    }
    if (changed) await chrome.storage.local.set({ reminders: list });
  }).catch(() => {});
  return remBusy;
}
// A reminder for other people (⏰ Remind me › For): to their extension through
// the Team hub; someone without the extension gets a ClickUp comment assigned to
// them when it's about a task. What happened is kept on the reminder (r.sent).
async function remNudge(cfg, userId, r) {
  const text = String(r.text || "").trim().slice(0, 300);
  if (await hubUrl()) {
    await hubHello(true).catch(() => {});
    const payload = { toUser: userId, taskId: r.taskId || "", taskName: String(r.taskName || r.text || "").slice(0, 200), taskUrl: r.taskId ? taskUrlFor(r.taskId) : "", text };
    let h = await hubCall("nudge", payload).catch(() => null);
    if (h && String(h.error || "").toLowerCase() === "admin only" && (await hubAdminKey())) h = await hubCall("nudge", payload, true).catch(() => null);
    if (h && h.ok) return "extension";
    if (!(h && h.reason === "no-extension") && !r.taskId) throw new Error(String((h && h.error) || "The Team hub didn't answer."));
  }
  if (!r.taskId) throw new Error("They don't use the extension, and the reminder isn't on a task (so there's nowhere in ClickUp to tell them).");
  await postAssignedComment(cfg.token, r.taskId, "\u23F0 Reminder from " + (cfg.username || "a teammate") + (text ? ": " + text : " - please take a look at this task."), userId);
  return "clickup";
}
async function remSendToPeople(r) {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token) return;
  const sent = [], failed = [];
  for (const p of r.to) {
    if (!/^\d+$/.test(String(p.id)) || String(p.id) === String(cfg.userId)) continue;
    try { sent.push(p.name + ((await remNudge(cfg, String(p.id), r)) === "clickup" ? " (ClickUp comment)" : "")); }
    catch (e) { failed.push(p.name + ": " + String((e && e.message) || e)); }
  }
  r.sent = { at: Date.now(), sent, failed };
  if (r.forMe === false && (sent.length || failed.length)) {
    notify("rem-sent-" + r.id + "-" + Date.now(), failed.length ? "Reminder not sent to everyone" : "Reminder sent \u2713",
      (sent.length ? "To " + sent.join(", ") + ". " : "") + (failed.length ? "Couldn't reach " + failed.join("; ") : "")).catch(() => {});
  }
}
async function remAct(notifId, btn) {
  const rid = notifId.slice(REM_PREFIX.length, notifId.lastIndexOf("-"));
  chrome.notifications.clear(notifId).catch(() => {});
  const list = await remList();
  const r = list.find((x) => x && x.id === rid);
  if (!r) return;
  if (btn === 0) {
    // Snooze: a one-time reminder comes back in 10 minutes; a repeating one gets
    // an extra one-time copy so its own schedule stays as it is.
    const soon = Date.now() + 10 * 60000;
    if (!r.repeat || r.repeat === "none") { r.at = soon; r.active = true; }
    else list.push({ ...r, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), repeat: "none", at: soon, active: true, snoozeOf: r.id });
  } else if (!r.repeat || r.repeat === "none") {
    r.done = true; r.active = false;
  }
  await chrome.storage.local.set({ reminders: list });
}
chrome.notifications.onButtonClicked.addListener((id, btn) => {
  if (id.startsWith(REM_PREFIX)) remAct(id, btn).catch(() => {});
});
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith(REM_PREFIX) || notifTargetUrls.has(id)) return; // a linked task opens via the shared handler
  chrome.notifications.clear(id).catch(() => {});
  // The in-memory link is gone after a worker restart: read it from the reminder.
  remList().then((list) => {
    const rid = id.slice(REM_PREFIX.length, id.lastIndexOf("-"));
    const r = list.find((x) => x && x.id === rid);
    const url = r && !(r.files && r.files.length) && /^https:\/\/app\.clickup\.com\//.test(String(r.taskUrl || "")) ? r.taskUrl
      : chrome.runtime.getURL("options.html" + (r ? "?rem=" + encodeURIComponent(r.id) : "") + "#reminders");
    chrome.tabs.create({ url }).catch(() => {});
  }).catch(() => {});
});
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.reminders) scheduleReminders().catch(() => {});
});

// Any Drive write refused because the Drive is full (lib-drive sets driveFullAt).
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.driveFullAt && ch.driveFullAt.newValue) notifyDriveFull(null, "").catch(() => {});
});
let tfTimer = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.taskFilesChangedAt) return;
  clearTimeout(tfTimer);
  tfTimer = setTimeout(() => { syncTaskFiles().catch(() => {}); }, 5000);
});

// ---------- Diagnostics (Options > General > Help & diagnostics) ----------
// The last 25 errors from the background and the pages (pcm-help.js), plus a
// readable report the user copies and sends to whoever helps them. The report
// never carries tokens, emails, links or long IDs (scrubDiag).
async function diagLog(where, e) {
  try {
    const msg = String((e && e.message) || e || "error").slice(0, 300);
    const { diagLog: log } = await chrome.storage.local.get("diagLog");
    const next = (Array.isArray(log) ? log : []).concat({ at: Date.now(), where, msg });
    await chrome.storage.local.set({ diagLog: next.slice(-25) });
  } catch (e2) {}
}
self.addEventListener("error", (e) => { diagLog("background", (e.message || "error") + (e.lineno ? " (line " + e.lineno + ")" : "")); });
self.addEventListener("unhandledrejection", (e) => { diagLog("background", "promise: " + ((e.reason && e.reason.message) || e.reason)); });
function scrubDiag(s) {
  return String(s == null ? "" : s)
    .replace(/Bearer\s+\S+/gi, "Bearer [token]")
    .replace(/\b(pk|ghp|gho|ghs|github_pat|ya29|sk)[_.-][\w.-]+/gi, "[token]")
    .replace(/https?:\/\/[^\s"')<>]+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[id]");
}
async function buildDiagReport(pageInfo) {
  const p = pageInfo || {};
  const when = (t) => (t ? new Date(t).toLocaleString() + " (" + Math.round((Date.now() - t) / 60000) + " min ago)" : "never");
  const L = [];
  const add = (k, v) => L.push(k + ": " + v);
  L.push("Personal ClickUp Manager diagnostics");
  add("Made", new Date().toString());
  add("Version", chrome.runtime.getManifest().version);
  add("Browser", p.browser || navigator.userAgent);
  add("Platform", p.platform || "?");
  add("Language", p.language || "?");
  add("Folder picker available", p.folderPicker === false ? "no (Brave: needs the File System Access flag)" : "yes");
  if (Array.isArray(p.setup) && p.setup.length) { L.push("Setup:"); for (const s of p.setup) L.push("  " + s); }

  const settings = await getSettings().catch(() => ({}));
  const cfg = await getClickupConfig().catch(() => null);
  const cst = await getClickupState().catch(() => null);
  L.push("ClickUp:");
  L.push("  connected: " + (cfg && cfg.token ? "yes" : "no") + " · workspace chosen: " + (cfg && cfg.teamId ? "yes" : "no") + " · user found: " + (cfg && cfg.userId ? "yes" : "no"));
  L.push("  last refresh: " + when(cst && cst.at));
  if (cst && cst.error) L.push("  last error: " + cst.error + " at " + when(cst.errorAt));
  if (cst && cst.rateLimitedUntil > Date.now()) L.push("  rate-limited for " + Math.round((cst.rateLimitedUntil - Date.now()) / 1000) + " s");
  const tasks = cst && Array.isArray(cst.tasks) ? cst.tasks.length : 0;
  L.push("  tasks due today: " + tasks + " · timer running: " + (cst && cst.running ? "yes" : "no"));

  const signedIn = await isSignedIn().catch(() => false);
  const { driveLastSync, updateInfo, updatePolicy, autoUpdateState, siteMonitorState, diagLog: log } =
    await chrome.storage.local.get(["driveLastSync", "updateInfo", "updatePolicy", "autoUpdateState", "siteMonitorState", "diagLog"]);
  add("Drive sync", (signedIn ? "signed in" : "off") + " · last sync " + when(driveLastSync));
  L.push("Updates:");
  L.push("  latest known: " + ((updateInfo && updateInfo.latest) || "?") + " · settings file checked " + when(updatePolicy && updatePolicy.at));
  L.push("  install automatically: " + (settings.autoUpdate === false ? "off" : "on"));
  if (autoUpdateState) L.push("  last automatic install: " + (autoUpdateState.reason || "ok") + " · tries failed " + (autoUpdateState.fails || 0) + " · " + when(autoUpdateState.lastTry));
  try { const fx = await chrome.storage.local.get(["autoUpdateClickOnly", "autoUpdateViaTab"]); L.push("  waiting for a click: " + (fx.autoUpdateClickOnly ? "yes" + (fx.autoUpdateClickOnly.version ? " (v" + fx.autoUpdateClickOnly.version + ")" : " (old, for every version)") : "no") + " · last update tab: " + (fx.autoUpdateViaTab ? (fx.autoUpdateViaTab.reason || "ok") + (fx.autoUpdateViaTab.version ? " (v" + fx.autoUpdateViaTab.version + ")" : "") + " · " + when(fx.autoUpdateViaTab.at) : "never")); } catch (e) {}
  const sm = await getSiteMonitorConfig().catch(() => ({ sites: [] }));
  const down = siteMonitorState && typeof siteMonitorState === "object" ? Object.values(siteMonitorState).filter((s) => s && s.down).length : 0;
  add("Site monitor", (sm.enabled ? "on" : "off") + " · " + (Array.isArray(sm.sites) ? sm.sites.length : 0) + " sites · " + down + " down");
  let level = "?";
  try { level = await new Promise((r) => chrome.notifications.getPermissionLevel(r)); } catch (e) {}
  add("Notifications", level + (settings.notifyAll === false ? " · all turned off in the bell menu" : "") +
    (Number(settings.notifyPausedUntil) > Date.now() ? " · paused until " + new Date(settings.notifyPausedUntil).toLocaleTimeString() : ""));
  const off = Object.keys(settings).filter((k) => settings[k] === false);
  if (off.length) add("Switched off", off.join(", "));
  try {
    const cmds = await chrome.commands.getAll();
    add("Shortcuts", cmds.map((c) => (c.name === "_execute_action" ? "open popup" : c.name) + " = " + (c.shortcut || "not set")).join(" · "));
  } catch (e) {}
  try {
    const alarms = await chrome.alarms.getAll();
    L.push("Scheduled checks:");
    for (const a of alarms.sort((x, y) => x.scheduledTime - y.scheduledTime)) {
      L.push("  " + a.name + " in " + Math.max(0, Math.round((a.scheduledTime - Date.now()) / 60000)) + " min" + (a.periodInMinutes ? " (every " + a.periodInMinutes + " min)" : ""));
    }
  } catch (e) {}
  try { add("Storage used", Math.round((await chrome.storage.local.getBytesInUse(null)) / 1024) + " KB"); } catch (e) {}
  const errs = Array.isArray(log) ? log.slice(-15) : [];
  L.push("Recent errors" + (errs.length ? " (oldest first):" : ": none"));
  for (const e of errs) L.push("  " + new Date(e.at).toLocaleString() + " · " + e.where + " · " + e.msg);
  return L.map(scrubDiag).join("\n");
}

// ---------- Keyboard shortcuts (manifest "commands"; changed at chrome://extensions/shortcuts) ----------
// toggle-timer: stop the running timer, or start again the task stopped last
// (else the Extra Task). Same effect as the task row's Stop / Start buttons.
async function shortcutToggleTimer() {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId) {
    await notify("cu-shortcut", "Connect ClickUp first", "The start/stop shortcut needs ClickUp connected (Options > ClickUp setup).", null, chrome.runtime.getURL("options.html#clickup"));
    return;
  }
  const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
  const st = (await getClickupState().catch(() => null)) || {};
  if (cur) {
    await stopTimer(cfg.token, cfg.teamId);
    if (cur.taskId) await setTaskStatus(cfg.token, String(cur.taskId), "to do").catch(() => {});
    await chrome.storage.local.set({ lastStoppedTask: { id: cur.taskId ? String(cur.taskId) : null, name: cur.taskName || "", at: Date.now() } });
    if (String(st.activeTaskId || "") === String(cur.taskId || "")) await setClickupState({ ...st, activeTaskId: null });
    clearFilterCache();
    refreshClickup({ includeTasks: true }).catch(() => {});
    await notify("cu-shortcut", "Timer stopped", (cur.taskName || "Your task") + " - start it again with the same shortcut.", null);
    return;
  }
  const { lastStoppedTask } = await chrome.storage.local.get("lastStoppedTask");
  let task = null;
  if (lastStoppedTask && lastStoppedTask.id) {
    task = await getTaskById(cfg.token, lastStoppedTask.id).catch(() => null);
    if (task && isTaskDone(task)) task = null; // finished since: don't reopen it
  }
  if (!task && st.extraTask && st.extraTask.id) task = { id: st.extraTask.id, name: st.extraTask.name || "Extra Task" };
  if (!task) {
    await notify("cu-shortcut", "Nothing to start", "Start a task once from the popup; after that the shortcut starts and stops it.", null);
    return;
  }
  const id = String(task.id);
  if (st.activeTaskId && String(st.activeTaskId) !== id) await setTaskStatus(cfg.token, String(st.activeTaskId), "to do").catch(() => {});
  await setTaskStatus(cfg.token, id, "in progress").catch(() => {});
  await startTimer(cfg.token, cfg.teamId, id);
  await setClickupState({ ...st, activeTaskId: id });
  clearFilterCache();
  refreshClickup({ includeTasks: true }).catch(() => {});
  await notify("cu-shortcut", "Timer started", (task.name || "Your task") + " - stop it with the same shortcut.", null);
}
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-timer") {
    shortcutToggleTimer().catch((e) => {
      diagLog("shortcut", e);
      notify("cu-shortcut", "Shortcut failed", String(e && e.message ? e.message : e), "danger");
    });
  } else if (command === "toggle-float") {
    toggleFloat().catch((e) => diagLog("auto-float", "toggle: " + (e && e.message ? e.message : e)));
  } else if (command === "open-dashboard") {
    const url = chrome.runtime.getURL("options.html");
    chrome.tabs.query({ url: url + "*" }).then((tabs) => {
      const t = tabs[0];
      if (t) { chrome.tabs.update(t.id, { active: true, url: url + "#dashboard" }); chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); }
      else chrome.tabs.create({ url: url + "#dashboard" });
    }).catch(() => {});
  }
});

// Blank-page check: a site can answer "200 OK" with nothing on it (WordPress's
// white screen - a PHP fatal error with errors hidden - sends 0 bytes). The
// no-cors check below can't see that, so for sites the user allowed the
// extension to read (Site monitor > "Turn on blank-page check", optional host
// permission per site) the SAME single request reads the page instead.
// Returns a reason when the page is broken, else "".
const SITE_ERROR_PAGES = [
  [/There has been a critical error on (this|your) website/i, "WordPress critical error"],
  [/Error establishing a database connection/i, "database connection error"],
  [/(<b>)?(PHP )?(Fatal|Parse) error(<\/b>)?:\s/i, "PHP fatal error"],
  [/Briefly unavailable for scheduled maintenance/i, "stuck in WordPress maintenance mode"],
];
// The page a security plugin / firewall shows a visitor it has blocked or wants
// to challenge. Only on a short page (a real page that merely mentions one of
// these words must not match).
const SITE_BLOCK_PAGES = [
  [/Your access to this site has been limited|wordfence/i, "Wordfence blocked this computer"],
  [/imunify360|bot-protection|has been blocked by Imunify/i, "Imunify360 blocked this computer"],
  [/Access Denied - Sucuri Website Firewall|sucuri\.net\/privacy-policy/i, "Sucuri firewall blocked this computer"],
  [/sgcaptcha|SiteGround[^<]{0,80}(captcha|bot)/i, "SiteGround's bot check stopped this computer"],
  [/Attention Required! \| Cloudflare|Just a moment\.\.\.|cf-browser-verification|cf_chl_opt/i, "Cloudflare's check stopped this computer"],
  [/Request (was )?rejected|Mod_?Security|Not Acceptable!/i, "the server's firewall rejected this computer"],
  [/Too Many Requests|rate limit(ed)?/i, "the site is rate-limiting this computer"],
];
function firewallBlockReason(res, html) {
  const st = Number(res && res.status) || 0;
  const raw = String(html || "");
  if (st === 429) return "the site is rate-limiting this computer";
  if (raw.length > 60000) return "";
  for (const [re, why] of SITE_BLOCK_PAGES) if (re.test(raw)) return (st >= 400 || raw.length < 20000) ? why : "";
  return "";
}
function blankPageReason(html) {
  const raw = String(html || "");
  if (raw.trim().length < 64) return raw.trim().length ? "almost empty page (" + raw.trim().length + " bytes)" : "blank page - the server sent 0 bytes";
  // A meta-refresh page (a redirect, or SiteGround's bot check) isn't blank.
  if (/<meta[^>]+http-equiv=["']?refresh/i.test(raw)) return "";
  const text = raw.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<head\b[\s\S]*?<\/head>/i, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  // Error pages are short: an ordinary page that merely MENTIONS "Fatal error:"
  // or "critical error" somewhere in its text must not count as broken.
  if (text.length < 1500) for (const [re, why] of SITE_ERROR_PAGES) if (re.test(raw.slice(0, 200000))) return why;
  // Pages built by JavaScript (an empty shell + scripts) are fine: only call it
  // blank when nothing at all would show - no text, images, links or scripts.
  if (/<script[^>]+src=|<img\b|<iframe\b|<video\b|<svg\b|<a\s[^>]*href=/i.test(raw)) return "";
  return text.length < 20 ? "page has no visible content" : "";
}
// Origin patterns the blank-page check needs for a site (with and without www).
function siteReadOrigins(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./i, "");
    return ["*://" + h + "/*", "*://www." + h + "/*"];
  } catch (e) { return []; }
}
async function canReadSite(url) {
  const origins = siteReadOrigins(url);
  if (!origins.length) return false;
  try { return await chrome.permissions.contains({ origins }); } catch (e) { return false; }
}

// plainOnly: the "is this PC online" probes - generate_204 answers with an
// empty body on purpose, which the page reader would call a blank page.
async function checkOneSite(url, timeoutMs = SITE_MONITOR_CHECK_TIMEOUT_MS, plainOnly = false) {
  if (!plainOnly && await canReadSite(url)) {
    const r = await readOneSite(url, timeoutMs);
    if (r) return r; // else (a redirect to another domain, odd CORS) - the plain check below
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // no-cors: the extension has no host permission for client sites, so a
    // normal (CORS) fetch fails for EVERY site and would report it "down". An
    // opaque no-cors response still proves the server answered; a real outage
    // (DNS/connect/TLS failure, timeout) rejects and lands in the catch.
    const t0 = Date.now();
    const res = await fetch(url, { method: "GET", mode: "no-cors", cache: "no-store", redirect: "follow", signal: controller.signal });
    clearTimeout(timer);
    const ms = Date.now() - t0;
    if (res.type === "opaque" || res.type === "opaqueredirect") return { ok: true, status: 0, ms };
    return { ok: res.status < 500, status: res.status, ms };
  } catch (e) {
    clearTimeout(timer);
    const msg = String(e && e.message ? e.message : e);
    return { ok: false, status: 0, error: e && e.name === "AbortError" ? "No reply within " + Math.round(timeoutMs / 1000) + "s" : msg };
  }
}

// The PHP version a site's server states in its reply headers ("X-Powered-By:
// PHP/8.1.27", or in "Server"), noted during the normal check - no extra request.
// "" when it doesn't say (many hosts hide it). Saved per site (storage sitePhp)
// for Site monitor's PHP2Shell line (options.js).
const sitePhpSeen = new Map();
function phpFromHeaders(res, html) {
  const xp = String((res && res.headers && res.headers.get("x-powered-by")) || "");
  const sv = String((res && res.headers && res.headers.get("server")) || "");
  const m = (xp + " " + sv).match(/PHP\/(\d+\.\d+(?:\.\d+)?)/i);
  return { php: m ? m[1] : "", powered: xp.slice(0, 80), server: sv.slice(0, 80), platform: sitePlatform(res, html) };
}
// What the site is built on, from the page the check already read: a hosted
// builder (Wix, Shopify, Squarespace, Webflow) runs no PHP of the site's own, so
// PHP2Shell doesn't apply; "WordPress" when the page is one. "" when unsure.
function sitePlatform(res, html) {
  const h = (k) => String((res && res.headers && res.headers.get(k)) || "");
  const p = String(html || "").slice(0, 300000);
  if (h("x-wix-request-id") || /pepyaka/i.test(h("server")) || /content="Wix\.com Website Builder"|static\.wixstatic\.com/i.test(p)) return "Wix";
  if (h("x-shopify-stage") || h("x-shopid") || /cdn\.shopify\.com|Shopify\.theme/i.test(p)) return "Shopify";
  if (/squarespace/i.test(h("server")) || /static1\.squarespace\.com|<!-- This is Squarespace/i.test(p)) return "Squarespace";
  if (/content="Webflow"|website-files\.com|data-wf-site=/i.test(p)) return "Webflow";
  if (/\/wp-content\/|\/wp-includes\/|content="WordPress/i.test(p)) return "WordPress";
  return "";
}
// The readable version of the check (one GET, same as the plain one). Returns
// null when the page couldn't be read (so the caller falls back), never a false
// "down" for a read problem; a real outage (no reply / timeout) is still down.
async function readOneSite(url, timeoutMs, confirming = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    // The confirming read asks the way a browser does (for an HTML page, past any cache).
    res = await fetch(url, confirming
      ? { method: "GET", cache: "reload", credentials: "omit", redirect: "follow", signal: controller.signal, headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" } }
      : { method: "GET", cache: "no-store", credentials: "omit", redirect: "follow", signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") return { ok: false, status: 0, error: "No reply within " + Math.round(timeoutMs / 1000) + "s" };
    return null; // e.g. redirected to a domain we can't read: let the plain check decide
  }
  try {
    const html = await res.text();
    try { sitePhpSeen.set(url, phpFromHeaders(res, html)); } catch (e) {}
    clearTimeout(timer);
    const ms = Date.now() - t0;
    // A Cloudflare "checking your browser" page isn't an outage.
    if (res.headers.get("cf-mitigated") === "challenge") return { ok: true, status: res.status, ms, read: true };
    // Nor is the site's security plugin / firewall blocking THIS computer (it saw
    // a page being fetched every few minutes and took it for a bot): the site is
    // up for everyone else. Shown in Site monitor as a note, no alarm.
    const block = firewallBlockReason(res, html);
    if (block) return { ok: true, status: res.status, ms, read: true, blocked: block };
    if (res.status >= 500) return { ok: false, status: res.status, ms, read: true, error: "HTTP " + res.status + ((blankPageReason(html) && " - " + blankPageReason(html)) || "") };
    if (res.status >= 400) return { ok: true, status: res.status, ms, read: true }; // as before: only 5xx counts as down
    const why = blankPageReason(html);
    if (why) {
      // The server said it was sending a page, but nothing arrived: a reading
      // hiccup on this computer, not a blank site.
      const said = Number(res.headers.get("content-length")) || 0;
      if (!html.length && said > 0) return null;
      // A blank / error page is only believed when a second read a few seconds
      // later (asked the way a browser asks) shows it too: a firewall or cache
      // answering one automated request with an empty "200 OK" is common, and
      // the site is fine for everyone else (a false "site blank" alert).
      if (!confirming) {
        await sleepMs(4000);
        const again = await readOneSite(url, timeoutMs, true);
        if (!again || again.ok) return again ? { ...again, ms } : null;
        return again;
      }
      return { ok: false, blank: true, status: res.status, ms, read: true, error: "Page is broken: " + why + " (HTTP " + res.status + ")" };
    }
    return { ok: true, status: res.status, ms, read: true };
  } catch (e) {
    clearTimeout(timer);
    return e && e.name === "AbortError" ? { ok: false, status: res.status, error: "Page didn't finish loading within " + Math.round(timeoutMs / 1000) + "s" } : null;
  }
}

// Is THIS machine online? navigator.onLine is a quick "definitely not"; the
// probes settle it when it says yes (it also says yes on a captive portal).
async function internetReachable() {
  try { if (typeof navigator !== "undefined" && navigator.onLine === false) return false; } catch (e) {}
  for (const u of SITE_MONITOR_PROBES) {
    const r = await checkOneSite(u, SITE_MONITOR_PROBE_TIMEOUT_MS, true);
    if (r.ok) return true;
  }
  return false;
}

// What kind of problem a failed check is: the page answered but is empty / an
// error page (blank), the server answered with an error (5xx), or no answer at
// all (down - timeout, DNS, refused). Each gets its own notification.
const SITE_KINDS = {
  blank: { icon: "⚠️", level: "Warning", what: "site blank", sound: "danger" },
  "5xx": { icon: "🔥", level: "Error", what: "server error", sound: "danger" },
  down: { icon: "🚨", level: "Critical", what: "site down", sound: "danger" },
};
const SITE_SEVERITY = { blank: 1, "5xx": 2, down: 3 };
function siteKind(result) {
  if (result.blank) return "blank";
  if (result.read && Number(result.status) >= 500) return "5xx";
  return "down";
}
function siteKindLabel(kind, status) {
  const k = SITE_KINDS[kind] || SITE_KINDS.down;
  return k.what + (kind === "5xx" && status ? " (HTTP " + status + ")" : "");
}
const fmtMins = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? m + " min" : Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : ""); };
// One site's new state after a check, and the notification to show (if any).
// Pure (no Chrome calls), so it's tested on its own. A notification only comes
// on a CHANGE: up -> problem, one problem -> another kind, problem -> back up.
// Automatic checks need failuresNeeded failed checks in a row first; a manual
// "Check" decides at once (and notifies too - the change is real either way).
function siteDecide(prevIn, result, o) {
  const prev = { ...(prevIn || { up: null, fails: 0, lastCheck: 0, lastDownNotified: 0 }) };
  const now = o.now;
  // A fail count from long ago (PC asleep, Chrome closed) isn't consecutive.
  if (prev.lastCheck && now - prev.lastCheck > o.staleMs) prev.fails = 0;
  prev.lastCheck = now;
  prev.read = !!result.read; // the page itself was checked (blank-page check on)
  prev.blank = !result.ok && !!result.blank;
  let note = null;
  if (result.ok) {
    if (prev.up === false) {
      // Everything it went through, in order: "site blank, then server error (HTTP 500)".
      const seen = Array.isArray(prev.seen) && prev.seen.length ? prev.seen : [siteKindLabel(prev.kind || "down", prev.status)];
      const was = seen.join(", then ");
      note = { kind: "up", sound: undefined, title: "✅ Back up: " + o.name,
        message: o.name + " is working again" + (prev.downSince ? " - it was " + was + " for " + fmtMins(now - prev.downSince) : " (was " + was + ")") + "." };
    }
    prev.up = true;
    prev.fails = 0;
    prev.lastError = "";
    // Up for everyone, but the site's security is blocking this computer.
    prev.blocked = result.blocked || "";
    prev.lastMs = result.ms || 0;
    prev.kind = "";
    prev.status = 0;
    prev.downSince = 0;
    prev.seen = [];
    prev.worst = 0;
    return { prev, note };
  }
  const kind = siteKind(result);
  prev.fails = (prev.fails || 0) + 1;
  prev.lastError = result.error || ("HTTP " + result.status);
  if (!prev.downSince) prev.downSince = now;
  const k = SITE_KINDS[kind];
  const head = k.icon + " " + k.level + " - " + siteKindLabel(kind, result.status) + ": " + o.name;
  const why = kind === "blank" ? o.name + " answers, but the page is broken. " + prev.lastError
    : kind === "5xx" ? o.name + " answers with a server error (HTTP " + result.status + "). " + prev.lastError
    : o.name + " doesn't answer at all. " + prev.lastError +
      " If it opens fine for others, the site's security (a firewall or security plugin) may be blocking this computer - ask whoever manages the site to allow this office's IP.";
  if (prev.up === false) {
    // Already known to be down: news only when it gets WORSE than anything seen
    // in this outage (blank -> server error -> no answer). A server flapping
    // between 503 and a timeout must not post a sticky alarm every 5 minutes.
    if (SITE_SEVERITY[kind] > (prev.worst != null ? prev.worst : SITE_SEVERITY[prev.kind] || 0)) {
      note = { kind, sound: k.sound, title: k.icon + " Still broken, now " + siteKindLabel(kind, result.status) + ": " + o.name, message: why };
    }
  } else if (o.manual || prev.fails >= o.failuresNeeded) {
    if (o.manual) prev.fails = Math.max(prev.fails, o.failuresNeeded);
    prev.up = false;
    prev.lastDownNotified = now;
    note = { kind, sound: k.sound, title: head, message: why + (o.manual ? "" : " (" + prev.fails + " checks in a row, ~" + fmtMins(now - prev.downSince) + ")") };
  }
  // Only while it counts as down (an unconfirmed first failure isn't history).
  if (prev.up === false) {
    const lab = siteKindLabel(kind, result.status);
    prev.seen = Array.isArray(prev.seen) ? prev.seen : [];
    if (prev.seen[prev.seen.length - 1] !== lab) prev.seen = prev.seen.concat(lab).slice(-5);
  }
  if (prev.up === false) prev.worst = Math.max(prev.worst || 0, SITE_SEVERITY[kind] || 0);
  prev.kind = kind;
  prev.status = Number(result.status) || 0;
  return { prev, note };
}

// opts.manual (the options page's "Check now" buttons): decide up/down from this
// one check - no 2-check wait and no notification, since the user is looking at
// the result. The offline test and the slow retry still apply, so a blip on the
// user's own connection can't mark a site down. opts.url limits it to one site.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// The clients the Clients tab lists - from my tasks (Today, This week, Next week,
// tracked), plus ones added by hand, minus ones hidden (task-files.js mine()).
async function smMyClientKeys() {
  const g = await chrome.storage.local.get(["clickupState", "settings"]);
  const st = g.clickupState || {}, set = g.settings || {};
  const k = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const keys = new Set();
  for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) if (b) for (const f of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[f] || []) {
    const c = String((t && (t.client || (t.container && t.container.listName))) || "").trim();
    if (c && !/extra tasks?|daily tracking/i.test(c)) keys.add(k(c));
  }
  for (const c of Array.isArray(set.tfAdded) ? set.tfAdded : []) keys.add(k(c));
  for (const h of Array.isArray(set.tfHidden) ? set.tfHidden : []) keys.delete(h);
  return [...keys].filter((x) => x.length >= 3);
}
// The same rule as the page (options.js smNameMatch): equal, or one starts with the other when both have 4+ letters.
function smSiteIsMine(s, keys) {
  const b = String((s && s.name) || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return b.length >= 3 && keys.some((a) => a.length >= 3 && (a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)))));
}
async function checkSitesImpl(opts = {}) {
  const cfg = await getSiteMonitorConfig();
  if (!cfg || !Array.isArray(cfg.sites) || cfg.sites.length === 0) return { checked: 0 };
  if (!cfg.enabled && !opts.manual) return { checked: 0 };
  const now = Date.now();
  const state = (await chrome.storage.local.get("siteMonitorState"))["siteMonitorState"] || {};
  const siteSnooze = (await chrome.storage.local.get("siteSnooze")).siteSnooze || {};
  // A paused client's site isn't checked at all (no alerts, no requests): marked
  // so Site monitor can say so, and checked again once the client is resumed.
  for (const s of cfg.sites) {
    if (!s || !s.url) continue;
    const p = isPausedSite(s);
    if (p) state[s.url] = { ...(state[s.url] || { up: null, fails: 0, lastCheck: 0 }), paused: true };
    else if (state[s.url] && state[s.url].paused) { const { paused, ...rest } = state[s.url]; state[s.url] = rest; }
  }
  // A site switched off in Site monitor (its Monitor tick) isn't checked either.
  const siteOff = (await chrome.storage.local.get("siteOff")).siteOff || {};
  for (const s of cfg.sites) if (s && s.url && siteOff[s.url]) state[s.url] = { ...(state[s.url] || { up: null, fails: 0, lastCheck: 0 }), off: true };
  for (const s of cfg.sites) if (s && s.url && !siteOff[s.url] && state[s.url] && state[s.url].off) { const { off, ...rest } = state[s.url]; state[s.url] = rest; }
  // Site monitor › Only my clients: the other sites aren't checked (a single site's own Check still is).
  const mine = !opts.url && (await chrome.storage.local.get("smMineOnly")).smMineOnly ? await smMyClientKeys().catch(() => []) : [];
  const anyMine = mine.length && cfg.sites.some((s) => smSiteIsMine(s, mine));
  const sites = cfg.sites.filter((s) => s && s.url && (!opts.url || s.url === opts.url) && !isPausedSite(s) && !siteOff[s.url] && (!anyMine || smSiteIsMine(s, mine)));
  // Site monitor shows "Checking now…" on these until each one's own result is in
  // (startSiteCheck clears it when the run ends, however it ends).
  try { await chrome.storage.local.set({ siteMonitorChecking: { startedAt: now, urls: sites.map((s) => s.url) } }); } catch (e) {}
  // Persist on EVERY run (not only when a status flips) so the "last check" time
  // stays current - AND in stages, not once at the end. A run that fails waits
  // up to a minute in sleeps and retries below; if the worker is stopped in the
  // middle of that, or anything throws, a single save at the end lost every
  // result and the alert, and "last check" froze hours back while every row
  // still read "Up". That is a monitor that has gone blind without saying so.
  const saveState = async () => { try { await chrome.storage.local.set({ siteMonitorState: state }); } catch (e) {} };
  // mapLimit turns a check that threw into null. Reading .ok straight off that
  // threw a TypeError and took the whole run with it - one odd site stopped the
  // monitor for good, until the next reload.
  const results = new Map();
  const res = (s) => results.get(s && s.url) || { ok: false, status: 0, error: "The check didn't finish" };
  let localProblem = false;
  // Each site is decided once (done), and a site that throws on the way can't
  // stop the others or lose what the run already learned.
  const done = new Set();
  const decide = async (list) => {
    for (const site of list) {
      const key = site.url;
      if (!key || done.has(key)) continue;
      done.add(key);
      try {
        const prev = state[key] || { up: null, fails: 0, lastCheck: 0, lastDownNotified: 0 };
        const result = res(site);
        if (localProblem && !result.ok && !result.read) {
          // Leave up/fails untouched; just note why nothing was decided.
          prev.lastCheck = now;
          prev.lastError = "Couldn't check: this computer looked offline";
          prev.skippedAt = now;
          state[key] = prev;
          continue;
        }
        const d = siteDecide(prev, result, { manual: !!opts.manual, now, name: site.name || site.url, failuresNeeded: SITE_MONITOR_FAILURES, staleMs: SITE_MONITOR_STALE_MS });
        // Carried over by siteDecide's copy of prev: when this site was last
        // told about, and what for. Read before it is overwritten below.
        const toldBefore = d.prev.lastNote || null;
        state[key] = d.prev;
        // Snoozed in Site monitor (an unstable site that keeps alerting): still
        // checked and shown, just no alerts until the snooze ends.
        const snoozed = Number(siteSnooze[key]) > now;
        // The same alert for the same site, again, within minutes, is never
        // news - it is a duplicate run or a replayed alarm. The id has no
        // timestamp in it either, so a card that does slip through REPLACES the
        // old one in the tray instead of stacking another copy on top.
        const repeat = !!d.note && !!toldBefore && toldBefore.kind === d.note.kind && now - (Number(toldBefore.at) || 0) < SITE_NOTE_REPEAT_MS;
        if (d.note && !snoozed && !repeat) {
          // Written down BEFORE it is sent, so a worker that dies here can't
          // come back and announce the same thing all over again.
          d.prev.lastNote = { kind: d.note.kind, at: now };
          await saveState();
          // Guarded: a notification that fails is not a reason to throw away the
          // results of the run (it used to be sent before the only save).
          await notify("site-" + d.note.kind + "-" + key, d.note.title, d.note.message, d.note.sound, chrome.runtime.getURL("options.html#sites"),
            { priority: 2, requireInteraction: d.note.kind !== "up" }).catch((e) => diagLog("sites", e));
          // Automation rules: "A client's site goes down / comes back up".
          rulesFire(d.note.kind === "up" ? "site_up" : "site_down", [{ site: { name: site.name || site.url, url: site.url, paused: false }, at: now }]).catch(() => {});
        }
      } catch (e) { diagLog("sites", "deciding " + key + ": " + ((e && e.message) || e)); }
    }
    await saveState();
  };
  // 1) One check per site (30s timeout), a few sites at a time.
  const first = await mapLimit(sites, SITE_MONITOR_PARALLEL, (s) => checkOneSite(s.url));
  sites.forEach((s, i) => results.set(s.url, first[i]));
  // The PHP versions the sites just stated (Site monitor › PHP2Shell): kept per site.
  try {
    const sp = (await chrome.storage.local.get("sitePhp")).sitePhp || {};
    let n = 0;
    for (const s of sites) {
      const h = sitePhpSeen.get(s.url);
      if (!h) continue;
      sitePhpSeen.delete(s.url);
      const prev = sp[s.url];
      if (prev && prev.src) { // from the team sheet / WordPress itself: more reliable than a header (a CDN can say another PHP)
        if (h.platform && prev.platform !== h.platform) { sp[s.url] = { ...prev, platform: h.platform }; n++; }
        continue;
      }
      sp[s.url] = { ...(prev || {}), ...h, at: Date.now() }; n++; // keeps a failed WordPress read's reason
    }
    if (n) await chrome.storage.local.set({ sitePhp: sp });
  } catch (e) {}
  let failed = sites.filter((s) => !res(s).ok);
  // Sites that answered are settled: decide and save them now, before the waits.
  await decide(sites.filter((s) => res(s).ok));
  // 2) Anything failed: is it us? Offline, or half the list failing in the same
  //    minute, is this PC's connection - never a client outage. Don't count it.
  // A site that answered with a broken page (read: true) reached us fine, so it
  // never counts towards "is it this PC's connection".
  const unreachable = failed.filter((s) => !res(s).read);
  if (unreachable.length) {
    if (!(await internetReachable())) localProblem = true;
    else if (unreachable.length >= 2 && unreachable.length * 2 >= sites.length) localProblem = true;
  }
  // 3) Still suspect: re-try up to SITE_MONITOR_RETRIES more times, 20s apart
  //    (UptimeRobot's confirmation re-checks). Any answer clears it.
  for (let attempt = 0; attempt < SITE_MONITOR_RETRIES && failed.length && !localProblem; attempt++) {
    await sleepMs(SITE_MONITOR_RETRY_GAP_MS);
    const retried = await mapLimit(failed, SITE_MONITOR_PARALLEL, (s) => checkOneSite(s.url));
    failed.forEach((s, i) => results.set(s.url, retried[i]));
    failed = failed.filter((s) => !res(s).ok);
  }
  await decide(sites);
  // What the last run did, so the page and Copy diagnostics can tell "checked,
  // all fine" from "hasn't run for hours".
  try { await chrome.storage.local.set({ siteMonitorRun: { at: Date.now(), startedAt: now, checked: sites.length, ms: Date.now() - now, manual: !!opts.manual } }); } catch (e) {}
  const all = sites.map((s) => res(s));
  return { checked: sites.length, up: all.filter((r) => r.ok).length,
    down: localProblem ? 0 : all.filter((r) => !r.ok).length, offline: localProblem };
}

// Only ONE check runs at a time. Opening a laptop delivers every alarm Chrome
// missed at nearly the same moment (the 5-minute site alarm, the 1-minute
// backstop, and the options page asking for a check as it opens), and each run
// started by reading its own copy of siteMonitorState from before any of them
// saved. So each one saw the same sites as still down and each announced
// "Back up" - four sites came back and the user got a dozen notifications.
// Same single-flight shape as clickupRefreshInFlight: a second caller joins the
// run already in progress instead of starting a parallel one.
let siteCheckInFlight = null;
// A module variable is lost when MV3 restarts the worker mid-run, so the lease
// is also kept in storage. Honoured for 3 minutes - longer than the worst run
// (two 20s waits plus retries) - and only for automatic runs: a check the user
// asked for always goes ahead. The 1-minute backstop means a lock left behind
// by a killed worker costs one cycle, not the day.
const SITE_LOCK_MS = 3 * 60 * 1000;
function startSiteCheck(opts) {
  const run = (async () => {
    // Read inside the run, where an await is harmless. Doing it before the
    // claim below is what broke the first attempt at this fix.
    if (!opts.manual) {
      const held = (await chrome.storage.local.get("siteMonitorLock").catch(() => ({}))).siteMonitorLock;
      if (held && Date.now() - (Number(held.at) || 0) < SITE_LOCK_MS) return { checked: 0, busy: true };
    }
    await chrome.storage.local.set({ siteMonitorLock: { at: Date.now() } }).catch(() => {});
    try { return await checkSitesImpl(opts); }
    finally { await chrome.storage.local.remove(["siteMonitorLock", "siteMonitorChecking"]).catch(() => {}); }
  })().finally(() => { if (siteCheckInFlight === run) siteCheckInFlight = null; });
  siteCheckInFlight = run;
  return run;
}
// Deliberately NOT async: the check and the claim inside startSiteCheck have to
// happen in ONE uninterrupted turn. With an await between them - reading the
// storage lease, as this first did - all three callers woken by the same laptop
// lid see a null siteCheckInFlight, all yield on that read, and all three go on
// to start a run anyway. The guard reads as if it works and never fires.
function checkSites(opts = {}) {
  if (!siteCheckInFlight) return startSiteCheck(opts);
  // A run is already going: join it instead of starting a second one. If it
  // turns out to have stood down for a lease another worker left behind, a check
  // the user actually asked for still goes ahead on its own.
  if (!opts.manual) return siteCheckInFlight;
  return siteCheckInFlight.then((r) => (r && r.busy ? startSiteCheck(opts) : r));
}

// How long without a check before the monitor counts as stalled: 2.5x the
// 5-minute period, so one late alarm or one slow run isn't mistaken for a stop.
const SITE_MONITOR_STALL_MS = Math.round(2.5 * SITE_MONITOR_PERIOD_MIN * 60 * 1000);
const SITE_MONITOR_STALL_RETRY_MS = 5 * 60 * 1000; // at most one catch-up run per 5 min
const SITE_MONITOR_STALL_TELL_MS = 30 * 60 * 1000; // past half an hour, say it out loud
// "4h 25m" / "12 minutes" - for telling the user how long the gap was.
function siteGapLabel(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return m + (m === 1 ? " minute" : " minutes");
  const h = Math.floor(m / 60), r = m % 60;
  return h + "h" + (r ? " " + r + "m" : "");
}

// Site monitor safety net, run from the 1-minute alarm next to the other
// backstops. Chrome does drop alarms (a crashed worker, a long sleep, a profile
// reload), and before this a run that died left every row reading "Up" with the
// clock frozen hours back - the monitor was blind and said nothing. So: re-arm
// the alarm if it went missing, and if nothing has been checked for a while,
// check now and tell the user once.
async function siteMonitorBackstop() {
  const cfg = await getSiteMonitorConfig().catch(() => null);
  if (!cfg || !cfg.enabled || !Array.isArray(cfg.sites) || !cfg.sites.length) return;
  const now = Date.now();
  // Re-arm a dropped alarm. ensureAlarm is a no-op when the period already
  // matches, so this only does anything when Chrome really lost it.
  const alarm = await chrome.alarms.get(SITE_MONITOR_ALARM).catch(() => null);
  if (!alarm) await ensureAlarm(SITE_MONITOR_ALARM, { periodInMinutes: SITE_MONITOR_PERIOD_MIN });
  const store = await chrome.storage.local.get(["siteMonitorState", "siteOff", "siteMonitorWatch"]).catch(() => ({}));
  const state = store.siteMonitorState || {};
  const siteOff = store.siteOff || {};
  const watch = store.siteMonitorWatch || {};
  // This minute's heartbeat. A gap here means Chrome was closed or the PC was
  // asleep, which is the one case where a missed check is nobody's fault - so
  // catch up quietly then, and only call it a stall when we were awake for it.
  const tickAt = Number(watch.tickAt) || 0;
  const wasAwake = tickAt > 0 && now - tickAt < 3 * 60 * 1000;
  const keep = (extra) => chrome.storage.local.set({ siteMonitorWatch: { ...watch, tickAt: now, ...extra } }).catch(() => {});
  // Only the sites actually being monitored: a paused client or a site with its
  // Monitor tick off is meant to have an old timestamp and never counts.
  const watched = cfg.sites.filter((s) => s && s.url && !isPausedSite(s) && !siteOff[s.url]);
  let newest = 0;
  for (const s of watched) newest = Math.max(newest, Number((state[s.url] || {}).lastCheck) || 0);
  // Nothing watched, or nothing ever checked (just set up): leave it to the alarm.
  if (!watched.length || !newest) { await keep({}); return; }
  const stale = now - newest;
  if (stale < SITE_MONITOR_STALL_MS) { await keep({ since: 0, toldAt: 0, triedAt: Number(watch.triedAt) || 0 }); return; }
  // One catch-up at a time: a run with a failing site takes about a minute, and
  // this is called every minute.
  if (now - (Number(watch.triedAt) || 0) < SITE_MONITOR_STALL_RETRY_MS) { await keep({}); return; }
  const since = Number(watch.since) || newest;
  let toldAt = Number(watch.toldAt) || 0;
  if (wasAwake && stale >= SITE_MONITOR_STALL_TELL_MS && !toldAt) toldAt = now;
  await keep({ triedAt: now, since, toldAt });
  // Said once per episode (toldAt), and never for a shut-down or sleeping PC.
  if (toldAt === now) {
    await notify("site-stalled-" + newest, "Site monitor had stopped checking",
      "Nothing was checked for " + siteGapLabel(stale) + " (last check " +
        new Date(newest).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) +
        "). Checking " + watched.length + (watched.length === 1 ? " site" : " sites") + " now.",
      "normal", chrome.runtime.getURL("options.html#sites"), { priority: 2 }).catch((e) => diagLog("sites", e));
  }
  await checkSites().catch((e) => diagLog("sites", "backstop: " + ((e && e.message) || e)));
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
const TAG_LIST_STORE_KEY = "cuTagList"; // workspace tag names for the By-tag dropdown
const TAG_LIST_TTL = 24 * 3600 * 1000; // a day: tags change rarely, reads are cheap but not free
// Auto-detected "Extra(s) Task(s)" per user, cached 1h so filtered department /
// all-user views don't re-scan every render. userId (string) -> { at, task }.
const EXTRA_TASK_CACHE_MS = 3600000;
const extraTaskCache = new Map();
// Filter queries can be expensive (per-user Extra Task discovery + a wide scope),
// so they run in the background with a keepalive; the CLICKUP_FILTER handler
// answers instantly with "" building "" and the UI polls for the cached result.
const FILTER_CACHE_MS = 5 * 60 * 1000;
const lastFilterError = new Map(); // key -> the error of a build that just failed (told once)
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
// Same question, asked about SOMEONE ELSE: the Bulk edit tab's "Whose tasks".
// Keyed by user id, and deliberately separate from overdueCache so the
// dashboard's own "mine" answer is never replaced by a teammate's.
const overdueScopeCache = new Map();
// Overdue tasks for one person (empty scope = me). The "me" scope keeps filling
// the single-slot overdueCache, because that is what the dashboard's "Deadline
// crossed" reads; a teammate's list goes in the per-user map instead.
async function getOverdueTasks(cfg, force, assignee) {
  const whoKey = cuScopeKey(cfg.userId, assignee);
  const isMe = whoKey === String(cfg.userId == null ? "" : cfg.userId);
  // Same token rule as getOpenTasks / computeFilterData: another person's tasks
  // need the optional workspace Admin token, not your personal one.
  const token = cuScopeToken(cfg, cfg.userId, assignee);
  const cached = isMe ? overdueCache : overdueScopeCache.get(whoKey);
  if (!force && cached && Date.now() - cached.at < 5 * 60000) return { ok: true, data: cached.data };
  const todayStart = new Date().setHours(0, 0, 0, 0);
  const raw = [];
  for (let page = 0; page < 6; page++) {
    const url = cuOverdueUrl(cfg.teamId, { page, assignee: whoKey, before: todayStart });
    const res = await cuRawFetch(token, url, { headers: { Authorization: token } });
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
        assignees: cuRowAssignees(t), tags: [], assignee: cuTaskAssigneeName(t),
      };
    });
  const data = { tasks, deadlineTasks: [], trackedTasks: [],
    estimateMs: tasks.reduce((n, t) => n + t.estimateMs, 0), spentMs: tasks.reduce((n, t) => n + t.spentMs, 0) };
  const settings = await getSettings();
  await annotateClients(token, data, settings.cuClientLevel || "auto");
  if (isMe) overdueCache = { at: Date.now(), data };
  else {
    overdueScopeCache.set(whoKey, { at: Date.now(), data });
    if (overdueScopeCache.size > 8) overdueScopeCache.delete(overdueScopeCache.keys().next().value);
  }
  return { ok: true, data };
}
// The overdue query, as a pure URL builder (see cuOpenTasksUrl).
function cuOverdueUrl(teamId, { page = 0, assignee, before } = {}) {
  return "https://api.clickup.com/api/v2/team/" + encodeURIComponent(teamId) + "/task?page=" + encodeURIComponent(page) +
    "&subtasks=true&include_closed=false&assignees[]=" + encodeURIComponent(assignee || "") +
    "&due_date_lt=" + encodeURIComponent(before == null ? "" : before);
}
let openTasksCache = null; // Bulk edit "Any date" (CLICKUP_OPEN_TASKS)
// Every open task assigned to me, with or without dates, so the Insights tab
// can find missing estimates / due dates and the daily "needs tidying" reminder
// has something to talk about. Up to 6 pages, cached 3 minutes (the reminder
// asks for a fresh copy, since it only runs once a day).
// `tag` narrows it to one tag name (Bulk edit > "By tag"); ClickUp's own
// `tags[]` filter does that server-side, and matches names exactly.
// `assignee` narrows it to one person's tasks (empty = me). Scoping by user is
// the same `assignees[]` the Filter card already uses, so an Owner/Admin token
// can reach a teammate's tasks and a plain member simply gets their own.
// ---------- Insights > Performance (and Plan's estimate suggestions) ----------
// 12 weeks of history: tracked time per day and per task (ONE time-entries
// request) + the tasks finished in that time (1-5 light pages). Built only when
// Plan / Performance is opened, at most every 6 hours, never while ClickUp asks
// us to back off, one build at a time; kept in storage (perfHistory) so the tab
// paints at once and only refreshes quietly.
const PERF_WEEKS = 12;
const PERF_TTL_MS = 6 * 3600000;
let perfBuild = null;
// weeks: how far back (12 by default; 27 = six months, 53 = a year, asked for
// only when a 6-month / 1-year review period is picked). A longer history, once
// read, is kept and refreshed at that length - at most once a day.
const PERF_MAX_WEEKS = 53;
async function getPerfHistory(force, weeks) {
  const want = Math.max(PERF_WEEKS, Math.min(PERF_MAX_WEEKS, Number(weeks) || PERF_WEEKS));
  const { perfHistory } = await chrome.storage.local.get("perfHistory");
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, reason: "not-configured", data: perfHistory || null };
  // v2 adds per-day task hours + names (the clickable charts); an older copy is still shown until rebuilt.
  const mine = perfHistory && String(perfHistory.userId) === String(cfg.userId) ? perfHistory : null;
  const span = Math.max(want, (mine && Number(mine.weeks)) || PERF_WEEKS);
  const ttl = span > PERF_WEEKS ? 24 * 3600000 : PERF_TTL_MS;
  const fresh = mine && mine.v === 2 && (Number(mine.weeks) || PERF_WEEKS) >= want && Date.now() - (mine.at || 0) < (force ? 10 * 60000 : ttl);
  if (fresh) return { ok: true, data: mine };
  const cst = await getClickupState().catch(() => null);
  if (cst && cst.rateLimitedUntil > Date.now()) return { ok: true, data: mine, busy: true };
  if (!perfBuild) perfBuild = (async () => {
    const now = new Date();
    const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - 7 * (span - 1));
    const fromTs = mon.getTime(), toTs = Date.now();
    const hist = await fetchTrackedHistory(cfg.token, cfg.teamId, fromTs, toTs, cfg.userId);
    const days = {}, taskMs = {};
    for (const [d, m] of Object.entries(hist.byDay)) { let s = 0; for (const [tid, ms] of Object.entries(m)) { s += ms; taskMs[tid] = (taskMs[tid] || 0) + ms; } days[d] = s; }
    const done = await fetchDoneLite(cfg.token, cfg.teamId, cfg.userId, fromTs, toTs);
    const settings = await getSettings().catch(() => ({}));
    const holder = { tasks: done };
    await annotateClients(cfg.token, holder, settings.cuClientLevel || "auto").catch(() => {});
    const slim = (holder.tasks || done).map((t) => ({ id: t.id, name: t.name, url: t.url, parentId: t.parentId, client: t.client || "",
      dueDateMs: t.dueDateMs, doneAt: t.doneAt, estimateMs: t.estimateMs, spentMs: t.spentMs }));
    // The first day with tracked time: how long you have been working here, as far
    // as this history can tell (a 6-month review needs 6 months of it).
    const tracked = Object.keys(days).map(Number).filter((d) => days[d] > 0);
    const firstDay = tracked.length ? Math.min(...tracked) : 0;
    const data = { v: 2, at: Date.now(), userId: String(cfg.userId), fromTs, toTs, weeks: span, firstDay, days, taskMs, byDay: hist.byDay, names: hist.names, done: slim };
    await chrome.storage.local.set({ perfHistory: data });
    return data;
  })().finally(() => { perfBuild = null; });
  try { return { ok: true, data: await perfBuild }; }
  catch (e) { return { ok: !!mine, data: mine, error: String(e && e.message ? e.message : e) }; }
}
// ---------- Insights > Plan: developers' tasks that will come back as reviews ----------
// When a developer finishes a "dev"-tagged task, a short review task lands on the
// tech team. Plan reserves that time ahead: open dev-tagged tasks due by the end
// of next week that are NOT assigned to me (mine are already in my list). ONE
// team-task query (no assignee filter: everything this token can see, up to 3
// pages), cached 30 minutes in storage, never while ClickUp asks us to back off,
// one build at a time; only when Plan is open.
const DEV_TAG = "dev";
const DEV_TTL_MS = 30 * 60000;
let devBuild = null;
async function getDevPipeline(force) {
  const { devPipeline } = await chrome.storage.local.get("devPipeline");
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, reason: "not-configured", data: devPipeline || null };
  const mine = devPipeline && String(devPipeline.userId) === String(cfg.userId) ? devPipeline : null;
  if (mine && Date.now() - (mine.at || 0) < (force ? 5 * 60000 : DEV_TTL_MS)) return { ok: true, data: mine };
  const cst = await getClickupState().catch(() => null);
  if (cst && cst.rateLimitedUntil > Date.now()) return { ok: true, data: mine, busy: true };
  if (!devBuild) devBuild = (async () => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    end.setDate(end.getDate() + ((7 - end.getDay()) % 7) + 7); // Sunday after next
    const raw = [];
    for (let page = 0; page < 3; page++) {
      const url = "https://api.clickup.com/api/v2/team/" + encodeURIComponent(cfg.teamId) + "/task?page=" + page +
        "&subtasks=true&include_closed=false&tags[]=" + encodeURIComponent(DEV_TAG) + "&due_date_lt=" + end.getTime();
      const res = await cuRawFetch(cfg.token, url, { headers: { Authorization: cfg.token } });
      if (!res.ok) { if (page === 0) throw new Error(res.status === 429 ? "ClickUp rate limit" : "ClickUp HTTP " + res.status); break; }
      const j = await res.json().catch(() => null);
      const batch = j && Array.isArray(j.tasks) ? j.tasks : [];
      raw.push(...batch);
      if (batch.length < 100 || j.last_page === true) break;
    }
    const me = String(cfg.userId);
    const tasks = raw.filter((x) => x && !isTaskDone(x) && !(Array.isArray(x.assignees) && x.assignees.some((a) => String(a && a.id) === me))).map((x) => ({
      id: String(x.id), name: x.name || "(untitled task)", url: taskUrlFor(x.id),
      dueDateMs: Number(x.due_date) || 0, startDateMs: Number(x.start_date) || 0, estimateMs: Number(x.time_estimate) || 0,
      status: (x.status && x.status.status) || "", container: taskContainer(x),
      assignees: (Array.isArray(x.assignees) ? x.assignees : []).map((a) => String((a && (a.username || a.email)) || "").trim()).filter(Boolean),
    }));
    const settings = await getSettings().catch(() => ({}));
    const holder = { tasks };
    await annotateClients(cfg.token, holder, settings.cuClientLevel || "auto").catch(() => {});
    const data = { at: Date.now(), userId: me, tag: DEV_TAG, tasks: (holder.tasks || tasks).map((x) => { const { container, ...rest } = x; return { ...rest, client: x.client || "" }; }) };
    await chrome.storage.local.set({ devPipeline: data });
    return data;
  })().finally(() => { devBuild = null; });
  try { return { ok: true, data: await devBuild }; }
  catch (e) { return { ok: !!mine, data: mine, error: String(e && e.message ? e.message : e) }; }
}
// ---------- Smart search: "tasks I completed last month for Acme Dental" ----------
// The search box turns a sentence into { assignee, mode, fromTs, toTs, client }
// and asks here: ONE filtered team-task query (ClickUp does the person + date
// filtering), up to 5 pages, then the client is matched on our side. Someone
// else's tasks use the workspace Admin token when one is saved (same rule as the
// Filter card). Cached 3 minutes per question; skipped while ClickUp asks us to
// back off.
const smartCache = new Map();
async function smartTaskSearch(q) {
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, error: "Connect ClickUp first." };
  const who = cuScopeKey(cfg.userId, q.assignee);
  const isMe = who === String(cfg.userId);
  const token = cuScopeToken(cfg, cfg.userId, who);
  const mode = q.mode === "done" ? "done" : q.mode === "any" ? "any" : "due";
  const fromTs = Number(q.fromTs) || 0, toTs = Number(q.toTs) || 0;
  const key = [who, mode, fromTs, toTs].join("|");
  const hit = smartCache.get(key);
  let rows;
  if (hit && Date.now() - hit.at < 3 * 60000) rows = hit.rows;
  else {
    const cst = await getClickupState().catch(() => null);
    if (cst && cst.rateLimitedUntil > Date.now()) return { ok: false, error: "ClickUp asked us to slow down - try again in a minute." };
    const params = ["subtasks=true", "assignees[]=" + encodeURIComponent(who), "include_closed=" + (mode === "due" ? "false" : "true")];
    if (mode === "done") { if (fromTs) params.push("date_done_gt=" + (fromTs - 1)); if (toTs) params.push("date_done_lt=" + (toTs + 1)); }
    else { if (fromTs) params.push("due_date_gt=" + (fromTs - 1)); if (toTs) params.push("due_date_lt=" + (toTs + 1)); }
    const raw = [];
    for (let page = 0; page < 5; page++) {
      const res = await cuRawFetch(token, "https://api.clickup.com/api/v2/team/" + encodeURIComponent(cfg.teamId) + "/task?page=" + page + "&" + params.join("&"), { headers: { Authorization: token } });
      if (res.status === 429) { if (page === 0) return { ok: false, error: "ClickUp rate limit - try again in a minute." }; break; }
      if (!res.ok) { if (page === 0) return { ok: false, error: "ClickUp HTTP " + res.status }; break; }
      const j = await res.json().catch(() => null);
      const batch = j && Array.isArray(j.tasks) ? j.tasks : [];
      raw.push(...batch);
      if (batch.length < 100 || j.last_page === true) break;
    }
    rows = raw.filter((x) => x && (mode !== "done" || isTaskDone(x))).map((x) => ({
      id: String(x.id), name: x.name || "(untitled task)", url: taskUrlFor(x.id),
      status: (x.status && x.status.status) || "", done: isTaskDone(x), priority: cuPriorityName(x),
      dueDateMs: Number(x.due_date) || 0, doneAt: Number(x.date_done || x.date_closed) || 0,
      estimateMs: Number(x.time_estimate) || 0, spentMs: Number(x.time_spent) || 0,
      container: taskContainer(x), assignee: cuTaskAssigneeName(x),
    }));
    const settings = await getSettings().catch(() => ({}));
    const holder = { tasks: rows };
    await annotateClients(token, holder, settings.cuClientLevel || "auto").catch(() => {});
    rows = (holder.tasks || rows).map((x) => { const { container, ...rest } = x; return { ...rest, client: x.client || "" }; });
    smartCache.set(key, { at: Date.now(), rows });
    if (smartCache.size > 30) smartCache.delete(smartCache.keys().next().value);
  }
  const ck = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const want = ck(q.client);
  const tasks = want ? rows.filter((x) => ck(x.client).includes(want) || (want.length >= 5 && want.includes(ck(x.client)) && ck(x.client).length >= 4)) : rows;
  return { ok: true, tasks, isMe, viaAdmin: !isMe && !!(cfg.adminToken && String(cfg.adminToken).trim()), total: rows.length };
}
async function getOpenTasks(cfg, force, tag, assignee) {
  const tagKey = String(tag || "").trim().toLowerCase();
  const whoKey = cuScopeKey(cfg.userId, assignee);
  const isMe = whoKey === String(cfg.userId == null ? "" : cfg.userId);
  // Reading someone else's tasks needs a token that can see them. The SAME rule
  // the Filter card already follows (computeFilterData): the personal token for
  // your own scope, the optional workspace Admin token for anybody else's - a
  // plain member's personal token simply won't return them, which is correct.
  const token = cuScopeToken(cfg, cfg.userId, assignee);
  if (!force && openTasksCache && openTasksCache.tag === tagKey && openTasksCache.who === whoKey && Date.now() - openTasksCache.at < 3 * 60000) {
    return { ok: true, data: openTasksCache.data };
  }
  const raw = [];
  for (let page = 0; page < 6; page++) {
    const url = cuOpenTasksUrl(cfg.teamId, { page, assignee: whoKey, tag: tagKey });
    const res = await cuRawFetch(token, url, { headers: { Authorization: token } });
    if (res.status === 429) { if (page === 0) throw new Error("ClickUp rate limit - try again in a minute"); break; }
    if (!res.ok) { if (page === 0) throw new Error("ClickUp HTTP " + res.status); break; }
    const j = await res.json().catch(() => null);
    const batch = j && Array.isArray(j.tasks) ? j.tasks : [];
    raw.push(...batch);
    if (batch.length < 100 || j.last_page === true) break;
  }
  const settings = await getSettings().catch(() => ({}));
  const tasks = raw.filter((t) => !isTaskDone(t)).map((t) => {
    const est = Number(t.time_estimate) || 0;
    return {
      id: t.id, name: t.name || "(untitled task)", url: taskUrlFor(t.id),
      estimateMs: est, spentMs: Number(t.time_spent) || 0,
      startDateMs: Number(t.start_date) || null, dueDateMs: Number(t.due_date) || null,
      status: (t.status && t.status.status) || "", priority: cuPriorityName(t),
      done: false, container: taskContainer(t), isSubtask: !!t.parent, parentId: t.parent || undefined,
      // Tag names, so the Bulk edit tab can suggest the tags in play and the
      // rows can show which one matched.
      tags: (Array.isArray(t.tags) ? t.tags : []).map((x) => String((x && (x.name || x)) || "").trim()).filter(Boolean),
      // Who owns it, so a batch on someone else's work can say so out loud.
      assignee: cuTaskAssigneeName(t),
      // How many people share it - Insights > Plan reads a dev-tagged task shared
      // with a developer as "my part is the review", not its whole estimate.
      assigneeCount: Array.isArray(t.assignees) ? t.assignees.length : 0,
      // What it waits on (ClickUp dependencies) - Insights > Plan orders by it.
      dependsOn: (Array.isArray(t.dependencies) ? t.dependencies : []).filter((d) => d && String(d.task_id) === String(t.id) && d.depends_on).map((d) => String(d.depends_on)),
      // When ClickUp last changed it (a new comment counts) - Unread comments rechecks those first.
      updatedMs: Number(t.date_updated) || 0,
    };
  });
  const data = { tasks, deadlineTasks: [], trackedTasks: [] };
  await annotateClients(token, data, settings.cuClientLevel || "auto").catch(() => {});
  openTasksCache = { at: Date.now(), data, tag: tagKey, who: whoKey };
  return { ok: true, data };
}
// The open-task query, as a pure URL builder so the scope (whose tasks) and the
// tag filter are pinned down by a test instead of by reading string concatenation.
function cuOpenTasksUrl(teamId, { page = 0, assignee, tag } = {}) {
  return "https://api.clickup.com/api/v2/team/" + encodeURIComponent(teamId) + "/task?page=" + encodeURIComponent(page) +
    "&subtasks=true&include_closed=false&assignees[]=" + encodeURIComponent(assignee || "") +
    (tag ? "&tags[]=" + encodeURIComponent(tag) : "");
}
// "Whose tasks" scope key: empty / missing means ME. Returns the user id to ask
// ClickUp for, so "me" and an explicit own-id are the same query.
function cuScopeKey(myId, assignee) {
  const want = String(assignee == null ? "" : assignee).trim();
  if (!want || want === "__all__") return String(myId == null ? "" : myId);
  return want;
}
// A task's first assignee, as a name ("" when it has none). Cheap: the task
// object already carries the assignees.
function cuTaskAssigneeName(t) {
  const a = Array.isArray(t && t.assignees) ? t.assignees[0] : null;
  return String((a && (a.username || a.email || a.name)) || "").trim();
}
// Can this token look at OTHER people's tasks? ClickUp's own rule is workspace
// role, and the roster carries it when the endpoint said (1 owner, 2 admin,
// 3 member, 4 guest). Only those two privileged roles grant it. Returns true
// (owner/admin), false (a role that is definitely not privileged), or null when
// ClickUp didn't say - and null must NOT be read as "no": we then offer the
// picker and let ClickUp answer, because guessing would hide a feature from an
// admin whose roster came back without roles.
function cuCanScopeOthers(members, myId) {
  const me = String(myId == null ? "" : myId);
  const entry = (Array.isArray(members) ? members : []).find((m) => m && String(m.id) === me);
  if (!entry || entry.role == null || entry.role === "") return null;
  const n = Number(typeof entry.role === "object" ? entry.role.id : entry.role);
  if (!Number.isFinite(n)) return null; // unreadable, so unknown - never a silent yes
  return n === 1 || n === 2;
}
// ...and the picker's gate, as ONE pure decision. A saved Admin API token is the
// owner telling us they have workspace-level access, so it unlocks the picker
// even when the roster's role for them reads as a plain member (the role probe
// can silently fall back to team visibility and say "member"). No token, no
// override: the role stands, and "unknown" stays unknown.
function cuScopeGate(roleVerdict, adminToken) {
  if (typeof adminToken === "string" && adminToken.trim()) return true;
  return roleVerdict;
}
// Which token does a scope need? MY tasks always use the personal token.
// Somebody else's need the optional workspace Admin token - a personal token
// cannot read or edit another person's task - falling back to the personal one,
// which already works when that person is an owner/admin. ONE place, because
// this choice used to be written out by hand in three spots and the write path
// kept using the personal token after the read path had moved. No token value
// ever leaves the background.
function cuScopeToken(cfg, myId, assignee) {
  const me = String(myId == null ? "" : myId);
  const admin = cfg && typeof cfg.adminToken === "string" ? cfg.adminToken.trim() : "";
  return cuScopeKey(me, assignee) !== me && admin ? admin : String((cfg && cfg.token) || "");
}
let doneTodayCache = null; // wrap-up's "closed today" list, kept one minute
// Every task you closed today, with its client and the links in its description:
// { ok, tasks } or { ok: false, reason | error }. maxAgeMs: how old a kept copy may be.
// ---------- Daily Tasks Update to Slack ----------
// The wrap-up page's Send button, or by itself on weekdays at a set time
// (settings dailyUpdateAuto / dailyUpdateTime): the update is POSTED in the team's
// #daily-task-update channel as the user, through the Slack sign-in the extension
// already has (Clients › Slack). storage dailyUpdateSent { day, at, link, channel,
// how } - so the scheduled send never posts twice in a day; dailyUpdateDraft
// { day, text } - the page's edited text, which the scheduled send uses that day.
const DAILY_UPDATE_CHANNEL = "daily-task-update";
const ymdLocal = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
async function dailyUpdateChannel(s) {
  const want = String((await getSettings()).dailyUpdateChannel || DAILY_UPDATE_CHANNEL).replace(/^#/, "").trim().toLowerCase();
  const { dailyUpdateChan: c } = await chrome.storage.local.get("dailyUpdateChan");
  if (c && c.id && c.name === want && c.team === s.team) return c;
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const r = await slackApi("conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) }, s);
    if (!r || !r.ok) throw new Error((r && r.error) || "no answer from Slack");
    const hit = (r.channels || []).find((x) => String(x.name || "").toLowerCase() === want);
    if (hit) { const v = { id: hit.id, name: want, team: s.team }; await chrome.storage.local.set({ dailyUpdateChan: v }); return v; }
    cursor = (r.response_metadata && r.response_metadata.next_cursor) || "";
    if (!cursor) break;
  }
  return null;
}
async function sendDailyUpdate(text, how) {
  const { slackSession: s } = await chrome.storage.local.get("slackSession");
  if (!s) return { ok: false, error: "Connect Slack first (Clients \u203A Slack channels \u203A Connect)." };
  const t = String(text || "").trim();
  if (!t) return { ok: false, error: "There's nothing to send." };
  let ch;
  try { ch = await dailyUpdateChannel(s); } catch (e) { return { ok: false, error: SLACK_AUTH_ERR.test(String(e && e.message)) ? "Slack signed you out - open Slack in Chrome and press Reconnect (Clients)." : "Couldn't reach Slack (" + String((e && e.message) || e) + ")." }; }
  if (!ch) return { ok: false, error: "Couldn't find #" + String((await getSettings()).dailyUpdateChannel || DAILY_UPDATE_CHANNEL).replace(/^#/, "") + " in your Slack - join the channel, then try again." };
  const r = await slackApi("chat.postMessage", { channel: ch.id, text: PcmDailyUpdate.forSlack(t), mrkdwn: "true", unfurl_links: "false", unfurl_media: "false" }, s).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r || !r.ok) {
    const err = String((r && r.error) || "no answer");
    return { ok: false, error: err === "not_in_channel" ? "You're not in #" + ch.name + " - join it in Slack, then try again."
      : SLACK_AUTH_ERR.test(err) ? "Slack signed you out - open Slack in Chrome and press Reconnect (Clients)." : "Slack said: " + err };
  }
  const sent = { day: ymdLocal(Date.now()), at: Date.now(), channel: ch.name, link: "https://" + (s.domain || "slack.com") + "/archives/" + ch.id + "/p" + String(r.ts || "").replace(".", ""), how: how || "button" };
  await chrome.storage.local.set({ dailyUpdateSent: sent });
  return { ok: true, ...sent };
}
// Every minute (the main tick): on a weekday that isn't a company holiday, once
// the set time has passed and nothing was sent today, send it - the text edited
// on the wrap-up page today if any, else today's completed tasks. Nothing
// completed: not sent (said once). A failure is tried again 15 minutes later, at
// most 3 times a day, and said once.
async function maybeAutoDailyUpdate() {
  // Per computer (storage dailyUpdateAuto { on, time }), not in the synced settings:
  // the same person on two computers mustn't post it twice.
  const { dailyUpdateAuto: au } = await chrome.storage.local.get("dailyUpdateAuto");
  const set = { dailyUpdateAuto: !!(au && au.on), dailyUpdateTime: (au && au.time) || "17:30" };
  if (!set.dailyUpdateAuto) return;
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return;
  try { if (isCompanyHoliday(now.getTime())) return; } catch (e) {}
  const [h, m] = String(set.dailyUpdateTime || "17:30").split(":").map(Number);
  const due = new Date(now); due.setHours(Number.isFinite(h) ? h : 17, Number.isFinite(m) ? m : 30, 0, 0);
  if (now < due) return;
  const day = ymdLocal(now.getTime());
  const g = await chrome.storage.local.get(["dailyUpdateSent", "dailyUpdateTry", "dailyUpdateDraft", "slackSession"]);
  if (g.dailyUpdateSent && g.dailyUpdateSent.day === day) return;
  const tr = g.dailyUpdateTry && g.dailyUpdateTry.day === day ? g.dailyUpdateTry : { day, n: 0, at: 0 };
  if (tr.n >= 3 || Date.now() - tr.at < 15 * 60000) return;
  const next = { day, n: tr.n + 1, at: Date.now() };
  await chrome.storage.local.set({ dailyUpdateTry: next });
  let text = g.dailyUpdateDraft && g.dailyUpdateDraft.day === day ? String(g.dailyUpdateDraft.text || "") : "";
  if (/Couldn't load today's completed tasks|Loading the tasks you completed today/.test(text)) text = ""; // never post an error / loading line
  if (!text) {
    const d = await getDoneToday(true).catch(() => null);
    if (!d || !d.ok) { if (next.n >= 3) await notify("daily-update", "Daily update not sent", "Couldn't read today's completed tasks from ClickUp. Open Wrap up the day and press Send.", undefined, chrome.runtime.getURL("wrapup.html")).catch(() => {}); return; }
    if (!(d.tasks || []).some((t) => !PcmDailyUpdate.isExtra(t))) {
      await chrome.storage.local.set({ dailyUpdateSent: { day, at: Date.now(), skipped: "nothing completed", how: "auto" } });
      await notify("daily-update", "Daily update not sent", "No tasks were completed today, so nothing was posted in #" + DAILY_UPDATE_CHANNEL + ".", undefined, chrome.runtime.getURL("wrapup.html")).catch(() => {});
      return;
    }
    text = PcmDailyUpdate.build(d.tasks || [], {});
  }
  const r = await sendDailyUpdate(text, "auto");
  if (r.ok) await notify("daily-update", "Daily update sent \u2713", "Posted in #" + r.channel + " at " + new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ".", undefined, r.link).catch(() => {});
  else if (next.n >= 3 || !g.slackSession) await notify("daily-update", "Daily update not sent", r.error + " Open Wrap up the day to send it.", undefined, chrome.runtime.getURL("wrapup.html")).catch(() => {});
}
// ---------- Automation › Check out in Slack ----------
// Only while the Automation tab is switched on (storage automationTab): on
// weekdays (not company holidays) at the set time, post the text ("out") in
// #rmt-check-in-check-out as the user - once a day, only on a day they worked
// (time tracked today or at the computer today), and only within 2 hours of the
// time (a late "out" after the computer slept through it would look odd).
// storage slackOut { on, time "HH:MM", text, channel }, slackOutSent { day, at, link, channel }, slackOutTry.
const SLACK_OUT_CHANNEL = "rmt-check-in-check-out";
async function slackChannelIdByName(s, name) {
  const want = String(name || "").replace(/^#/, "").trim().toLowerCase();
  if (!want) return null;
  const { slackChanIds } = await chrome.storage.local.get("slackChanIds");
  const ids = { ...(slackChanIds || {}) }, key = s.team + ":" + want;
  if (ids[key]) return { id: ids[key], name: want };
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const r = await slackApi("conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) }, s);
    if (!r || !r.ok) throw new Error((r && r.error) || "no answer from Slack");
    const hit = (r.channels || []).find((x) => String(x.name || "").toLowerCase() === want);
    if (hit) { ids[key] = hit.id; await chrome.storage.local.set({ slackChanIds: ids }); return { id: hit.id, name: want }; }
    cursor = (r.response_metadata && r.response_metadata.next_cursor) || "";
    if (!cursor) break;
  }
  return null;
}
// The two posts share one schedule (storage slackOut): kind "out" = check-out
// { on, time, text }, kind "in" = check-in { inOn, inTime, inText }; days [0-6]
// (default Mon-Fri) or mode "dates" with dates ["YYYY-MM-DD"]; skipHolidays
// (default on). slackOutSent / slackInSent { day, at, link, channel, text, how }.
const SLACK_IN_OUT = {
  out: { on: "on", time: "time", text: "text", defTime: "17:00", defText: "out", sent: "slackOutSent", tries: "slackOutTry" },
  in: { on: "inOn", time: "inTime", text: "inText", defTime: "08:00", defText: "in", sent: "slackInSent", tries: "slackInTry" },
};
// Is today one of the chosen days (mode "days", default Mon-Fri) or dates (mode "dates")?
function slackDayChosen(cfg, now) {
  if (cfg.mode === "dates") return Array.isArray(cfg.dates) && cfg.dates.includes(ymdLocal(now.getTime()));
  const days = Array.isArray(cfg.days) && cfg.days.length ? cfg.days.map(Number) : [1, 2, 3, 4, 5];
  return days.includes(now.getDay());
}
// ...and not a company holiday, unless that's allowed (skipHolidays false).
function slackInOutDayOk(cfg, now) {
  if (!slackDayChosen(cfg, now)) return false;
  if (cfg.skipHolidays !== false) { try { if (isCompanyHoliday(now.getTime())) return false; } catch (e) {} }
  return true;
}
async function slackOutPost(cfg, how, kind) {
  const k = SLACK_IN_OUT[kind === "in" ? "in" : "out"];
  const { slackSession: s } = await chrome.storage.local.get("slackSession");
  if (!s) return { ok: false, error: "Slack isn't connected (Clients \u203A Slack channels \u203A Connect)." };
  const text = String((cfg && cfg[k.text]) || k.defText).trim().slice(0, 200) || k.defText;
  let ch;
  try { ch = await slackChannelIdByName(s, (cfg && cfg.channel) || SLACK_OUT_CHANNEL); } catch (e) { return { ok: false, error: SLACK_AUTH_ERR.test(String(e && e.message)) ? "Slack signed you out - press Reconnect in Clients." : "Couldn't reach Slack (" + String((e && e.message) || e) + ")." }; }
  if (!ch) return { ok: false, error: "Couldn't find #" + ((cfg && cfg.channel) || SLACK_OUT_CHANNEL) + " in your Slack." };
  const r = await slackApi("chat.postMessage", { channel: ch.id, text: text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }, s).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r || !r.ok) { const err = String((r && r.error) || "no answer"); return { ok: false, error: err === "not_in_channel" ? "You're not in #" + ch.name + "." : SLACK_AUTH_ERR.test(err) ? "Slack signed you out - press Reconnect in Clients." : "Slack said: " + err }; }
  const sent = { day: ymdLocal(Date.now()), at: Date.now(), channel: ch.name, text, how: how || "auto", kind: kind === "in" ? "in" : "out", link: "https://" + (s.domain || "slack.com") + "/archives/" + ch.id + "/p" + String(r.ts || "").replace(".", "") };
  await chrome.storage.local.set({ [k.sent]: sent });
  return { ok: true, ...sent };
}
// One of the two, if it's due: only while the Automation tab is on and it's
// ticked, on a chosen day / date, from its time until 2 hours after, once a day.
// "out" only on a day worked (time tracked or at the computer today); "in" only
// when the computer is in use right now (a check-in nobody is there for is worse
// than none). Retries every 5 minutes, at most 3 times.
async function slackInOutRun(kind) {
  const k = SLACK_IN_OUT[kind];
  const g = await chrome.storage.local.get(["automationTab", "slackOut", k.sent, k.tries, "userActiveAt", "clickupState"]);
  const cfg = g.slackOut || {};
  if (!g.automationTab || !cfg[k.on]) return;
  const now = new Date();
  if (!slackInOutDayOk(cfg, now)) return;
  const [h, m] = String(cfg[k.time] || k.defTime).split(":").map(Number);
  const due = new Date(now); due.setHours(Number.isFinite(h) ? h : 17, Number.isFinite(m) ? m : 0, 0, 0);
  if (now < due || now - due > 2 * 3600000) return;
  const day = ymdLocal(now.getTime());
  if (g[k.sent] && g[k.sent].day === day) return;
  {
    const sa = ((await chrome.storage.local.get("slackAhead")).slackAhead || {})[day + ":" + kind];
    if (sa && !sa.cancelled && sa.postAt <= Date.now()) return; // Slack already posted it today
    if (cfg.ahead && sa) return; // Slack posts it (or it was cancelled)
  }
  const mid = new Date(now).setHours(0, 0, 0, 0);
  const st = g.clickupState || {};
  if (kind === "out" && !((Number(st.at) >= mid && Number(st.spentMs) > 0) || Number(g.userActiveAt) >= mid)) return;
  if (kind === "in" && !(Number(g.userActiveAt) >= Date.now() - 15 * 60000)) return;
  const tr = g[k.tries] && g[k.tries].day === day ? g[k.tries] : { day, n: 0, at: 0 };
  if (tr.n >= 3 || Date.now() - tr.at < 5 * 60000) return;
  const next = { day, n: tr.n + 1, at: Date.now() };
  await chrome.storage.local.set({ [k.tries]: next });
  const r = await slackOutPost(cfg, "auto", kind);
  const word = kind === "in" ? "Checked in" : "Checked out";
  if (r.ok) await notify("slack-" + kind, word + " in Slack \u2713", "Posted \"" + r.text + "\" in #" + r.channel + " at " + new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ".", undefined, r.link).catch(() => {});
  else if (next.n >= 3) await notify("slack-" + kind, "Couldn't " + word.toLowerCase().replace("checked", "check") + " in Slack", r.error, undefined, "https://app.slack.com").catch(() => {});
}
async function maybeSlackCheckOut() {
  await slackAheadSync(false).catch((e) => diagLog("slack ahead", String(e && e.message ? e.message : e)));
  await slackInOutRun("in").catch(() => {});
  await slackInOutRun("out").catch(() => {});
}
// ---- Schedule in Slack ahead (slackOut.ahead, off unless ticked) ----
// Slack's own scheduled messages (chat.scheduleMessage) for the next 7 days of
// check-in / check-out, so they're posted by Slack even when this computer is
// off. Topped up every ~30 minutes while the computer is on, and at once when
// the card changes (SLACK_AHEAD_SYNC). storage slackAhead { "YYYY-MM-DD:in|out":
// { id, channel, postAt, text, kind, day, cancelled? } }: kept so each one can be
// cancelled here (chat.deleteScheduledMessage) or replaced when the time / text /
// days change; one deleted in Slack itself is noticed (chat.scheduledMessages.list)
// and not scheduled again. Off (or the tab hidden, or the message unticked):
// every upcoming one is deleted from Slack.
const SLACK_AHEAD_DAYS = 7;
let slackAheadBusy = false;
function slackAheadWanted(cfg, on, nowMs) {
  const out = {};
  if (!on) return out;
  for (let i = 0; i <= SLACK_AHEAD_DAYS; i++) {
    const d = new Date(nowMs); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + i);
    if (!slackInOutDayOk(cfg, d)) continue;
    for (const kind of ["in", "out"]) {
      const k = SLACK_IN_OUT[kind];
      if (!cfg[k.on]) continue;
      const [h, m] = String(cfg[k.time] || k.defTime).split(":").map(Number);
      const at = new Date(d); at.setHours(Number.isFinite(h) ? h : 8, Number.isFinite(m) ? m : 0, 0, 0);
      if (at.getTime() < nowMs + 2 * 60000) continue; // Slack needs a time in the future
      const text = String(cfg[k.text] || k.defText).trim().slice(0, 200) || k.defText;
      out[ymdLocal(at.getTime()) + ":" + kind] = { postAt: at.getTime(), text, kind, day: ymdLocal(at.getTime()) };
    }
  }
  return out;
}
let slackAheadAgain = false;
async function slackAheadSync(force) {
  if (slackAheadBusy) { if (force) slackAheadAgain = true; return { ok: true, queued: true }; } // done right after the running one
  const g = await chrome.storage.local.get(["automationTab", "slackOut", "slackAhead", "slackAheadAt", "slackSession"]);
  const cfg = g.slackOut || {};
  const have = { ...(g.slackAhead || {}) };
  const on = !!(g.automationTab && cfg.ahead && (cfg.on || cfg.inOn));
  if (!on && !Object.keys(have).length) return { ok: true, list: have };
  if (!force && Date.now() - (Number(g.slackAheadAt) || 0) < 30 * 60000 && on) return { ok: true, list: have };
  const s = g.slackSession;
  if (!s) return { ok: false, error: "Slack isn't connected." };
  slackAheadBusy = true;
  try {
    const now = Date.now();
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let ch = null;
    try { ch = await slackChannelIdByName(s, cfg.channel || SLACK_OUT_CHANNEL); } catch (e) {}
    // What Slack still holds: one deleted there is marked cancelled (not re-made).
    if (ch && Object.values(have).some((x) => x && x.id && !x.cancelled && x.postAt > now)) {
      const r = await slackApi("chat.scheduledMessages.list", { channel: ch.id, limit: "100" }, s).catch(() => null);
      if (r && r.ok) {
        const ids = new Set((r.scheduled_messages || []).map((m) => m.id));
        for (const x of Object.values(have)) if (x && x.id && !x.cancelled && x.postAt > now + 60000 && !ids.has(x.id)) { x.cancelled = true; x.how = "slack"; }
      }
    }
    const want = slackAheadWanted(cfg, on, now);
    const del = async (x) => {
      if (!(x && x.id && x.postAt > now)) return true;
      if (!ch) return false;
      const r = await slackApi("chat.deleteScheduledMessage", { channel: ch.id, scheduled_message_id: x.id }, s).catch(() => null);
      return !!(r && (r.ok || r.error === "invalid_scheduled_message_id"));
    };
    let err = "";
    // Gone from the plan (or changed): delete from Slack.
    for (const [key, x] of Object.entries(have)) {
      if (!x) { delete have[key]; continue; }
      if (x.postAt <= now + 2 * 60000) { if (now - x.postAt > 2 * 86400000) delete have[key]; continue; } // posted, or about to be: left alone (kept 2 days for the list)
      const w = want[key];
      if (x.cancelled) { if (!w) delete have[key]; continue; } // a day cancelled stays cancelled while it's planned
      if (!w || w.postAt !== x.postAt || w.text !== x.text) {
        if (await del(x)) delete have[key];
        else err = "Couldn't remove " + new Date(x.postAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) + " from Slack - it may still be posted (Slack \u203A Drafts & sent \u203A Scheduled).";
        await new Promise((ok) => setTimeout(ok, 300));
      }
    }
    // New ones.
    if (on && ch) {
      for (const [key, w] of Object.entries(want)) {
        if (have[key]) continue; // (also one whose delete failed above: not made twice)
        const r = await slackApi("chat.scheduleMessage", { channel: ch.id, text: esc(w.text), post_at: String(Math.floor(w.postAt / 1000)) }, s).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        if (r && r.ok) have[key] = { id: r.scheduled_message_id, channel: ch.name, ...w };
        else { err = String((r && r.error) || "no answer"); if (SLACK_AUTH_ERR.test(err)) break; }
        await new Promise((ok) => setTimeout(ok, 300));
      }
    } else if (on && !ch) err = "Couldn't find #" + (cfg.channel || SLACK_OUT_CHANNEL) + " in your Slack.";
    await chrome.storage.local.set({ slackAhead: have, slackAheadAt: Date.now(), slackAheadErr: err });
    return { ok: !err, error: err, list: have };
  } finally {
    slackAheadBusy = false;
    if (slackAheadAgain) { slackAheadAgain = false; setTimeout(() => { slackAheadSync(true).catch(() => {}); }, 0); }
  }
}
// Cancel one (✕ on the card): deleted from Slack, marked so it isn't made again.
async function slackAheadCancel(key) {
  const g = await chrome.storage.local.get(["slackAhead", "slackSession", "slackOut"]);
  const have = { ...(g.slackAhead || {}) };
  const x = have[key];
  if (!x) return { ok: false, error: "Not scheduled any more." };
  if (x.postAt <= Date.now()) return { ok: false, error: "Slack has already posted it." };
  if (!x.cancelled && x.id) {
    const s = g.slackSession;
    if (!s) return { ok: false, error: "Slack isn't connected." };
    const ch = await slackChannelIdByName(s, (g.slackOut && g.slackOut.channel) || SLACK_OUT_CHANNEL).catch(() => null);
    const r = ch ? await slackApi("chat.deleteScheduledMessage", { channel: ch.id, scheduled_message_id: x.id }, s).catch(() => null) : null;
    if (!r || (!r.ok && r.error !== "invalid_scheduled_message_id")) return { ok: false, error: "Slack said: " + ((r && r.error) || "no answer") };
  }
  have[key] = { ...x, cancelled: true, how: "here" };
  await chrome.storage.local.set({ slackAhead: have });
  return { ok: true, list: have };
}
// ---------- Automation › Away in Slack ----------
// Only while the Automation tab is on (storage automationTab) and ticked
// (storage slackAway { on, away "HH:MM", active "HH:MM" }): on weekdays from the
// away time on, Slack shows you away (users.setPresence away); on weekdays that
// aren't company holidays, between the active time and the away time, back to
// automatic (active). Each once a day (slackAwayLast { away: day, active: day }),
// so changing it by hand in Slack in between is respected. Untick / hide the tab:
// back to automatic at once (SLACK_AWAY_SET).
async function slackSetPresence(presence) {
  const { slackSession: s } = await chrome.storage.local.get("slackSession");
  if (!s) return { ok: false, error: "Slack isn't connected (Clients \u203A Slack channels \u203A Connect)." };
  const r = await slackApi("users.setPresence", { presence: presence === "away" ? "away" : "auto" }, s).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
  if (!r || !r.ok) { const err = String((r && r.error) || "no answer"); return { ok: false, error: SLACK_AUTH_ERR.test(err) ? "Slack signed you out - press Reconnect in Clients." : "Slack said: " + err }; }
  const now = { presence: presence === "away" ? "away" : "active", at: Date.now() };
  await chrome.storage.local.set({ slackAwayNow: now });
  return { ok: true, ...now };
}
async function maybeSlackPresence() {
  const g = await chrome.storage.local.get(["automationTab", "slackAway", "slackAwayLast"]);
  const cfg = g.slackAway || {};
  if (!g.automationTab || !cfg.on) return;
  const now = new Date();
  if (!slackDayChosen(cfg, now)) return; // a day not chosen keeps the last one (Friday's away lasts the weekend)
  const at = (hhmm, dh) => { const [h, m] = String(hhmm || "").split(":").map(Number); const d = new Date(now); d.setHours(Number.isFinite(h) ? h : dh, Number.isFinite(m) ? m : 0, 0, 0); return d; };
  const awayAt = at(cfg.away || "17:00", 17), activeAt = at(cfg.active || "08:00", 8);
  const day = ymdLocal(now.getTime());
  const last = { ...(g.slackAwayLast || {}) };
  let want = "";
  if (now >= awayAt && last.away !== day) want = "away";
  else if (now >= activeAt && now < awayAt && last.active !== day) {
    let holiday = false;
    if (cfg.skipHolidays !== false) { try { holiday = isCompanyHoliday(now.getTime()); } catch (e) {} }
    if (!holiday) want = "active";
  }
  if (!want) return;
  const tries = last.tries && last.tries.day === day && last.tries.what === want ? last.tries : { day, what: want, n: 0, at: 0 };
  if (tries.n >= 3 || Date.now() - tries.at < 5 * 60000) return;
  tries.n++; tries.at = Date.now();
  const r = await slackSetPresence(want === "away" ? "away" : "auto");
  if (r.ok) { last[want] = day; delete last.tries; }
  else last.tries = tries;
  await chrome.storage.local.set({ slackAwayLast: last });
  if (!r.ok && tries.n >= 3) await notify("slack-away", "Couldn't set your Slack status", r.error, undefined, "https://app.slack.com").catch(() => {});
}
async function getDoneToday(force, maxAgeMs = 60000) {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, reason: "not-configured" };
  const from = new Date().setHours(0, 0, 0, 0);
  if (!force && doneTodayCache && doneTodayCache.day === from && Date.now() - doneTodayCache.at < maxAgeMs) return { ok: true, tasks: doneTodayCache.tasks };
  try {
    const rows = await fetchDoneBetween(cfg.token, cfg.teamId, cfg.userId, from, Date.now());
    // Some subtasks come back without their description: read those one by one
    // (capped; one 429 waits and retries once) so their links aren't lost.
    for (const r of rows.filter((x) => x.needDetail).slice(0, 60)) {
      try {
        let d;
        try { d = await getTaskDetail(cfg.token, r.id); } catch (e) {
          if (!e || e.status !== 429) throw e;
          await new Promise((z) => setTimeout(z, Math.min(8000, Number(e.retryAfterMs) || 3000)));
          d = await getTaskDetail(cfg.token, r.id);
        }
        r.links = d.links || [];
      } catch (e) {}
    }
    const settings = await getSettings();
    await annotateClients(cfg.token, { tasks: rows }, settings.cuClientLevel || "auto");
    const tasks = rows.map((r) => ({ id: r.id, name: r.name, url: r.url, parentId: r.parentId, client: r.client || "", links: r.links || [], doneAt: r.doneAt }));
    doneTodayCache = { day: from, at: Date.now(), tasks };
    return { ok: true, tasks };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Someone was taken off a task: drop them from that task's rows in everything
// already saved (dashboard state + filter / overdue / open-task caches), so the
// lists show it at once with NO ClickUp calls - instead of throwing the caches
// away, which made the next look rebuild every list from ClickUp.
function dropAssigneeIn(node, taskId, userId, depth) {
  if (!node || typeof node !== "object" || depth > 9) return 0;
  let n = 0;
  if (!Array.isArray(node) && String(node.id) === taskId && Array.isArray(node.assignees)) {
    const before = node.assignees.length;
    node.assignees = node.assignees.filter((a) => String(a && a.id) !== userId);
    if (node.assignees.length !== before) { n++; if (typeof node.assigneeCount === "number") node.assigneeCount = node.assignees.length; }
  }
  for (const k in node) { const v = node[k]; if (v && typeof v === "object") n += dropAssigneeIn(v, taskId, userId, depth + 1); }
  return n;
}
// Someone added to a task: put them on every saved copy of it at once (no ClickUp
// calls; the next refresh confirms it).
function addAssigneeIn(node, taskId, person, depth) {
  if (!node || typeof node !== "object" || depth > 9) return 0;
  let n = 0;
  if (!Array.isArray(node) && String(node.id) === taskId && Array.isArray(node.assignees) && !node.assignees.some((a) => String(a && a.id) === person.id)) {
    node.assignees = node.assignees.concat([{ id: person.id, username: person.username }]);
    n++;
    if (typeof node.assigneeCount === "number") node.assigneeCount = node.assignees.length;
  }
  for (const k in node) { const v = node[k]; if (v && typeof v === "object") n += addAssigneeIn(v, taskId, person, depth + 1); }
  return n;
}
async function addAssigneeEverywhere(taskId, person) {
  const id = String(taskId);
  try { const st = await getClickupState(); if (st && addAssigneeIn(st, id, person, 0)) await setClickupState(st); } catch (e) {}
  await hydrateFilterCache();
  for (const v of filterCache.values()) if (v && v.data) addAssigneeIn(v.data, id, person, 0);
  for (const c of [overdueCache, openTasksCache, ...overdueScopeCache.values()]) if (c) addAssigneeIn(c, id, person, 0);
  await persistFilterCache();
}
// ---- Scheduled assignments ("+ Add someone" > ⏰) ----
// storage asgSchedule: [{ id, taskId, taskName, url, userId, name, at, tries, nextTry, done, failed, error }]
// Checked every minute (UPDATE_ALARM), so a time missed while Chrome was closed
// runs as soon as it's open again. ClickUp busy: tried again in 5 minutes, up to 6
// times, then you're told. Finished ones are kept 7 days (shown, then dropped).
const ASG_KEY = "asgSchedule";
let asgRunning = false;
async function runScheduledAssigns() {
  if (asgRunning) return;
  asgRunning = true;
  try {
    const g = await chrome.storage.local.get(ASG_KEY);
    const jobs = Array.isArray(g[ASG_KEY]) ? g[ASG_KEY] : [];
    const now = Date.now();
    const due = jobs.filter((j) => j && !j.done && !j.failed && j.at <= now && (!j.nextTry || j.nextTry <= now));
    const old = jobs.some((j) => j && (j.done || j.failed) && now - (j.done || j.failed) > 7 * 864e5);
    if (!due.length && !old) return;
    const cfg = await getClickupConfig();
    const st = await getClickupState().catch(() => null);
    const busy = !cfg || !cfg.token || (st && st.rateLimitedUntil > now);
    for (const j of busy ? [] : due) {
      try {
        await addTaskAssignee(cfg.token, j.taskId, j.userId);
        j.done = Date.now();
        if (cfg.userId && String(cfg.userId) === String(j.userId)) { clearFilterCache(); refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {}); }
        else await addAssigneeEverywhere(j.taskId, { id: String(j.userId), username: String(j.name || "") });
        await notify("asg-" + j.id, "Assigned as scheduled", (j.name || "They") + " is now on \u201C" + (j.taskName || "the task") + "\u201D in ClickUp.", undefined, j.url || taskUrlFor(j.taskId)).catch(() => {});
      } catch (e) {
        j.tries = (j.tries || 0) + 1;
        j.error = String((e && e.message) || e).slice(0, 200);
        if (j.tries >= 6) {
          j.failed = Date.now();
          await notify("asg-" + j.id, "Couldn't assign " + (j.name || "them"), "\u201C" + (j.taskName || "the task") + "\u201D - ClickUp said: " + j.error + ". Add them from the task row instead.", undefined, j.url || taskUrlFor(j.taskId)).catch(() => {});
        } else j.nextTry = Date.now() + 5 * 60000;
      }
    }
    await chrome.storage.local.set({ [ASG_KEY]: jobs.filter((j) => j && !((j.done || j.failed) && now - (j.done || j.failed) > 7 * 864e5)) });
  } finally { asgRunning = false; }
}
async function dropAssigneeEverywhere(taskId, userId) {
  const id = String(taskId), uid = String(userId);
  let n = 0;
  try {
    const st = await getClickupState();
    if (st && dropAssigneeIn(st, id, uid, 0)) { n++; await setClickupState(st); }
  } catch (e) {}
  await hydrateFilterCache(); // a restarted worker: load the saved lists first so none are lost
  for (const v of filterCache.values()) if (v && v.data) n += dropAssigneeIn(v.data, id, uid, 0);
  for (const c of [overdueCache, openTasksCache, ...overdueScopeCache.values()]) if (c) n += dropAssigneeIn(c, id, uid, 0);
  await persistFilterCache();
  return n;
}
function clearFilterCache() {
  filterCache.clear();
  overdueCache = null;
  overdueScopeCache.clear();
  openTasksCache = null;
  chrome.storage.local.set({ [FILTER_STORE_KEY]: {} }).catch(() => {});
}
hydrateFilterCache();
async function buildRoster(cfg) {
  try {
    const members = await fetchTeamMembers(cfg.token, cfg.teamId, cfg.adminToken);
    const prev = (await getClickupState()) || {};
    const before = Array.isArray(prev.members) ? prev.members.length : 0;
    const note = members && members.length ? null : "No users found in this workspace's accessible tasks.";
    console.log("[ClickUp] member roster:", members ? members.length : 0, " users" + (note ? " - " + note : "") +
      (members && members.length > before ? " (+" + (members.length - before) + " since the last build)" : ""));
    const st = (await getClickupState()) || {};
    // A rebuild that finds FEWER people than we already had is suspicious - a
    // source that was refused usually returns a short list, not the whole
    // workspace. Say so instead of quietly shrinking the picker, because a
    // colleague disappearing is exactly the bug this roster is meant to fix.
    const shrunk = before > 0 && members && members.length < before;
    st.members = members || [];
    st.membersAt = Date.now();
    st.membersNote = note;
    if (shrunk) st.membersWarn = "This read found only " + st.members.length + " of the " + before + " people last time - a ClickUp source was probably refused. Press ↻ to try again.";
    else st.membersWarn = null;
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
  // Agent Router: leave the GitHub accounts signed in (GitHub's account picker
  // chooses the right one) instead of signing out of GitHub before each login.
  ghKeepSignedIn: false,
  arCloseTabs: true, // close each Agent Router tab after a successful login (manual runs too)
  notify: true,
  notifySound: true, // play a chime when any notification/reminder pops up
  notifyVolume: 100, // % loudness of every notification sound (5-100)
  // Bell menu (popup/panel/options): master switch + "Pause 1 hour" (lunch).
  notifyAll: true,
  notifyPausedUntil: 0, // ms timestamp; reminders stay silent until then
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
  clickupExtendedMode: "days", // "days" | "excl0" (legacy - clickupMultiDay decides now)
  // How a multi-day task (start -> due) counts, in EVERY card and filter:
  // "due" = whole estimate on its due date (default), "days" = spread over the
  // working days it covers, "excl0" = spread over the days with time tracked on it.
  clickupMultiDay: "due",
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
  // Background ClickUp sync interval (minutes). One refresh is ~10-40 requests and
  // ClickUp allows ~100/min per token, so 2 is the floor; reminders ride on it.
  clickupSyncMin: 5,
  // Admin tools (publishing a new version). Off by default; the GitHub token it
  // uses is stored encrypted on THIS machine only and never ships in a release.
  showAdmin: false,
  // Include the admin GitHub token in the Drive backup, so a reinstall restores
  // it. Off means the token stays on this computer only.
  adminSyncToken: true,
  // Which days a "week" covers for the Due this week / next week views.
  clickupWeekMode: "sun-sat", // sun-sat | mon-sun | mon-fri | sun-thu
  // ---- Away protection ----
  // Coming back after this long idle/locked while a timer kept running asks
  // "Remove away time / Keep it". Ignoring the question keeps the time.
  clickupAwayNotify: true,
  clickupAwayMin: 15, // minutes, 5-240
  // ---- End-of-day wrap-up ----
  // Weekday notification that opens wrapup.html (leftovers -> tomorrow, standup copy).
  clickupWrapUp: true,
  // ---- Close the weekly Extra Task (see maybeCloseExtraTask) ----
  clickupExtraAutoClose: true,
  clickupWarnEmptyComplete: true,
  clickupOverRepeatMin: 15, // repeat "still over the estimate" every N minutes (0 = once)
  clickupRelatedOn: true, // AI briefs look up related tasks (open and closed)
  clickupRelatedCap: 25, // at most this many related tasks per task
  clickupRelatedIds: "", // extra reference-ID patterns (one per line)
  clickupHolidayHeadsUp: true,
  // ---- Daily "needs tidying" reminder ----
  // One short, actionable summary a day of what the Insights tab flags:
  // overdue, no estimate, no due date, blocked - plus a "dependency resolved,
  // carry on and close it" line. Silent when there's nothing to say, so a clean
  // board never nags.
  clickupTidyNotify: true,
  clickupTidyTime: "14:00", // local "HH:MM"
  clickupTidyDays: "weekdays", // "weekdays" | "every" | "0,3,5" (0 = Sunday)
  clickupTidyMax: 3, // tasks named per line, 1-6
  clickupTidyResolved: true, // "a dependency cleared, this can move again"
  clickupTidyCats: { overdue: true, noEst: true, noDue: true, blocked: true, offDay: true },
  // ---- Updates ----
  // Install new versions automatically in the background (needs the one-time
  // folder choice on the update page, with Chrome's "Allow on every visit").
  autoUpdate: true,
  // Fireworks in the extension's pages when a milestone is reached, and a small
  // pop-up window with them when no extension page is being looked at.
  celebrations: true,
  celebrationWindow: true,
  celebrationSeconds: 3, // how long the animation / pop-up card lasts (1-15)
  // Visual effects (Options > General > Animations and effects).
  fxLiquid: true, fxChart: true, fxCount: true, fxIconRing: true,
  // Floating tracker (tracker.html): the Float button, full view on hover, today's total.
  floatTracker: true, floatAutoOpen: true, floatAutoAnywhere: true, floatHover: true, floatToday: true, floatSize: "slim",
  // Where the timer shows while you track: "float" (the floating window), "taskbar"
  // (the ClickUp Tracker app), "both" or "off". timerPlaceChosen = picked once, kept.
  timerPlace: "float", timerPlaceChosen: false,
  // How the slim floating timer and the taskbar app draw their strip: L (Task | Today), F, H, J or B (battery).
  stripStyle: "B",
  stripAnim: true,
  // Task files: back the files' text up to Drive (hidden app data).
  taskFilesDrive: true,
  clickupWrapUpTime: "16:45", // local "HH:MM"
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
// Escalating backoff per account: 1st failure 1h, then 6h, 24h, and 72h as the
// cap. A flat hour meant a broken account re-attempted the GitHub login every
// 1-1.5h for the life of the install (the scheduler alarm is 30 min), and GitHub
// flags rapid repeated failed sign-ins - it can then reject even a correctly
// typed 2FA code. That is the same risk the 250ms guard before the 2FA submit in
// lib-automation.js exists for. The first rung stays at RETRY_COOLDOWN_MS so a
// genuinely transient failure still recovers as quickly as it always did.
const RETRY_BACKOFF_MS = [RETRY_COOLDOWN_MS, 6 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 72 * 60 * 60 * 1000];
// Notes that mean the stored credentials or config are WRONG, so no amount of
// retrying can help: stop the automatic attempts and wait for a person (a manual
// Run and the "I logged in" button both clear it). Everything else - a closed tab, a
// timeout, a CAPTCHA, an unresponsive page - is transient and keeps retrying on
// the ladder above. Matched as a lowercased SUBSTRING because several of these
// notes are built by template string ("GitHub rejected the credentials: " +
// err.text), so full-string equality would miss them. To add one, put its most
// stable fragment here; nothing else needs to change.
const PERMANENT_FAILURE_NOTES = [
  "github rejected the credentials",
  "2fa code was not accepted",
  "no totp secret saved",
  "totp secret looks invalid",
  "missing its username or password",
];

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
// ---------- Agent Router retry policy (pure helpers) ----------
// How long to wait after the nth consecutive failure (n is 1-based). Anything
// past the end of the ladder stays at the cap; a missing/junk count is treated
// as the first failure, so the wait can never come out as 0.
function retryDelayForFails(n) {
  const i = Math.min(Math.max(1, Math.floor(Number(n) || 0)), RETRY_BACKOFF_MS.length) - 1;
  return RETRY_BACKOFF_MS[i];
}
// Does this note mean the stored sign-in itself is wrong? See
// PERMANENT_FAILURE_NOTES - substring match, because notes are concatenated.
function isPermanentFailure(note) {
  const s = String(note || "").toLowerCase();
  return s !== "" && PERMANENT_FAILURE_NOTES.some((frag) => s.includes(frag));
}
// Earliest moment the daily runner may attempt this account again (0 = no wait).
// Prefers the stamp recordLoginResult wrote; the loginFails fallback covers a
// record written by an older copy of the extension, or merged in from Drive.
function nextAttemptAt(st) {
  const s = st || {};
  const stamped = Number(s.nextAttemptAt) || 0;
  if (stamped > 0) return stamped;
  const fails = Math.max(0, Number(s.loginFails) || 0);
  const ran = Number(s.lastRunAt) || 0;
  return fails > 0 && ran > 0 ? ran + retryDelayForFails(fails) : 0;
}
// What a finished attempt does to the retry bookkeeping. Pure, so recordLoginResult
// just stamps the result. A success wipes the slate clean - including a stop - so an
// account that starts working again needs no intervention.
function retryPatchFor(prev, result, note, now) {
  if (result === "success") return { loginFails: 0, nextAttemptAt: 0, retryStoppedAt: 0 };
  const fails = Math.max(0, Number((prev || {}).loginFails) || 0) + 1;
  // A permanent failure also carries the normal wait, so that clearing the stop
  // on its own can never turn into an immediate re-attempt.
  return {
    loginFails: fails,
    nextAttemptAt: now + retryDelayForFails(fails),
    retryStoppedAt: isPermanentFailure(note) ? now : 0,
  };
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
  // Only for a login made AFTER the window that hasn't been credited yet. A login
  // inside the window (e.g. a manual run) earns nothing and must not push the next
  // run 24h past itself - that silently skipped a whole day (Sep 18 11:12 PM run
  // delayed Sep 19's 7:57 AM credit).
  if (s.lastResult === "success" && s.lastRunAt && now - s.lastRunAt < RESET_MS &&
      s.lastRunAt >= effectiveDoneAt(s) + RESET_MS) return false;
  // The stored sign-in is wrong, so retrying would only pile up failed GitHub
  // attempts. Stop until a person fixes it; a manual Run still works.
  if (Number(s.retryStoppedAt) > 0) return false;
  // Escalating backoff after a failed / needs-attention attempt. Checked on the
  // stamp rather than on lastResult, so a record whose lastResult was cleared
  // (a crashed worker, see clearStaleRunningOnce) still serves out its wait.
  const until = nextAttemptAt(s);
  if (until > 0 && now < until) return false;
  // A record written before the backoff existed carries no counter at all, so keep
  // the old flat one-hour floor for it: an upgrade must not release a burst of
  // retries the previous version was holding back.
  if (!until && s.lastResult && s.lastResult !== "success" && s.lastRunAt && now - s.lastRunAt < RETRY_COOLDOWN_MS)
    return false;
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

// Emit the ONE desktop notification per fresh credit, and ONLY while one of
// Agent Router's quota batches is actually open.
//
// The gate is the whole point. This notification means "you can use Claude now",
// and Agent Router only releases Claude/GPT in two fixed batches (10:00 / 19:00
// Beijing by default, auto-synced by syncArScheduleFromPage). The account's daily
// quota CREDIT is a different event: it lands whenever the daily auto-login
// happens to run. Because this function was also called from the 5-minute
// balance poll, a credit detected at 8:31 PM announced "a fresh batch just
// opened" - which was simply false, and is the bug the owner reported.
//
// Off-window the credit is left PENDING (notified is deliberately NOT stamped),
// so it is announced at the next real batch instead of being dropped. One toast
// per credit either way, never more often than before, and never a false claim.
// Returns why it stayed quiet, so dev-tools/t_ar_batch.js can read the decision.
async function maybeNotifyQuotaCredit(nowMs = Date.now()) {
  const settings = await getSettings();
  if (settings.arQuotaNotify === false) return { notified: false, why: "turned-off" };
  const win = arBatchWindow(settings.arQuotaTimes, nowMs);
  if (!win.open) return { notified: false, why: "outside-batch-window" };
  const credits = await getCredits();
  const accounts = (await getAccounts()).filter(a => effectiveMode(a, settings) !== "off");
  let anyNew = false;
  for (const a of accounts) {
    const r = credits[a.id];
    if (!r || !r.lastCreditAt) continue;
    if (r.lastCreditAt > (r.notified || 0)) { anyNew = true; break; }
  }
  if (!anyNew) return { notified: false, why: "no-fresh-credit" };
  // The batch time in the reader's OWN clock - the schedule is Beijing, the
  // person reading the toast is not. The id must keep its ar-quota- prefix:
  // that is what routes a click to Agent Router in notifications.onClicked.
  const when = new Date(win.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  // Only claim Claude when Agent Router actually offers it to this account.
  const { arStatus: ars = null } = typeof chrome !== "undefined" && chrome.storage ? await chrome.storage.local.get("arStatus").catch(() => ({})) : {};
  const noClaude = !!(ars && Array.isArray(ars.usable) && ars.usable.length && !ars.claude);
  await notify(
    "ar-quota-credit-" + nowMs,
    "Agent Router - the " + when + " batch is open 🚀",
    noClaude
      ? "Your fresh quota is in. Usable now: " + ars.usable.join(", ") + " - no Claude for your account at the moment."
      : "Claude and GPT are usable now, and your fresh quota is in. Click to jump in before it runs out."
  );
  // Stamp with the SAME clock the decision used, and never behind the credit
  // being acknowledged. Reading Date.now() here instead let the stamp land
  // EARLIER than lastCreditAt whenever the clock had moved backwards - a laptop
  // waking with a stale clock, which is exactly what caused the wake-up
  // notification burst - and then lastCreditAt > notified was still true, so the
  // very same credit was announced again on the next poll. Caught by
  // dev-tools/t_ar_batch.js.
  for (const a of accounts) {
    const r = credits[a.id];
    if (r && r.lastCreditAt > (r.notified || 0)) r.notified = Math.max(nowMs, r.lastCreditAt);
  }
  await setCredits(credits);
  return { notified: true, why: "batch-open", at: win.at, hhmm: win.hhmm };
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
        if (d.group) chrome.storage.local.set({ arUserGroup: String(d.group) }).catch(() => {}); // which models it may use (arReadStatus)
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
    // Announce a fresh credit if (and only if) a quota batch is open right now -
    // the poll runs every 5 minutes, so this is also the catch-up path when the
    // batch alarm was missed or Agent Router credited a little late. Off-window
    // it is a no-op and the credit waits for the next batch.
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
  await chrome.storage.local.remove(["clickupEnc", "clickupState", "clickupNotified", "insOpenCache", "perfHistory", "devPipeline"]);
}

// Push accounts AND the ClickUp config (encrypted token etc.) together so a new
// machine signed in with the same Google account gets both.
async function pushAllToDrive(tok, accounts) {
  const ccfg = await getClickupConfig().catch(() => null);
  const settings = await getSettings().catch(() => null);
  const departments = (settings && Array.isArray(settings.clickupDepartments)) ? settings.clickupDepartments : null;
  let admin = null;
  if (!settings || settings.adminSyncToken !== false) {
    const { adminEnc } = await chrome.storage.local.get("adminEnc");
    const saved = await decryptJSON(adminEnc, null);
    if (saved && saved.token) admin = { token: saved.token };
  }
  await pushAccountsToDrive(tok, accounts, ccfg && ccfg.token ? ccfg : null, departments, settings, await collectExtras(), admin);
}

// ---------- Drive "extras": local-only data that must survive a reinstall ----------
// Each key carries its own "last changed" stamp (extrasStamps) so the newest copy
// wins per key: a fresh install adopts the Drive copy, while a newer local edit is
// never overwritten by an older remote one.
const EXTRA_KEYS = ["autoRules", "siteMonitorConfig", "theme", "cuFilter", "cuFilterMode", "cuFilterDefault", "customSounds", "cuManualOrder", "siteDirSeen", "reminders", "clientNotes", "taskNotes", "taskPins", "planOverrides", "localTasks", "cuDupesOk"];
const EXTRAS_MAX_SOUNDS = 1500000; // skip very large custom-sound files in the Drive copy
async function collectExtras() {
  const got = await chrome.storage.local.get([...EXTRA_KEYS, "extrasStamps"]);
  const stamps = (got.extrasStamps && typeof got.extrasStamps === "object") ? got.extrasStamps : {};
  const values = {};
  const outStamps = {};
  for (const k of EXTRA_KEYS) {
    if (got[k] === undefined) continue;
    if (k === "customSounds" && JSON.stringify(got[k]).length > EXTRAS_MAX_SOUNDS) continue;
    values[k] = got[k];
    outStamps[k] = Number(stamps[k]) || 0;
  }
  return { values, stamps: outStamps };
}
// Restore the publishing token from Drive when this machine has none (after a
// reinstall, or on a second computer). A token already here always wins.
async function adoptRemoteAdmin(remote) {
  if (!remote || !remote.token) return;
  const s = await getSettings().catch(() => ({}));
  if (s.adminSyncToken === false) return;
  const { adminEnc } = await chrome.storage.local.get("adminEnc");
  const local = await decryptJSON(adminEnc, null);
  if (local && local.token) return;
  await chrome.storage.local.set({ adminEnc: await encryptJSON({ token: remote.token }) });
}
async function adoptRemoteExtras(remote) {
  if (!remote || !remote.values || typeof remote.values !== "object") return;
  const got = await chrome.storage.local.get([...EXTRA_KEYS, "extrasStamps"]);
  const stamps = { ...((got.extrasStamps && typeof got.extrasStamps === "object") ? got.extrasStamps : {}) };
  const patch = {};
  for (const k of EXTRA_KEYS) {
    if (!(k in remote.values)) continue;
    const rAt = Number(remote.stamps && remote.stamps[k]) || 0;
    const lAt = Number(stamps[k]) || 0;
    // Take the remote when it's newer, or when this machine has nothing for the key.
    if (rAt > lAt || got[k] === undefined) {
      patch[k] = remote.values[k];
      stamps[k] = Math.max(rAt, lAt);
    }
  }
  if (!Object.keys(patch).length) return;
  patch.extrasStamps = stamps; // same write, so the change listener doesn't re-stamp it
  await chrome.storage.local.set(patch);
  if (patch.siteMonitorConfig) {
    const c = patch.siteMonitorConfig;
    if (c && c.enabled && Array.isArray(c.sites) && c.sites.length) await ensureAlarm(SITE_MONITOR_ALARM, { periodInMinutes: SITE_MONITOR_PERIOD_MIN });
  }
}
// Stamp local edits, then push to Drive shortly after (not just every 15 min).
let extrasPushTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || changes.extrasStamps) return;
  const keys = EXTRA_KEYS.filter((k) => changes[k]);
  if (!keys.length) return;
  (async () => {
    const { extrasStamps } = await chrome.storage.local.get("extrasStamps");
    const stamps = { ...((extrasStamps && typeof extrasStamps === "object") ? extrasStamps : {}) };
    for (const k of keys) stamps[k] = Date.now();
    await chrome.storage.local.set({ extrasStamps: stamps });
    clearTimeout(extrasPushTimer);
    extrasPushTimer = setTimeout(() => { autoSyncIfSignedIn({ light: true }); }, 4000);
  })().catch(() => {});
});

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
async function syncNow({ light = false } = {}) {
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
    if (remote) await adoptRemoteExtras(remote.extras);
    if (remote) await adoptRemoteAdmin(remote.admin);
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
    const ccfg = light ? null : await getClickupConfig().catch(() => null);
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
  // The self-made departments were cleared for ClickUp's own Teams (v4.1.3): an
  // older Drive copy must not bring them back.
  if (settings && settings.deptsCleared) return;
  const local = (settings && Array.isArray(settings.clickupDepartments)) ? settings.clickupDepartments : [];
  if (local.length) return;
  await setSettings({ clickupDepartments: remoteDepartments }).catch(() => {});
}
// ---- Departments = ClickUp's own Teams + any the person made themselves ----
// Teams are read from ClickUp at most every 12 hours (one request), cached in
// storage (cuGroups). Self-made departments (settings.clickupDepartments) were
// cleared once for everyone in v4.1.3 (deptsCleared); new ones can still be made.
const CU_GROUPS_TTL = 12 * 3600000;
async function clickupGroups(cfg, force) {
  const { cuGroups } = await chrome.storage.local.get("cuGroups");
  const fresh = cuGroups && cuGroups.teamId === String(cfg && cfg.teamId) && Date.now() - (cuGroups.at || 0) < (cuGroups.failed ? 3600000 : CU_GROUPS_TTL);
  if (!force && fresh) return cuGroups.list || [];
  if (!cfg || !cfg.token || !cfg.teamId) return (cuGroups && cuGroups.list) || [];
  try {
    const list = await getUserGroups(cfg.token, cfg.teamId);
    await chrome.storage.local.set({ cuGroups: { at: Date.now(), teamId: String(cfg.teamId), list } });
    return list;
  } catch (e) {
    await chrome.storage.local.set({ cuGroups: { ...(cuGroups || {}), at: Date.now(), teamId: String(cfg.teamId), failed: String(e && e.message ? e.message : e).slice(0, 200), list: (cuGroups && cuGroups.list) || [] } });
    return (cuGroups && cuGroups.list) || [];
  }
}
async function allDepartments(cfg, settings, force) {
  const groups = await clickupGroups(cfg, force).catch(() => []);
  const own = (Array.isArray(settings && settings.clickupDepartments) ? settings.clickupDepartments : []).filter((d) => d && !String(d.id || "").startsWith("cu:"));
  return groups.concat(own);
}
async function clearOwnDepartmentsOnce() {
  const s = await getSettings().catch(() => null);
  if (!s || s.deptsCleared) return;
  await setSettings({ clickupDepartments: [], deptsCleared: Date.now() }).catch(() => {});
}
clearOwnDepartmentsOnce().catch(() => {});
async function getClickupState() {
  const { clickupState } = await chrome.storage.local.get("clickupState");
  return clickupState && typeof clickupState === "object" ? clickupState : null;
}
async function setClickupState(state) {
  await chrome.storage.local.set({ clickupState: state });
  updateBadge().catch(() => {});
  maybeAutoFloat(state).catch((e) => diagLog("auto-float", String(e && e.message ? e.message : e)));
  return state;
}

// ---------- floating tracker: open it by itself when a timer starts ----------
// Chrome opens a floating window only during a REAL click on the page that
// hosts it. A click made by a script (like Agent Router's) doesn't count; one
// sent through the debugger does. So when a timer is found running that hasn't
// been floated yet - started in the popup, in ClickUp, with the shortcut - the
// background opens the pinned Tracker tab without switching to it, clicks it
// once through the debugger and lets go straight away (Chrome shows its
// "started debugging this browser" bar for that moment). Each timer is floated
// at most once: closing the window keeps it closed until the next timer.
// Setting: floatAutoAnywhere (General › Floating tracker).
let autoFloatBusy = false;
const floatRunKey = (r) => (r && r.taskId ? String(r.taskId) + ":" + String(r.startMs || "") : "");
async function maybeAutoFloat(state) {
  const key = floatRunKey(state && state.running);
  if (!key || autoFloatBusy) return;
  const s = await getSettings();
  if (s.floatTracker === false || s.floatAutoAnywhere === false || !chrome.debugger) return;
  if (s.timerPlace === "taskbar" || s.timerPlace === "off") return; // the taskbar app shows it instead (or nothing)
  const g = await chrome.storage.local.get(["floatAutoKey", "floatOpen"]);
  if (g.floatAutoKey === key) return; // this timer was handled already (opened, or closed by you)
  await chrome.storage.local.set({ floatAutoKey: key });
  if (g.floatOpen) return;
  autoFloatBusy = true;
  try {
    // A Start pressed in the dashboard / side panel opens it in that click
    // itself - give that a moment before stepping in.
    await new Promise((r) => setTimeout(r, 3000));
    const now = await chrome.storage.local.get(["floatOpen", "clickupState"]);
    if (now.floatOpen || floatRunKey(now.clickupState && now.clickupState.running) !== key) return;
    await autoFloatNow();
  } finally { autoFloatBusy = false; }
}
async function floatTrackerTab() {
  const url = chrome.runtime.getURL("tracker.html");
  const found = await chrome.tabs.query({ url: url + "*" }).catch(() => []);
  if (found[0]) return found[0];
  const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
  const tab = await chrome.tabs.create({ url: url + "?auto=1", pinned: true, index: 0, active: false, windowId: cur ? cur.windowId : undefined });
  // Wait for it to load (its script adds the click handler).
  await new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(t); resolve(); };
    const on = (id, info) => { if (id === tab.id && info.status === "complete") done(); };
    const t = setTimeout(done, 8000);
    chrome.tabs.onUpdated.addListener(on);
  });
  await new Promise((r) => setTimeout(r, 400));
  return tab;
}
async function realClick(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    const ev = { x: 12, y: 12, button: "left", clickCount: 1 };
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 12, y: 12 });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...ev });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...ev });
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}
// Opened from a tab that isn't in front, Chrome makes the floating window as big
// as the browser window and won't let the page shrink it without a click IN it.
// The window says so (storage floatNeedsFit); one debugger click inside it lets
// it put itself back to its small size (tracker.js only resizes on that click).
async function fitFloatWindow(since) {
  const until = Date.now() + 1500, from = Number(since) || Date.now() - 8000;
  let need = 0;
  while (Date.now() < until && !need) {
    need = Number((await chrome.storage.local.get("floatNeedsFit")).floatNeedsFit) || 0;
    if (need && need < from) need = 0; // left over from an earlier window: ignore
    if (!need) await new Promise((r) => setTimeout(r, 150));
  }
  if (!need) return;
  try {
    const targets = await chrome.debugger.getTargets();
    const t = targets.find((x) => x.type === "page" && x.title === "Tracker" && /^about:blank/.test(x.url || ""));
    if (!t) { diagLog("auto-float", "fit: floating window not found"); return; }
    const target = { targetId: t.id };
    await chrome.debugger.attach(target, "1.3");
    try {
      const ev = { x: 3, y: 3, button: "left", clickCount: 1 };
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mousePressed", ...ev });
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseReleased", ...ev });
    } finally { await chrome.debugger.detach(target).catch(() => {}); }
  } catch (e) { diagLog("auto-float", "fit: " + (e && e.message ? e.message : e)); }
}
// The "Show or hide the floating timer" shortcut (Alt+Shift+4): open → close it,
// closed → open it (timer running or not) through the same click as the
// automatic open.
async function toggleFloat() {
  const { floatOpen } = await chrome.storage.local.get("floatOpen");
  if (floatOpen) {
    chrome.runtime.sendMessage({ type: "FLOAT_CLOSE" }).catch(() => {});
    setTimeout(() => { chrome.storage.local.set({ floatOpen: false }).catch(() => {}); }, 1500);
    return false;
  }
  return autoFloatNow();
}
// ---------- the taskbar app (ClickUp Tracker, desktop-tracker/) ----------
// The app listens on this computer only (127.0.0.1:47615). Each minute the
// extension tells it whether to show (Settings › Where the timer shows) and, when
// it isn't signed in yet, hands it the ClickUp connection - so installing it needs
// no typing. The app only answers what it is; it never sends the token back.
const DESK_URL = "http://127.0.0.1:47615/pcm";
async function deskPost(body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    const res = await fetch(DESK_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
    return res.ok ? await res.json() : null;
  } finally { clearTimeout(t); }
}
async function deskLink(force) {
  const s = await getSettings();
  const place = s.timerPlace || "float";
  const da = (await chrome.storage.local.get("deskApp")).deskApp || {};
  // Nobody asked for it and it was never seen: don't knock on the port at all.
  if (!force && place !== "taskbar" && place !== "both" && !da.seenAt && !da.wanted) return null;
  const show = place === "taskbar" || place === "both";
  let r = null;
  const style = ["B", "L", "F", "H", "J"].includes(s.stripStyle) ? s.stripStyle : "B", anim = s.stripAnim !== false, warnEmpty = s.clickupWarnEmptyComplete !== false;
  try { r = await deskPost({ show, style, anim, warnEmpty, ext: chrome.runtime.id }); } catch (e) { r = null; }
  if (!r || r.app !== "clickup-tracker") {
    const out = { ...da, running: false, checkedAt: Date.now() };
    await chrome.storage.local.set({ deskApp: out });
    return out;
  }
  if (!r.signedIn) {
    const cfg = await getClickupConfig().catch(() => null);
    if (cfg && cfg.token) { try { r = (await deskPost({ show, style, anim, warnEmpty, ext: chrome.runtime.id, token: cfg.token, teamId: cfg.teamId || "" })) || r; } catch (e) {} }
  }
  const out = { ...da, running: true, seenAt: Date.now(), checkedAt: Date.now(), version: String(r.version || ""), signedIn: !!r.signedIn, user: String(r.user || ""), shown: r.shown !== false, folders: !!r.folders };
  await chrome.storage.local.set({ deskApp: out });
  // The first time the app turns up and nothing was chosen yet: the timer moves to
  // the taskbar and the floating window stops opening by itself (Settings can
  // change it back, or show both).
  if (!da.seenAt && !s.timerPlaceChosen) {
    await setSettings({ timerPlace: "taskbar", timerPlaceChosen: true });
    if (!show) { try { await deskPost({ show: true, ext: chrome.runtime.id }); } catch (e) {} }
  }
  return out;
}
// One notification after this update (Windows / Mac only) inviting people to try
// it; the Dashboard card stays until they pick.
async function deskTryNotice() {
  const s = await getSettings();
  if (s.timerPlaceChosen) return;
  const g = await chrome.storage.local.get("deskTryNotified");
  if (g.deskTryNotified) return;
  const pi = await chrome.runtime.getPlatformInfo().catch(() => ({}));
  if (pi.os !== "win" && pi.os !== "mac") return;
  await chrome.storage.local.set({ deskTryNotified: Date.now() });
  setTimeout(() => {
    notify("desk-try", "New: your timer in the " + (pi.os === "mac" ? "menu bar" : "taskbar"),
      "One click puts the task you're tracking, with Stop and Done, right in the " + (pi.os === "mac" ? "Mac menu bar" : "Windows taskbar") + ". Click to try it.",
      undefined, chrome.runtime.getURL("options.html#dashboard")).catch(() => {});
  }, 20000);
}

// ---------- comments kept until a task is completed ----------
// storage heldComments: { taskId: [{ id, text, auto, at, sendAt, taskName, url, tries, nextTry, failed, error }] }.
// Written in a task's ▸ details with "Send when I complete it"; posted (with
// @mentions) when the task is completed from the extension - after asking, or by
// itself when "auto". With sendAt ("⏰ Send at…") it's also posted at that time
// by the every-minute check below, whether or not the task is completed.
async function heldList(taskId) {
  const { heldComments } = await chrome.storage.local.get("heldComments");
  const l = heldComments && Array.isArray(heldComments[taskId]) ? heldComments[taskId] : [];
  return l.filter((c) => c && c.text);
}
async function heldUpdate(taskId, fn) {
  const { heldComments } = await chrome.storage.local.get("heldComments");
  const all = heldComments && typeof heldComments === "object" ? { ...heldComments } : {};
  const next = fn((all[taskId] || []).slice());
  if (next.length) all[taskId] = next; else delete all[taskId];
  await chrome.storage.local.set({ heldComments: all });
}
// Posts them in order; each one is removed as soon as it's posted, so a failure
// part-way never posts the same comment twice.
// withStatus: a scheduled comment's status change (c.status) goes first - posted at
// its time or with Send now; not when the task is being completed anyway. Setting
// the same status twice is harmless, so a retry never posts the comment twice.
async function sendHeldComments(cfg, taskId, list, withStatus) {
  let data = null;
  const members = ((await getClickupState().catch(() => null)) || {}).members;
  for (const c of list) {
    if (withStatus && c.status) await setTaskStatus(cfg.token, taskId, c.status);
    data = await addTaskComment(cfg.token, taskId, c.text.slice(0, 5000), members);
    await heldUpdate(taskId, (l) => l.filter((x) => x.id !== c.id));
  }
  return data;
}
// Comments scheduled for a time (sendAt): checked every minute (UPDATE_ALARM), so a
// time missed while Chrome was closed is posted as soon as it opens. ClickUp
// refusing: tried again in 5 minutes, up to 6 times, then you're told (it stays in
// the task's ▸ details, marked, with Send now).
let heldSchedRunning = false;
async function runScheduledComments() {
  if (heldSchedRunning) return;
  heldSchedRunning = true;
  try {
    const { heldComments } = await chrome.storage.local.get("heldComments");
    const now = Date.now();
    const due = [];
    for (const [taskId, l] of Object.entries(heldComments || {})) for (const c of Array.isArray(l) ? l : []) {
      if (c && c.text && c.sendAt && c.sendAt <= now && !c.failed && (!c.nextTry || c.nextTry <= now)) due.push([taskId, c]);
    }
    if (!due.length) return;
    const cfg = await getClickupConfig();
    const st = await getClickupState().catch(() => null);
    if (!cfg || !cfg.token || (st && st.rateLimitedUntil > now)) return;
    for (const [taskId, c] of due) {
      const url = c.url || taskUrlFor(taskId);
      try {
        await sendHeldComments(cfg, taskId, [c], true);
        if (c.status) { clearFilterCache(); refreshClickup({ includeTasks: true }).catch(() => {}); }
        await notify("hcs-" + c.id, "💬 Comment posted as scheduled", (c.status ? "Status set to " + c.status + ". " : "") + "On “" + (c.taskName || "the task") + "”: “" + c.text.replace(/\s+/g, " ").slice(0, 120) + "”", undefined, url).catch(() => {});
      } catch (e) {
        const tries = (c.tries || 0) + 1, error = String((e && e.message) || e).slice(0, 200);
        const failed = tries >= 6 ? Date.now() : 0;
        await heldUpdate(taskId, (l) => l.map((x) => x.id === c.id ? { ...x, tries, error, failed, nextTry: failed ? 0 : Date.now() + 5 * 60000 } : x));
        if (failed) await notify("hcs-" + c.id, "💬 Scheduled comment not posted", "“" + (c.taskName || "the task") + "” - ClickUp said: " + error + ". It's still in the task's ▸ details: press Send now there.", "danger", url).catch(() => {});
      }
    }
  } finally { heldSchedRunning = false; }
}
async function heldStartReminder(taskId) {
  const held = taskId ? (await heldList(taskId)).filter((c) => !c.sendAt) : [];
  if (!held.length) return;
  const first = held[0].text.replace(/\s+/g, " ");
  await notify("held-" + taskId, "\uD83D\uDCAC " + (held.length === 1 ? "A comment is" : held.length + " comments are") + " waiting on this task",
    "“" + (first.length > 120 ? first.slice(0, 118) + "…" : first) + "” - " + (held.every((c) => c.auto) ? "it's sent by itself when you complete the task." : "you'll be asked to send it when you complete the task."),
    undefined, chrome.runtime.getURL("options.html#dashboard"));
}

// ---------- Unread comments ----------
// Teammates explain things in task comments ("moved to you because…") that are
// easy to miss. Every 5 minutes (after the ClickUp refresh) a few of your open
// tasks have their comments read: tasks ClickUp says changed since the last
// look first, then any not looked at for 3 hours - at most 6 reads a run, never
// while ClickUp is rate-limiting. cuComments { taskId: { checkedAt, upd, list:
// [last 6 comments by others] } }; cuCommentSeen { taskId: when you looked }.
// The pages count a comment as unread when it's newer than that look (and less
// than 60 days old). A new comment that @mentions you pops up a notification.
// ---------- Automation rules (the Automation tab, shown with /automation) ----------
// WHEN something happens / IF conditions hold / THEN do things - the blocks,
// checks and plain words live in lib-rules.js (globalThis.PcmRules). This is the
// runner. Events come from what the extension already sees, with no extra
// ClickUp requests to notice them: a refresh compared with the one before
// (timers, completions, new tasks), the every-minute alarm (time of day, "the
// running task reaches…", tasks due / overdue at their check time), Site monitor
// (down / up) and the comment scan (mentions).
// Storage: autoRules (the rules, in the Drive backup) · autoRuleLog (what they
// did, with undo) · autoRuleSeen (once per task per trigger per day) ·
// autoRuleRuns (at most LIMITS.perDay runs a day each) · autoRuleQueue (the rest
// of a rule after "Wait", and actions held back while ClickUp rate-limits) ·
// autoRulePending (waiting for your OK: a shared task, or more than LIMITS.bulk
// tasks at once) · autoRuleKnown (task ids already seen, for "a new task").
const RULES = globalThis.PcmRules;
const RULE_LOG_MAX = 150;
const ruleDay = (ts) => { const d = new Date(ts || Date.now()); return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); };
async function rulesAll() {
  const { autoRules } = await chrome.storage.local.get("autoRules");
  return (Array.isArray(autoRules) ? autoRules : []).filter((r) => r && r.id && r.trigger && Array.isArray(r.actions));
}
const rulesOn = async (type) => (await rulesAll()).filter((r) => r.on !== false && r.trigger.type === type);
// A timer the rules started or stopped themselves is not a new "timer starts /
// stops" event for other rules - that is how two rules would ping-pong.
let rulesTimerTouchedAt = 0;
let rulesBusy = Promise.resolve();
// Rows the extension already holds, by task id (today, the weeks, the open-task set).
async function rulesRows() {
  const st = (await getClickupState().catch(() => null)) || {};
  const g = await chrome.storage.local.get(["insOpenCache"]).catch(() => ({}));
  const rows = new Map();
  const add = (t) => { if (t && t.id != null && !rows.has(String(t.id))) rows.set(String(t.id), t); };
  for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) if (b) for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[k] || []) add(t);
  for (const t of (g.insOpenCache && g.insOpenCache.tasks) || []) add(t);
  return { st, rows };
}
function rulesTaskCtx(t) {
  if (!t) return null;
  return { id: String(t.id != null ? t.id : t.taskId), name: String(t.name || t.taskName || ""), client: String(t.client || ""), status: String(t.status || ""),
    priority: String(t.priority || ""), estimateMs: Number(t.totalEstimateMs || t.estimateMs) || 0, spentMs: Number(t.totalSpentMs || t.spentMs) || 0,
    dueDateMs: Number(t.dueDateMs) || 0, done: !!t.done, paused: !!t.paused, url: t.url || (t.id != null ? taskUrlFor(t.id) : ""),
    assignees: Array.isArray(t.assignees) ? t.assignees.map((a) => String((a && a.id) || "")).filter(Boolean) : null };
}
async function rulesBaseCtx() {
  const st = (await getClickupState().catch(() => null)) || {};
  const now = Date.now(), dow = new Date(now).getDay();
  const live = st.running && st.running.startMs ? Math.max(0, now - Math.max(Number(st.running.startMs) || 0, Number(st.at) || 0, new Date(now).setHours(0, 0, 0, 0))) : 0;
  return { now, workday: dow !== 0 && dow !== 6 && !isCompanyHoliday(now), todayMs: (Number(st.spentMs) || 0) + live };
}
async function rulesLog(entry) {
  const { autoRuleLog } = await chrome.storage.local.get("autoRuleLog");
  const log = Array.isArray(autoRuleLog) ? autoRuleLog : [];
  log.unshift({ id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), at: Date.now(), ...entry });
  await chrome.storage.local.set({ autoRuleLog: log.slice(0, RULE_LOG_MAX) });
}
// The next task to start: open, mine, due today, not paused, not the one just
// finished - in the order the Today list shows them.
async function rulesNextTask(exceptId) {
  const cfg = await getClickupConfig().catch(() => null);
  const me = String((cfg && cfg.userId) || "");
  const st = (await getClickupState().catch(() => null)) || {};
  const today = new Date().setHours(0, 0, 0, 0);
  const pick = (st.tasks || []).filter((t) => t && t.id != null && !t.done && !t.paused && String(t.id) !== String(exceptId || "") &&
    !EXTRA_TASK_RE.test(t.name || "") && (!t.dueDateMs || new Date(t.dueDateMs).setHours(0, 0, 0, 0) <= today) &&
    (!Array.isArray(t.assignees) || !t.assignees.length || t.assignees.some((a) => String(a && a.id) === me)));
  return pick.find((t) => Number(t.estimateMs) > 0) || pick[0] || null;
}
// One action. Returns { did: "what happened", undo?: {...}, changed?: bool }.
// Ready-made rules put in the Rules list once, switched off (one click turns them
// on). Deleting one is respected: it is never added back.
const RULE_SEEDS = ["Weekly Extra Task"];
async function rulesSeed() {
  const g = await chrome.storage.local.get(["autoRules", "autoRuleSeeded"]);
  const seeded = Array.isArray(g.autoRuleSeeded) ? g.autoRuleSeeded : [];
  const rules = Array.isArray(g.autoRules) ? g.autoRules.slice() : [];
  // Weekly Extra Task first came at 9:00: an untouched, switched-off copy moves to 8:00 (office hours start).
  if (!seeded.includes("Weekly Extra Task@8")) {
    for (const r of rules) {
      if (r && r.name === "Weekly Extra Task" && r.on === false && r.trigger && r.trigger.params && r.trigger.params.hhmm === "09:00") r.trigger.params.hhmm = "08:00";
    }
    seeded.push("Weekly Extra Task@8");
    await chrome.storage.local.set({ autoRules: rules, autoRuleSeeded: seeded });
  }
  const todo = RULE_SEEDS.filter((n) => !seeded.includes(n));
  if (!todo.length) return;
  for (const n of todo) {
    const tpl = (RULES.TEMPLATES || []).find((x) => x.name === n);
    if (!tpl || rules.some((r) => r && r.name === n)) continue;
    const { rule } = RULES.normRule({ ...tpl, on: false });
    rules.push(rule);
  }
  await chrome.storage.local.set({ autoRules: rules, autoRuleSeeded: seeded.concat(todo) });
}
// Weekly Extra Task rule: an Extra Task of mine for this week that the rule did
// NOT make (ClickUp's repeat, or made by hand). The repeat itself can't be read or
// switched off through ClickUp's API, so the person is shown the task to do it.
async function extraClash() {
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || cfg.userId == null) return null;
  const now = new Date();
  const mon = new Date(now); mon.setHours(0, 0, 0, 0);
  const dow = mon.getDay();
  if (dow === 0) mon.setDate(mon.getDate() + 1); else if (dow === 6) mon.setDate(mon.getDate() + 2); else mon.setDate(mon.getDate() - (dow - 1));
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4); fri.setHours(23, 59, 59, 999);
  extraTaskCache.clear();
  const have = await discoverExtraTaskFor(cfg, cfg.userId, cfg.username || cfg.email || "", { fromTs: mon.getTime() - 7 * 86400000, toTs: fri.getTime() });
  if (!have || !have.id) return null;
  const { extraTaskMemo: memo } = await chrome.storage.local.get("extraTaskMemo").catch(() => ({}));
  if (memo && Array.isArray(memo.madeIds) && memo.madeIds.includes(String(have.id))) return null;
  return { name: have.name || "Extra Tasks", url: have.url || taskUrlFor(have.id), done: !!have.done };
}
// ---------- held up? (Insights) ----------
// A task can be waiting on work nobody linked in ClickUp: a schema / live / publish
// step whose page (the parent task) isn't written yet, a parent marked PENDING, or a
// description saying "only build if the client confirms". Read once per task and
// kept 6 hours; at most 30 tasks, one at a time, and never while ClickUp is busy.
const HOLD_TTL = 6 * 3600000;
const HOLD_STEP_RE = /\b(live|go[- ]?live|publish(ing)?|schema|placement|upload|deploy|index(ing)?|implement(ation)?|launch)\b/i;
const HOLD_NAME_RE = /\b(pending|on hold|waiting|awaiting|blocked)\b/i;
const HOLD_TEXT_RE = /(only (?:build|do|start|proceed|publish|create|implement)[^.\n]{0,60}?\bif\b[^.\n]{0,80}|once (?:the )?[^.\n]{0,50}?\b(?:published|live|approved|confirmed|ready|signed off)\b|after (?:the )?[^.\n]{0,50}?\b(?:is |are |gets? )?(?:published|live|approved|confirmed)\b|waiting (?:for|on) [^.\n]{3,60}|depends on [^.\n]{3,60}|blocked by [^.\n]{3,60}|not (?:yet )?(?:published|live|approved|confirmed)[^.\n]{0,40}|pending (?:client|approval|confirmation|review|sign[- ]?off)[^.\n]{0,40})/i;
function holdStopped(st) { return /road\s*-?block|block|on hold|\bhold\b|stuck|waiting|pending|halt|paused/i.test(String(st || "")); }
function holdFinished(st, done) { return !!done || /\b(complete|completed|done|closed|approved|resolved|published|live|in review|review|qa)\b/i.test(String(st || "")); }
// A plan / container parent (a month, a week, a schedule, "Client - SEO - 2026-10"):
// its subtasks don't wait on it.
const HOLD_CONTAINER_RE = /\b20\d\d-\d\d\b|\bweeks?\s*\d|\bweek of\b|\bweekly\b|\bmonthly\b|\bschedule\b|\bproduction\b|\bsprint\b|\bretainer\b|\bbacklog\b|\broadmap\b|\bq[1-4]\b|\s-\s*seo\s*-|\[(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+20\d\d\b/i;
const HOLD_RULES = 5; // bump when holdReason learns something new: every task is checked again
// A container parent: a schedule / plan / month or week list (by its name), or one
// holding 6+ subtasks none of which is a numbered step - a list of separate tasks,
// not one job in steps. Its subtasks don't wait on it or on each other.
function holdContainer(p) {
  if (!p) return false;
  if (HOLD_CONTAINER_RE.test(p.name || "")) return true;
  return Array.isArray(p.subs) && p.subs.length >= 6 && !p.subs.some((s) => holdStep(s.name));
}
// A step number in a name: "ACT-066.S3", "Step 2", "Phase 2", "Part 3", "2. Write...".
// (Not "Week 2" - that's when, not an order.)
function holdStep(name) {
  const n = String(name || "");
  let m = /^\s*([A-Za-z]{1,8}[- ]?\d+)\.S(\d{1,2})\b/i.exec(n);
  if (m) return { base: m[1].toUpperCase(), n: +m[2] };
  m = /\b(?:step|phase|part|stage)\s*(\d{1,2})\b/i.exec(n);
  if (m) return { base: "", n: +m[1] };
  m = /^\s*(\d{1,2})[.)]\s+\S/.exec(n);
  if (m) return { base: "", n: +m[1] };
  return null;
}
// The task's code ("ACT-066.S3" -> "ACT-066.S3", "AP-14 | ..." -> "AP-14").
const HOLD_CODE_RE = /\b([A-Z]{2,8}-\d{1,4}(?:\.S\d{1,2})?)\b/g;
// Earlier steps (same parent, a lower step number) that aren't finished yet.
function holdEarlierSteps(t, sibs) {
  const me = holdStep(t.name);
  if (!me || me.n < 2 || !Array.isArray(sibs)) return [];
  return sibs.filter((s) => s && s.id !== t.id && !holdFinished(s.status, s.done)).filter((s) => {
    const o = holdStep(s.name);
    return o && o.n < me.n && o.base === me.base;
  }).sort((a, b) => holdStep(a.name).n - holdStep(b.name).n);
}
// The task the last reason is about ({ id, name }), so the Warnings tab can link it.
let holdRef = null;
function holdReason(t, p, me, deps, more) {
  more = more || {};
  holdRef = null;
  const about = (x) => { holdRef = x && x.id ? { id: String(x.id), name: String(x.name || "") } : null; };
  const q = (s) => "\u201C" + String(s || "").trim().slice(0, 90) + "\u201D";
  const who = (x) => (Array.isArray(x && x.assignees) ? x.assignees : []).map((a) => String(a.name || "").split(" ")[0]).filter(Boolean).join(", ");
  const dd = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
  // A dependency set in ClickUp ("waiting on") that isn't finished.
  const dep = (Array.isArray(deps) ? deps : []).find((x) => x && !holdFinished(x.status, x.done));
  if (dep) about(dep);
  if (dep) return "it waits on " + q(dep.name) + " (" + (dep.status || "open") + (who(dep) ? ", with " + who(dep) : "") + (dep.dueDateMs ? ", due " + dd(dep.dueDateMs) : "") + ") - a dependency in ClickUp";
  // Under a container parent (a schedule, a month's list...) the parent says
  // nothing about whether this task can go ahead: none of the parent rules apply.
  if (holdContainer(p)) p = null;
  // An earlier numbered step of the same work isn't done yet.
  const early = Array.isArray(more.earlier) ? more.earlier : [];
  if (early.length) { const e = early[0]; about(e); return "an earlier step isn't done yet: " + q(e.name) + " is " + (e.status || "open") + (who(e) ? " with " + who(e) : "") + (early.length > 1 ? " (+" + (early.length - 1) + " more)" : ""); }
  // Its description points to another task that's still open.
  const ref = (Array.isArray(more.refs) ? more.refs : []).find((x) => x && !holdFinished(x.status, x.done));
  if (ref) about(ref);
  if (ref) return "its description points to " + q(ref.name) + ", still " + (ref.status || "open") + (who(ref) ? " with " + who(ref) : "");
  if (p && !p.done && holdStopped(p.status)) about(p);
  if (p && !p.done && holdStopped(p.status)) return "its parent task is " + p.status + " (" + q(p.name) + ")";
  if (p && HOLD_NAME_RE.test(p.name || "") && !p.done) about(p);
  if (p && HOLD_NAME_RE.test(p.name || "") && !p.done) return "its parent is marked " + (String(p.name).match(HOLD_NAME_RE)[0]).toUpperCase() + " (" + q(p.name) + ")";
  if (HOLD_NAME_RE.test(t.name || "")) return "its name says " + (String(t.name).match(HOLD_NAME_RE)[0]).toUpperCase();
  if (p && HOLD_STEP_RE.test(t.name || "") && !holdFinished(p.status, p.done)) about(p);
  if (p && HOLD_STEP_RE.test(t.name || "") && !holdFinished(p.status, p.done)) return "a " + String(t.name).match(HOLD_STEP_RE)[0].toLowerCase() + " step, but the work it goes on isn't finished yet (" + q(p.name) + " is " + (p.status || "open") + ")";
  const m = String(t.text || "").match(HOLD_TEXT_RE);
  if (m) return "its description says " + q(m[0]);
  // Its parent is real work (not a month / week plan), still open, with someone
  // else, and due no later than this task: that work most likely comes first
  // (e.g. "Make booking completion the primary conversion" under "Track completed
  // bookings as a conversion", which first has to create the event).
  const mine = (x) => me != null && (Array.isArray(x && x.assignees) ? x.assignees : []).some((a) => String(a.id) === String(me));
  if (p && !holdFinished(p.status, p.done) && Array.isArray(p.assignees) && p.assignees.length && !mine(p) &&
    (!p.dueDateMs || !t.dueDateMs || new Date(p.dueDateMs).setHours(0, 0, 0, 0) <= new Date(t.dueDateMs).setHours(0, 0, 0, 0))) {
    about(p);
    return "its parent " + q(p.name) + " is still " + (p.status || "open") + " with " + who(p) + (p.dueDateMs ? " (due " + dd(p.dueDateMs) + ")" : "") + " - its work most likely has to be done first";
  }
  return "";
}
async function holdHints(ids) {
  const out = {};
  if (!ids.length) return out;
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return out;
  const { holdCache } = await chrome.storage.local.get("holdCache");
  const cache = holdCache && typeof holdCache === "object" ? holdCache : {};
  const now = Date.now();
  const st = (await getClickupState().catch(() => null)) || {};
  const busy = st.rateLimitedUntil > now;
  const info = async (id, subs) => {
    const key = (subs ? "s" : "i") + id;
    const c = cache[key];
    if (c && now - c.at < HOLD_TTL && (!c.v || Array.isArray(c.v.assignees))) return c.v;
    if (busy) return undefined;
    const v = await getTaskHoldInfo(cfg.token, id, { subs: !!subs }).catch((e) => { if (e && e.status === 429) throw e; return null; });
    cache[key] = { at: now, v };
    await new Promise((r) => setTimeout(r, 120));
    return v;
  };
  const done = []; // the tasks actually read (a busy ClickUp leaves the rest unchecked)
  const refOf = {}; // id -> the task its reason is about
  try {
    for (const id of ids) {
      const t = await info(id);
      if (!t) continue;
      done.push(id);
      const p = t.parentId ? await info(t.parentId, true) : null;
      const deps = [];
      for (const did of Array.isArray(t.waitsOn) ? t.waitsOn.slice(0, 2) : []) { const x = await info(did); if (x) deps.push(x); }
      const earlier = holdEarlierSteps(t, p && p.subs);
      // Tasks its description points to: ClickUp links, and other tasks' codes
      // ("after ACT-025") looked up in the task index (no ClickUp request).
      const refs = [];
      const refIds = new Set(Array.isArray(t.linksTo) ? t.linksTo : []);
      const own = new Set([...String(t.name || "").matchAll(HOLD_CODE_RE)].map((m) => m[1]));
      for (const m of String(t.text || "").matchAll(HOLD_CODE_RE)) {
        if (refIds.size >= 3 || own.has(m[1])) continue;
        const hit = await tixFindByCode(m[1]).catch(() => "");
        if (hit && hit !== String(t.id) && hit !== String(t.parentId || "")) refIds.add(hit);
      }
      for (const rid of [...refIds].slice(0, 3)) { const x = await info(rid); if (x) refs.push(x); }
      const why = holdReason(t, p, cfg.userId, deps, { earlier, refs });
      if (why) { out[id] = why; if (holdRef) refOf[id] = holdRef; }
    }
  } catch (e) { /* ClickUp busy: what we have so far */ }
  // Per task, what was found (why = "" when nothing holds it up): the task rows'
  // ⚠ icon reads this, so the dashboard, popup and side panel show it without asking.
  try {
    const { holdFound } = await chrome.storage.local.get("holdFound");
    const found = holdFound && typeof holdFound === "object" ? { ...holdFound } : {};
    for (const id of done) found[id] = { why: out[id] || "", at: now, r: HOLD_RULES, ref: refOf[id] || null };
    const keepF = Object.entries(found).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 400);
    await chrome.storage.local.set({ holdFound: Object.fromEntries(keepF) });
  } catch (e) {}
  // Keep the cache small: the 300 newest entries.
  const keep = Object.entries(cache).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 300);
  await chrome.storage.local.set({ holdCache: Object.fromEntries(keep) }).catch(() => {});
  return out;
}
async function rulesDoAction(rule, a, ctx, cfg) {
  const p = a.params || {}, t = ctx.task;
  const fill = (s) => RULES.fill(s, ctx);
  switch (a.type) {
    case "notify": {
      const title = fill(p.title) || rule.name;
      const msg = fill(p.message) || RULES.describe(rule);
      await notify("rule-" + rule.id + "-" + ((t && t.id) || (ctx.site && ctx.site.url) || "x"), title, msg, p.sound === "none" ? "none" : p.sound, (t && t.url) || (ctx.site && ctx.site.url) || chrome.runtime.getURL("options.html#automation"));
      return { did: "notified you: " + title };
    }
    case "stop_timer": {
      const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
      if (!cur) return { did: "no timer was running" };
      rulesTimerTouchedAt = Date.now();
      await stopTimer(cfg.token, cfg.teamId);
      return { did: "stopped the timer on " + (cur.taskName || "the task"), undo: { op: "start", taskId: String(cur.taskId) }, changed: true };
    }
    case "start_timer": {
      const target = p.which === "this" ? t : rulesTaskCtx(await rulesNextTask(t && t.id));
      if (!target || !target.id) return { did: "no task left to start" };
      const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
      rulesTimerTouchedAt = Date.now();
      if (cur && String(cur.taskId) === target.id) return { did: target.name + " was already running" };
      if (cur) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
      await setTaskStatus(cfg.token, target.id, "in progress").catch(() => {});
      await startTimer(cfg.token, cfg.teamId, target.id);
      await patchStateTask(target.id, { status: "in progress" }).catch(() => {});
      const st = (await getClickupState().catch(() => null)) || {};
      await setClickupState({ ...st, activeTaskId: target.id });
      return { did: "started " + target.name, undo: { op: "stop" }, changed: true };
    }
    case "complete_task": {
      if (!t) return { did: "no task to complete" };
      await setTaskStatus(cfg.token, t.id, "complete");
      await patchStateTask(t.id, { status: "complete", done: true }).catch(() => {});
      const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
      if (cur && String(cur.taskId) === t.id) { rulesTimerTouchedAt = Date.now(); await stopTimer(cfg.token, cfg.teamId).catch(() => {}); }
      await advanceAutoRun(cfg, t.id).catch(() => {});
      return { did: "completed " + t.name, undo: { op: "status", taskId: t.id, prev: t.status && !/complete|closed|done/i.test(t.status) ? t.status : "to do" }, changed: true };
    }
    case "set_status": {
      if (!t) return { did: "no task" };
      await setTaskStatus(cfg.token, t.id, p.status);
      await patchStateTask(t.id, { status: p.status }).catch(() => {});
      return { did: "set " + t.name + " to " + p.status, undo: { op: "status", taskId: t.id, prev: t.status || "to do" }, changed: true };
    }
    case "move_due": {
      if (!t) return { did: "no task" };
      const task = await getTaskById(cfg.token, t.id);
      const d = new Date(); d.setHours(0, 0, 0, 0);
      const work = (x) => x.getDay() !== 0 && x.getDay() !== 6 && !isCompanyHoliday(x.getTime());
      if (p.to === "tomorrow") d.setDate(d.getDate() + 1);
      else if (p.to === "next_monday") { d.setDate(d.getDate() + 1); while (d.getDay() !== 1) d.setDate(d.getDate() + 1); }
      else { d.setDate(d.getDate() + 1); for (let i = 0; i < 14 && !work(d); i++) d.setDate(d.getDate() + 1); }
      const due = shiftDueToDay(task && task.dueDateMs, d.getTime());
      await setTaskDueDate(cfg.token, t.id, due, task ? task.dueDateHasTime : null);
      return { did: "moved " + t.name + " to " + d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }), undo: { op: "due", taskId: t.id, prev: (task && task.dueDateMs) || null, hasTime: task ? task.dueDateHasTime : null }, changed: true };
    }
    case "create_extra": {
      // This week's Monday to Friday (on a weekend: next week's).
      const now = new Date(ctx.now || Date.now());
      const mon = new Date(now); mon.setHours(0, 0, 0, 0);
      const dow = mon.getDay();
      if (dow === 0) mon.setDate(mon.getDate() + 1); else if (dow === 6) mon.setDate(mon.getDate() + 2); else mon.setDate(mon.getDate() - (dow - 1));
      const fri = new Date(mon); fri.setDate(mon.getDate() + 4); fri.setHours(23, 59, 59, 999);
      const fmt = (d) => d.toLocaleDateString([], { month: "short", day: "numeric" });
      const label = fmt(mon) + " \u2013 " + fmt(fri);
      let work = 0;
      for (let i = 0; i < 5; i++) { const x = new Date(mon); x.setDate(mon.getDate() + i); if (!isCompanyHoliday(x.getTime())) work++; }
      if (!work) return { did: "no Extra Task for " + label + " - the whole week is holidays" };
      const hint = cfg.username || cfg.email || "";
      // Already covered this week? Any Extra Task of mine whose start..due span
      // touches Mon-Fri - a weekly one, one with odd dates (due next Monday), or a
      // daily one. Always a fresh look (the lookup cache is an hour long).
      const covers = (x) => {
        if (!x) return false;
        const due = Number(x.dueDateMs) || 0, st = Number(x.startDateMs) || due;
        return !!due && Math.min(st, due) <= fri.getTime() && due >= mon.getTime();
      };
      extraTaskCache.clear();
      const { extraTaskMemo: memo0 } = await chrome.storage.local.get("extraTaskMemo").catch(() => ({}));
      const have = await discoverExtraTaskFor(cfg, cfg.userId, hint, { fromTs: mon.getTime(), toTs: fri.getTime() });
      if (have === undefined) throw new Error("ClickUp didn't answer - it tries again next time");
      if (covers(have)) {
        const mine = !!(memo0 && Array.isArray(memo0.madeIds) && memo0.madeIds.includes(String(have.id)));
        return { did: "this week's Extra Task is already there (" + (have.name || "Extra Tasks") + (mine ? ", made by this rule" : " - made in ClickUp: if it repeats there, this rule isn't needed") + ")" };
      }
      // An earlier one still open: if it repeats in ClickUp, closing it makes this
      // week's - making one here too would be a duplicate. Nothing until it's closed.
      const back = new Date(mon); back.setDate(mon.getDate() - 35);
      const prev = await discoverExtraTaskFor(cfg, cfg.userId, hint, { fromTs: back.getTime(), toTs: mon.getTime() - 1 });
      if (prev === undefined) throw new Error("ClickUp didn't answer - it tries again next time");
      if (prev && !prev.done) return { did: "not made: your earlier Extra Task (" + (prev.name || "Extra Tasks") + ") is still open - close it first (if it repeats in ClickUp, that makes this week's one)" };
      // A tracking task added by link in ClickUp setup (any name) that covers this week.
      const sset = await getSettings().catch(() => ({}));
      for (const u of (Array.isArray(sset.clickupDeadlineTaskUrls) ? sset.clickupDeadlineTaskUrls : []).slice(0, 6)) {
        const id = parseTaskIdFromUrl(u);
        if (!id) continue;
        const ct = await getTaskById(cfg.token, id).catch(() => null);
        if (ct && !/^(closed|done)$/i.test(ct.statusType || "") && covers(ct)) return { did: "not made: your tracking task " + (ct.name || "") + " already covers this week" };
      }
      // Where and what: the List and name of the last one (remembered when found).
      const { extraTaskMemo: memo } = await chrome.storage.local.get("extraTaskMemo").catch(() => ({}));
      let listId = (have && have.listId) || (prev && prev.listId) || (memo && memo.listId) || "";
      let name = (have && have.name) || (prev && prev.name) || (memo && memo.name) || "";
      if (!listId) throw new Error("no earlier Extra Task found to copy its List from - make one in ClickUp once, then the rule makes the next ones");
      if (!name) name = "Extra Tasks - " + (cfg.username || "me");
      const hours = Math.max(1, Math.min(60, Number(p.hours) || 7));
      const made = await createTask(cfg.token, listId, { name, startDateMs: mon.getTime() + 9 * 3600000, dueDateMs: new Date(fri).setHours(17, 0, 0, 0), estimateMs: hours * 3600000, assignees: cfg.userId != null ? [cfg.userId] : [] });
      const madeIds = ((memo && Array.isArray(memo.madeIds)) ? memo.madeIds : []).concat(String(made && made.id || "")).filter(Boolean).slice(-12);
      await chrome.storage.local.set({ extraTaskMemo: { listId, name, at: Date.now(), madeIds } }).catch(() => {});
      extraTaskCache.clear();
      clearFilterCache();
      refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
      return { did: "created " + name + " for " + label + " (" + hours + "h, " + RULES.fmtMin(Math.round(hours * 60 / 5)) + " a day)", changed: true, url: made && made.url };
    }
    case "comment": {
      if (!t) return { did: "no task" };
      const text = fill(p.text);
      if (!text) return { did: "the comment was empty" };
      await postTaskComment(cfg.token, t.id, text);
      return { did: "commented on " + t.name, changed: true };
    }
    case "open_task": {
      if (!t) return { did: "no task" };
      await chrome.tabs.create({ url: t.url || taskUrlFor(t.id), active: true }).catch(() => {});
      return { did: "opened " + t.name };
    }
    case "open_url": {
      const url = fill(p.url);
      if (!/^https?:\/\/\S+$/i.test(url)) return { did: "no valid link to open" };
      await chrome.tabs.create({ url, active: true }).catch(() => {});
      return { did: "opened " + url };
    }
    case "remind_open": {
      const { rows } = await rulesRows();
      const today = new Date().setHours(0, 0, 0, 0);
      const wk = new Date(today); wk.setDate(wk.getDate() + ((7 - wk.getDay()) % 7)); // to Sunday
      const end = wk.getTime() + 86400000 - 1;
      const open = [...rows.values()].filter((x) => x && !x.done && !x.paused && Number(x.dueDateMs) > 0 && !EXTRA_TASK_RE.test(x.name || "")).filter((x) => {
        const due = new Date(x.dueDateMs).setHours(0, 0, 0, 0);
        return p.range === "today" ? due === today : p.range === "overdue" ? due < today : due >= today && x.dueDateMs <= end;
      });
      const word = p.range === "today" ? "due today" : p.range === "overdue" ? "overdue" : "due this week";
      const title = open.length ? open.length + " task" + (open.length === 1 ? "" : "s") + " " + word + " still open" : "Nothing " + word + " is still open ✓";
      await notify("rule-" + rule.id + "-open", title, open.slice(0, 4).map((x) => "• " + x.name).join("\n") + (open.length > 4 ? "\n+" + (open.length - 4) + " more" : ""), undefined, chrome.runtime.getURL("options.html#dashboard"));
      return { did: title };
    }
    default: return { did: "skipped an unknown action" };
  }
}
// Run a rule's actions for one context, from step `from`. "Wait" (and ClickUp
// asking us to slow down) puts the rest in autoRuleQueue for later.
async function rulesRun(rule, ctx, from = 0, why = "") {
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId) return;
  const did = [], undo = [];
  let changed = false, error = "";
  for (let i = from; i < rule.actions.length; i++) {
    const a = rule.actions[i];
    if (a.type === "wait") {
      await rulesEnqueue(rule, ctx, i + 1, Date.now() + a.params.minutes * 60000);
      did.push("waiting " + RULES.fmtMin(a.params.minutes) + " for the rest");
      break;
    }
    if (RULES.ACTIONS[a.type].changes) {
      const st = (await getClickupState().catch(() => null)) || {};
      if (st.rateLimitedUntil > Date.now()) { await rulesEnqueue(rule, ctx, i, Math.max(st.rateLimitedUntil, Date.now() + 5 * 60000)); did.push("ClickUp asked to slow down - the rest runs in a few minutes"); break; }
    }
    try {
      const r = await rulesDoAction(rule, a, ctx, cfg);
      did.push(r.did);
      if (r.undo) undo.push(r.undo);
      if (r.changed) changed = true;
    } catch (e) {
      error = String((e && e.message) || e);
      did.push("stopped: " + error);
      break;
    }
  }
  await rulesLog({ ruleId: rule.id, ruleName: rule.name, task: ctx.task ? { id: ctx.task.id, name: ctx.task.name, url: ctx.task.url } : null, site: ctx.site || null, did, undo, error, why });
  if (changed) { clearFilterCache(); refreshClickup({ includeTasks: true }).catch(() => {}); }
}
async function rulesEnqueue(rule, ctx, from, runAt) {
  const { autoRuleQueue } = await chrome.storage.local.get("autoRuleQueue");
  const q = Array.isArray(autoRuleQueue) ? autoRuleQueue : [];
  q.push({ id: "q" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ruleId: rule.id, ctx, from, runAt });
  await chrome.storage.local.set({ autoRuleQueue: q.slice(-100) });
}
async function rulesRunQueue() {
  const { autoRuleQueue } = await chrome.storage.local.get("autoRuleQueue");
  const q = Array.isArray(autoRuleQueue) ? autoRuleQueue : [];
  const due = q.filter((x) => x.runAt <= Date.now());
  if (!due.length) return;
  await chrome.storage.local.set({ autoRuleQueue: q.filter((x) => x.runAt > Date.now()) });
  const all = await rulesAll();
  for (const x of due) {
    const rule = all.find((r) => r.id === x.ruleId);
    if (rule && rule.on !== false) await rulesRun(rule, x.ctx, x.from, "after waiting");
  }
}
// Something happened: every switched-on rule with that trigger, for each
// context (a task, a site, or none), its conditions, the once-a-day and per-day
// limits, then the actions - or held for your OK.
function rulesFire(type, items, opts = {}) {
  rulesBusy = rulesBusy.then(() => rulesFireNow(type, items, opts)).catch((e) => diagLog("rules", type + ": " + ((e && e.message) || e)));
  return rulesBusy;
}
async function rulesFireNow(type, items, opts) {
  const rules = (await rulesOn(type)).filter((r) => !opts.only || r.id === opts.only);
  if (!rules.length) return;
  const cfg = await getClickupConfig().catch(() => null);
  const me = String((cfg && cfg.userId) || "");
  const base = await rulesBaseCtx();
  const g = await chrome.storage.local.get(["autoRuleSeen", "autoRuleRuns"]);
  const seen = g.autoRuleSeen && typeof g.autoRuleSeen === "object" ? g.autoRuleSeen : {};
  const runs = g.autoRuleRuns && typeof g.autoRuleRuns === "object" ? g.autoRuleRuns : {};
  const day = ruleDay();
  for (const rule of rules) {
    const matched = [];
    for (const it of items.length ? items : [{}]) {
      const ctx = { ...base, task: it.task || null, site: it.site || null };
      const key = rule.id + "|" + type + "|" + ((ctx.task && ctx.task.id) || (ctx.site && ctx.site.url + "|" + (it.at || "")) || "") + "|" + day;
      if (seen[key]) continue;
      // Everything but the one condition that costs a ClickUp read first.
      const cheap = { ...rule, conds: (rule.conds || []).filter((c) => c.type !== "no_proof") };
      if (!RULES.condsMet(cheap, ctx)) continue;
      if (RULES.needsProofCheck(rule) && ctx.task && cfg) ctx.proofMissing = !!(await completionEvidenceMissing(cfg, ctx.task.id));
      if (RULES.needsProofCheck(rule) && !ctx.proofMissing) continue;
      seen[key] = Date.now();
      matched.push(ctx);
    }
    if (!matched.length) continue;
    const r = runs[rule.id] && runs[rule.id].day === day ? runs[rule.id] : { day, n: 0 };
    const changes = rule.actions.some((a) => RULES.ACTIONS[a.type].changes);
    // Never another person's task; a shared one, or many at once, waits for your OK.
    const ok = [], ask = [];
    for (const ctx of matched) {
      const who = ctx.task && ctx.task.assignees;
      if (changes && ctx.task && who && who.length && me && !who.includes(me)) {
        await rulesLog({ ruleId: rule.id, ruleName: rule.name, task: { id: ctx.task.id, name: ctx.task.name, url: ctx.task.url }, did: ["skipped - not your task"], undo: [] });
        continue;
      }
      if (changes && ctx.task && who && who.length > 1) ask.push(ctx); else ok.push(ctx);
    }
    if (changes && ok.length > RULES.LIMITS.bulk) { ask.push(...ok.splice(0)); }
    for (const ctx of ok) {
      if (r.n >= RULES.LIMITS.perDay) { await rulesLog({ ruleId: rule.id, ruleName: rule.name, task: ctx.task ? { id: ctx.task.id, name: ctx.task.name } : null, did: ["not run - it already ran " + RULES.LIMITS.perDay + " times today"], undo: [] }); break; }
      r.n++;
      await rulesRun(rule, ctx, 0, RULES.sayTrigger(rule.trigger));
    }
    if (ask.length) await rulesAsk(rule, ask);
    runs[rule.id] = r;
  }
  // Seen keys older than 3 days go.
  const cut = Date.now() - 3 * 86400000;
  for (const k of Object.keys(seen)) if (seen[k] < cut) delete seen[k];
  await chrome.storage.local.set({ autoRuleSeen: seen, autoRuleRuns: runs });
}
async function rulesAsk(rule, ctxs) {
  const { autoRulePending } = await chrome.storage.local.get("autoRulePending");
  const list = Array.isArray(autoRulePending) ? autoRulePending : [];
  list.push({ id: "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ruleId: rule.id, ruleName: rule.name, at: Date.now(), ctxs,
    why: ctxs.length > RULES.LIMITS.bulk ? ctxs.length + " tasks at once" : "a task shared with other people" });
  await chrome.storage.local.set({ autoRulePending: list.slice(-30) });
  await notify("rule-ask-" + rule.id, "“" + rule.name + "” is waiting for your OK",
    (ctxs.length === 1 && ctxs[0].task ? ctxs[0].task.name + " is shared with other people." : ctxs.length + " tasks at once.") + " Open Automation to approve or dismiss.", undefined, chrome.runtime.getURL("options.html#automation"));
}
async function rulesUndo(logId) {
  const { autoRuleLog } = await chrome.storage.local.get("autoRuleLog");
  const log = Array.isArray(autoRuleLog) ? autoRuleLog : [];
  const e = log.find((x) => x.id === logId);
  if (!e || !Array.isArray(e.undo) || !e.undo.length || e.undone) return { ok: false, error: "Nothing to undo." };
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return { ok: false, error: "ClickUp isn't connected." };
  for (const u of e.undo.slice().reverse()) {
    if (u.op === "status") { await setTaskStatus(cfg.token, u.taskId, u.prev); await patchStateTask(u.taskId, { status: u.prev, done: false }).catch(() => {}); }
    else if (u.op === "due") await setTaskDueDate(cfg.token, u.taskId, u.prev, u.hasTime);
    else if (u.op === "stop") { rulesTimerTouchedAt = Date.now(); await stopTimer(cfg.token, cfg.teamId).catch(() => {}); }
    else if (u.op === "start") { rulesTimerTouchedAt = Date.now(); await startTimer(cfg.token, cfg.teamId, u.taskId); }
  }
  e.undone = Date.now();
  await chrome.storage.local.set({ autoRuleLog: log });
  clearFilterCache(); refreshClickup({ includeTasks: true }).catch(() => {});
  return { ok: true };
}
// ---- the event sources ----
// A refresh compared with the one before: timers, completions, new tasks.
async function rulesOnState(prev, next) {
  if (!prev || !next) return;
  if (!(await rulesAll()).some((r) => r.on !== false)) return;
  const keyOf = (x) => (x ? String(x.taskId || "") + ":" + String(x.startMs || "") : "");
  const touchedByRule = Date.now() - rulesTimerTouchedAt < 20000;
  const { rows } = await rulesRows();
  const rowCtx = (id, name) => rulesTaskCtx(rows.get(String(id)) || { id, name });
  if (keyOf(prev.running) !== keyOf(next.running) && !touchedByRule) {
    if (prev.running && prev.running.taskId) await rulesFire("timer_stopped", [{ task: rowCtx(prev.running.taskId, prev.running.taskName) }]);
    if (next.running && next.running.taskId) await rulesFire("timer_started", [{ task: rowCtx(next.running.taskId, next.running.taskName) }]);
  }
  const bundles = (s) => [s, s.todayFilter, s.thisWeek, s.nextWeek].filter(Boolean);
  const before = new Map();
  for (const b of bundles(prev)) for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[k] || []) if (t && t.id != null) before.set(String(t.id), t);
  const completed = [], fresh = [];
  const { autoRuleKnown } = await chrome.storage.local.get("autoRuleKnown");
  const known = new Set(Array.isArray(autoRuleKnown) ? autoRuleKnown : []);
  const firstRun = !known.size;
  for (const b of bundles(next)) for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[k] || []) {
    if (!t || t.id == null) continue;
    const id = String(t.id), was = before.get(id);
    if (t.done && was && !was.done && !completed.some((c) => c.task.id === id)) completed.push({ task: rulesTaskCtx(t) });
    if (!known.has(id)) { known.add(id); if (!firstRun && !t.done && !EXTRA_TASK_RE.test(t.name || "")) fresh.push({ task: rulesTaskCtx(t) }); }
  }
  await chrome.storage.local.set({ autoRuleKnown: [...known].slice(-3000) });
  if (completed.length) await rulesFire("task_completed", completed);
  if (fresh.length) await rulesFire("task_new", fresh);
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.clickupState) rulesOnState(ch.clickupState.oldValue, ch.clickupState.newValue).catch(() => {});
});
// Every minute: the time of day, the running task's time, due / overdue at
// their check time, and anything waiting in the queue.
async function rulesTick() {
  const all = (await rulesAll()).filter((r) => r.on !== false);
  await rulesRunQueue().catch(() => {});
  if (!all.length) return;
  const now = Date.now(), d = new Date(now);
  const hmNow = d.getHours() * 60 + d.getMinutes();
  const at = (hm) => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
  // Late by up to 2 hours (Chrome was closed at 4:30) still counts; later than that is skipped.
  const inWindow = (hm) => hmNow >= at(hm) && hmNow - at(hm) <= 120;
  for (const r of all.filter((x) => x.trigger.type === "time_of_day")) {
    if ((r.trigger.params.days || []).includes(d.getDay()) && inWindow(r.trigger.params.hhmm)) await rulesFire("time_of_day", [{}], { only: r.id });
  }
  const dayRules = all.filter((x) => (x.trigger.type === "task_due_today" || x.trigger.type === "task_overdue") && inWindow(x.trigger.params.hhmm));
  if (dayRules.length) {
    const { rows } = await rulesRows();
    const today = new Date(now).setHours(0, 0, 0, 0);
    const open = [...rows.values()].filter((t) => t && !t.done && Number(t.dueDateMs) > 0 && !EXTRA_TASK_RE.test(t.name || ""));
    for (const r of dayRules) {
      const due = open.filter((t) => { const x = new Date(t.dueDateMs).setHours(0, 0, 0, 0); return r.trigger.type === "task_due_today" ? x === today : x < today; });
      if (due.length) await rulesFire(r.trigger.type, due.map((t) => ({ task: rulesTaskCtx(t) })), { only: r.id });
    }
  }
  const reach = all.filter((x) => x.trigger.type === "tracked_reaches");
  if (reach.length) {
    const st = (await getClickupState().catch(() => null)) || {};
    const run = st.running;
    const { runningProgress: rp } = await chrome.storage.local.get("runningProgress");
    if (run && run.taskId && rp && String(rp.taskId) === String(run.taskId)) {
      const live = Math.max(0, now - (Number(run.startMs) || now));
      const tracked = (Number(rp.closedMs) || 0) + live, est = Number(rp.estimateMs) || 0;
      const todayTask = (Number(rp.closedTodayMs) || 0) + Math.max(0, now - Math.max(Number(run.startMs) || now, new Date(now).setHours(0, 0, 0, 0)));
      const { rows } = await rulesRows();
      const task = rulesTaskCtx({ ...(rows.get(String(run.taskId)) || { id: run.taskId, name: rp.taskName || run.taskName }), estimateMs: est, spentMs: tracked });
      for (const r of reach) {
        const p = r.trigger.params;
        const hit = p.what === "estimate" ? est > 0 && tracked >= est : p.what === "before" ? est > 0 && tracked >= est - p.minutes * 60000 && tracked < est : todayTask >= p.minutes * 60000;
        if (hit) await rulesFire("tracked_reaches", [{ task }], { only: r.id });
      }
    }
  }
}
// A dry run: what a rule would do right now, without doing it.
async function rulesTest(rule) {
  const { rule: r } = RULES.normRule(rule);
  const probs = RULES.problems(r);
  const base = await rulesBaseCtx();
  const { st, rows } = await rulesRows();
  const out = { problems: probs, describe: RULES.describe(r), items: [], note: "" };
  if (!r.trigger) return out;
  const today = new Date().setHours(0, 0, 0, 0);
  let cands = [];
  const t = r.trigger.type;
  if (t === "timer_started" || t === "timer_stopped" || t === "tracked_reaches") {
    if (st.running && st.running.taskId) cands = [{ task: rulesTaskCtx(rows.get(String(st.running.taskId)) || { id: st.running.taskId, name: st.running.taskName }) }];
    else out.note = "No timer is running now, so there's nothing to try it on. It runs when one is.";
  } else if (t === "task_completed") cands = [...rows.values()].filter((x) => x && x.done).slice(0, 3).map((x) => ({ task: rulesTaskCtx(x) }));
  else if (t === "task_due_today" || t === "task_overdue") cands = [...rows.values()].filter((x) => x && !x.done && Number(x.dueDateMs) > 0 && (t === "task_due_today" ? new Date(x.dueDateMs).setHours(0, 0, 0, 0) === today : new Date(x.dueDateMs).setHours(0, 0, 0, 0) < today)).map((x) => ({ task: rulesTaskCtx(x) }));
  else if (t === "site_down" || t === "site_up") {
    const cfg = await getSiteMonitorConfig().catch(() => null);
    const sst = (await chrome.storage.local.get("siteMonitorState")).siteMonitorState || {};
    cands = ((cfg && cfg.sites) || []).filter((s) => s && s.url && sst[s.url] && sst[s.url].up === (t === "site_up")).map((s) => ({ site: { name: s.name || s.url, url: s.url, paused: !!isPausedSite(s) } }));
    if (!cands.length) out.note = t === "site_down" ? "No site is down right now - it runs when one goes down." : "No site to try it on yet.";
  } else if (t === "time_of_day") { cands = [{}]; out.note = "It runs at " + RULES.fmtTime(r.trigger.params.hhmm) + " on " + r.trigger.params.days.map((n) => RULES.DAY_NAMES[n]).join(", ") + "."; }
  else out.note = "It runs when that happens - there's nothing to try it on right now.";
  for (const c of cands.slice(0, 8)) {
    const ctx = { ...base, ...c };
    const cheap = { ...r, conds: r.conds.filter((x) => x.type !== "no_proof") };
    const met = RULES.condsMet(cheap, ctx);
    out.items.push({ who: (c.task && c.task.name) || (c.site && c.site.name) || "now", would: met ? r.actions.map(RULES.sayAction) : [],
      skip: met ? (RULES.needsProofCheck(r) ? "(and only if nothing shows the work - checked when it runs)" : "") : "its conditions don't hold" });
  }
  return out;
}

// ---------- archived tasks (Insights › Health › Archived recently) ----------
// A task archived in ClickUp vanishes from every list here without a word (all
// the extension's reads ask for non-archived tasks) - a whole Weekly Production
// Schedule went, subtasks and all, and nobody noticed. One small read lists the
// archived tasks assigned to me: about every 30 minutes, and within a minute
// when a task drops out of my lists without being completed. New ones are
// notified (grouped by their parent) and kept in cuArchived for 30 days. WHO
// archived it isn't in ClickUp's API - the task's Activity in ClickUp shows it,
// one click away.
const ARCH_EVERY_MS = 30 * 60000, ARCH_SOON_MS = 2 * 60000, ARCH_KEEP_MS = 30 * 86400000;
let archSoon = false, archRun = null;
function archiveWatch(force) {
  if (archRun) return archRun;
  archRun = (async () => {
    const cfg = await getClickupConfig().catch(() => null);
    if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return null;
    const st = (await getClickupState().catch(() => null)) || {};
    if (st.rateLimitedUntil > Date.now()) return null;
    const { cuArchived } = await chrome.storage.local.get("cuArchived");
    const prev = cuArchived && typeof cuArchived === "object" && Array.isArray(cuArchived.tasks) ? cuArchived : null;
    const now = Date.now();
    const gap = prev ? now - (prev.at || 0) : Infinity;
    if (!force && prev && !(gap >= ARCH_EVERY_MS || (archSoon && gap >= ARCH_SOON_MS))) return prev;
    archSoon = false;
    // First time: the last 7 days, kept quietly (no flood of old news).
    // Later: from the oldest one still listed, so the answer is every task of mine
    // that IS archived now - one unarchived in ClickUp drops off the list too.
    const listed = prev ? prev.tasks : [];
    const oldest = listed.reduce((m, t) => Math.min(m, Number(t.archivedAt) || now), now);
    const since = prev ? Math.max(now - ARCH_KEEP_MS, Math.min((prev.at || now) - 10 * 60000, oldest - 60000)) : now - 7 * 86400000;
    const found = await fetchArchivedMine(bgToken(cfg.token), cfg.teamId, cfg.userId, since);
    const still = new Set(found.map((t) => t.id));
    const whole = found.length < 300; // a full answer (3 pages): only then can "missing" mean "unarchived"
    const known = new Map(listed.filter((t) => !whole || still.has(t.id) || (Number(t.archivedAt) || 0) < since).map((t) => [t.id, t]));
    const fresh = found.filter((t) => !known.has(t.id));
    // The parent's name, for "archived with its parent ..." (a few reads at most).
    const parents = {};
    for (const pid of [...new Set(fresh.map((t) => t.parentId).filter(Boolean))].slice(0, 5)) {
      const p = await getTaskById(cfg.token, pid).catch(() => null);
      if (p && p.name) parents[pid] = p.name;
    }
    for (const t of fresh) { if (parents[t.parentId]) t.parentName = parents[t.parentId]; t.noticedAt = now; known.set(t.id, t); }
    const tasks = [...known.values()].filter((t) => now - (t.archivedAt || t.noticedAt || now) < ARCH_KEEP_MS)
      .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0)).slice(0, 200);
    const out = { at: now, tasks };
    await chrome.storage.local.set({ cuArchived: out });
    if (prev && fresh.length) {
      // One notification per parent (or per task on its own).
      const groups = new Map();
      for (const t of fresh) { const k = t.parentId && t.parentName ? "p" + t.parentId : "t" + t.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      let n = 0;
      for (const [k, list] of groups) {
        if (n++ >= 3) break;
        const first = list[0];
        const title = "\uD83D\uDCE6 Archived in ClickUp: " + (k[0] === "p" ? first.parentName : first.name);
        const msg = k[0] === "p"
          ? "With " + list.length + " of your task" + (list.length === 1 ? "" : "s") + ": " + list.slice(0, 3).map((t) => t.name).join(", ") + (list.length > 3 ? " and " + (list.length - 3) + " more" : "") + ". Click to see who archived it (Activity)."
          : (first.client ? first.client + " · " : "") + "Click to see who archived it (Activity in ClickUp).";
        await notify("arch-" + k, title, msg, undefined, k[0] === "p" ? taskUrlFor(first.parentId) : first.url).catch(() => {});
      }
      // Automation rules: "A task of mine is archived".
      rulesFire("task_archived", fresh.map((t) => ({ task: rulesTaskCtx(t) }))).catch(() => {});
    }
    return out;
  })().catch((e) => { diagLog("archived", (e && e.message) || e); return null; }).finally(() => { archRun = null; });
  return archRun;
}
// A task that was in my lists, not completed, and is gone after a refresh: maybe
// archived - look within the minute instead of waiting half an hour.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !ch.clickupState) return;
  const a = ch.clickupState.oldValue, b = ch.clickupState.newValue;
  if (!a || !b) return;
  const ids = (s) => { const m = new Map(); for (const x of [s, s.todayFilter, s.thisWeek, s.nextWeek].filter(Boolean)) for (const k of ["tasks", "deadlineTasks"]) for (const t of x[k] || []) if (t && t.id != null) m.set(String(t.id), t); return m; };
  const before = ids(a), after = ids(b);
  const today = new Date().setHours(0, 0, 0, 0);
  for (const [id, t] of before) {
    if (after.has(id) || t.done) continue;
    // Its dates still fall inside what the lists cover: not just a week rolling over.
    if (!t.dueDateMs || Number(t.dueDateMs) >= today) { archSoon = true; break; }
  }
});

const CMT_PER_RUN = 6, CMT_RECHECK_MS = 3 * 3600000;
let cmtScanning = false;
async function scanComments(more) {
  if (cmtScanning) return;
  const st = (await getClickupState().catch(() => null)) || {};
  if (st.rateLimitedUntil > Date.now()) return;
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return;
  const s = await getSettings().catch(() => ({}));
  if (s.commentWatch === false) return;
  cmtScanning = true;
  try {
    const g = await chrome.storage.local.get(["insOpenCache", "cuComments"]);
    const rows = new Map();
    const add = (t) => { if (t && t.id && !t.done && !/\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(t.name || "")) { const k = String(t.id); if (!rows.has(k)) rows.set(k, t); } };
    for (const t of (g.insOpenCache && g.insOpenCache.tasks) || []) add(t);
    for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) if (b) for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) for (const t of b[k] || []) add(t);
    const cache = g.cuComments && typeof g.cuComments === "object" ? { ...g.cuComments } : {};
    const now = Date.now();
    const due = [...rows.values()].filter((t) => {
      const c = cache[String(t.id)];
      return !c || (Number(t.updatedMs) > (c.upd || 0) + 1000) || now - (c.checkedAt || 0) > CMT_RECHECK_MS;
    }).sort((a, b) => {
      const ca = cache[String(a.id)], cb = cache[String(b.id)];
      const pa = !ca ? 0 : Number(a.updatedMs) > (ca.upd || 0) ? 1 : 2, pb = !cb ? 0 : Number(b.updatedMs) > (cb.upd || 0) ? 1 : 2;
      return pa - pb || (Number(b.updatedMs) || 0) - (Number(a.updatedMs) || 0);
    }).slice(0, more ? CMT_PER_RUN * 3 : CMT_PER_RUN);
    const me = String(cfg.userId || "");
    const pings = [];
    for (const t of due) {
      const id = String(t.id);
      let list;
      try { list = await getTaskCommentsLite(cfg.token, id); }
      catch (e) { if (e && e.status === 429) break; cache[id] = { ...(cache[id] || {}), checkedAt: now }; continue; }
      const others = list.filter((c) => c.userId !== me).sort((a, b) => b.at - a.at).slice(0, 6)
        .map((c) => ({ at: c.at, who: c.who, text: c.text, mention: c.mentions.includes(me) }));
      const prev = cache[id];
      if (prev && prev.list) {
        const before = prev.list.reduce((mx, c) => Math.max(mx, c.at), 0);
        for (const c of others) if (c.at > before && c.mention) pings.push({ id, name: t.name, url: t.url || taskUrlFor(id), c });
      }
      cache[id] = { checkedAt: now, upd: Number(t.updatedMs) || 0, name: String(t.name || "").slice(0, 200), url: t.url || taskUrlFor(id), client: t.client || "", list: others };
      await new Promise((r) => setTimeout(r, 250));
    }
    // Forget tasks that are no longer open (kept a day in case the list was partial).
    for (const k of Object.keys(cache)) if (!rows.has(k) && now - (cache[k].checkedAt || 0) > 24 * 3600000) delete cache[k];
    await chrome.storage.local.set({ cuComments: cache });
    for (const p of pings.slice(0, 3)) {
      await notify("cmt-" + p.id + "-" + p.c.at, "\uD83D\uDCAC " + p.c.who + " mentioned you", "“" + p.name + "”: " + p.c.text, undefined, p.url).catch(() => {});
    }
    // Automation rules: "Someone mentions me in a comment".
    if (pings.length) rulesFire("comment_mention", pings.map((p) => ({ task: rulesTaskCtx(rows.get(p.id) || { id: p.id, name: p.name, url: p.url }) }))).catch(() => {});
  } finally { cmtScanning = false; }
}

// ---------- draft tasks (local-tasks.js) ----------
// The fields ClickUp gets for a draft: the people picked (older drafts only had
// "assign it to me"), start and due dates, and a parent when it's a subtask.
function draftCreateFields(d, cfg) {
  const ids = Array.isArray(d.assignees)
    ? d.assignees.map((a) => a && a.id).filter((x) => x != null && String(x).trim() !== "")
    : (d.assignMe !== false && cfg.userId != null ? [cfg.userId] : []);
  return { name: d.name, md: d.md, dueDateMs: d.dueDateMs, startDateMs: d.startDateMs, estimateMs: d.estimateMs, priority: d.priority, assignees: ids, parentId: d.parentId || "" };
}
// A draft with "Relate to a task" picked: once it's created it's related to that
// task (ClickUp's Relate a Task). A failure doesn't undo the new task - it's said.
async function relateDraft(cfg, d, task) {
  if (!d || !d.relateId || !task || !task.id) return "";
  try { await relateTasks(cfg.token, String(task.id), String(d.relateId), "related"); return ""; }
  catch (e) { return "\u201C" + (d.name || task.name || "The task") + "\u201D is in ClickUp, but couldn't be related to \u201C" + (d.relateName || "the task") + "\u201D: " + String(e && e.message ? e.message : e) + " - relate it in ClickUp."; }
}
// Drafts set to "Send to ClickUp on <date, time>": created when that time comes
// (checked every minute), then their notes / pin / reminders move to the real
// task and the draft goes away - the same as pressing Apply to ClickUp.
let draftsSending = false;
async function sendScheduledDrafts() {
  if (draftsSending) return;
  const g = await chrome.storage.local.get("localTasks");
  const list = Array.isArray(g.localTasks) ? g.localTasks : [];
  const due = list.filter((d) => d && Number(d.applyAt) > 0 && Number(d.applyAt) <= Date.now() && d.listId && !d.error);
  if (!due.length) return;
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return;
  draftsSending = true;
  try {
    for (const d of due) {
      let task = null, err = "";
      try { task = await createTask(cfg.token, String(d.listId), draftCreateFields(d, cfg)); }
      catch (e) { err = String(e && e.message ? e.message : e); if (e && e.status === 429) break; }
      const cur = (await chrome.storage.local.get("localTasks")).localTasks || [];
      if (!task) {
        const x = cur.find((y) => y.id === d.id);
        if (x) { x.error = ("Couldn't send it at the set time: " + err).slice(0, 300); await chrome.storage.local.set({ localTasks: cur }); }
        await notify("draft-fail-" + d.id, "Draft task not sent", "“" + (d.name || "Untitled") + "” couldn't be created in ClickUp: " + err, "danger", chrome.runtime.getURL("options.html#dashboard"));
        continue;
      }
      const relErr = await relateDraft(cfg, d, task);
      if (relErr) await notify("draft-rel-" + d.id, "Task sent - not related", relErr, "danger", task.url).catch(() => {});
      const ex = await chrome.storage.local.get(["taskNotes", "taskPins", "reminders"]);
      const out = { localTasks: cur.filter((y) => y.id !== d.id) };
      const to = String(task.id);
      if (ex.taskNotes && ex.taskNotes[d.id]) { ex.taskNotes[to] = ex.taskNotes[d.id]; delete ex.taskNotes[d.id]; out.taskNotes = ex.taskNotes; }
      if (ex.taskPins && ex.taskPins[d.id]) { ex.taskPins[to] = ex.taskPins[d.id]; delete ex.taskPins[d.id]; out.taskPins = ex.taskPins; }
      if (Array.isArray(ex.reminders) && ex.reminders.some((r) => r && r.taskId === d.id)) {
        for (const r of ex.reminders) if (r && r.taskId === d.id) { r.taskId = to; r.taskUrl = task.url || r.taskUrl; }
        out.reminders = ex.reminders;
      }
      await chrome.storage.local.set(out);
      await notify("draft-sent-" + to, "Task sent to ClickUp ✓", "“" + (d.name || task.name) + "” was created in ClickUp at the time you set.", undefined, task.url);
    }
    openTasksCache = null;
    clearFilterCache();
    refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
  } finally { draftsSending = false; }
}
async function waitFloatOpen(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await chrome.storage.local.get("floatOpen")).floatOpen) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
async function autoFloatNow() {
  const since = Date.now();
  await chrome.storage.local.set({ floatNeedsFit: 0 }).catch(() => {});
  const tab = await floatTrackerTab();
  if (!tab || tab.id == null) return false;
  // 1) In the background - you stay where you are.
  try { await realClick(tab.id); } catch (e) { diagLog("auto-float", "click: " + (e && e.message ? e.message : e)); }
  if (await waitFloatOpen(2500)) { await fitFloatWindow(since); return true; }
  // 2) Chrome wouldn't take it from a hidden tab: show the Tracker tab for a
  //    moment, click, and go straight back to the tab you were on.
  const [back] = await chrome.tabs.query({ active: true, windowId: tab.windowId }).catch(() => []);
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise((r) => setTimeout(r, 300));
    await realClick(tab.id);
  } catch (e) { diagLog("auto-float", "front click: " + (e && e.message ? e.message : e)); }
  const ok = await waitFloatOpen(2500);
  if (back && back.id !== tab.id) await chrome.tabs.update(back.id, { active: true }).catch(() => {});
  if (ok) await fitFloatWindow(since);
  if (!ok) {
    diagLog("auto-float", "the floating window did not open");
    // Chrome wouldn't let it open by itself here: one click on this opens it.
    await notify("float-ask", "Float your timer?", "Chrome didn't let the floating timer open by itself this time. Click here, then click once in the Tracker tab.", null, chrome.runtime.getURL("tracker.html")).catch(() => {});
  }
  return ok;
}

// ---------- Recently completed: a local history that costs no ClickUp calls ----------
// Every refresh already fetches tasks WITH their status (the due-date queries all
// pass include_closed=true), so a task that comes back done is a completion we
// can record for free. That is the whole point of this: the ask was for a
// completed-task history that "doesnt impact the clickup rate limit", so nothing
// here ever issues a request - it only reads rows the refresh already has in
// hand. A side benefit is that completions made directly in ClickUp are caught
// too, not just the ones made with the extension's own Complete button.
const DONE_HISTORY_KEY = "cuDoneHistory";
const DONE_HISTORY_MAX = 200;      // plenty for "what did I finish recently", bounded storage
const DONE_HISTORY_DAYS = 60;      // older entries are dropped on the next refresh
// Each bundle in clickupState carries the same three row arrays. Walk the lot so
// a task completed in any view (today, this week, next week, a custom range,
// the configured URLs) is recorded once.
function cuDoneRowsOf(state) {
  const out = [];
  const eat = (b) => {
    if (!b || typeof b !== "object") return;
    for (const key of ["tasks", "deadlineTasks", "trackedTasks"]) {
      const rows = b[key];
      if (Array.isArray(rows)) for (const r of rows) if (r && r.done && r.id != null) out.push(r);
    }
  };
  eat(state);
  for (const key of ["todayFilter", "thisWeek", "thisWorkweek", "nextWeek", "tomorrow", "custom", "overdue"]) eat(state && state[key]);
  const perDay = state && state.weekly && state.weekly.perDay;
  if (Array.isArray(perDay)) for (const d of perDay) eat(d);
  return out;
}
async function recordDoneHistory(state) {
  const rows = cuDoneRowsOf(state);
  const store = await chrome.storage.local.get(DONE_HISTORY_KEY);
  const prev = Array.isArray(store && store[DONE_HISTORY_KEY]) ? store[DONE_HISTORY_KEY] : [];
  const byId = new Map(prev.map((e) => [String(e.id), e]));
  const now = Date.now();
  let added = 0;
  for (const r of rows) {
    const id = String(r.id);
    const been = byId.get(id);
    if (been) {
      // Already recorded: keep the ORIGINAL timestamp (a later refresh must not
      // be able to move a completion forward) but let the details stay current.
      been.name = r.name || been.name;
      been.client = r.client || been.client;
      been.url = r.url || been.url;
      been.status = r.status || been.status;
      been.spentMs = Number(r.spentMs) || been.spentMs || 0;
      been.estimateMs = Number(r.totalEstimateMs) || Number(r.estimateMs) || been.estimateMs || 0;
      continue;
    }
    const exact = Number(r.doneAt) || 0;
    byId.set(id, {
      id,
      name: r.name || "(untitled task)",
      url: r.url || "",
      client: r.client || "",
      status: r.status || "",
      // ClickUp's own completion time when it gave one; otherwise the moment we
      // first saw it done. `exact` says which, so the card never claims a
      // precision it doesn't have.
      doneAt: exact || now,
      exact: !!exact,
      estimateMs: Number(r.totalEstimateMs) || Number(r.estimateMs) || 0,
      spentMs: Number(r.spentMs) || 0,
    });
    added++;
  }
  const cutoff = now - DONE_HISTORY_DAYS * 86400000;
  const next = [...byId.values()]
    .filter((e) => Number(e.doneAt) > cutoff)
    .sort((a, b) => Number(b.doneAt) - Number(a.doneAt))
    .slice(0, DONE_HISTORY_MAX);
  // Only write when something actually changed, so an idle refresh doesn't churn
  // storage (and doesn't wake every storage listener in the UI).
  if (added || next.length !== prev.length || JSON.stringify(next) !== JSON.stringify(prev)) {
    await chrome.storage.local.set({ [DONE_HISTORY_KEY]: next });
  }
  return next;
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
    awayNotify: settings.clickupAwayNotify !== false,
    awayMin: Number(settings.clickupAwayMin) || 15,
    wrapUp: settings.clickupWrapUp !== false,
    extraAutoClose: settings.clickupExtraAutoClose !== false,
    warnEmptyComplete: settings.clickupWarnEmptyComplete !== false,
    overRepeatMin: Number.isFinite(Number(settings.clickupOverRepeatMin)) ? Number(settings.clickupOverRepeatMin) : 15,
    relatedOn: settings.clickupRelatedOn !== false,
    relatedCap: Number(settings.clickupRelatedCap) || 25,
    relatedIds: String(settings.clickupRelatedIds || ""),
    holidayHeadsUp: settings.clickupHolidayHeadsUp !== false,
    wrapUpTime: settings.clickupWrapUpTime || "16:45",
    // Daily "needs tidying" reminder (see maybeTidyNotify / lib-tidy.js).
    tidyNotify: settings.clickupTidyNotify !== false,
    tidyTime: settings.clickupTidyTime || "14:00",
    tidyDays: settings.clickupTidyDays || "weekdays",
    tidyMax: Math.max(1, Math.min(6, Number(settings.clickupTidyMax) || 3)),
    tidyResolved: settings.clickupTidyResolved !== false,
    tidyCats: tidySettings(settings).cats,
    syncMin: syncMinutes(settings),
    weekMode: settings.clickupWeekMode || "sun-sat",
    adminSyncToken: settings.adminSyncToken !== false,
    workdayEndHour: Number(settings.clickupWorkdayEndHour) || 0,
    extendedMode: extendedModeOf(settings),
    multiDay: multiDayOf(settings),
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
// task instead of the viewer's. Cached per user and range for an hour. `hint` (name/email)
// sharpens which match is preferred when someone has several Extra-named tasks.
// Which occurrence to look for depends on the range being asked about, so the
// cache is keyed per user PER RANGE (see extraRangeKey).
// Cached per person AND per exact range (first day - last day). It used to be
// keyed by "that week's Monday": a Sun-Sat "Due next week" (Oct 11-17) then got
// Mon Oct 5 - the same key as today (Fri Oct 9) - and kept showing today's
// finished Extra Task instead of next week's new one.
function extraRangeKey(userId, fromTs, toTs) {
  const day = (ts) => new Date(ts).setHours(0, 0, 0, 0);
  return String(userId) + ":" + day(fromTs) + ":" + day(toTs || fromTs);
}

// Detect the "Extra(s) Task(s)" occupying `range` for a SPECIFIC member (not just
// the signed-in user). This is what lets a department/Jack-scoped filter list
// Jack's own extra task instead of the viewer's. `hint` (name/email) sharpens
// which match is preferred when someone has several Extra-named tasks, and the
// range decides WHICH occurrence of the recurring task applies - see
// chooseExtraOccurrence in lib-clickup.js. Cached per user per week for an hour.
async function discoverExtraTaskFor(cfg, userId, hint, range) {
  const from = (range && Number(range.fromTs)) || Date.now();
  const to = (range && Number(range.toTs)) || from;
  const key = extraRangeKey(userId, from, to);
  const hit = extraTaskCache.get(key);
  // A FINISHED occurrence due before the range asked about is "the next one
  // isn't there yet" (ClickUp creates it a moment after the close): check again
  // after 5 minutes instead of keeping that answer for an hour, or Due next week
  // went on missing the new Extra Task that already existed.
  const stale = hit && hit.value && hit.value.done && Number(hit.value.dueDateMs) && Number(hit.value.dueDateMs) < from;
  if (hit && Date.now() - hit.at < (stale ? 5 * 60000 : EXTRA_TASK_CACHE_MS)) return hit.value;
  let value = null;
  try {
    // A lookup that FAILED (ClickUp rate limit, network) is not "this person has
    // no Extra task": it used to be cached as null for an hour, which emptied the
    // Extra task section for anyone who hit the limit at the wrong moment.
    value = await findExtraTaskByName({
      token: cfg.token,
      teamId: cfg.teamId,
      userId: userId != null ? userId : cfg.userId,
      usernameHint: hint || (String(userId) === String(cfg.userId) ? (cfg.username || cfg.email || "") : ""),
      // Only YOUR Extra Task gets the whole-task-list fallback; see findExtraTaskByName.
      fullScan: String(userId != null ? userId : cfg.userId) === String(cfg.userId),
      fromTs: from,
      toTs: to,
    });
  } catch (e) {
    // Keep the last answer we had (even if old); otherwise "unknown" (undefined),
    // and don't cache the failure - the next refresh tries again.
    return hit ? hit.value : undefined;
  }
  extraTaskCache.set(key, { at: Date.now(), value });
  if (value && value.listId && String(userId != null ? userId : cfg.userId) === String(cfg.userId)) {
    chrome.storage.local.set({ extraTaskMemo: { listId: value.listId, name: value.name || "", at: Date.now() } }).catch(() => {});
  }
  return value;
}

// The signed-in user's Extra Task for TODAY (the "Start Extra Task" button).
async function discoverExtraTask(cfg) {
  const from = new Date(); from.setHours(0, 0, 0, 0);
  const to = new Date(from); to.setHours(23, 59, 59, 999);
  return discoverExtraTaskFor(cfg, cfg.userId, cfg.username || cfg.email || "",
    { fromTs: from.getTime(), toTs: to.getTime() });
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
// One date range as the card shows it (tomorrow, a custom range, a day picked
// in the weekly chart): tasks DUE in the range, configured tasks' share, the
// range's full tracked time, and the tasks worked on there but not due there.
// Built once here and kept in state, so the dashboard, side panel, popup and the
// toolbar badge all show the same numbers at the same moment.
async function buildRangeBundle(cfg, settings, fromTs, toTs) {
  const d = await computeFilterData(cfg, settings, [], fromTs, toTs);
  cacheFilterResult(filterKey([], fromTs, toTs), d); // Explore / exports get it free
  // Spread mode: a started task due later belongs here for its share of these dates.
  const spreadOn = spreadOf(settings);
  const inRange = (t) => { const x = Number(t && t.dueDateMs) || 0; return (x >= fromTs && x <= toTs) || (spreadOn && t && t.extended && Number(t.estimateMs) > 0); };
  const tasks = (Array.isArray(d.tasks) ? d.tasks : []).filter(inRange);
  const deadlineTasks = Array.isArray(d.deadlineTasks) ? d.deadlineTasks : []; // already this range's share
  const sum = (a, k) => a.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
  const keep = new Set(tasks.map((t) => String(t && t.id)));
  const other = [], seen = new Set();
  for (const t of (Array.isArray(d.tasks) ? d.tasks : []).concat(Array.isArray(d.trackedTasks) ? d.trackedTasks : [])) {
    const id = String(t && t.id);
    if (!t || keep.has(id) || seen.has(id) || !(Number(t.spentMs) > 0)) continue;
    seen.add(id); other.push(t);
  }
  return {
    estimateMs: sum(tasks, "estimateMs") + sum(deadlineTasks, "dayEstimateMs"),
    spentMs: Math.max(Number(d.spentMs) || 0, sum(tasks, "spentMs") + sum(deadlineTasks, "spentMs")),
    fromTs, toTs, tasks, deadlineTasks, trackedTasks: other,
    taskCount: tasks.length + deadlineTasks.length,
    noEstimateCount: tasks.filter((t) => !Number(t.estimateMs)).length,
    at: Date.now(),
  };
}
// The saved filter's custom range (the Filter menu's own dates or a chart day).
// Due › Previous week / This month / Next month / Previous month (and This /
// Next week by start date): the same ranges the pages use.
function cuFilterPresetRange(f) {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const span = (a, b) => ({ fromTs: a.getTime(), toTs: b.getTime() });
  const sun = (off) => new Date(y, m, d - now.getDay() + off);
  if (f.duePrevWeek) return span(sun(-7), new Date(y, m, d - now.getDay() - 1, 23, 59, 59, 999));
  const k = f.dueThisMonth ? 0 : f.dueNextMonth ? 1 : f.duePrevMonth ? -1 : null;
  if (k === null) {
    if (f.dateBasis !== "start" && f.dateBasis !== "both") return null;
    if (f.dueNextWeek) return span(sun(7), new Date(y, m, d - now.getDay() + 13, 23, 59, 59, 999));
    if (f.dueWeek) return span(sun(0), new Date(y, m, d - now.getDay() + 6, 23, 59, 59, 999));
    return null;
  }
  return span(new Date(y, m + k, 1), new Date(y, m + k + 1, 0, 23, 59, 59, 999));
}
function cuFilterCustomRange(f) {
  if (!f) return null;
  const basis = f.dateBasis === "start" || f.dateBasis === "both" ? f.dateBasis : "due";
  if (!f.dueCustom) { const p = cuFilterPresetRange(f); return p ? { ...p, basis } : null; }
  const p = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0; };
  let a = p(f.customFrom);
  if (!a) return null;
  let b = p(f.customTo) || a;
  if (b < a) { const x = a; a = b; b = x; }
  const end = new Date(b); end.setHours(23, 59, 59, 999);
  return { fromTs: a, toTs: end.getTime(), basis };
}
// A range bundle by due date (ClickUp searches by due date), or by start date /
// both. ClickUp can't search by start date, so "start" takes the open-tasks list
// (already kept for Insights / Bulk edit) plus the range's own rows; "both" is
// the due-date rows whose start date is in the range too.
async function buildBasisBundle(cfg, settings, r) {
  const due = await buildRangeBundle(cfg, settings, r.fromTs, r.toTs);
  if (!r.basis || r.basis === "due") return { ...due, basis: "due" };
  const inR = (x) => { x = Number(x) || 0; return x >= r.fromTs && x <= r.toTs; };
  let rows = (due.tasks || []).concat(due.trackedTasks || []).filter((t) => t && inR(t.startDateMs));
  const have = new Set(rows.map((t) => String(t.id)));
  rows = rows.filter((t) => r.basis === "start" || inR(t.dueDateMs));
  if (r.basis === "start") {
    const open = await getOpenTasks(cfg, false).catch(() => null);
    const extra = ((open && open.data && open.data.tasks) || []).filter((t) => inR(t.startDateMs) && !have.has(String(t.id))).map((t) => ({ ...t, type: "due" }));
    if (extra.length) {
      const holder = { tasks: extra };
      await annotateClients(cfg.token, holder, settings.cuClientLevel || "auto").catch(() => {});
      rows = rows.concat(holder.tasks);
    }
  }
  const sum = (k) => rows.reduce((n, t) => n + (Number(t && t[k]) || 0), 0);
  return { fromTs: r.fromTs, toTs: r.toTs, basis: r.basis, at: Date.now(), tasks: rows, deadlineTasks: [], trackedTasks: [],
    estimateMs: sum("estimateMs"), spentMs: sum("spentMs"), taskCount: rows.length, noEstimateCount: rows.filter((t) => !Number(t.estimateMs)).length };
}
// Recently used ranges (a month, Previous week, a custom range, by start date…)
// are kept ready: the last few are rebuilt quietly in the slow lane after a timed
// refresh, so switching back to one shows at once (and refreshes behind it when
// it's older than a few minutes). rangeCache: "from-to-basis" -> bundle.
const rangeCache = new Map();
const RANGE_FRESH_MS = 5 * 60000, RANGE_KEEP_MS = 30 * 60000, RECENT_MAX = 3;
const rangeKey = (r) => r.fromTs + "-" + r.toTs + "-" + (r.basis || "due");
function rangeCachePut(b) { if (b && b.fromTs && b.toTs) { rangeCache.set(rangeKey(b), b); if (rangeCache.size > 8) rangeCache.delete(rangeCache.keys().next().value); } }
// The filter pieces that make a range (re-worked out each time, so "This month" moves on with the calendar).
const rangeSpec = (f) => { const o = {}; for (const k of ["dueWeek", "dueNextWeek", "duePrevWeek", "dueThisMonth", "dueNextMonth", "duePrevMonth", "dueCustom", "customFrom", "customTo", "dateBasis"]) if (f && f[k]) o[k] = f[k]; return o; };
async function rememberRecentRange(f) {
  if (!cuFilterCustomRange(f)) return;
  const spec = rangeSpec(f), key = JSON.stringify(spec);
  const { cuRecentRanges } = await chrome.storage.local.get("cuRecentRanges");
  const list = (Array.isArray(cuRecentRanges) ? cuRecentRanges : []).filter((x) => JSON.stringify(x) !== key);
  list.unshift(spec);
  await chrome.storage.local.set({ cuRecentRanges: list.slice(0, RECENT_MAX) });
}
let prefetching = false;
async function prefetchRecentRanges() {
  if (prefetching) return;
  prefetching = true;
  const stop = startKeepAlive();
  try {
    const { cuRecentRanges, cuFilter, rateLimitedUntil } = await chrome.storage.local.get(["cuRecentRanges", "cuFilter", "rateLimitedUntil"]);
    if (Number(rateLimitedUntil) > Date.now()) return;
    const cfg0 = await getClickupConfig();
    if (!cfg0 || !cfg0.token || !cfg0.teamId || cfg0.userId == null) return;
    const cfg = { ...cfg0, token: bgToken(cfg0.token) };
    const settings = await getSettings();
    const cur = cuFilterCustomRange(cuFilter);
    for (const spec of Array.isArray(cuRecentRanges) ? cuRecentRanges : []) {
      const r = cuFilterCustomRange(spec);
      if (!r || (cur && rangeKey(cur) === rangeKey(r))) continue; // the current one is built by the refresh itself
      const have = rangeCache.get(rangeKey(r));
      if (have && Date.now() - (have.at || 0) < RANGE_KEEP_MS) continue;
      try { rangeCachePut({ ...(await buildBasisBundle(cfg, settings, r)), basis: r.basis }); } catch (e) { if (e && e.status === 429) break; }
    }
  } catch (e) {} finally { stop(); prefetching = false; }
}
// Build the custom-range bundle now (the filter just changed) and put it in state.
let customBuild = null;
async function refreshCustomBundle() {
  if (customBuild) return customBuild;
  customBuild = (async () => {
    const stop = startKeepAlive();
    try {
      const { cuFilter } = await chrome.storage.local.get("cuFilter");
      const r = cuFilterCustomRange(cuFilter);
      if (!r) return;
      const cfg = await getClickupConfig();
      if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return;
      rememberRecentRange(cuFilter).catch(() => {});
      const prev = (await getClickupState()) || {};
      if (prev.custom && prev.custom.fromTs === r.fromTs && prev.custom.toTs === r.toTs && (prev.custom.basis || "due") === r.basis && Date.now() - (prev.custom.at || 0) < RANGE_FRESH_MS) return;
      // Kept ready ahead of time: shown at once; rebuilt behind it when it's a few minutes old.
      const ready = rangeCache.get(rangeKey(r));
      if (ready && Date.now() - (ready.at || 0) < RANGE_KEEP_MS) {
        const cur0 = (await getClickupState()) || {};
        await setClickupState({ ...cur0, custom: ready });
        await updateBadge().catch(() => {});
        if (Date.now() - (ready.at || 0) < RANGE_FRESH_MS) return;
      }
      const custom = await buildBasisBundle(cfg, await getSettings(), r);
      await stampFamily({ custom }, cfg, false).catch(() => {}); // names already known only
      rangeCachePut(custom);
      const cur = (await getClickupState()) || {};
      const still = cuFilterCustomRange((await chrome.storage.local.get("cuFilter")).cuFilter);
      if (still && rangeKey(still) === rangeKey(r)) await setClickupState({ ...cur, custom }); // not if another range was picked meanwhile
      await updateBadge().catch(() => {});
    } catch (e) {} finally { stop(); customBuild = null; }
  })();
  return customBuild;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.cuFilter) { refreshCustomBundle().catch(() => {}); updateBadge().catch(() => {}); }
});
async function computeFilterData(cfg0, settings, assigneeIds, fromTs, toTs) {
  // Someone is waiting for this (Explore, a picked day): wait for ClickUp's slots
  // rather than fail when the refresh has used most of the minute.
  const cfg = { ...cfg0, token: patientToken(cfg0.token), adminToken: cfg0.adminToken ? patientToken(cfg0.adminToken) : cfg0.adminToken };
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
    const ex = await discoverExtraTaskFor(cfg, u, memberHint.get(u) || "", { fromTs, toTs });
    if (ex && ex.url) extraUrls.push(ex.url);
  }
  const deadlineTaskUrls = [];
  for (const u of configuredUrls.concat(extraUrls)) {
    const tid = parseTaskIdFromUrl(u);
    if (tid && !deadlineTaskUrls.some((x) => parseTaskIdFromUrl(x) === tid)) deadlineTaskUrls.push(u);
  }
  const extendedMode = extendedModeOf(settings);
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
    fromTs, toTs, deadlineTaskUrls, extendedMode, spread: spreadOf(settings),
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
// A due date changed from the extension: move that task in the saved state at
// once (Today list, This week by day, the week / next-week / range bundles), so
// every card shows it straight away instead of after the whole refresh. The full
// refresh still runs behind it. Spread (multi-day) rows, configured tasks and the
// Extra Task are left to that refresh.
async function patchStateDue(taskId, dueMs) {
  const st = await getClickupState();
  if (!st || !taskId) return;
  const id = String(taskId), due = Number(dueMs) || 0;
  const day = (ms) => new Date(Number(ms)).setHours(0, 0, 0, 0);
  const same = (t) => t && String(t.id != null ? t.id : t.taskId) === id;
  const plain = (t) => !t.extended && t.type !== "cfg" && t.type !== "extra" && !("dayEstimateMs" in t);
  // A row to copy onto a new day (any plain copy of it).
  let tpl = null;
  const lists = [st.tasks, st.thisWeek && st.thisWeek.tasks, st.nextWeek && st.nextWeek.tasks, st.custom && st.custom.tasks];
  if (st.weekly && Array.isArray(st.weekly.perDay)) for (const p of st.weekly.perDay) lists.push(p && p.tasks);
  for (const l of lists) for (const t of l || []) if (same(t) && plain(t)) { tpl = tpl || t; }
  if (!tpl) return; // not a plain row anywhere: the refresh handles it
  const moved = { ...tpl, dueDateMs: due || null };
  const est = Number(tpl.estimateMs) || 0;
  const inDay = (ts) => !!due && day(due) === day(ts);
  // Today list
  const today = Date.now();
  if (Array.isArray(st.tasks)) {
    const had = st.tasks.some(same);
    if (had && !inDay(today)) { st.tasks = st.tasks.filter((t) => !same(t)); st.estimateMs = Math.max(0, (Number(st.estimateMs) || 0) - est); }
    else if (!had && inDay(today)) { st.tasks = st.tasks.concat([moved]); st.estimateMs = (Number(st.estimateMs) || 0) + est; }
    else st.tasks = st.tasks.map((t) => (same(t) ? { ...t, dueDateMs: due || null } : t));
  }
  // This week by day
  const wk = st.weekly;
  if (wk && Array.isArray(wk.perDay)) {
    for (const p of wk.perDay) {
      if (!p) continue;
      const rows = Array.isArray(p.tasks) ? p.tasks : [];
      const had = rows.some((t) => same(t) && plain(t));
      if (had && !inDay(p.ts)) { p.tasks = rows.filter((t) => !(same(t) && plain(t))); p.estimateMs = Math.max(0, (Number(p.estimateMs) || 0) - est); }
      else if (!had && inDay(p.ts)) { p.tasks = rows.concat([moved]); p.estimateMs = (Number(p.estimateMs) || 0) + est; }
    }
    if (wk.today && wk.friday) {
      const ts = new Date().setHours(0, 0, 0, 0);
      const sum = (arr) => arr.reduce((n, p) => n + (Number(p.estimateMs) || 0), 0);
      wk.today = { ...wk.today, estimateMs: sum(wk.perDay.filter((p) => p.ts <= ts)) };
      wk.friday = { ...wk.friday, estimateMs: sum(wk.perDay) };
    }
    wk.at = Date.now();
  }
  // Range bundles (this / next week, the filter's range)
  for (const b of [st.thisWeek, st.nextWeek, st.custom]) {
    if (!b || !Array.isArray(b.tasks) || !b.fromTs || !b.toTs) continue;
    if (b.basis && b.basis !== "due") continue; // by start date: the refresh decides
    const inside = !!due && due >= b.fromTs && due <= b.toTs;
    const had = b.tasks.some(same);
    if (had && !inside) { b.tasks = b.tasks.filter((t) => !same(t)); b.estimateMs = Math.max(0, (Number(b.estimateMs) || 0) - est); }
    else if (!had && inside) { b.tasks = b.tasks.concat([moved]); b.estimateMs = (Number(b.estimateMs) || 0) + est; }
    else b.tasks = b.tasks.map((t) => (same(t) ? { ...t, dueDateMs: due || null } : t));
    b.at = Date.now();
  }
  st.at = Date.now();
  await setClickupState(st);
}
// This week by day › drag: the whole batch is handed over here, so it finishes
// even if the page is reloaded or closed. Every page shows it from storage
// (cuPendingMoves): still moving (on the new day, marked), saved, or refused.
let movesRunning = false;
async function pendingMoves() { const g = await chrome.storage.local.get("cuPendingMoves"); return g && g.cuPendingMoves && Array.isArray(g.cuPendingMoves.items) ? g.cuPendingMoves : { items: [] }; }
async function savePendingMoves(p) { await chrome.storage.local.set({ cuPendingMoves: { ...p, at: Date.now() } }); }
async function runPendingMoves() {
  if (movesRunning) return;
  movesRunning = true;
  const stop = startKeepAlive();
  let any = false;
  try {
    const cfg = await getClickupConfig();
    for (;;) {
      const p = await pendingMoves();
      const it = p.items.find((x) => x.status === "pending");
      if (!it) break;
      try {
        if (!cfg || !cfg.token) throw new Error("ClickUp isn't connected.");
        if (it.clear) await setTaskDueDate(cfg.token, it.id, null, null); // Undo of a task that had no due date
        else if (Number(it.startMs) > 0) await setTaskDates(cfg.token, it.id, Number(it.startMs), Number(it.dueMs));
        else { const task = await getTaskById(cfg.token, it.id).catch(() => null); await setTaskDueDate(cfg.token, it.id, Number(it.dueMs), task ? task.dueDateHasTime : null); }
        await patchStateDue(it.id, it.clear ? 0 : Number(it.dueMs)).catch(() => {});
        it.status = "done"; any = true;
      } catch (e) { it.status = "failed"; it.error = String((e && e.message) || e); }
      it.doneAt = Date.now();
      const cur = await pendingMoves();
      cur.items = cur.items.map((x) => (x.key === it.key ? it : x));
      await savePendingMoves(cur);
    }
  } finally {
    stop(); movesRunning = false;
    if (any) { clearFilterCache(); refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {}); }
    // Finished ones stay visible for a little while (the "Moved ✓" line), then go.
    setTimeout(async () => { const p = await pendingMoves(); const keep = p.items.filter((x) => x.status === "pending" || Date.now() - (x.doneAt || 0) < 60000); if (keep.length !== p.items.length) await savePendingMoves({ ...p, items: keep }); }, 61000);
  }
}
// A task changed from the extension (status, done, priority, estimate): change
// it in the saved state at once, so every card shows it before the full refresh.
async function patchStateTask(taskId, fields) {
  const st = await getClickupState();
  if (!st || !taskId || !fields) return;
  const id = String(taskId), seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { o.forEach(walk); return; }
    const oid = o.id != null ? o.id : o.taskId;
    if (oid != null && String(oid) === id && ("name" in o || "status" in o)) {
      for (const [k, v] of Object.entries(fields)) {
        if (k === "estimateMs" && ("dayEstimateMs" in o || o.extended || o.type === "cfg")) continue; // a share keeps its share
        o[k] = v;
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(st);
  st.at = Date.now();
  await setClickupState(st);
}
// Family on the rows: a subtask carries its parent's name (parentName), a parent
// how many of its subtasks are in the loaded lists (childCount). Parent names are
// remembered (storage parentNames, 7 days); up to 15 new ones are looked up per
// refresh, only when fetch is allowed - so it costs almost nothing.
async function stampFamily(state, cfg, fetchNew) {
  if (!state) return;
  const rows = [], seen = new Set();
  const walk = (o) => {
    if (!o || typeof o !== "object" || seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o.id != null && typeof o.name === "string") rows.push(o);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v);
  };
  walk(state);
  const kids = new Map(); // parentId -> Set(child ids)
  for (const t of rows) if (t.parentId) { const k = String(t.parentId); if (!kids.has(k)) kids.set(k, new Set()); kids.get(k).add(String(t.id)); }
  const g = await chrome.storage.local.get("parentNames").catch(() => ({}));
  const names = g && g.parentNames && typeof g.parentNames === "object" ? { ...g.parentNames } : {};
  const known = new Map(rows.map((t) => [String(t.id), t.name])); // a parent that is itself listed
  const WEEK = 7 * 86400000;
  let changed = false;
  if (fetchNew && cfg && cfg.token) {
    const want = [...kids.keys()].filter((id) => !known.has(id) && !(names[id] && Date.now() - (names[id].at || 0) < WEEK)).slice(0, 15);
    for (const id of want) {
      try { const t = await getTaskById(cfg.token, id); if (t && t.name) { names[id] = { name: t.name, at: Date.now() }; changed = true; } } catch (e) { if (e && e.status === 429) break; }
    }
  }
  for (const [id, nm] of known) if (kids.has(id) && (!names[id] || names[id].name !== nm)) { names[id] = { name: nm, at: Date.now() }; changed = true; }
  // keep it small: the newest 400
  const keys = Object.keys(names);
  if (keys.length > 400) { keys.sort((a, b) => (names[b].at || 0) - (names[a].at || 0)).slice(400).forEach((k) => delete names[k]); changed = true; }
  if (changed) await chrome.storage.local.set({ parentNames: names }).catch(() => {});
  for (const t of rows) {
    if (t.parentId && names[String(t.parentId)]) t.parentName = names[String(t.parentId)].name;
    const c = kids.get(String(t.id));
    if (c && c.size) t.childCount = c.size; else if ("childCount" in t) delete t.childCount;
  }
}
// One task in two snapshots with different due days - e.g. its date changed
// between the today fetch and the week fetch, or ClickUp's search still had the
// old date for a moment: the NEWER snapshot wins and the older copy is dropped
// (with its estimate), so a task never shows on two days at once.
function dropStaleDueRows(state) {
  if (!state) return;
  const day = (ms) => new Date(Number(ms)).setHours(0, 0, 0, 0);
  const idOf = (t) => (t && t.id != null ? String(t.id) : "");
  const dated = (t) => idOf(t) && Number(t.dueDateMs) > 0 && !t.extended && t.type !== "cfg" && t.type !== "extra";
  const wk = state.weekly && Array.isArray(state.weekly.perDay) ? state.weekly : null;
  const sources = [[state.tasks, state.at], [state.thisWeek && state.thisWeek.tasks, state.thisWeek && state.thisWeek.at],
    [state.nextWeek && state.nextWeek.tasks, state.nextWeek && state.nextWeek.at], [state.custom && state.custom.tasks, state.custom && state.custom.at]];
  if (wk) for (const p of wk.perDay) sources.push([p && p.tasks, p && p.live ? state.at : wk.at]);
  const best = new Map(); // id -> { due, at } from the newest snapshot that has it
  for (const [rows, at] of sources) {
    const a = Number(at) || 0;
    if (!a || !Array.isArray(rows)) continue;
    for (const t of rows) { if (!dated(t)) continue; const cur = best.get(idOf(t)); if (!cur || a > cur.at) best.set(idOf(t), { due: day(t.dueDateMs), at: a }); }
  }
  const stale = (t, at) => { if (!dated(t)) return false; const b = best.get(idOf(t)); return !!b && b.at > (Number(at) || 0) && b.due !== day(t.dueDateMs); };
  // Drops the stale rows from a list; returns the estimate that went with them.
  const prune = (holder, key, at) => {
    const rows = holder && holder[key];
    if (!Array.isArray(rows)) return 0;
    let less = 0;
    const keep = rows.filter((t) => { if (stale(t, at)) { less += Number(t.estimateMs) || 0; return false; } return true; });
    if (keep.length !== rows.length) holder[key] = keep;
    return less;
  };
  const lessToday = prune(state, "tasks", state.at);
  if (lessToday) state.estimateMs = Math.max(0, (Number(state.estimateMs) || 0) - lessToday);
  for (const b of [state.thisWeek, state.nextWeek, state.custom]) { const l = prune(b, "tasks", b && b.at); if (l) b.estimateMs = Math.max(0, (Number(b.estimateMs) || 0) - l); }
  if (wk) {
    let changed = false;
    for (const p of wk.perDay) { const l = prune(p, "tasks", p && p.live ? state.at : wk.at); if (l) { p.estimateMs = Math.max(0, (Number(p.estimateMs) || 0) - l); changed = true; } }
    if (changed && wk.today && wk.friday) {
      const ts = new Date().setHours(0, 0, 0, 0);
      const sum = (arr) => arr.reduce((n, p) => n + (Number(p.estimateMs) || 0), 0);
      wk.today = { ...wk.today, estimateMs: sum(wk.perDay.filter((p) => p.ts <= ts)) };
      wk.friday = { ...wk.friday, estimateMs: sum(wk.perDay) };
    }
  }
}
// Changes made in ClickUp itself (a new estimate, due or start date, status,
// name, priority) reach every list here within one refresh: the cached bundles
// (this week, Mon-Fri, next week, tomorrow, the custom range, today) are only
// re-fetched every 15-60 minutes, so they kept the old values and the same task
// could show "no est" / Oct 30 in one card and 30m / Today in another. One
// request per refresh asks ClickUp for the tasks changed since the last one, and
// every copy of those tasks is patched; a task that moved out of a list's dates
// leaves it, one that moved into a cached list's dates makes that list re-fetch
// on the next refresh. storage cuChangedAt = when the last such check ran.
// Returns the time to store as cuChangedAt once the patched state is saved (0: nothing read).
async function patchChangedTasks(state, cfg) {
  if (!state || !cfg || !cfg.token || !cfg.teamId) return 0;
  const { cuChangedAt } = await chrome.storage.local.get("cuChangedAt");
  const now = Date.now();
  const since = Math.max(Number(cuChangedAt) || 0, now - 2 * 3600000) - 90000; // a little overlap; never more than 2h back
  const me = cfg.userId != null ? String(cfg.userId) : "";
  const fresh = new Map();
  for (let page = 0; page < 3; page++) { // a busy team after a long sleep: a few pages, not one
    const r = await fetchTeamTasksPage(cfg.token, cfg.teamId, page, since);
    for (const x of (r && r.tasks) || []) {
      if (!x || x.id == null || fresh.has(String(x.id))) continue;
      fresh.set(String(x.id), {
        name: x.name || "", status: (x.status && x.status.status) || "", done: isTaskDone(x), priority: cuPriorityName(x),
        startDateMs: Number(x.start_date) || 0, dueDateMs: Number(x.due_date) || 0, estimateMs: Number(x.time_estimate) || 0,
        // Mine (assigned to me) - only these can make one of my lists fetch again.
        mine: !!me && (Array.isArray(x.assignees) ? x.assignees : []).some((a) => a && String(a.id) === me),
        extra: /^extras?\s+tasks?\b/i.test(x.name || ""),
      });
    }
    if (!r || r.last) break;
  }
  if (fresh.size) applyChangedTasks(state, fresh);
  return now;
}
// Patches every copy of the changed tasks (pure, so a test can drive it).
function applyChangedTasks(state, fresh) {
  const day = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).setHours(0, 0, 0, 0) : 0);
  const idOf = (t) => String((t && (t.id != null ? t.id : t.taskId)) || "");
  // A row whose estimate is the whole task's (not a day's share or a configured task's).
  const fullEst = (t) => !("dayEstimateMs" in t) && !("totalEstimateMs" in t) && t.type !== "cfg" && t.type !== "extra" && !t.extended;
  const t0 = new Date().setHours(0, 0, 0, 0), t1 = t0 + 86399999;
  let n = 0;
  const bundles = [
    { b: state, from: t0, to: t1 }, // today
    { b: state.todayFilter }, { b: state.tomorrow, ranged: true }, { b: state.thisWeek, ranged: true, refetch: true },
    { b: state.thisWorkweek, ranged: true }, { b: state.nextWeek, ranged: true, refetch: true }, { b: state.custom, ranged: true, refetch: true },
  ];
  for (const { b, from, to, ranged: ranged0, refetch: refetch0 } of bundles) {
    if (!b) continue;
    // A custom list by START date (or both) isn't bounded by due dates: patch only.
    const byDue = !b.basis || b.basis === "due";
    const ranged = ranged0 && byDue, refetch = refetch0 && byDue;
    const lo = from || (ranged ? Number(b.fromTs) || 0 : 0), hi = to || (ranged ? Number(b.toTs) || 0 : 0);
    const inside = (ms) => !lo || !hi || (day(ms) >= day(lo) && day(ms) <= hi);
    for (const key of ["tasks", "deadlineTasks", "trackedTasks"]) {
      const rows = b[key];
      if (!Array.isArray(rows)) continue;
      const keep = [];
      for (const t of rows) {
        const f = fresh.get(idOf(t));
        if (!f) { keep.push(t); continue; }
        // Its due date left this list's dates (only the plain "due in these dates" list): it goes.
        if (key === "tasks" && lo && hi && f.dueDateMs && !inside(f.dueDateMs) && day(f.dueDateMs) !== day(t.dueDateMs)) {
          if (fullEst(t)) b.estimateMs = Math.max(0, (Number(b.estimateMs) || 0) - (Number(t.estimateMs) || 0));
          n++; continue;
        }
        if (key === "tasks" && fullEst(t) && f.estimateMs !== (Number(t.estimateMs) || 0)) {
          b.estimateMs = Math.max(0, (Number(b.estimateMs) || 0) + f.estimateMs - (Number(t.estimateMs) || 0));
          t.estimateMs = f.estimateMs; t.hasEstimate = f.estimateMs > 0; n++;
        }
        for (const k of ["name", "status", "done", "priority", "startDateMs", "dueDateMs"]) {
          const v = k === "startDateMs" || k === "dueDateMs" ? (f[k] || null) : f[k];
          if (v !== undefined && t[k] !== v && !(v === null && !t[k])) { t[k] = v; n++; }
        }
        keep.push(t);
      }
      if (keep.length !== rows.length) b[key] = keep;
    }
    if ("taskCount" in b && Array.isArray(b.tasks)) b.taskCount = b.tasks.length;
    // Moved INTO this cached list's dates but not in it yet: re-fetch it next time.
    if (refetch && lo && hi) {
      const have = new Set((b.tasks || []).map(idOf));
      for (const [id, f] of fresh) if (f.mine && !f.extra && f.dueDateMs && inside(f.dueDateMs) && !f.done && !have.has(id)) { b.stale = true; break; }
    }
  }
  // This week by day: names / status / priority straight away; its day shares
  // (estimates, which day) are re-worked on the next refresh when a task in it changed.
  const wk = state.weekly;
  if (wk && Array.isArray(wk.perDay)) {
    let touched = false;
    for (const p of wk.perDay) for (const t of (p && p.tasks) || []) {
      const f = fresh.get(idOf(t));
      if (!f) continue;
      for (const k of ["name", "status", "done", "priority"]) if (t[k] !== f[k]) { t[k] = f[k]; n++; }
      // Its day shares re-worked only for my own plain rows (not the configured / Extra ones, whose numbers differ by design).
      if (f.mine && t.type !== "cfg" && t.type !== "extra" && !t.extended && (f.estimateMs !== (Number(t.totalEstimateMs != null ? t.totalEstimateMs : t.estimateMs) || 0) || day(f.dueDateMs) !== day(t.dueDateMs))) touched = true;
    }
    if (touched) wk.stale = true;
  }
  return n;
}
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
    const res = await cuRawFetch(cfg.token, "https://api.clickup.com/api/v2" + path, { headers: { Authorization: cfg.token } });
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

  // 3b) The team's client list (Admin > Client sites for everyone) is the most
  //     reliable source: a client whose name matches gets that exact site, and
  //     listed clients with no ClickUp tasks are shown too.
  const { teamSites } = await chrome.storage.local.get("teamSites");
  const teamList = teamSites && Array.isArray(teamSites.list) ? teamSites.list : [];
  if (teamList.length) {
    const coreKey = (n) => String(n || "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !SITE_NAME_STOPWORDS.has(w)).join("");
    const byKey = new Map();
    for (const s of teamList) {
      for (const k of [siteNameKey(s.name), coreKey(s.name)]) if (k && k.length >= 3 && !byKey.has(k)) byKey.set(k, s);
    }
    const used = new Set();
    for (const c of out) {
      const s = byKey.get(c.key) || byKey.get(coreKey(c.name));
      if (!s) continue;
      used.add(s.url);
      c.candidates = [s.url, ...c.candidates.filter((u) => siteHostKey(u) !== siteHostKey(s.url))].slice(0, 5);
      c.url = s.url;
      c.confidence = "high";
      c.source = "team client list";
    }
    for (const s of teamList) {
      if (used.has(s.url) || !s.name) continue;
      out.push({ name: s.name, key: siteNameKey(s.name), taskCount: 0, url: s.url, confidence: "high", source: "team client list", candidates: [s.url] });
    }
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

// ---------- "Waiting on others" (dependency) detection ----------
// A task assigned to me is WAITING when it has a subtask assigned to someone else
// that is still open, and none of MY subtasks under it are open (my part is done).
// It is BLOCKED (red) when such a subtask is already past its due date.
// Subtasks are fetched per parent (team /task?parent=…), cached 15 min, and at
// most 25 new parents are looked up per pass to stay far from ClickUp's limits.
const WAIT_TTL_MS = 15 * 60 * 1000;
const WAIT_MAX_FETCH = 25;
let waitPassRunning = false;
async function refreshWaitingInfo() {
  if (waitPassRunning) return;
  waitPassRunning = true;
  try {
    const cfg = await getClickupConfig();
    if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return;
    const me = String(cfg.userId);
    const st = await getClickupState();
    if (!st) return;
    // Candidate parents: my top-level, not-done rows in every bundle the UI shows.
    const ids = new Set();
    const parentDue = {}; // parentId -> its own due date (ms), for the selfBlock pass below
    const parentName = {}; // parentId -> its name (a schedule / plan "container" isn't flagged)
    const collect = (arr) => {
      for (const t of Array.isArray(arr) ? arr : []) {
        const id = t && (t.id != null ? t.id : t.taskId);
        if (id != null && !t.isSubtask && !t.done) {
          const key = String(id);
          ids.add(key);
          const d = Number(t.dueDateMs) || 0;
          if (d && !parentDue[key]) parentDue[key] = d;
          if (!parentName[key]) parentName[key] = String(t.name || "");
        }
      }
    };
    collect(st.tasks); collect(st.deadlineTasks);
    for (const b of [st.todayFilter, st.thisWeek, st.nextWeek, overdueCache && overdueCache.data]) {
      if (b) { collect(b.tasks); collect(b.deadlineTasks); }
    }
    const { cuWaitCache2: cache0 } = await chrome.storage.local.get("cuWaitCache2");
    const cache = cache0 && typeof cache0 === "object" ? cache0 : {};
    const now = Date.now();
    let fetched = 0;
    for (const id of ids) {
      const c = cache[id];
      if (c && now - c.at < WAIT_TTL_MS) continue;
      if (fetched >= WAIT_MAX_FETCH) break;
      fetched++;
      try {
        const subs = await getSubtasksOfParent(cfg.token, cfg.teamId, id, null); // every assignee
        cache[id] = {
          at: now,
          subs: subs.map((x) => ({
            id: String(x.id), name: x.name || "(subtask)", url: taskUrlFor(x.id), done: isTaskDone(x),
            due: Number(x.due_date) || null,
            who: (Array.isArray(x.assignees) ? x.assignees : []).map((a) => ({ id: String(a && a.id), name: (a && (a.username || a.email)) || "someone" })),
          })),
        };
      } catch (e) {
        if (e && e.status === 429) break; // rate-limited: try the rest next pass
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const k of Object.keys(cache)) if (!ids.has(k) && now - cache[k].at > 24 * 3600 * 1000) delete cache[k];
    await chrome.storage.local.set({ cuWaitCache2: cache });
    chrome.storage.local.remove("cuWaitCache").catch(() => {}); // pre-fix cache (wrong subtasks)

    const todayStart = new Date().setHours(0, 0, 0, 0);
    const waiting = {};
    for (const id of ids) {
      const c = cache[id];
      if (!c || !c.subs || !c.subs.length) continue;
      const mineOpen = c.subs.some((x) => !x.done && x.who.some((a) => a.id === me));
      if (mineOpen) continue; // still my own work to do
      const others = c.subs.filter((x) => !x.done && x.who.length && !x.who.some((a) => a.id === me));
      if (!others.length) continue;
      waiting[id] = {
        blockers: others.map((x) => ({
          name: x.name, url: x.url, who: x.who[0].name, due: x.due,
          overdue: !!x.due && new Date(x.due).setHours(0, 0, 0, 0) < todayStart,
        })),
      };
    }
    // Its OWN open subtasks: a parent can't be completed while they're open (a
    // dependency in all but name), whoever they're with. later / parentOverdue mark
    // the worse cases (subtasks due after it, or it's already past due); pending says
    // which ones. A schedule / plan "container" (a month's list, 6+ unnumbered
    // subtasks) isn't flagged: it's closed when its separate tasks are, by design.
    // Same cache, no fetch.
    for (const id of ids) {
      const c = cache[id];
      if (!c || !c.subs || !c.subs.length) continue;
      if (holdContainer({ name: parentName[id] || "", subs: c.subs })) continue;
      const pDue = parentDue[id] || 0;
      const open = c.subs.filter((x) => !x.done);
      if (!open.length) continue;
      const later = pDue ? open.filter((x) => x.due && x.due > pDue) : [];
      const parentOverdue = !!pDue && pDue < todayStart;
      const latestDueMs = open.reduce((m, x) => (x.due && x.due > m ? x.due : m), 0) || null;
      const pending = open.slice(0, 4).map((x) => ({ id: x.id, name: String(x.name || "(subtask)").slice(0, 90), url: x.url, who: x.who.some((a) => a.id === me) ? "you" : ((x.who[0] && x.who[0].name) || ""), due: x.due || null }));
      const entry = waiting[id] || {};
      entry.selfBlock = { open: open.length, total: c.subs.length, later: later.length, latestDueMs, parentOverdue, pending };
      waiting[id] = entry;
    }
    const st2 = await getClickupState();
    if (st2 && JSON.stringify(st2.waiting || {}) !== JSON.stringify(waiting)) {
      await setClickupState({ ...st2, waiting });
    }
  } finally {
    waitPassRunning = false;
  }
}

// Coalescing wrapper around the actual refresh. Prevents the ClickUp API from
// being hammered into a 429: (1) auto (alarm) refreshes honour a persisted 429
// cooldown and a minimum spacing; (2) a single in-flight refresh is shared by
// all concurrent callers (alarm + popup-open + task action) instead of stacking.
let clickupRefreshInFlight = null;
// Allowed background sync intervals (minutes); anything else falls back to 5.
const SYNC_CHOICES = [2, 3, 5, 10, 15, 30];
function syncMinutes(s) {
  const n = Number(s && s.clickupSyncMin);
  return SYNC_CHOICES.includes(n) ? n : 5;
}

// Bumped by every setting change that alters what the lists hold. A refresh
// started before the change notices on its way out and throws its result away
// (it would put tasks counted the old way back on screen), so the new one never
// has to wait for it.
let settingsGen = 0;
let rebuildTimer = 0, rebuildWaiters = [];
// A setting that changes what the task lists and cards hold. The pages show
// "Updating…" (cuRebuild, read by task-sort.js) in two stages:
//   phase "today" - nothing is rebuilt yet: lists hide their rows, number cards dim;
//   phase "week"  - today's list and numbers are saved (onToday): they come back,
//                   the week cards / week lists stay dimmed until the rest is in;
//   (removed)     - everything is saved.
// Quick clicks back and forth share one refresh; an older rebuild never clears
// the mark of a newer one.
function rebuildListsFor(what, opts) {
  const myGen = ++settingsGen;
  const mark = (phase) => { if (settingsGen === myGen) chrome.storage.local.set({ cuRebuild: { at: Date.now(), what, phase } }).catch(() => {}); };
  const done = () => { if (settingsGen === myGen) chrome.storage.local.remove("cuRebuild").catch(() => {}); };
  mark("today");
  return new Promise((resolve) => {
    rebuildWaiters.push(resolve);
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      const waiters = rebuildWaiters; rebuildWaiters = [];
      refreshClickup({ ...opts, after: true, onToday: () => mark("week") })
        .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }))
        .then((r) => { done(); for (const w of waiters) w(r); });
    }, 400);
  });
}
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
      // Guard = interval minus a minute (5 min -> 4 min, as before).
      const minGap = (syncMinutes(await getSettings().catch(() => ({}))) - 1) * 60000;
      if (prev.at && Date.now() - prev.at < minGap) {
        return { ok: false, reason: "too-soon" };
      }
    }
  }
  // Share one in-flight refresh across concurrent triggers - except after a
  // setting changed (opts.after): the running one was started with the OLD
  // setting and will throw its result away (settingsGen), so start the new one
  // now instead of waiting behind it. (Joining it kept "Spread over days" rows -
  // tasks due later - under "Due today" after switching to "By due date"; waiting
  // for it made "Updating the list…" last over a minute.)
  if (clickupRefreshInFlight && !opts.after) return clickupRefreshInFlight;
  const run = (async () => {
    try {
      const r = await refreshClickupImpl(opts);
      refreshWaitingInfo().catch(() => {}); // "Waiting on …" chips (cached, throttled)
      if (opts && opts.viaAlarm && r && r.ok !== false) prefetchRecentRanges().catch(() => {});
      return r;
    } finally {
      if (clickupRefreshInFlight === run) clickupRefreshInFlight = null;
    }
  })();
  clickupRefreshInFlight = run;
  return run;
}

// Opening the popup or the options page asks for a forced rebuild of the weekly
// summary and the week/day bundles, so an estimate just changed in ClickUp shows
// up straight away instead of sitting behind a 15-30 minute cache. Forced must
// still mean "at most once a minute" though: each bundle is a full paginated
// ClickUp fan-out, and reopening the popup a few times in a row was burning
// through the rate limit ("ClickUp rate limit hit - try again in a minute").
const FORCE_REBUILD_MIN_MS = 60000;
// How the weekly bundle counts (bump when the rule changes so cached copies rebuild).
// 5 = the filter's Sun-Sat week, counted by the multi-day setting (by due date /
// spread). Stamped with the setting too, so switching it rebuilds the week at once.
const WEEKLY_RULE = 5;
// The multi-day setting ("due" | "days" | "excl0") and what the counting code needs from it.
function multiDayOf(settings) { const m = settings && settings.clickupMultiDay; return m === "days" || m === "excl0" ? m : "due"; }
function extendedModeOf(settings) { return multiDayOf(settings) === "excl0" ? "excl0" : "days"; }
function spreadOf(settings) { return multiDayOf(settings) !== "due"; }
function forceFloor(forced, ttl) { return forced ? FORCE_REBUILD_MIN_MS : ttl; }

// A configured task (the recurring Extra Task) that fails to load on THIS refresh
// - usually one rate-limited request - came back as a bare { error } row: its
// share dropped out of today's total (6h 48m instead of 8h 12m) and the card
// showed a nameless "(configured task)". Today's share doesn't change minute to
// minute, so if the same task loaded fine earlier TODAY, keep that row and its
// estimate. Its tracked minutes, which this refresh listed under "Tracked · not
// due today" because the row was missing, move back onto it. With no good row
// from today, the error row stays and the card says why (options.js).
function keepLastGoodConfigured(data, prev) {
  if (!data || !Array.isArray(data.deadlineTasks)) return;
  if (!prev || !prev.at || todayString(prev.at) !== todayString()) return;
  const prevRows = Array.isArray(prev.deadlineTasks) ? prev.deadlineTasks : [];
  const tracked = Array.isArray(data.trackedTasks) ? data.trackedTasks : [];
  let changed = false;
  data.deadlineTasks = data.deadlineTasks.map((row) => {
    if (!row || !row.error) return row;
    const id = parseTaskIdFromUrl(row.taskUrl || "");
    const good = id && prevRows.find((p) => p && !p.error && String(p.id) === String(id));
    if (!good) return row;
    const ti = tracked.findIndex((t) => t && String(t.id) === String(id));
    const spentMs = ti >= 0 ? (Number(tracked[ti].spentMs) || 0) : 0;
    if (ti >= 0) tracked.splice(ti, 1); // its minutes are already in the tracked total
    const est = Number(good.dayEstimateMs) || 0;
    data.estimateMs = (Number(data.estimateMs) || 0) + est;
    data.deadlineEstimateMs = (Number(data.deadlineEstimateMs) || 0) + est;
    changed = true;
    return { ...good, spentMs, lastKnownAt: prev.at, loadError: row.error };
  });
  if (changed) {
    data.trackedTasks = tracked;
    data.targetMet = Number(data.targetMs) > 0 && data.estimateMs >= Number(data.targetMs);
  }
}

// forceWeeks: also bypass the due-this/next-week bundles' 60-min TTL. Only set by
// an estimate edit or an explicit Refresh click - never by popup-open/alarms.
async function refreshClickupImpl({ includeTasks = false, viaAlarm = false, forceWeekly = false, forceWeeks = false, onToday = null } = {}) {
  const gen = settingsGen; // a setting changed after this = our result is stale (see rebuildListsFor)
  const t0 = Date.now();
  // The timed refresh nobody is waiting for goes in the slow lane (see bgToken).
  const cfg0 = await getClickupConfig();
  const cfg = cfg0 && cfg0.token && viaAlarm ? { ...cfg0, token: bgToken(cfg0.token) } : cfg0;
  if (!cfg || !cfg.token) return { ok: false, reason: "not-configured" };
  if (!cfg.teamId || cfg.userId == null) return { ok: false, reason: "incomplete-setup" };
  const settings = await getSettings();
  const targetHours = Number(settings.clickupTargetHours) || 0;
  // Auto-detect the "Extra(s) Task(s)" task by name (no manual URL needed) and
  // fold it into the configured-task set, so today / weekly / filter all see it.
  let extraTask = await discoverExtraTask(cfg);
  // Couldn't look (rate limit / network): keep the Extra task from the last
  // refresh rather than dropping it, and remember that this one couldn't check.
  let extraLookup = "ok";
  if (extraTask === undefined) {
    extraLookup = "failed";
    const last = await getClickupState().catch(() => null);
    extraTask = (last && last.extraTask) || null;
  }
  const deadlineTaskUrls = mergeExtraTaskUrl(
    Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : [],
    extraTask
  );
  const extendedMode = extendedModeOf(settings);
  const spread = spreadOf(settings), multiDay = multiDayOf(settings);
  // One shared cache for configured-task fetches across today + weekly, so each
  // by-URL task is fetched from the API at most once per refresh.
  const taskCache = createTaskCache();
  try {
    const data = await fetchTodayEstimate({ token: cfg.token, teamId: cfg.teamId, userId: cfg.userId, targetHours, deadlineTaskUrls, extendedMode, taskCache, spread });
    // One failed request must not knock the Extra Task out of today's total.
    keepLastGoodConfigured(data, await getClickupState().catch(() => null));
    if (gen !== settingsGen) return { ok: false, reason: "superseded" };
    // After a setting change: today's list (the Tasks card, the popup) is saved
    // the moment it's built, and the "Updating…" line ends; the week views below
    // can take a while (many requests) and are saved when they're done.
    if (typeof onToday === "function") {
      try {
        const prevQ = (await getClickupState().catch(() => null)) || {};
        const quick = { ...prevQ, estimateMs: data.estimateMs, spentMs: data.spentMs, targetMs: data.targetMs, targetHours: data.targetHours,
          taskCount: data.taskCount, noEstimateCount: data.noEstimateCount, targetMet: data.targetMet, deadlineTasks: data.deadlineTasks,
          deadlineEstimateMs: data.deadlineEstimateMs, deadlineSpentMs: data.deadlineSpentMs, tasks: data.tasks, error: null };
        // The filter list for the Tasks card; if ClickUp is slow it follows with
        // the full refresh instead of holding today's list back.
        quick.todayFilter = await Promise.race([getTodayFilterData(cfg, settings), new Promise((r) => setTimeout(() => r(prevQ.todayFilter || null), 10000))]);
        await annotateClients(cfg.token, quick, settings.cuClientLevel || "auto");
        if (gen === settingsGen) { await setClickupState(quick); onToday(); diagLog("ClickUp", "setting change: today's list rebuilt in " + Math.round((Date.now() - t0) / 100) / 10 + " s"); }
      } catch (e) {}
    }

    // Weekly accumulation (current week Mon→Fri). fetchWeeklySummary computes BOTH
    // the Mon→today and Mon→Friday aggregates in one pass, so the popup's
    // ToToday/ToFriday toggle just re-renders from the cached state - no network.
    // The week recompute is throttled (~30 min TTL): the popup/options only read
    // the cached state, and "today's" freshness already comes from the 5-min
    // fetchTodayEstimate above. It also re-runs when the week rolls over.
    let weekly = null;
    try {
      // The same week as the Due this week filter (Sunday -> Saturday by default),
      // so a task due on a weekend is counted too.
      const wb = cuWeekBounds(settings.clickupWeekMode || "sun-sat", 0);
      const monday = new Date(wb.fromTs);
      const friEnd = new Date(wb.toTs);
      const mondayTs = monday.getTime();
      const friEndTs = friEnd.getTime();
      const prev = (await getClickupState().catch(() => null)) || null;
      const prevWeekly = prev && prev.weekly;
      const WEEKLY_TTL = 30 * 60000;
      // A copy built by an older counting rule is rebuilt at once (an update must
      // not leave Tue-Fri on the old numbers for up to half an hour).
      const weekChanged = !prevWeekly || prevWeekly.rule !== WEEKLY_RULE + ":" + multiDay ||
        prevWeekly.fromTs !== mondayTs || prevWeekly.toTs !== friEndTs;
      if (!weekChanged && prevWeekly.at && !prevWeekly.stale && Date.now() - prevWeekly.at < forceFloor(forceWeekly, WEEKLY_TTL)) {
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
          spread,
        });
        weekly.at = Date.now();
        weekly.rule = WEEKLY_RULE + ":" + multiDay;
      }
      // Today's column is Due today's own numbers (fresh every refresh), so the
      // This week card can't disagree with the Due today card on the same day.
      weekly = weeklyWithToday(weekly, data);
      // Remember which slice the user last picked so the popup can settle its toggle.
      weekly.weeklyToView = settings.clickupWeeklyTo === "friday" ? "friday" : "today";
    } catch (e) {
      weekly = null;
    }

    // Carry over the cached member directory (used by Department Creator) - the
    // per-cycle refresh below replaces the whole state object.
    const prevSt = await getClickupState();
    const members = (prevSt && Array.isArray(prevSt.members)) ? prevSt.members : null;
    const waiting = (prevSt && prevSt.waiting && typeof prevSt.waiting === "object") ? prevSt.waiting : {};
    const membersAt = (prevSt && prevSt.membersAt) || 0;

    // "Due this week" and "Due next week" scopes, each the full Sunday→Saturday of
    // its calendar week. Both are ADDITIONAL fan-outs (computeFilterData over a date
    // range), so each carries its own longer TTL (~60 min) and, unlike weekly,
    // deliberately IGNORES forceWeekly: opening the popup must not re-pay these costs.
    // A bundle refetches only when its hour elapses or the week rolls over (range
    // bounds change). Best-effort: a failure leaves whichever bundle already built and
    // the rest of the refresh proceeds. (This is DUE-date bounded, distinct from the
    // Mon→Fri `weekly` summary card, which is tracked-time accumulated and untouched.)
    // Superseded by a newer setting while the weekly summary was fetched: stop
    // here rather than spend more ClickUp requests on week views nobody will see.
    if (gen !== settingsGen) return { ok: false, reason: "superseded" };
    let thisWeek = null;
    let thisWorkweek = null;
    let nextWeek = null;
    let tomorrow = null;
    let custom = null;
    try {
      const weekMode = settings.clickupWeekMode || "sun-sat";
      const thisB = cuWeekBounds(weekMode, 0);
      const nextB = cuWeekBounds(weekMode, 1);
      const sun = new Date(thisB.fromTs);
      const sat = new Date(thisB.toTs);
      const nSun = new Date(nextB.fromTs);
      const nSat = new Date(nextB.toTs);
      // Due tomorrow / this week / next week read these bundles, so an estimate or
      // due date changed in ClickUp must not sit behind a long cache. 15 min in
      // the background; opening the popup or the options page rebuilds them now.
      const WEEK_TTL = 15 * 60000;
      const buildWeek = async (prev, fromTs, toTs) => {
        const rangeChanged = !prev || prev.fromTs !== fromTs || prev.toTs !== toTs || prev.multiDay !== multiDay;
        if (!rangeChanged && prev && prev.at && !prev.stale && Date.now() - prev.at < forceFloor(forceWeeks, WEEK_TTL)) return prev; // fresh - no API calls
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
        // Spread mode keeps a started task due after the week: it counts its
        // share of this week's days (by the setting the user chose).
        const prune = (rows) => (Array.isArray(rows) ? rows : []).filter((t) => {
          const d = Number(t && t.dueDateMs) || 0;
          if (!d) return true;            // no due → not a due-bound claim to prune
          if (spread && t.extended && Number(t.estimateMs) > 0) return true;
          return d >= fromTs && d <= toTs;
        });
        const tasks = prune(w.tasks);
        // Configured tasks (the recurring Extra Task) carry a per-day share of
        // their estimate, so they belong to every day they run - pruning them by
        // due date made them vanish from every view except Today.
        const deadlineTasks = Array.isArray(w.deadlineTasks) ? w.deadlineTasks : [];
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
          multiDay,
        };
      };
      thisWeek = await buildWeek((prevSt && prevSt.thisWeek) || null, sun.getTime(), sat.getTime());
      nextWeek = await buildWeek((prevSt && prevSt.nextWeek) || null, nSun.getTime(), nSat.getTime());
      // "Due tomorrow" is its own ONE-DAY bundle, built here rather than by each
      // page. A page-level cache starts empty on every popup open, so the card
      // flashed "0m · loading…" for a couple of seconds and paid for a fresh
      // ClickUp fan-out every single open (popup and options each paying
      // separately, which is what started hitting the rate limit). Building it
      // once here means the popup paints instantly from state and the badge -
      // which cannot run page code - reads the very same number.
      const buildDay = async (prev, fromTs, toTs) => {
        const rangeChanged = !prev || prev.fromTs !== fromTs || prev.toTs !== toTs || prev.multiDay !== multiDay;
        if (!rangeChanged && prev && prev.at && !prev.stale && Date.now() - prev.at < forceFloor(forceWeeks, WEEK_TTL)) return prev;
        return { ...(await buildRangeBundle(cfg, settings, fromTs, toTs)), multiDay };
      };
      const tomStart = new Date(); tomStart.setDate(tomStart.getDate() + 1); tomStart.setHours(0, 0, 0, 0);
      const tomEnd = new Date(tomStart); tomEnd.setHours(23, 59, 59, 999);
      // Due tomorrow left the Filter menu (tomorrow is in This week / Next week), so
      // its own range isn't fetched any more.
      tomorrow = null; void tomStart; void tomEnd;
      // The saved filter's custom range / chart day, shared by every page + the badge.
      try {
        const { cuFilter: savedFilter } = await chrome.storage.local.get("cuFilter");
        const cr = cuFilterCustomRange(savedFilter);
        const pc = (prevSt && prevSt.custom) || null;
        custom = !cr ? null
          : cr.basis === "due" ? { ...(await buildDay(pc && (pc.basis || "due") === "due" ? pc : null, cr.fromTs, cr.toTs)), basis: "due" }
          : pc && pc.fromTs === cr.fromTs && pc.toTs === cr.toTs && pc.basis === cr.basis && Date.now() - (pc.at || 0) < 30 * 60000 ? pc
          : await buildBasisBundle(cfg, settings, cr);
      } catch (e) { custom = (prevSt && prevSt.custom) || null; }
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
    if (gen !== settingsGen) return { ok: false, reason: "superseded" };
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
      tomorrow, // tomorrow's one-day bundle (see buildDay) - popup AND badge read this
      custom, // the saved filter's custom range / chart day (buildRangeBundle) - every page + badge
      // auto-detected "Extra(s) Task(s)"; datesFix = the Mon-Fri it should have when its dates are off
      extraTask: extraTask ? { ...extraTask, datesFix: (extraWeekDates(extraTask) || {}).label || "" } : null,
      extraLookup, // "failed" = couldn't check this time (the dashboard says so instead of "not found")
      running: running || null, // live timer (taskId/taskName/startMs) or null
      at: data.at,
      error: null,
      rateLimitedUntil: 0, // a clean fetch clears any prior 429 backoff
      members,
      waiting, // parentId -> { blockers: [...] } (see refreshWaitingInfo)
      membersAt,
    };
    // The upper today card mirrors the Filter "Today + My tasks" default: attach
    // the identical computation so its numbers and task list match the filter.
    state.todayFilter = await getTodayFilterData(cfg, settings);
    // Stamp client names on every row (today tasks / deadline / weekly / filter)
    // so the popup + options can show a client tag and filter by client.
    await annotateClients(cfg.token, state, settings.cuClientLevel || "auto");
    // Note every task that came back done, for the dashboard's "Recently
    // completed" card. Costs no requests (see recordDoneHistory) and must never
    // be able to sink a refresh, hence the catch.
    await recordDoneHistory(state).catch(() => {});
    dropStaleDueRows(state);
    const changedAt = await patchChangedTasks(state, cfg).catch((e) => { diagLog("changed tasks", String(e && e.message ? e.message : e)); return 0; }); // edits made in ClickUp reach every list
    await stampFamily(state, cfg, true).catch(() => {}); // subtask / parent hints on the rows
    if (gen !== settingsGen) return { ok: false, reason: "superseded" }; // a newer setting's refresh owns the state
    await setClickupState(state);
    if (changedAt) await chrome.storage.local.set({ cuChangedAt: changedAt }).catch(() => {}); // only once the patched lists are saved
    await maybeNotifyClickup(state, { viaAlarm });
    await maybeNotifyRunningTask(cfg).catch(() => {});
    await maybeNotifyNotTracking(cfg, { viaAlarm }).catch(() => {});
    return { ok: true, data: includeTasks ? { ...state, tasks: data.tasks } : state };
  } catch (e) {
    // Keep the last good numbers (if any) and just annotate the error, so the UI
    // can say "couldn't refresh" without blanking the panel.
    const prev = (await getClickupState()) || {};
    const state = { ...prev, error: String(e && e.message ? e.message : e), errorAt: Date.now() };
    diagLog("ClickUp refresh", e);
    // On a 429, back off: park a cooldown so auto-refreshes stop hitting the API
    // until ClickUp's own Retry-After window elapses (default ~1 min).
    if (e && e.status === 429) {
      state.rateLimitedUntil = Date.now() + (Number(e.retryAfterMs) || 60000);
    }
    await setClickupState(state);
    return { ok: false, reason: "fetch-failed", error: state.error };
  }
}

// Every ClickUp reminder is about the WORKING day, so none of them may fire at
// night or at the weekend: Mon-Fri only, inside the configured office hours
// (Tracking settings -> Office hours start/end, default 8am-5pm). Shared by the
// daily-estimate nudges and the "are you working?" idle reminder so there is one
// rule, not two. A misconfigured window (start >= end) silences them entirely.
function officeHourBounds(settings) {
  const s = Number(settings && settings.clickupIdleStartHour);
  const e = Number(settings && settings.clickupIdleEndHour);
  return { startHour: Number.isFinite(s) ? s : 8, endHour: Number.isFinite(e) ? e : 17 };
}
// ---- Company calendar: holidays and work-from-home days ----
// Shared through the settings file (update-policy.json "calendar"), so every copy
// has the same list and the admin can change it without a new version. The dates
// below are the built-in fallback until the file has a list.
const DEFAULT_COMPANY_CAL = [
  { from: "2026-08-28", to: "2026-08-28", kind: "holiday", title: "Janai Purnima / Raksha Bandhan" },
  { from: "2026-10-12", to: "2026-11-13", kind: "wfh", title: "Work from home (Dashain & Tihar)" },
  { from: "2026-10-19", to: "2026-10-23", kind: "holiday", title: "Dashain holidays" },
  { from: "2026-11-09", to: "2026-11-12", kind: "holiday", title: "Tihar holidays" },
];
function normalizeCompanyCal(list) {
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  return (Array.isArray(list) ? list : []).filter((e) => e && ok.test(String(e.from || ""))).slice(0, 200).map((e) => ({
    from: String(e.from), to: ok.test(String(e.to || "")) && String(e.to) >= String(e.from) ? String(e.to) : String(e.from),
    kind: ["holiday", "wfh", "event", "festival"].includes(e.kind) ? e.kind : "event",
    title: String(e.title || (e.kind === "holiday" ? "Holiday" : e.kind === "wfh" ? "Work from home" : "Event")).slice(0, 80),
    // Events (Admin › Company calendar & events): a time, a note, and when to remind
    // everyone (minutes before; 0 = at the time).
    ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.time || "")) ? { time: String(e.time) } : {}),
    ...(e.note ? { note: String(e.note).slice(0, 300) } : {}),
    ...(Array.isArray(e.remind) && e.remind.length ? { remind: [...new Set(e.remind.map(Number).filter((n) => Number.isFinite(n) && n >= 0 && n <= 10080))].slice(0, 6) } : {}),
    ...(e.id ? { id: String(e.id).slice(0, 40) } : {}),
    // Festival days (a name for the day, not a day off): short label, group ("Dashain"), main day.
    ...(e.kind === "festival" && e.short ? { short: String(e.short).slice(0, 24) } : {}),
    ...(e.kind === "festival" && e.group ? { group: String(e.group).slice(0, 24) } : {}),
    ...(e.kind === "festival" && e.main ? { main: true } : {}),
  }));
}
// When an event starts (its day at its time; no time = 9:00 that morning).
function companyEventAt(e) {
  const [h, m] = (e.time || "09:00").split(":").map(Number);
  const d = new Date(e.from + "T00:00:00"); d.setHours(h, m, 0, 0);
  return d.getTime();
}
// Admin events: a notification for each "remind" time (e.g. a day before, an hour
// before, at the time), whether or not it's a working day. A copy that was off at
// the time catches up within 30 minutes; older ones are skipped, not piled up.
async function companyEventReminders(now = Date.now()) {
  const evs = companyCal.filter((e) => e.kind === "event" && Array.isArray(e.remind) && e.remind.length);
  if (!evs.length) return;
  const { companyEvSeen } = await chrome.storage.local.get("companyEvSeen");
  const seen = companyEvSeen && typeof companyEvSeen === "object" ? { ...companyEvSeen } : {};
  let changed = false;
  for (const e of evs) {
    const at = companyEventAt(e);
    for (const before of e.remind) {
      const due = at - before * 60000;
      // The event's own time is part of the key: moved from 2:00 to 3:00, every
      // reminder goes off again for the new time.
      const key = (e.id || e.from + "|" + e.title) + "@" + before + "@" + at;
      if (seen[key] || now < due || now - due > 30 * 60000) continue;
      seen[key] = now; changed = true;
      const when = before === 0 ? "now" : before < 60 ? "in " + before + " minutes" : before < 1440 ? "in " + Math.round(before / 60) + " hour" + (before >= 120 ? "s" : "")
        : before === 1440 ? "tomorrow" : "in " + Math.round(before / 1440) + " days";
      const t = new Date(at).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      await notify("company-ev-" + key, "\uD83D\uDCCC " + e.title + (before === 0 ? " - starting now" : " - " + when),
        t + (e.note ? " · " + e.note : ""), null, chrome.runtime.getURL("options.html#dashboard"));
    }
  }
  if (changed) {
    // Keep only marks for events still on the list.
    const live = new Set(evs.map((e) => e.id || e.from + "|" + e.title));
    for (const k of Object.keys(seen)) if (!live.has(k.split("@")[0])) delete seen[k];
    await chrome.storage.local.set({ companyEvSeen: seen });
  }
}
let companyCal = DEFAULT_COMPANY_CAL.slice();
const calYmd = (ts) => { const d = new Date(ts); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const companyOn = (ts) => { const k = calYmd(ts); return companyCal.filter((e) => k >= e.from && k <= e.to); };
const isCompanyHoliday = (ts) => companyOn(ts).some((e) => e.kind === "holiday");
const isCompanyWfh = (ts) => companyOn(ts).some((e) => e.kind === "wfh");
// Keep storage (read by the pages' calendar) and memory in step.
async function loadCompanyCal() {
  const { companyCalendar } = await chrome.storage.local.get("companyCalendar");
  if (Array.isArray(companyCalendar)) companyCal = normalizeCompanyCal(companyCalendar);
  else await chrome.storage.local.set({ companyCalendar: companyCal });
}
loadCompanyCal().catch(() => {});
chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.companyCalendar) companyCal = normalizeCompanyCal(ch.companyCalendar.newValue); });
// From the settings file: replace the list when it has one.
function normalizePausedClients(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map((p) => ({
    name: String((p && p.name) || "").trim().slice(0, 80),
    since: /^\d{4}-\d{2}-\d{2}$/.test(String(p && p.since)) ? String(p.since) : "",
    note: String((p && p.note) || "").trim().slice(0, 140),
  })).filter((p) => { const k = p.name.toLowerCase().replace(/[^a-z0-9]+/g, ""); if (k.length < 3 || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 100);
}
// The totals leave paused clients' unfinished tasks out (lib-clickup); keep its
// list current, and recount at once when it changes.
// What this person sees: the team's list, minus the ones they resumed for
// themselves, plus their own (paused-clients.js keeps the same rule).
async function effectivePausedClients() {
  const g = await chrome.storage.local.get(["pausedClients", "myPausedClients", "myResumedClients"]).catch(() => ({}));
  const k = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const resumed = Array.isArray(g.myResumedClients) ? g.myResumedClients : [];
  const out = (Array.isArray(g.pausedClients) ? g.pausedClients : []).filter((p) => p && !resumed.includes(k(p.name)));
  for (const p of Array.isArray(g.myPausedClients) ? g.myPausedClients : []) if (p && !out.some((x) => k(x.name) === k(p.name))) out.push(p);
  return out;
}
// Everything else that belongs to a paused client goes quiet too: its sites are
// not checked (no down / blank alerts), its tasks get no tidy-up nudges.
let pausedKeysBg = [];
const pausedKeyBg = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function rememberPaused(list) { pausedKeysBg = (Array.isArray(list) ? list : []).map((p) => pausedKeyBg(p && p.name)).filter((k) => k.length >= 3); return list; }
// A site: the client's name anywhere in the site's name or address
// (":house: Acme Roofing SEO", acmeroofing.com).
function isPausedSite(site) {
  if (!pausedKeysBg.length || !site) return false;
  let host = "";
  try { host = new URL(site.url).hostname.replace(/^www\./, ""); } catch (e) {}
  const hay = [pausedKeyBg(site.name), pausedKeyBg(host)].filter(Boolean);
  return pausedKeysBg.some((p) => hay.some((h) => h === p || (p.length >= 5 && h.includes(p)) || (h.length >= 4 && p.startsWith(h))));
}
// A task row (raw or slim): its client, list or folder.
function isPausedRow(t) {
  if (!pausedKeysBg.length || !t) return false;
  const c = t.container || {};
  for (const n of [t.client, c.listName, t.list && t.list.name, c.folderName]) {
    const k = pausedKeyBg(n);
    if (k && pausedKeysBg.some((p) => k === p || (k.length >= 4 && p.length >= 4 && (k.startsWith(p) || p.startsWith(k))))) return true;
  }
  return false;
}
try {
  effectivePausedClients().then(rememberPaused).then(setPausedClients).catch(() => {});
  chrome.storage.onChanged.addListener(async (ch, area) => {
    if (area !== "local" || !(ch.pausedClients || ch.myPausedClients || ch.myResumedClients)) return;
    setPausedClients(rememberPaused(await effectivePausedClients()));
    try { clearFilterCache(); } catch (e) {}
    refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
  });
} catch (e) {}
async function applyPausedClients(policy) {
  if (!policy || !Array.isArray(policy.pausedClients)) return;
  const next = normalizePausedClients(policy.pausedClients);
  const { pausedClients } = await chrome.storage.local.get("pausedClients");
  if (JSON.stringify(pausedClients || []) !== JSON.stringify(next)) await chrome.storage.local.set({ pausedClients: next });
}
async function applyCompanyCal(policy) {
  if (!policy || !Array.isArray(policy.calendar)) return;
  const next = normalizeCompanyCal(policy.calendar);
  const { companyCalendar } = await chrome.storage.local.get("companyCalendar");
  if (JSON.stringify(companyCalendar || []) !== JSON.stringify(next)) await chrome.storage.local.set({ companyCalendar: next });
}
// On the last working day before a holiday or work-from-home period starts, one
// heads-up (after office start): "Dashain holidays start Monday (Oct 19)".
async function maybeCompanyHeadsUp() {
  const now = new Date();
  const settings = await getSettings();
  if (!insideOfficeHours(settings, now)) return;
  const { companyNotified } = await chrome.storage.local.get("companyNotified");
  const seen = companyNotified && typeof companyNotified === "object" ? { ...companyNotified } : {};
  for (const e of companyCal) {
    if (e.kind === "event") continue;
    const start = new Date(e.from + "T00:00:00");
    if (start.getTime() <= now.getTime()) continue;
    // the working day before it (skip weekends and holidays)
    const prev = new Date(start); prev.setDate(prev.getDate() - 1);
    for (let i = 0; i < 10 && (prev.getDay() === 0 || prev.getDay() === 6 || isCompanyHoliday(prev.getTime())); i++) prev.setDate(prev.getDate() - 1);
    if (calYmd(prev.getTime()) !== calYmd(now.getTime())) continue;
    const key = e.kind + ":" + e.from;
    if (seen[key]) continue;
    const days = Math.round((start - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    const when = days === 1 ? "tomorrow" : start.toLocaleDateString(undefined, { weekday: "long" });
    const range = start.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + (e.to !== e.from ? " - " + new Date(e.to + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
    await notify("company-" + key, (e.kind === "holiday" ? "\uD83C\uDF89 " : "\uD83C\uDFE0 ") + e.title + " from " + when,
      range + (e.kind === "wfh" ? " - check in and out and track your ClickUp tasks as usual." : " - enjoy the break."), null);
    seen[key] = Date.now();
    await chrome.storage.local.set({ companyNotified: seen });
  }
}
function insideOfficeHours(settings, when = new Date()) {
  const weekday = when.getDay() !== 0 && when.getDay() !== 6;
  if (!weekday) return false;
  if (isCompanyHoliday(when.getTime())) return false; // company holiday: no work nudges
  const { startHour, endHour } = officeHourBounds(settings);
  if (!(startHour < endHour)) return false;
  const hour = when.getHours();
  return hour >= startHour && hour < endHour;
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
  // Office hours only - these were firing at 10:30pm on a Sunday before.
  if (!insideOfficeHours(settings)) return;
  const { clickupNotified } = await chrome.storage.local.get("clickupNotified");
  const seen = clickupNotified && typeof clickupNotified === "object" ? { ...clickupNotified } : {};
  const today = todayString();
  // One record for the whole check: each milestone marks itself and saves, so a
  // second milestone in the same check can't erase the first one's mark.
  const mark = async (key) => {
    seen[key] = today;
    const { clickupNotified: cur } = await chrome.storage.local.get("clickupNotified");
    await chrome.storage.local.set({ clickupNotified: { ...(cur && typeof cur === "object" ? cur : {}), [key]: today } });
  };
  const estMs = Number(state.estimateMs) || 0;
  const spentMs = Number(state.spentMs) || 0;
  const tgtMs = Number(state.targetMs) || 0;
  const estTxt = fmtDuration(estMs);
  const spentTxt = fmtDuration(spentMs);
  const tgtTxt = fmtDuration(tgtMs);

  // Animation for the milestone (celebrate.js / celebrate.html): fireworks, or a
  // little rain cloud when the day is falling short. Pictures for the toast.
  const celebrate = (kind, big, mood, title, sub) => celebrateMilestone({ kind, big, mood, title, sub }).catch(() => {});
  const IMG_HAPPY = { type: "image", imageUrl: chrome.runtime.getURL("icons/celebrate.png") };
  const IMG_SAD = { type: "image", imageUrl: chrome.runtime.getURL("icons/sad.png") };

  // --- Estimate-based milestones (fire only while UNDER 100% of target) ---

  // Halfway milestone - fires only inside the 40%-60% window so the user
  // sees it right around the midpoint, not at 86% or 107%.
  const halfLo = tgtMs * 0.4;
  const halfHi = tgtMs * 0.6;
  if (settings.clickupHalfwayNotify !== false && estMs >= halfLo && estMs <= halfHi && seen.halfway !== today) {
    await notify("clickup-halfway-" + Date.now(), "ClickUp - halfway to your daily estimate ⏳",
      "Estimated " + estTxt + " (" + Math.round((estMs / tgtMs) * 100) + "% of " + tgtTxt + ")" +
      (spentMs > 0 ? " · tracked " + spentTxt : "") + ".", undefined, undefined, IMG_HAPPY);
    await mark("halfway");
    celebrate("halfway", false, "happy", "Halfway there! \u23f3", "Estimated " + estTxt + " of " + tgtTxt);
  }

  // "Almost there" - fires at ~86% (i.e. 6h of 7h) up to <100%.
  const almostMs = tgtMs * 0.857;
  if (settings.clickupAlmostThereNotify !== false && estMs >= almostMs && estMs < tgtMs && seen.almost !== today) {
    await notify("clickup-almost-" + Date.now(), "ClickUp - almost at your daily estimate 🎯",
      "Just " + fmtDuration(Math.max(0, tgtMs - estMs)) + " to go (estimated " + estTxt + " of " + tgtTxt + ")" +
      (spentMs > 0 ? " · tracked " + spentTxt : "") + ".", undefined, undefined, IMG_HAPPY);
    await mark("almost");
    celebrate("almost", false, "happy", "Almost there! \ud83c\udfaf", "Just " + fmtDuration(Math.max(0, tgtMs - estMs)) + " to go");
  }

  // --- Tracked-time milestones (independent of estimate; same thresholds) ---
  // Checked before the "estimate met" return below: that return used to skip
  // these, so tracked milestones never fired on days the estimate was reached.

  if (spentMs >= halfLo && spentMs <= halfHi && seen.spentHalfway !== today) {
    await notify("clickup-spent-half-" + Date.now(), "ClickUp - tracked halfway ⏳",
      "Tracked " + spentTxt + " (" + Math.round((spentMs / tgtMs) * 100) + "% of " + tgtTxt + ")" +
      " · estimated " + estTxt + ".", undefined, undefined, IMG_HAPPY);
    await mark("spentHalfway");
    celebrate("spentHalfway", false, "happy", "Halfway tracked! \u23f3", "Tracked " + spentTxt + " of " + tgtTxt);
  }

  if (spentMs >= almostMs && spentMs < tgtMs && seen.spentAlmost !== today) {
    await notify("clickup-spent-almost-" + Date.now(), "ClickUp - almost there (tracked) 🎯",
      "Tracked " + spentTxt + " of " + tgtTxt + " - just " + fmtDuration(Math.max(0, tgtMs - spentMs)) + " to go" +
      " · estimated " + estTxt + ".", undefined, undefined, IMG_HAPPY);
    await mark("spentAlmost");
    celebrate("spentAlmost", false, "happy", "Almost there! \ud83c\udfaf", "Tracked " + spentTxt + " of " + tgtTxt);
  }

  if (spentMs >= tgtMs && seen.spentMet !== today) {
    // Tracked time crossed the day's goal - same celebration as the estimate win.
    await notify("clickup-spent-met-" + Date.now(), "ClickUp - tracked target reached ✓",
      "Tracked " + spentTxt + " (target " + tgtTxt + ") · estimated " + estTxt + ".",
      "winner", undefined, IMG_HAPPY);
    await mark("spentMet");
    celebrate("spentMet", true, "happy", "Tracked target reached! \ud83c\udf89", "Tracked " + spentTxt + " today");
  }


  // Target reached (>= 100%) - the day's estimate goal is met, so celebrate.
  if (state.targetMet) {
    if (seen.met !== today) {
      await notify("clickup-met-" + Date.now(), "ClickUp - daily estimate reached ✓",
        estTxt + " estimated for today (target " + tgtTxt + ")" +
        (spentMs > 0 ? " · tracked " + spentTxt : "") + ".",
        "winner", undefined, IMG_HAPPY);
      await mark("met");
      celebrate("met", true, "happy", "Daily estimate reached! \ud83c\udf89", estTxt + " estimated for today");
    }
    // Estimate met, but TRACKED time still short at the end of the workday.
    if (viaAlarm && spentMs < tgtMs && seen.spentShort !== today) {
      const endH = Math.min(Number(settings.clickupWorkdayEndHour), officeHourBounds(settings).endHour - 1);
      if (Number.isFinite(endH) && new Date().getHours() >= endH) {
        const shortTxt = fmtDuration(Math.max(0, tgtMs - spentMs));
        await notify("clickup-spentshort-" + Date.now(), "ClickUp - tracked time short today \ud83d\udd54",
          "Tracked " + spentTxt + " of " + tgtTxt + " · " + shortTxt + " short (the estimate is met).", "danger", undefined, IMG_SAD);
        await mark("spentShort");
        celebrate("spentShort", true, "sad", "Tracked time is short today", shortTxt + " short of " + tgtTxt);
      }
    }
    return; // past target: no nudge / end-of-day nags
  }

  if (!viaAlarm) return; // don't nudge on manual refresh
  const hour = new Date().getHours();
  // Clamped to the last office hour: a nudge set for 8pm would otherwise be
  // silenced outright by the office-hours gate at the top of this function.
  const lastOfficeHour = officeHourBounds(settings).endHour - 1;
  const nudgeHour = Math.min(Number(settings.clickupNudgeHour), lastOfficeHour);
  if (Number.isFinite(nudgeHour) && hour >= nudgeHour && seen.nudge !== today) {
    const shortMs = Math.max(0, tgtMs - estMs);
    // Still under the day's target late in the day - the urgent alarm is right.
    await notify("clickup-nudge-" + Date.now(), "ClickUp - under your daily estimate",
      "Estimated " + estTxt + " / " + tgtTxt + " · tracked " + spentTxt + " · " + fmtDuration(shortMs) + " short.",
      "danger", undefined, IMG_SAD);
    await chrome.storage.local.set({ clickupNotified: { ...seen, nudge: today } });
    celebrate("nudge", false, "sad", "Under your daily estimate", fmtDuration(shortMs) + " short of " + tgtTxt);
  }
  // End-of-day warning - fires once after workdayEndHour if still under target.
  const endHour = Math.min(Number(settings.clickupWorkdayEndHour), lastOfficeHour);
  if (Number.isFinite(endHour) && hour >= endHour && seen.endOfDay !== today) {
    const shortMs = Math.max(0, tgtMs - estMs);
    await notify("clickup-endofday-" + Date.now(), "ClickUp - workday winding down 🕔",
      "Estimated " + estTxt + " of " + tgtTxt + " · tracked " + spentTxt + " · " + fmtDuration(shortMs) + " short.",
      "danger", undefined, IMG_SAD);
    await chrome.storage.local.set({ clickupNotified: { ...seen, endOfDay: today } });
    celebrate("endOfDay", true, "sad", "Not quite there today", fmtDuration(shortMs) + " short of " + tgtTxt);
  }
}

// Per-task nudge: fires once per task per day when the CURRENTLY RUNNING
// ClickUp timer's tracked time (today's closed entries on that task + the live
// segment since the timer started) comes within `clickupRunningThresholdMin`
// minutes of that task's own time_estimate - e.g. "50 of 60 min tracked, wrap
// up soon." Fires a separate one-time "reached" nudge once it's actually hit
// or passed the estimate. Independent of the daily-aggregate nudges above.
// On time, not every 5 minutes: once the numbers are known (timer start + time
// tracked before it + estimate), the exact moments the task gets "almost up"
// and "reached" are just arithmetic, so local chrome.alarms are set for them
// (see scheduleEstimateAlarms). No ClickUp requests while waiting; when one
// fires, this runs once more to confirm with ClickUp and notify.
// ---------- auto-run queue (console /autorun) ----------
// autoRunQueue { ids: [taskId...] (the current one first), names: {id: name},
// total, current }. Each task runs until its tracked time reaches its estimate,
// is completed (the auto-complete path below), and the next one starts. Every
// time entry it starts is labelled "Auto-run queue (k of n)", so ClickUp's
// timesheet shows it was started automatically.
async function startQueuedTask(cfg, taskId, label) {
  const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
  if (cur && String(cur.taskId) !== String(taskId)) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
  await setTaskStatus(cfg.token, taskId, "in progress").catch(() => {});
  await startTimer(cfg.token, cfg.teamId, taskId, label);
  // A task already warned about today must still complete when it reaches its estimate.
  const { clickupNotified: cn } = await chrome.storage.local.get("clickupNotified");
  if (cn && cn.runningMet && cn.runningMet[String(taskId)]) { delete cn.runningMet[String(taskId)]; await chrome.storage.local.set({ clickupNotified: cn }); }
  const st = (await getClickupState().catch(() => null)) || {};
  await setClickupState({ ...st, activeTaskId: String(taskId) });
}
// The queue's current task was just completed (automatically or by hand): start the next.
async function advanceAutoRun(cfg, doneId) {
  try {
    const { autoRunQueue: q } = await chrome.storage.local.get("autoRunQueue");
    if (!q || !Array.isArray(q.ids) || !q.ids.length || String(q.current || "") !== String(doneId)) return;
    const rest = q.ids.filter((id) => String(id) !== String(doneId));
    if (!rest.length) {
      await chrome.storage.local.remove("autoRunQueue");
      await notify("autorun-done-" + Date.now(), "Queue finished ✓", "All " + q.total + " queued task" + (q.total === 1 ? "" : "s") + " ran and were completed.");
      return;
    }
    const next = rest[0], k = q.total - rest.length + 1;
    const { autoCompleteTasks: ac } = await chrome.storage.local.get("autoCompleteTasks");
    const marks = { ...(ac || {}) };
    if (!marks[next]) marks[next] = { name: (q.names && q.names[next]) || "", at: Date.now() };
    await chrome.storage.local.set({ autoRunQueue: { ...q, ids: rest, current: next }, autoCompleteTasks: marks });
    try {
      await startQueuedTask(cfg, next, "Auto-run queue (" + k + " of " + q.total + ")");
      await notify("autorun-next-" + Date.now(), "Started next (" + k + " of " + q.total + ")", "\"" + ((q.names && q.names[next]) || "next task") + "\" is running and completes at its estimate.", undefined, taskUrlFor(next));
    } catch (e) {
      await chrome.storage.local.set({ autoRunQueue: { ...q, ids: rest, current: next, paused: true } });
      await notify("autorun-fail-" + Date.now(), "Queue paused", "Couldn't start \"" + ((q.names && q.names[next]) || "the next task") + "\": " + String(e && e.message ? e.message : e), "danger", taskUrlFor(next));
    }
  } catch (e) { diagLog("auto-run", String(e && e.message ? e.message : e)); }
}
const EST_ALARM_NEAR = "cu-est-near", EST_ALARM_MET = "cu-est-met";
// While the running task stays past its estimate: a reminder every few minutes
// (ClickUp setup › "Keep reminding me while it's over", default 15 min, 0 = off).
const EST_ALARM_OVER = "cu-est-over";
// Stop (or complete) a task once its tracked time reaches a set limit
// (autoStopTasks { [taskId]: { name, ms, scope: "today" | "total", action: "stop" |
// "complete", daily, firedDay } }). Checked against ClickUp's own entries every
// time the running task's progress is worked out (each refresh, every start and
// restart), so pauses and restarts can't throw it off; between those, an alarm
// set for the moment the limit is reached checks again with fresh numbers.
const STOPAT_ALARM = "cu-stopat";
async function maybeAutoStop(cfg, entry, progress, key, today) {
  const { autoStopTasks: rules } = await chrome.storage.local.get("autoStopTasks").catch(() => ({}));
  const rule = rules && rules[key];
  if (!rule || !progress || !(Number(rule.ms) > 0) || (rule.daily && rule.firedDay === today)) { await chrome.alarms.clear(STOPAT_ALARM).catch(() => {}); return false; }
  const now = Date.now();
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const tracked = rule.scope === "total"
    ? Number(progress.trackedMs) || 0
    : (Number(progress.closedTodayMs) || 0) + Math.max(0, now - Math.max(Number(entry.startMs) || now, dayStart));
  const left = Number(rule.ms) - tracked;
  if (left > 15000) { chrome.alarms.create(STOPAT_ALARM, { when: now + left + 2000 }); return false; }
  const name0 = progress.taskName || entry.taskName || rule.name || "this task";
  try {
    await stopTimer(cfg.token, cfg.teamId);
    if (rule.action === "complete") await setTaskStatus(cfg.token, key, "complete");
    const next = { ...rules };
    if (rule.daily) next[key] = { ...rule, firedDay: today }; else delete next[key];
    await chrome.storage.local.set({ autoStopTasks: next, runningProgress: null });
    await chrome.alarms.clear(STOPAT_ALARM).catch(() => {});
    await scheduleEstimateAlarms(null);
    if (rule.action === "complete") await advanceAutoRun(cfg, key).catch(() => {});
    const st = (await getClickupState().catch(() => null)) || {};
    if (rule.action === "complete" && String(st.activeTaskId || "") === key) await setClickupState({ ...st, activeTaskId: null });
    await notify("clickup-stopat-" + Date.now(), rule.action === "complete" ? "Completed at your limit \u2713" : "Timer stopped at your limit \u2713",
      "\u201C" + name0 + "\u201D reached " + fmtDuration(Number(rule.ms)) + (rule.scope === "total" ? " in all" : " today") + ", so the timer was stopped" + (rule.action === "complete" ? " and the task marked complete" : "") + "." + (rule.daily ? " Same again tomorrow." : ""),
      undefined, taskUrlFor(key));
    clearFilterCache();
    setTimeout(() => { refreshClickup({ includeTasks: true }).catch(() => {}); }, 2000);
    return true;
  } catch (e) {
    diagLog("stop-at", String(e && e.message ? e.message : e));
    return false;
  }
}
// How long before the estimate "almost up" comes: the setting (10 minutes), but
// never more than a quarter of the task's estimate - a 7m task warns 2 minutes
// before, 16m 4 minutes, 33m 8 minutes - and none for a task of 3 minutes or less
// (only "reached"). Without this a short task (5m, 7m) said "almost up" the
// moment it was started.
function nearLeadMs(settings, estimateMs) {
  const set = Math.max(1, Number(settings && settings.clickupRunningThresholdMin) || 10) * 60000;
  const est = Number(estimateMs) || 0;
  if (est <= 3 * 60000) return 0;
  return Math.max(60000, Math.min(set, Math.round((est * 0.25) / 60000) * 60000));
}
async function scheduleEstimateAlarms(entry, progress, settings, seenNear, seenMet) {
  await chrome.alarms.clear(EST_ALARM_NEAR).catch(() => {});
  await chrome.alarms.clear(EST_ALARM_MET).catch(() => {});
  // The repeating one goes only when there's nothing to remind about any more
  // (re-creating it on every refresh would keep pushing it back).
  if (!entry || !progress || !(progress.estimateMs > 0) || (settings && settings.clickupRunningNotify === false)) await chrome.alarms.clear(EST_ALARM_OVER).catch(() => {});
  // (Called with no arguments to just clear them - settings may be missing then.)
  // autoOn: this running task is marked to complete itself (autoCompleteTasks).
  let marked = {};
  if (entry) { try { const g = await chrome.storage.local.get("autoCompleteTasks"); marked = (g && g.autoCompleteTasks) || {}; } catch (e) {} }
  const notifyOn = !!settings && settings.clickupRunningNotify !== false, autoOn = !!(entry && marked[String(entry.taskId)]);
  if (!entry || !progress || !(progress.estimateMs > 0) || (!notifyOn && !autoOn)) return;
  const now = Date.now();
  const crossAt = now + (progress.estimateMs - progress.trackedMs) + 3000; // a few seconds late, so ClickUp agrees it's crossed
  const thresholdMs = nearLeadMs(settings, progress.estimateMs);
  const nearAt = crossAt - thresholdMs;
  if (notifyOn && !seenNear && thresholdMs > 0 && nearAt > now + 5000) chrome.alarms.create(EST_ALARM_NEAR, { when: nearAt });
  if (!seenMet && crossAt > now + 5000) chrome.alarms.create(EST_ALARM_MET, { when: crossAt });
  // Already over (or about to be): the repeating reminder runs from the crossing on.
  const every = Number(settings.clickupOverRepeatMin);
  const repeatMin = Number.isFinite(every) ? every : 15;
  if (notifyOn && repeatMin > 0) {
    const have = await chrome.alarms.get(EST_ALARM_OVER).catch(() => null);
    if (!have) chrome.alarms.create(EST_ALARM_OVER, { when: Math.max(now + 60000, crossAt + repeatMin * 60000), periodInMinutes: repeatMin });
  }
}
// Someone else's timer running on the task we're tracking: tell once per their
// timer (ClickUp lets each person run one timer, on any task - two people can
// be on the same task at once). Seen only when ClickUp lets us list their
// entries (workspace admins); otherwise their time shows once it's stopped.
async function notifyParallelTracking(entry, progress) {
  const list = progress && Array.isArray(progress.othersRunning) ? progress.othersRunning : [];
  if (!entry || !list.length) return;
  const { parallelSeen } = await chrome.storage.local.get("parallelSeen");
  const seen = parallelSeen && typeof parallelSeen === "object" ? parallelSeen : {};
  const fresh = list.filter((o) => !seen[String(entry.taskId) + ":" + o.id + ":" + o.startMs]);
  if (!fresh.length) return;
  const keep = {};
  for (const [k, v] of Object.entries(seen)) if (Number(v) > Date.now() - 2 * 86400000) keep[k] = v;
  for (const o of fresh) keep[String(entry.taskId) + ":" + o.id + ":" + o.startMs] = Date.now();
  await chrome.storage.local.set({ parallelSeen: keep });
  const names = fresh.map((o) => o.name).join(", ");
  const name = (progress && progress.taskName) || entry.taskName || "this task";
  await notify("parallel-" + entry.taskId + "-" + Date.now(), "\u26A0 " + names + (fresh.length === 1 ? " is" : " are") + " tracking this task too",
    "\u201C" + name + "\u201D - " + names + " started a timer on it" + (fresh[0].startMs ? " at " + new Date(fresh[0].startMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "") + ", so its estimate is being used by both of you. Check with them before going on.",
    "danger", taskUrlFor(entry.taskId));
}
// Is a timer running, and is it the one we know? One small request. A new timer
// (started in ClickUp or the taskbar app, or restarted after a pause) gets its
// earlier time worked out and its "almost up" / "reached" alarms set at once.
async function syncRunningTimer(cfg) {
  const running = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => undefined);
  if (running === undefined) return { running: null, changed: false }; // couldn't ask: change nothing
  const prev = (await getClickupState()) || {};
  const keyOf = (x) => (x ? String(x.taskId || "") + ":" + String(x.startMs || "") : "");
  const changed = keyOf(prev.running) !== keyOf(running);
  if (changed) await setClickupState({ ...prev, running: running || null });
  if (changed && running) maybeNotifyRunningTask(cfg).catch(() => {});
  if (changed && !running) { await chrome.storage.local.set({ runningProgress: null }).catch(() => {}); await scheduleEstimateAlarms(null).catch(() => {}); }
  return { running: running || null, changed };
}
async function maybeNotifyRunningTask(cfg) {
  if (!cfg || !cfg.token || !cfg.teamId) return;
  const settings = await getSettings();
  let entry;
  try {
    entry = await getCurrentTimeEntry(cfg.token, cfg.teamId);
  } catch (e) {
    return; // best-effort - don't let a failed lookup break the rest of the refresh
  }
  if (!entry) { await chrome.storage.local.set({ runningProgress: null }); await scheduleEstimateAlarms(null); return; }
  let progress;
  try {
    // Asking for the other assignees' entries only works for workspace admins:
    // after a refusal, don't ask again for a day (no wasted request per refresh).
    const { cuOthersRefusedAt } = await chrome.storage.local.get("cuOthersRefusedAt").catch(() => ({}));
    const tryOthers = !(Number(cuOthersRefusedAt) > Date.now() - 86400000);
    const { autoStopTasks: stopRules } = await chrome.storage.local.get("autoStopTasks").catch(() => ({}));
    progress = await getRunningTaskProgress(cfg.token, cfg.teamId, entry.taskId, entry.startMs, Date.now(), { meId: cfg.userId, tryOthers, anyway: !!(stopRules && stopRules[String(entry.taskId)]) });
    if (progress && progress.othersRefused) await chrome.storage.local.set({ cuOthersRefusedAt: Date.now() }).catch(() => {});
  } catch (e) {
    return;
  }
  await notifyParallelTracking(entry, progress).catch(() => {});
  // The floating tracker's bar and face: estimate + time tracked today before this
  // timer started (the live part is added on the page, second by second).
  // closedTodayMs is TODAY's share of that earlier time, so the pages can show
  // "4h 49m · 31m today" for a task tracked across several days.
  await chrome.storage.local.set({ runningProgress: {
    taskId: String(entry.taskId), startMs: entry.startMs || 0, taskName: (progress && progress.taskName) || entry.taskName || "",
    estimateMs: progress ? progress.estimateMs : 0,
    closedMs: progress ? Math.max(0, progress.trackedMs - Math.max(0, Date.now() - (entry.startMs || Date.now()))) : 0,
    closedTodayMs: progress ? Math.max(0, Number(progress.closedTodayMs) || 0) : 0,
    // Part of closedMs that someone else tracked (the estimate is the task's), and
    // anyone tracking it at this very moment.
    othersMs: progress ? Math.max(0, Number(progress.othersMs) || 0) : 0,
    othersRunning: progress && Array.isArray(progress.othersRunning) ? progress.othersRunning : [],
    // Part of closedMs tracked on its subtasks (a parent whose estimate covers them).
    subtasksMs: progress ? Math.max(0, Number(progress.subtasksMs) || 0) : 0,
    subtaskCount: progress ? Math.max(0, Number(progress.subtaskCount) || 0) : 0,
    // Its dates: the strip shows today's time against the task's share for a day.
    startDateMs: (progress && progress.startDateMs) || null, dueDateMs: (progress && progress.dueDateMs) || null,
    at: Date.now(),
  } });
  const { clickupNotified } = await chrome.storage.local.get("clickupNotified");
  const seen = clickupNotified && typeof clickupNotified === "object" ? clickupNotified : {};
  const runningNear = (seen.runningNear && typeof seen.runningNear === "object") ? seen.runningNear : {};
  const runningMet = (seen.runningMet && typeof seen.runningMet === "object") ? seen.runningMet : {};
  const today = todayString();
  const key = String(entry.taskId);
  // "Almost up" / "reached" are said once per task AND estimate: raising the
  // estimate after the alert (10m -> 30m) gets its own alerts for the new one
  // (it used to be once per task per day, so the raised estimate never alerted).
  const stamp = today + "|" + Math.round((Number(progress && progress.estimateMs) || 0) / 60000);
  await scheduleEstimateAlarms(entry, progress, settings, runningNear[key] === stamp, runningMet[key] === stamp).catch(() => {});
  // A task marked to complete itself (autoCompleteTasks, chosen per task): when
  // the running task's tracked time reaches its estimate, stop the timer and mark
  // it complete. Never the Extra Task or a configured recurring / multi-day task
  // (daily buckets). A task shared with others can be marked - the person chose it.
  const { autoCompleteTasks: acMarked } = await chrome.storage.local.get("autoCompleteTasks").catch(() => ({}));
  if (acMarked && acMarked[key] && progress && progress.estimateMs > 0 && progress.trackedMs >= progress.estimateMs && runningMet[key] !== stamp) {
    const name0 = progress.taskName || entry.taskName || "this task";
    const configured = (Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : []).some((u) => parseTaskIdFromUrl(u) === key);
    const isExtra = /\bextra\s*\(?s?\)?\s*tasks?\b/i.test(name0);
    let task = null;
    try { task = await getTaskById(cfg.token, key); } catch (e) {}
    if (!configured && !isExtra && task) {
      try {
        await stopTimer(cfg.token, cfg.teamId);
        // Comments kept for completion go out first (nobody to ask here).
        const held = await heldList(key).catch(() => []);
        if (held.length) {
          try { await sendHeldComments(cfg, key, held); }
          catch (e) { await notify("held-fail-" + key, "💬 Waiting comment not posted", "“" + name0 + "” was completed at its estimate, but its waiting comment couldn't be posted (" + String(e && e.message ? e.message : e) + "). It's still in the task's ▸ details - press Send now there.", "danger", task.url); }
        }
        await setTaskStatus(cfg.token, key, "complete");
        const st = (await getClickupState().catch(() => null)) || {};
        if (String(st.activeTaskId || "") === key) await setClickupState({ ...st, activeTaskId: null });
        const left = { ...acMarked }; delete left[key]; // done: no longer marked
        await chrome.storage.local.set({ runningProgress: null, autoCompleteTasks: left, clickupNotified: { ...seen, runningMet: { ...runningMet, [key]: stamp } } });
        await scheduleEstimateAlarms(null);
        await advanceAutoRun(cfg, key);
        await notify("clickup-autocomplete-" + Date.now(), "Completed automatically ✓",
          "\"" + name0 + "\" reached its " + fmtDuration(progress.estimateMs) + " estimate, so the timer was stopped and the task marked complete.",
          undefined, taskUrlFor(key));
        clearFilterCache();
        // Not awaited: this can run inside a refresh, which must finish first.
        setTimeout(() => { refreshClickup({ includeTasks: true }).catch(() => {}); }, 2000);
        return;
      } catch (e) {
        diagLog("auto-complete", String(e && e.message ? e.message : e));
        // Fall through to the usual "estimate reached" notice.
      }
    }
  }
  if (await maybeAutoStop(cfg, entry, progress, key, today).catch(() => false)) return;
  if (settings.clickupRunningNotify === false) return;
  if (!progress || !(progress.estimateMs > 0)) return; // task has no estimate set - nothing to compare against
  const thresholdMs = nearLeadMs(settings, progress.estimateMs);
  const remainingMs = progress.estimateMs - progress.trackedMs;
  const name = progress.taskName || entry.taskName || "this task";
  if (remainingMs <= 0) {
    // Still running past it, after the first notice: say so again every few
    // minutes (danger sound), so a timer left on can't run on unnoticed.
    const every = Number(settings.clickupOverRepeatMin);
    const repeatMin = Number.isFinite(every) ? every : 15;
    const overMsNow = progress.trackedMs - progress.estimateMs;
    const runningOver = (seen.runningOver && typeof seen.runningOver === "object") ? seen.runningOver : {};
    if (runningMet[key] === stamp && repeatMin > 0 && overMsNow >= 60000 && Date.now() - (Number(runningOver[key]) || 0) >= (repeatMin - 0.5) * 60000) {
      await notify("clickup-running-over-" + Date.now(), "Still running - " + fmtDuration(overMsNow) + " over the estimate ⚠️",
        "\"" + name + "\" has " + fmtDuration(progress.trackedMs) + " tracked against a " + fmtDuration(progress.estimateMs) + " estimate. Stop the timer, complete the task, or raise its estimate.",
        "danger", taskUrlFor(entry.taskId));
      await chrome.storage.local.set({ clickupNotified: { ...seen, runningOver: { ...runningOver, [key]: Date.now() } } });
    }
    if (runningMet[key] !== stamp) {
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
      await chrome.storage.local.set({ clickupNotified: { ...seen, runningMet: { ...runningMet, [key]: stamp }, runningOver: { ...runningOver, [key]: Date.now() } } });
    }
  } else if (thresholdMs > 0 && remainingMs <= thresholdMs) {
    if (runningNear[key] !== stamp) {
      // Tracked time is about to reach the task's own estimate - warn with the
      // urgent alarm so the user wraps up in time (not just after crossing).
      const taskUrl = taskUrlFor(entry.taskId);
      await notify("clickup-running-near-" + Date.now(), "ClickUp - estimate almost up ⏳",
        "\"" + name + "\" has " + fmtDuration(remainingMs) + " left of its " + fmtDuration(progress.estimateMs) + " estimate - wrap up soon.",
        "danger",
        taskUrl);
      await chrome.storage.local.set({ clickupNotified: { ...seen, runningNear: { ...runningNear, [key]: stamp } } });
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

  // Mon-Fri inside office hours - the same rule the estimate nudges use.
  if (!insideOfficeHours(settings)) return;
  // Stay quiet while the user is away from the computer (idle 5+ min or locked).
  try { if ((await chrome.idle.queryState(300)) !== "active") return; } catch (e) {}

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

  // Offer a one-click Start on the most important open task due today.
  const top = pickTopTask(await getClickupState().catch(() => null));
  if (top) await chrome.storage.local.set({ cuNudgeTask: { id: String(top.id), name: top.name || "" } });
  const label = top ? String(top.name || "task") : "";
  await notify("clickup-idle-" + Date.now(), "Time tracking hasn't started yet ⏱️",
    "No ClickUp timer is running. Are you working? Start your timer so today's time gets tracked.",
    "danger", null,
    top ? { buttons: [{ title: "▶ Start: " + (label.length > 38 ? label.slice(0, 37) + "…" : label) }] } : null);
  await chrome.storage.local.set({ clickupNotified: { ...seen, idleNudgeAt: Date.now() } });
}

// Most important open task due today (priority, then biggest estimate). Skips
// the Extra Task and tasks waiting on someone else.
const TOP_PRIO_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
function pickTopTask(st) {
  // todayFilter follows the Filter the user has on (e.g. "this week"), so it can
  // hold tasks due later: only a task whose due date is TODAY qualifies.
  const waiting = (st && st.waiting) || {};
  const rank = (t) => { const r = TOP_PRIO_RANK[String(t.priority || "").toLowerCase()]; return r == null ? 4 : r; };
  const dayStart = new Date().setHours(0, 0, 0, 0), dayEnd = dayStart + 86400000;
  const dueToday = (t) => { const d = Number(t && t.dueDateMs) || 0; return d >= dayStart && d < dayEnd; };
  const seen = new Set();
  const pool = [...((st && st.tasks) || []), ...((st && st.todayFilter && st.todayFilter.tasks) || [])]
    .filter((t) => t && t.id != null && !seen.has(String(t.id)) && seen.add(String(t.id)));
  const open = pool.filter((t) => !t.done && dueToday(t) && Number(t.assigneeCount || 1) <= 1 &&
    t.type !== "extra" && !/\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(t.name || "") && !waiting[String(t.id)]);
  open.sort((a, c) => rank(a) - rank(c) || (Number(c.estimateMs) || 0) - (Number(a.estimateMs) || 0));
  return open[0] || null;
}

// "▶ Start" button on the not-tracking reminder. Never switches away from a
// timer that started meanwhile; shared tasks just open in ClickUp.
async function startTaskFromNudge(taskId) {
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId) return;
  try {
    const task = await getTaskById(cfg.token, taskId).catch(() => null);
    if (task && task.assigneeCount > 1) { chrome.tabs.create({ url: task.url || taskUrlFor(taskId) }).catch(() => {}); return; }
    const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
    if (cur) return;
    const st = (await getClickupState().catch(() => null)) || {};
    if (st.activeTaskId && String(st.activeTaskId) !== String(taskId)) await setTaskStatus(cfg.token, String(st.activeTaskId), "to do").catch(() => {});
    await setTaskStatus(cfg.token, taskId, "in progress").catch(() => {});
    await startTimer(cfg.token, cfg.teamId, taskId);
    const st2 = (await getClickupState().catch(() => null)) || {};
    await setClickupState({ ...st2, activeTaskId: String(taskId) });
    clearFilterCache();
    refreshClickup({ includeTasks: true }).catch(() => {});
  } catch (e) {
    await notify("cu-start-fail-" + Date.now(), "Couldn't start the timer", String((e && e.message) || e), "danger", taskUrlFor(taskId));
  }
}

// ---------- away protection ----------
// Chrome reports "idle" after N seconds without input (N = the away threshold)
// or "locked" at once. When the user comes back and a ClickUp timer ran through
// the whole away stretch, ask once: remove the away time, or keep it.
async function awaySettings() {
  const s = await getSettings();
  return { on: s.clickupAwayNotify !== false, min: Math.min(240, Math.max(5, Number(s.clickupAwayMin) || 15)) };
}
async function applyIdleInterval() {
  try { const { min } = await awaySettings(); chrome.idle.setDetectionInterval(min * 60); } catch (e) {}
}
async function onIdleStateChanged(newState) {
  const now = Date.now();
  const { cuAway } = await chrome.storage.local.get("cuAway");
  if (newState === "idle" || newState === "locked") {
    if (cuAway && cuAway.since) return; // keep the earliest moment (idle, then locked)
    const { min } = await awaySettings();
    await chrome.storage.local.set({ cuAway: { since: newState === "idle" ? now - min * 60000 : now } });
    return;
  }
  if (!cuAway || !cuAway.since) return; // back to "active"
  await chrome.storage.local.remove("cuAway");
  const { on, min } = await awaySettings();
  const awayMs = now - cuAway.since;
  if (!on || awayMs < min * 60000) return;
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId) return;
  let cur = null;
  try { cur = await getCurrentTimeEntry(cfg.token, cfg.teamId); } catch (e) { return; }
  if (!cur || !cur.id || !(cur.startMs < cuAway.since)) return; // no timer ran through the away time
  const p = { entryId: cur.id, taskId: String(cur.taskId), taskName: cur.taskName || "", description: cur.description || "", startMs: cur.startMs, since: cuAway.since };
  await chrome.storage.local.set({ cuAwayPending: p });
  const at = new Date(p.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  await notify("away-" + now, "You were away " + fmtDuration(awayMs),
    "Your timer on \"" + (p.taskName || "a task") + "\" kept running since " + at + ". Remove the away time?",
    undefined, null, { priority: 2, requireInteraction: true, buttons: [{ title: "Remove away time" }, { title: "Keep it" }] });
}
// "Remove away time": end the entry at the moment the user left and, if it was
// still running, start the same task again now (same description). ClickUp then
// shows two rows with the away gap removed.
async function removeAwayTime() {
  const { cuAwayPending: p } = await chrome.storage.local.get("cuAwayPending");
  await chrome.storage.local.remove("cuAwayPending");
  if (!p || !p.entryId) return;
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId) return;
  try {
    const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
    const stillRunning = !!(cur && String(cur.id) === String(p.entryId));
    if (stillRunning) await stopTimer(cfg.token, cfg.teamId);
    await updateTimeEntry(cfg.token, cfg.teamId, p.entryId, { start: p.startMs, end: p.since, duration: p.since - p.startMs, tid: p.taskId });
    if (stillRunning) await startTimer(cfg.token, cfg.teamId, p.taskId, p.description);
    clearFilterCache();
    refreshClickup({ includeTasks: true }).catch(() => {});
    const at = new Date(p.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    await notify("cu-away-done-" + Date.now(), "Away time removed",
      "\"" + (p.taskName || "Your task") + "\" now stops at " + at + (stillRunning ? ", and its timer is running again from now." : "."));
  } catch (e) {
    await notify("cu-away-fail-" + Date.now(), "Couldn't remove the away time",
      String((e && e.message) || e) + " You can edit the entry in ClickUp Timesheet.", "danger", "https://app.clickup.com");
  }
}

// ---------- end-of-day wrap-up ----------
const WRAPUP_ALARM = "cuWrapUp";
function parseHM(str, def) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || "").trim());
  if (!m || +m[1] > 23 || +m[2] > 59) return def;
  return [+m[1], +m[2]];
}
function nextWrapUpAt(timeStr, now = Date.now()) {
  const [h, m] = parseHM(timeStr, [16, 45]);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function scheduleWrapUpAlarm() {
  try {
    const s = await getSettings();
    if (s.clickupWrapUp === false) { await chrome.alarms.clear(WRAPUP_ALARM); return; }
    const when = nextWrapUpAt(s.clickupWrapUpTime);
    const ex = await chrome.alarms.get(WRAPUP_ALARM);
    if (ex && Math.abs(ex.scheduledTime - when) < 60000) return;
    // The worker wakes every minute; one that wakes just after the wrap-up
    // minute (before the alarm is delivered) used to push TODAY's pending alarm
    // to tomorrow. Leave an alarm for today's configured time alone.
    const [h, m] = parseHM(s.clickupWrapUpTime, [16, 45]);
    const todayAt = new Date().setHours(h, m, 0, 0);
    if (ex && Math.abs(ex.scheduledTime - todayAt) < 60000 && ex.scheduledTime > Date.now() - 10 * 60000) return;
    await chrome.alarms.create(WRAPUP_ALARM, { when });
  } catch (e) {}
}
// Open tasks due TODAY (the ones worth moving), from the Today view's rows.
function wrapUpOpenTasks(st) {
  const b = (st && st.todayFilter && Array.isArray(st.todayFilter.tasks)) ? st.todayFilter : (st || {});
  const today = new Date().setHours(0, 0, 0, 0);
  return (Array.isArray(b.tasks) ? b.tasks : []).filter((t) => t && !t.done && t.type !== "extra" &&
    !/^extras?\s+tasks?\b/i.test(t.name || "") && t.dueDateMs && new Date(t.dueDateMs).setHours(0, 0, 0, 0) === today);
}
async function onWrapUpAlarm() {
  await scheduleWrapUpAlarm(); // tomorrow's
  await maybeWrapUp();
}
// How long after the wrap-up time a late start (PC asleep, Chrome closed, alarm
// lost) still gets today's wrap-up. Checked from the every-minute update alarm.
const WRAPUP_LATE_MS = 4 * 3600000;
// Open the wrap-up page, or bring an already-open one to the front.
async function openWrapUpPage() {
  const url = chrome.runtime.getURL("wrapup.html");
  try {
    const tabs = await chrome.tabs.query({ url: url + "*" });
    if (tabs && tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true });
      if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch (e) {}
  await chrome.tabs.create({ url }).catch(() => {});
}
// The weekly "Extra Task" is a recurring ClickUp task (Mon-Fri). ClickUp makes
// next week's copy when this one is closed, so a forgotten one used to block
// next week's. From 5 PM on its due day (Friday) - or the next time the
// extension runs if Chrome was closed then - an open occurrence is set to
// "complete", once per occurrence. Never while its timer is still running (it
// waits until you stop). Settings > ClickUp setup > "Close my weekly Extra
// Task" turns it off.
const EXTRA_CLOSE_HOUR = 17;
function extraCloseDue(t, now) {
  if (!t || !t.id || t.done || !(Number(t.dueDateMs) > 0)) return false;
  const at = new Date(Number(t.dueDateMs)); at.setHours(EXTRA_CLOSE_HOUR, 0, 0, 0);
  return now >= at.getTime();
}
// A week that is office holidays from Monday to Friday (Dashain...) needs no
// Extra Task: its occurrence is closed at once, so it never sits in the lists
// and ClickUp makes the next working week's. A week with any working day keeps it.
function extraWeekAllHoliday(t) {
  if (!t || !t.id || t.done || !(Number(t.dueDateMs) > 0)) return false;
  const d = new Date(Number(t.dueDateMs)); d.setHours(12, 0, 0, 0);
  const dow = d.getDay();
  const mon = new Date(d);
  if (dow === 0) mon.setDate(mon.getDate() + 1); else if (dow === 6) mon.setDate(mon.getDate() + 2); else mon.setDate(mon.getDate() - (dow - 1));
  for (let i = 0; i < 5; i++) { const x = new Date(mon); x.setDate(mon.getDate() + i); if (!isCompanyHoliday(x.getTime())) return false; }
  return true;
}
async function maybeCloseExtraTask() {
  const s = await getSettings();
  if (s.clickupExtraAutoClose === false) return;
  const st = (await getClickupState().catch(() => null)) || {};
  const ex = st.extraTask;
  const now = Date.now();
  const skip = extraWeekAllHoliday(ex);
  if (!skip && !extraCloseDue(ex, now)) return;
  const { extraAutoClosed, extraCloseTry } = await chrome.storage.local.get(["extraAutoClosed", "extraCloseTry"]);
  const done = extraAutoClosed && typeof extraAutoClosed === "object" ? extraAutoClosed : {};
  if (done[ex.id]) return;
  // At most one try every 5 minutes (it waits while the timer runs), and an hour
  // after a failed one - this runs every minute, ClickUp's limits are shared.
  const tr = extraCloseTry && extraCloseTry.id === String(ex.id) ? extraCloseTry : null;
  if (tr && now - (tr.at || 0) < (tr.failed ? 3600000 : 5 * 60000)) return;
  await chrome.storage.local.set({ extraCloseTry: { id: String(ex.id), at: now } });
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId) return;
  // Re-read it: the state can be minutes old (closed by hand meanwhile, or moved).
  const t = await getTaskById(cfg.token, String(ex.id)).catch(() => null);
  if (!t) return;
  const fresh = { id: String(ex.id), done: isTaskDone(t), dueDateMs: Number(t.dueDateMs || t.due_date) || 0 };
  if (skip ? !extraWeekAllHoliday(fresh) : !extraCloseDue(fresh, now)) return; // (its dates moved meanwhile: left alone)
  const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
  if (cur && String(cur.taskId) === fresh.id) return; // still tracking on it: wait until it's stopped
  try { await setTaskStatus(cfg.token, fresh.id, "complete"); }
  catch (e) { await chrome.storage.local.set({ extraCloseTry: { id: fresh.id, at: now, failed: String(e && e.message ? e.message : e).slice(0, 200) } }); return; }
  done[fresh.id] = now;
  const keep = Object.entries(done).sort((a, b) => b[1] - a[1]).slice(0, 20);
  await chrome.storage.local.set({ extraAutoClosed: Object.fromEntries(keep) });
  clearFilterCache();
  // ClickUp creates next week's occurrence a moment after the close: forget the
  // Extra Task each week had, refresh now, and once more a bit later with the
  // week views rebuilt so "Due next week" shows the new one.
  extraTaskCache.clear();
  refreshClickup({ includeTasks: true }).catch(() => {});
  setTimeout(() => { extraTaskCache.clear(); clearFilterCache(); refreshClickup({ includeTasks: true, forceWeeks: true, forceWeekly: true }).catch(() => {}); }, 90000);
  await notify("cu-extra-closed-" + now, skip ? "Holiday week: Extra Task skipped" : "Extra Task closed for this week",
    skip ? (ex.name || "Your Extra Task") + " was for a week of office holidays, so it was closed straight away. ClickUp now creates the one for the next working week."
      : (ex.name || "Your Extra Task") + " was still open after 5 PM on its due day, so it was marked complete. ClickUp now creates next week's one.",
    undefined, t.url || ex.url || null);
}
// ---------- the Extra Task's dates: Monday to Friday of one week ----------
// A recurring Extra Task whose repeat rule is off comes out e.g. "Fri -> Mon".
// Its week is the one it's due in (a weekend due date: the week after); the fix
// keeps both times of day. null = the dates are fine (or nothing to check).
function extraWeekDates(ex) {
  if (!ex || ex.done || !Number(ex.dueDateMs)) return null;
  const due = new Date(Number(ex.dueDateMs));
  const d0 = new Date(due); d0.setHours(0, 0, 0, 0);
  const dow = d0.getDay();
  const mon = new Date(d0);
  if (dow === 0) mon.setDate(mon.getDate() + 1); else if (dow === 6) mon.setDate(mon.getDate() + 2); else mon.setDate(mon.getDate() - (dow - 1));
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const s = Number(ex.startDateMs) ? new Date(Number(ex.startDateMs)) : null;
  const okStart = !!s && new Date(s).setHours(0, 0, 0, 0) === mon.getTime();
  if (okStart && d0.getTime() === fri.getTime()) return null;
  const st = new Date(mon); if (s) st.setHours(s.getHours(), s.getMinutes(), 0, 0); else st.setHours(9, 0, 0, 0);
  const du = new Date(fri); du.setHours(due.getHours(), due.getMinutes(), 0, 0);
  const f = (d) => d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return { startMs: st.getTime(), dueMs: du.getTime(), label: f(mon) + " \u2013 " + f(fri) };
}
// Once per occurrence and its dates: say so, with a one-click fix.
async function maybeCheckExtraDates() {
  const st = await getClickupState().catch(() => null);
  const ex = st && st.extraTask;
  const fix = extraWeekDates(ex);
  if (!fix) return;
  const key = ex.id + ":" + (ex.startDateMs || 0) + ":" + ex.dueDateMs;
  const { extraDatesWarned } = await chrome.storage.local.get("extraDatesWarned");
  if (extraDatesWarned === key) return;
  await chrome.storage.local.set({ extraDatesWarned: key });
  await notify("cu-extradates-" + Date.now(), "Your Extra Task's dates look off",
    (ex.name || "The Extra Task") + " isn't set Monday to Friday of one week. Fix it to " + fix.label + "? (Its repeat rule in ClickUp may need the same fix.)",
    undefined, null, { buttons: [{ title: "Fix dates to " + fix.label }], requireInteraction: true });
}
async function fixExtraDates() {
  const cfg = await getClickupConfig();
  const st = await getClickupState().catch(() => null);
  const ex = st && st.extraTask;
  const fix = extraWeekDates(ex);
  if (!cfg || !cfg.token || !fix) return { ok: !fix, already: !fix };
  await setTaskDates(cfg.token, ex.id, fix.startMs, fix.dueMs);
  extraTaskCache.clear(); clearFilterCache();
  refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
  return { ok: true, label: fix.label };
}

// ---------- heads-up before an office holiday ----------
// On the last working day before a company holiday (from 2 PM): one notice per
// holiday with your open tasks due while the office is closed, so they can be
// moved in time - or "nothing due then".
async function maybeHolidayHeadsUp(now = Date.now()) {
  const s = await getSettings();
  if (s.clickupHolidayHeadsUp === false) return;
  const d = new Date(now);
  if (d.getHours() < 14 || d.getDay() === 0 || d.getDay() === 6 || isCompanyHoliday(now)) return;
  const n = new Date(d); n.setHours(12, 0, 0, 0); n.setDate(n.getDate() + 1);
  for (let i = 0; i < 4 && (n.getDay() === 0 || n.getDay() === 6); i++) n.setDate(n.getDate() + 1);
  const k = calYmd(n.getTime());
  const hol = companyCal.find((e) => e.kind === "holiday" && k >= e.from && k <= (e.to || e.from));
  if (!hol) return;
  const key = hol.from + "|" + hol.title;
  const { holidayHeadsUp } = await chrome.storage.local.get("holidayHeadsUp");
  const seen = Array.isArray(holidayHeadsUp) ? holidayHeadsUp : [];
  if (seen.includes(key)) return;
  await chrome.storage.local.set({ holidayHeadsUp: seen.concat(key).slice(-20) });
  const end = new Date((hol.to || hol.from) + "T23:59:59").getTime();
  const from = new Date(d); from.setHours(23, 59, 59, 999);
  let due = [];
  try {
    const cfg = await getClickupConfig();
    const r = cfg && cfg.token ? await getOpenTasks(cfg, false) : null;
    due = ((r && r.ok && r.data && r.data.tasks) || []).filter((t) => t && !t.done && Number(t.dueDateMs) > from.getTime() && Number(t.dueDateMs) <= end);
  } catch (e) {}
  const f = (ymdS) => new Date(ymdS + "T12:00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const when = f(hol.from) + (hol.to && hol.to !== hol.from ? " \u2013 " + f(hol.to) : "");
  const names = due.slice(0, 3).map((t) => "\u2022 " + String(t.name || "").slice(0, 60)).join("\n");
  await notify("cu-holiday-" + Date.now(), hol.title + " - " + when,
    due.length ? "The office is closed then and " + due.length + " of your tasks " + (due.length === 1 ? "is" : "are") + " due:\n" + names + (due.length > 3 ? "\n\u2026 and " + (due.length - 3) + " more" : "") + "\nMove the dates today (or ask your senior)."
      : "The office is closed then. Nothing of yours is due in those days \u2713",
    undefined, chrome.runtime.getURL("options.html#dashboard"), due.length ? { requireInteraction: true } : undefined);
}

async function maybeWrapUp() {
  const s = await getSettings();
  if (s.clickupWrapUp === false) return;
  const now = new Date();
  if (now.getDay() === 0 || now.getDay() === 6) return;
  if (isCompanyHoliday(now.getTime())) return; // company holiday
  const [h, m] = parseHM(s.clickupWrapUpTime, [16, 45]);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (now.getTime() < at.getTime() - 5000) return; // not time yet today
  if (now.getTime() > at.getTime() + WRAPUP_LATE_MS) return; // too late to be useful
  const { cuWrapUpShown } = await chrome.storage.local.get("cuWrapUpShown");
  if (cuWrapUpShown === todayString()) return;
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token) return;
  const st = await getClickupState().catch(() => null);
  if (!st) return;
  await chrome.storage.local.set({ cuWrapUpShown: todayString() });
  // Open the page itself: a notification alone is easy to miss (Focus Assist,
  // Do Not Disturb, or it slides into the Action Center unseen).
  await openWrapUpPage();
  const open = wrapUpOpenTasks(st).length;
  const target = Number(st.targetMs) > 0 ? " of " + fmtDuration(st.targetMs) : "";
  await notify("wrapup-" + Date.now(), "Time to wrap up the day 📋",
    "Tracked " + fmtDuration(Number(st.spentMs) || 0) + target + ". " +
      (open ? open + " task" + (open === 1 ? "" : "s") + " due today still open." : "Everything due today is done ✓") +
      " Click to review and copy your standup.",
    undefined, chrome.runtime.getURL("wrapup.html"));
}
// ---------- Daily "needs tidying" reminder ----------
// One summary a day of what the Insights tab flags: overdue, no estimate, no
// due date, blocked, plus a "dependency resolved, carry on and close it" line
// for tasks that were blocked yesterday and are free now. Silent when there's
// nothing to say. It rides the every-minute update alarm (no alarm of its own),
// with a late window so a laptop that was asleep at the time still gets it.
const TIDY_LATE_MS = 4 * 3600000;
function tidySettings(s) {
  return {
    cats: (s && s.clickupTidyCats) || {},
    max: Number(s && s.clickupTidyMax) || 3,
    resolved: !s || s.clickupTidyResolved !== false,
  };
}
// Gather everything the notification needs. Shared by the scheduled nudge and
// the Options "Preview now" button, so what you preview is what you get.
async function tidyReminderPayload(opts = {}) {
  const s = opts.settings || await getSettings();
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, reason: "not-configured" };
  const st = await getClickupState().catch(() => null);
  if (!st) return { ok: false, reason: "no-state" };
  const res = await getOpenTasks(cfg, opts.fresh !== false).catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
  if (!res || !res.ok || !res.data || !Array.isArray(res.data.tasks)) {
    return { ok: false, reason: "no-tasks", error: res && res.error };
  }
  const todayStart = new Date().setHours(0, 0, 0, 0);
  // A paused client's tasks get no tidy-up nudges.
  const model = tidyCollect(res.data.tasks.filter((t) => !isPausedRow(t)), st.waiting, todayStart, { offDay: offDayReason(s.clickupWeekMode) });
  // Yesterday's blocked list, so we can spot what has been freed up since.
  const { cuTidyBlocked } = await chrome.storage.local.get("cuTidyBlocked");
  const snap = cuTidyBlocked && typeof cuTidyBlocked === "object" ? cuTidyBlocked : {};
  const t = tidySettings(s);
  const resolved = t.resolved && snap.day && snap.day !== todayString()
    ? tidyResolved(snap.ids || [], model, res.data.tasks) : [];
  const say = tidyLines(model, { cats: t.cats, max: t.max, resolved });
  return { ok: true, model, resolved, say, urgent: tidyUrgent(model, resolved), blockedIds: model.blockedIds };
}
// A due date on a day off: a company holiday (from the team calendar) or the
// weekend - the days outside the working week ("A week runs": Sun-Thu teams are
// off Fri-Sat, everyone else Sat-Sun). Returns why ("Sat 10 Oct", "Dashain
// holidays · 21 Oct"), "" for a working day.
function offDayReason(weekMode) {
  const off = weekMode === "sun-thu" ? [5, 6] : [6, 0];
  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return (ms) => {
    const hol = companyOn(ms).find((e) => e.kind === "holiday");
    if (hol) return (hol.title || "Company holiday") + " \u00b7 " + tidyDateShort(ms);
    const d = new Date(ms).getDay();
    return off.includes(d) ? DAY[d] + " " + tidyDateShort(ms) : "";
  };
}
// The Insights lists a "needs tidying" notification talks about, in its order:
// counts keys (lib-tidy) -> the Insights drill ids. Kept IN the notification id
// ("cu-tidy-overdue.noest-<time>"), because the in-memory click target is gone
// once Chrome puts the worker to sleep - that's how a click ended up opening
// plain ClickUp instead of Insights.
const TIDY_DRILL = { overdue: "overdue", noEst: "noest", noDue: "nodue", blocked: "blocked" };
function tidyDrills(say) {
  return Object.keys((say && say.counts) || {}).map((k) => TIDY_DRILL[k]).filter(Boolean);
}
function tidyDrillsFromId(id) {
  const m = /^cu-tidy-(?:preview-)?([a-z.]+)-\d+$/.exec(String(id || ""));
  return m ? m[1].split(".").filter((d) => Object.values(TIDY_DRILL).includes(d)) : [];
}
// Shown until clicked or closed with its own X (no buttons): opens those lists.
const TIDY_NOTE_OPTS = { priority: 2, requireInteraction: true };
async function openInsightsPage(drills) {
  const url = chrome.runtime.getURL("options.html" + (drills && drills.length ? "?drill=" + drills.join(",") : "") + "#insights");
  // An open dashboard: change only its #hash (no reload - a half-typed note in
  // Clients would be lost) and hand it the lists through storage (options.js).
  try {
    const open = await chrome.tabs.query({ url: chrome.runtime.getURL("options.html") + "*" });
    if (open && open.length) {
      if (drills && drills.length) await chrome.storage.local.set({ insGoDrills: { drills, at: Date.now() } });
      const cur = String(open[0].url || "").split("#")[0];
      await chrome.tabs.update(open[0].id, { active: true, url: cur + "#insights" });
      if (open[0].windowId != null) await chrome.windows.update(open[0].windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch (e) {}
  try {
    const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("options.html") + "*" });
    if (tabs && tabs.length) {
      await chrome.tabs.update(tabs[0].id, { active: true, url });
      if (tabs[0].windowId != null) await chrome.windows.update(tabs[0].windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch (e) {}
  await chrome.tabs.create({ url }).catch(() => {});
}
async function maybeTidyNotify() {
  const s = await getSettings();
  if (s.clickupTidyNotify === false) return;
  const now = new Date();
  if (!tidyDayOk(s.clickupTidyDays, now)) return;
  if (isCompanyHoliday(now.getTime())) return; // company holiday: nobody wants a nudge
  const [h, m] = parseHM(s.clickupTidyTime, [14, 0]);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  if (now.getTime() < at.getTime() - 5000) return; // not time yet today
  if (now.getTime() > at.getTime() + TIDY_LATE_MS) return; // too late to be useful
  const { cuTidyShown } = await chrome.storage.local.get("cuTidyShown");
  if (cuTidyShown === todayString()) return; // once a day, never twice
  const p = await tidyReminderPayload({ settings: s }).catch(() => null);
  if (!p || !p.ok) return; // not connected / ClickUp unhappy: stay quiet, try tomorrow
  // Mark the day before saying anything, so a second wake in the same minute
  // can't post the same summary twice, and remember what was blocked so
  // tomorrow can spot a dependency that got resolved.
  await chrome.storage.local.set({
    cuTidyShown: todayString(),
    cuTidyBlocked: { day: todayString(), ids: p.blockedIds || [] },
  });
  if (p.say.empty) return; // clean board: no notification at all
  const drills = tidyDrills(p.say);
  await notify("cu-tidy-" + (drills.join(".") || "all") + "-" + Date.now(), p.say.title, p.say.message, p.urgent ? "danger" : undefined,
    null, { contextMessage: (p.say.context || "Insights") + " · click to see them", ...TIDY_NOTE_OPTS });
}
// Keep a task's time of day when moving its due date to another day.
function shiftDueToDay(oldDueMs, dayMs) {
  const d = new Date(dayMs);
  if (oldDueMs) { const o = new Date(oldDueMs); d.setHours(o.getHours(), o.getMinutes(), o.getSeconds(), o.getMilliseconds()); }
  else d.setHours(12, 0, 0, 0);
  return d.getTime();
}

// ---------- what counts as a "week" ----------
// Teams disagree: some run Sunday to Saturday, some Monday to Sunday, some only
// count working days. One setting (clickupWeekMode) drives every week view, so
// "Due this week" always means the same thing across the extension.
const CU_WEEK_MODES = {
  "sun-sat": { start: 0, days: 7, label: "Sun-Sat" },
  "mon-sun": { start: 1, days: 7, label: "Mon-Sun" },
  "mon-fri": { start: 1, days: 5, label: "Mon-Fri" },
  "sun-thu": { start: 0, days: 5, label: "Sun-Thu" },
};
// ---- This week by day: another week (the card's ‹ / ›) ----
// The same per-day breakdown as this week (fetchWeeklySummary: one paginated
// read of the week's tasks + one of its tracked time), built only when asked and
// kept 30 minutes per week, so paging back and forth costs nothing more. From 8
// weeks back to 12 ahead. While ClickUp has asked us to slow down, nothing is read.
const WEEK_AT_TTL = 30 * 60000;
const weekAtMem = new Map(); // "fromTs:rule" -> weekly
async function weekAtOffset(offset, force) {
  const off = Math.max(-8, Math.min(12, Math.round(Number(offset) || 0)));
  const cfg = await getClickupConfig();
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, error: "ClickUp isn't set up." };
  const settings = await getSettings();
  const b = cuWeekBounds(settings.clickupWeekMode || "sun-sat", off);
  const extendedMode = extendedModeOf(settings), spread = spreadOf(settings), multiDay = multiDayOf(settings);
  const rule = WEEKLY_RULE + ":" + multiDay;
  const key = b.fromTs + ":" + rule;
  const hit = weekAtMem.get(key);
  if (!force && hit && Date.now() - hit.at < WEEK_AT_TTL) return { ok: true, weekly: hit, cached: true };
  const st = await getClickupState().catch(() => null);
  if (st && st.rateLimitedUntil > Date.now()) return hit ? { ok: true, weekly: hit, cached: true } : { ok: false, error: "ClickUp asked us to slow down - try again in a minute." };
  const taskUrls = mergeExtraTaskUrl(Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : [], st && st.extraTask);
  const weekly = await fetchWeeklySummary({ token: cfg.token, teamId: cfg.teamId, userId: cfg.userId, taskUrls, fromTs: b.fromTs, toTs: b.toTs, extendedMode, taskCache: createTaskCache(), spread });
  weekly.at = Date.now(); weekly.rule = rule; weekly.offset = off;
  try { await annotateClients(cfg.token, { weekly }, settings.cuClientLevel || "auto"); } catch (e) {}
  weekAtMem.set(key, weekly);
  if (weekAtMem.size > 12) weekAtMem.delete(weekAtMem.keys().next().value);
  return { ok: true, weekly };
}
function cuWeekBounds(mode, offsetWeeks, now) {
  const m = CU_WEEK_MODES[mode] || CU_WEEK_MODES["sun-sat"];
  const d = new Date(now == null ? Date.now() : now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - m.start + 7) % 7) + (offsetWeeks || 0) * 7);
  const end = new Date(d);
  end.setDate(d.getDate() + m.days - 1);
  end.setHours(23, 59, 59, 999);
  return { fromTs: d.getTime(), toTs: end.getTime(), label: m.label, days: m.days };
}

// Read / write a JSON file in the repo (update-policy.json). A missing file
// reads as { data: null } and is created on the first write.
async function ghGetJsonFile(head, path) {
  const res = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/contents/" + path, { headers: head, cache: "no-store" });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(path + ": GitHub said HTTP " + res.status);
  const j = await res.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(String(j.content || "").replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { data, sha: j.sha || null };
}
async function ghPutJsonFile(head, path, obj, sha, message) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2) + "\n");
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const body = { message, content: btoa(bin) };
  if (sha) body.sha = sha;
  const put = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/contents/" + path, {
    method: "PUT", headers: { ...head, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!put.ok) {
    let why = "HTTP " + put.status;
    try { const e = await put.json(); if (e && e.message) why = e.message; } catch (e2) {}
    throw new Error(path + ": " + why);
  }
}

// Update one file in the repo: read it, let `change` rewrite the text (null =
// nothing to do), then commit it back. Used when publishing, so the repository
// carries the same version and notes as the release.
async function ghPutFile(head, path, change, message) {
  const url = "https://api.github.com/repos/" + UPDATE_REPO + "/contents/" + path;
  const res = await fetch(url, { headers: head, cache: "no-store" });
  if (!res.ok) throw new Error(path + ": GitHub said HTTP " + res.status);
  const j = await res.json();
  const text = new TextDecoder().decode(Uint8Array.from(atob(String(j.content || "").replace(/\n/g, "")), (c) => c.charCodeAt(0)));
  const next = change(text);
  if (next == null) return false; // already up to date
  const bytes = new TextEncoder().encode(next);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const put = await fetch(url, {
    method: "PUT",
    headers: { ...head, "Content-Type": "application/json" },
    body: JSON.stringify({ message, content: btoa(bin), sha: j.sha }),
  });
  if (!put.ok) {
    let why = "HTTP " + put.status;
    try { const e = await put.json(); if (e && e.message) why = e.message; } catch (e2) {}
    throw new Error(path + ": " + why);
  }
  return true;
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
  if (false) { // Due tomorrow left the Filter menu
    // The one-day bundle the popup shows, so the badge can never disagree with
    // the page. Scraping tomorrow's rows out of the week bundles (the old way)
    // missed the recurring Extra Task: it carries a per-day share, not a due
    // date on tomorrow, so the badge read 6h while the card read 8h 12m.
    const start = new Date(); start.setDate(start.getDate() + 1); start.setHours(0, 0, 0, 0);
    const from = start.getTime();
    const b = st.tomorrow;
    if (b && Number(b.fromTs) === from) return Number(b.estimateMs) || 0;
    return 0; // no bundle yet - better blank than a number the page contradicts
  }
  // Custom range, the month / previous-week presets, weeks by start date: the
  // shared bundle (the same number the pages show); until it's built, today's.
  const r = cuFilterCustomRange(f);
  if (r) {
    if (st.custom && st.custom.fromTs === r.fromTs && st.custom.toTs === r.toTs && (st.custom.basis || "due") === r.basis) {
      // Days picked one by one in the calendar: only those days count.
      const days = Array.isArray(f.customDays) && f.customDays.length > 1 && f.customDays[0] === f.customFrom && f.customDays[f.customDays.length - 1] === (f.customTo || f.customFrom) ? new Set(f.customDays) : null;
      if (days) {
        const dayOf = (ms) => { const x = new Date(Number(ms)); return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0"); };
        return (st.custom.tasks || []).filter((t) => t && Number(t.dueDateMs) > 0 && days.has(dayOf(t.dueDateMs))).reduce((n, t) => n + (Number(t.estimateMs) || 0), 0);
      }
      return Number(st.custom.estimateMs) || 0;
    }
    return Number(st.estimateMs) || 0;
  }
  // Nothing ticked under Due = today.
  return Number(st.estimateMs) || 0;
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
    // Automatic retries stopped: it needs a person whether or not it failed today,
    // so it can't sit in "pending" once the failure is a day old.
    else if (Number(st.retryStoppedAt) > 0) attention++;
    else if (st.lastResult && st.lastResult !== "success" && isToday(st.lastRunAt)) attention++;
    else pending++;
  }
  // The options sidebar shows this count on Agent Router (nav-badges.js) - "since"
  // is when it went above 0, so a count you've already looked at stays quiet.
  try {
    const { arAttention: was } = await chrome.storage.local.get("arAttention");
    const n0 = (was && was.n) || 0;
    if (n0 !== attention) await chrome.storage.local.set({ arAttention: { n: attention, since: attention > 0 && n0 > 0 ? (was.since || Date.now()) : attention > 0 ? Date.now() : 0 } });
  } catch (e) {}
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
      let cuFilter = {}; // nothing ticked = today, as on the pages
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
  // The running task past its own estimate wins the badge: a red "!".
  try {
    const { runningProgress: rp } = await chrome.storage.local.get("runningProgress");
    if (rp && Number(rp.estimateMs) > 0 && rp.startMs) {
      const tracked = (Number(rp.closedMs) || 0) + Math.max(0, Date.now() - Number(rp.startMs));
      if (tracked - Number(rp.estimateMs) >= 60000) { text = "!"; color = "#dc2626"; }
    }
  } catch (e) {}
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch (e) {}
  // Progress ring around the toolbar icon: today's tracked time against target.
  let ring = null;
  if (settings.fxIconRing !== false) {
    try {
      const cfg = await getClickupConfig();
      const st = await getClickupState();
      if (cfg && cfg.token && st && Number(st.targetMs) > 0) ring = Math.max(0, Number(st.spentMs) || 0) / Number(st.targetMs);
    } catch (e) {}
  }
  await setIconRing(ring).catch(() => {});
}

// Draws the extension icon with a thin progress ring around it (blue while under
// target, green once met). null = the plain icon. Redrawn only when the ring
// moves by at least 2%, so it costs nothing between changes.
let iconRingShown = "unset";
let iconBase = null;
async function setIconRing(frac) {
  const key = frac == null ? "plain" : String(Math.min(100, Math.round(frac * 50) * 2));
  if (key === iconRingShown) return;
  iconRingShown = key;
  if (frac == null) {
    await chrome.action.setIcon({ path: { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" } });
    return;
  }
  if (!iconBase) iconBase = await createImageBitmap(await (await fetch(chrome.runtime.getURL("icons/icon48.png"))).blob());
  const met = frac >= 1;
  const imageData = {};
  for (const size of [16, 32]) {
    const c = new OffscreenCanvas(size, size);
    const g = c.getContext("2d");
    const lw = Math.max(2, Math.round(size * 0.13));
    const inset = lw + (size >= 32 ? 1 : 0);
    g.drawImage(iconBase, inset, inset, size - inset * 2, size - inset * 2);
    const r = (size - lw) / 2;
    g.lineWidth = lw;
    g.strokeStyle = "rgba(128,128,128,0.35)";
    g.beginPath(); g.arc(size / 2, size / 2, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = met ? "#22c55e" : "#3b82f6";
    g.lineCap = "round";
    g.beginPath(); g.arc(size / 2, size / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac)); g.stroke();
    imageData[size] = g.getImageData(0, 0, size, size);
  }
  await chrome.action.setIcon({ imageData });
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
    reasons: ["AUDIO_PLAYBACK", "BLOBS"],
    justification: "Play a chime when a reminder notification appears, and unpack update packages to install new versions in the background.",
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
// Bell menu: all notifications off, or paused (lunch / meeting).
function notificationsMuted(s) {
  return !!s && (s.notifyAll === false || Number(s.notifyPausedUntil) > Date.now());
}
async function playNotificationSound(force, sound, volumeOverride) {
  try {
    const s = await getSettings();
    // Muted means no sound from any path, including update notices.
    if (!force && (!s.notifySound || notificationsMuted(s))) return;
    // Loudness (Options > Notifications and sound). A test passes the slider's
    // live value so the change can be heard before saving.
    const pct = Number(volumeOverride != null ? volumeOverride : s.notifyVolume);
    const volume = Math.max(0.05, Math.min(1, (Number.isFinite(pct) && pct > 0 ? pct : 100) / 100));
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
    // The user's own sound for this slot, if they set one (Options > General).
    let src = "";
    try {
      const { customSounds } = await chrome.storage.local.get("customSounds");
      const key = sound === "danger" ? "danger" : sound === "winner" ? "winner" : "notify";
      const c = customSounds && customSounds[key];
      if (c && typeof c.src === "string") src = c.src;
    } catch (e) {}
    for (let attempt = 0; attempt < 6; attempt++) {
      const ok = await sendPlaySound(sound, nonce, src, volume);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 70));
    }
  } catch (e) {}
}
// One PLAY_SOUND round-trip. Resolves true only if the offscreen doc acked.
function sendPlaySound(sound, nonce, src, volume) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        { type: "PLAY_SOUND", target: "offscreen", sound: sound || "notify", nonce, src: src || "", volume },
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
// ---------- milestone animations ----------
// Every milestone is saved as "celebrate" so any open extension page plays it
// (celebrate.js). When the user isn't looking at an extension page, a small
// window pops up with the animation and closes itself (settings.celebrationWindow,
// on by default). Neither when celebrations are off or notifications are paused.
async function celebrateMilestone({ kind, big, mood, title, sub, force }) {
  const settings = await getSettings();
  if (!force && (settings.celebrations === false || settings.notifyAll === false || Number(settings.notifyPausedUntil) > Date.now())) return;
  const id = (kind || "milestone") + "-" + Date.now();
  const secs = Math.max(1, Math.min(15, Number(settings.celebrationSeconds) || 3));
  if (!force) await chrome.storage.local.set({ celebrate: { id, kind, big: !!big, mood: mood || "happy", secs, at: Date.now() } });
  if (!force && settings.celebrationWindow === false) return;
  // Someone is looking at the popup / side panel / an extension tab: it plays there.
  if (!force) {
    try {
      // The popup means they're using it right now. A side panel only counts when
      // it's in the window they're looking at: pinned in one window while they
      // work in another app or window, it isn't seen, so the card still shows.
      const ctx = await chrome.runtime.getContexts({ contextTypes: ["POPUP", "SIDE_PANEL"] });
      if (ctx.some((c) => c.contextType === "POPUP")) return;
      const w = await chrome.windows.getLastFocused({ populate: true });
      if (w && w.focused && ctx.some((c) => c.contextType === "SIDE_PANEL" && c.windowId === w.id)) return;
      const act = w && w.focused && (w.tabs || []).find((t) => t.active);
      if (act && String(act.url || "").startsWith(chrome.runtime.getURL(""))) return;
    } catch (e) {}
  }
  let left, top;
  const width = 340, height = 112; // notification-card size
  try {
    const w = await chrome.windows.getLastFocused();
    if (w && Number.isFinite(w.left) && Number.isFinite(w.width)) {
      left = Math.max(0, w.left + w.width - width - 24);
      top = Math.max(0, w.top + w.height - height - 24);
    }
  } catch (e) {}
  const q = new URLSearchParams({ mood: mood || "happy", big: big ? "1" : "0", secs: String(secs), title: title || "", sub: sub || "" });
  try {
    await chrome.windows.create({ url: chrome.runtime.getURL("celebrate.html?" + q), type: "popup", width, height, left, top, focused: false });
    // Seen in the window, so a page opened later doesn't replay it.
    if (!force) await chrome.storage.local.set({ celebrateSeen: id });
  } catch (e) {}
}

async function notify(id, title, message, sound, targetUrl, opts) {
  // Bell menu: everything off, or paused (e.g. lunch). Update notices don't use notify().
  try {
    if (notificationsMuted(await getSettings())) return;
  } catch (e) {}
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
        ...(opts || {}),
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
  let stopped = 0;
  for (const r of entries) {
    if (r.result === "success") ok++;
    else if (r.result === "needs-attention") attn++;
    else fail++;
    // Same classifier the backoff uses: say so here, or the user would only find
    // out that an account stopped retrying by opening the popup.
    if (r.result !== "success" && isPermanentFailure(r.note)) stopped++;
  }
  const parts = [];
  if (ok) parts.push(`${ok} logged in`);
  if (attn) parts.push(`${attn} need${attn === 1 ? "s" : ""} you`);
  if (fail) parts.push(`${fail} failed`);
  if (stopped) parts.push(`auto retries stopped for ${stopped}`);
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
// The retry bookkeeping (loginFails / nextAttemptAt / retryStoppedAt) is left
// untouched on purpose: a crashed worker is not a credential failure, so it must
// not escalate the backoff - but an outstanding wait from the LAST real failure
// still has to be served out, which is why shouldRun() checks the stamp rather
// than lastResult.
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

async function healUnanchoredCredits() {
  try {
    const status = await getStatus();
    let changed = false;
    for (const id of Object.keys(status)) {
      const r = status[id];
      const doneAt = effectiveDoneAt(r);
      if (r && r.lastResult === "success" && doneAt > 0 && r.lastRunAt && r.lastRunAt >= doneAt + RESET_MS) {
        status[id] = { ...r, lastDone: todayString(r.lastRunAt), lastDoneAt: r.lastRunAt, creditSource: "login" };
        changed = true;
      }
    }
    if (changed) {
      await chrome.storage.local.set({ status });
      updateBadge().catch(() => {});
      mirrorToDrive(status).catch(() => {});
    }
  } catch (e) {}
}
healUnanchoredCredits();

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
    { targetUrl: settings.targetUrl, active, keepTabs: manual && settings.arCloseTabs === false, timeoutScale, keepGithub: settings.ghKeepSignedIn === true, isCancelled: isCancelledFn },
    async ({ accountId, phase, result, note, detected, tabId }) => {
      if (phase === "start") {
        setStatusFor(accountId, { lastRunAt: Date.now(), lastResult: "running", note: "" });
      } else if (phase === "done") {
        await recordLoginResult(accountId, result, note, detected, settings);
        // A tab left open for the person (passkey, CAPTCHA, Google...): notice
        // when they finish the login there and record it like a normal run.
        if (result === "needs-attention" && tabId) watchAttentionTab(tabId, accountId).catch(() => {});
      }
      chrome.runtime.sendMessage({ type: "RUN_PROGRESS", accountId, phase, result, note }).catch(() => {});
    }
  );
  return results;
}

// Record one finished login (Run, or a login the person finished by hand in the
// tab left open for them): the status line, and the earning checkpoint rules.
async function recordLoginResult(accountId, result, note, detected, settings) {
        const patch = { lastRunAt: Date.now(), lastResult: result, note: note || "" };
        const status = await getStatus();
        const prev = status[accountId] || {};
        // Retry bookkeeping: count the failure, stamp when the daily runner may try
        // again (escalating - see RETRY_BACKOFF_MS), and stop the automatic retries
        // altogether when the note says the stored sign-in itself is wrong. A
        // success clears all three.
        Object.assign(patch, retryPatchFor(prev, result, patch.note, patch.lastRunAt));
        if (result === "success") {
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
              } else if (effectiveDoneAt(prev) > 0) {
                // The last credit is KNOWN and 24h+ old, so by Agent Router's rule
                // this login is the credit - even when the balance can't show a
                // rise (baseline lost after a reinstall, or read after the credit
                // already landed). Unknown history keeps the baseline-only path.
                checkpoint = Date.now();
                source = "login";
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
        await setStatusFor(accountId, patch);
        if (detected) applyDetected(accountId, detected).catch(() => {});
        // Balance rides in a separate local key (never mirrored to Drive).
        if (result === "success" && detected && detected.balance != null)
          setBalanceFor(accountId, detected.balance).catch(() => {});
}

// ---------- logins finished by hand ----------
// arAttnTabs = { [tabId]: { accountId, at } } for tabs a run left open for the
// person. When such a tab reaches Agent Router's logged-in app, the login is
// recorded (same rules as Run) and the red "needs you" message goes away.
const ATTN_TTL_MS = 12 * 3600000;
async function attnTabs() {
  const { arAttnTabs } = await chrome.storage.local.get("arAttnTabs");
  const m = arAttnTabs && typeof arAttnTabs === "object" ? arAttnTabs : {};
  const now = Date.now();
  for (const k of Object.keys(m)) if (!m[k] || now - (m[k].at || 0) > ATTN_TTL_MS) delete m[k];
  return m;
}
async function watchAttentionTab(tabId, accountId) {
  const m = await attnTabs();
  m[String(tabId)] = { accountId, at: Date.now() };
  await chrome.storage.local.set({ arAttnTabs: m });
}
const attnChecking = new Set();
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !/^https:\/\/([a-z0-9-]+\.)*agentrouter\.org\//i.test(String((tab && tab.url) || ""))) return;
  if (/\/(login|oauth)/i.test(new URL(tab.url).pathname) || attnChecking.has(tabId)) return;
  attnChecking.add(tabId);
  (async () => {
    const m = await attnTabs();
    const w = m[String(tabId)];
    if (!w) return;
    await new Promise((r) => setTimeout(r, 1500)); // let the app save its session
    const { loggedIn, detected } = await readAgentRouterLogin(tabId);
    if (!loggedIn) return;
    // Only when it's the same Agent Router account (never credit another one).
    const acc = (await getAccounts()).find((a) => a.id === w.accountId);
    if (!acc) return;
    if (acc.detectedArUsername && detected.arUsername && acc.detectedArUsername !== detected.arUsername) {
      await setStatusFor(w.accountId, { note: "That tab is logged in to a different Agent Router account (" + detected.arUsername + ")." });
      return;
    }
    delete m[String(tabId)];
    await chrome.storage.local.set({ arAttnTabs: m });
    await recordLoginResult(w.accountId, "success", "Logged in (finished by you in the tab).", detected, await getSettings());
    chrome.runtime.sendMessage({ type: "RUN_PROGRESS", accountId: w.accountId, phase: "done", result: "success" }).catch(() => {});
  })().catch(() => {}).finally(() => attnChecking.delete(tabId));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attnTabs().then((m) => { if (m[String(tabId)]) { delete m[String(tabId)]; return chrome.storage.local.set({ arAttnTabs: m }); } }).catch(() => {});
});

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
async function autoSyncIfSignedIn(opts) {
  try {
    if (!(await isSignedIn())) return; // no valid/silently-refreshable token
    await syncNow(opts);
    syncTaskFiles().catch(() => {}); // Task files backup / restore
  } catch (e) {}
}

// ---------- Update check (GitHub Releases) ----------
// The extension is distributed as GitHub Releases (a zip per version). About
// twice a day it asks GitHub for the latest release; when that is newer than the
// installed manifest version it stores `updateInfo` (the popup/options show an
// "Update available" link) and shows ONE notification per new version.
// UPDATE_REPO is "<github-user>/<repo>" - set when the repository is created.
const UPDATE_REPO = "Dipson-bot/personal-clickup-manager";
// How often every installed copy looks for a new version, how often it reminds,
// whether the latest release is important, a hold time and a "notify everyone
// now" nonce all come from update-policy.json in the repo, which the Admin panel
// edits. It is read from raw.githubusercontent.com (a plain file, not the rate-
// limited GitHub API), so checking every 15-30 minutes costs nothing. Missing or
// unreadable = these defaults.

// ---------- team hub: Help & issues + active users (the admin's Apps Script) ----------
// The hub address travels in update-policy.json (hubUrl), written from Admin >
// Team hub, so no user sets anything up. Names and photos come ONLY from ClickUp
// (/user, cached, refreshed at most weekly). Each copy checks in about once a
// day; replies from the admin in threads you're part of show as notifications.
const HUB_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/;
const HUB_HELLO_MS = 20 * 3600000;
const HUB_ACTIVE_MS = 60 * 60000; // opening the popup / options counts as "active", at most hourly
const HUB_POLL_MS = 10 * 60000;
async function hubUrl() {
  const { updatePolicy, hubUrlLocal } = await chrome.storage.local.get(["updatePolicy", "hubUrlLocal"]);
  const u = (updatePolicy && updatePolicy.policy && updatePolicy.policy.hubUrl) || hubUrlLocal || "";
  return HUB_URL_RE.test(u) ? u : "";
}
async function installId() {
  let { installId: id } = await chrome.storage.local.get("installId");
  if (!id) { id = crypto.randomUUID().replace(/-/g, ""); await chrome.storage.local.set({ installId: id }); }
  return id;
}
const HUB_PROFILE_MS = 3 * 3600000;
async function hubProfile(force) {
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return null;
  let c = cfg;
  // Your ClickUp name and picture, re-read every 3 hours (one small request): it
  // was once a week, so a new profile picture took up to 7 days to reach the Team hub.
  if (force || !cfg.profileAt || Date.now() - cfg.profileAt > HUB_PROFILE_MS) {
    try {
      const u = await getUser(cfg.token);
      c = await setClickupConfig({ username: u.username || cfg.username || "", avatar: u.profilePicture || "", color: u.color || "", initials: u.initials || "", profileAt: Date.now() });
    } catch (e) {} // keep what we have; try again next time
  }
  return { cuUserId: String(c.userId || ""), name: c.username || "", avatar: c.avatar || "", color: c.color || "", initials: c.initials || "" };
}
// What the Team hub's users list shows for each person (Admin › Team hub,
// Performance / Health columns): built from what this copy already has - the
// stored performance history (rebuilt at most every 6 h) and the open tasks -
// at most every 3 hours, and sent with the check-in. Small: scores and counts.
const EXTRA_TASK_RE = /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i;
function perfScores(perf, targetMs, now = Date.now()) {
  const DAY = 86400000;
  const dayStartOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const today = dayStartOf(now);
  const mon = (() => { const d = new Date(today); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
  const monthStart = new Date(new Date(today).getFullYear(), new Date(today).getMonth(), 1).getTime();
  const done = (perf.done || []).filter((t) => t && t.doneAt && !EXTRA_TASK_RE.test(t.name || ""));
  const lateDays = (t) => Math.ceil((t.doneAt - (dayStartOf(t.dueDateMs) + DAY)) / DAY);
  const score = (from) => {
    let tracked = 0, work = 0;
    for (let d = dayStartOf(from); d < today; d += DAY) {
      const g = new Date(d).getDay();
      if (g === 0 || g === 6 || isCompanyHoliday(d)) continue;
      work++; tracked += Number(perf.days && (perf.days[d] || perf.days[String(d)])) || 0;
    }
    const parts = [];
    if (work && targetMs) parts.push({ k: "h", w: 40, s: Math.min(100, (tracked / (work * targetMs)) * 100) });
    const dated = done.filter((t) => t.doneAt >= from && Number(t.dueDateMs) > 0);
    if (dated.length) parts.push({ k: "d", w: 35, s: (1 - dated.reduce((a, t) => a + (lateDays(t) >= 1 ? Math.min(1, lateDays(t) / 7) : 0), 0) / dated.length) * 100 });
    const acc = done.filter((t) => t.doneAt >= from && t.estimateMs > 0 && t.spentMs > 0);
    if (acc.length) parts.push({ k: "e", w: 25, s: (acc.reduce((a, t) => a + Math.max(0, 1 - Math.abs(t.spentMs / t.estimateMs - 1)), 0) / acc.length) * 100 });
    const ws = parts.reduce((a, p) => a + p.w, 0);
    const o = { s: ws ? Math.round(parts.reduce((a, p) => a + p.s * p.w, 0) / ws) : null };
    for (const p of parts) o[p.k] = Math.round(p.s);
    return o;
  };
  const late4 = done.filter((t) => t.doneAt >= today - 28 * DAY && Number(t.dueDateMs) > 0 && lateDays(t) >= 1).length;
  const fin4 = done.filter((t) => t.doneAt >= today - 28 * DAY).length;
  return { w: score(mon), m: score(monthStart), a: score(Math.max(Number(perf.fromTs) || today, mon - 7 * 11 * DAY)), late4, fin4 };
}
async function teamSummary() {
  const { teamSummaryCache } = await chrome.storage.local.get("teamSummaryCache");
  // A summary whose open tasks couldn't be read (ClickUp busy) is kept only 20
  // minutes, not 3 hours - so the admin's Health column fills in at the next try.
  if (teamSummaryCache && Date.now() - (teamSummaryCache.at || 0) < (teamSummaryCache.h ? 3 * 3600000 : 20 * 60000)) return teamSummaryCache;
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || cfg.userId == null) return null;
  const settings = await getSettings().catch(() => ({}));
  const targetMs = (Number(settings.clickupTargetHours) || 7) * 3600000;
  const out = { at: Date.now() };
  try { const r = await getPerfHistory(false); if (r && r.data) out.p = perfScores(r.data, targetMs); } catch (e) {}
  try {
    const g = await chrome.storage.local.get("insOpenCache");
    let rows = g.insOpenCache && Date.now() - (g.insOpenCache.at || 0) < 24 * 3600000 ? g.insOpenCache.tasks : null;
    if (!rows) { const r = await getOpenTasks(cfg, false).catch(() => null); rows = r && r.ok && r.data ? r.data.tasks : null; }
    if (Array.isArray(rows)) {
      const today = new Date().setHours(0, 0, 0, 0);
      const open = rows.filter((t) => t && !t.done && !EXTRA_TASK_RE.test(t.name || ""));
      const st = (await getClickupState().catch(() => null)) || {};
      out.h = { open: open.length, od: open.filter((t) => Number(t.dueDateMs) > 0 && new Date(Number(t.dueDateMs)).setHours(0, 0, 0, 0) < today).length,
        ne: open.filter((t) => !(Number(t.estimateMs) > 0)).length, nd: open.filter((t) => !(Number(t.dueDateMs) > 0)).length,
        bl: Object.keys(st.waiting || {}).length };
    }
  } catch (e) {}
  // Couldn't read them this time: the last good counts (under a day old) rather
  // than an empty Health cell; with none, the short cache above retries soon.
  if (!out.h && teamSummaryCache && teamSummaryCache.h && Date.now() - (teamSummaryCache.hAt || teamSummaryCache.at || 0) < 24 * 3600000) {
    out.h = teamSummaryCache.h;
    out.hAt = teamSummaryCache.hAt || teamSummaryCache.at;
  } else if (out.h) out.hAt = out.at;
  if (!out.p && !out.h) return null;
  await chrome.storage.local.set({ teamSummaryCache: out });
  return out;
}
async function hubAdminKey() {
  const { adminHubEnc } = await chrome.storage.local.get("adminHubEnc");
  const a = await decryptJSON(adminHubEnc, null);
  return a && a.key ? String(a.key) : "";
}
async function hubPost(url, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const res = await fetch(url, { method: "POST", body: JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
    const txt = await res.text();
    let j = null;
    try { j = JSON.parse(txt); } catch (e) {}
    if (!j) return { ok: false, error: res.ok ? "The hub gave an unexpected answer - check the web app is deployed with access for \"Anyone\"." : "The hub said HTTP " + res.status + "." };
    return j;
  } catch (e) {
    return { ok: false, error: e && e.name === "AbortError" ? "The hub didn't answer in time - try again." : "Couldn't reach the hub (" + ((e && e.message) || e) + ")." };
  } finally { clearTimeout(timer); }
}
// This person's day for the admin's card in Admin › Users (click a picture): what
// the Due today and This week cards show and the task with a timer running. Read
// from the last refresh (no ClickUp calls); the running timer's time since that
// refresh is added, as the pages do. Nothing when the numbers are from yesterday.
async function hubDaySnap() {
  try {
    const st = await getClickupState();
    if (!st || !(Number(st.at) > 0)) return null;
    const now = Date.now(), mid = new Date(now).setHours(0, 0, 0, 0);
    if (Number(st.at) < mid) return null;
    const run = st.running && st.running.taskId ? st.running : null;
    const live = run && run.startMs ? Math.max(0, now - Math.max(Number(run.startMs) || 0, Number(st.at) || 0, mid)) : 0;
    const tgt = Number(st.targetMs) || 0;
    const w = st.weekly && st.weekly.friday;
    // The running task's client, from whichever list has the task (for the admin's card).
    let runClient = "";
    if (run) {
      const id = String(run.taskId);
      const lists = [st.tasks, st.todayFilter && st.todayFilter.tasks, st.thisWeek && st.thisWeek.tasks, st.nextWeek && st.nextWeek.tasks, st.custom && st.custom.tasks, st.deadlineTasks];
      for (const p of (st.weekly && st.weekly.perDay) || []) lists.push(p && p.tasks, p && p.trackedTasks);
      for (const l of lists) { const t = (l || []).find((x) => x && String(x.id) === id); const c = t && (t.client || (t.container && t.container.listName)); if (c) { runClient = String(c); break; } }
    }
    return {
      at: now, est: Number(st.estimateMs) || 0, trk: (Number(st.spentMs) || 0) + live, tgt, n: Number(st.taskCount) || 0, ne: Number(st.noEstimateCount) || 0,
      w: w ? { est: Number(w.estimateMs) || 0, trk: (Number(w.spentMs) || 0) + live, tgt: tgt * (Number(w.count) || 0), from: Number(w.fromTs) || 0, to: Number(w.toTs) || 0 } : null,
      run: run ? { id: String(run.taskId), name: String(run.taskName || "").slice(0, 160), since: Number(run.startMs) || 0, client: runClient.slice(0, 80) } : null,
    };
  } catch (e) { return null; }
}
async function hubCall(action, payload, asAdmin) {
  const url = await hubUrl();
  if (!url) return { ok: false, reason: "not-set-up", error: "Help & issues isn't set up yet - ask your admin." };
  // act: when this person last used the computer (presence for the admin's
  // Users list: active now / away / offline) - a time, nothing about what they did.
  const { userActiveAt } = await chrome.storage.local.get("userActiveAt");
  const day = await hubDaySnap();
  const body = { ...(payload || {}), action, install: await installId(), act: Number(userActiveAt) || 0, ...(day ? { day: JSON.stringify(day) } : {}) };
  if (asAdmin) {
    const key = await hubAdminKey();
    // Made an admin by the owner: the hub knows this copy by its install id.
    const { hubMe } = key ? {} : await chrome.storage.local.get("hubMe");
    if (key) body.key = key;
    else if (!(hubMe && hubMe.role === "admin")) return { ok: false, error: "Save the admin key first (Admin > Team hub)." };
  }
  return hubPost(url, body);
}
// Check in with the Team hub: name, photo, version, last active. At least daily
// (gapMs), hourly when the popup / options is opened, and straight away when the
// version changed since the last check-in (after an update), so the admin's
// users list never shows a version this copy no longer runs.
async function hubHello(force, gapMs = HUB_HELLO_MS) {
  const { hubHelloAt, hubHelloVer } = await chrome.storage.local.get(["hubHelloAt", "hubHelloVer"]);
  const version = chrome.runtime.getManifest().version;
  if (!force && hubHelloVer === version && Date.now() - (Number(hubHelloAt) || 0) < gapMs) return null;
  if (!(await hubUrl())) return null;
  const p = await hubProfile();
  if (!p) return null; // not connected to ClickUp: nothing to say who this is
  await chrome.storage.local.set({ hubHelloAt: Date.now() });
  const sum = await teamSummary().catch(() => null);
  const r = await hubCall("hello", { ...p, version, ...(sum ? { perf: JSON.stringify(sum).slice(0, 900) } : {}) });
  if (r && r.ok) await chrome.storage.local.set({ hubHelloVer: version });
  if (r && r.ok) await chrome.storage.local.set({ hubMe: { state: r.state, mutedUntil: r.mutedUntil || 0, settings: r.settings || {}, role: r.role === "owner" || r.role === "admin" ? r.role : "user", at: Date.now() } });
  return r;
}
// Notices from the admin (maintenance break, sudden holiday...): checked every
// 10 minutes, kept in storage for the pages' banner (notices.js) and the Help &
// issues tab, and each new one pops up once. Like your own reminders they show
// while notifications are paused; only "All notifications off" silences them.
const HUB_NOTICE_MS = 10 * 60000;
async function hubPollNotices(force) {
  const { hubNoticesAt, hubNoticesSeen } = await chrome.storage.local.get(["hubNoticesAt", "hubNoticesSeen"]);
  if (!force && Date.now() - (Number(hubNoticesAt) || 0) < HUB_NOTICE_MS) return;
  if (!(await hubUrl())) return;
  await chrome.storage.local.set({ hubNoticesAt: Date.now() });
  const r = await hubCall("notices", {});
  await hubPollClientNotes().catch(() => {}); // client notices teammates' Slack found
  if (!r || !r.ok || !Array.isArray(r.notices)) return; // an older hub script has no notices yet
  await setHubNotices(r.notices, hubNoticesSeen);
}
async function setHubNotices(list, seenIn) {
  const notices = (Array.isArray(list) ? list : []).slice(0, 10);
  const seen = seenIn && typeof seenIn === "object" ? { ...seenIn } : ((await chrome.storage.local.get("hubNoticesSeen")).hubNoticesSeen || {});
  const s = await getSettings();
  for (const n of notices) {
    if (seen[n.id]) continue;
    seen[n.id] = Date.now();
    if (s.notifyAll === false) continue;
    const icon = n.level === "urgent" ? "\uD83D\uDEA8 " : n.level === "important" ? "\u26A0\uFE0F " : "\uD83D\uDCE2 ";
    try {
      await chrome.notifications.create("hub-notice-" + n.id, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: icon + String(n.title || "Notice").slice(0, 120), message: String(n.text || "").slice(0, 300) || "From your admin",
        priority: 2, requireInteraction: n.level !== "info",
      });
      notifTargetUrls.set("hub-notice-" + n.id, chrome.runtime.getURL("options.html#hub"));
    } catch (e) {}
    if (s.notifySound !== false) await playNotificationSound(true, n.level === "urgent" ? "danger" : null).catch(() => {});
  }
  await chrome.storage.local.set({ hubNotices: { at: Date.now(), list: notices }, hubNoticesSeen: seen });
}
// Task reminders a teammate sent you through the hub (the 🔔 next to a person
// on a task): checked every few minutes, each shown once as a notification that
// opens the task. Like your own reminders they show while notifications are
// paused; only "All notifications off" silences them.
const HUB_NUDGE_MS = 3 * 60000;
async function hubPollNudges(force) {
  const { hubNudgesAt } = await chrome.storage.local.get("hubNudgesAt");
  if (!force && Date.now() - (Number(hubNudgesAt) || 0) < HUB_NUDGE_MS) return;
  if (!(await hubUrl())) return;
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return;
  await chrome.storage.local.set({ hubNudgesAt: Date.now() });
  const r = await hubCall("nudges", {});
  if (!r || !r.ok || !Array.isArray(r.nudges) || !r.nudges.length) return; // an older hub script has no nudges
  const s = await getSettings();
  const { nudgesIn } = await chrome.storage.local.get("nudgesIn");
  const kept = (Array.isArray(nudgesIn) ? nudgesIn : []).concat(r.nudges).slice(-30);
  await chrome.storage.local.set({ nudgesIn: kept });
  if (s.notifyAll === false) return;
  for (const n of r.nudges.slice(0, 10)) {
    const id = "nudge-" + n.id;
    const url = /^https:\/\/app\.clickup\.com\//.test(n.taskUrl || "") ? n.taskUrl : (n.taskId ? taskUrlFor(n.taskId) : null);
    // Most of these are about a task. The admin's "open your extension please"
    // is not, so a reminder with no task reads as its own message instead of
    // "A task - ...", and only a real task promises a link to click.
    const head = n.taskName || (n.taskId ? "A task" : "");
    try {
      await chrome.notifications.create(id, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: ("\u23F0 Reminder from " + (n.fromName || "a teammate")).slice(0, 120),
        message: (head ? head + (n.text ? " - \u201C" + n.text + "\u201D" : "") : (n.text || "A reminder for you")).slice(0, 300),
        contextMessage: url ? "Click to open the task in ClickUp" : "From your team - see the Reminders tab", priority: 2, requireInteraction: true,
      });
      if (url) notifTargetUrls.set(id, url);
    } catch (e) {}
    if (s.notifySound !== false) await playNotificationSound(true).catch(() => {});
  }
}
// Admin replies / resolutions in threads you started, replied to or "me too"'d.
async function hubPollReplies(force) {
  const { hubActive, hubPollAt, hubSeen } = await chrome.storage.local.get(["hubActive", "hubPollAt", "hubSeen"]);
  if (!hubActive) return;
  if (!force && Date.now() - (Number(hubPollAt) || 0) < HUB_POLL_MS) return;
  await chrome.storage.local.set({ hubPollAt: Date.now() });
  const r = await hubCall("threads", {});
  if (!r || !r.ok || !Array.isArray(r.threads)) return;
  const seen = hubSeen && typeof hubSeen === "object" ? { ...hubSeen } : {};
  const first = !hubSeen;
  for (const t of r.threads) {
    if (!t.mine) continue;
    const was = Number(seen[t.id]) || 0;
    if (!first && t.lastAt > was && t.lastRole === "admin") {
      const done = t.status === "resolved";
      try {
        const { hubUnread } = await chrome.storage.local.get("hubUnread");
        const list = (Array.isArray(hubUnread) ? hubUnread : []).filter((x) => x && x.id !== t.id);
        list.push({ id: t.id, title: String(t.title || "").slice(0, 120), at: Number(t.lastAt) || Date.now(), resolved: done });
        await chrome.storage.local.set({ hubUnread: list.slice(-30) });
      } catch (e) {}
      await notify("hub-" + t.id + "-" + t.lastAt, done ? "Resolved" + (t.fixedIn ? " in v" + t.fixedIn : "") + ": " + t.title : "Admin replied: " + t.title,
        done ? "Your admin marked this issue resolved." + (t.fixedIn ? " Update to v" + t.fixedIn + " if you haven't." : "") : "Open Help & issues to read the reply.",
        null, chrome.runtime.getURL("options.html?thread=" + encodeURIComponent(t.id) + "#hub"));
    }
    seen[t.id] = Math.max(was, Number(t.lastAt) || 0);
  }
  await chrome.storage.local.set({ hubSeen: seen });
}

const UPDATE_POLICY_PATH = "update-policy.json";
const UPDATE_POLICY_URL = "https://raw.githubusercontent.com/" + UPDATE_REPO + "/main/" + UPDATE_POLICY_PATH;
const UPDATE_ALARM = "updateCheck";
const UPDATE_POLICY_DEFAULTS = { checkEveryMinutes: 30, remindEveryHours: 24, important: false, holdUntil: 0, notifyNonce: "", autoInstallAfterHours: 0 };
function normalizeUpdatePolicy(p) {
  const o = p && typeof p === "object" ? p : {};
  const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
  return {
    checkEveryMinutes: num(o.checkEveryMinutes, 30, 15, 720),
    remindEveryHours: num(o.remindEveryHours, 24, 1, 168),
    // Automatic installs wait this long after a release is announced, so a bad
    // one can be held back before it reaches everyone. 0 = straight away.
    autoInstallAfterHours: num(o.autoInstallAfterHours, 0, 0, 168),
    important: !!o.important,
    holdUntil: Number(o.holdUntil) > 0 ? Number(o.holdUntil) : 0,
    notifyNonce: typeof o.notifyNonce === "string" ? o.notifyNonce.slice(0, 40) : "",
    notifiedAllAt: Number(o.notifiedAllAt) || 0,
    // When the Admin last published the team's client sites (client-sites.json).
    sitesAt: Number(o.sitesAt) || 0,
    updatedAt: Number(o.updatedAt) || 0,
    // The newest release, written by Admin publish / Notify, so a notification
    // needs nothing but this file. Only this repository's own releases count.
    latest: /^\d+(\.\d+){1,3}$/.test(String(o.latest || "")) ? String(o.latest) : "",
    zip: String(o.zip || "").startsWith("https://github.com/" + UPDATE_REPO + "/releases/download/") ? String(o.zip) : "",
    url: String(o.url || "").startsWith("https://github.com/" + UPDATE_REPO + "/releases") ? String(o.url) : "",
    // The admin's team hub (Help & issues). Only a Google Apps Script web app.
    hubUrl: HUB_URL_RE.test(String(o.hubUrl || "")) ? String(o.hubUrl) : "",
    // Published without a pop-up: copies don't show "Update available" for this
    // version (automatic updates still install it; Check for updates still shows it).
    quietFor: /^\d+(\.\d+){1,3}$/.test(String(o.quietFor || "")) ? String(o.quietFor) : "",
    // A release for some people only (a GitHub pre-release): only copies whose
    // ClickUp user id is listed see it; everyone else keeps `latest`.
    preview: normalizePreview(o.preview),
    // Company holidays / work-from-home days (see DEFAULT_COMPANY_CAL).
    calendar: Array.isArray(o.calendar) ? o.calendar : undefined,
    // Reminders the admin set for everyone (Reminders › 📣 For everyone).
    teamReminders: Array.isArray(o.teamReminders) ? o.teamReminders.slice(0, 40) : undefined,
    // Clients who have paused working with us (Admin › Paused clients): their
    // tasks are struck through everywhere (paused-clients.js).
    pausedClients: Array.isArray(o.pausedClients) ? normalizePausedClients(o.pausedClients) : undefined,
  };
}
function normalizePreview(p) {
  if (!p || typeof p !== "object") return null;
  const latest = /^\d+(\.\d+){1,3}$/.test(String(p.latest || "")) ? String(p.latest) : "";
  const zip = String(p.zip || "").startsWith("https://github.com/" + UPDATE_REPO + "/releases/download/") ? String(p.zip) : "";
  if (!latest || !zip) return null;
  return {
    latest, zip,
    url: String(p.url || "").startsWith("https://github.com/" + UPDATE_REPO + "/releases") ? String(p.url) : "",
    cuUserIds: (Array.isArray(p.cuUserIds) ? p.cuUserIds : []).map(String).filter((x) => /^\d{1,15}$/.test(x)).slice(0, 500),
    notify: !!p.notify,
    nonce: typeof p.nonce === "string" ? p.nonce.slice(0, 40) : "",
    at: Number(p.at) || 0,
  };
}
// This copy's view of the policy: a preview release replaces `latest` for the
// people it was published to.
async function effectivePolicy(policy) {
  const pv = policy && policy.preview;
  if (!pv || !pv.cuUserIds.length) return policy;
  const cfg = await getClickupConfig().catch(() => null);
  const me = cfg && cfg.userId != null ? String(cfg.userId) : "";
  if (!me || !pv.cuUserIds.includes(me)) return policy;
  if (policy.latest && cmpVersion(policy.latest, pv.latest) >= 0) return policy; // already released to everyone
  return { ...policy, latest: pv.latest, zip: pv.zip, url: pv.url, quietFor: pv.notify ? "" : pv.latest,
    notifyNonce: pv.notify && pv.nonce ? pv.nonce : policy.notifyNonce, notifiedAllAt: pv.at || policy.notifiedAllAt, previewForMe: true };
}
// Where the settings file is read from. jsDelivr (a free public mirror of GitHub
// files, no request limits) is checked every minute; the Admin panel refreshes
// its copy the moment settings change. GitHub's own file is read every 10
// minutes as well (and whenever jsDelivr fails) and the newer of the two wins,
// so a missed refresh can never leave anyone behind for jsDelivr's 12-hour cache.
const UPDATE_POLICY_CDN = "https://cdn.jsdelivr.net/gh/" + UPDATE_REPO + "@main/" + UPDATE_POLICY_PATH;
const UPDATE_POLICY_PURGE = "https://purge.jsdelivr.net/gh/" + UPDATE_REPO + "@main/" + UPDATE_POLICY_PATH;
const UPDATE_RAW_EVERY_MS = 10 * 60000;
async function readPolicyFrom(url) {
  try {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    return res.ok ? normalizeUpdatePolicy(await res.json()) : null;
  } catch (e) { return null; }
}
async function fetchUpdatePolicy() {
  const { updatePolicy: stored } = await chrome.storage.local.get("updatePolicy");
  const cdn = await readPolicyFrom(UPDATE_POLICY_CDN);
  const rawDue = !cdn || !stored || Date.now() - (stored.rawAt || 0) >= UPDATE_RAW_EVERY_MS;
  const raw = rawDue ? await readPolicyFrom(UPDATE_POLICY_URL) : null;
  const known = stored && stored.policy ? normalizeUpdatePolicy(stored.policy) : null;
  // Newest wins (by the Admin's save time), and never go back to an older copy.
  const best = [cdn, raw, known].filter(Boolean).sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
  const policy = best || normalizeUpdatePolicy(UPDATE_POLICY_DEFAULTS);
  await chrome.storage.local.set({ updatePolicy: { at: Date.now(), rawAt: rawDue ? Date.now() : (stored && stored.rawAt) || 0, policy } });
  return policy;
}
// Every copy looks for news once a minute (a ~200-byte file). The login alarm
// still calls the check every 30 minutes too; nothing doubles up.
async function scheduleUpdateAlarm() {
  try {
    const a = await chrome.alarms.get(UPDATE_ALARM);
    if (!a || a.periodInMinutes !== 1) await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  } catch (e) {}
}
// Refresh jsDelivr's copy after the Admin panel changes the file - now, and once
// more a little later in case GitHub hadn't finished publishing the commit.
async function purgePolicyCdn() {
  const hit = () => fetch(UPDATE_POLICY_PURGE, { cache: "no-store" }).catch(() => {});
  await hit();
  setTimeout(hit, 20000);
}

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
// GitHub's release API allows 60 requests an hour per internet connection, shared
// by everyone in the same office - so it is asked only when there is a reason:
// a Check-for-updates press, a new "Notify everyone", this copy just updated, or
// every 6 hours. A failure backs off 5 minutes instead of retrying every minute.
// Everything else (reminders, holds, important) is decided from what is stored.
const RELEASE_CHECK_MS = 6 * 3600 * 1000;
const RELEASE_RETRY_MS = 5 * 60000;
async function checkForUpdate(force, forceNotify = false) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(UPDATE_REPO) || UPDATE_REPO === "OWNER/REPO") return { ok: false, reason: "not-configured" };
  const current = chrome.runtime.getManifest().version;
  const { updateInfo: prev } = await chrome.storage.local.get("updateInfo");
  const policy = await effectivePolicy(await fetchUpdatePolicy());
  scheduleUpdateAlarm();
  await maybeApplyTeamSites(policy).catch(() => {});
  await applyCompanyCal(policy).catch(() => {});
  await applyPausedClients(policy).catch(() => {});
  await applyTeamReminders(policy).catch(() => {});
  // "Notify everyone now": a nonce this copy hasn't acted on yet skips the
  // reminder gap and any hold.
  const nonceNew = !!policy.notifyNonce && policy.notifyNonce !== (prev && prev.nonceSeen);
  const now = Date.now();
  const backingOff = prev && prev.releaseFailAt && now - prev.releaseFailAt < RELEASE_RETRY_MS;
  // Only a Check-for-updates press ignores the 5-minute back-off: retrying every
  // minute while GitHub refuses would just keep the whole office locked out.
  // With the newest release in the settings file, first runs and "Notify
  // everyone" don't need the API at all; it stays as a 6-hourly safety net for
  // releases published outside the Admin panel.
  const polRelease = !!(policy.latest && policy.zip);
  const needRelease = force || (!backingOff && (((!prev || !prev.latest) && !polRelease) ||
    (prev && prev.current !== current) || (nonceNew && !polRelease) ||
    // 6-hourly safety net. A first run that the file can already answer starts
    // that clock instead of spending a request (see releaseCheckedAt below).
    (prev ? now - (prev.releaseCheckedAt || 0) >= RELEASE_CHECK_MS : !polRelease)));
  let apiError = "";
  let info;
  if (needRelease) {
    try {
      const res = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest", {
        headers: { Accept: "application/vnd.github+json" }, cache: "no-store",
      });
      if (!res.ok) throw new Error("GitHub HTTP " + res.status);
      const j = await res.json();
      const latest = String(j.tag_name || "").replace(/^v/i, "");
      const zip = (Array.isArray(j.assets) ? j.assets : []).find((x) => /\.zip$/i.test(x.name || ""));
      info = {
        checkedAt: now, releaseCheckedAt: now, releaseFailAt: 0, current, latest,
        // "[critical]" in the release notes marks it important. (The old
        // /[critical]/ was a character class - any c, r, i, t, a or l - so EVERY
        // release counted as important and reminded every 4 hours.)
        notesCritical: /\[critical\]/i.test(String(j.body || "")),
        url: j.html_url || "https://github.com/" + UPDATE_REPO + "/releases/latest",
        zip: zip ? zip.browser_download_url : "",
        nonceSeen: prev && prev.nonceSeen,
        notifiedFor: prev && prev.notifiedFor,
        notifiedAt: prev && prev.notifiedAt,
      };
    } catch (e) {
      // Not fatal: the settings file may still know the newest release.
      apiError = String(e && e.message ? e.message : e);
      info = { ...(prev || {}), current, checkedAt: now, releaseFailAt: now };
    }
  } else {
    info = { ...prev, current, checkedAt: now };
  }
  // Whichever knows the newer release wins: the file or the API.
  if (polRelease && (!info.latest || cmpVersion(policy.latest, info.latest) > 0)) {
    info.latest = policy.latest;
    info.zip = policy.zip;
    info.url = policy.url || "https://github.com/" + UPDATE_REPO + "/releases/latest";
    info.notesCritical = false; // importance comes from the file's own switch
    if (!info.releaseCheckedAt) info.releaseCheckedAt = now; // start the 6-hour safety-net clock
  }
  info.newer = !!info.latest && cmpVersion(info.latest, current) > 0;
  info.critical = policy.important || !!info.notesCritical;
  // Automatic install time for this version: when it was announced (or first
  // seen here) + the Admin's delay; important releases don't wait; a hold wins.
  if (info.latest && (!prev || prev.autoFor !== info.latest)) { info.autoFor = info.latest; info.autoFirstSeen = now; }
  else if (prev) { info.autoFor = prev.autoFor; info.autoFirstSeen = prev.autoFirstSeen; }
  {
    const base = policy.latest === info.latest && policy.notifiedAllAt ? policy.notifiedAllAt : (info.autoFirstSeen || now);
    const delay = info.critical ? 0 : policy.autoInstallAfterHours * 3600000;
    info.autoAt = Math.max(base + delay, policy.holdUntil || 0);
  }
  if (apiError) info.error = apiError; else delete info.error;
  // Notify when a version is new to us, again at the Admin's reminder interval
  // (important = at most every 4 hours) until its zip is downloaded, never
  // before a hold time - unless the admin pressed Notify everyone now - and
  // whenever the user presses "Check for updates" themselves.
  const { updateDownload: dl } = await chrome.storage.local.get("updateDownload");
  const downloaded = dl && dl.version === info.latest;
  const gap = (info.critical ? Math.min(4, policy.remindEveryHours) : policy.remindEveryHours) * 3600 * 1000;
  const held = now < policy.holdUntil;
  const due = nonceNew || (!held && (info.notifiedFor !== info.latest || now - (info.notifiedAt || 0) >= gap));
  info.nonceSeen = policy.notifyNonce || info.nonceSeen; // act on each nonce once
  if (info.newer && (forceNotify || (due && !downloaded))) {
    info.notifiedFor = info.latest;
    info.notifiedAt = now;
    // No "Update now" pop-up when the admin published it quietly, or when this
    // copy's automatic updates are set up and working (it installs by itself and
    // says "Updated" afterwards). "Check for updates" always shows it.
    // Automatic updates ON (the default): no "Update available" pop-ups at all -
    // it installs by itself, and if Chrome needs a click to finish, that one
    // notice comes from the installer. Only an Important update still left
    // uninstalled a day after it appeared speaks up, so nobody is stuck on a
    // broken version. (It used to stay quiet only when the install could be
    // confirmed to work right then, so some copies were reminded every few hours.)
    let quiet = "";
    if (!forceNotify) {
      if (policy.quietFor && policy.quietFor === info.latest && !nonceNew) quiet = "admin";
      else if ((await getSettings()).autoUpdate !== false) {
        // Still not installed a day after it appeared - whatever the reason
        // (no folder, a failed download, a tab that timed out) - for an Important one.
        const stuck = info.critical && now - (info.autoFirstSeen || now) > 24 * 3600000;
        if (!stuck) quiet = "auto";
      }
    }
    info.quiet = quiet;
    await chrome.storage.local.set({ updateInfo: info });
    if (!quiet) await showUpdateNotification(info);
  }
  await chrome.storage.local.set({ updateInfo: info });
  return apiError ? { ok: false, reason: apiError, ...info } : { ok: true, ...info };
}

// Update notification: stays until dismissed; buttons = download / what's new.
// Button + click targets are read back from storage (updateInfo), because the
// service worker may have been restarted by the time the user clicks.
// Would an automatic update work here right now? (Asked of the offscreen page,
// which holds the folder permission; remembered for 30 minutes.)
let autoReadyCache = null;
async function autoUpdateReady() {
  if (autoReadyCache && Date.now() - autoReadyCache.at < 30 * 60000) return autoReadyCache.ready;
  let ready = false;
  try {
    await ensureOffscreenDocument();
    for (let i = 0; i < 6; i++) {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "AUTO_UPDATE_READY" }).catch(() => null);
      if (r && typeof r.ready === "boolean") {
        ready = r.ready;
        // The hidden page lacks the permission, but the last update went in from
        // a background tab: it will again, so no "Update now" pop-up is needed.
        if (!ready && r.reason === "permission") {
          const { autoUpdateViaTab: v } = await chrome.storage.local.get("autoUpdateViaTab");
          ready = !!(v && v.ok);
        }
        break;
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  } catch (e) {}
  autoReadyCache = { at: Date.now(), ready };
  return ready;
}
async function showUpdateNotification(info) {
  // Off / paused in the bell menu: stay quiet. A critical update still shows
  // (silently - the sound player checks the same switch) so nobody is left
  // on a broken version; the popup's update banner covers the rest.
  if (notificationsMuted(await getSettings()) && !info.critical) return;
  try {
    await chrome.notifications.create("update-available-" + info.latest, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: (info.critical ? "Important update: v" : "Update available: v") + info.latest,
      message: "You have v" + info.current + ". Click Update now to install it." + (info.critical ? " Please do this today." : ""),
      priority: 2,
      requireInteraction: true,
      buttons: [{ title: "Update now" }, { title: "What's new" }],
    });
  } catch (e) {}
  await playNotificationSound(false).catch(() => {});
}
// Runs on every install/reload. If the user downloaded an update, tell them
// plainly whether it is now installed, or exactly what is still missing.
// ---------- automatic background updates ----------
// A new version installs as soon as this copy notices it - there is no "quiet
// moment" any more. The old rule (popup or side panel closed, user idle, and
// after 20 minutes install anyway) meant people who keep the dashboard or the
// side panel open all day stayed on the old version for days, which is what
// "it says there is an update but never installs" turned out to be.
// The price of installing straight away: the reload closes an open popup or
// side panel. Extension TABS are reopened by the handler near the end of this
// file, so a dashboard left open comes back on its own.
const AUTO_FAST_RETRY_MS = 45 * 1000; // first tries: again almost at once
const AUTO_FAST_TRIES = 3;
const AUTO_RETRY_MS = 30 * 60000; // after that: every 30 minutes, for as long as it takes
// Pure: should this copy install right now? ("off" = the user turned it off,
// "up-to-date" = nothing newer, "scheduled" = the admin's rollout time hasn't
// come, "retry-wait" = a recent try failed and the next one isn't due.)
function autoUpdateWhen(st, ui, autoOn, now) {
  if (autoOn === false) return { go: false, why: "off" };
  if (!ui || !ui.newer || !ui.zip || !ui.latest) return { go: false, why: "up-to-date" };
  if (now < (Number(ui.autoAt) || 0)) return { go: false, why: "scheduled" };
  const lastTry = Number(st && st.lastTry) || 0;
  if (lastTry) {
    const fails = (st && st.fails) || 0;
    // Waiting for the person (setup, Chrome's OK, a click): don't keep opening tabs.
    const setup = /^(no-folder|permission|moved|needs-click)$/.test(String((st && st.reason) || ""));
    const wait = setup ? AUTO_RETRY_MS : fails < AUTO_FAST_TRIES ? AUTO_FAST_RETRY_MS : AUTO_RETRY_MS;
    if (now - lastTry < wait) return { go: false, why: "retry-wait" };
  }
  return { go: true, why: "" };
}
// The taskbar app updates this extension's folder (desktop-tracker/src/extupdate.js):
// it finds the folder the browser has on record for this extension and writes a
// random code there; reading that code back from this extension proves it is
// the folder it runs from; then the app downloads this project's release,
// checks it and installs it (backup, manifest last). { ok, version } or
// { ok: false, reason: "no-app" | "not-found" | "app-wrong-folder" | ... }.
async function installViaDesktop(ui) {
  const post = async (body, ms) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(DESK_URL + "/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      return res.ok ? await res.json() : null; // 404 = an app too old to do it
    } catch (e) { return null; } finally { clearTimeout(t); }
  };
  if (!ui || !ui.zip || !ui.latest) return { ok: false, reason: "no-update" };
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => (b % 36).toString(36)).join("");
  const loc = await post({ op: "locate", nonce }, 6000);
  if (!loc) return { ok: false, reason: "no-app" };
  if (!loc.ok) return { ok: false, reason: loc.reason || "app-failed", error: loc.error || "" };
  let seen = "";
  try { seen = (await (await fetch(chrome.runtime.getURL("pcm-folder-check.txt") + "?t=" + Date.now(), { cache: "no-store" })).text()).trim(); } catch (e) {}
  if (seen !== nonce) return { ok: false, reason: "app-wrong-folder", error: "the folder the taskbar app found isn't the one this extension runs from" };
  const res = await post({ op: "install", nonce, version: ui.latest, zip: ui.zip }, 200000);
  if (!res) return { ok: false, reason: "app-no-reply" };
  return res.ok ? { ok: true, version: res.version, via: "app" } : { ok: false, reason: res.reason || "app-failed", error: res.error || "" };
}
async function maybeAutoUpdate() {
  const settings = await getSettings();
  const { updateInfo: ui, autoUpdateState: prevState } = await chrome.storage.local.get(["updateInfo", "autoUpdateState"]);
  const now = Date.now();
  const st = prevState && ui && prevState.version === ui.latest ? prevState : { version: (ui && ui.latest) || "", fails: 0 };
  if (!autoUpdateWhen(st, ui, settings.autoUpdate, now).go) return;
  // Extension pages to bring back after the reload. The popup and the side
  // panel are not in here: Chrome only opens those from a click, so they close.
  let tabs = [];
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ["TAB"] });
    // Not an update tab itself: after the restart it would only ask again.
    tabs = ctx.map((c) => c.documentUrl).filter((u) => u && String(u).startsWith(chrome.runtime.getURL("")) && !/\/auto-update\.html/.test(String(u)));
  } catch (e) {}
  st.lastTry = now;
  // First the taskbar app (ClickUp Tracker 0.3.9+): it writes the new version
  // into this extension's folder itself - no browser permission, no click.
  // Quietly skipped when the app isn't installed, running or new enough.
  const app = await installViaDesktop(ui).catch((e) => ({ ok: false, reason: "app-error", error: String((e && e.message) || e) }));
  const appTrace = "taskbar app: " + (app.ok ? "installed" : app.reason + (app.error ? " (" + String(app.error).slice(0, 80) + ")" : ""));
  let r = app.ok ? app : null;
  if (!r) {
    await ensureOffscreenDocument();
    for (let i = 0; i < 10 && !r; i++) {
      try { r = await chrome.runtime.sendMessage({ target: "offscreen", type: "AUTO_UPDATE", ui: { latest: ui.latest, zip: ui.zip } }); }
      catch (e) { await new Promise((res) => setTimeout(res, 300)); }
    }
  }
  const trace = [appTrace].concat(app.ok ? [] : ["hidden page: " + (!r ? "no reply" : r.ok ? "installed" : r.reason + (r.error ? " (" + String(r.error).slice(0, 80) + ")" : ""))]);
  // The hidden page couldn't do it (often the folder permission - Chrome applies
  // "Allow on every visit" to the extension's tabs - or anything else that went
  // wrong there): do the same install from a tab opened in the background; if
  // that tab isn't allowed either, it is brought to the front (see installViaTab).
  // Never a second update tab: not while one is still open, and not again for a
  // version that is waiting for the person's click (needs-click / permission) -
  // the notice and the Version and updates card say how to finish it. (Opening
  // a fresh tab in front every 30 minutes is what made it "keep coming back".)
  const openTabs = await chrome.tabs.query({ url: chrome.runtime.getURL("auto-update.html") + "*" }).catch(() => []);
  // Waiting for a click on THIS version - but not forever: after 6 hours the
  // background tab is tried once more (Chrome often has the folder permission
  // back by then, e.g. after a restart).
  const waitingForClick = /^(needs-click|permission)$/.test(String(st.reason || "")) && (!st.lastTabAt || now - Number(st.lastTabAt) < 6 * 3600000);
  // A browser where even the update tab in front needed a click (Comet doesn't
  // keep "Allow on every visit") would get that tab popping up with EVERY
  // release. There, no tab is opened by itself any more: the update waits for
  // the person - one notice, the popup's banner, Version and updates › Update now.
  // (Ends as soon as the hidden page manages an update by itself.)
  const { autoUpdateClickOnly: clickFlag, autoUpdateViaTab: lastTab } = await chrome.storage.local.get(["autoUpdateClickOnly", "autoUpdateViaTab"]);
  // A browser that needed a click before still gets an automatic try with every
  // release - from a tab that STAYS in the background (quiet): where Chrome kept
  // "Allow on every visit" it installs by itself; where it can't (Comet), that tab
  // closes and the one "click to finish" notice says so - no tab jumping in front.
  // (It used to skip the try altogether: one update that needed a click switched
  // automatic updates off on that computer for every later release.)
  const clickOnly = !!clickFlag || !!(lastTab && lastTab.reason === "needs-click");
  if (!(r && r.ok) && (openTabs.length || waitingForClick)) {
    trace.push("update tab: not opened " + (openTabs.length ? "again (one is already open)" : waitingForClick ? "again (waiting for your click)" : "(this browser always needs a click - waiting for you)"));
    // Still waiting for the same click: keep saying so, quietly. (Recording the
    // hidden page's "permission" here fired a second notice - "set up again" -
    // whose button opened the update page in yet another tab.)
    r = { ok: false, reason: waitingForClick ? st.reason : "needs-click" };
  } else if (!(r && r.ok) && !(r && /^(no-update|no-folder)$/.test(r.reason || ""))) {
    const t = await installViaTab({ quiet: clickOnly });
    st.lastTabAt = now;
    if (t) {
      trace.push((t.woke ? "tab (brought to the front): " : "background tab: ") + (t.ok ? "installed" : t.reason + (t.error ? " (" + String(t.error).slice(0, 80) + ")" : "")));
      await chrome.storage.local.set({ autoUpdateViaTab: { ok: !!t.ok || !/^(permission|no-folder|moved|tab-timeout|stalled|no-update|needs-click)$/.test(t.reason || ""), at: now, reason: t.reason || "", version: ui.latest } });
      if (t.reason === "needs-click") await chrome.storage.local.set({ autoUpdateClickOnly: { version: ui.latest, at: now } });
      r = t;
      autoReadyCache = null;
    } else trace.push("background tab: couldn't open one");
  }
  diagLog("automatic update", trace.join(" -> "));
  // The hidden page installed it by itself: this browser keeps the permission now.
  // Installed (by the hidden page or a tab): any "needs a click" note is history.
  if (r && r.ok) await chrome.storage.local.remove(["autoUpdateClickOnly", "autoUpdateViaTab"]).catch(() => {});
  if (r && r.ok && trace.some((x) => /^(hidden page|taskbar app): installed/.test(x))) await chrome.storage.local.remove(["autoUpdateViaTab"]).catch(() => {});
  if (r && r.ok) {
    // Put back the tab the person was using if the update tab came to the front.
    try {
      const { autoUpdateWake: w } = await chrome.storage.local.get("autoUpdateWake");
      if (w && w.prevTabId != null) await chrome.tabs.update(w.prevTabId, { active: true }).catch(() => {});
      if (w && w.prevWindowId != null) await chrome.windows.update(w.prevWindowId, { focused: true }).catch(() => {});
      await chrome.storage.local.remove("autoUpdateWake");
    } catch (e) {}
    await chrome.storage.local.set({
      autoUpdateState: { version: ui.latest, installedAt: now, fails: 0 },
      updateDownload: { version: ui.latest, done: true, at: now, via: "auto" },
      reopenAfterReload: { urls: tabs, at: now },
    });
    setTimeout(() => chrome.runtime.reload(), 500);
    return;
  }
  st.reason = (r && r.reason) || "no-reply";
  st.error = (r && r.error) || "";
  st.trace = trace;
  st.lastTryAt = now;
  // Chrome wants one click: the update tab is open in front with a Finish update
  // button. Say so once per version (clicking the notice shows that tab).
  if (st.reason === "needs-click") {
    if (st.clickNoticeFor !== ui.latest && !notificationsMuted(await getSettings())) {
      st.clickNoticeFor = ui.latest;
      chrome.notifications.create("auto-update-click-" + ui.latest, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), priority: 2, requireInteraction: true,
        title: "One click to finish updating to v" + ui.latest,
        message: "The browser needs your OK to let the extension update its folder. Click here when it suits you, then Install / Finish update - it installs and restarts the extension.",
      }, () => void chrome.runtime.lastError);
    }
    await chrome.storage.local.set({ autoUpdateState: st });
    return;
  }
  // A one-time setup problem isn't a failure to count - it just waits for setup.
  if (!/^(no-folder|permission|moved)$/.test(st.reason)) {
    st.fails = (st.fails || 0) + 1;
    diagLog("automatic update", st.reason + (st.error ? ": " + st.error : ""));
  } else if (st.setupNoticeFor !== ui.latest && !notificationsMuted(await getSettings())) {
    // (Muted in the bell menu: not marked as shown, so it comes once they're back on.)
    // "Install updates automatically" is ticked, but the one-time folder setup
    // was never done (or Chrome was told "Allow this time"): it would otherwise
    // retry silently forever. Say so ONCE per version, with the way to fix it.
    st.setupNoticeFor = ui.latest;
    const why = st.reason === "no-folder"
      ? "Automatic updates need a one-time setup on this computer: choose the extension's folder and pick “Allow on every visit”."
      : st.reason === "moved"
        ? "The extension's folder has moved. Choose its current folder once and pick “Allow on every visit”."
        : "Chrome didn't keep its permission for the extension's folder (usually “Allow this time” was picked). Set it up again and pick “Allow on every visit”.";
    chrome.notifications.create("auto-update-setup-" + ui.latest, {
      type: "basic", iconUrl: chrome.runtime.getURL("icons/icon128.png"), priority: 2, requireInteraction: true,
      title: "v" + ui.latest + " couldn't install automatically",
      message: why + " It takes about 30 seconds and only once.",
      buttons: [{ title: "Set up automatic updates" }, { title: "Install this update now" }],
    }, () => void chrome.runtime.lastError);
    diagLog("automatic update", "waiting for setup: " + st.reason);
  }
  await chrome.storage.local.set({ autoUpdateState: st });
}

// Install from auto-update.html in a tab that isn't focused, wait for its
// answer (2 minutes at most), close it. null = the tab couldn't be opened.
// The tab asks to come to the front when Chrome won't let a hidden page use the
// folder (AUTO_UPDATE_TAB_FRONT) - like Agent Router's paused-tab wake - and the
// tab the person was using is put back afterwards. A tab that needs a click
// (needs-click) stays open in front. The background keeps itself awake while the
// tab downloads and installs.
async function installViaTab(opts = {}) {
  const quiet = !!(opts && opts.quiet);
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let tab = null, onMsg = null, timer = null, keep = null, woke = false;
  const bringForward = async () => {
    if (woke || !tab) return;
    woke = true;
    try {
      const [prev] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
      const win = await chrome.windows.getLastFocused().catch(() => null);
      await chrome.storage.local.set({ autoUpdateWake: { prevTabId: prev && prev.id !== tab.id ? prev.id : null, prevWindowId: win && win.id !== tab.windowId ? win.id : null } });
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    } catch (e) {}
  };
  const answer = new Promise((resolve) => {
    onMsg = (msg) => {
      if (!msg || msg.nonce !== nonce) return;
      // Quiet: not brought to the front - it needs a click, and the notice asks for it.
      if (msg.type === "AUTO_UPDATE_TAB_FRONT") { if (quiet) resolve({ ok: false, reason: "needs-click", quiet: true }); else bringForward(); return; }
      if (msg.type === "AUTO_UPDATE_TAB_RESULT") resolve(msg);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    timer = setTimeout(() => resolve({ ok: false, reason: "tab-timeout" }), 150000);
  });
  const cleanup = () => { chrome.runtime.onMessage.removeListener(onMsg); clearTimeout(timer); clearInterval(keep); };
  keep = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  // The tab checks this on load: one Chrome restored after a restart (session
  // storage is empty then) or left from an earlier try closes itself.
  await chrome.storage.session.set({ autoUpdateTab: { nonce, at: Date.now() } }).catch(() => {});
  try {
    tab = await chrome.tabs.create({ url: chrome.runtime.getURL("auto-update.html?n=" + nonce), active: false });
  } catch (e) {
    cleanup();
    return null;
  }
  const r = await answer;
  cleanup();
  if (!r.ok && (r.reason !== "needs-click" || quiet)) {
    if (tab && tab.id != null) await chrome.tabs.remove(tab.id).catch(() => {});
    if (woke) {
      const { autoUpdateWake: w } = await chrome.storage.local.get("autoUpdateWake").catch(() => ({}));
      if (w && w.prevTabId != null) await chrome.tabs.update(w.prevTabId, { active: true }).catch(() => {});
      if (w && w.prevWindowId != null) await chrome.windows.update(w.prevWindowId, { focused: true }).catch(() => {});
      await chrome.storage.local.remove("autoUpdateWake").catch(() => {});
    }
  }
  return { ok: !!r.ok, version: r.version, reason: r.reason || "", error: r.error || "", woke };
}

// A task about to be completed with nothing to show for it: no filled
// Description: "..." or File: "..." in its description, and no comment. Returns
// { name } then, else null - also null when it can't be checked (a failed read
// never stops a task being completed) and for the recurring Extra Task.
const EVIDENCE_FIELD = (name) => new RegExp("(?:^|\\n)[ \\t*_>-]*" + name + "\\s*:\\s*[*_]*\\s*\"([\\s\\S]*?)\"", "i");
function hasEvidenceText(desc) {
  return ["Description", "File"].some((n) => { const m = EVIDENCE_FIELD(n).exec(String(desc || "")); return !!(m && m[1].replace(/[*_\s]/g, "")); });
}
async function completionEvidenceMissing(cfg, taskId) {
  try {
    const d = await getTaskDetail(cfg.token, taskId);
    if (/\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(d.name || "")) return null;
    if (hasEvidenceText(d.description)) return null;
    const cs = await getTaskCommentsLite(cfg.token, taskId);
    return cs.length ? null : { name: d.name || "" };
  } catch (e) { return null; }
}

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
// ---------- Slack downloads -> the client's files ----------
// Clients › "Slack downloads go to the client's files" (storage slackAutoFile; the
// extension can already read files.slack.com - host *://*/* for Site monitor): a document you
// download from Slack is copied into the client's files too. The client comes from
// the Slack channel you're in (the Slack tab's title) and the file name. With the
// taskbar app: straight into the client's folder; otherwise it waits in the
// "From Slack" box (IndexedDB pcm-slackinbox) and the Clients tab files it - or
// asks which client when it can't tell. Your own download stays where it is.
const SLACK_DOC_RE = /\.(pdf|docx?|xlsx?|csv|html?|md|txt|pptx?|json|rtf|odt|ods)$/i;
const SLACK_GENERIC = new Set(["seo", "client", "clients", "audit", "audits", "website", "services", "service", "group", "digital", "marketing", "company", "agency", "solutions", "media", "local", "report", "the", "and", "daily", "tracking", "team", "alert", "task", "tasks", "update", "general"]);
const sKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
function slackInboxDb() {
  return new Promise((ok, bad) => {
    const r = indexedDB.open("pcm-slackinbox", 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains("files")) r.result.createObjectStore("files", { keyPath: "id" }); };
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
}
async function slackInboxPut(rec) {
  const d = await slackInboxDb();
  await new Promise((ok, bad) => { const tx = d.transaction("files", "readwrite"); tx.objectStore("files").put(rec); tx.oncomplete = ok; tx.onerror = () => bad(tx.error); });
  d.close();
}
// Every client name the extension knows: on your tasks, saved in Clients, or with notes.
async function slackClientNames() {
  const names = new Set();
  try {
    const st = (await getClickupState()) || {};
    for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek, st.custom]) for (const t of (b && b.tasks) || []) if (t && t.client) names.add(String(t.client));
  } catch (e) {}
  try {
    const g = await chrome.storage.local.get(["clientNotes", "settings", "insOpenCache"]);
    for (const l of Object.values(g.clientNotes || {})) if (Array.isArray(l) && l[0] && l[0].client) names.add(String(l[0].client));
    for (const n of (g.settings && g.settings.tfAdded) || []) if (typeof n === "string") names.add(n);
    for (const t of (g.insOpenCache && g.insOpenCache.tasks) || []) if (t && t.client) names.add(String(t.client));
  } catch (e) {}
  return [...names].filter((n) => sKey(n).length >= 3);
}
// The one client the hints (channel name, file name) point to, or "".
// How well a client name fits one hint (a channel or file name): 100 the same
// name ("Acme Co SEO" / #acme-co), 50+ the hint holds the whole name -
// the longer, the more specific (so #acme-co beats "Acme SEO"), 30+ the
// name holds the hint (#blue-sky-roofing for "Blue Sky Roofing Pros SEO"), 1 only a
// shared word (never enough to pick a channel by itself).
function slackMatchScore(n, h) {
  const full = sKey(n), k = full.replace(/seo$/, ""), hk = sKey(h);
  if (k.length < 4 || hk.length < 3) return 0;
  if (hk === k || hk === full) return 100;
  if (hk.includes(k)) return 50 + k.length;
  if (hk.length >= 5 && k.includes(hk)) return 30 + hk.length;
  const words = String(n).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !SLACK_GENERIC.has(w));
  return words.some((w) => hk.includes(w)) ? 1 : 0;
}
// Channel suggestions for Match channels: best pairs first, each client and each
// channel used once; a shared word alone never suggests a channel (Daily Tracking
// is not #daily-alert-team-c).
function slackSuggest(names, chans) {
  const pairs = [];
  for (const c of chans) for (const n of names) { const sc = slackMatchScore(n, c.name); if (sc >= 30) pairs.push([sc, n, c.id]); }
  pairs.sort((x, y) => y[0] - x[0]);
  const suggest = {}, used = new Set();
  for (const [, n, id] of pairs) if (!suggest[n] && !used.has(id)) { suggest[n] = id; used.add(id); }
  return suggest;
}
// The one client the hints (channel name, file name) point to best, or "" on a tie.
function guessSlackClient(names, hints) {
  let best = 0, pick = [];
  for (const n of names) {
    const s = Math.max(0, ...hints.map((h) => slackMatchScore(n, h)));
    if (s > best) { best = s; pick = [n]; } else if (s && s === best && !pick.some((p) => sKey(p) === sKey(n))) pick.push(n);
  }
  return pick.length === 1 ? pick[0] : "";
}
// The channel of the Slack tab used last ("acme-dental (Channel) - Team - Slack").
async function slackChannelHint() {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://app.slack.com/*", "https://*.slack.com/*"] });
    const t = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    if (!t || !t.title) return "";
    return String(t.title).replace(/^[*!]\s*/, "").split(" - ")[0].replace(/\s*\((channel|private channel|dm|direct message)\)\s*$/i, "").trim().slice(0, 80);
  } catch (e) { return ""; }
}
const abToB64 = (ab) => { const u = new Uint8Array(ab); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
async function onSlackDownload(id) {
  const { slackAutoFile } = await chrome.storage.local.get("slackAutoFile");
  if (!slackAutoFile) return;
  const [it] = await chrome.downloads.search({ id }).catch(() => []);
  const url = (it && (it.finalUrl || it.url)) || "";
  if (!/^https:\/\/files\.slack\.com\//.test(url)) return;
  const name = String(it.filename || "").split(/[\\/]/).pop() || "file";
  if (!SLACK_DOC_RE.test(name)) return; // documents only (screenshots and the like stay out)
  const open = chrome.runtime.getURL("options.html#files");
  let blob = null, why = "";
  try {
    const res = await fetch(url, { credentials: "include", cache: "no-store" });
    if (!res.ok) why = "Slack answered " + res.status;
    else {
      blob = await res.blob();
      if (/text\/html/i.test(blob.type) && !/\.html?$/i.test(name)) { blob = null; why = "Slack sent its sign-in page"; }
    }
  } catch (e) { why = String((e && e.message) || e); }
  if (blob && blob.size > 25 * 1048576) { blob = null; why = "over 25 MB"; }
  if (!blob) {
    await notify("slack-" + id, "Slack file not copied", "\u201C" + name + "\u201D (" + why + "). Add it from Clients \u203A + Add files instead.", undefined, open).catch(() => {});
    return;
  }
  const channel = await slackChannelHint();
  const client = guessSlackClient(await slackClientNames(), [channel, name.replace(/\.[a-z0-9]+$/i, "")]);
  const where = await saveSlackFile(blob, name, client, channel, String(id));
  if (where.startsWith("dup:")) await notify("slack-" + id, "Already in " + client + "\u2019s files", "\u201C" + name + "\u201D is the same file as \u201C" + where.slice(4) + "\u201D - not saved again.", undefined, open).catch(() => {});
  else if (where === "folder") await notify("slack-" + id, "Slack file saved for " + client, "\u201C" + name + "\u201D is in " + client + "\u2019s folder" + (channel ? " (from #" + channel + ")" : "") + ".", undefined, open).catch(() => {});
  else await notify("slack-" + id, client ? "Slack file for " + client : "Slack file: which client?",
    "\u201C" + name + "\u201D" + (client ? " - it's added to " + client + "\u2019s files when the extension's page is open (click to open it)." : " - pick the client in Clients \u203A From Slack (click to open it)."), undefined, open).catch(() => {});
}
// Into the client's folder with the taskbar app ("folder"), otherwise the From
// Slack box, which the Clients page files (known client) or asks about ("inbox").
// Already there? The same content under any name ("dup"): checked by a
// fingerprint (SHA-256) against what Slack brought before (storage slackHashes,
// per client), the files in the client's folder and the ones kept in the
// extension or waiting in From Slack - only files of the same size are read.
const sha256 = async (ab) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", ab))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function deskFiles(body, ms) {
  try {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms || 20000);
    const res = await fetch("http://127.0.0.1:47615/pcm/files", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
    clearTimeout(tm);
    return res.ok ? await res.json() : null;
  } catch (e) { return null; }
}
async function slackHasSame(client, size, hash) {
  const ck = sKey(client);
  const { slackHashes } = await chrome.storage.local.get("slackHashes");
  if (slackHashes && slackHashes[ck] && slackHashes[ck][hash]) return slackHashes[ck][hash];
  const b64Hash = async (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return sha256(u8.buffer); };
  // the client's folder (taskbar app)
  const ls = await deskFiles({ op: "list", client }, 8000);
  for (const f of ((ls && ls.ok && ls.files) || []).filter((x) => Number(x.size) === size).slice(0, 8)) {
    const rd = await deskFiles({ op: "read", client, rel: f.rel }, 30000);
    if (rd && rd.ok && rd.b64 && (await b64Hash(rd.b64)) === hash) return f.rel;
  }
  // kept in the extension (Clients files) and waiting in From Slack
  const sameIn = (dbName, idx) => new Promise((ok) => {
    const rq = indexedDB.open(dbName);
    rq.onerror = () => ok([]);
    rq.onsuccess = () => {
      const d = rq.result;
      try {
        if (!d.objectStoreNames.contains("files")) { d.close(); return ok([]); }
        const st = d.transaction("files").objectStore("files");
        const q = idx && st.indexNames.contains(idx) ? st.index(idx).getAll(ck) : st.getAll();
        q.onsuccess = () => { d.close(); ok((q.result || []).filter((r) => r && r.blob && r.blob.size === size && (!r.client || sKey(r.client) === ck))); };
        q.onerror = () => { d.close(); ok([]); };
      } catch (e) { d.close(); ok([]); }
    };
  });
  for (const r of (await sameIn("pcm-taskfiles", "ck")).concat(await sameIn("pcm-slackinbox")).slice(0, 8)) {
    if ((await sha256(await r.blob.arrayBuffer())) === hash) return r.name || "a file";
  }
  return "";
}
async function rememberSlackHash(client, hash, name) {
  const ck = sKey(client);
  const { slackHashes } = await chrome.storage.local.get("slackHashes");
  const all = slackHashes && typeof slackHashes === "object" ? slackHashes : {};
  const mine = { ...(all[ck] || {}), [hash]: String(name).slice(0, 120) };
  const keys = Object.keys(mine);
  if (keys.length > 1500) for (const k of keys.slice(0, keys.length - 1500)) delete mine[k];
  await chrome.storage.local.set({ slackHashes: { ...all, [ck]: mine } });
}
async function saveSlackFile(blob, name, client, channel, tag) {
  const ab = await blob.arrayBuffer();
  const hash = await sha256(ab);
  if (client) {
    const same = await slackHasSame(client, blob.size, hash).catch(() => "");
    if (same) { await rememberSlackHash(client, hash, same); return "dup:" + same; }
    const r = await deskFiles({ op: "clientFile", client, name: name.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 120), b64: abToB64(ab) }, 60000);
    if (r && r.ok) { await rememberSlackHash(client, hash, name); return "folder"; }
  }
  await slackInboxPut({ id: "s" + tag + "-" + Date.now().toString(36), name, type: blob.type || "", size: blob.size, blob, channel, client, at: Date.now() });
  await chrome.storage.local.set({ slackInboxAt: Date.now() });
  if (client) await rememberSlackHash(client, hash, name);
  return "inbox";
}

// ---------- Slack channels -> client files, automatically (Clients › Slack) ----------
// Uses the Slack sign-in already in this Chrome (no password): Connect reads the
// Slack web page's own session from an open app.slack.com tab. Then every 20
// minutes the channels matched to clients are checked for new documents (read
// only - nothing is posted or changed in Slack), and each new one is saved like a
// download above. Not an official Slack app: it may need a fix if Slack changes.
// storage slackSession { team, name, domain, token, user, mode, at } - this
// computer only (not in the Drive backup, not in settings).
// storage slackChannels { [channelId]: { name, client } } · slackPoll { at, err, since: { [channelId]: ms }, seen: { [fileId]: ms } }
const SLACK_POLL_MS = 20 * 60000;
const SLACK_AUTH_ERR = /^(invalid_auth|not_authed|account_inactive|token_revoked|token_expired|no_permission)$/;
async function slackTab() {
  const tabs = await chrome.tabs.query({ url: "https://app.slack.com/*" }).catch(() => []);
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}
// A call to Slack's web API with the session. mode "tab": made from inside a Slack
// tab (when Chrome doesn't send Slack's cookie with the extension's own request).
async function slackApi(method, params, s) {
  const body = { token: s.token, ...(params || {}) };
  const url = "https://" + (s.domain || "slack.com") + "/api/" + method;
  if (s.mode !== "tab") {
    const res = await fetch(url, { method: "POST", credentials: "include", body: new URLSearchParams(body) });
    return res.json();
  }
  const tab = await slackTab();
  if (!tab) return { ok: false, error: "no_slack_tab" };
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [url, body],
    func: async (u, b) => { try { const x = await fetch(u, { method: "POST", credentials: "include", body: new URLSearchParams(b) }); return await x.json(); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } } });
  return (r && r.result) || { ok: false, error: "no answer from the Slack tab" };
}
// Slack's sign-in page where a file was expected (also for an .html file, so a
// login page is never saved as an audit): a redirect to sign in, or an HTML page
// that is Slack's own.
async function slackLooksSignin(res, blob) {
  if (res && res.redirected && !/^https:\/\/files\.slack\.com\//.test(res.url || "")) return true;
  if (!/text\/html/i.test((blob && blob.type) || "")) return false;
  const head = (await blob.slice(0, 20000).text().catch(() => "")).toLowerCase();
  return /<title>[^<]*slack[^<]*<\/title>/.test(head) && /sign ?in|signin|redir=/.test(head);
}
// The file itself. The extension's own request first; if Slack answers with its
// sign-in page (its cookie isn't sent with that request for some files), the same
// download from inside an open Slack tab, where the sign-in always is.
async function slackFetchFile(url, s) {
  if (s.mode !== "tab") {
    let why = "";
    try {
      const res = await fetch(url, { credentials: "include", headers: { Authorization: "Bearer " + s.token } });
      if (!res.ok) why = "Slack answered " + res.status;
      else { const b = await res.blob(); if (!(await slackLooksSignin(res, b))) return b; why = "Slack sent its sign-in page"; }
    } catch (e) { why = String((e && e.message) || e); }
    if (!(await slackTab())) throw new Error(why + (/sign-in/.test(why) ? " (open Slack in a Chrome tab and it's fetched from there)" : ""));
  }
  const tab = await slackTab();
  if (!tab) throw new Error("no Slack tab open");
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [url],
    func: async (u) => { const x = await fetch(u, { credentials: "include" }); if (!x.ok) return { error: "Slack answered " + x.status }; const b = await x.blob(); const d = await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(String(fr.result)); fr.readAsDataURL(b); }); return { type: b.type, b64: d.replace(/^data:[^,]*,/, "") }; } });
  const v = r && r.result;
  if (!v || v.error) throw new Error((v && v.error) || "no answer from the Slack tab");
  const bin = atob(v.b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const blob = new Blob([u8], { type: v.type || "" });
  if (await slackLooksSignin(null, blob)) throw new Error("Slack sent its sign-in page");
  return blob;
}
async function slackConnect(teamId) {
  const tab = await slackTab();
  if (!tab) return { ok: false, error: "Open Slack in Chrome first (app.slack.com), signed in, then press Connect again." };
  let raw = null;
  try { const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { try { return localStorage.getItem("localConfig_v2"); } catch (e) { return null; } } }); raw = r && r.result; } catch (e) {}
  let cfg = null; try { cfg = JSON.parse(raw || "null"); } catch (e) {}
  const teams = Object.values((cfg && cfg.teams) || {}).filter((t) => t && t.token && t.id);
  if (!teams.length) return { ok: false, error: "Couldn't find a Slack sign-in in that tab. Sign in to Slack in Chrome (app.slack.com), let it load, then press Connect again." };
  const t = teams.find((x) => x.id === teamId) || teams.find((x) => x.id === (cfg && cfg.lastActiveTeamId)) || teams[0];
  let domain = "slack.com";
  try { if (t.url) domain = new URL(t.url).host; } catch (e) {}
  const s = { team: t.id, name: String(t.name || t.domain || "Slack"), domain, token: String(t.token), mode: "bg", at: Date.now() };
  let a = await slackApi("auth.test", {}, s).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
  if (!a || !a.ok) { s.mode = "tab"; a = await slackApi("auth.test", {}, s).catch((e) => ({ ok: false, error: String(e && e.message || e) })); }
  if (!a || !a.ok) return { ok: false, error: "Slack didn't accept the sign-in (" + ((a && a.error) || "no answer") + "). Reload the Slack tab and press Connect again." };
  s.user = String(a.user || ""); s.userId = String(a.user_id || "");
  await chrome.storage.local.set({ slackSession: s, slackPoll: { ...((await chrome.storage.local.get("slackPoll")).slackPoll || {}), err: "" } });
  return { ok: true, team: s.name, user: s.user, mode: s.mode, teams: teams.map((x) => ({ id: x.id, name: x.name })) };
}
async function slackChannelList() {
  const { slackSession: s } = await chrome.storage.local.get("slackSession");
  if (!s) return { ok: false, error: "Connect Slack first." };
  const out = [];
  let cursor = "";
  for (let i = 0; i < 10; i++) {
    const r = await slackApi("conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) }, s);
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || "no answer", auth: SLACK_AUTH_ERR.test((r && r.error) || "") };
    for (const c of r.channels || []) out.push({ id: c.id, name: c.name, member: !!c.is_member, private: !!c.is_private });
    cursor = (r.response_metadata && r.response_metadata.next_cursor) || "";
    if (!cursor) break;
  }
  out.sort((a, b) => (b.member - a.member) || a.name.localeCompare(b.name));
  // A suggestion per client: the one channel its name points to.
  const names = await slackClientNames();
  const suggest = slackSuggest(names, out);
  return { ok: true, channels: out, clients: names.sort((a, b) => a.localeCompare(b)), suggest };
}
// ---------- Client notices (from the clients' Slack channels) ----------
// A client's instruction posted in its matched Slack channel ("hold off any
// changes from Wednesday", "focus on backlinks", a launch date...). Read with the
// 20-minute Slack check: text only, new top-level messages only (the first look
// goes back 3 days). A message that reads like an instruction - by its shape (a
// pasted client message, @channel, people tagged, a date) and its words - is
// kept, shown once as a notification and shared through the team hub, so
// teammates without Slack connected see it too. The pages (client-notices.js)
// show the Dashboard card and the ⚠ pills on that client's tasks, and Chrome's
// built-in AI (where there is one) adds a one-line summary, the dates and which
// tasks change the site. Nothing changes in ClickUp unless someone clicks.
// storage clientNotices { at, list: [{ id, client, channel, ts, at, text, permalink, by, fromMs, untilMs, score, kind, summary, important, onsite, ai, src }] }
//         cnoteSince { [channelId]: oldest ts read next }, cnoteSeen { [id]: at } (notified once)
const CNOTE_MAX = 60;
const CNOTE_KEEP_MS = 45 * 86400000;
const CNOTE_FIRST_MS = 3 * 86400000;
const CNOTE_MIN_SCORE = 6;
let cnoteRefreshAt = 0;
const CNOTE_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const CNOTE_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Slack's markup as people read it.
function cnotePlain(s, names) {
  return String(s || "")
    .replace(/<!(channel|here|everyone)[^>]*>/g, "@$1")
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (m, id, n) => (n || (names && names[id]) ? "@" + (n || names[id]) : ""))
    .replace(/^[ \t]+/gm, "")
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
// The dates a message names, counted from when it was posted: today, tomorrow,
// a weekday (the next one after that day), or a month and day ("Oct 28",
// "28th October"). The first one is when it starts; one after until / till /
// through is when it ends. { fromMs, untilMs } - start of day, 0 when none.
function cnoteDates(text, postedMs) {
  const low = String(text || "").toLowerCase();
  const base = new Date(Number(postedMs) || Date.now());
  base.setHours(0, 0, 0, 0);
  const hits = [];
  const add = (idx, d) => { d.setHours(0, 0, 0, 0); hits.push({ idx, ms: d.getTime() }); };
  let m;
  const rel = /\b(today|tonight|tomorrow)\b/g;
  while ((m = rel.exec(low))) { const d = new Date(base); if (m[1] === "tomorrow") d.setDate(d.getDate() + 1); add(m.index, d); }
  // Full names, plus the short forms that aren't everyday words ("sat", "sun" are).
  const wd = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues?|wed|thu(?:rs?)?|fri)\b/g;
  while ((m = wd.exec(low))) {
    const i = CNOTE_DAYS.findIndex((n) => n.startsWith(m[1].slice(0, 3)));
    if (i < 0) continue;
    const d = new Date(base);
    let diff = (i - d.getDay() + 7) % 7;
    if (diff === 0) diff = 7;
    d.setDate(d.getDate() + diff);
    add(m.index, d);
  }
  const mon = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])";
  const md = new RegExp("\\b" + mon + "\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?" + mon, "g");
  while ((m = md.exec(low))) {
    const mi = CNOTE_MONTHS.indexOf((m[1] || m[4]).slice(0, 3));
    const day = Number(m[2] || m[3]);
    if (mi < 0 || !(day >= 1 && day <= 31)) continue;
    if (m[1] === "may" && String(text || "").slice(m.index, m.index + 3) === "may") continue; // "the client may 5 times..." (lower case) isn't May 5
    const d = new Date(base.getFullYear(), mi, day);
    if (d.getTime() < base.getTime() - 60 * 86400000) d.setFullYear(d.getFullYear() + 1);
    add(m.index, d);
  }
  hits.sort((a, b) => a.idx - b.idx);
  let fromMs = 0, untilMs = 0;
  for (const h of hits) {
    const before = low.slice(Math.max(0, h.idx - 14), h.idx);
    if (/\b(until|till|til|through|thru|to)\s+(?:next\s+|this\s+|the\s+)?$/.test(before) && fromMs) { if (!untilMs) untilMs = h.ms; }
    else if (!fromMs) fromMs = h.ms;
  }
  if (untilMs && untilMs < fromMs) untilMs = 0;
  return { fromMs, untilMs };
}
// How much a message reads like a client instruction (CNOTE_MIN_SCORE and up is
// kept). Its shape counts most - a pasted client message, everyone or several
// people tagged, a date - plus words that ask for something to start, stop or
// change. The AI (in the pages) then drops the ones that aren't.
function cnoteScore(raw, postedMs) {
  const t = String(raw || "");
  const low = cnotePlain(t).toLowerCase();
  let s = 0;
  if (/client(?:'s)?\s+(?:message|said|says|wrote|email|request|update|feedback)|(?:message|email|note)\s+from\s+(?:the\s+)?client|from the client|^\s*(?:>|&gt;)/im.test(t)) s += 3;
  if (/<!(channel|here|everyone)/.test(t)) s += 2;
  s += Math.min(2, (t.match(/<@[UW][A-Z0-9]+/g) || []).length);
  if (cnoteDates(t, postedMs).fromMs) s += 2;
  const words = low.match(/\b(hold off|on hold|hold|pause\w*|stop\w*|don'?t|do not|no (?:more )?changes|freeze|until further notice|focus\w* on|priorit\w*|instead|deadline|launch\w*|go(?:ing)? live|migrat\w*|redesign\w*|rebuild\w*|new (?:website|site|developer|agency|host\w*|domain)|cancel\w*|postpone\w*|urgent\w*|asap|must|approv\w*|access|budget)\b/g) || [];
  s += Math.min(3, new Set(words).size);
  if (low.length < 60) s -= 3;
  return s;
}
const cnoteId = (cid, ts) => String(cid) + "-" + String(ts).replace(/[^0-9]/g, "");
// What a notice says in a line (the notification, the banner): the AI's summary,
// else the client's own words - the part after "Client message:" when the
// message quotes one - without the @tags, the greeting and Slack's *bold*.
function cnoteBrief(n) {
  if (n && n.summary) return String(n.summary);
  let t = String((n && n.text) || "");
  const m = t.match(/client(?:'s)?\s+(?:message|email|said|says|wrote|request)\s*\**\s*:\s*\**([\s\S]+)/i);
  if (m) t = m[1];
  return t.replace(/@(channel|here|everyone|someone)\b/g, "").replace(/[*_~]/g, "").replace(/^\s*(hi|hello|hey|dear)\b[^\n]*\n/i, "").replace(/\s+/g, " ").trim();
}
// Is this client one I have open tasks for (assigned to me)? Only then a notice
// pops up for me. null when ClickUp isn't connected.
const cnoteKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
async function cnoteMyClientKeys() {
  const tasks = await cnoteTasks().catch(() => null);
  if (!tasks) return null;
  const keys = new Set();
  for (const t of tasks) for (const c of [t.client, t.container && t.container.listName]) if (c) keys.add(cnoteKey(c));
  return [...keys];
}
// My open tasks for the notices (who gets one, the card's task list): one copy
// kept 15 minutes in session storage (cleared when Chrome closes), so opening the
// popup again and again doesn't ask ClickUp each time.
const CNOTE_TASKS_MS = 15 * 60000;
async function cnoteTasks(force) {
  const area = chrome.storage.session || chrome.storage.local;
  const { cnoteTasksCache: c } = await area.get("cnoteTasksCache").catch(() => ({}));
  if (!force && c && Array.isArray(c.tasks) && Date.now() - (Number(c.at) || 0) < CNOTE_TASKS_MS) return c.tasks;
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return null;
  const r = await getOpenTasks(cfg, false).catch(() => null);
  if (!r || !r.ok || !r.data) return c && Array.isArray(c.tasks) ? c.tasks : null;
  const tasks = (r.data.tasks || []).map((t) => ({ id: t.id, name: t.name, url: t.url, dueDateMs: t.dueDateMs, client: t.client, container: t.container ? { listName: t.container.listName } : null, done: false }));
  await area.set({ cnoteTasksCache: { at: Date.now(), tasks } }).catch(() => {});
  return tasks;
}
function cnoteIsMine(client, keys) {
  const k = cnoteKey(client);
  return !!keys && k.length >= 3 && keys.some((x) => x === k || (x.length >= 4 && k.length >= 4 && (x.startsWith(k) || k.startsWith(x))));
}
// Slack people's names for the @tags (asked once each, kept).
async function cnoteNames(ids, s) {
  const { slackUserNames } = await chrome.storage.local.get("slackUserNames");
  const names = { ...(slackUserNames || {}) };
  let asked = 0;
  for (const id of ids) {
    if (names[id] || asked >= 15) continue;
    asked++;
    const r = await slackApi("users.info", { user: id }, s).catch(() => null);
    const u = r && r.ok && r.user;
    if (u) names[id] = String((u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name || u.name || "").slice(0, 60) || "someone";
  }
  if (asked) await chrome.storage.local.set({ slackUserNames: names });
  return names;
}
function cnoteFromMessage(m, cid, client, s) {
  if (!m || !m.ts || m.bot_id || (m.subtype && m.subtype !== "thread_broadcast")) return null;
  const att = (Array.isArray(m.attachments) ? m.attachments : []).filter((a) => a && (!a.from_url || a.is_msg_unfurl || a.is_share)).map((a) => [a.pretext, a.title, a.text].filter(Boolean).join("\n"));
  const raw = [m.text || ""].concat(att).join("\n").trim();
  const posted = Math.round(Number(m.ts) * 1000);
  const score = cnoteScore(raw, posted);
  if (score < CNOTE_MIN_SCORE) return null;
  const d = cnoteDates(raw, posted);
  return {
    id: cnoteId(cid, m.ts), client: String(client).slice(0, 120), channel: cid, ts: String(m.ts), at: posted,
    raw, text: cnotePlain(raw).slice(0, 1500), permalink: "https://" + (s.domain || "slack.com") + "/archives/" + cid + "/p" + String(m.ts).replace(".", ""),
    fromMs: d.fromMs, untilMs: d.untilMs, score, kind: "", summary: "", important: null, onsite: [], ai: false, src: "slack",
  };
}
// Merge notices into storage (newest first, kept CNOTE_KEEP_MS). A copy with the
// AI's reading wins over one without; the dates the AI read win over the guess.
async function cnoteMerge(items) {
  const g = await chrome.storage.local.get("clientNotices");
  const by = new Map(((g.clientNotices && g.clientNotices.list) || []).map((n) => [n.id, n]));
  const fresh = [];
  for (const n of items || []) {
    if (!n || !n.id || !n.client) continue;
    const had = by.get(n.id);
    if (!had) { by.set(n.id, n); fresh.push(n); continue; }
    if (n.ai && !had.ai) by.set(n.id, { ...had, ...n });
    else if (n.ai && had.ai && Number(n.aiAt || 0) > Number(had.aiAt || 0)) by.set(n.id, { ...had, ...n });
  }
  const cut = Date.now() - CNOTE_KEEP_MS;
  const list = [...by.values()].filter((n) => Number(n.at) > cut || Number(n.untilMs || n.fromMs) > Date.now()).sort((a, b) => b.at - a.at).slice(0, CNOTE_MAX);
  await chrome.storage.local.set({ clientNotices: { at: Date.now(), list } });
  return fresh.filter((n) => list.some((x) => x.id === n.id));
}
async function cnoteAnnounce(fresh) {
  if (!fresh.length) return;
  const { cnoteSeen } = await chrome.storage.local.get("cnoteSeen");
  const seen = { ...(cnoteSeen || {}) };
  const mine = await cnoteMyClientKeys().catch(() => null); // only clients I have open tasks for
  for (const n of fresh) {
    if (seen[n.id] || n.important === false) continue;
    seen[n.id] = Date.now();
    if (!cnoteIsMine(n.client, mine)) continue;
    if (Date.now() - Number(n.at) > 2 * 86400000) continue; // an old message found on the first look: on the card, no pop-up
    const when = n.fromMs ? " (from " + new Date(n.fromMs).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + ")" : "";
    await notify("cnote-" + n.id, "⚠️ " + n.client + ": client notice" + when, cnoteBrief(n).slice(0, 240), undefined, chrome.runtime.getURL("options.html#dashboard")).catch(() => {});
  }
  for (const k of Object.keys(seen)) if (Date.now() - seen[k] > CNOTE_KEEP_MS) delete seen[k];
  await chrome.storage.local.set({ cnoteSeen: seen });
}
// Shared with the team (hub ClientNotes): what was found, and the AI's reading.
async function cnoteShare(list) {
  if (!list.length || !(await hubUrl())) return;
  const pick = (n) => ({ id: n.id, client: n.client, channel: n.channel, at: n.at, text: n.text, permalink: n.permalink, fromMs: n.fromMs || 0, untilMs: n.untilMs || 0, kind: n.kind || "", summary: n.summary || "", important: n.important == null ? "" : n.important ? "1" : "0", onsite: (n.onsite || []).join(","), ai: n.ai ? (n.aiAt || Date.now()) : 0 });
  await hubCall("cnotePost", { notes: JSON.stringify(list.slice(0, 10).map(pick)) }).catch(() => null);
}
async function cnoteFromHub(rows) {
  const items = (Array.isArray(rows) ? rows : []).map((r) => ({
    id: String(r.id || ""), client: String(r.client || ""), channel: String(r.channel || ""), ts: "", at: Number(r.at) || 0, text: String(r.text || ""), permalink: /^https:\/\/[a-z0-9.-]+\.slack\.com\//.test(String(r.permalink || "")) ? String(r.permalink) : "",
    fromMs: Number(r.fromMs) || 0, untilMs: Number(r.untilMs) || 0, kind: String(r.kind || ""), summary: String(r.summary || ""), important: r.important === "1" || r.important === 1 || r.important === true ? true : r.important === "0" || r.important === 0 || r.important === false ? false : null,
    onsite: String(r.onsite || "").split(",").filter(Boolean), ai: !!Number(r.ai), aiAt: Number(r.ai) || 0, src: "hub", by: String(r.byName || ""),
  }));
  await cnoteAnnounce(await cnoteMerge(items));
}
// The 20-minute Slack check, messages half: new messages in each matched channel.
async function cnotePollChannels(ids, map, s) {
  const { cnoteSince } = await chrome.storage.local.get("cnoteSince");
  const since = { ...(cnoteSince || {}) };
  const found = [];
  let authErr = false;
  for (const cid of ids.slice(0, 60)) {
    const oldest = since[cid] || String(Math.floor((Date.now() - CNOTE_FIRST_MS) / 1000));
    if (found.length || cid !== ids[0]) await new Promise((x) => setTimeout(x, 300));
    const r = await slackApi("conversations.history", { channel: cid, oldest, limit: "100" }, s).catch(() => null);
    if (!r || !r.ok) { if (r && SLACK_AUTH_ERR.test(r.error || "")) { authErr = true; break; } continue; }
    let msgs = r.messages || [];
    if (r.has_more && r.response_metadata && r.response_metadata.next_cursor) {
      const r2 = await slackApi("conversations.history", { channel: cid, oldest, limit: "100", cursor: r.response_metadata.next_cursor }, s).catch(() => null);
      if (r2 && r2.ok) msgs = msgs.concat(r2.messages || []);
    }
    let newest = oldest;
    for (const m of msgs) {
      if (Number(m.ts) > Number(newest)) newest = String(m.ts);
      const n = cnoteFromMessage(m, cid, map[cid].client, s);
      if (n) found.push(n);
    }
    since[cid] = newest;
  }
  await chrome.storage.local.set({ cnoteSince: since });
  if (found.length) {
    const ids = [...new Set(found.flatMap((n) => (String(n.raw).match(/<@([UW][A-Z0-9]+)/g) || []).map((x) => x.slice(2))))];
    const names = ids.length ? await cnoteNames(ids, s).catch(() => ({})) : {};
    for (const n of found) { n.text = cnotePlain(n.raw, names).slice(0, 1500); delete n.raw; }
    const fresh = await cnoteMerge(found);
    await cnoteAnnounce(fresh);
    await cnoteShare(fresh);
  }
  return { authErr, found: found.length };
}
async function hubPollClientNotes() {
  const r = await hubCall("cnotes", {}).catch(() => null);
  if (r && r.ok && Array.isArray(r.notes)) await cnoteFromHub(r.notes);
}

// ---------- PHP version from WordPress itself (Site monitor › PHP2Shell) ----------
// Most hosts strip the PHP version from their replies, so the header check says
// "hidden". WordPress always knows it (Tools › Site Health › Info › Server): read
// that page with the WordPress sign-in already in Chrome - no password is ever
// typed. One site at a time with a pause, and only when someone presses the
// button. Not signed in to that site: says so.
const WP_PHP_PAUSE_MS = 2500;
let wpPhpRunning = false;
function wpPhpFromHtml(html) {
  const h = String(html || "");
  const m = h.match(/PHP version\s*<\/t[dh]>\s*<td[^>]*>\s*(\d+\.\d+(?:\.\d+)?)/i) || h.match(/php_version:\s*(\d+\.\d+(?:\.\d+)?)/i) || h.match(/<td[^>]*>\s*PHP[^<]{0,40}<\/td>\s*<td[^>]*>\s*(\d+\.\d+\.\d+)/i);
  return m ? m[1] : "";
}
// What a Site Health answer says: the version, or why there isn't one.
function wpPhpJudge(final, status, html) {
  if (/wp-login\.php|\/login\b|reauth=1/i.test(final)) return { ok: false, reason: "signin", error: "Not signed in to this site's WordPress in Chrome" };
  if (status === 404) return { ok: false, reason: "notwp", error: "No WordPress admin found (not a WordPress site?)" };
  if (status === 403 || status === 401) return { ok: false, reason: "blocked", error: "The site's security turned the request away (HTTP " + status + ")" };
  if (status >= 400) return { ok: false, error: "The site answered " + status };
  const php = wpPhpFromHtml(html);
  if (php) return { ok: true, php };
  if (/site-health/.test(final)) return { ok: false, reason: "noread", error: "Site Health opened but didn't show the PHP version (your role may not see it)" };
  return { ok: false, reason: "notwp", error: "No WordPress Site Health page" };
}
async function wpPhpReadOne(url) {
  let base;
  try { const u = new URL(url); base = u.origin; } catch (e) { return { ok: false, error: "bad address" }; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  let out;
  try {
    const res = await fetch(base + "/wp-admin/site-health.php?tab=debug", { credentials: "include", redirect: "follow", cache: "no-store", signal: ctl.signal });
    out = wpPhpJudge(String(res.url || ""), res.status, res.ok ? await res.text() : "");
  } catch (e) {
    out = { ok: false, error: e && e.name === "AbortError" ? "No answer within 30s" : "Couldn't reach it" };
  } finally { clearTimeout(timer); }
  // Turned away (a security plugin or the host's firewall can refuse a request
  // that isn't from a page) and a tab of that site is open: ask from inside it,
  // the way the page itself would.
  if (!out.ok && out.reason !== "notwp") {
    const inTab = await wpPhpReadInTab(base).catch(() => null);
    if (inTab) return inTab.ok || inTab.reason === "signin" ? inTab : out;
  }
  return out;
}
async function wpPhpReadInTab(base) {
  const host = new URL(base).hostname.replace(/^www\./, "");
  const tabs = await chrome.tabs.query({ url: ["https://" + host + "/*", "https://www." + host + "/*"] }).catch(() => []);
  const tab = tabs.find((t) => t && t.id != null && !t.discarded);
  if (!tab) return null;
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
    try { const x = await fetch("/wp-admin/site-health.php?tab=debug", { credentials: "include", cache: "no-store" }); return { url: x.url, status: x.status, html: x.ok ? (await x.text()).slice(0, 3000000) : "" }; } catch (e) { return null; }
  } }).catch(() => [null]);
  const v = r && r.result;
  return v ? wpPhpJudge(String(v.url || ""), Number(v.status) || 0, String(v.html || "")) : null;
}
async function wpPhpRead(urls, onEach) {
  if (wpPhpRunning) return { ok: false, error: "Already reading - wait for it to finish." };
  wpPhpRunning = true;
  const out = {};
  try {
    const list = [...new Set((urls || []).map(String).filter((u) => /^https?:\/\//.test(u)))].slice(0, 80);
    for (let i = 0; i < list.length; i++) {
      if (i) await new Promise((r) => setTimeout(r, WP_PHP_PAUSE_MS));
      const r = await wpPhpReadOne(list[i]);
      out[list[i]] = r;
      const sp = (await chrome.storage.local.get("sitePhp")).sitePhp || {};
      sp[list[i]] = r.ok ? { php: r.php, src: "wp", at: Date.now() } : { ...(sp[list[i]] || { php: "" }), wpErr: r.error, wpReason: r.reason || "", wpAt: Date.now() };
      await chrome.storage.local.set({ sitePhp: sp, wpPhpProgress: { done: i + 1, total: list.length, at: Date.now() } });
      if (onEach) await Promise.resolve(onEach(list[i], r)).catch(() => {});
      if (r.error === "Couldn't reach it" || /within 30s/.test(r.error || "")) await new Promise((x) => setTimeout(x, WP_PHP_PAUSE_MS)); // a slow site: an extra breather
    }
  } finally {
    wpPhpRunning = false;
    await chrome.storage.local.set({ wpPhpProgress: null });
  }
  return { ok: true, results: out };
}
// Read from WordPress through another Chrome profile (the taskbar app as go-between).
// Often the clients' WordPress sign-ins live in a different Chrome profile from
// this extension. A second copy of the extension in that profile, ticked as the
// helper (storage wpHelper), knocks on the taskbar app once a minute; when this
// copy asks (wpPhpStart), the helper takes the list, reads each site's Site
// Health with its own sign-ins and hands back only the PHP versions, which this
// copy collects (wpRelayCollect). Nothing but site addresses and version numbers
// passes through the app, on this computer only; no sign-in ever leaves a profile.
// storage wpPhpRelay { id, at, state: waiting|done|gone|timeout, total, got, takenAt }
const WP_HELPER_FRESH_MS = 5 * 60000;
async function wpRelayTick() {
  const g = await chrome.storage.local.get(["wpHelper", "wpPhpRelay"]);
  if (g.wpHelper) await wpHelperTake();
  if (g.wpPhpRelay && g.wpPhpRelay.state === "waiting") await wpRelayCollect();
}
async function wpHelperTake() {
  if (wpPhpRunning) return;
  const r = await deskFiles({ op: "phpTake", install: await installId() }, 3000);
  if (!r || !r.ok || !r.job) return;
  const job = r.job;
  await wpPhpRead(job.urls, (url, res) => deskFiles({ op: "phpDone", install: "", id: job.id, results: { [url]: res } }, 5000));
}
async function wpRelayCollect() {
  const { wpPhpRelay: rl } = await chrome.storage.local.get("wpPhpRelay");
  if (!rl || rl.state !== "waiting") return rl || null;
  const r = await deskFiles({ op: "phpResults", id: rl.id }, 3000);
  const next = { ...rl, checkedAt: Date.now(), note: "" };
  if (!r) next.note = "The taskbar app isn't answering - is it running?";
  else if (r.gone) next.state = "gone";
  else {
    const res = r.results || {};
    if (Object.keys(res).length) {
      const sp = (await chrome.storage.local.get("sitePhp")).sitePhp || {};
      for (const [u, x] of Object.entries(res)) sp[u] = x.ok ? { php: x.php, src: "wp", at: Date.now() } : { ...(sp[u] || { php: "" }), wpErr: x.error, wpReason: x.reason || "", wpAt: Date.now() };
      await chrome.storage.local.set({ sitePhp: sp });
    }
    next.got = Object.keys(res).length; next.total = Number(r.total) || rl.total; next.takenAt = Number(r.takenAt) || 0;
    if (next.got >= next.total) next.state = "done";
  }
  if (next.state === "waiting" && Date.now() - rl.at > 45 * 60000) next.state = "timeout";
  if (next.state !== rl.state || next.got !== rl.got || next.note !== (rl.note || "") || next.takenAt !== rl.takenAt) await chrome.storage.local.set({ wpPhpRelay: next });
  return next;
}
// The button: through the helper profile when one checked in lately, otherwise
// (only when asked: local) with this profile's own WordPress sign-ins.
async function wpPhpStart(urls, local) {
  const list = [...new Set((urls || []).map(String).filter((u) => /^https?:\/\//.test(u)))].slice(0, 80);
  if (!list.length) return { ok: false, error: "No sites to read." };
  if (local) {
    if (wpPhpRunning) return { ok: false, error: "Already reading - wait for it to finish." };
    wpPhpRead(list).catch(() => {});
    return { ok: true, relay: false };
  }
  const me = await installId();
  const st = await deskFiles({ op: "phpStatus", install: me }, 3000);
  if (!st) return { ok: false, why: "noapp" };
  if (!st.ok) return { ok: false, why: "oldapp" };
  if (st.helperIsYou) return { ok: false, why: "selfhelper" };
  if (!(Date.now() - (Number(st.helperAt) || 0) < WP_HELPER_FRESH_MS)) return { ok: false, why: "nohelper" };
  const j = await deskFiles({ op: "phpJob", install: me, urls: list }, 5000);
  if (!j || !j.ok) return { ok: false, why: "oldapp", error: j && j.error };
  await chrome.storage.local.set({ wpPhpRelay: { id: j.id, at: Date.now(), state: "waiting", total: list.length, got: 0, takenAt: 0 } });
  return { ok: true, relay: true };
}
// Every 20 minutes (and on Refresh): the LIST of files in the matched channels -
// names, dates, sizes, links; nothing is downloaded. A file is fetched only when
// a brief needs it (SLACK_TASK_LOOKUP / SLACK_FILE_GET: Copy for AI, Explain,
// Plan with AI), its text kept in a small cache in the page (task-panel.js), and
// the file itself never stored - so no client folder fills up with Slack files.
// storage slackIndex { [channelId]: { at, since, files: [{ id, name, size, created, url, permalink, user, img }] } }
const SLACK_IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
const SLACK_INDEX_MAX = 400; // per channel, newest first
let slackPolling = false;
async function slackPoll(force) {
  if (slackPolling) return { ok: false, error: "already checking" };
  const g = await chrome.storage.local.get(["slackSession", "slackChannels", "slackPoll", "slackIndex"]);
  const s = g.slackSession, map = g.slackChannels || {}, poll = g.slackPoll || {};
  const ids = Object.keys(map).filter((k) => map[k] && map[k].client);
  if (!s || !ids.length) return { ok: false, error: !s ? "Connect Slack first." : "Match at least one channel to a client." };
  if (!force && (poll.authErr || Date.now() - (Number(poll.at) || 0) < SLACK_POLL_MS)) return { ok: true, skipped: true };
  slackPolling = true;
  const index = { ...(g.slackIndex || {}) };
  for (const k of Object.keys(index)) if (!map[k]) delete index[k]; // channels no longer matched
  let err = "", authErr = false;
  try {
    for (const cid of ids.slice(0, 60)) {
      const cur = index[cid] || { files: [] };
      const from = Number(cur.since) || 0; // 0: the first look - all of it
      const known = new Map((cur.files || []).map((f) => [f.id, f]));
      let newest = from, page = 1, pages = 1, ok = true;
      do {
        const r = await slackApi("files.list", { channel: cid, count: "100", page: String(page), ...(from ? { ts_from: String(Math.floor(from / 1000)) } : {}) }, s).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        if (!r || !r.ok) { err = (r && r.error) || "no answer"; if (SLACK_AUTH_ERR.test(err)) authErr = true; ok = false; break; }
        pages = Math.min(20, Number(r.paging && r.paging.pages) || 1);
        for (const f of r.files || []) {
          if (!f || !f.id) continue;
          newest = Math.max(newest, (Number(f.created) || 0) * 1000 + 1000);
          const name = String(f.name || f.title || "file");
          const img = SLACK_IMG_RE.test(name);
          if (!SLACK_DOC_RE.test(name) && !img) continue;
          if (f.is_external || f.mode === "external" || f.mode === "tombstone" || f.is_hidden_by_limit) continue; // nothing to download there
          known.set(f.id, { id: f.id, name: name.slice(0, 160), size: Number(f.size) || 0, created: (Number(f.created) || 0) * 1000, url: f.url_private_download || f.url_private || "", permalink: f.permalink || "", user: String(f.user || ""), img });
        }
        page++;
      } while (page <= pages);
      if (authErr) break;
      index[cid] = { at: Date.now(), since: ok ? newest : from, files: [...known.values()].sort((a, b) => b.created - a.created).slice(0, SLACK_INDEX_MAX) };
    }
    // The messages half: client instructions (Client notices).
    if (!authErr) { const cr = await cnotePollChannels(ids, map, s).catch(() => null); if (cr && cr.authErr) authErr = true; }
  } finally { slackPolling = false; }
  const count = Object.values(index).reduce((n, c) => n + ((c && c.files) || []).length, 0);
  await chrome.storage.local.set({ slackIndex: index, slackPoll: { at: Date.now(), err: authErr ? "Slack signed out - open Slack in Chrome and press Reconnect" : err, authErr, listed: count } });
  if (authErr && !poll.authErr) await notify("slack-auth", "Slack needs reconnecting", "Slack signed this browser out, so the briefs can't look in your Slack channels. Open Slack in Chrome, then Clients › Slack › Reconnect.", undefined, chrome.runtime.getURL("options.html#files")).catch(() => {});
  return { ok: !authErr, listed: count, error: authErr ? "Slack signed out - open Slack in Chrome and press Reconnect" : err };
}
// What Slack has for one task: its client's channel(s), the files that fit it
// (the task's code or words in the name; the newest audits) and the messages
// that mention it (Slack's search: the code, else its key words). Nothing is
// downloaded here - SLACK_FILE_GET fetches the ones the brief asks for.
const SLACK_AUDITISH = /audit|technical|report|finding|analysis|strategy|plan|brief|onboard/i;
function slackTaskWords(name) {
  const stop = new Set(["with", "from", "that", "this", "your", "page", "pages", "site", "website", "make", "only", "then", "never", "add", "fix", "the", "and", "for", "into", "each", "all", "new", "update", "check", "remove", "change", "task", "tasks", "client"]);
  return [...new Set(String(name || "").toLowerCase().replace(/[^a-z0-9\s-]+/g, " ").split(/[\s-]+/).filter((w) => w.length >= 4 && !stop.has(w) && !SLACK_GENERIC.has(w)))].slice(0, 8);
}
function slackPickFiles(files, taskName, max, hasAudit) {
  const code = (String(taskName || "").match(/\b([A-Z]{2,6}-\d{1,4})/) || [])[1] || "";
  const words = slackTaskWords(taskName);
  const scored = (files || []).filter((f) => !f.img).map((f) => {
    const n = f.name.toLowerCase();
    let s = 0;
    if (code && n.includes(code.toLowerCase())) s += 100;
    for (const w of words) if (n.includes(w)) s += 10;
    if (SLACK_AUDITISH.test(f.name)) s += 15;
    return { f, s };
  }).filter((x) => x.s > (hasAudit ? 15 : 0)).sort((a, b) => b.s - a.s || b.f.created - a.f.created);
  return scored.slice(0, max || 3).map((x) => ({ ...x.f, why: x.s >= 100 ? "names the task" : x.s > 15 ? "matches the task" : "an audit / report" }));
}
// Not a client (Daily Tracking, the Extra task): never looked up in Slack.
const SLACK_NOT_CLIENT = /^(daily ?tracking|extra ?tasks?)$/i;
// A file from Slack's search (or shared with a message) in the index's shape, so
// it can be ranked, fetched and cited the same way. null: not one we can read.
function slackFileEntry(f, cids, map) {
  if (!f || !f.id || f.is_external || f.mode === "external" || f.mode === "tombstone" || f.is_hidden_by_limit) return null;
  const name = String(f.name || f.title || "file");
  const img = SLACK_IMG_RE.test(name);
  if (!img && !SLACK_DOC_RE.test(name)) return null;
  const cid = (Array.isArray(f.channels) ? f.channels : []).concat(Array.isArray(f.groups) ? f.groups : []).find((c) => map[c]) || cids[0];
  return { id: f.id, name: name.slice(0, 160), size: Number(f.size) || 0, created: (Number(f.created || f.timestamp) || 0) * 1000, url: f.url_private_download || f.url_private || "", permalink: f.permalink || "", user: String(f.user || ""), img, channel: (map[cid] && map[cid].name) || "", cid };
}
// Files found by a search this session (not in the channel's file list yet), so
// SLACK_FILE_GET can fetch them. storage.session: gone when Chrome closes.
async function slackRememberFound(list) {
  if (!list.length || !chrome.storage.session) return;
  const { slackFound } = await chrome.storage.session.get("slackFound").catch(() => ({}));
  const m = { ...(slackFound || {}) };
  for (const f of list) m[f.id] = f;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k];
  await chrome.storage.session.set({ slackFound: m }).catch(() => {});
}
async function slackTaskLookup(client, taskName, opts) {
  opts = opts || {};
  if (SLACK_NOT_CLIENT.test(String(client || "").trim())) return { ok: false, reason: "not-a-client" };
  const g = await chrome.storage.local.get(["slackSession", "slackChannels", "slackIndex"]);
  const s = g.slackSession, map = g.slackChannels || {};
  if (!s) return { ok: false, reason: "not-connected" };
  const ck = sKey(client);
  const cids = Object.keys(map).filter((k) => map[k] && ck && sKey(map[k].client) === ck);
  if (!cids.length) return { ok: false, reason: "no-channel" };
  let idx = g.slackIndex || {};
  if (cids.some((c) => !idx[c])) { await slackPoll(true).catch(() => {}); idx = (await chrome.storage.local.get("slackIndex")).slackIndex || {}; }
  const all = [].concat(...cids.map((c) => ((idx[c] && idx[c].files) || []).map((f) => ({ ...f, channel: map[c].name || "", cid: c }))));
  // An audit-like file only for the name's sake: when the client has no audit yet.
  const files = slackPickFiles(all, taskName, opts.max || 3, !!opts.hasAudit);
  let messages = [], images = [];
  if (!opts.noSearch) {
    const code = (String(taskName || "").match(/\b([A-Z]{2,6}-\d{1,4})/) || [])[1] || "";
    const q = code || slackTaskWords(taskName).slice(0, 3).join(" ");
    if (q) {
      const where = cids.map((c) => "in:#" + (map[c].name || "")).filter((x) => x.length > 4).join(" ");
      // The messages about the task, and Slack's own file search (it matches a
      // document's title and text, not only its file name) - side by side.
      const [r, rf] = await Promise.all([
        slackApi("search.messages", { query: q + " " + where, count: "8", sort: "timestamp" }, s).catch(() => null),
        slackApi("search.files", { query: q + " " + where, count: "8", sort: "timestamp" }, s).catch(() => null),
      ]);
      // The files shared WITH those messages come first (that's usually exactly
      // what the task needs), then the search's; each one only once.
      const shared = [].concat(...((r && r.ok && r.messages && r.messages.matches) || []).map((m) => (Array.isArray(m.files) ? m.files : [])));
      const searched = (rf && rf.ok && rf.files && rf.files.matches) || [];
      const have = new Set(files.map((f) => f.id));
      const more = [];
      for (const raw of shared.concat(searched)) {
        const e = slackFileEntry(raw, cids, map);
        if (!e || have.has(e.id)) continue;
        have.add(e.id);
        if (e.img) { if (images.length < 6) images.push({ name: e.name, link: e.permalink, at: e.created }); }
        else if (more.length < 3) more.push({ ...e, why: shared.includes(raw) ? "shared with a message about the task" : "Slack's search found it" });
      }
      files.push(...more);
      await slackRememberFound(more).catch(() => {});
      messages = ((r && r.ok && r.messages && r.messages.matches) || []).map((m) => ({ text: String(m.text || "").slice(0, 600), who: String(m.username || (m.user_profile && m.user_profile.display_name) || ""), at: Math.round(Number(m.ts) * 1000) || 0, link: m.permalink || "", channel: (m.channel && m.channel.name) || "" })).filter((m) => m.text);
    }
  }
  return { ok: true, channels: cids.map((c) => map[c].name || ""), files, messages, images, known: all.filter((f) => !f.img).length };
}
// The copies an earlier version saved from Slack into client folders (when it
// pulled every channel): named by it ("Slack screenshot 2026-10-13 1956 AB12C.png",
// "<name> (2026-09-21).pdf") and remembered when saved (slackHashes). Listed for
// Clients › Slack › Move to Recycle Bin, then moved there by the taskbar app
// (0.4.1+: op trashFiles - recoverable, only directly in that client's folder).
const SLACK_SHOT_NAME = /^Slack screenshot \d{4}-\d\d-\d\d \d{4} [A-Za-z0-9]{1,5}\.[a-z0-9]{2,5}$/i;
const SLACK_DATED_NAME = /^.+ \(\d{4}-\d\d-\d\d\)\.[a-z0-9]{1,6}$/i;
async function slackCopies() {
  const g = await chrome.storage.local.get(["slackHashes", "slackChannels"]);
  const hashes = g.slackHashes || {};
  const names = {}; // client key -> display name
  for (const v of Object.values(g.slackChannels || {})) if (v && v.client) names[sKey(v.client)] = v.client;
  const out = [];
  let desk = false;
  for (const [ck, rec] of Object.entries(hashes)) {
    const remembered = new Set(Object.values(rec || {}).map((n) => String(n)));
    const client = names[ck] || ck;
    const ls = await deskFiles({ op: "list", client }, 10000);
    if (!ls || !ls.ok) continue;
    desk = true;
    const hits = (ls.files || []).filter((f) => f && f.rel && !/[\\/]/.test(f.rel) && (SLACK_SHOT_NAME.test(f.rel) || (SLACK_DATED_NAME.test(f.rel) && remembered.has(f.rel))));
    if (hits.length) out.push({ client, names: hits.map((f) => ({ name: f.rel, size: Number(f.size) || 0 })) });
  }
  return { ok: true, desk, clients: out, total: out.reduce((n, c) => n + c.names.length, 0), bytes: out.reduce((n, c) => n + c.names.reduce((m, f) => m + f.size, 0), 0) };
}
async function slackTrashCopies(list) {
  let moved = 0, failed = 0, needUpdate = false;
  const g = await chrome.storage.local.get("slackHashes");
  const hashes = { ...(g.slackHashes || {}) };
  for (const c of Array.isArray(list) ? list : []) {
    const want = (c.names || []).map((x) => String(x)).filter((n) => SLACK_SHOT_NAME.test(n) || SLACK_DATED_NAME.test(n));
    if (!want.length) continue;
    const r = await deskFiles({ op: "trashFiles", client: c.client, names: want }, 120000);
    if (!r || !r.ok) { if (r && /update the ClickUp Tracker/i.test(r.error || "")) needUpdate = true; failed += want.length; continue; }
    moved += (r.moved || []).length; failed += (r.failed || []).length;
    // Gone: not "already there" for a later Slack download any more.
    const ck = sKey(c.client), gone = new Set((r.moved || []).concat(r.missing || []));
    if (hashes[ck]) hashes[ck] = Object.fromEntries(Object.entries(hashes[ck]).filter(([, n]) => !gone.has(n)));
  }
  await chrome.storage.local.set({ slackHashes: hashes });
  return { ok: !needUpdate, moved, failed, needUpdate, error: needUpdate ? "Update the ClickUp Tracker app (0.4.1 or later) first - it does the moving." : "" };
}
async function slackFileGet(id) {
  const g = await chrome.storage.local.get(["slackSession", "slackIndex"]);
  const s = g.slackSession;
  if (!s) return { ok: false, error: "Slack isn't connected." };
  let f = null;
  for (const c of Object.values(g.slackIndex || {})) { f = ((c && c.files) || []).find((x) => x.id === id); if (f) break; }
  if (!f && chrome.storage.session) { const { slackFound } = await chrome.storage.session.get("slackFound").catch(() => ({})); f = (slackFound || {})[id] || null; } // found by a search this session
  if (!f || !f.url) return { ok: false, error: "not in the list" };
  if (f.size > 12 * 1048576) return { ok: false, error: "over 12 MB" };
  const blob = await slackFetchFile(f.url, s);
  return { ok: true, name: f.name, type: blob.type || "", created: f.created, b64: abToB64(await blob.arrayBuffer()) };
}
chrome.downloads.onChanged.addListener((delta) => {
  if (delta && delta.state && delta.state.current === "complete") onSlackDownload(delta.id).catch(() => {});
});
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
    if (id.startsWith("auto-update-setup-")) {
      // Both open the update page: the setup version walks through the folder
      // step; the other has "Install" ready (and does the setup on the way).
      chrome.notifications.clear(id).catch(() => {});
      openUpdater(btn === 0);
    } else if (id.startsWith("update-available-")) {
      chrome.notifications.clear(id).catch(() => {});
      if (btn === 0) openUpdater();
      else {
        const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
        if (ui && ui.url) chrome.tabs.create({ url: ui.url }).catch(() => {});
        // Keep the Download button one click away after reading the notes.
        if (ui && ui.newer) setTimeout(() => showUpdateNotification(ui).catch(() => {}), 1500);
      }
    } else if (id.startsWith("away-")) {
      chrome.notifications.clear(id).catch(() => {});
      if (btn === 0) await removeAwayTime();
      else await chrome.storage.local.remove("cuAwayPending");
    } else if (id.startsWith("clickup-idle-")) {
      chrome.notifications.clear(id).catch(() => {});
      const { cuNudgeTask: t } = await chrome.storage.local.get("cuNudgeTask");
      if (t && t.id) await startTaskFromNudge(t.id);
    } else if (id.startsWith("cu-extradates-")) {
      chrome.notifications.clear(id).catch(() => {});
      const r = await fixExtraDates().catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
      if (r && r.ok && r.label) notify("cu-extradates-done-" + Date.now(), "Extra Task dates fixed", "It now runs " + r.label + ".");
    } else if (id.startsWith("cu-tidy-")) {
      // "needs tidying" summary: straight to the Insights tab that produced it.
      chrome.notifications.clear(id).catch(() => {});
      await openInsightsPage(tidyDrillsFromId(id));
    } else if (id === "update-downloaded" || (id === "update-pending" && btn === 0)) {
      chrome.runtime.reload(); // picks up the unzipped files
    } else if (id === "update-pending" && btn === 1) {
      const { updateDownload: d } = await chrome.storage.local.get("updateDownload");
      if (d && d.id != null) { try { chrome.downloads.show(d.id); } catch (e) {} }
    }
  })().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  runPendingMoves().catch(() => {}); // week-card moves left half done
  // No floating window survives a browser restart: a leftover "open" flag would
  // stop it opening by itself for the running timer.
  chrome.storage.local.set({ floatOpen: false }).catch(() => {});
  // Reminders that came due while Chrome was closed show now as "Missed".
  ensureDefaultReminders().catch(() => {}).then(() => fireDueReminders()).then(() => scheduleReminders()).catch(() => {});
  checkForUpdate().catch(() => {});
  checkAndMaybeRun().catch(() => {});
  updateBadge().catch(() => {});
  refreshClickup({ viaAlarm: true }).catch(() => {});
  autoSyncIfSignedIn();
  migrateAgentRouterQuotaTimes().then(() => scheduleAgentRouterAlarms()).catch(() => {});
  pollBalancesInBackground().catch(() => {});
  hubHello().catch(() => {});
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
    const en = /((?:\d{1,2}:\d{2}\s*(?:AM|PM|a\.m\.|p\.m\.)?[\s,]*(?:and|&|,|\/)?\s*)+)\s*(?:\(?\s*)Beijing/i.exec(s);
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
// "10:00" Beijing -> the same moment in this computer's local time, for notices.
function beijingToLocalLabel(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  if (!m) return "";
  // Beijing is UTC+8: build that instant today, then render it locally.
  const now = new Date();
  const utcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), Number(m[1]) - 8, Number(m[2]));
  return new Date(utcMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function beijingTimesLabel(times) {
  const local = (times || []).map(beijingToLocalLabel).filter(Boolean);
  const zone = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").split("/").pop().replace(/_/g, " ");
  return (times || []).join(" & ") + " Beijing" + (local.length ? " = " + local.join(" & ") + (zone ? " " + zone : " your time") : "");
}

// ---- Agent Router: what can be used right now (ar-status.js shows it) ----
// Agent Router's public model list (/api/pricing) says which models each account
// group may use: Claude can be listed yet open only to some groups (e.g. svip /
// test), and then Claude Code through Agent Router fails with "no usable models"
// for everyone else. Read with the notice at most every 30 minutes (a "Check
// now" forces it), kept as storage arStatus; a notification when Claude comes or
// goes, or a new notice is posted. A read that fails keeps the last answer.
const AR_STATUS_MIN_MS = 30 * 60 * 1000;
let arStatusInFlight = null;
// The English half of the notice (it comes in Chinese, then English), as plain text.
function arNoticeEnglish(md) {
  let s = String(md || "");
  const i = s.search(/important notice|^#+\s*notice/im);
  if (i >= 0) s = s.slice(i);
  return s.replace(/^#+\s*/gm, "").replace(/\*\*/g, "").replace(/^-{3,}\s*$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 2000);
}
function arStatusFrom(models, notice, group, prev) {
  const usable = models ? models.filter((m) => !m.groups.length || m.groups.includes(group)).map((m) => m.name) : (prev && prev.usable) || [];
  return {
    at: Date.now(), group,
    models: models ? models.map((m) => m.name) : (prev && prev.models) || [],
    usable,
    claude: usable.some((n) => /claude/i.test(n)),
    claudeOnly: models ? models.filter((m) => /claude/i.test(m.name) && !usable.includes(m.name)).map((m) => ({ name: m.name, groups: m.groups })) : (prev && prev.claudeOnly) || [],
    notice: notice ? arNoticeEnglish(notice) : (prev && prev.notice) || "",
    noticeSig: notice ? String(notice).length + ":" + String(notice).slice(0, 80) : (prev && prev.noticeSig) || "",
  };
}
function arReadStatus(opts = {}) {
  if (arStatusInFlight) return arStatusInFlight;
  arStatusInFlight = (async () => {
    const { arStatus: prev = null, arUserGroup = "" } = await chrome.storage.local.get(["arStatus", "arUserGroup"]);
    if (!opts.force && prev && Date.now() - (Number(prev.at) || 0) < AR_STATUS_MIN_MS) return prev;
    let models = null, notice = "";
    try {
      const r = await fetch("https://agentrouter.org/api/pricing");
      const j = r && r.ok ? await r.json().catch(() => null) : null;
      if (j && Array.isArray(j.data)) models = j.data.map((m) => ({ name: String((m && m.model_name) || ""), groups: Array.isArray(m && m.enable_groups) ? m.enable_groups.map(String) : [] })).filter((m) => m.name);
    } catch (e) {}
    try {
      const r = await fetch("https://agentrouter.org/api/notice", { credentials: "include" });
      const j = r && r.ok ? await r.json().catch(() => null) : null;
      const d = j && (j.data ?? j.notice ?? j.content);
      if (typeof d === "string") notice = d;
    } catch (e) {}
    if (!models && !notice) return prev;
    const st = arStatusFrom(models, notice, arUserGroup || "default", prev);
    await chrome.storage.local.set({ arStatus: st });
    // Told once: Claude gone (or not there on the first read) / back; else a new notice.
    const prevClaude = prev ? !!prev.claude : true;
    if (models && st.claude !== prevClaude) {
      await notify("ar-claude", st.claude ? "Agent Router: Claude is available again" : "Agent Router: no Claude for your account right now",
        st.claude ? "Claude models: " + st.usable.filter((n) => /claude/i.test(n)).join(", ") + "."
          : "Usable now: " + (st.usable.join(", ") || "none") + ". Claude Code through Agent Router won't work until Claude is offered again.", undefined, "https://agentrouter.org").catch(() => {});
    } else if (prev && st.noticeSig && st.noticeSig !== prev.noticeSig) {
      await notify("ar-notice", "Agent Router posted a new notice", st.notice.replace(/\s+/g, " ").slice(0, 220), undefined, "https://agentrouter.org").catch(() => {});
    }
    return st;
  })().catch(() => null).finally(() => { arStatusInFlight = null; });
  return arStatusInFlight;
}

function syncArScheduleFromPage(opts = {}) {
  arReadStatus().catch(() => {});
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
      "New batch times: " + beijingTimesLabel(times) + " (auto-synced)",
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

// How long after a release minute "a fresh batch just opened" is still true.
// Generous on purpose: the service worker can be asleep at the exact minute,
// Chrome throttles alarms, and Agent Router sometimes credits a few minutes
// late - the 5-minute balance poll then catches up inside this window. Short
// enough that a quota credit landing in the evening is nowhere near it.
const AR_BATCH_GRACE_MS = 45 * 60 * 1000;
// ...and a small lead, because an alarm that fires a few seconds EARLY would
// otherwise find only yesterday's release and stay silent for the whole day -
// a silent miss is worse than a toast one minute early.
const AR_BATCH_LEAD_MS = 2 * 60 * 1000;

// Is one of the scheduled batches open right now? times are Beijing "HH:MM"
// strings (settings.arQuotaTimes, auto-synced from Agent Router's own notice).
// nextBeijingTimeUTC returns the NEXT occurrence, so today's release is either
// that or that minus a day depending on which side of it we are - both are
// checked, and the window is open while the release is at most graceMs old (or
// AR_BATCH_LEAD_MS away). Pure, so dev-tools/t_ar_batch.js can drive any clock.
function arBatchWindow(times, nowMs = Date.now(), graceMs = AR_BATCH_GRACE_MS) {
  const list = Array.isArray(times) && times.length ? times : AR_QUOTA_DEFAULT_TIMES;
  const DAY = 24 * 60 * 60 * 1000;
  let best = null;
  for (const hhmm of list) {
    const next = nextBeijingTimeUTC(hhmm, nowMs);
    if (!next) continue; // an empty or malformed "(none)" row in Options
    for (const at of [next - DAY, next]) {
      const ageMs = nowMs - at;
      if (ageMs < -AR_BATCH_LEAD_MS || ageMs > graceMs) continue;
      if (!best || Math.abs(ageMs) < Math.abs(best.ageMs)) best = { open: true, at, hhmm, ageMs };
    }
  }
  return best || { open: false, at: 0, hhmm: "", ageMs: Infinity };
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
  // then emit the ONE notification if a new credit is waiting to be announced.
  // This is the path the notification is MEANT to come from - the alarm fires at
  // the release minute, so arBatchWindow is open and the claim is true.
  await pollBalancesInBackground().catch(() => {});
  await maybeNotifyQuotaCredit();
}

// Slim became the floating window's default size: copies still on Normal
// switch once (Compact, a deliberate choice, is kept). Later changes stay.
async function slimDefaultOnce() {
  const { floatSlimDefault } = await chrome.storage.local.get("floatSlimDefault");
  if (floatSlimDefault) return;
  const s = await getSettings();
  if (!s.floatSize || s.floatSize === "normal") await setSettings({ floatSize: "slim" });
  await chrome.storage.local.set({ floatSlimDefault: Date.now() });
}
chrome.runtime.onInstalled.addListener((details) => {
  slimDefaultOnce().catch(() => {});
  // A reload / update closes every floating window (its page went away) - and
  // the page doesn't always get to say so. Clear the flag, then float the
  // running timer again shortly (a reload is not "you closed it").
  chrome.storage.local.set({ floatOpen: false, floatAutoKey: "" }).catch(() => {});
  setTimeout(() => { getClickupState().then((st) => maybeAutoFloat(st)).catch(() => {}); }, 4000);
  // Alarms don't survive an update / reload: put the reminders' back.
  ensureDefaultReminders().catch(() => {}).then(() => fireDueReminders()).then(() => scheduleReminders()).catch(() => {});
  deskTryNotice().catch(() => {});
  // Brand-new install: offer one-click update setup while the folder is fresh in mind.
  if (details && details.reason === "install") openUpdater(true);
  // After a reload: confirm a downloaded update actually got installed, then
  // refresh update info (no "Update available" pop-up on a plain reload).
  confirmUpdateApplied().catch(() => {}).finally(() => checkForUpdate(true, false).catch(() => {}));
  ensurePeriodicAlarms();
  updateBadge().catch(() => {});
  autoSyncIfSignedIn();
  migrateAgentRouterQuotaTimes().then(() => scheduleAgentRouterAlarms()).catch(() => {});
  // After an update: tell the Team hub the new version now, not tomorrow.
  hubHello().catch(() => {});
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
  const syncS = await getSettings().catch(() => ({}));
  await ensureAlarm(CLICKUP_ALARM, { periodInMinutes: syncMinutes(syncS) });
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
// Reopen the page that pressed "Reload extension" / "Set version & reload".
// Only for a fresh request (the restart takes a second or two) and only once.
(async () => {
  try {
    const { reopenAfterReload: r } = await chrome.storage.local.get("reopenAfterReload");
    if (!r) return;
    await chrome.storage.local.remove("reopenAfterReload");
    // One page (Reload extension / Set version & reload / the update page): bring
    // it back in front, on the same section. Several pages (an automatic update
    // while the user was away): reopen them quietly in the background.
    const urls = Array.isArray(r.urls) ? r.urls : [r.url];
    const toFront = !Array.isArray(r.urls);
    if (Date.now() - (Number(r.at) || 0) < 60000) {
      let first = true;
      for (const u of urls.slice(0, 6)) {
        if (!u || !String(u).startsWith(chrome.runtime.getURL(""))) continue;
        const tab = await chrome.tabs.create({ url: u, active: toFront && first }).catch(() => null);
        if (toFront && first && tab && tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        first = false;
      }
    }
  } catch (e) {}
})();
// Agent Router's twice-daily Claude/GPT quota-batch reminders (converted from
// Beijing time to whatever moment that is for this user). These are absolute
// `when` alarms (not a countdown), so re-deriving them each wake is harmless.
scheduleAgentRouterAlarms().catch(() => {});
// End-of-day wrap-up (absolute "when" alarm, re-derived harmlessly on each wake)
// and away detection (idle/locked -> active).
scheduleWrapUpAlarm().catch(() => {});
applyIdleInterval().catch(() => {});
try { chrome.idle.onStateChanged.addListener((st) => { onIdleStateChanged(st).catch(() => {}); }); } catch (e) {}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === CHECK_ALARM) {
    checkForUpdate().catch(() => {}); // cheap: the update alarm already runs every minute
    checkAndMaybeRun().catch(() => {});
    // No ClickUp refresh here: CLICKUP_ALARM already refreshes every 5 min, so
    // adding one on the 30-min check only guarantees an overlapping burst.
    autoSyncIfSignedIn();
  } else if (alarm.name === UPDATE_ALARM) {
    rulesTick().catch((e) => diagLog("rules", "tick: " + ((e && e.message) || e))); // Automation rules: time of day, timers, due / overdue, waits
    archiveWatch(false).catch(() => {}); // archived tasks: self-gated (30 min, or a minute after a task vanished)
    await checkForUpdate().catch(() => {});
    await maybeAutoUpdate().catch(() => {});
    // Backstop for the wrap-up alarm (missed while asleep / Chrome closed).
    // Cheap: settings + one storage read, and it runs at most once a day.
    await maybeWrapUp().catch(() => {});
    // The daily "needs tidying" summary, same deal: it self-gates on the time
    // of day, so checking every minute is free and a missed alarm still lands.
    await maybeTidyNotify().catch(() => {});
    await maybeCloseExtraTask().catch(() => {});
    await maybeCheckExtraDates().catch(() => {});
    await maybeHolidayHeadsUp().catch(() => {});
    // Week-card moves left pending (the worker was stopped mid-batch): carry on.
    if (!movesRunning) { const pm = await pendingMoves().catch(() => ({ items: [] })); if (pm.items.some((x) => x.status === "pending")) runPendingMoves().catch(() => {}); }
    // Backstop for reminder alarms (asleep / missed).
    await fireDueReminders();
    await runScheduledAssigns().catch(() => {}); // people scheduled onto tasks ("+ Add someone" > ⏰)
    await runScheduledComments().catch(() => {}); // comments scheduled for a time (▸ details > ⏰ Send at…)
    await slackPoll(false).catch(() => {}); // Slack channels matched to clients: new documents, every 20 min
    await maybeCompanyHeadsUp().catch(() => {});
    await companyEventReminders().catch(() => {});
    // Someone at the computer this minute (keyboard / mouse in the last minute):
    // the hub calls below carry it, for the admin's "active now" dot.
    try { if ((await chrome.idle.queryState(60)) === "active") await chrome.storage.local.set({ userActiveAt: Date.now() }); } catch (e) {}
    // Team hub: daily check-in, admin replies every 10 min (both no-ops when not set up).
    await hubHello().catch(() => {});
    await hubPollReplies().catch(() => {});
    await hubPollNotices().catch(() => {});
    await hubPollNudges().catch(() => {});
    await sendScheduledDrafts().catch((e) => diagLog("drafts", String(e && e.message ? e.message : e)));
    await deskLink(false).catch(() => {});
    await wpRelayTick().catch(() => {}); // Read from WordPress through the other Chrome profile
    await maybeAutoDailyUpdate().catch((e) => diagLog("daily update", String(e && e.message ? e.message : e))); // wrap-up › send it by itself
    await maybeSlackCheckOut().catch((e) => diagLog("slack out", String(e && e.message ? e.message : e)));
    await maybeSlackPresence().catch((e) => diagLog("slack away", String(e && e.message ? e.message : e)));
    // A timer started or stopped somewhere else (ClickUp, the taskbar app) while
    // no extension page is open: noticed within a minute, so its alerts are set
    // on time (the 5-minute refresh alone could make them up to 5 minutes late).
    // Not while ClickUp is rate-limiting us, or the screen is locked.
    try {
      const cfg0 = await getClickupConfig().catch(() => null);
      const st0 = (await getClickupState().catch(() => null)) || {};
      const idle = await chrome.idle.queryState(300).catch(() => "active");
      if (cfg0 && cfg0.token && cfg0.teamId && !(st0.rateLimitedUntil > Date.now()) && idle !== "locked") await syncRunningTimer(cfg0);
    } catch (e) {}
    // Floating tracker: a timer that is running but was never floated (started
    // before a reload, or between refreshes) is noticed within a minute. Storage
    // reads only unless it acts; not awaited (it waits a few seconds first).
    getClickupState().then((st) => maybeAutoFloat(st)).catch(() => {});
    // Backstop for the site monitor (dropped alarm / a run that died): re-arms
    // the alarm and catches up if nothing has been checked for ~12 min. Storage
    // reads only unless it has to act.
    await siteMonitorBackstop().catch((e) => diagLog("sites", "backstop: " + ((e && e.message) || e)));
  } else if (alarm.name === CLICKUP_ALARM) {
    refreshClickup({ viaAlarm: true }).then(() => scanComments()).catch(() => {});
  } else if (alarm.name === EST_ALARM_NEAR || alarm.name === EST_ALARM_MET || alarm.name === EST_ALARM_OVER || alarm.name === STOPAT_ALARM) {
    // The running task's estimate is (almost) up: one check with ClickUp (is the
    // timer still on, exact time) and the alert. Skipped while ClickUp is
    // rate-limiting us; the 5-minute refresh still catches it then.
    const st = (await getClickupState().catch(() => null)) || {};
    if (!(st.rateLimitedUntil > Date.now())) {
      const cfg = await getClickupConfig().catch(() => null);
      await maybeNotifyRunningTask(cfg).catch(() => {});
    }
  } else if (alarm.name === BALANCE_ALARM) {
    pollBalancesInBackground().catch(() => {});
  } else if (alarm.name === SYNC_ALARM) {
    autoSyncIfSignedIn();
  } else if (alarm.name === SITE_MONITOR_ALARM) {
    // Awaited so the worker stays alive through the fetches + the state write -
    // fire-and-forget risks suspension before checkSites persists its results.
    // Logged, never swallowed: a silent .catch(() => {}) here is how the monitor
    // could stop for hours with nothing in Copy diagnostics to say why.
    await checkSites().catch((e) => diagLog("sites", "alarm: " + ((e && e.message) || e)));
  } else if (alarm.name === WRAPUP_ALARM) {
    await onWrapUpAlarm().catch(() => {});
  } else if (alarm.name.startsWith(REM_PREFIX)) {
    await fireDueReminders();
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
    if (id.startsWith("auto-update-setup-")) {
      chrome.notifications.clear(id).catch(() => {});
      openUpdater(true);
      return;
    }
    if (id.startsWith("auto-update-click-")) {
      // The update tab waiting for its one click: show it (or the update page if it was closed).
      chrome.notifications.clear(id).catch(() => {});
      const [t] = await chrome.tabs.query({ url: chrome.runtime.getURL("auto-update.html") + "*" }).catch(() => []);
      if (t) { await chrome.tabs.update(t.id, { active: true }).catch(() => {}); await chrome.windows.update(t.windowId, { focused: true }).catch(() => {}); }
      else openUpdater();
      return;
    }
    if (id.startsWith("cu-tidy-")) {
      // Before the "cu-" fallback below (plain ClickUp): the lists it names, in Insights.
      chrome.notifications.clear(id).catch(() => {});
      await openInsightsPage(tidyDrillsFromId(id));
      return;
    }
    let url = notifTargetUrls.get(id);
    if (!url) {
      if (id.startsWith("ar-quota-") || id.startsWith("daily-login-")) {
        const settings = await getSettings().catch(() => null);
        url = (settings && settings.targetUrl) || URLS.agentRouterLogin;
      } else if (id.startsWith("wrapup-")) {
        url = chrome.runtime.getURL("wrapup.html");
      } else if (id.startsWith("site-")) {
        url = chrome.runtime.getURL("options.html#sites");
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
const TASK_MUTATIONS = new Set([
  "CLICKUP_TASK_START", "CLICKUP_TASK_STOP", "CLICKUP_TASK_COMPLETE",
  "SET_CLICKUP_ESTIMATE", "CLICKUP_SET_DUE", "CLICKUP_MOVE_DUE",
]);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // Anything that changes a task from the extension must not be hidden by the
      // 2-minute subtask cache (lib-clickup getTaskTree).
      if (TASK_MUTATIONS.has(msg && msg.type)) clearTaskTreeCache();
      switch (msg.type) {
      case "GET_STATE": {
        // (The Drive "signed in" answer never holds this up - see signedInQuick.)
        hubHello(false, HUB_ACTIVE_MS).catch(() => {}); // popup / options opened = active (hourly at most)
        const settings = await getSettings();
        const accounts = (await getAccounts()).map((a) => publicAccount(a, settings));
        const status = await getStatus();
        const balances = await getBalances();
        const availability = await getAvailability();
        const signedIn = await signedInQuick();
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
      case "CLICKUP_TASK_RELATED": {
        // A brief's "Related tasks" for one task: dependencies, links, parent,
        // siblings, tasks mentioned / sharing a reference ID - open AND closed,
        // with their last comments. Read-only; the token never leaves here.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const s = await getSettings();
        if (s.clickupRelatedOn === false) { sendResponse({ ok: true, off: true, tasks: [] }); break; }
        try {
          const d = await getTaskPanel(cfg.token, String(msg.taskId || ""));
          // A plan passes its share of the plan's budget (msg.cap) - never more than the setting.
          const cap = Math.max(1, Math.min(Number(s.clickupRelatedCap) || 25, Number(msg.cap) || Infinity));
          const r = await getRelatedTasks(cfg.token, d, { cap, ids: s.clickupRelatedIds, teamId: cfg.teamId });
          sendResponse({ ok: true, ...r });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status });
        }
        break;
      }
      case "CLICKUP_TASK_PANEL": {
        try {
          const cfg = await getClickupConfig();
          if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
          const data = await getTaskPanel(cfg.token, msg.taskId, !!msg.force);
          // Which of the assignees is me. The panel is cached per task and the id
          // lives in the config, not in ClickUp's answer, so it is stamped on here:
          // the note sender needs it to leave you out of the people it offers.
          data.meUserId = cfg.userId == null ? "" : String(cfg.userId);
          sendResponse({ ok: true, data });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status }); }
        break;
      }
      case "CLICKUP_TASK_ATTACH": {
        // Floating tracker's big view: upload files (screenshots pasted with
        // Ctrl+V, dropped or picked) to the task, then post the comment with their
        // links - ClickUp's API can't put files inside a comment itself.
        // msg.files = [{ name, type, b64 }] (base64; messages can't carry Blobs).
        try {
          const cfg = await getClickupConfig();
          if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
          const taskId = String(msg.taskId || "");
          const files = Array.isArray(msg.files) ? msg.files.slice(0, 10) : [];
          const links = [], uploaded = [];
          for (const f of files) {
            const bin = atob(String(f.b64 || ""));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const fd = new FormData();
            fd.append("attachment", new Blob([bytes], { type: f.type || "application/octet-stream" }), String(f.name || "file").slice(0, 120));
            const res = await cuRawFetch(cfg.token, "https://api.clickup.com/api/v2/task/" + encodeURIComponent(taskId) + "/attachment", {
              method: "POST", headers: { Authorization: cfg.token }, body: fd,
            });
            if (!res.ok) throw new Error("upload of " + (f.name || "a file") + " failed (HTTP " + res.status + ")");
            const j = await res.json().catch(() => ({}));
            links.push((f.name || "file") + (j && j.url ? ": " + j.url : ""));
            uploaded.push({ name: f.name || "file", url: (j && j.url) || "" });
          }
          // Description editor: only upload, the links go into the description.
          if (msg.noComment) { sendResponse({ ok: true, files: uploaded }); break; }
          const text = [String(msg.text || "").trim(), links.length ? "Attached: " + links.join("\n") : ""].filter(Boolean).join("\n\n");
          const members = ((await getClickupState().catch(() => null)) || {}).members;
          const data = text ? await addTaskComment(cfg.token, taskId, text.slice(0, 5000), members) : null;
          sendResponse({ ok: true, data, uploaded: links.length, mentioned: data && data.mentioned, unmatched: data && data.unmatched });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "CLICKUP_TASK_DESCRIPTION": {
        // Floating tracker's bigger view: save the task's description. Refuses
        // (changed: true + their text) if it was edited in ClickUp meanwhile.
        try {
          const cfg = await getClickupConfig();
          if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
          const data = await setTaskDescription(cfg.token, String(msg.taskId || ""), String(msg.text || "").slice(0, 60000), msg.expected);
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e), changed: e && e.code === "changed", current: e && e.current });
        }
        break;
      }
      case "SMART_TASKS": {
        try { sendResponse(await smartTaskSearch(msg.q || {})); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "PLAN_DEV_TASKS": {
        try { sendResponse(await getDevPipeline(!!msg.force)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "PERF_HISTORY": {
        try { sendResponse(await getPerfHistory(!!msg.force, msg.weeks)); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "CLICKUP_OPEN_TASKS": {
        // Bulk edit "Any date": every open task assigned to me, with or without
        // dates (so missing due / start dates and estimates can be found). Up to
        // 6 pages, cached 3 minutes. Also what the daily "needs tidying" reminder
        // reads, so the notification and the Insights tab always agree. With
        // msg.tag it is narrowed to that one tag (Bulk edit > "By tag"), and with
        // msg.assignee to one person's tasks (Bulk edit > "Whose tasks").
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          sendResponse(await getOpenTasks(cfg, !!msg.force, msg.tag, msg.assignee));
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_TIDY_PREVIEW": {
        // Options > "Preview now": post the real summary without spending today's
        // one-shot, so the user can see exactly what lands at their chosen time.
        // Nothing to say? Show a labelled sample instead of staying silent, so
        // the button always shows the shape of the notification.
        const p = await tidyReminderPayload({ fresh: !!msg.fresh }).catch(() => null);
        if (!p || !p.ok) {
          sendResponse({ ok: false, reason: (p && p.reason) || "not-connected", error: p && p.error });
          break;
        }
        let say = p.say;
        if (say.empty) {
          const day = 86400000, today = new Date().setHours(0, 0, 0, 0);
          say = tidyLines(tidyCollect([
            { id: "p1", name: "Fix the redirect rule", estimateMs: 3600000, dueDateMs: today - 3 * day },
            { id: "p2", name: "Q4 audit report", estimateMs: 0, dueDateMs: null },
            { id: "p3", name: "Website redesign", estimateMs: 7200000, dueDateMs: today + 2 * day },
          ], { p3: { blockers: [{ who: "Rigo" }] } }, today), { cats: {}, max: 3 });
          say.sample = true;
        }
        const drills = tidyDrills(say);
        await notify("cu-tidy-preview-" + (drills.join(".") || "all") + "-" + Date.now(), say.title, say.message, undefined,
          null, { contextMessage: (say.sample ? "Sample - nothing to tidy right now · " : "") + (say.context || "Insights › Needs tidying") + " · click to see them", ...TIDY_NOTE_OPTS });
        sendResponse({ ok: true, k: p.model.k, sample: !!say.sample, lines: p.say.lines });
        break;
      }
      case "HELD_COMMENTS": {
        // The comments kept on a task until it's completed: list / save / delete / send now.
        const taskId = String(msg.taskId || "");
        if (!taskId) { sendResponse({ ok: false, error: "no task" }); break; }
        try {
          if (msg.op === "save") {
            const text = String(msg.text || "").trim().slice(0, 5000);
            if (!text) { sendResponse({ ok: false, error: "Write a comment first." }); break; }
            // ⏰ Send at…: a time (at least 30 seconds ahead); without it, a plain "when I complete it" one.
            const sendAt = Number(msg.sendAt) || 0;
            if (sendAt && sendAt < Date.now() + 30000) { sendResponse({ ok: false, error: "Pick a time later than now." }); break; }
            await heldUpdate(taskId, (list) => {
              const i = list.findIndex((c) => c.id === msg.id);
              const c = { id: msg.id || "h" + Date.now().toString(36), text, auto: !!msg.auto, at: Date.now(), sendAt, taskName: String(msg.taskName || "").slice(0, 200), url: String(msg.url || ""), status: sendAt ? String(msg.status || "").trim().toLowerCase().slice(0, 60) : "", tries: 0, nextTry: 0, failed: 0, error: "" };
              if (i >= 0) list[i] = { ...list[i], ...c }; else list.push(c);
              return list;
            });
          } else if (msg.op === "auto") {
            await heldUpdate(taskId, (list) => list.map((c) => c.id === msg.id ? { ...c, auto: !!msg.auto } : c));
          } else if (msg.op === "delete") {
            await heldUpdate(taskId, (list) => list.filter((c) => c.id !== msg.id));
          } else if (msg.op === "send") {
            const cfg = await getClickupConfig();
            if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
            const one = (await heldList(taskId)).filter((c) => c.id === msg.id);
            const data = await sendHeldComments(cfg, taskId, one, true);
            if (one.some((c) => c.status)) { clearFilterCache(); refreshClickup({ includeTasks: true }).catch(() => {}); }
            sendResponse({ ok: true, list: await heldList(taskId), data });
            break;
          }
          sendResponse({ ok: true, list: await heldList(taskId) });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status }); }
        break;
      }
      case "COMMENTS_SEEN": {
        // A task's comments were looked at (its ▸ details opened, or "Mark read").
        const ids = (Array.isArray(msg.taskIds) ? msg.taskIds : [msg.taskId]).map((x) => String(x || "")).filter(Boolean);
        const { cuCommentSeen } = await chrome.storage.local.get("cuCommentSeen");
        const seen = cuCommentSeen && typeof cuCommentSeen === "object" ? { ...cuCommentSeen } : {};
        for (const id of ids) seen[id] = Date.now();
        await chrome.storage.local.set({ cuCommentSeen: seen });
        sendResponse({ ok: true });
        break;
      }
      case "COMMENTS_SCAN": { sendResponse({ ok: true }); scanComments(!!msg.more).catch(() => {}); break; }
      case "CLICKUP_TASK_COMMENT": {
        try {
          const cfg = await getClickupConfig();
          const text = String(msg.text || "").trim();
          if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
          if (!text) { sendResponse({ ok: false, error: "Write a comment first." }); break; }
          // @names are matched to the workspace people already loaded (no request).
          const members = ((await getClickupState().catch(() => null)) || {}).members;
          const data = await addTaskComment(cfg.token, msg.taskId, text.slice(0, 5000), members);
          sendResponse({ ok: true, data, mentioned: data && data.mentioned, unmatched: data && data.unmatched });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status }); }
        break;
      }
      case "CELEBRATE_PREVIEW": {
        // Options > Preview: the animation in every open extension page (options,
        // side panel, popup), the notification with its picture, and the card.
        const sad = msg.mood === "sad";
        const ps = await getSettings();
        const secs = Math.max(1, Math.min(15, Number(msg.secs) || Number(ps.celebrationSeconds) || 3));
        await chrome.storage.local.set({ celebrate: { id: "preview-" + Date.now(), kind: "preview", preview: true, big: true, mood: sad ? "sad" : "happy", secs, at: Date.now() } });
        await notify("clickup-preview-" + Date.now(), sad ? "ClickUp - not quite there today (preview)" : "ClickUp - daily estimate reached \u2713 (preview)",
          sad ? "This is what a missed-target notification looks like." : "This is what a target-reached notification looks like.",
          sad ? "danger" : "winner", undefined, { type: "image", imageUrl: chrome.runtime.getURL(sad ? "icons/sad.png" : "icons/celebrate.png") });
        await celebrateMilestone({ kind: "preview", big: true, mood: sad ? "sad" : "happy", force: true,
          title: sad ? "Not quite there today" : "Daily estimate reached! \ud83c\udf89", sub: "Preview" });
        sendResponse({ ok: true });
        break;
      }
      case "RELOAD_EXTENSION": {
        // A reload closes every extension page. Remember the page that asked
        // (with its #section) so it comes straight back once we've restarted.
        const back = String((sender && (sender.url || (sender.tab && sender.tab.url))) || "");
        if (back.startsWith(chrome.runtime.getURL(""))) {
          await chrome.storage.local.set({ reopenAfterReload: { url: back, at: Date.now() } }).catch(() => {});
        }
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
      case "SITE_MONITOR_CHECK_NOW": {
        try {
          const summary = await checkSites({ manual: true, url: msg.url || "" });
          const state = (await chrome.storage.local.get("siteMonitorState"))["siteMonitorState"] || {};
          sendResponse({ ok: true, summary, state });
        } catch (e) { diagLog("sites", "check now: " + ((e && e.message) || e)); sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }); }
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
          const res = await cuRawFetch(cfg.token,
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
          // A batch (Insights › Plan "Apply all") refreshes once at the end itself.
          if (res.ok && msg.skipRefresh) break;
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
                if (d.group) chrome.storage.local.set({ arUserGroup: String(d.group) }).catch(() => {});
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
      case "HUB": {
        // Help & issues: every call from the pages goes through here (the address,
        // this install's id, the ClickUp name/photo and the admin key are added).
        const a = String(msg.action || "");
        const p = { ...(msg.payload || {}) };
        if (a === "post" || a === "metoo") {
          const prof = await hubProfile();
          if (!prof) { sendResponse({ ok: false, error: "Connect ClickUp first - your name and photo come from it." }); break; }
          p.name = prof.name;
          if (p.diag === true) p.diag = await buildDiagReport("help").catch(() => "");
          else delete p.diag;
          // First post / me-too on this computer: make sure the hub knows who this is.
          await hubHello(true).catch(() => {});
        }
        // The admin's users list: check this copy in first so its own row is current.
        if (a === "users") await hubHello(true).catch(() => {});
        // A moderation call names the person acted on in "install", but every call
        // carries THIS copy's install id there - so it travels as "target".
        if (a === "mod" && p.install) { p.target = p.install; delete p.install; }
        const r = await hubCall(a, p, !!msg.admin);
        if (r && r.ok && (a === "notice" || a === "notices") && Array.isArray(r.notices)) await setHubNotices(r.notices).catch(() => {});
        if (r && r.ok && (a === "post" || a === "metoo")) {
          const { hubSeen } = await chrome.storage.local.get("hubSeen");
          await chrome.storage.local.set({ hubActive: true, hubSeen: hubSeen || {} });
        }
        sendResponse(r);
        break;
      }
      case "REMINDERS_CHECK": {
        // A reminder saved for "Now" (or already due) goes out at once.
        await fireDueReminders();
        sendResponse({ ok: true });
        break;
      }
      case "HUB_INFO": {
        const url = await hubUrl();
        const { hubMe } = await chrome.storage.local.get("hubMe");
        sendResponse({ ok: true, url: !!url, profile: await hubProfile().catch(() => null), me: hubMe || null, adminKey: !!(await hubAdminKey()), install: await installId() });
        break;
      }
      case "HUB_SEEN": {
        const { hubSeen } = await chrome.storage.local.get("hubSeen");
        const seen = hubSeen && typeof hubSeen === "object" ? { ...hubSeen } : {};
        seen[String(msg.id)] = Math.max(Number(seen[String(msg.id)]) || 0, Number(msg.lastAt) || Date.now());
        const { hubUnread } = await chrome.storage.local.get("hubUnread");
        await chrome.storage.local.set({ hubSeen: seen, hubUnread: (Array.isArray(hubUnread) ? hubUnread : []).filter((x) => x && x.id !== String(msg.id)) });
        sendResponse({ ok: true });
        break;
      }
      case "ADMIN_HUB_SAVE": {
        // Admin > Team hub: test the address + key, keep the key (encrypted) on this
        // computer, and publish the address in update-policy.json for everyone.
        const url = String(msg.url || "").trim();
        const key = String(msg.key || "").trim();
        if (!HUB_URL_RE.test(url)) { sendResponse({ ok: false, error: "That isn't a Google Apps Script web app address (it ends in /exec)." }); break; }
        const test = await hubPost(url, { action: "users", key, install: await installId() });
        if (!test || !test.ok) { sendResponse({ ok: false, error: (test && test.error) || "The hub didn't answer." }); break; }
        await chrome.storage.local.set({ adminHubEnc: await encryptJSON({ key }), hubUrlLocal: url });
        let shared = false, shareError = "";
        try {
          const { adminEnc } = await chrome.storage.local.get("adminEnc");
          const saved = await decryptJSON(adminEnc, null);
          if (!saved || !saved.token) throw new Error("add your GitHub token (GitHub access, below) so everyone's copy gets the address");
          const head = { Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" };
          const cur = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
          const next = normalizeUpdatePolicy({ ...(cur.data || UPDATE_POLICY_DEFAULTS), hubUrl: url });
          next.updatedAt = Date.now();
          await ghPutJsonFile(head, UPDATE_POLICY_PATH, next, cur.sha, "Set the team hub address");
          await purgePolicyCdn();
          await chrome.storage.local.set({ updatePolicy: { at: Date.now(), rawAt: Date.now(), policy: next } });
          shared = true;
        } catch (e) { shareError = String((e && e.message) || e); }
        await hubHello(true).catch(() => {});
        sendResponse({ ok: true, users: test.total || 0, shared, shareError });
        break;
      }
      case "TF_DRIVE_COPY": {
        // Clients > "Copy to Drive": the client's files (originals when kept) into
        // My Drive > Personal ClickUp Manager > Clients > <client>. Files copied
        // before aren't uploaded again. Asks for Drive access the first time.
        try {
          const ck = String(msg.client || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
          const name = String(msg.client || "Client").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "Client";
          const recs = (await tfAll()).filter((r) => r.ck === ck);
          if (!recs.length) { sendResponse({ ok: false, error: "This client has no files yet." }); break; }
          const tok = await getFileToken(true);
          if (!tok) { sendResponse({ ok: false, error: "Google Drive access wasn't given." }); break; }
          const top = await driveFolder(tok, "Personal ClickUp Manager", "root");
          const cl = await driveFolder(tok, "Clients", top);
          const dir = await driveFolder(tok, name, cl);
          const { tfDriveCopies } = await chrome.storage.local.get("tfDriveCopies");
          const copies = tfDriveCopies && typeof tfDriveCopies === "object" ? { ...tfDriveCopies } : {};
          let uploaded = 0, skipped = 0, textOnly = 0;
          for (const r of recs) {
            if (copies[r.id]) { skipped++; continue; }
            let blob = r.blob, fname = r.name, type = r.type || (r.blob && r.blob.type) || "";
            if (!blob && r.html) { blob = new Blob([r.html], { type: "text/html" }); type = "text/html"; }
            if (!blob && r.text) { blob = new Blob([r.text], { type: "text/plain" }); type = "text/plain"; fname = String(r.name).replace(/\.[a-z0-9]+$/i, "") + " (text).txt"; textOnly++; }
            if (!blob) continue;
            copies[r.id] = await uploadDriveFile(tok, { name: fname, type, blob, parentId: dir });
            uploaded++;
            await chrome.storage.local.set({ tfDriveCopies: copies });
          }
          sendResponse({ ok: true, url: "https://drive.google.com/drive/folders/" + dir, uploaded, skipped, textOnly });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      }
      case "DISMISS_NOTE": {
        // Hide an account's "needs you" message (nothing else changes).
        await setStatusFor(msg.id, { noteDismissedAt: Date.now() });
        sendResponse({ ok: true });
        break;
      }
      case "MARK_DONE": {
        const now = Date.now();
        // This bypasses recordLoginResult, so clear the retry bookkeeping here too:
        // the person just logged in by hand, which proves the stored sign-in works,
        // and this is the button sitting next to the failure note.
        await setStatusFor(msg.id, { lastDone: todayString(), lastDoneAt: now, lastRunAt: now, lastResult: "success", note: "marked manually", loginFails: 0, nextAttemptAt: 0, retryStoppedAt: 0 });
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
        if (msg.patch && "fxIconRing" in msg.patch) updateBadge().catch(() => {}); // ring on/off right away
        await scheduleAgentRouterAlarms(next).catch(() => {});
        applyIdleInterval().catch(() => {});
        scheduleWrapUpAlarm().catch(() => {});
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
          await setClickupConfig({ token, userId: user.id, username: user.username, email: user.email, teamId, teamName,
            avatar: user.profilePicture || "", color: user.color || "", initials: user.initials || "", profileAt: Date.now() });
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
          // Remember the task we switched away from (e.g. for a meeting), so the
          // floating tracker can offer "Back to <task>" when the Extra Task ends.
          if (cur && cur.taskId && String(cur.taskId) !== taskId) {
            await chrome.storage.local.set({ resumeTask: { id: String(cur.taskId), name: cur.taskName || "", at: Date.now() } });
          }

          // Set this task to "in progress" and start its timer (with the optional
          // Custom note / "Meeting" description from the Extra Task controls).
          await setTaskStatus(cfg.token, taskId, "in progress").catch(() => {});
          await startTimer(cfg.token, cfg.teamId, taskId, msg.description);

          await setClickupState({ ...st, activeTaskId: taskId });
          clearFilterCache();

          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          const running = (r.data && r.data.running) || await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          sendResponse({ ok: true, running: running || null, data: r.data || null });
          heldStartReminder(String(msg.taskId || "")).catch(() => {});
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
          const { running, changed } = await syncRunningTimer(cfg);
          sendResponse({ ok: true, running: running || null, changed });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_PHONE_SETUP": {
        // What a phone shortcut needs to start/stop the timer: the workspace id
        // and the auto-discovered Extra Task id. NO secret in this reply - the
        // token is only ever handed out by CLICKUP_PHONE_TOKEN, on a click.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const st = (await getClickupState().catch(() => null)) || {};
        const ex = st.extraTask || null;
        sendResponse({
          ok: true,
          workspaceId: cfg.teamId ? String(cfg.teamId) : "",
          username: cfg.username || cfg.email || "",
          extraTaskId: ex && ex.id ? String(ex.id) : "",
          extraTaskName: (ex && ex.name) || "",
          extraTaskUrl: (ex && ex.url) || "",
          dailyTargetMs: Math.max(0, Number(st.targetMs) || 0),
        });
        break;
      }
      case "CLICKUP_PHONE_TOKEN": {
        // Reveals the personal token so the owner can paste it into a phone
        // shortcut. Deliberately its own message: nothing else in the extension
        // can ask for it, and it is never written to storage or logged.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        sendResponse({ ok: true, token: String(cfg.token) });
        break;
      }
      case "CLICKUP_TASK_START": {
        // Per-task Start: set the task "in progress" in ClickUp AND start its
        // timer. Only ONE task may be in progress at a time, so we first revert
        // whatever was active (the last task WE set + any task with a live timer)
        // back to "to do" and stop its timer. Tasks with more than one assignee
        // start too - the list warns about them on hover before the click.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        if (!cfg.teamId) { sendResponse({ ok: false, reason: "incomplete-setup" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
        try {
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
          // Every card shows it straight away (the refresh below confirms).
          for (const rid of toRevert) await patchStateTask(rid, { status: "to do" }).catch(() => {});
          await patchStateTask(taskId, { status: "in progress" }).catch(() => {});
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
          await patchStateTask(taskId, { status: "to do" }).catch(() => {}); // every card at once
          // The start/stop shortcut starts this one again next time.
          await chrome.storage.local.set({ lastStoppedTask: { id: taskId, name: (cur && String(cur.taskId) === taskId && cur.taskName) || "", at: Date.now() } });
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
        // Comments kept "for when I complete it" (task ▸ details): "Ask me first"
        // ones stop here so the page can ask; "Send automatically" ones (and the
        // asked ones once you say Send) are posted before the task is completed.
        const held = await heldList(taskId);
        let sentHeld = false;
        if (held.length) {
          const asked = held.filter((c) => !c.auto);
          if (asked.length && msg.held !== "send" && msg.held !== "skip") {
            sendResponse({ ok: false, reason: "held-comment", comments: held.map((c) => ({ id: c.id, text: c.text.slice(0, 300), auto: !!c.auto })) });
            break;
          }
          const toSend = msg.held === "send" ? held : held.filter((c) => c.auto);
          try { await sendHeldComments(cfg, taskId, toSend); sentHeld = toSend.length > 0; }
          catch (e) {
            sendResponse({ ok: false, error: "The waiting comment couldn't be posted, so the task was not completed: " + String(e && e.message ? e.message : e) + " - it's still kept in ▸ details." });
            break;
          }
        }
        // Nothing to show for it (no filled Description: / File: and no comment):
        // the page asks "complete anyway?" and sends evidence:"skip" if so.
        if (!sentHeld && msg.evidence !== "skip" && (await getSettings()).clickupWarnEmptyComplete !== false) {
          const miss = await completionEvidenceMissing(cfg, taskId);
          if (miss) { sendResponse({ ok: false, reason: "no-evidence", taskName: miss.name }); break; }
        }
        try {
          await setTaskStatus(cfg.token, taskId, "complete");
          await patchStateTask(taskId, { status: "complete", done: true }).catch(() => {}); // every card at once
          const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
          if (cur && String(cur.taskId) === taskId) await stopTimer(cfg.token, cfg.teamId).catch(() => {});
          const st = (await getClickupState().catch(() => null)) || {};
          if (String(st.activeTaskId || "") === taskId) await setClickupState({ ...st, activeTaskId: null });
          await advanceAutoRun(cfg, taskId); // the auto-run queue's current task: start the next
          clearFilterCache();
          const r = await refreshClickup({ includeTasks: true }).catch(() => ({}));
          sendResponse({ ok: true, running: (r.data && r.data.running) || null, data: r.data || null });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_DONE_HISTORY": {
        // Pure storage read - no ClickUp request, so the Recently completed card
        // can be opened and searched as often as you like without touching the
        // rate limit. The list is built during each refresh (recordDoneHistory).
        // It also records from the data already loaded right now (still no
        // request), so the card isn't empty until the next full refresh - which
        // after a reload or a rate-limit pause can be a while.
        const cur = await getClickupState().catch(() => null);
        if (cur) await recordDoneHistory(cur).catch(() => {});
        const store = await chrome.storage.local.get(DONE_HISTORY_KEY).catch(() => ({}));
        const rows = Array.isArray(store && store[DONE_HISTORY_KEY]) ? store[DONE_HISTORY_KEY] : [];
        sendResponse({ ok: true, rows, days: DONE_HISTORY_DAYS, max: DONE_HISTORY_MAX, synced: !!(cur && cur.at), syncedAt: (cur && cur.at) || 0 });
        break;
      }
      case "CLICKUP_DONE_HISTORY_CLEAR": {
        await chrome.storage.local.set({ [DONE_HISTORY_KEY]: [] }).catch(() => {});
        sendResponse({ ok: true, rows: [] });
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
        if (p.clickupSyncMin !== undefined && SYNC_CHOICES.includes(Number(p.clickupSyncMin))) patch.clickupSyncMin = Number(p.clickupSyncMin);
        if (p.clickupWeekMode !== undefined && CU_WEEK_MODES[p.clickupWeekMode]) patch.clickupWeekMode = p.clickupWeekMode;
        if (p.clickupAwayNotify !== undefined) patch.clickupAwayNotify = !!p.clickupAwayNotify;
        if (p.clickupAwayMin !== undefined) {
          const n = Number(p.clickupAwayMin);
          if (Number.isFinite(n) && n >= 5 && n <= 240) patch.clickupAwayMin = Math.floor(n);
        }
        if (p.clickupWrapUp !== undefined) patch.clickupWrapUp = !!p.clickupWrapUp;
        if (p.clickupExtraAutoClose !== undefined) patch.clickupExtraAutoClose = !!p.clickupExtraAutoClose;
        if (p.clickupWarnEmptyComplete !== undefined) patch.clickupWarnEmptyComplete = !!p.clickupWarnEmptyComplete;
        if (p.clickupRelatedOn !== undefined) patch.clickupRelatedOn = !!p.clickupRelatedOn;
        if (p.clickupOverRepeatMin !== undefined) patch.clickupOverRepeatMin = Math.max(0, Math.min(120, Math.round(Number(p.clickupOverRepeatMin) || 0)));
        if (p.clickupRelatedCap !== undefined) patch.clickupRelatedCap = Math.max(1, Math.min(60, Number(p.clickupRelatedCap) || 25));
        if (p.clickupRelatedIds !== undefined) patch.clickupRelatedIds = String(p.clickupRelatedIds || "").slice(0, 2000);
        if (p.clickupHolidayHeadsUp !== undefined) patch.clickupHolidayHeadsUp = !!p.clickupHolidayHeadsUp;
        if (p.clickupWrapUpTime !== undefined && parseHM(p.clickupWrapUpTime, null)) {
          const [h, m] = parseHM(p.clickupWrapUpTime, null);
          patch.clickupWrapUpTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
        }
        if (p.clickupTidyNotify !== undefined) patch.clickupTidyNotify = !!p.clickupTidyNotify;
        if (p.clickupTidyTime !== undefined && parseHM(p.clickupTidyTime, null)) {
          const [h, m] = parseHM(p.clickupTidyTime, null);
          patch.clickupTidyTime = String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
        }
        if (p.clickupTidyDays !== undefined) {
          const d = String(p.clickupTidyDays).toLowerCase().trim();
          // "weekdays" / "every" / a comma list of 0-6 (0 = Sunday)
          if (d === "weekdays" || d === "every" || d.split(",").map((x) => parseInt(x, 10)).every((n) => Number.isInteger(n) && n >= 0 && n <= 6) && d) {
            patch.clickupTidyDays = d;
          }
        }
        if (p.clickupTidyMax !== undefined) {
          const n = Number(p.clickupTidyMax);
          if (Number.isFinite(n) && n >= 1 && n <= 6) patch.clickupTidyMax = Math.floor(n);
        }
        if (p.clickupTidyResolved !== undefined) patch.clickupTidyResolved = !!p.clickupTidyResolved;
        if (p.clickupTidyCats !== undefined && p.clickupTidyCats && typeof p.clickupTidyCats === "object") {
          const c = p.clickupTidyCats;
          patch.clickupTidyCats = {
            overdue: c.overdue !== false, noEst: c.noEst !== false,
            noDue: c.noDue !== false, blocked: c.blocked !== false, offDay: c.offDay !== false,
          };
        }
        if (p.clickupWorkdayEndHour !== undefined) {
          const n = Number(p.clickupWorkdayEndHour);
          if (Number.isFinite(n) && n >= 0 && n <= 23) patch.clickupWorkdayEndHour = Math.floor(n);
        }
        if (p.clickupExtendedMode !== undefined) {
          patch.clickupExtendedMode = p.clickupExtendedMode === "excl0" ? "excl0" : "days";
        }
        if (p.clickupMultiDay !== undefined) {
          patch.clickupMultiDay = p.clickupMultiDay === "days" || p.clickupMultiDay === "excl0" ? p.clickupMultiDay : "due";
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
        if (patch.clickupSyncMin !== undefined) await ensureAlarm(CLICKUP_ALARM, { periodInMinutes: syncMinutes(next) }).catch(() => {});
        applyIdleInterval().catch(() => {});
        scheduleWrapUpAlarm().catch(() => {});
        // Deadline config, extended-mode, or extended-mode changes recompute the
        // estimate itself, so refetch from the API. The weeklyTo toggle is cheap:
        // it just re-renders from the cached Mon→today / Mon→Friday aggregates
        // (fetchWeeklySummary already computed both), so no network here.
        if (patch.clickupMultiDay !== undefined) {
          // Every card and filter counts differently now: rebuild them all.
          clearFilterCache();
          sendResponse({ ok: true, settings: next });
          rebuildListsFor("Multi-day tasks", { includeTasks: true, forceWeeks: true, forceWeekly: true }).catch(() => {});
          break;
        }
        if (patch.clickupWeekMode !== undefined) {
          // Same here: the week bundles rebuild in the background.
          sendResponse({ ok: true, settings: next });
          refreshClickup({ includeTasks: false, forceWeeks: true, after: true }).catch(() => {});
          break;
        }
        if (patch.clickupDeadlineTaskUrls !== undefined || patch.clickupExtendedMode !== undefined) {
          await rebuildListsFor("Recurring or multi-day tasks", { includeTasks: false }).catch(() => {});
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
      case "EXTRA_FIX_DATES": {
        try { sendResponse(await fixExtraDates()); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "TASK_TIME_ENTRIES": {
        // Task details › Time tracked: list, change or delete your own entries.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const taskId = String(msg.taskId || "");
        if (!taskId) { sendResponse({ ok: false, error: "no task" }); break; }
        try {
          if (msg.op === "delete" && msg.entryId) {
            await deleteTimeEntry(cfg.token, cfg.teamId, String(msg.entryId));
          } else if (msg.op === "save" && msg.entryId) {
            const s = Number(msg.startMs), e = Number(msg.endMs);
            if (!(s > 0) || !(e > s)) { sendResponse({ ok: false, error: "The end has to be after the start." }); break; }
            const body = { start: s, end: e, duration: e - s, tid: taskId };
            if (typeof msg.description === "string") body.description = msg.description.slice(0, 500);
            await updateTimeEntry(cfg.token, cfg.teamId, String(msg.entryId), body);
          }
          // "Why?" filled in: the change and the reason as a comment on the task,
          // so whoever reads the timesheet can see why it was changed.
          let commented = false;
          const why = String(msg.reason || "").trim().slice(0, 1000);
          if (why && msg.op && msg.change) {
            try { await postTaskComment(cfg.token, taskId, "\u23F1 " + String(msg.change).slice(0, 400) + "\nReason: " + why); commented = true; } catch (e) {}
          }
          const entries = await getTaskTimeEntries(cfg.token, cfg.teamId, taskId);
          sendResponse({ ok: true, entries, commented });
          // The task's time, today's and the week's totals follow.
          if (msg.op) { clearFilterCache(); refreshClickup({ includeTasks: true }).catch(() => {}); }
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_SET_ENTRY_NOTE": {
        // "Tracking now" note box: set the running (or just-stopped) time entry's
        // description - the Description column in ClickUp Timesheet.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          let entryId = msg.entryId ? String(msg.entryId) : null;
          let taskId = msg.taskId ? String(msg.taskId) : null;
          if (!entryId) {
            const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
            if (cur) { entryId = cur.id; taskId = String(cur.taskId); }
          }
          if (!entryId) { sendResponse({ ok: false, reason: "no-timer" }); break; }
          const description = String(msg.description || "").trim().slice(0, 500);
          const body = { description };
          if (taskId) body.tid = taskId;
          await updateTimeEntry(cfg.token, cfg.teamId, entryId, body);
          const st = await getClickupState().catch(() => null);
          if (st && st.running && String(st.running.id) === entryId) {
            await setClickupState({ ...st, running: { ...st.running, description } });
          }
          sendResponse({ ok: true, description });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_ALL_LISTS": {
        // New task › Client: every List (client) in the workspace the user can
        // reach, with its id - kept a day (the Lists rarely change).
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const { cuAllLists: c } = await chrome.storage.local.get("cuAllLists");
        if (!msg.force && c && c.teamId === String(cfg.teamId) && Array.isArray(c.lists) && c.lists.length && Date.now() - (c.at || 0) < 24 * 3600 * 1000) { sendResponse({ ok: true, lists: c.lists }); break; }
        try {
          const r0 = await getOpenTasks(cfg, false).catch(() => null);
          const folderIds = [];
          for (const t of (r0 && r0.data && r0.data.tasks) || []) { const ct = (t && t.container) || {}; if (ct.folderId && !folderIds.includes(ct.folderId)) folderIds.push(ct.folderId); }
          const lists = await listAllLists(cfg.token, cfg.teamId, folderIds);
          if (lists.length) await chrome.storage.local.set({ cuAllLists: { at: Date.now(), teamId: String(cfg.teamId), lists } });
          sendResponse({ ok: true, lists: lists.length ? lists : (c && c.lists) || [] });
        } catch (e) {
          sendResponse({ ok: !!(c && c.lists && c.lists.length), lists: (c && c.lists) || [], error: String((e && e.message) || e) });
        }
        break;
      }
      case "CLICKUP_TASK_LISTS": {
        // "Create a task": the Lists the user's open tasks live in (from the
        // cached open-task read - usually no new request), with their client.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          const collect = (r) => {
            const map = new Map();
            for (const t of (r && r.data && r.data.tasks) || []) {
              const c = t.container || {};
              if (!c.listId) continue;
              const x = map.get(c.listId) || { id: c.listId, name: c.listName || "List", folder: c.folderName || "", client: t.client || "", n: 0 };
              x.n++;
              map.set(c.listId, x);
            }
            return [...map.values()];
          };
          let lists = collect(await getOpenTasks(cfg, !!msg.force));
          // A copy read before lists carried their id: read once more.
          if (!lists.length && !msg.force) lists = collect(await getOpenTasks(cfg, true));
          lists.sort((a, b) => (a.client || a.name).localeCompare(b.client || b.name) || a.name.localeCompare(b.name));
          sendResponse({ ok: true, lists });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status });
        }
        break;
      }
      case "DESK_STATUS": {
        // Settings asks "is the taskbar app running?" (and passes the choice on to it).
        const r = await deskLink(true).catch(() => null);
        sendResponse({ ok: true, app: r || { running: false } });
        break;
      }
      case "LOCAL_TASKS_SEND_DUE": { sendResponse({ ok: true }); sendScheduledDrafts().catch(() => {}); break; }
      case "CLICKUP_CREATE_TASK": {
        // "Apply to ClickUp" on a draft task (local-tasks.js): one POST.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured", error: "Connect ClickUp first (ClickUp setup)." }); break; }
        const d = msg.draft || {};
        const listId = String(d.listId || "").trim();
        if (!/^\d+$/.test(listId)) { sendResponse({ ok: false, error: "Pick the List to create it in." }); break; }
        if (!String(d.name || "").trim()) { sendResponse({ ok: false, error: "The task needs a name." }); break; }
        try {
          const task = await createTask(cfg.token, listId, draftCreateFields(d, cfg));
          const relErr = await relateDraft(cfg, d, task);
          openTasksCache = null;
          clearFilterCache();
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, task, relErr });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status });
        }
        break;
      }
      case "CLICKUP_MOVE_MANY": {
        // msg.moves: [{ taskId, name, dueMs, startMs, fromTs, toTs }] - queued, answered at once.
        const moves = Array.isArray(msg.moves) ? msg.moves.filter((m) => m && m.taskId && (Number(m.dueMs) > 0 || m.clear)).slice(0, 50) : [];
        if (!moves.length) { sendResponse({ ok: false, error: "Nothing to move." }); break; }
        const p = await pendingMoves();
        const batch = Date.now().toString(36);
        const items = p.items.filter((x) => !moves.some((m) => String(m.taskId) === x.id && x.status === "pending"));
        for (const m of moves) items.push({ key: batch + ":" + m.taskId, batch, id: String(m.taskId), name: String(m.name || "task").slice(0, 200), dueMs: Number(m.dueMs) || 0, clear: !!m.clear, startMs: Number(m.startMs) || 0,
          // what it was, for Undo
          oldDueMs: Number(m.oldDueMs) || 0, oldStartMs: Number(m.oldStartMs) || 0, undo: !!m.undo,
          from: Number(m.fromTs) || 0, to: Number(m.toTs) || 0, status: "pending", at: Date.now() });
        await savePendingMoves({ ...p, items });
        sendResponse({ ok: true, queued: moves.length, batch });
        runPendingMoves().catch(() => {});
        break;
      }
      case "CLICKUP_SET_DUE": {
        // Row due-date editor: msg.dueMs (ms) or null to clear it.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
        try {
          const due = msg.dueMs == null || msg.dueMs === "" ? null : Number(msg.dueMs);
          const task = due ? await getTaskById(cfg.token, taskId).catch(() => null) : null;
          // This week by day (drag to another day): the start date can come along.
          if (due && Number(msg.startMs) > 0) await setTaskDates(cfg.token, taskId, Number(msg.startMs), due);
          else await setTaskDueDate(cfg.token, taskId, due, task ? task.dueDateHasTime : null);
          clearFilterCache();
          await patchStateDue(taskId, due).catch(() => {}); // every card shows it at once
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, dueDateMs: due });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_ADD_TIME": {
        // "+ Add missed time": a finished time entry on the Extra task (or msg.taskId).
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, error: "Connect ClickUp first." }); break; }
        const st = (await getClickupState().catch(() => null)) || {};
        const taskId = msg.taskId ? String(msg.taskId) : (st.extraTask && st.extraTask.id ? String(st.extraTask.id) : "");
        if (!taskId) { sendResponse({ ok: false, error: "No Extra task found yet - refresh ClickUp first." }); break; }
        const startMs = Number(msg.startMs), durationMs = Number(msg.durationMs);
        if (!(startMs > 0) || !(durationMs >= 60000) || durationMs > 12 * 3600000 || startMs + durationMs > Date.now() + 120000) { sendResponse({ ok: false, error: "Pick a past time span between 1 minute and 12 hours." }); break; }
        try {
          await addTimeEntry(cfg.token, cfg.teamId, taskId, startMs, durationMs, String(msg.description || "").slice(0, 200));
          clearFilterCache();
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, taskName: msg.taskId ? "" : ((st.extraTask && st.extraTask.name) || "the Extra task") });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "ASG_SCHEDULE": {
        // ⏰ next to a person in "+ Add someone": add them to the task at a set time.
        const taskId = msg.taskId ? String(msg.taskId) : "", userId = msg.userId ? String(msg.userId) : "";
        const at = Number(msg.at) || 0;
        if (!taskId || !/^\d+$/.test(userId)) { sendResponse({ ok: false, error: "No task or person." }); break; }
        if (!(at > Date.now() + 30000)) { sendResponse({ ok: false, error: "Pick a time later than now." }); break; }
        const g = await chrome.storage.local.get(ASG_KEY);
        const jobs = Array.isArray(g[ASG_KEY]) ? g[ASG_KEY] : [];
        const job = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), taskId, taskName: String(msg.taskName || "").slice(0, 200), url: String(msg.url || ""), userId, name: String(msg.name || "").slice(0, 80), at };
        // One per person and task: a new time replaces the earlier one.
        await chrome.storage.local.set({ [ASG_KEY]: jobs.filter((j) => !(j && !j.done && !j.failed && j.taskId === taskId && j.userId === userId)).concat([job]).slice(-300) });
        sendResponse({ ok: true, job });
        break;
      }
      case "SLACK_CONNECT": { sendResponse(await slackConnect(msg.team).catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "SLACK_DISCONNECT": { await chrome.storage.local.remove(["slackSession"]); await chrome.storage.local.set({ slackPoll: { ...((await chrome.storage.local.get("slackPoll")).slackPoll || {}), authErr: false, err: "" } }); sendResponse({ ok: true }); break; }
      case "SLACK_CHANNELS": { sendResponse(await slackChannelList().catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "SLACK_MAP_SET": {
        // { [channelId]: { name, client } } - only the matched ones are kept.
        const m = {};
        for (const [k, v] of Object.entries(msg.map || {})) if (/^[CG][A-Z0-9]{6,}$/.test(k) && v && String(v.client || "").trim()) m[k] = { name: String(v.name || "").slice(0, 80), client: String(v.client).slice(0, 120) };
        await chrome.storage.local.set({ slackChannels: m });
        sendResponse({ ok: true, count: Object.keys(m).length });
        break;
      }
      case "SLACK_TASK_LOOKUP": { sendResponse(await slackTaskLookup(msg.client, msg.name, msg.opts).catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "SLACK_FILE_GET": { sendResponse(await slackFileGet(String(msg.id || "")).catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "SLACK_COPIES": { sendResponse(await (msg.op === "trash" ? slackTrashCopies(msg.clients) : slackCopies()).catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "CNOTE_AI": {
        // A page's reading of a client notice with Chrome's AI: kept and shared with the team.
        const g = await chrome.storage.local.get("clientNotices");
        const n = ((g.clientNotices && g.clientNotices.list) || []).find((x) => x.id === String(msg.id || ""));
        if (!n) { sendResponse({ ok: false }); break; }
        const a = msg.ai || {};
        const day = (v) => { const t = Date.parse(String(v || "") + "T00:00:00"); return Number.isFinite(t) ? t : 0; };
        const upd = { ...n, ai: true, aiAt: Date.now(), important: a.important !== false, kind: String(a.kind || "").slice(0, 40), summary: String(a.summary || "").slice(0, 300),
          fromMs: typeof a.from === "string" ? day(a.from) : n.fromMs || 0, untilMs: typeof a.until === "string" ? day(a.until) : n.untilMs || 0, onsite: (Array.isArray(a.onsite) ? a.onsite : []).map(String).slice(0, 60) };
        await cnoteMerge([upd]);
        await cnoteShare([upd]).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "CNOTE_TASKS": { const t = await cnoteTasks(!!msg.force).catch(() => null); sendResponse(t ? { ok: true, tasks: t } : { ok: false }); break; }
      case "CNOTE_REFRESH": {
        if (Date.now() - cnoteRefreshAt < 60000) { sendResponse({ ok: true, skipped: true }); break; } // pressed again within a minute
        cnoteRefreshAt = Date.now();
        await chrome.storage.local.set({ slackPoll: { ...((await chrome.storage.local.get("slackPoll")).slackPoll || {}), at: 0 } });
        const r1 = await slackPoll(true).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        await hubPollClientNotes().catch(() => {});
        sendResponse(r1 || { ok: true });
        break;
      }
      case "SHEET_CSV": {
        // Site monitor › Update from the sheet: a Google Sheet read as CSV with the
        // Google sign-in already in this Chrome profile (the tab in the link: gid).
        const sid = String(msg.url || "").match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
        if (!sid) { sendResponse({ ok: false, error: "That isn't a Google Sheets link." }); break; }
        const gid = (String(msg.url).match(/[#&?]gid=(\d+)/) || [])[1] || "0";
        try {
          const res = await fetch("https://docs.google.com/spreadsheets/d/" + sid[1] + "/export?format=csv&gid=" + gid, { credentials: "include", cache: "no-store" });
          const text = await res.text();
          if (!res.ok || /text\/html/i.test(res.headers.get("content-type") || "") || /^\s*<!doctype html/i.test(text)) { sendResponse({ ok: false, error: "Google didn't hand over the sheet. Sign in to Chrome's Google account that can open it (in this profile), or share it as \"Anyone with the link can view\"." }); break; }
          sendResponse({ ok: true, text: text.slice(0, 2000000) });
        } catch (e) { sendResponse({ ok: false, error: "Couldn't reach Google Sheets (" + String((e && e.message) || e) + ")." }); }
        break;
      }
      case "WP_PHP_START": { sendResponse(await wpPhpStart(msg.urls, !!msg.local).catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "WP_RELAY_COLLECT": { sendResponse((await wpRelayCollect().catch(() => null)) || { state: "" }); break; }
      case "WP_HELPER_SET": {
        await chrome.storage.local.set({ wpHelper: !!msg.on });
        if (msg.on) await wpHelperTake().catch(() => {}); // say "I'm here" to the app straight away
        const ps = await deskFiles({ op: "phpStatus", install: await installId() }, 3000);
        sendResponse({ ok: true, app: !!(ps && ps.ok), oldApp: !!(ps && !ps.ok) });
        break;
      }
      case "SLACK_POLL_NOW": { sendResponse(await slackPoll(true).catch((e) => ({ ok: false, error: String(e && e.message || e) }))); break; }
      case "ASG_CANCEL": {
        const g = await chrome.storage.local.get(ASG_KEY);
        const jobs = Array.isArray(g[ASG_KEY]) ? g[ASG_KEY] : [];
        await chrome.storage.local.set({ [ASG_KEY]: jobs.filter((j) => j && j.id !== msg.id) });
        sendResponse({ ok: true });
        break;
      }
      case "CLICKUP_ADD_ASSIGNEE": {
        // "+ Add someone" in a task row's WHO list.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured", error: "Connect ClickUp first." }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : "";
        const userId = msg.userId ? String(msg.userId) : "";
        if (!taskId || !/^\d+$/.test(userId)) { sendResponse({ ok: false, error: "No task or person." }); break; }
        try {
          await addTaskAssignee(cfg.token, taskId, userId);
          const self = !!(cfg.userId && String(cfg.userId) === userId);
          if (self) { clearFilterCache(); refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {}); } // now yours: it joins your lists
          else await addAssigneeEverywhere(taskId, { id: userId, username: String(msg.name || "") });
          sendResponse({ ok: true, self });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_REMOVE_ASSIGNEE": {
        // The ✕ next to a person in a task row's WHO list. Taking yourself off
        // needs msg.confirmSelf (the task then leaves your list).
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured", error: "Connect ClickUp first." }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : "";
        const userId = msg.userId ? String(msg.userId) : "";
        if (!taskId || !/^\d+$/.test(userId)) { sendResponse({ ok: false, error: "No task or person." }); break; }
        if (cfg.userId && String(cfg.userId) === userId && !msg.confirmSelf) { sendResponse({ ok: false, reason: "self" }); break; }
        try {
          await removeTaskAssignee(cfg.token, taskId, userId);
          if (cfg.userId && String(cfg.userId) === userId) {
            // Took yourself off: the task leaves your lists and totals - rebuild them.
            clearFilterCache();
            refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          } else {
            // Someone else: only their initials change - fix the saved lists in place
            // (no ClickUp calls; the regular refresh confirms it later).
            await dropAssigneeEverywhere(taskId, userId);
          }
          sendResponse({ ok: true, self: !!(cfg.userId && String(cfg.userId) === userId) });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "HUB_MESSAGE": {
        // Clients › Reports › 🔔 Send to a teammate: a notification in THEIR
        // extension (through the Team hub), about something that isn't a task.
        const cfg = await getClickupConfig();
        const userId = msg.userId ? String(msg.userId) : "";
        if (!/^\d+$/.test(userId)) { sendResponse({ ok: false, error: "Pick a person." }); break; }
        if (cfg && cfg.userId && String(cfg.userId) === userId) { sendResponse({ ok: false, error: "That's you." }); break; }
        if (!(await hubUrl())) { sendResponse({ ok: false, error: "The Team hub isn't set up, so messages can't reach other people's extension." }); break; }
        await hubHello(true).catch(() => {});
        const r = await hubCall("nudge", { toUser: userId, taskId: "", taskName: String(msg.title || "").slice(0, 200), taskUrl: "", text: String(msg.text || "").trim().slice(0, 300) });
        if (r && r.ok) { sendResponse({ ok: true }); break; }
        sendResponse({ ok: false, error: r && r.reason === "no-extension" ? "They don't use the extension (or haven't opened it yet), so it can't reach them." : String((r && r.error) || "The Team hub didn't answer.") });
        break;
      }
      case "CLICKUP_NUDGE": {
        // The 🔔 next to a teammate on a task: a reminder shown by THEIR extension
        // (through the Team hub), or - msg.via "clickup" - a ClickUp comment
        // assigned to them, so ClickUp notifies them (for people without the extension).
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "Connect ClickUp first." }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : "";
        const userId = msg.userId ? String(msg.userId) : "";
        if (!taskId || !/^\d+$/.test(userId)) { sendResponse({ ok: false, error: "No task or person." }); break; }
        if (cfg.userId && String(cfg.userId) === userId) { sendResponse({ ok: false, reason: "self", error: "That's you - use ⏰ Remind me in the task's details for your own reminder." }); break; }
        const text = String(msg.text || "").trim().slice(0, 300);
        if (msg.via === "clickup") {
          try {
            const me = cfg.username || "A teammate";
            await postAssignedComment(cfg.token, taskId, "\u23F0 Reminder from " + me + (text ? ": " + text : " - please take a look at this task."), userId);
            sendResponse({ ok: true, via: "clickup" });
          } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
          break;
        }
        if (!(await hubUrl())) { sendResponse({ ok: false, reason: "no-hub", error: "The Team hub isn't set up, so reminders can't reach their extension." }); break; }
        await hubHello(true).catch(() => {});
        const nPayload = { toUser: userId, taskId, taskName: String(msg.taskName || "").slice(0, 200), taskUrl: taskUrlFor(taskId), text };
        let r = await hubCall("nudge", nPayload);
        // "admin only" comes back from a hub whose DEPLOYED copy still has
        // reminders behind its admin gate (the gate has since moved below the
        // public actions). If this person really is an admin - their key is
        // saved - send it again with the key, so "I am already an admin" means
        // what it says instead of being refused.
        if (r && String(r.error || "").toLowerCase() === "admin only" && (await hubAdminKey()))
          r = await hubCall("nudge", nPayload, true);
        if (r && r.ok) { sendResponse({ ok: true, via: "hub" }); break; }
        // An older Team hub script doesn't know the "nudge" action. It says so in
        // one of two ways: "unknown action" if it predates reminders entirely, or
        // "admin only" if it has them but still gated. Either way the answer for
        // the user is the same: the hub needs its new version deploying, and
        // meanwhile the reminder can still go as a ClickUp comment.
        const he = r && r.error ? String(r.error).toLowerCase() : "";
        if (he === "unknown action" || he === "admin only") {
          sendResponse({ ok: false, reason: "old-hub", error: "The Team hub script needs updating (deploy its new version) before reminders can reach their extension." });
          break;
        }
        sendResponse(r || { ok: false, error: "No answer from the Team hub." });
        break;
      }
      case "CLICKUP_EXPORT_SUBTASKS": {
        // Export helper: every subtask of the given tasks (one request per task,
        // so it only runs when someone ticks "include subtasks").
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const ids = Array.isArray(msg.taskIds) ? msg.taskIds.slice(0, 200) : [];
        const subtasks = {};
        const parents = {}; // taskId -> its own parent id (so the export nests correctly)
        const details = {}; // taskId -> name/description/status/due, straight from ClickUp
        let missed = 0;
        // One 429 shouldn't lose the rest of the export: wait what ClickUp asks
        // for (capped) and try that task once more.
        const withRetry = async (fn) => {
          try { return await fn(); } catch (e) {
            if (!e || e.status !== 429) throw e;
            await new Promise((r) => setTimeout(r, Math.min(8000, Number(e.retryAfterMs) || 3000)));
            return fn();
          }
        };
        for (const id of ids) {
          try {
            const tree = await withRetry(() => getTaskTree(cfg.token, String(id), null));
            parents[String(id)] = tree.parent;
            details[String(id)] = tree.self;
            subtasks[String(id)] = tree.subtaskRows;
          } catch (e) {
            subtasks[String(id)] = [];
            missed++;
          }
        }
        // ClickUp's subtask list has no description, so ask for each subtask the
        // export will actually show (capped, so a huge range can't run away).
        if (msg.includeSubtasks !== false) {
          const want = [];
          for (const list of Object.values(subtasks)) {
            for (const st of list) if (st && st.id && !st.description && !details[String(st.id)]) want.push(String(st.id));
          }
          for (const id of want.slice(0, 200)) {
            try {
              const d = await withRetry(() => getTaskDetail(cfg.token, id));
              details[id] = d;
            } catch (e) { missed++; }
          }
        }
        // Names of parents that aren't among these tasks (a subtask in the list
        // whose task isn't), so the client report can show "Task | Sub task".
        const parentNames = {};
        const needNames = [...new Set(Object.values(parents).filter((p) => p && !details[String(p)]).map(String))].slice(0, 60);
        for (const p of needNames) {
          try { const d = await withRetry(() => getTaskDetail(cfg.token, p)); parentNames[p] = d.name || ""; details[p] = details[p] || d; } catch (e) {}
        }
        sendResponse({ ok: true, subtasks, parents, details, missed, parentNames });
        break;
      }
      case "CLICKUP_EXPORT_MY_COMMENTS": {
        // Plain sheet export: your latest comment on each task (for Work File's
        // File: when the task's own File: "..." is empty). One request per task,
        // one retry after a rate limit; unreadable ones are left out.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const ids = [...new Set((Array.isArray(msg.taskIds) ? msg.taskIds : []).map(String))].slice(0, 250);
        const texts = {};
        for (const id of ids) {
          try { texts[id] = await getLatestCommentBy(cfg.token, id, cfg.userId); }
          catch (e) {
            if (e && e.status === 429) {
              await new Promise((r) => setTimeout(r, Math.min(8000, Number(e.retryAfterMs) || 3000)));
              try { texts[id] = await getLatestCommentBy(cfg.token, id, cfg.userId); } catch (e2) {}
            }
          }
        }
        sendResponse({ ok: true, texts });
        break;
      }
      case "CLICKUP_EXPORT_COMMENT_LINKS": {
        // Client report: the links in each task's comments (one request per task,
        // one retry after a rate limit). A task whose comments can't be read is
        // simply left out of the map.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const ids = [...new Set((Array.isArray(msg.taskIds) ? msg.taskIds : []).map(String))].slice(0, 250);
        const links = {};
        for (const id of ids) {
          try { links[id] = await getTaskCommentLinks(cfg.token, id); }
          catch (e) {
            if (e && e.status === 429) {
              await new Promise((r) => setTimeout(r, Math.min(8000, Number(e.retryAfterMs) || 3000)));
              try { links[id] = await getTaskCommentLinks(cfg.token, id); } catch (e2) {}
            }
          }
        }
        sendResponse({ ok: true, links });
        break;
      }
      case "EXPORT_TO_GOOGLE": {
        // Create a Google Sheet / Doc from the export HTML. Asks for the
        // "create files in Drive" permission the first time only.
        try {
          // The export client first (its project can make every link clickable);
          // the older one if that sign-in can't be had, so exports always work.
          let tok = await getExportToken(true).catch(() => null);
          if (!tok) tok = await getFileToken(true);
          if (!tok) { sendResponse({ ok: false, reason: "Google didn't grant permission to create the file." }); break; }
          const r = await createGoogleFile(tok, { name: msg.name || "tasks", html: msg.html || "", csv: msg.csv || "", xlsx: msg.xlsx || "", kind: msg.kind === "docs" ? "docs" : "sheets" });
          // Google files are private by default; share on request so the link works for the team.
          const shared = msg.share === false ? false : await shareAnyoneWithLink(tok, r.id).catch(() => false);
          // A Sheet: make every link in every cell clickable (Sheets API; the file
          // itself already links each cell to its first link).
          const links = msg.kind !== "docs" ? await linkifySheet(tok, r.id).catch((e) => ({ ok: false, error: String((e && e.message) || e) })) : null;
          sendResponse({ ok: true, url: r.url, shared, links });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "ADMIN_STATE": {
        // What the Admin panel needs to draw itself (never the token itself).
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const tok = await decryptJSON(adminEnc, null);
        sendResponse({
          ok: true,
          repo: UPDATE_REPO,
          hasToken: !!(tok && tok.token),
          syncToken: (await getSettings()).adminSyncToken !== false,
          tokenHint: tok && tok.token ? String(tok.token).slice(0, 4) + "…" + String(tok.token).slice(-4) : "",
          version: chrome.runtime.getManifest().version,
        });
        break;
      }
      case "ADMIN_SET_TOKEN": {
        const t = String(msg.token || "").trim();
        if (!t) { await chrome.storage.local.remove("adminEnc"); sendResponse({ ok: true, cleared: true }); break; }
        // Check it works (and that it can see the repo) before saving it.
        try {
          const res = await fetch("https://api.github.com/repos/" + UPDATE_REPO, {
            headers: { Authorization: "Bearer " + t, Accept: "application/vnd.github+json" },
          });
          if (res.status === 401) { sendResponse({ ok: false, error: "GitHub rejected that token." }); break; }
          if (!res.ok) { sendResponse({ ok: false, error: "GitHub said HTTP " + res.status + " for " + UPDATE_REPO + "." }); break; }
          const j = await res.json();
          if (!j || !j.permissions || !j.permissions.push) {
            sendResponse({ ok: false, error: "That token can read the repo but not write to it (needs Contents: read and write)." });
            break;
          }
          await chrome.storage.local.set({ adminEnc: await encryptJSON({ token: t }) });
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "ADMIN_PUBLISH": {
        // Create the GitHub release and attach the package the Admin panel built.
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const saved = await decryptJSON(adminEnc, null);
        const token = saved && saved.token;
        if (!token) { sendResponse({ ok: false, error: "No GitHub token saved." }); break; }
        const version = String(msg.version || "").replace(/^v/, "").trim();
        if (!/^\d+\.\d+(\.\d+)?$/.test(version)) { sendResponse({ ok: false, error: "Version must look like 3.7.0." }); break; }
        const tag = "v" + version;
        // Who gets it: [] = everyone; otherwise ClickUp user ids (people / departments).
        const audience = (Array.isArray(msg.audience) ? msg.audience : []).map(String).filter((x) => /^\d{1,15}$/.test(x));
        const notifyUsers = msg.notify === true;
        try {
          const head = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" };
          const exists = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/tags/" + tag, { headers: head });
          if (exists.ok) { sendResponse({ ok: false, error: tag + " is already published. Use a higher version number." }); break; }
          // Keep the repository in step: bump manifest.json and add this version's
          // CHANGELOG section, so the source matches what was just released.
          let repoUpdated = false;
          let repoError = "";
          if (msg.commit !== false) {
            try {
              await ghPutFile(head, "manifest.json", (text) => {
                const next = text.replace(/("version"\s*:\s*")[^"]+(")/, "$1" + version + "$2");
                return next === text ? null : next;
              }, "v" + version);
              await ghPutFile(head, "CHANGELOG.md", (text) => {
                if (new RegExp("^##\\s+v?" + version.replace(/\./g, "\\.") + "(\\s|$)", "m").test(text)) return null; // already there
                const notes = String(msg.notes || "").trim() || ("- Version " + version);
                const section = "## v" + version + "\n" + notes + "\n\n";
                return text.startsWith("# Changelog")
                  ? text.replace("# Changelog\n\n", "# Changelog\n\n" + section)
                  : section + text;
              }, "Changelog for v" + version);
              repoUpdated = true;
            } catch (e) {
              repoError = String(e && e.message ? e.message : e);
            }
          }
          const body = String(msg.notes || "").trim() || ("Version " + version);
          const create = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases", {
            method: "POST",
            headers: { ...head, "Content-Type": "application/json" },
            // Some people only: a GitHub pre-release, which "latest release" ignores.
            body: JSON.stringify({ tag_name: tag, name: tag, body: msg.critical ? "[critical]\n\n" + body : body, draft: false, prerelease: audience.length > 0 }),
          });
          if (!create.ok) {
            let why = "HTTP " + create.status;
            try { const j = await create.json(); if (j && j.message) why = j.message; } catch (e2) {}
            sendResponse({ ok: false, error: "Couldn't create the release: " + why });
            break;
          }
          const rel = await create.json();
          // Upload the zip as the release asset (raw binary, base64 from the page).
          const bin = Uint8Array.from(atob(String(msg.zipB64 || "")), (c) => c.charCodeAt(0));
          const name = "personal-clickup-manager-" + tag + ".zip";
          const up = await fetch("https://uploads.github.com/repos/" + UPDATE_REPO + "/releases/" + rel.id + "/assets?name=" + encodeURIComponent(name), {
            method: "POST",
            headers: { ...head, "Content-Type": "application/zip" },
            body: bin,
          });
          if (!up.ok) {
            let why = "HTTP " + up.status;
            try { const j = await up.json(); if (j && j.message) why = j.message; } catch (e2) {}
            sendResponse({ ok: false, error: "Release created but the package upload failed (" + why + "). Attach it by hand: " + rel.html_url });
            break;
          }
          let assetUrl = "";
          try { assetUrl = (await up.json()).browser_download_url || ""; } catch (e) {}
          // Tell everyone now: stamp a new "Notify everyone" in the settings file so
          // every copy shows the update within about a minute - unless the admin set
          // a "Don't notify before" time, which is then respected.
          let notified = false;
          try {
            const cur = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
            // Always record the new release in the file; notify now unless a
            // "Don't notify before" time is set (then it's told at that time).
            let pol;
            if (audience.length) {
              // Some people only: `latest` stays as it is for everyone else.
              pol = normalizeUpdatePolicy({ ...(cur.data || UPDATE_POLICY_DEFAULTS),
                preview: { latest: version, zip: assetUrl, url: rel.html_url, cuUserIds: audience, notify: notifyUsers, nonce: Date.now().toString(36), at: Date.now() } });
              notified = notifyUsers ? "some" : "quiet";
            } else {
              pol = normalizeUpdatePolicy({ ...(cur.data || UPDATE_POLICY_DEFAULTS),
                latest: version, zip: assetUrl, url: rel.html_url, important: !!msg.critical, preview: null });
              if (!notifyUsers) { pol.quietFor = version; pol.notifiedAllAt = Date.now(); notified = "quiet"; }
              else if (pol.holdUntil > Date.now()) { pol.quietFor = ""; notified = "held"; }
              else {
                pol.quietFor = "";
                pol.notifyNonce = Date.now().toString(36);
                pol.notifiedAllAt = Date.now();
                notified = true;
              }
            }
            pol.updatedAt = Date.now();
            await ghPutJsonFile(head, UPDATE_POLICY_PATH, pol, cur.sha, (notified === true ? "Notify everyone about " : audience.length ? "Release to some people: " : "Record ") + tag);
            await purgePolicyCdn();
          } catch (e) { notified = false; }
          await chrome.storage.local.remove("updateInfo");
          checkForUpdate(true, false).catch(() => {});
          sendResponse({ ok: true, url: rel.html_url, tag, repoUpdated, repoError, notified });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "ADMIN_RELEASE_ALL": {
        // A release published to some people only: make it a normal release for
        // everyone (msg.notify = with the "Update available" pop-up).
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const saved = await decryptJSON(adminEnc, null);
        if (!saved || !saved.token) { sendResponse({ ok: false, error: "No GitHub token saved." }); break; }
        try {
          const head = { Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" };
          const cur = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
          const pol = normalizeUpdatePolicy(cur.data || UPDATE_POLICY_DEFAULTS);
          const pv = pol.preview;
          if (!pv) { sendResponse({ ok: false, error: "There's no release waiting for everyone." }); break; }
          const tag = "v" + pv.latest;
          const rr = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/tags/" + tag, { headers: head });
          if (!rr.ok) throw new Error("Couldn't find " + tag + " on GitHub (HTTP " + rr.status + ")");
          const rel = await rr.json();
          const pr = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/" + rel.id, {
            method: "PATCH", headers: { ...head, "Content-Type": "application/json" }, body: JSON.stringify({ prerelease: false, make_latest: "true" }),
          });
          if (!pr.ok) throw new Error("GitHub said HTTP " + pr.status);
          const next = normalizeUpdatePolicy({ ...pol, latest: pv.latest, zip: pv.zip, url: pv.url || rel.html_url, preview: null });
          next.updatedAt = Date.now();
          if (msg.notify) { next.quietFor = ""; next.notifyNonce = Date.now().toString(36); next.notifiedAllAt = Date.now(); }
          else { next.quietFor = pv.latest; next.notifiedAllAt = Date.now(); }
          await ghPutJsonFile(head, UPDATE_POLICY_PATH, next, cur.sha, "Release " + tag + " to everyone");
          await purgePolicyCdn();
          await chrome.storage.local.set({ updatePolicy: { at: Date.now(), rawAt: Date.now(), policy: next } });
          sendResponse({ ok: true, version: pv.latest });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "ADMIN_RELEASE_INFO": {
        // For the Admin publish card: departments + known people (ClickUp ids) and
        // any release still limited to some people.
        const settings = await getSettings();
        const deps = await allDepartments(await getClickupConfig().catch(() => null), settings, false);
        const { updatePolicy } = await chrome.storage.local.get("updatePolicy");
        const pol = normalizeUpdatePolicy((updatePolicy && updatePolicy.policy) || {});
        let people = [];
        const u = await hubCall("users", {}, true).catch(() => null);
        if (u && u.ok) people = (u.users || []).filter((x) => x.cuUserId).map((x) => ({ id: String(x.cuUserId), name: x.name, version: x.version }));
        sendResponse({ ok: true, departments: deps.map((d) => ({ id: d.id, name: d.name, users: (d.users || []).map((x) => ({ id: String(x.id), name: x.name })) })), people, preview: pol.preview });
        break;
      }
      case "FLOAT_TRACKER_OPEN": {
        // The floating tracker lives in a small pinned tab (tracker.html): Chrome
        // only opens an always-on-top window after a click on that page, and
        // closes it with that page. Reuse the tab when it's already there.
        try {
          const url = chrome.runtime.getURL("tracker.html");
          const [back] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          const backId = back && !String(back.url || "").startsWith(url) ? back.id : "";
          const found = await chrome.tabs.query({ url: url + "*" });
          if (found[0]) {
            await chrome.tabs.update(found[0].id, { active: true, url: url + "?back=" + backId });
            await chrome.windows.update(found[0].windowId, { focused: true }).catch(() => {});
          } else {
            await chrome.tabs.create({ url: url + "?back=" + backId, pinned: true, index: 0, active: true });
          }
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "TASKFILES_SYNC": {
        sendResponse(await syncTaskFiles());
        break;
      }
      case "DRIVE_FILES": {
        // Drive Sync card > "Where is it saved?": the files in the hidden
        // app-data area and the Google account they belong to. No contents.
        try {
          const tok = await getValidToken(false);
          if (!tok) { sendResponse({ ok: false, reason: "signed-out" }); break; }
          const files = await listDriveFiles(tok);
          const account = await getDriveAccount().catch(() => "");
          const quota = await driveQuota(tok).catch(() => null);
          sendResponse({ ok: true, files, account: account || "", quota });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "FLOAT_TOGGLE": {
        sendResponse({ ok: true });
        toggleFloat().catch((e) => diagLog("auto-float", "toggle: " + (e && e.message ? e.message : e)));
        break;
      }
      case "FLOAT_REOPEN": {
        // The floating window was dragged partly behind the taskbar / off the
        // screen and closed itself: open it again (at Chrome's own spot - see
        // tracker.js watchPlacement) through the pinned Tracker tab.
        sendResponse({ ok: true });
        setTimeout(() => { autoFloatNow().catch((e) => diagLog("auto-float", "reopen: " + (e && e.message ? e.message : e))); }, 400);
        break;
      }
      case "TRACKER_PROGRESS": {
        // The tracker saw a different running task than its numbers: recompute.
        const cfg = await getClickupConfig().catch(() => null);
        await maybeNotifyRunningTask(cfg).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case "DIAG_REPORT": {
        try { sendResponse({ ok: true, text: await buildDiagReport(msg.page) }); }
        catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "ADMIN_SITES_GET": {
        // The published team list (decrypted with this workspace) + this copy's own.
        const cfg = await getClickupConfig().catch(() => null);
        const { updatePolicy } = await chrome.storage.local.get("updatePolicy");
        const want = Number(updatePolicy && updatePolicy.policy && updatePolicy.policy.sitesAt) || 0;
        const file = await readTeamSitesFile(want).catch(() => null);
        const published = cfg && cfg.teamId ? await decryptTeamSites(file, cfg.teamId) : null;
        const mine = cleanTeamSites((await getSiteMonitorConfig()).sites);
        sendResponse({ ok: true, connected: !!(cfg && cfg.teamId), published, publishedAt: file ? Number(file.updatedAt) || 0 : 0, mine });
        break;
      }
      case "ADMIN_SITES_PUBLISH": {
        // Encrypt the list with this ClickUp workspace, save it to the repo and
        // announce it in update-policy.json (sitesAt) so every copy picks it up.
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const saved = await decryptJSON(adminEnc, null);
        if (!saved || !saved.token) { sendResponse({ ok: false, error: "Save a GitHub token first (GitHub access, below)." }); break; }
        const cfg = await getClickupConfig().catch(() => null);
        if (!cfg || !cfg.teamId) { sendResponse({ ok: false, error: "Connect ClickUp first: the list is locked to your ClickUp workspace." }); break; }
        const sites = cleanTeamSites(msg.sites);
        if (!sites.length) { sendResponse({ ok: false, error: "No valid sites in the list." }); break; }
        const mode = msg.mode === "match" ? "match" : "add";
        const to = (Array.isArray(msg.to) ? msg.to : []).map(String).filter((x) => /^\d{1,15}$/.test(x)).slice(0, 300);
        try {
          const head = { Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" };
          const now = Date.now();
          const cur = await ghGetJsonFile(head, TEAM_SITES_PATH);
          await ghPutJsonFile(head, TEAM_SITES_PATH, { v: 1, updatedAt: now, enc: await encryptWithPassphrase({ sites, mode, to }, teamSitesPass(cfg.teamId)) },
            cur.sha, "Update team client sites");
          const pol = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
          const next = normalizeUpdatePolicy({ ...(pol.data || UPDATE_POLICY_DEFAULTS), sitesAt: now });
          next.updatedAt = now;
          await ghPutJsonFile(head, UPDATE_POLICY_PATH, next, pol.sha, "Announce updated team client sites");
          await purgePolicyCdn();
          fetch("https://purge.jsdelivr.net/gh/" + UPDATE_REPO + "@main/" + TEAM_SITES_PATH, { cache: "no-store" }).catch(() => {});
          // This copy takes them straight away (it is the source when matching).
          const added = mode === "match" ? 0 : await applyTeamSites(sites);
          await chrome.storage.local.set({ teamSites: { key: now + ":" + cfg.teamId, status: "ok", triedAt: now, at: now, list: sites, added } });
          sendResponse({ ok: true, count: sites.length, added, at: now });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "ADMIN_TEAM_REMINDER": {
        // Reminders › 📣 For everyone: put this reminder (or its removal) in the
        // shared settings file. Needs the admin GitHub token.
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const saved = await decryptJSON(adminEnc, null);
        if (!saved || !saved.token) { sendResponse({ ok: false, error: "Save the GitHub token first (Admin › GitHub access)." }); break; }
        const r = msg.rem || {};
        const id = /^[\w-]{3,60}$/.test(String(r.id || "")) ? String(r.id) : "";
        if (!id) { sendResponse({ ok: false, error: "This reminder has no id." }); break; }
        try {
          const head = { Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" };
          const cur = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
          const base = normalizeUpdatePolicy(cur.data || UPDATE_POLICY_DEFAULTS);
          const at = new Date(Number(r.at) || Date.now());
          const v = Date.now();
          const entry = msg.remove ? { id, removed: true, v } : { id, text: String(r.text || "").trim().slice(0, 300), h: at.getHours(), m: at.getMinutes(),
            // "On set dates" has to survive the trip, or sending out a reminder
            // set for the 17th and 25th would quietly become "weekdays" for
            // everyone. normTeamRems drops it back to weekdays only if the days
            // are missing.
            repeat: ["daily", "weekdays", "weekly", "dates", "days"].includes(r.repeat) ? r.repeat : "weekdays", dates: remDates(r.dates), days: remDays(r.days), dow: at.getDay(), sound: r.sound || "normal", v, force: !!msg.force };
          const list = normTeamRems(base.teamReminders).filter((t) => t.id !== id);
          list.push(entry);
          const next = normalizeUpdatePolicy({ ...(cur.data || UPDATE_POLICY_DEFAULTS), teamReminders: list });
          next.updatedAt = v;
          await ghPutJsonFile(head, UPDATE_POLICY_PATH, next, cur.sha, msg.remove ? "Stop a reminder for everyone" : "Send a reminder to everyone");
          await purgePolicyCdn();
          await chrome.storage.local.set({ updatePolicy: { at: v, rawAt: v, policy: next } });
          // This copy already has it as it should be: mark it applied.
          const g2 = await chrome.storage.local.get(["teamRemApplied", "reminders"]);
          const ap = { ...((g2.teamRemApplied && typeof g2.teamRemApplied === "object") ? g2.teamRemApplied : {}) };
          const mine = (Array.isArray(g2.reminders) ? g2.reminders : []).find((x) => x && x.id === id);
          ap[id] = { v, sig: msg.remove ? "" : remSig(mine) };
          await chrome.storage.local.set({ teamRemApplied: ap });
          sendResponse({ ok: true, team: normTeamRems(next.teamReminders) });
        } catch (e) { sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }); }
        break;
      }
      case "ADMIN_POLICY_GET": {
        // Current update-notification settings, read straight from the repo when a
        // token is saved (no CDN delay), else from the public file.
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const saved = await decryptJSON(adminEnc, null);
        try {
          let raw = null;
          if (saved && saved.token) {
            const r = await ghGetJsonFile({ Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" }, UPDATE_POLICY_PATH);
            raw = r.data;
          } else {
            const res = await fetch(UPDATE_POLICY_URL + "?t=" + Date.now(), { cache: "no-store" });
            if (res.ok) raw = await res.json();
          }
          sendResponse({ ok: true, policy: normalizeUpdatePolicy(raw || UPDATE_POLICY_DEFAULTS), exists: !!raw });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "ADMIN_POLICY_SET": {
        // Save the update-notification settings to update-policy.json in the repo;
        // msg.notifyNow also stamps a new nonce so every copy shows the update
        // prompt on its next check. Needs the admin GitHub token.
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const saved = await decryptJSON(adminEnc, null);
        if (!saved || !saved.token) { sendResponse({ ok: false, error: "Save a GitHub token first (GitHub access, below)." }); break; }
        try {
          const head = { Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" };
          const cur = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
          const next = normalizeUpdatePolicy({ ...(cur.data || UPDATE_POLICY_DEFAULTS), ...(msg.policy || {}) });
          // Put the newest release in the file (asked with the admin's own token, so
          // not from the office's shared anonymous allowance), so everyone's copy can
          // act on it without asking GitHub's rate-limited API.
          try {
            const rr = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest", { headers: head, cache: "no-store" });
            if (rr.ok) {
              const rj = await rr.json();
              const za = (Array.isArray(rj.assets) ? rj.assets : []).find((x) => /\.zip$/i.test(x.name || ""));
              const withRel = normalizeUpdatePolicy({ ...next, latest: String(rj.tag_name || "").replace(/^v/i, ""),
                zip: za ? za.browser_download_url : "", url: rj.html_url || "" });
              next.latest = withRel.latest; next.zip = withRel.zip; next.url = withRel.url;
            }
          } catch (e) {}
          next.updatedAt = Date.now();
          if (msg.notifyNow) { next.notifyNonce = Date.now().toString(36); next.notifiedAllAt = Date.now(); }
          await ghPutJsonFile(head, UPDATE_POLICY_PATH, next, cur.sha,
            msg.notifyNow ? "Notify everyone about the latest version" : "Update notification settings");
          await purgePolicyCdn(); // everyone's once-a-minute check sees it now
          // This copy follows the new settings straight away too.
          await chrome.storage.local.set({ updatePolicy: { at: Date.now(), rawAt: Date.now(), policy: next } });
          scheduleUpdateAlarm();
          sendResponse({ ok: true, policy: next });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "LIST_RELEASES": {
        // Every published version, newest first - the updater page lists them so
        // a bad release can be rolled back.
        try {
          const res = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases?per_page=30", {
            headers: { Accept: "application/vnd.github+json" },
          });
          if (!res.ok) throw new Error("GitHub said HTTP " + res.status);
          const list = (await res.json()) || [];
          // A pre-release is a release for some people only: list it just for them.
          const mine = await effectivePolicy(await fetchUpdatePolicy()).catch(() => null);
          const myPreview = mine && mine.previewForMe ? "v" + mine.latest : "";
          sendResponse({
            ok: true,
            releases: list.filter((r) => r && !r.draft && (!r.prerelease || r.tag_name === myPreview)).map((r) => {
              const zip = (r.assets || []).find((a) => /\.zip$/i.test(a.name || ""));
              return {
                version: String(r.tag_name || "").replace(/^v/, ""),
                name: r.name || r.tag_name || "",
                publishedAt: r.published_at || "",
                prerelease: !!r.prerelease,
                url: r.html_url || "",
                zip: zip ? zip.browser_download_url : "",
              };
            }).filter((r) => r.version && r.zip),
          });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_BULK_ONE": {
        // Bulk edit tab: change ONE task and report its old values (for Undo).
        // msg.change = { kind: "due", mode: "set"|"shift"|"clear", dayMs, days }
        //            | { kind: "status", value } | { kind: "priority", value: "urgent|high|normal|low|none" }
        //            | { kind: "estimate", ms } | { kind: "restore", before }.
        // msg.assignee (optional): whose tasks this batch is on. Empty = mine. When
        // it is somebody else's, the optional workspace Admin token does the read
        // and the write, because a personal token cannot edit another person's task.
        // msg.comment (optional): the SAME line posted as a ClickUp comment on
        // this task, so a batch change is explained in one place - "Due date
        // changed because ...". Added AFTER the change, so a task is never
        // commented on when its change failed, and a comment that fails never
        // loses the change.
        // No refresh here: the tab asks for one refresh when the batch is done.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        const ch = msg.change || {};
        if (!taskId) { sendResponse({ ok: false, reason: "no-task" }); break; }
        const scopeId = cuScopeKey(cfg.userId, msg.assignee);
        const otherScope = scopeId !== String(cfg.userId == null ? "" : cfg.userId);
        const token = cuScopeToken(cfg, cfg.userId, msg.assignee);
        const PRIO = { urgent: 1, high: 2, normal: 3, low: 4, none: null };
        const put = async (body) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const res = await cuRawFetch(token, "https://api.clickup.com/api/v2/task/" + encodeURIComponent(taskId), {
              method: "PUT", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify(body),
            });
            if (res.status === 429) {
              const wait = Math.min(60, Number(res.headers.get("Retry-After")) || 20);
              await new Promise((z) => setTimeout(z, wait * 1000));
              continue;
            }
            if (!res.ok) {
              let why = "HTTP " + res.status;
              try { const j = await res.json(); if (j && (j.err || j.error)) why = j.err || j.error; } catch (e) {}
              throw new Error(why);
            }
            return;
          }
          throw new Error("ClickUp is busy (rate limit) - try again in a minute");
        };
        try {
          const task = await getTaskById(token, taskId);
          if (!task) throw new Error("task not found");
          const before = {
            dueDateMs: task.dueDateMs || null, dueDateHasTime: task.dueDateHasTime != null ? !!task.dueDateHasTime : null,
            status: task.status || "", priority: task.priority || "none", estimateMs: Number(task.estimateMs) || 0,
            startDateMs: task.startDateMs || null,
          };
          let body = null;
          if (ch.kind === "due") {
            if (ch.mode === "clear") body = { due_date: null };
            else if (ch.mode === "shift") {
              if (!before.dueDateMs) { sendResponse({ ok: false, skipped: true, error: "has no due date to move" }); break; }
              body = { due_date: before.dueDateMs + Math.round(Number(ch.days) || 0) * 86400000 };
            } else body = { due_date: shiftDueToDay(before.dueDateMs, Number(ch.dayMs)) };
            if (body.due_date && before.dueDateHasTime != null) body.due_date_time = before.dueDateHasTime;
          } else if (ch.kind === "start") {
            // Start date: set a day (noon if it had none) / shift / clear.
            if (ch.mode === "clear") body = { start_date: null };
            else if (ch.mode === "shift") {
              if (!before.startDateMs) { sendResponse({ ok: false, skipped: true, error: "has no start date to move" }); break; }
              body = { start_date: before.startDateMs + Math.round(Number(ch.days) || 0) * 86400000 };
            } else body = { start_date: shiftDueToDay(before.startDateMs, Number(ch.dayMs)) };
          } else if (ch.kind === "status") body = { status: String(ch.value || "") };
          else if (ch.kind === "priority") body = { priority: PRIO[String(ch.value || "none").toLowerCase()] ?? null };
          else if (ch.kind === "estimate") body = { time_estimate: Math.max(0, Math.round(Number(ch.ms) || 0)) };
          else if (ch.kind === "restore" && ch.before) {
            const b = ch.before;
            body = { due_date: b.dueDateMs || null, status: b.status || undefined, priority: PRIO[String(b.priority || "none").toLowerCase()] ?? null, time_estimate: Number(b.estimateMs) || 0 };
            if (b.dueDateMs && b.dueDateHasTime != null) body.due_date_time = !!b.dueDateHasTime;
            // Older Undo records (before start dates were covered) mustn't clear it.
            if ("startDateMs" in b) body.start_date = b.startDateMs || null;
          }
          if (!body) throw new Error("nothing to change");
          await put(body);
          // Every card shows the change at once (the refresh afterwards confirms).
          try {
            const f = {};
            if (body.status) { f.status = body.status; f.done = /^(complete|done|closed)$/i.test(body.status); }
            if ("time_estimate" in body) f.estimateMs = Number(body.time_estimate) || 0;
            if ("priority" in body) { const nm = Object.keys(PRIO).find((k) => PRIO[k] === body.priority); f.priority = nm && nm !== "none" ? nm : ""; }
            if (Object.keys(f).length) await patchStateTask(taskId, f);
            if ("due_date" in body) await patchStateDue(taskId, Number(body.due_date) || 0);
          } catch (pe) {}
          let comment = null, commentError = null;
          const cText = String(msg.comment || "").replace(/\s+/g, " ").trim().slice(0, 5000);
          if (cText) {
            for (let attempt = 0; attempt < 3; attempt++) {
              try { await postTaskComment(token, taskId, cText); comment = "ok"; break; }
              catch (ce) {
                // ClickUp is per-token rate limited, and a batch of N tasks makes
                // 2N calls; wait it out rather than losing the comment.
                if (ce && ce.status === 429 && attempt < 2) {
                  await new Promise((z) => setTimeout(z, Math.min(60000, Number(ce.retryAfterMs) || 20000)));
                  continue;
                }
                comment = "no";
                commentError = String(ce && ce.message ? ce.message : ce).slice(0, 200);
                break;
              }
            }
          }
          sendResponse({ ok: true, before, comment, commentError, otherScope });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_MOVE_DUE": {
        // Wrap-up "→ Tomorrow": move a task's due date to msg.dayMs, keeping its
        // time of day (and ClickUp's date-only vs timed flag).
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const taskId = msg.taskId ? String(msg.taskId) : null;
        const dayMs = Number(msg.dayMs);
        if (!taskId || !Number.isFinite(dayMs)) { sendResponse({ ok: false, reason: "bad-args" }); break; }
        try {
          const task = await getTaskById(cfg.token, taskId);
          const due = shiftDueToDay(task && task.dueDateMs, dayMs);
          await setTaskDueDate(cfg.token, taskId, due, task ? task.dueDateHasTime : null);
          clearFilterCache();
          await patchStateDue(taskId, due).catch(() => {}); // every card shows it at once
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, dueDateMs: due });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_REFRESH": {
        clearFilterCache();
        // The ↻ / Refresh now buttons: find each week's Extra Task afresh too.
        if (msg.manual) extraTaskCache.clear();
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
        // A rate-limited build that just failed: say so once (the page stops
        // waiting), then the next Load starts afresh.
        if (!forceFresh && lastFilterError.has(key)) { const err = lastFilterError.get(key); lastFilterError.delete(key); sendResponse({ ok: false, reason: "fetch-failed", error: err }); break; }
        const run = (async () => {
          const stop = startKeepAlive();
          try {
            const data = await computeFilterData(cfg, settings, assigneeIds, fromTs, toTs);
            cacheFilterResult(key, data);
          } catch (e) {
            const err = String(e && e.message ? e.message : e);
            // A rate-limit miss isn't remembered (the next Load tries again); other
            // failures only for 15 seconds - it used to stick for 5 minutes.
            if (!(e && e.status === 429)) filterCache.set(key, { at: Date.now() - FILTER_CACHE_MS + 15000, data: null, error: err });
            else filterCache.delete(key);
            lastFilterError.set(key, err);
          } finally {
            stop();
            filterBuilds.delete(key);
          }
        })();
        filterBuilds.set(key, run);
        sendResponse({ ok: true, data: null, building: true });
        break;
      }
      case "DEV_CMD": {
        // dev.js. Admin = the publishing (GitHub) token is saved on this copy;
        // admin commands are refused here for anyone else.
        const { adminEnc } = await chrome.storage.local.get("adminEnc");
        const admin = !!adminEnc;
        const cmd = String(msg.cmd || "");
        if (cmd === "whoami") {
          const cfg = await getClickupConfig().catch(() => null);
          sendResponse({ ok: true, admin, user: (cfg && (cfg.username || cfg.email)) || "", team: (cfg && cfg.teamName) || "", version: chrome.runtime.getManifest().version });
          break;
        }
        if (cmd === "refresh") {
          clearFilterCache();
          const r = await refreshClickup({ includeTasks: true, forceWeekly: true, forceWeeks: true }).catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e) }));
          sendResponse({ ok: !!(r && r.ok !== false), error: r && r.error });
          break;
        }
        if (cmd === "autorun-start") {
          const cfg = await getClickupConfig().catch(() => null);
          const ids = (Array.isArray(msg.ids) ? msg.ids : []).map(String).filter(Boolean).slice(0, 30);
          if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, error: "Connect ClickUp first." }); break; }
          if (!ids.length) { sendResponse({ ok: false, error: "No tasks picked." }); break; }
          const names = msg.names && typeof msg.names === "object" ? msg.names : {};
          const { autoCompleteTasks: ac } = await chrome.storage.local.get("autoCompleteTasks");
          const marks = { ...(ac || {}) };
          for (const id of ids) if (!marks[id]) marks[id] = { name: names[id] || "", at: Date.now() };
          await chrome.storage.local.set({ autoRunQueue: { ids, names, total: ids.length, current: ids[0], at: Date.now() }, autoCompleteTasks: marks });
          try {
            await startQueuedTask(cfg, ids[0], "Auto-run queue (1 of " + ids.length + ")");
            clearFilterCache();
            setTimeout(() => { refreshClickup({ includeTasks: true }).catch(() => {}); }, 1500);
            sendResponse({ ok: true });
          } catch (e) {
            await chrome.storage.local.remove("autoRunQueue");
            sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
          }
          break;
        }
        if (cmd === "autorun-add") {
          // More tasks at the end of the queue that's already running (each runs
          // when the one before it completes). Tasks already in it are skipped.
          const { autoRunQueue: q } = await chrome.storage.local.get("autoRunQueue");
          if (!q || !Array.isArray(q.ids) || !q.ids.length) { sendResponse({ ok: false, none: true, error: "No queue is running." }); break; }
          const names = msg.names && typeof msg.names === "object" ? msg.names : {};
          const room = Math.max(0, 30 - q.ids.length);
          const add = (Array.isArray(msg.ids) ? msg.ids : []).map(String).filter((id) => id && !q.ids.includes(id)).filter((id, i, a) => a.indexOf(id) === i).slice(0, room);
          if (!add.length) { sendResponse({ ok: false, error: room ? "Those tasks are already in the queue." : "The queue is full (30 tasks)." }); break; }
          const { autoCompleteTasks: ac } = await chrome.storage.local.get("autoCompleteTasks");
          const marks = { ...(ac || {}) };
          for (const id of add) if (!marks[id]) marks[id] = { name: names[id] || "", at: Date.now() };
          const next = { ...q, ids: q.ids.concat(add), names: { ...(q.names || {}), ...names }, total: (Number(q.total) || q.ids.length) + add.length };
          await chrome.storage.local.set({ autoRunQueue: next, autoCompleteTasks: marks });
          sendResponse({ ok: true, added: add.length, total: next.total, done: next.total - next.ids.length });
          break;
        }
        if (cmd === "autorun-set-waiting") {
          // The tasks still WAITING in a running queue, in a new order (the numbered
          // boxes edit them live). The one running now (ids[0]) is never touched;
          // a task taken out loses the auto-complete mark the queue gave it.
          const { autoRunQueue: q } = await chrome.storage.local.get("autoRunQueue");
          if (!q || !Array.isArray(q.ids) || !q.ids.length) { sendResponse({ ok: false, none: true, error: "No queue is running." }); break; }
          const names = msg.names && typeof msg.names === "object" ? msg.names : {};
          const run = String(q.ids[0]);
          const waiting = (Array.isArray(msg.waiting) ? msg.waiting : []).map(String).filter((id) => id && id !== run).filter((id, i, a) => a.indexOf(id) === i).slice(0, 29);
          const done = (Number(q.total) || q.ids.length) - q.ids.length;
          const gone = q.ids.slice(1).map(String).filter((id) => !waiting.includes(id));
          const { autoCompleteTasks: ac } = await chrome.storage.local.get("autoCompleteTasks");
          const marks = { ...(ac || {}) };
          for (const id of gone) delete marks[id];
          for (const id of waiting) if (!marks[id]) marks[id] = { name: names[id] || (q.names || {})[id] || "", at: Date.now() };
          const next = { ...q, ids: [run].concat(waiting), names: { ...(q.names || {}), ...names }, total: done + 1 + waiting.length };
          await chrome.storage.local.set({ autoRunQueue: next, autoCompleteTasks: marks });
          sendResponse({ ok: true, total: next.total, done });
          break;
        }
        if (cmd === "autorun-stop") {
          await chrome.storage.local.remove("autoRunQueue");
          sendResponse({ ok: true });
          break;
        }
        if (!admin) { sendResponse({ ok: false, unknown: true }); break; }
        if (cmd === "policy") {
          const p = await fetchUpdatePolicy().catch(() => null);
          const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
          sendResponse({ ok: !!p, policy: p, info: ui || null });
          break;
        }
        if (cmd === "autoupdate") {
          // Run the automatic update now (no waiting for the minute alarm or a retry gap).
          const { autoUpdateState: s0 } = await chrome.storage.local.get("autoUpdateState");
          if (s0) { delete s0.lastTry; await chrome.storage.local.set({ autoUpdateState: s0 }); }
          await checkForUpdate(true).catch(() => {});
          const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
          if (!ui || !ui.newer) { sendResponse({ ok: true, upToDate: true, current: chrome.runtime.getManifest().version, latest: ui && ui.latest }); break; }
          await maybeAutoUpdate().catch(() => {});
          const { autoUpdateState: s1 } = await chrome.storage.local.get("autoUpdateState");
          sendResponse({ ok: true, latest: ui.latest, state: s1 || null });
          break;
        }
        if (cmd === "cacheclear") {
          clearFilterCache();
          clearTaskTreeCache();
          await chrome.storage.local.remove(["cuClientNames", "devPipeline", "cuWaitCache2"]).catch(() => {});
          refreshClickup({ includeTasks: true, forceWeekly: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        sendResponse({ ok: false, unknown: true });
        break;
      }
      case "CLICKUP_CLIENT_NAMES": {
        // Every client in the workspace for the Explore Client dropdown. Kept for a
        // day: the list of clients rarely changes and building it costs requests.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const settings = await getSettings();
        const level = settings.cuClientLevel || "auto";
        const { cuClientNames: cached } = await chrome.storage.local.get("cuClientNames");
        const fresh = cached && cached.v === 2 && cached.teamId === String(cfg.teamId) && cached.level === level && Array.isArray(cached.names) && cached.names.length &&
          Date.now() - (cached.at || 0) < 24 * 3600 * 1000;
        if (fresh && !msg.force) { sendResponse({ ok: true, names: cached.names }); break; }
        // Every client, from several sources so the list is never empty:
        //  1. the Folders the user's tasks are in + everything shared with them
        //     (a shared "All SEO Clients" Folder isn't in any Space they belong
        //     to, so the workspace walk below never sees it),
        //  2. the workspace's Folders / Lists in the user's Spaces (the "Client
        //     Name" field can't be listed that way, so that setting lists Lists),
        //  3. the "Client Name" dropdown field's own options,
        //  4. every client the extension has already seen in its task data.
        let names = [], error = "";
        const r0 = await getOpenTasks(cfg, false).catch(() => null);
        const myTasks = (r0 && r0.data && r0.data.tasks) || [];
        const folderIds = [], listIds = [];
        for (const t of myTasks) {
          const c = (t && t.container) || {};
          if (c.folderId && !folderIds.includes(c.folderId)) folderIds.push(c.folderId);
          if (c.listId && !listIds.includes(c.listId)) listIds.push(c.listId);
        }
        try { names = await listReachableClients(cfg.token, cfg.teamId, folderIds, level); }
        catch (e) { error = String(e && e.message ? e.message : e); }
        try { names = names.concat((await listWorkspaceClients(cfg.token, cfg.teamId, level === "field" ? "list" : level)) || []); }
        catch (e) { if (!error) error = String(e && e.message ? e.message : e); }
        try {
          const opts = await listClientFieldOptions(cfg.token, listIds);
          // Field-level workspaces name clients by the field: put those first.
          names = level === "field" || !names.length ? opts.concat(names) : names.concat(opts);
        } catch (e) { if (!error) error = String(e && e.message ? e.message : e); }
        if (!names.length) {
          const g = await chrome.storage.local.get(["clickupState", "insOpenCache", "devPipeline", "perfHistory"]).catch(() => ({}));
          const st = g.clickupState || {};
          const rows = [];
          for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek, st.tomorrow]) if (b) for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) rows.push(...(b[k] || []));
          rows.push(...((g.insOpenCache && g.insOpenCache.tasks) || []), ...((g.devPipeline && g.devPipeline.tasks) || []), ...((g.perfHistory && g.perfHistory.done) || []));
          for (const t of rows) { const c = String((t && t.client) || "").trim(); if (c && !/extra tasks?|daily tracking/i.test(c)) names.push(c); }
        }
        // One per client (spelling differences of the same name), sorted.
        const seenKeys = new Set(), uniq = [];
        for (const n of names) { const k = String(n).toLowerCase().replace(/[^a-z0-9]+/g, ""); if (k && !seenKeys.has(k)) { seenKeys.add(k); uniq.push(n); } }
        uniq.sort((a, b) => String(a).replace(/^[^a-z0-9]+/i, "").localeCompare(String(b).replace(/^[^a-z0-9]+/i, "")));
        if (uniq.length && !error) await chrome.storage.local.set({ cuClientNames: { v: 2, at: Date.now(), teamId: String(cfg.teamId), level, names: uniq } }); // v2: shared Folders included
        if (!uniq.length && cached && Array.isArray(cached.names) && cached.names.length) { sendResponse({ ok: true, names: cached.names, error }); break; }
        sendResponse({ ok: uniq.length > 0, names: uniq, error });
        break;
      }
      case "OPEN_TAB_GROUP": {
        // "Open in a tab group": a list's ClickUp tasks as tabs in one named Chrome
        // tab group (a week, a day, a client...), next to the tab the user is on.
        const urls = [...new Set((Array.isArray(msg.urls) ? msg.urls : []).map(String).filter((u) => /^https:\/\/app\.clickup\.com\//.test(u)))].slice(0, 60);
        if (!urls.length) { sendResponse({ ok: false, reason: "no-tasks" }); break; }
        try {
          const [cur] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
          const winId = cur && cur.windowId;
          const ids = [];
          for (const [i, url] of urls.entries()) {
            const t = await chrome.tabs.create({ url, active: i === 0, ...(winId != null ? { windowId: winId } : {}), ...(cur && cur.index != null ? { index: cur.index + 1 + i } : {}) });
            ids.push(t.id);
          }
          const groupId = await chrome.tabs.group({ tabIds: ids, ...(winId != null ? { createProperties: { windowId: winId } } : {}) });
          const colors = ["blue", "green", "purple", "cyan", "orange", "pink", "yellow", "red", "grey"];
          const color = colors.includes(msg.color) ? msg.color : "blue";
          if (chrome.tabGroups) await chrome.tabGroups.update(groupId, { title: String(msg.title || "Tasks").slice(0, 60), color, collapsed: false }).catch(() => {});
          sendResponse({ ok: true, opened: ids.length, capped: (msg.urls || []).length > 60 });
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
        }
        break;
      }
      case "CLICKUP_TASK_INDEX": {
        // Explore › Find these tasks. Not built yet (or rebuilding): starts it and
        // answers at once with state "building" - the page follows cuTaskIndex.
        // Built: brings it up to date (what changed since, usually one request)
        // and answers "ready"; the page reads the rows from IndexedDB itself.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const settings = await getSettings();
        const { cuTaskIndex: m } = await chrome.storage.local.get("cuTaskIndex");
        const run = syncTaskIndex({ rebuild: !!msg.rebuild, maxAgeMs: msg.force ? 0 : 5 * 60000 });
        if (msg.rebuild || tixNeedsBuild(m, cfg, settings)) { run.catch(() => {}); sendResponse({ ok: true, state: "building" }); break; }
        const r = await run.catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
        sendResponse({ ...r, state: "ready" });
        break;
      }
      case "SLACK_AWAY_SET": { sendResponse(await slackSetPresence(msg.presence === "away" ? "away" : "auto").catch((e) => ({ ok: false, error: String((e && e.message) || e) }))); break; }
      case "SLACK_AHEAD_SYNC": { sendResponse(await slackAheadSync(true).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))); break; }
      case "SLACK_AHEAD_CANCEL": { sendResponse(await slackAheadCancel(String(msg.key || "")).catch((e) => ({ ok: false, error: String((e && e.message) || e) }))); break; }
      case "SLACK_OUT_NOW": {
        // Sent now: today's scheduled one (if Slack hasn't posted it yet) is cancelled, so it isn't posted twice.
        { const key = ymdLocal(Date.now()) + ":" + (msg.kind === "in" ? "in" : "out"); const sa = ((await chrome.storage.local.get("slackAhead")).slackAhead || {})[key]; if (sa && !sa.cancelled && sa.postAt > Date.now()) await slackAheadCancel(key).catch(() => {}); }
        const g = await chrome.storage.local.get("slackOut"); sendResponse(await slackOutPost({ ...(g.slackOut || {}), ...(msg.cfg || {}) }, "button", msg.kind === "in" ? "in" : "out").catch((e) => ({ ok: false, error: String((e && e.message) || e) }))); break; }
      case "DAILY_UPDATE_SEND": { sendResponse(await sendDailyUpdate(msg.text, "button").catch((e) => ({ ok: false, error: String((e && e.message) || e) }))); break; }
      case "CLICKUP_DONE_TODAY": {
        // Wrap-up page's Daily Tasks Update: every task you closed today, in every
        // project, with its client and the links in its description. Asked when the
        // page opens / Refresh is pressed (kept a minute), never on a timer.
        sendResponse(await getDoneToday(!!msg.force));
        break;
      }
      case "ARCHIVED_GET": {
        let r = await archiveWatch(!!msg.force).catch(() => null);
        if (!r) r = (await chrome.storage.local.get("cuArchived")).cuArchived || null;
        sendResponse({ ok: true, data: r });
        break;
      }
      case "CLICKUP_WEEK_AT": {
        // This week by day's ‹ / ›: a week's per-day breakdown (msg.offset weeks from this one).
        sendResponse(await weekAtOffset(msg.offset, !!msg.force).catch((e) => ({ ok: false, error: String((e && e.message) || e) })));
        break;
      }
      case "HOLD_CONTEXT": {
        // task-panel.js's AI check: the task, its parent and the parent's other steps.
        try {
          const cfg = await getClickupConfig();
          const st = (await getClickupState().catch(() => null)) || {};
          if (!cfg || !cfg.token || st.rateLimitedUntil > Date.now()) { sendResponse({ ok: false, error: "ClickUp is busy - try again in a minute." }); break; }
          const t = await getTaskHoldInfo(cfg.token, String(msg.id));
          const p = t && t.parentId ? await getTaskHoldInfo(cfg.token, t.parentId, { subs: true }).catch(() => null) : null;
          sendResponse({ ok: !!t, t, p, me: cfg.userId != null ? String(cfg.userId) : "" });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      }
      case "AR_STATUS": {
        // ar-status.js: what Agent Router offers right now (msg.force = Check now).
        const st = await arReadStatus({ force: !!msg.force }).catch(() => null);
        sendResponse({ ok: !!st, status: st });
        break;
      }
      case "INS_HOLD_HINTS": {
        // Insights asks for its overdue / soon-due tasks: is something holding each
        // one up that ClickUp doesn't show as a dependency? Cached 6 hours a task.
        sendResponse(await holdHints(Array.isArray(msg.ids) ? msg.ids.map(String).slice(0, 30) : []).catch(() => ({})));
        break;
      }
      case "ARCHIVED_UNARCHIVE": {
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
        try {
          await unarchiveTask(cfg.token, String(msg.id));
          const { cuArchived } = await chrome.storage.local.get("cuArchived");
          if (cuArchived && Array.isArray(cuArchived.tasks)) await chrome.storage.local.set({ cuArchived: { ...cuArchived, tasks: cuArchived.tasks.filter((t) => t.id !== String(msg.id)) } });
          clearFilterCache();
          refreshClickup({ includeTasks: true }).catch(() => {});
          sendResponse({ ok: true });
        } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      }
      // ---- Automation rules (the Automation tab) ----
      case "RULES_GET": {
        await rulesSeed().catch(() => {});
        const g = await chrome.storage.local.get(["autoRules", "autoRuleLog", "autoRulePending", "autoRuleQueue", "autoRuleRuns"]);
        sendResponse({ ok: true, rules: Array.isArray(g.autoRules) ? g.autoRules : [], log: (Array.isArray(g.autoRuleLog) ? g.autoRuleLog : []).slice(0, 60),
          pending: Array.isArray(g.autoRulePending) ? g.autoRulePending : [], queued: (Array.isArray(g.autoRuleQueue) ? g.autoRuleQueue : []).length, runs: g.autoRuleRuns || {} });
        break;
      }
      case "RULES_SAVE": {
        const { rule, dropped } = RULES.normRule(msg.rule);
        const probs = RULES.problems(rule);
        if (probs.length) rule.on = false; // never switched on while it can't run
        const all = await rulesAll();
        const i = all.findIndex((r) => r.id === rule.id);
        if (i >= 0) { rule.createdAt = all[i].createdAt || rule.createdAt; all[i] = rule; } else all.push(rule);
        await chrome.storage.local.set({ autoRules: all.slice(0, 100) });
        sendResponse({ ok: true, rule, problems: probs, dropped });
        break;
      }
      case "RULES_TOGGLE": {
        const all = await rulesAll();
        const r = all.find((x) => x.id === msg.id);
        if (!r) { sendResponse({ ok: false, error: "That rule is gone." }); break; }
        const probs = msg.on ? RULES.problems(r) : [];
        if (probs.length) { sendResponse({ ok: false, problems: probs }); break; }
        if (msg.on && !msg.force && (r.actions || []).some((x) => x && x.type === "create_extra")) {
          const clash = await extraClash().catch(() => null);
          if (clash) { sendResponse({ ok: false, extraClash: clash }); break; }
        }
        r.on = !!msg.on;
        await chrome.storage.local.set({ autoRules: all });
        sendResponse({ ok: true });
        break;
      }
      case "RULES_DELETE": {
        const all = (await rulesAll()).filter((x) => x.id !== msg.id);
        const g = await chrome.storage.local.get(["autoRuleQueue", "autoRulePending"]);
        await chrome.storage.local.set({ autoRules: all, autoRuleQueue: (g.autoRuleQueue || []).filter((x) => x.ruleId !== msg.id), autoRulePending: (g.autoRulePending || []).filter((x) => x.ruleId !== msg.id) });
        sendResponse({ ok: true });
        break;
      }
      case "RULES_TEST": {
        try { sendResponse({ ok: true, ...(await rulesTest(msg.rule)) }); }
        catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      }
      case "RULES_UNDO": {
        try { sendResponse(await rulesUndo(msg.id)); }
        catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
        break;
      }
      case "RULES_PENDING": {
        // msg.approve true: run it now for those tasks; false: drop it.
        const g = await chrome.storage.local.get("autoRulePending");
        const list = Array.isArray(g.autoRulePending) ? g.autoRulePending : [];
        const p = list.find((x) => x.id === msg.id);
        await chrome.storage.local.set({ autoRulePending: list.filter((x) => x.id !== msg.id) });
        if (p && msg.approve) {
          const rule = (await rulesAll()).find((r) => r.id === p.ruleId);
          if (rule) for (const ctx of p.ctxs || []) await rulesRun(rule, ctx, 0, "approved by you");
        }
        sendResponse({ ok: true });
        break;
      }
      case "RULES_CLEAR_LOG": {
        await chrome.storage.local.set({ autoRuleLog: [] });
        sendResponse({ ok: true });
        break;
      }
      case "CLICKUP_OVERDUE": {
        // Deadline crossed = due date on a day BEFORE today AND status not complete
        // (isTaskDone: closed/done type or complete/completed/done/closed/resolved/
        // shipped/approved). Not limited to the Due selection: overdue tasks are,
        // by definition, never "due today", so they need their own query.
        // msg.assignee narrows it to one person's tasks (Bulk edit > "Whose tasks").
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          sendResponse(await getOverdueTasks(cfg, !!msg.force, msg.assignee));
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
        // A rebuild is started when the cache is missing, stale, or when the tab
        // explicitly asked (the ↻ next to "Whose tasks").
        if ((msg.force || !members || stale) && !rosterBuildPromise) {
          rosterBuildPromise = buildRoster(cfg);
        }
        // msg.wait = the tab is asking BECAUSE the roster was empty or short, so
        // it wants the NEW list, not the cache it already saw. This is the whole
        // reason a colleague could be "missing" with a perfectly good probe in
        // place: the build ran in the background, the reply went out with the old
        // (partial) list, the tab rendered that, and nothing ever asked again - so
        // pressing ↻ looked like it did nothing either. Wait for the build, then
        // answer with what it actually found. Only when the tab asks, because a
        // background rebuild must not hold the service worker open by itself.
        let fresh = null;
        if (msg.wait && rosterBuildPromise) {
          try { await rosterBuildPromise; } catch (e) { /* buildRoster records its own error */ }
          const st2 = (await getClickupState()) || {};
          if (Array.isArray(st2.members)) { members = st2.members; note = st2.membersNote || null; }
        }
        sendResponse({
          ok: true,
          members: members || [],
          note: note || undefined,
          warn: ((st && st.membersWarn) || null) || undefined,
          building: !!rosterBuildPromise,
          departments: await allDepartments(cfg, settings, !!msg.force),
          userId: cfg.userId != null ? String(cfg.userId) : null,
          // My own display name, so a bulk comment on somebody else's task can
          // say who made the change. Never a token.
          meName: String(cfg.username || cfg.email || "").trim(),
          // Can this token reach OTHER people's tasks? true = owner/admin,
          // false = a known plain member, null = ClickUp didn't say (offer it and
          // let ClickUp answer). Bulk edit's "Whose tasks" uses this to decide
          // whether to show the picker at all.
          canScope: cuScopeGate(cuCanScopeOthers(members || [], cfg.userId), cfg.adminToken),
        });
        break;
      }
      case "CLICKUP_FIND_USER": {
        // Find a colleague by NAME, for the case the roster is incomplete. A task
        // query is the search: /team/{id}/task takes assignees[] but the reliable
        // way to turn a name into a user id is ClickUp's own user search, and any
        // user object it returns (id, username, email) is enough to filter by.
        // So: read the workspace's people, keep the ones whose name matches, and
        // let the caller show them - the id is never invented from the text.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          const q = String(msg.name || "").trim().toLowerCase();
          if (!q) { sendResponse({ ok: true, members: [] }); break; }
          const pool = [];
          const map = new Map();
          try {
            const j = await import("./lib-clickup.js");
            const members = await j.fetchTeamMembers(cfg.token, cfg.teamId, cfg.adminToken);
            for (const m of (Array.isArray(members) ? members : [])) map.set(String(m.id), m);
          } catch (e) { /* fall through to the task-assignee scan below */ }
          for (const m of map.values()) {
            const name = String(m.name || "").toLowerCase(), mail = String(m.email || "").toLowerCase();
            if (name.indexOf(q) >= 0 || mail.indexOf(q) >= 0) pool.push(m);
          }
          // Not in any roster? Their tasks still name them: scan open tasks and
          // collect every assignee we have not seen. This is what finds a
          // colleague who is in ClickUp but missing from every directory we can
          // read - the "I can't find Subina Khadka" case.
          try {
            const j = await import("./lib-clickup.js");
            const extra = await j.harvestAssigneeMatches(cfg.token, cfg.teamId, q, map, 6);
            for (const m of extra) if (m && m.id != null) map.set(String(m.id), m);
          } catch (e) { /* a refused scan is not fatal: the roster answer stands */ }
          for (const m of map.values()) {
            const name = String(m.name || "").toLowerCase(), mail = String(m.email || "").toLowerCase();
            if (name.indexOf(q) >= 0 || mail.indexOf(q) >= 0) pool.push(m);
          }
          const uniq = [];
          const seen = new Set();
          for (const m of pool) { const k = String(m.id); if (!seen.has(k)) { seen.add(k); uniq.push(m); } }
          sendResponse({ ok: true, members: uniq });
        } catch (e) {
          sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_TAG_LIST": {
        // Every tag in the workspace, for the Bulk edit "By tag" DROPDOWN. The
        // names come from ClickUp itself, so a misspelt tag is impossible - which
        // was the whole point of asking for a list instead of a text box. Cached
        // for a day: tags change rarely, and this must not cost a call per
        // render or per keystroke. Pass force to re-read (the ↻ next to the
        // dropdown), which is also the escape hatch after adding tags in ClickUp.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        try {
          const stored = (await chrome.storage.local.get(TAG_LIST_STORE_KEY)) || {};
          const saved = stored[TAG_LIST_STORE_KEY];
          if (!msg.force && saved && Array.isArray(saved.tags) && saved.tags.length && Date.now() - (saved.at || 0) < TAG_LIST_TTL) {
            sendResponse({ ok: true, tags: saved.tags, cached: true, at: saved.at });
            break;
          }
          let tags = [];
          let source = "workspace";
          try { tags = (await fetchWorkspaceTags(cfg.token, cfg.teamId)).tags; } catch (e) { source = "tasks"; }
          if (!tags.length) {
            // Some plans/roles refuse the workspace tag list. Fall back to the
            // tags ClickUp just sent on real tasks, so the dropdown is still
            // useful instead of mysteriously empty.
            const fromTasks = [];
            for (const t of (openTasksCache && openTasksCache.data && openTasksCache.data.tasks) || []) {
              for (const g of (Array.isArray(t && t.tags) ? t.tags : [])) fromTasks.push(g);
            }
            tags = cuTagNames(fromTasks);
            source = tags.length ? "tasks" : "none";
          }
          // Only a good answer is cached: an empty list must be retried, not
          // remembered for a day.
          if (tags.length) await chrome.storage.local.set({ [TAG_LIST_STORE_KEY]: { at: Date.now(), tags } }).catch(() => {});
          sendResponse({ ok: true, tags, source, cached: false });
        } catch (e) {
          sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) });
        }
        break;
      }
      case "CLICKUP_DEPARTMENTS_SAVE": {
        // Persist the Department Creator config. Validation is light: each entry
        // needs a non-empty name and its users are reduced to {id, name} pairs.
        const depts = Array.isArray(msg.departments) ? msg.departments : [];
        const clean = depts
          .filter((d) => d && !String(d.id || "").startsWith("cu:")) // ClickUp's Teams live in ClickUp
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
        sendResponse({ ok: true, departments: await allDepartments(await getClickupConfig().catch(() => null), next, false) });
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
        // "All accounts": the same test login for each account in turn (e.g. to
        // watch "Keep me signed in to GitHub" switch accounts). Like the single
        // test it never writes the status / earning checkpoint, so an account
        // whose 24h window is over is SKIPPED: logging it in now would earn the
        // day's credit without recording it - the normal Run does that properly.
        if (msg.id === "__all__") {
          if (isRunning) { sendResponse({ ok: false, reason: "already running" }); break; }
          const all = (await getAccounts()).filter((a) => a.enabled !== false);
          const withTotp = all.filter((a) => a.totpSecret);
          const list = withTotp.length ? withTotp : all;
          if (!list.length) { sendResponse({ ok: false, reason: "no accounts" }); break; }
          isRunning = true;
          cancelRequested = false;
          sendResponse({ ok: true, started: list.length });
          const settings = await getSettings();
          const status = await getStatus();
          const say = (m) => chrome.runtime.sendMessage({ type: "DEBUG_PROGRESS", ...m }).catch(() => {});
          (async () => {
            for (let i = 0; i < list.length; i++) {
              const acc = list[i];
              const label = acc.label || acc.username || "account " + (i + 1);
              const more = i < list.length - 1;
              if (cancelRequested) { say({ done: true, ok: false, result: "needs-attention", note: "Stopped by user.", account: label, more: false }); break; }
              if (!isDoneWithinWindow(status[acc.id])) {
                say({ done: true, ok: false, result: "skipped", note: "its 24 hours are up, so logging in now would earn today's credit without recording it. Use Run for this one.", account: label, more });
                continue;
              }
              say({ phase: "starting " + label, account: label });
              let outcome;
              try {
                outcome = await runAccountLogin(acc, {
                  targetUrl: settings.targetUrl,
                  active: true,
                  keepTabs: true,
                  timeoutScale: settings.slowNetwork ? 2 : 1,
                  keepGithub: settings.ghKeepSignedIn === true,
                  isCancelled: isCancelledFn,
                });
              } catch (e) {
                outcome = { result: "failed", note: String(e && e.message ? e.message : e) };
              }
              // Remember which GitHub handle this account is (identity only - never the checkpoint).
              if (outcome.detected) applyDetected(acc.id, outcome.detected).catch(() => {});
              say({ done: true, ok: outcome.result === "success", result: outcome.result, note: outcome.note, detected: outcome.detected || {}, account: label, more });
              // Same as Run: close the tab once logged in (a tab that needs you
              // stays open), then a short pause before the next account.
              if (outcome.result === "success" && outcome.tabId) { try { await chrome.tabs.remove(outcome.tabId); } catch (e) {} }
              if (more && !cancelRequested) await new Promise((r) => setTimeout(r, (settings.slowNetwork ? 2 : 1) * (1500 + Math.random() * 2000)));
            }
          })().finally(() => {
            isRunning = false;
            cancelRequested = false;
            probeAvailabilityInBackground({}).catch(() => {});
          });
          break;
        }
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
          keepGithub: settings.ghKeepSignedIn === true,
          isCancelled: isCancelledFn,
        })
          .then((outcome) => {
            // Remember which GitHub handle this account is (identity only - never the checkpoint).
            if (outcome.detected) applyDetected(acc.id, outcome.detected).catch(() => {});
            // Same as Run: close the tab once logged in; a tab that needs you stays open.
            if (outcome.result === "success" && outcome.tabId) chrome.tabs.remove(outcome.tabId).catch(() => {});
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
        await playNotificationSound(true, msg.sound, msg.volume);
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
