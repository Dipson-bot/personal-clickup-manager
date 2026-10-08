// Personal ClickUp Manager - team hub (Google Apps Script web app).
//
// The extension's "Help & issues" tab and the Admin tab talk to this script.
// Everything is kept in YOUR Google account: one "PCM team hub" spreadsheet
// (Users, Threads, Messages) plus a Drive folder for screenshots and files.
//
// Setup (about 3 minutes):
//   1. script.google.com > New project > replace everything with this file > Save.
//   2. Pick "setup" in the function list at the top > Run > allow access
//      (it's your own script). The log at the bottom shows your ADMIN KEY.
//   3. Deploy > New deployment > type: Web app > Execute as: Me,
//      Who has access: Anyone > Deploy. Copy the Web app URL (ends in /exec).
//   4. Extension > Admin > Team hub: paste the URL and the admin key > Save & test.
// After changing this script later: Deploy > Manage deployments > edit > New version.
//
// Without the admin key, a copy of the extension can only: check in (name,
// photo, version), read the threads, post, reply, "me too", and delete its own
// messages - all rate-limited and blocked for muted / banned installs.
// Diagnostics and full-size files are only ever returned with the admin key.

const MAX_FILES = 8;
const MAX_TOTAL_B64 = 27 * 1024 * 1024; // ~20 MB of files per message
const MSG_MAX = 4000;
const TITLE_MAX = 150;
const POSTS_PER_HOUR = 30; // per install (slow mode can tighten it)
const ALL_CALLS_PER_MIN = 240; // whole hub, a safety valve

const SHEETS = {
  Users: ["install", "cuUserId", "name", "avatar", "color", "initials", "version", "firstSeen", "lastSeen", "status", "mutedUntil"],
  Threads: ["id", "title", "status", "pinned", "locked", "fixedIn", "byInstall", "byName", "byAvatar", "createdAt", "lastAt", "lastRole", "count", "metoo", "deleted"],
  Messages: ["id", "threadId", "install", "name", "avatar", "color", "initials", "role", "text", "at", "editedAt", "files", "diag", "deleted", "reactions", "replyTo"],
  // Announcements from the admin (maintenance break, sudden holiday...), shown to everyone until "until".
  Notices: ["id", "title", "text", "level", "createdAt", "until", "ended"],
  // Task reminders one teammate sends another (both on the same task); collected by the recipient's extension.
  Nudges: ["id", "toUser", "fromInstall", "fromUser", "fromName", "taskId", "taskName", "taskUrl", "text", "at", "deliveredAt"],
};
const NUDGES_PER_HOUR = 20; // per install
const REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "🙏", "✅", "👀"];

// ---------- storage ----------
function props() { return PropertiesService.getScriptProperties(); }
function adminKey() {
  let k = props().getProperty("ADMIN_KEY");
  if (!k) { k = Utilities.getUuid().replace(/-/g, ""); props().setProperty("ADMIN_KEY", k); }
  return k;
}
function setup() {
  folder();
  for (const n of Object.keys(SHEETS)) table(n);
  const k = adminKey();
  Logger.log("Your ADMIN KEY (paste it into the extension's Admin > Team hub): " + k);
  return k;
}
function folder() {
  const id = props().getProperty("FOLDER_ID");
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder("PCM team hub files");
  props().setProperty("FOLDER_ID", f.getId());
  return f;
}
function book() {
  const id = props().getProperty("BOOK_ID");
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) {} }
  const ss = SpreadsheetApp.create("PCM team hub");
  try { DriveApp.getFileById(ss.getId()).moveTo(folder()); } catch (e) {}
  props().setProperty("BOOK_ID", ss.getId());
  return ss;
}
function table(name) {
  const ss = book();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    const first = ss.getSheets()[0];
    sh = first && first.getLastRow() === 0 && first.getName() === "Sheet1" ? first.setName(name) : ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  } else if (sh.getLastColumn && sh.getLastColumn() < SHEETS[name].length) {
    sh.getRange(1, 1, 1, SHEETS[name].length).setValues([SHEETS[name]]); // columns added in a newer version
  }
  return sh;
}
// Rows as objects (with _row = sheet row number).
function readAll(name) {
  const sh = table(name);
  const v = sh.getDataRange().getValues();
  const h = SHEETS[name];
  return v.slice(1).map((r, i) => { const o = { _row: i + 2 }; h.forEach((k, j) => { o[k] = r[j]; }); return o; });
}
function writeRow(name, o) {
  const h = SHEETS[name];
  const row = h.map((k) => (o[k] === undefined ? "" : o[k]));
  const sh = table(name);
  if (o._row) sh.getRange(o._row, 1, 1, h.length).setValues([row]);
  else { sh.appendRow(row); o._row = sh.getLastRow(); }
}
// Drop a row for good. Only for rows that came from readAll (they carry _row);
// deleting shifts every row below it, so the caller must re-read before touching
// another one - which it does, since each request reads the sheet fresh.
function deleteRow(name, o) {
  if (!o || !Number(o._row)) return false;
  table(name).deleteRow(Number(o._row));
  return true;
}
const js = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const now = () => Date.now();
const setting = (k, d) => { const v = props().getProperty(k); return v == null ? d : v; };

// ---------- web app ----------
function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out({ ok: true, service: "pcm-hub" }); }
function doPost(e) {
  let q;
  try { q = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "bad request" }); }
  try {
    if (!flowOk()) return out({ ok: false, error: "The hub is busy - try again in a minute." });
    const admin = q.key && String(q.key) === adminKey();
    if (q.key && !admin) return out({ ok: false, error: "wrong admin key" });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (q.action) {
        case "hello": return out(hello(q));
        case "threads": return out(threads(q, admin));
        case "thread": return out(thread(q, admin));
        case "post": return out(post(q, admin));
        case "metoo": return out(metoo(q));
        case "deleteOwn": return out(deleteOwn(q));
        case "react": return out(react(q));
        case "notices": return out(notices());
        case "nudge": return out(nudge(q));
        case "nudges": return out(nudges(q));
      }
      if (!admin) return out({ ok: false, error: "admin only" });
      switch (q.action) {
        case "users": return out(users());
        case "mod": return out(mod(q));
        case "settings": return out(saveSettings(q));
        case "notice": return out(notice(q));
      }
      return out({ ok: false, error: "unknown action" });
    } finally { lock.releaseLock(); }
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err) });
  }
}
function flowOk() {
  const c = CacheService.getScriptCache();
  const k = "flow:" + Math.floor(now() / 60000);
  const n = Number(c.get(k) || 0);
  if (n >= ALL_CALLS_PER_MIN) return false;
  c.put(k, String(n + 1), 120);
  return true;
}
function cleanInstall(q) { return String(q.install || "").replace(/[^a-z0-9]/gi, "").slice(0, 40); }
function pub() { return { slowMin: Number(setting("SLOW_MIN", "0")) || 0, filesPublic: setting("FILES_PUBLIC", "0") === "1" }; }

// ---------- users ----------
function findUser(install) { return readAll("Users").find((u) => String(u.install) === install) || null; }
function userState(u) {
  if (!u) return "ok";
  if (u.status === "banned") return "banned";
  if (Number(u.mutedUntil) > now()) return "muted";
  return "ok";
}
function hello(q) {
  const install = cleanInstall(q);
  if (!install) return { ok: false, error: "no install id" };
  let u = findUser(install);
  const t = now();
  if (!u) u = { install, firstSeen: t, status: "ok", mutedUntil: 0 };
  u.cuUserId = String(q.cuUserId || u.cuUserId || "").slice(0, 30);
  u.name = String(q.name || u.name || "").slice(0, 80);
  u.avatar = /^https:\/\//.test(String(q.avatar || "")) ? String(q.avatar).slice(0, 500) : (u.avatar || "");
  u.color = /^#[0-9a-f]{3,8}$/i.test(String(q.color || "")) ? String(q.color) : (u.color || "");
  u.initials = String(q.initials || u.initials || "").slice(0, 4);
  u.version = String(q.version || u.version || "").slice(0, 20);
  u.lastSeen = t;
  writeRow("Users", u);
  return { ok: true, state: userState(u), mutedUntil: Number(u.mutedUntil) || 0, settings: pub() };
}
function users() {
  const t = now();
  const list = readAll("Users").map((u) => ({
    install: String(u.install), cuUserId: String(u.cuUserId), name: String(u.name), avatar: String(u.avatar), color: String(u.color), initials: String(u.initials),
    version: String(u.version), firstSeen: Number(u.firstSeen) || 0, lastSeen: Number(u.lastSeen) || 0, state: userState(u), mutedUntil: Number(u.mutedUntil) || 0,
  })).sort((a, b) => b.lastSeen - a.lastSeen);
  const day = 86400000;
  return { ok: true, users: list, total: list.length, activeToday: list.filter((u) => t - u.lastSeen < day).length, activeWeek: list.filter((u) => t - u.lastSeen < 7 * day).length, settings: pub() };
}

// ---------- threads / messages ----------
function threads(q, admin) {
  const install = cleanInstall(q);
  const msgs = readAll("Messages").filter((m) => !m.deleted);
  const mineThreads = new Set(msgs.filter((m) => String(m.install) === install).map((m) => String(m.threadId)));
  const list = readAll("Threads").filter((t) => !t.deleted).map((t) => {
    const mt = js(t.metoo, []);
    return {
      id: String(t.id), title: String(t.title), status: String(t.status || "open"), pinned: !!t.pinned, locked: !!t.locked, fixedIn: String(t.fixedIn || ""),
      byName: String(t.byName), byAvatar: String(t.byAvatar), createdAt: Number(t.createdAt) || 0, lastAt: Number(t.lastAt) || 0, lastRole: String(t.lastRole || ""),
      count: Number(t.count) || 0, metoo: mt.length, metooMine: mt.indexOf(install) >= 0,
      mine: String(t.byInstall) === install || mineThreads.has(String(t.id)) || mt.indexOf(install) >= 0,
    };
  }).sort((a, b) => (b.pinned - a.pinned) || (b.lastAt - a.lastAt)).slice(0, 300);
  return { ok: true, threads: list, settings: pub(), admin: !!admin };
}
function thread(q, admin) {
  const id = String(q.id || "");
  const t = readAll("Threads").find((x) => String(x.id) === id && !x.deleted);
  if (!t) return { ok: false, error: "That thread was removed." };
  const install = cleanInstall(q);
  const showFiles = admin || pub().filesPublic;
  const names = {};
  for (const u of readAll("Users")) names[String(u.install)] = String(u.name || "");
  const all = readAll("Messages").filter((m) => String(m.threadId) === id);
  const byId = {};
  for (const m of all) byId[String(m.id)] = m;
  const msgs = all.filter((m) => !m.deleted).map((m) => {
    const rx = js(m.reactions, {});
    const reactions = REACTIONS.filter((e) => Array.isArray(rx[e]) && rx[e].length).map((e) => ({ emoji: e, count: rx[e].length, mine: rx[e].indexOf(install) >= 0, who: rx[e].slice(0, 12).map((i) => names[i] || "someone") }));
    const q2 = m.replyTo ? byId[String(m.replyTo)] : null;
    const replyTo = q2 ? { id: String(q2.id), name: String(q2.name || ""), text: q2.deleted ? "(deleted)" : String(q2.text || "").slice(0, 140) } : null;
    const files = js(m.files, []).map((f) => {
      const o = { name: String(f.name), type: String(f.type || "") };
      if (showFiles && /^image\//.test(o.type)) { try { const th = DriveApp.getFileById(f.id).getThumbnail(); if (th) o.thumb = "data:" + th.getContentType() + ";base64," + Utilities.base64Encode(th.getBytes()); } catch (e) {} }
      if (admin) o.url = "https://drive.google.com/file/d/" + f.id + "/view";
      return o;
    });
    return {
      id: String(m.id), name: String(m.name), avatar: String(m.avatar), color: String(m.color), initials: String(m.initials), role: String(m.role || "user"),
      text: String(m.text), at: Number(m.at) || 0, editedAt: Number(m.editedAt) || 0, files, mine: String(m.install) === install,
      diag: admin ? String(m.diag || "") : "", install: admin ? String(m.install) : "",
      reactions, replyTo,
    };
  }).sort((a, b) => a.at - b.at);
  const mt = js(t.metoo, []);
  return { ok: true, thread: { id, title: String(t.title), status: String(t.status || "open"), pinned: !!t.pinned, locked: !!t.locked, fixedIn: String(t.fixedIn || ""), metoo: mt.length, metooMine: mt.indexOf(install) >= 0 }, messages: msgs, settings: pub(), admin: !!admin };
}
function rateOk(install, admin) {
  if (admin) return true;
  const c = CacheService.getScriptCache();
  const k = "p:" + install;
  const n = Number(c.get(k) || 0);
  if (n >= POSTS_PER_HOUR) return false;
  const slow = pub().slowMin;
  if (slow > 0) {
    const last = Number(c.get("last:" + install) || 0);
    if (last && now() - last < slow * 60000) return "slow";
  }
  c.put(k, String(n + 1), 3600);
  c.put("last:" + install, String(now()), 6 * 3600);
  return true;
}
function saveFiles(files, label) {
  const list = Array.isArray(files) ? files.slice(0, MAX_FILES) : [];
  if (!list.length) return [];
  let total = 0;
  for (const f of list) total += String((f && f.b64) || "").length;
  if (total > MAX_TOTAL_B64) throw new Error("The files are too big (20 MB in total).");
  const dir = folder().createFolder(label.replace(/[\\/:*?"<>|]/g, " ").slice(0, 80));
  return list.map((f) => {
    const blob = Utilities.newBlob(Utilities.base64Decode(String(f.b64 || "")), String(f.type || "application/octet-stream"), String(f.name || "file").slice(0, 120));
    const file = dir.createFile(blob);
    return { id: file.getId(), name: file.getName(), type: blob.getContentType() };
  });
}
function post(q, admin) {
  const install = cleanInstall(q);
  if (!install && !admin) return { ok: false, error: "no install id" };
  const u = findUser(install);
  const st = admin ? "ok" : userState(u);
  if (st === "banned") return { ok: false, error: "You can't post here any more (ask your admin)." };
  if (st === "muted") return { ok: false, error: "You're muted until " + new Date(Number(u.mutedUntil)).toLocaleString() + "." };
  const text = String(q.text || "").trim().slice(0, MSG_MAX);
  const files = Array.isArray(q.files) ? q.files : [];
  if (!text && !files.length) return { ok: false, error: "Write something first." };
  const t = now();
  const who = admin && q.asAdmin !== false ? { role: "admin" } : { role: "user" };
  let th;
  if (q.threadId) {
    th = readAll("Threads").find((x) => String(x.id) === String(q.threadId) && !x.deleted);
    if (!th) return { ok: false, error: "That thread was removed." };
    if (th.locked && !admin) return { ok: false, error: "This thread is locked." };
  } else {
    const title = String(q.title || "").trim().slice(0, TITLE_MAX);
    if (!title) return { ok: false, error: "Give the issue a short title." };
    th = { id: "t" + t.toString(36) + Math.random().toString(36).slice(2, 5), title, status: "open", pinned: "", locked: "", fixedIn: "",
      byInstall: install, byName: String((u && u.name) || q.name || "").slice(0, 80), byAvatar: String((u && u.avatar) || ""), createdAt: t, metoo: "[]", count: 0, deleted: "" };
  }
  // Rate limits last, so a post refused for another reason doesn't use them up.
  const r = rateOk(install, admin);
  if (r === "slow") return { ok: false, error: "Slow mode is on: one message every " + pub().slowMin + " min." };
  if (!r) return { ok: false, error: "Too many messages - try again later." };
  const saved = saveFiles(files, th.id + " " + new Date(t).toISOString().slice(0, 16));
  const m = {
    id: "m" + t.toString(36) + Math.random().toString(36).slice(2, 5), threadId: th.id, install,
    name: String((u && u.name) || q.name || (admin ? "Admin" : "")).slice(0, 80), avatar: String((u && u.avatar) || ""), color: String((u && u.color) || ""), initials: String((u && u.initials) || ""),
    role: who.role, text, at: t, editedAt: "", files: JSON.stringify(saved), diag: String(q.diag || "").slice(0, 45000), deleted: "",
    reactions: "{}", replyTo: String(q.replyTo || "").slice(0, 40),
  };
  writeRow("Messages", m);
  th.lastAt = t; th.lastRole = who.role; th.count = (Number(th.count) || 0) + 1;
  writeRow("Threads", th);
  if (who.role !== "admin") {
    try {
      MailApp.sendEmail(Session.getEffectiveUser().getEmail(), "[PCM hub] " + (q.threadId ? "Reply: " : "New issue: ") + th.title,
        (m.name || "Someone") + ":\n\n" + text + (saved.length ? "\n\n(" + saved.length + " file(s) attached)" : "") + "\n\nOpen the extension's Help & issues tab to answer.");
    } catch (e) {}
  }
  return { ok: true, threadId: th.id, messageId: m.id };
}
// A reaction on a message: toggles this install's emoji (muted / banned can't).
function react(q) {
  const install = cleanInstall(q);
  const emoji = String(q.emoji || "");
  if (!install || REACTIONS.indexOf(emoji) < 0) return { ok: false, error: "not allowed" };
  const st = userState(findUser(install));
  if (st !== "ok") return { ok: false, error: st === "banned" ? "You can't react here any more." : "You're muted for now." };
  const m = readAll("Messages").find((x) => String(x.id) === String(q.id) && !x.deleted);
  if (!m) return { ok: false, error: "That message was removed." };
  const rx = js(m.reactions, {});
  const list = Array.isArray(rx[emoji]) ? rx[emoji] : [];
  const i = list.indexOf(install);
  if (i >= 0) list.splice(i, 1); else list.push(install);
  rx[emoji] = list;
  m.reactions = JSON.stringify(rx);
  writeRow("Messages", m);
  return { ok: true, count: list.length, mine: i < 0 };
}
function metoo(q) {
  const install = cleanInstall(q);
  const th = readAll("Threads").find((x) => String(x.id) === String(q.id) && !x.deleted);
  if (!th || !install) return { ok: false, error: "not found" };
  const mt = js(th.metoo, []);
  const i = mt.indexOf(install);
  if (i >= 0) mt.splice(i, 1); else mt.push(install);
  th.metoo = JSON.stringify(mt);
  writeRow("Threads", th);
  return { ok: true, metoo: mt.length, mine: i < 0 };
}
function deleteOwn(q) {
  const install = cleanInstall(q);
  const m = readAll("Messages").find((x) => String(x.id) === String(q.id) && !x.deleted);
  if (!m || String(m.install) !== install) return { ok: false, error: "You can only delete your own messages." };
  m.deleted = now();
  writeRow("Messages", m);
  bumpCount(String(m.threadId));
  return { ok: true };
}
function bumpCount(threadId) {
  const th = readAll("Threads").find((x) => String(x.id) === threadId);
  if (!th) return;
  const left = readAll("Messages").filter((m) => String(m.threadId) === threadId && !m.deleted);
  th.count = left.length;
  if (!left.length) th.deleted = now(); // nothing left: the thread goes too
  writeRow("Threads", th);
}

// ---------- admin ----------
function mod(q) {
  const op = String(q.op || "");
  if (["editMsg", "deleteMsg"].indexOf(op) >= 0) {
    const m = readAll("Messages").find((x) => String(x.id) === String(q.id) && !x.deleted);
    if (!m) return { ok: false, error: "message not found" };
    if (op === "editMsg") { m.text = String(q.text || "").slice(0, MSG_MAX); m.editedAt = now(); writeRow("Messages", m); }
    else { m.deleted = now(); writeRow("Messages", m); bumpCount(String(m.threadId)); }
    return { ok: true };
  }
  // "forget": take a copy off the Users list. The Users sheet is keyed by install
  // id, so one person who reinstalled or uses a second Chrome profile holds two
  // rows and shows up twice in the admin panel; this is how the admin clears the
  // leftovers. Nothing on that computer changes, and the row comes back on its
  // next check-in - hello() recreates it.
  if (op === "forget") {
    const u = findUser(String(q.install || ""));
    if (!u) return { ok: true, gone: true }; // already off the list: nothing to do
    deleteRow("Users", u);
    return { ok: true };
  }
  if (["mute", "unmute", "ban", "unban"].indexOf(op) >= 0) {
    const u = findUser(String(q.install || ""));
    if (!u) return { ok: false, error: "user not found" };
    if (op === "mute") u.mutedUntil = now() + Math.max(1, Math.min(24 * 30, Number(q.hours) || 24)) * 3600000;
    if (op === "unmute") u.mutedUntil = 0;
    if (op === "ban") u.status = "banned";
    if (op === "unban") u.status = "ok";
    writeRow("Users", u);
    return { ok: true };
  }
  const th = readAll("Threads").find((x) => String(x.id) === String(q.id) && !x.deleted);
  if (!th) return { ok: false, error: "thread not found" };
  if (op === "pin") th.pinned = 1;
  else if (op === "unpin") th.pinned = "";
  else if (op === "lock") th.locked = 1;
  else if (op === "unlock") th.locked = "";
  else if (op === "resolve") { th.status = "resolved"; th.fixedIn = String(q.fixedIn || "").slice(0, 20); th.lastAt = now(); th.lastRole = "admin"; }
  else if (op === "reopen") { th.status = "open"; th.fixedIn = ""; }
  else if (op === "rename") th.title = String(q.title || th.title).slice(0, TITLE_MAX);
  else if (op === "deleteThread") th.deleted = now();
  else return { ok: false, error: "unknown op" };
  writeRow("Threads", th);
  return { ok: true };
}
// ---------- notices ----------
// Everyone: the notices still showing (newest first, at most 10).
function notices() {
  const t = now();
  const list = readAll("Notices").filter((n) => !n.ended && Number(n.until) > t)
    .sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, 10)
    .map((n) => ({ id: String(n.id), title: String(n.title), text: String(n.text), level: String(n.level || "info"), createdAt: Number(n.createdAt) || 0, until: Number(n.until) || 0 }));
  return { ok: true, notices: list };
}
// ---------- task reminders between teammates ----------
// nudge { toUser (ClickUp user id), taskId, taskName, taskUrl, text }: only to
// someone whose extension has checked in (so it can actually show it).
function nudge(q) {
  const install = cleanInstall(q);
  const u = install ? findUser(install) : null;
  if (!u) return { ok: false, error: "Open the extension once more so the hub knows who you are, then try again." };
  const st = userState(u);
  if (st !== "ok") return { ok: false, error: st === "banned" ? "You can't send reminders (ask your admin)." : "You're muted for now." };
  const to = String(q.toUser || "").replace(/[^0-9]/g, "").slice(0, 30);
  if (!to) return { ok: false, error: "No person picked." };
  if (to === String(u.cuUserId)) return { ok: false, reason: "self", error: "That's you." };
  if (!readAll("Users").some((x) => String(x.cuUserId) === to && x.status !== "banned")) return { ok: false, reason: "no-extension" };
  const t = now();
  const all = readAll("Nudges");
  if (all.filter((n) => String(n.fromInstall) === install && t - Number(n.at) < 3600000).length >= NUDGES_PER_HOUR) return { ok: false, error: "That's a lot of reminders for one hour - try again later." };
  const url = /^https:\/\/app\.clickup\.com\//.test(String(q.taskUrl || "")) ? String(q.taskUrl).slice(0, 300) : "";
  writeRow("Nudges", { id: "n" + t.toString(36) + Math.random().toString(36).slice(2, 5), toUser: to, fromInstall: install, fromUser: String(u.cuUserId || ""), fromName: String(u.name || "").slice(0, 80),
    taskId: String(q.taskId || "").slice(0, 40), taskName: String(q.taskName || "").slice(0, 200), taskUrl: url, text: String(q.text || "").trim().slice(0, 300), at: t, deliveredAt: "" });
  return { ok: true };
}
// nudges: this install's user's reminders not collected yet (marked collected now).
function nudges(q) {
  const install = cleanInstall(q);
  const u = install ? findUser(install) : null;
  if (!u || !u.cuUserId) return { ok: true, nudges: [] };
  const t = now();
  const list = readAll("Nudges").filter((n) => String(n.toUser) === String(u.cuUserId) && !n.deliveredAt && t - Number(n.at) < 7 * 86400000);
  for (const n of list) { n.deliveredAt = t; writeRow("Nudges", n); }
  return { ok: true, nudges: list.map((n) => ({ id: String(n.id), fromName: String(n.fromName), taskId: String(n.taskId), taskName: String(n.taskName), taskUrl: String(n.taskUrl), text: String(n.text), at: Number(n.at) || 0 })) };
}

// Admin: op "post" { title, text, level, until } or op "end" { id }.
function notice(q) {
  if (q.op === "end") {
    const n = readAll("Notices").find((x) => String(x.id) === String(q.id || ""));
    if (!n) return { ok: false, error: "notice not found" };
    n.ended = now(); writeRow("Notices", n);
    return notices();
  }
  const title = String(q.title || "").trim().slice(0, TITLE_MAX);
  const text = String(q.text || "").trim().slice(0, MSG_MAX);
  if (!title) return { ok: false, error: "Write a title for the notice." };
  const level = ["info", "important", "urgent"].includes(q.level) ? q.level : "info";
  const until = Math.min(Number(q.until) || 0, now() + 60 * 86400000);
  if (!(until > now())) return { ok: false, error: "Pick when the notice should stop showing (a time in the future)." };
  writeRow("Notices", { id: Utilities.getUuid().slice(0, 12), title, text, level, createdAt: now(), until, ended: "" });
  return notices();
}
function saveSettings(q) {
  if (q.slowMin != null) props().setProperty("SLOW_MIN", String(Math.max(0, Math.min(120, Number(q.slowMin) || 0))));
  if (q.filesPublic != null) props().setProperty("FILES_PUBLIC", q.filesPublic ? "1" : "0");
  return { ok: true, settings: pub() };
}
