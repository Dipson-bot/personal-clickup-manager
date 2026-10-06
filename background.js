// background.js  (ES module service worker)
// -----------------------------------------------------------------------------
// Wiring: encrypted account storage, per-account status, the once-per-day
// trigger, the toolbar badge, and all messages from popup.js / options.js.
// -----------------------------------------------------------------------------

import { encryptJSON, decryptJSON, encryptWithPassphrase, decryptWithPassphrase, generateTOTP, totpSecondsRemaining } from "./lib-crypto.js";
import {
  getFileToken,
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
} from "./lib-drive.js";
import { runAllAccounts, runAccountLogin, readAgentRouterLogin, URLS, GITHUB_KEEP_COOKIES } from "./lib-automation.js";
import { getUser, verifyToken, getTeams, fetchTodayEstimate, fetchWeeklySummary, fetchDateRangeEstimate, createTaskCache, fetchTeamMembers, fetchWorkspaceTags, cuTagNames, fmtDuration, findExtraTaskByName, parseTaskIdFromUrl, getCurrentTimeEntry, getRunningTaskProgress, startTimer, stopTimer, getTaskById, setTaskStatus, taskUrlFor, clientLabelFromContainer, resolveSpaceNamesFor, taskContainer, cuPriorityName, isTaskDone, getSubtasksOfParent, getTaskTree, getTaskDetail, updateTimeEntry, setTaskDueDate, clearTaskTreeCache, listWorkspaceClients, cuRowAssignees, fetchDoneBetween, fetchDoneLite, fetchTrackedHistory, getTaskPanel, addTaskComment, postTaskComment, setTaskDescription, getTaskCommentLinks, createTask, weeklyWithToday, listClientFieldOptions, listReachableClients } from "./lib-clickup.js";
import { resolveRelayKey, pickProbeModel, probeRelay } from "./lib-availability.js";
import { tidyCollect, tidyLines, tidyResolved, tidyDayOk, tidyUrgent } from "./lib-tidy.js";

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
  if (!file || !file.enc || !teamId) return null;
  try {
    const o = await decryptWithPassphrase(file.enc, teamSitesPass(teamId));
    return cleanTeamSites(o && o.sites);
  } catch (e) {
    return null; // another workspace (or a damaged file)
  }
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
  const sites = await decryptTeamSites(file, teamId);
  if (!sites) { await chrome.storage.local.set({ teamSites: { key, status: "other-workspace", triedAt: Date.now() } }); return; }
  const added = await applyTeamSites(sites);
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
  return Array.isArray(reminders) ? reminders : [];
}
// Next time a repeating reminder is due, after `now` (local time kept).
function remNext(at, repeat, now) {
  const t = new Date(at);
  let guard = 0;
  do {
    t.setDate(t.getDate() + (repeat === "weekly" ? 7 : 1));
    if (repeat === "weekdays") while (t.getDay() === 0 || t.getDay() === 6) t.setDate(t.getDate() + 1);
  } while (t.getTime() <= now && ++guard < 800);
  return t.getTime();
}
// Office reminders everyone starts with: check-in / check-out (the team uses
// the Rigo app) and returning the kitchen cups before 2:15 PM. Ordinary weekday
// reminders, each added once: they show in Options > Reminders, where they can
// be edited, paused or deleted like any other; a deleted one isn't added back.
// A new entry here reaches existing users too (tracked per id).
// Office reminders stay quiet on company days off: check-in/out on holidays
// (work from home still checks in), the cup reminder on holidays and WFH days.
const REM_SKIP = { "default-checkin": ["holiday"], "default-checkout": ["holiday"], "default-cups": ["holiday", "wfh"] };
const REM_DEFAULTS = [
  { id: "default-checkin", text: "Check in? Rigo", h: 8, m: 10, sound: "danger" },
  { id: "default-checkout", text: "Check out? Rigo", h: 17, m: 0, sound: "danger" },
  { id: "default-cups", text: "Return your cup to the kitchen (before 2:15 PM)", h: 14, m: 0, sound: "normal" },
];
// The next weekday at h:m that's still ahead.
function remNextWeekdayAt(h, m, now = Date.now()) {
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  while (d.getTime() <= now || d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.getTime();
}
async function ensureDefaultReminders() {
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
      if (shown < 5 && !offToday) { await showReminder(r, missed); shown++; }
      r.firedAt = now;
      if (r.repeat === "daily" || r.repeat === "weekdays" || r.repeat === "weekly") r.at = remNext(Number(r.at), r.repeat, now);
      else r.active = false; // one-time: moves to "Past" in the list
      changed = true;
    }
    if (changed) await chrome.storage.local.set({ reminders: list });
  }).catch(() => {});
  return remBusy;
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

// The readable version of the check (one GET, same as the plain one). Returns
// null when the page couldn't be read (so the caller falls back), never a false
// "down" for a read problem; a real outage (no reply / timeout) is still down.
async function readOneSite(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: "GET", cache: "no-store", credentials: "omit", redirect: "follow", signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === "AbortError") return { ok: false, status: 0, error: "No reply within " + Math.round(timeoutMs / 1000) + "s" };
    return null; // e.g. redirected to a domain we can't read: let the plain check decide
  }
  try {
    const html = await res.text();
    clearTimeout(timer);
    const ms = Date.now() - t0;
    // A Cloudflare "checking your browser" page isn't an outage.
    if (res.headers.get("cf-mitigated") === "challenge") return { ok: true, status: res.status, ms, read: true };
    if (res.status >= 500) return { ok: false, status: res.status, ms, read: true, error: "HTTP " + res.status + ((blankPageReason(html) && " - " + blankPageReason(html)) || "") };
    if (res.status >= 400) return { ok: true, status: res.status, ms, read: true }; // as before: only 5xx counts as down
    const why = blankPageReason(html);
    if (why) return { ok: false, blank: true, status: res.status, ms, read: true, error: "Page is broken: " + why + " (HTTP " + res.status + ")" };
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
    : o.name + " doesn't answer at all. " + prev.lastError;
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

async function checkSites(opts = {}) {
  const cfg = await getSiteMonitorConfig();
  if (!cfg || !Array.isArray(cfg.sites) || cfg.sites.length === 0) return { checked: 0 };
  if (!cfg.enabled && !opts.manual) return { checked: 0 };
  const now = Date.now();
  const state = (await chrome.storage.local.get("siteMonitorState"))["siteMonitorState"] || {};
  const sites = cfg.sites.filter((s) => s && s.url && (!opts.url || s.url === opts.url));
  // 1) One check per site (30s timeout), a few sites at a time.
  const results = new Map();
  const first = await mapLimit(sites, SITE_MONITOR_PARALLEL, (s) => checkOneSite(s.url));
  sites.forEach((s, i) => results.set(s.url, first[i]));
  let failed = sites.filter((s) => !results.get(s.url).ok);
  // 2) Anything failed: is it us? Offline, or half the list failing in the same
  //    minute, is this PC's connection - never a client outage. Don't count it.
  // A site that answered with a broken page (read: true) reached us fine, so it
  // never counts towards "is it this PC's connection".
  let localProblem = false;
  const unreachable = failed.filter((s) => !results.get(s.url).read);
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
    failed = failed.filter((s) => !results.get(s.url).ok);
  }
  for (const site of sites) {
    const key = site.url;
    const prev = state[key] || { up: null, fails: 0, lastCheck: 0, lastDownNotified: 0 };
    const result = results.get(key);
    if (localProblem && !result.ok && !result.read) {
      // Leave up/fails untouched; just note why nothing was decided.
      prev.lastCheck = now;
      prev.lastError = "Couldn't check: this computer looked offline";
      prev.skippedAt = now;
      state[key] = prev;
      continue;
    }
    const d = siteDecide(prev, result, { manual: !!opts.manual, now, name: site.name || site.url, failuresNeeded: SITE_MONITOR_FAILURES, staleMs: SITE_MONITOR_STALE_MS });
    state[key] = d.prev;
    if (d.note) {
      await notify("site-" + d.note.kind + "-" + now + "-" + key, d.note.title, d.note.message, d.note.sound, chrome.runtime.getURL("options.html#sites"),
        { priority: 2, requireInteraction: d.note.kind !== "up" });
    }
  }
  // Persist on EVERY run (not only when a status flips) so the "last check" time
  // stays current. Previously a steadily-up site never re-saved its lastCheck, so
  // the options page froze at the last status change and looked like it had stopped.
  await chrome.storage.local.set({ siteMonitorState: state });
  const res = sites.map((s) => results.get(s.url) || {});
  return { checked: sites.length, up: res.filter((r) => r.ok).length,
    down: localProblem ? 0 : res.filter((r) => !r.ok).length, offline: localProblem };
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
    const res = await fetch(url, { headers: { Authorization: token } });
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
async function getPerfHistory(force) {
  const { perfHistory } = await chrome.storage.local.get("perfHistory");
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) return { ok: false, reason: "not-configured", data: perfHistory || null };
  // v2 adds per-day task hours + names (the clickable charts); an older copy is still shown until rebuilt.
  const mine = perfHistory && String(perfHistory.userId) === String(cfg.userId) ? perfHistory : null;
  const fresh = mine && mine.v === 2 && Date.now() - (mine.at || 0) < (force ? 10 * 60000 : PERF_TTL_MS);
  if (fresh) return { ok: true, data: mine };
  const cst = await getClickupState().catch(() => null);
  if (cst && cst.rateLimitedUntil > Date.now()) return { ok: true, data: mine, busy: true };
  if (!perfBuild) perfBuild = (async () => {
    const now = new Date();
    const mon = new Date(now); mon.setHours(0, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7) - 7 * (PERF_WEEKS - 1));
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
    const data = { v: 2, at: Date.now(), userId: String(cfg.userId), fromTs, toTs, weeks: PERF_WEEKS, days, taskMs, byDay: hist.byDay, names: hist.names, done: slim };
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
      const res = await fetch(url, { headers: { Authorization: cfg.token } });
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
      const res = await fetch("https://api.clickup.com/api/v2/team/" + encodeURIComponent(cfg.teamId) + "/task?page=" + page + "&" + params.join("&"), { headers: { Authorization: token } });
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
    const res = await fetch(url, { headers: { Authorization: token } });
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
  clickupTidyCats: { overdue: true, noEst: true, noDue: true, blocked: true },
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
  floatTracker: true, floatHover: true, floatToday: true, floatSize: "normal",
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
const EXTRA_KEYS = ["siteMonitorConfig", "theme", "cuFilter", "cuFilterMode", "cuFilterDefault", "customSounds", "cuManualOrder", "siteDirSeen", "reminders", "clientNotes", "taskNotes", "taskPins", "planOverrides", "localTasks"];
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
    awayNotify: settings.clickupAwayNotify !== false,
    awayMin: Number(settings.clickupAwayMin) || 15,
    wrapUp: settings.clickupWrapUp !== false,
    extraAutoClose: settings.clickupExtraAutoClose !== false,
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
// task instead of the viewer's. Cached per user for an hour. `hint` (name/email)
// sharpens which match is preferred when someone has several Extra-named tasks.
// Which week's occurrence to look for depends on the day being asked about, so
// the cache is keyed per user PER WEEK. One entry for everything is what made
// "Due tomorrow" reuse the current week's answer when tomorrow is next week.
function extraRangeKey(userId, fromTs) {
  const d = new Date(fromTs);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // that week's Monday
  return String(userId) + ":" + d.getTime();
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
  const key = extraRangeKey(userId, from);
  const hit = extraTaskCache.get(key);
  if (hit && Date.now() - hit.at < EXTRA_TASK_CACHE_MS) return hit.value;
  let value = null;
  try {
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
    value = null;
  }
  extraTaskCache.set(key, { at: Date.now(), value });
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
function cuFilterCustomRange(f) {
  if (!f || !f.dueCustom) return null;
  const p = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0; };
  let a = p(f.customFrom);
  if (!a) return null;
  let b = p(f.customTo) || a;
  if (b < a) { const x = a; a = b; b = x; }
  const end = new Date(b); end.setHours(23, 59, 59, 999);
  return { fromTs: a, toTs: end.getTime() };
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
      const prev = (await getClickupState()) || {};
      if (prev.custom && prev.custom.fromTs === r.fromTs && prev.custom.toTs === r.toTs && Date.now() - (prev.custom.at || 0) < 5 * 60000) return;
      const custom = await buildRangeBundle(cfg, await getSettings(), r.fromTs, r.toTs);
      const cur = (await getClickupState()) || {};
      await setClickupState({ ...cur, custom });
      await updateBadge().catch(() => {});
    } catch (e) {} finally { stop(); customBuild = null; }
  })();
  return customBuild;
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.cuFilter) { refreshCustomBundle().catch(() => {}); updateBadge().catch(() => {}); }
});
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
    const collect = (arr) => {
      for (const t of Array.isArray(arr) ? arr : []) {
        const id = t && (t.id != null ? t.id : t.taskId);
        if (id != null && !t.isSubtask && !t.done) {
          const key = String(id);
          ids.add(key);
          const d = Number(t.dueDateMs) || 0;
          if (d && !parentDue[key]) parentDue[key] = d;
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
    // Idea A - "sub-blocked": a parent that cannot realistically be closed because
    // its OWN subtasks are still open and run PAST the parent's due date (e.g. a
    // task due today whose subtasks are due weeks out). Independent of assignee, so
    // it complements the person-based "waiting on others" above. Same cache, no fetch.
    for (const id of ids) {
      const c = cache[id];
      if (!c || !c.subs || !c.subs.length) continue;
      const pDue = parentDue[id] || 0;
      const open = c.subs.filter((x) => !x.done);
      if (!open.length) continue;
      const later = pDue ? open.filter((x) => x.due && x.due > pDue) : [];
      const parentOverdue = !!pDue && pDue < todayStart;
      if (!later.length && !(parentOverdue && open.length)) continue;
      const latestDueMs = open.reduce((m, x) => (x.due && x.due > m ? x.due : m), 0) || null;
      const entry = waiting[id] || {};
      entry.selfBlock = { open: open.length, later: later.length, latestDueMs, parentOverdue };
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
  // Share one in-flight refresh across concurrent triggers.
  if (clickupRefreshInFlight) return clickupRefreshInFlight;
  clickupRefreshInFlight = (async () => {
    try {
      const r = await refreshClickupImpl(opts);
      refreshWaitingInfo().catch(() => {}); // "Waiting on …" chips (cached, throttled)
      return r;
    } finally {
      clickupRefreshInFlight = null;
    }
  })();
  return clickupRefreshInFlight;
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
  const extendedMode = extendedModeOf(settings);
  const spread = spreadOf(settings), multiDay = multiDayOf(settings);
  // One shared cache for configured-task fetches across today + weekly, so each
  // by-URL task is fetched from the API at most once per refresh.
  const taskCache = createTaskCache();
  try {
    const data = await fetchTodayEstimate({ token: cfg.token, teamId: cfg.teamId, userId: cfg.userId, targetHours, deadlineTaskUrls, extendedMode, taskCache, spread });
    // One failed request must not knock the Extra Task out of today's total.
    keepLastGoodConfigured(data, await getClickupState().catch(() => null));

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
      if (!weekChanged && prevWeekly.at && Date.now() - prevWeekly.at < forceFloor(forceWeekly, WEEKLY_TTL)) {
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
        if (!rangeChanged && prev && prev.at && Date.now() - prev.at < forceFloor(forceWeeks, WEEK_TTL)) return prev; // fresh - no API calls
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
        if (!rangeChanged && prev && prev.at && Date.now() - prev.at < forceFloor(forceWeeks, WEEK_TTL)) return prev;
        return { ...(await buildRangeBundle(cfg, settings, fromTs, toTs)), multiDay };
      };
      const tomStart = new Date(); tomStart.setDate(tomStart.getDate() + 1); tomStart.setHours(0, 0, 0, 0);
      const tomEnd = new Date(tomStart); tomEnd.setHours(23, 59, 59, 999);
      tomorrow = await buildDay((prevSt && prevSt.tomorrow) || null, tomStart.getTime(), tomEnd.getTime());
      // The saved filter's custom range / chart day, shared by every page + the badge.
      try {
        const { cuFilter: savedFilter } = await chrome.storage.local.get("cuFilter");
        const cr = cuFilterCustomRange(savedFilter);
        custom = cr ? await buildDay((prevSt && prevSt.custom) || null, cr.fromTs, cr.toTs) : null;
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
      extraTask: extraTask || null, // auto-detected "Extra(s) Task(s)"
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
  { from: "2026-10-12", to: "2026-11-13", kind: "wfh", title: "Work from home (Dashain & Tihar)" },
  { from: "2026-10-19", to: "2026-10-23", kind: "holiday", title: "Dashain holidays" },
  { from: "2026-11-09", to: "2026-11-12", kind: "holiday", title: "Tihar holidays" },
];
function normalizeCompanyCal(list) {
  const ok = /^\d{4}-\d{2}-\d{2}$/;
  return (Array.isArray(list) ? list : []).filter((e) => e && ok.test(String(e.from || ""))).slice(0, 200).map((e) => ({
    from: String(e.from), to: ok.test(String(e.to || "")) && String(e.to) >= String(e.from) ? String(e.to) : String(e.from),
    kind: ["holiday", "wfh", "event"].includes(e.kind) ? e.kind : "event",
    title: String(e.title || (e.kind === "holiday" ? "Holiday" : e.kind === "wfh" ? "Work from home" : "Event")).slice(0, 80),
  }));
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
async function scheduleEstimateAlarms(entry, progress, settings, seenNear, seenMet) {
  await chrome.alarms.clear(EST_ALARM_NEAR).catch(() => {});
  await chrome.alarms.clear(EST_ALARM_MET).catch(() => {});
  // (Called with no arguments to just clear them - settings may be missing then.)
  // autoOn: this running task is marked to complete itself (autoCompleteTasks).
  let marked = {};
  if (entry) { try { const g = await chrome.storage.local.get("autoCompleteTasks"); marked = (g && g.autoCompleteTasks) || {}; } catch (e) {} }
  const notifyOn = !!settings && settings.clickupRunningNotify !== false, autoOn = !!(entry && marked[String(entry.taskId)]);
  if (!entry || !progress || !(progress.estimateMs > 0) || (!notifyOn && !autoOn)) return;
  const now = Date.now();
  const crossAt = now + (progress.estimateMs - progress.trackedMs) + 3000; // a few seconds late, so ClickUp agrees it's crossed
  const thresholdMs = Math.max(1, Number(settings.clickupRunningThresholdMin) || 10) * 60000;
  const nearAt = crossAt - thresholdMs;
  if (notifyOn && !seenNear && nearAt > now + 5000) chrome.alarms.create(EST_ALARM_NEAR, { when: nearAt });
  if (!seenMet && crossAt > now + 5000) chrome.alarms.create(EST_ALARM_MET, { when: crossAt });
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
    progress = await getRunningTaskProgress(cfg.token, cfg.teamId, entry.taskId, entry.startMs);
  } catch (e) {
    return;
  }
  // The floating tracker's bar and face: estimate + time tracked today before this
  // timer started (the live part is added on the page, second by second).
  // closedTodayMs is TODAY's share of that earlier time, so the pages can show
  // "4h 49m · 31m today" for a task tracked across several days.
  await chrome.storage.local.set({ runningProgress: {
    taskId: String(entry.taskId), startMs: entry.startMs || 0, taskName: (progress && progress.taskName) || entry.taskName || "",
    estimateMs: progress ? progress.estimateMs : 0,
    closedMs: progress ? Math.max(0, progress.trackedMs - Math.max(0, Date.now() - (entry.startMs || Date.now()))) : 0,
    closedTodayMs: progress ? Math.max(0, Number(progress.closedTodayMs) || 0) : 0,
    at: Date.now(),
  } });
  const { clickupNotified } = await chrome.storage.local.get("clickupNotified");
  const seen = clickupNotified && typeof clickupNotified === "object" ? clickupNotified : {};
  const runningNear = (seen.runningNear && typeof seen.runningNear === "object") ? seen.runningNear : {};
  const runningMet = (seen.runningMet && typeof seen.runningMet === "object") ? seen.runningMet : {};
  const today = todayString();
  const key = String(entry.taskId);
  await scheduleEstimateAlarms(entry, progress, settings, runningNear[key] === today, runningMet[key] === today).catch(() => {});
  // A task marked to complete itself (autoCompleteTasks, chosen per task): when
  // the running task's tracked time reaches its estimate, stop the timer and mark
  // it complete. Never the Extra Task or a configured recurring / multi-day task
  // (daily buckets). A task shared with others can be marked - the person chose it.
  const { autoCompleteTasks: acMarked } = await chrome.storage.local.get("autoCompleteTasks").catch(() => ({}));
  if (acMarked && acMarked[key] && progress && progress.estimateMs > 0 && progress.trackedMs >= progress.estimateMs && runningMet[key] !== today) {
    const name0 = progress.taskName || entry.taskName || "this task";
    const configured = (Array.isArray(settings.clickupDeadlineTaskUrls) ? settings.clickupDeadlineTaskUrls : []).some((u) => parseTaskIdFromUrl(u) === key);
    const isExtra = /\bextra\s*\(?s?\)?\s*tasks?\b/i.test(name0);
    let task = null;
    try { task = await getTaskById(cfg.token, key); } catch (e) {}
    if (!configured && !isExtra && task) {
      try {
        await stopTimer(cfg.token, cfg.teamId);
        await setTaskStatus(cfg.token, key, "complete");
        const st = (await getClickupState().catch(() => null)) || {};
        if (String(st.activeTaskId || "") === key) await setClickupState({ ...st, activeTaskId: null });
        const left = { ...acMarked }; delete left[key]; // done: no longer marked
        await chrome.storage.local.set({ runningProgress: null, autoCompleteTasks: left, clickupNotified: { ...seen, runningMet: { ...runningMet, [key]: today } } });
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
  if (settings.clickupRunningNotify === false) return;
  if (!progress) return; // task has no estimate set - nothing to compare against
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
async function maybeCloseExtraTask() {
  const s = await getSettings();
  if (s.clickupExtraAutoClose === false) return;
  const st = (await getClickupState().catch(() => null)) || {};
  const ex = st.extraTask;
  const now = Date.now();
  if (!extraCloseDue(ex, now)) return;
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
  if (!extraCloseDue(fresh, now)) return;
  const cur = await getCurrentTimeEntry(cfg.token, cfg.teamId).catch(() => null);
  if (cur && String(cur.taskId) === fresh.id) return; // still tracking on it: wait until it's stopped
  try { await setTaskStatus(cfg.token, fresh.id, "complete"); }
  catch (e) { await chrome.storage.local.set({ extraCloseTry: { id: fresh.id, at: now, failed: String(e && e.message ? e.message : e).slice(0, 200) } }); return; }
  done[fresh.id] = now;
  const keep = Object.entries(done).sort((a, b) => b[1] - a[1]).slice(0, 20);
  await chrome.storage.local.set({ extraAutoClosed: Object.fromEntries(keep) });
  clearFilterCache();
  refreshClickup({ includeTasks: true }).catch(() => {});
  await notify("cu-extra-closed-" + now, "Extra Task closed for this week",
    (ex.name || "Your Extra Task") + " was still open after 5 PM on its due day, so it was marked complete. ClickUp now creates next week's one.",
    undefined, t.url || ex.url || null);
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
  const model = tidyCollect(res.data.tasks, st.waiting, todayStart);
  // Yesterday's blocked list, so we can spot what has been freed up since.
  const { cuTidyBlocked } = await chrome.storage.local.get("cuTidyBlocked");
  const snap = cuTidyBlocked && typeof cuTidyBlocked === "object" ? cuTidyBlocked : {};
  const t = tidySettings(s);
  const resolved = t.resolved && snap.day && snap.day !== todayString()
    ? tidyResolved(snap.ids || [], model, res.data.tasks) : [];
  const say = tidyLines(model, { cats: t.cats, max: t.max, resolved });
  return { ok: true, model, resolved, say, urgent: tidyUrgent(model, resolved), blockedIds: model.blockedIds };
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
  if (f.dueTomorrow) {
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
  if (f.dueToday) return Number(st.estimateMs) || 0;
  // Custom range / chart day: the shared bundle (the same number the pages show);
  // until it's built, today's due estimate rather than the "active today" total.
  if (f.dueCustom) {
    const r = cuFilterCustomRange(f);
    if (r && st.custom && st.custom.fromTs === r.fromTs && st.custom.toTs === r.toTs) return Number(st.custom.estimateMs) || 0;
    return Number(st.estimateMs) || 0;
  }
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
    // Automatic retries stopped: it needs a person whether or not it failed today,
    // so it can't sit in "pending" once the failure is a day old.
    else if (Number(st.retryStoppedAt) > 0) attention++;
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
async function hubProfile(force) {
  const cfg = await getClickupConfig().catch(() => null);
  if (!cfg || !cfg.token) return null;
  let c = cfg;
  if (force || !cfg.profileAt || Date.now() - cfg.profileAt > 7 * 86400000) {
    try {
      const u = await getUser(cfg.token);
      c = await setClickupConfig({ username: u.username || cfg.username || "", avatar: u.profilePicture || "", color: u.color || "", initials: u.initials || "", profileAt: Date.now() });
    } catch (e) {} // keep what we have; try again next time
  }
  return { cuUserId: String(c.userId || ""), name: c.username || "", avatar: c.avatar || "", color: c.color || "", initials: c.initials || "" };
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
async function hubCall(action, payload, asAdmin) {
  const url = await hubUrl();
  if (!url) return { ok: false, reason: "not-set-up", error: "Help & issues isn't set up yet - ask your admin." };
  const body = { ...(payload || {}), action, install: await installId() };
  if (asAdmin) {
    const key = await hubAdminKey();
    if (!key) return { ok: false, error: "Save the admin key first (Admin > Team hub)." };
    body.key = key;
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
  const r = await hubCall("hello", { ...p, version });
  if (r && r.ok) await chrome.storage.local.set({ hubHelloVer: version });
  if (r && r.ok) await chrome.storage.local.set({ hubMe: { state: r.state, mutedUntil: r.mutedUntil || 0, settings: r.settings || {}, at: Date.now() } });
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
    let quiet = "";
    if (!forceNotify) {
      if (policy.quietFor && policy.quietFor === info.latest && !nonceNew) quiet = "admin";
      else if ((await getSettings()).autoUpdate !== false && (await autoUpdateReady())) quiet = "auto";
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
    tabs = ctx.map((c) => c.documentUrl).filter((u) => u && String(u).startsWith(chrome.runtime.getURL("")));
  } catch (e) {}
  st.lastTry = now;
  await ensureOffscreenDocument();
  let r = null;
  for (let i = 0; i < 10 && !r; i++) {
    try { r = await chrome.runtime.sendMessage({ target: "offscreen", type: "AUTO_UPDATE", ui: { latest: ui.latest, zip: ui.zip } }); }
    catch (e) { await new Promise((res) => setTimeout(res, 300)); }
  }
  const trace = ["hidden page: " + (!r ? "no reply" : r.ok ? "installed" : r.reason + (r.error ? " (" + String(r.error).slice(0, 80) + ")" : ""))];
  // The hidden page couldn't do it (often the folder permission - Chrome applies
  // "Allow on every visit" to the extension's tabs - or anything else that went
  // wrong there): do the same install from a tab opened in the background; if
  // that tab isn't allowed either, it is brought to the front (see installViaTab).
  if (!(r && r.ok) && !(r && /^(no-update|no-folder)$/.test(r.reason || ""))) {
    const t = await installViaTab();
    if (t) {
      trace.push((t.woke ? "tab (brought to the front): " : "background tab: ") + (t.ok ? "installed" : t.reason + (t.error ? " (" + String(t.error).slice(0, 80) + ")" : "")));
      await chrome.storage.local.set({ autoUpdateViaTab: { ok: !!t.ok || !/^(permission|no-folder|moved|tab-timeout|no-update|needs-click)$/.test(t.reason || ""), at: now, reason: t.reason || "" } });
      r = t;
      autoReadyCache = null;
    } else trace.push("background tab: couldn't open one");
  }
  diagLog("automatic update", trace.join(" -> "));
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
        message: "Chrome needs your OK once to let the extension update its folder. Click \"Finish update\" in the update tab - it installs and restarts the extension.",
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
async function installViaTab() {
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
      if (msg.type === "AUTO_UPDATE_TAB_FRONT") { bringForward(); return; }
      if (msg.type === "AUTO_UPDATE_TAB_RESULT") resolve(msg);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    timer = setTimeout(() => resolve({ ok: false, reason: "tab-timeout" }), 150000);
  });
  const cleanup = () => { chrome.runtime.onMessage.removeListener(onMsg); clearTimeout(timer); clearInterval(keep); };
  keep = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
  try {
    tab = await chrome.tabs.create({ url: chrome.runtime.getURL("auto-update.html?n=" + nonce), active: false });
  } catch (e) {
    cleanup();
    return null;
  }
  const r = await answer;
  cleanup();
  if (!r.ok && r.reason !== "needs-click") {
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
  // Alarms don't survive an update / reload: put the reminders' back.
  ensureDefaultReminders().catch(() => {}).then(() => fireDueReminders()).then(() => scheduleReminders()).catch(() => {});
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
    await checkForUpdate().catch(() => {});
    await maybeAutoUpdate().catch(() => {});
    // Backstop for the wrap-up alarm (missed while asleep / Chrome closed).
    // Cheap: settings + one storage read, and it runs at most once a day.
    await maybeWrapUp().catch(() => {});
    // The daily "needs tidying" summary, same deal: it self-gates on the time
    // of day, so checking every minute is free and a missed alarm still lands.
    await maybeTidyNotify().catch(() => {});
    await maybeCloseExtraTask().catch(() => {});
    // Backstop for reminder alarms (asleep / missed).
    await fireDueReminders();
    await maybeCompanyHeadsUp().catch(() => {});
    // Team hub: daily check-in, admin replies every 10 min (both no-ops when not set up).
    await hubHello().catch(() => {});
    await hubPollReplies().catch(() => {});
    await hubPollNotices().catch(() => {});
  } else if (alarm.name === CLICKUP_ALARM) {
    refreshClickup({ viaAlarm: true }).catch(() => {});
  } else if (alarm.name === EST_ALARM_NEAR || alarm.name === EST_ALARM_MET) {
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
    await checkSites().catch(() => {});
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
        hubHello(false, HUB_ACTIVE_MS).catch(() => {}); // popup / options opened = active (hourly at most)
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
      case "CLICKUP_TASK_PANEL": {
        try {
          const cfg = await getClickupConfig();
          if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
          sendResponse({ ok: true, data: await getTaskPanel(cfg.token, msg.taskId, !!msg.force) });
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
            const res = await fetch("https://api.clickup.com/api/v2/task/" + encodeURIComponent(taskId) + "/attachment", {
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
          const data = text ? await addTaskComment(cfg.token, taskId, text.slice(0, 5000)) : null;
          sendResponse({ ok: true, data, uploaded: links.length });
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
        try { sendResponse(await getPerfHistory(!!msg.force)); }
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
      case "CLICKUP_TASK_COMMENT": {
        try {
          const cfg = await getClickupConfig();
          const text = String(msg.text || "").trim();
          if (!cfg || !cfg.token) { sendResponse({ ok: false, error: "ClickUp isn't connected." }); break; }
          if (!text) { sendResponse({ ok: false, error: "Write a comment first." }); break; }
          sendResponse({ ok: true, data: await addTaskComment(cfg.token, msg.taskId, text.slice(0, 5000)) });
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
        } catch (e) { sendResponse({ ok: false, reason: String(e && e.message ? e.message : e) }); }
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
        const r = await hubCall(a, p, !!msg.admin);
        if (r && r.ok && (a === "notice" || a === "notices") && Array.isArray(r.notices)) await setHubNotices(r.notices).catch(() => {});
        if (r && r.ok && (a === "post" || a === "metoo")) {
          const { hubSeen } = await chrome.storage.local.get("hubSeen");
          await chrome.storage.local.set({ hubActive: true, hubSeen: hubSeen || {} });
        }
        sendResponse(r);
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
        await chrome.storage.local.set({ hubSeen: seen });
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
        try {
          await setTaskStatus(cfg.token, taskId, "complete");
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
            noDue: c.noDue !== false, blocked: c.blocked !== false,
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
          refreshClickup({ includeTasks: true, forceWeeks: true, forceWeekly: true }).catch(() => {});
          break;
        }
        if (patch.clickupWeekMode !== undefined) {
          // Same here: the week bundles rebuild in the background.
          sendResponse({ ok: true, settings: next });
          refreshClickup({ includeTasks: false, forceWeeks: true }).catch(() => {});
          break;
        }
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
      case "CLICKUP_CREATE_TASK": {
        // "Apply to ClickUp" on a draft task (local-tasks.js): one POST.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token) { sendResponse({ ok: false, reason: "not-configured", error: "Connect ClickUp first (ClickUp setup)." }); break; }
        const d = msg.draft || {};
        const listId = String(d.listId || "").trim();
        if (!/^\d+$/.test(listId)) { sendResponse({ ok: false, error: "Pick the List to create it in." }); break; }
        if (!String(d.name || "").trim()) { sendResponse({ ok: false, error: "The task needs a name." }); break; }
        try {
          const task = await createTask(cfg.token, listId, {
            name: d.name, md: d.md, dueDateMs: d.dueDateMs, estimateMs: d.estimateMs, priority: d.priority,
            assignees: d.assignMe !== false && cfg.userId != null ? [cfg.userId] : [],
          });
          openTasksCache = null;
          clearFilterCache();
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, task });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e), status: e && e.status });
        }
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
          await setTaskDueDate(cfg.token, taskId, due, task ? task.dueDateHasTime : null);
          clearFilterCache();
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, dueDateMs: due });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
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
          const tok = await getFileToken(true);
          if (!tok) { sendResponse({ ok: false, reason: "Google didn't grant permission to create the file." }); break; }
          const r = await createGoogleFile(tok, { name: msg.name || "tasks", html: msg.html || "", csv: msg.csv || "", kind: msg.kind === "docs" ? "docs" : "sheets" });
          // Google files are private by default; share on request so the link works for the team.
          const shared = msg.share === false ? false : await shareAnyoneWithLink(tok, r.id).catch(() => false);
          sendResponse({ ok: true, url: r.url, shared });
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
        const deps = Array.isArray(settings.clickupDepartments) ? settings.clickupDepartments : [];
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
        try {
          const head = { Authorization: "Bearer " + saved.token, Accept: "application/vnd.github+json" };
          const now = Date.now();
          const cur = await ghGetJsonFile(head, TEAM_SITES_PATH);
          await ghPutJsonFile(head, TEAM_SITES_PATH, { v: 1, updatedAt: now, enc: await encryptWithPassphrase({ sites }, teamSitesPass(cfg.teamId)) },
            cur.sha, "Update team client sites");
          const pol = await ghGetJsonFile(head, UPDATE_POLICY_PATH);
          const next = normalizeUpdatePolicy({ ...(pol.data || UPDATE_POLICY_DEFAULTS), sitesAt: now });
          next.updatedAt = now;
          await ghPutJsonFile(head, UPDATE_POLICY_PATH, next, pol.sha, "Announce updated team client sites");
          await purgePolicyCdn();
          fetch("https://purge.jsdelivr.net/gh/" + UPDATE_REPO + "@main/" + TEAM_SITES_PATH, { cache: "no-store" }).catch(() => {});
          // This copy takes them straight away.
          const added = await applyTeamSites(sites);
          await chrome.storage.local.set({ teamSites: { key: now + ":" + cfg.teamId, status: "ok", triedAt: now, at: now, list: sites, added } });
          sendResponse({ ok: true, count: sites.length, added, at: now });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
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
            const res = await fetch("https://api.clickup.com/api/v2/task/" + encodeURIComponent(taskId), {
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
          refreshClickup({ includeTasks: true, forceWeeks: true }).catch(() => {});
          sendResponse({ ok: true, dueDateMs: due });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
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
      case "CLICKUP_DONE_TODAY": {
        // Wrap-up page's Daily Tasks Update: every task you closed today, in every
        // project, with its client and the links in its description. Asked when the
        // page opens / Refresh is pressed (kept a minute), never on a timer.
        const cfg = await getClickupConfig();
        if (!cfg || !cfg.token || !cfg.teamId || cfg.userId == null) { sendResponse({ ok: false, reason: "not-configured" }); break; }
        const from = new Date().setHours(0, 0, 0, 0);
        if (!msg.force && doneTodayCache && doneTodayCache.day === from && Date.now() - doneTodayCache.at < 60000) {
          sendResponse({ ok: true, tasks: doneTodayCache.tasks }); break;
        }
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
          sendResponse({ ok: true, tasks });
        } catch (e) {
          sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
        }
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
          departments: Array.isArray(settings.clickupDepartments) ? settings.clickupDepartments : [],
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
