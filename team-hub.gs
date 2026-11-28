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
  Users: ["install", "cuUserId", "name", "avatar", "color", "initials", "version", "firstSeen", "lastSeen", "status", "mutedUntil", "role", "perf"],
  Threads: ["id", "title", "status", "pinned", "locked", "fixedIn", "byInstall", "byName", "byAvatar", "createdAt", "lastAt", "lastRole", "count", "metoo", "deleted"],
  Messages: ["id", "threadId", "install", "name", "avatar", "color", "initials", "role", "text", "at", "editedAt", "files", "diag", "deleted", "reactions", "replyTo"],
  // Announcements from the admin (maintenance break, sudden holiday...), shown to everyone until "until".
  Notices: ["id", "title", "text", "level", "createdAt", "until", "ended"],
  // Task reminders one teammate sends another (both on the same task); collected by the recipient's extension.
  Nudges: ["id", "toUser", "fromInstall", "fromUser", "fromName", "taskId", "taskName", "taskUrl", "text", "at", "deliveredAt"],
  // Client instructions found in the clients' Slack channels by someone's extension
  // ("hold off changes from Wednesday"...), so the whole team sees them.
  ClientNotes: ["id", "client", "channel", "at", "text", "permalink", "fromMs", "untilMs", "kind", "summary", "important", "onsite", "ai", "byInstall", "byName", "addedAt"],
};
const CNOTES_KEEP_MS = 45 * 86400000;
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
// Bumped whenever this script changes, so Admin › Team hub can say "your hub needs updating".
const HUB_VERSION = "2026-11-29";
function doGet() { return out({ ok: true, service: "pcm-hub", version: HUB_VERSION }); }
// Run once from the Apps Script editor (pick "authorize" next to Run): makes Google ask for every
// permission in appsscript.json - a new version doesn't always ask, and the hub then can't fetch.
function authorize() { ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL); return "Authorized - the hub can now read Google data and reach data hubs."; }
function doPost(e) {
  let q;
  try { q = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: "bad request" }); }
  try {
    if (!flowOk()) return out({ ok: false, error: "The hub is busy - try again in a minute." });
    // Two kinds of admin. The OWNER holds the admin key (whoever set the hub
    // up); nobody can take that away. Other people can be made admins by the
    // owner (Users "role" = "admin"): they get the admin tools through their
    // own install id, but only the owner can change roles, and they can't
    // mute / ban / remove the owner or another admin.
    const owner = !!(q.key && String(q.key) === adminKey());
    if (q.key && !owner) return out({ ok: false, error: "wrong admin key" });
    const me = cleanInstall(q);
    if (owner && me && setting("OWNER_INSTALL", "") !== me) props().setProperty("OWNER_INSTALL", me);
    const meRow = !owner && me ? findUser(me) : null;
    const admin = owner || !!(meRow && meRow.role === "admin" && userState(meRow) === "ok");
    q._owner = owner;
    if (me) touchPresence(me, q.act, q.day); // Script Properties + cache only, no sheet
    // Reading needs no lock. Only writes take it, so one slow read (a thread's
    // picture thumbnails, a long list) can no longer make everyone else wait
    // until "Lock timeout" - which is what happened with a dozen copies calling.
    switch (q.action) {
      case "threads": return out(threads(q, admin));
      case "thread": return out(thread(q, admin));
      case "notices": return out(notices());
      case "probe": return out(probe(q, meRow, owner));
      case "gdataProps": return out(gdataPropsHub(q, meRow, owner));
      case "gdataReport": return out(gdataReportHub(q, meRow, owner));
      case "gdataMonthly": return out(gdataMonthlyHub(q, meRow, owner));
      case "recipes": return out(recipesGet(q, meRow, owner));
      case "cnotes": return out(cnotes(q));
      case "users": if (admin) { const r = users(); r.youOwner = !!q._owner; return out(r); } break;
      case "nudges": if (!nudgesWaiting(q)) return out({ ok: true, nudges: [] }); break; // most checks: nothing new, no lock
      case "hello": if (!helloNeedsWrite(q, meRow)) return out(helloReply(q, meRow)); break; // nothing changed: no write
    }
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(25000)) return out({ ok: false, busy: true, error: "The hub is busy - try again in a minute." });
    try {
      switch (q.action) {
        case "hello": return out(hello(q));
        case "post": return out(post(q, admin));
        case "metoo": return out(metoo(q));
        case "deleteOwn": return out(deleteOwn(q));
        case "react": return out(react(q));
        case "cnotePost": return out(cnotePost(q));
        case "deliveredSave": return out(deliveredSave(q, meRow, owner));
        case "nudge": return out(nudge(q));
        case "nudges": return out(nudges(q));
      }
      if (!admin) return out({ ok: false, error: "admin only" });
      switch (q.action) {
        case "mod": return out(mod(q));
        case "settings": return out(saveSettings(q));
        case "notice": return out(notice(q));
        case "gdataHubs": return out(gdataHubs(q));
        case "recipesSave": return out(recipesSave(q));
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

// ---------- presence ----------
// Every call a copy makes (notices every 10 min, reminders every 3) says it is
// running (on) and when its person last used the computer (act). Kept in Script
// Properties (pres_<install>), written at most every 5 minutes per copy - sooner
// only when they came back after a break or started another task - so it costs
// no extra requests. day: their Due today / This week numbers and running task
// (for the admin's card when a picture is clicked).
function touchPresence(install, act, day) {
  try {
    const c = CacheService.getScriptCache(), k = "pres_" + install, t = now();
    const a = Math.min(t, Number(act) || 0);
    const prev = js(c.get(k) || "", null);
    const d = typeof day === "string" && day.length <= 2000 ? js(day, null) : null;
    const runId = (x) => String((x && x.run && x.run.id) || "");
    const runMoved = !!d && !!prev && runId(d) !== runId(prev.day);
    if (prev && !runMoved && t - prev.on < 5 * 60000 && a - (Number(prev.act) || 0) < 5 * 60000) return;
    const v = JSON.stringify({ on: t, act: Math.max(a, (prev && Number(prev.act)) || 0), day: d || (prev && prev.day) || null });
    props().setProperty(k, v);
    c.put(k, v, 21600);
  } catch (e) {}
}

// ---------- site probe ----------
// Site monitor's second opinion: a site that doesn't open from someone's office
// is loaded once from Google's servers. Up from here = that office's network is
// blocked by the site's firewall, not an outage. Team members only, http(s) only,
// no private addresses. One answer per site is shared for 5 minutes, so a client
// site gets at most one extra request per 5 minutes however many copies ask.
// ---------- Google data for Site monitor (Search Console + GA4), read as the hub's owner ----------
// The hub runs as the Google account that deployed it, so the team never signs in to
// Google: the extension asks the hub, the hub reads with its owner's access (scopes in
// appsscript.json: webmasters.readonly, analytics.readonly). That account must be able
// to see every client's Search Console / Analytics property. Cached: the property list
// 6 hours, each report 6 hours (CacheService's maximum).
function gfetch(url, body) {
  const opt = { muteHttpExceptions: true, headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() } };
  if (body) { opt.method = "post"; opt.contentType = "application/json"; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(url, opt), code = res.getResponseCode(), txt = res.getContentText();
  if (code >= 300) { let m = "HTTP " + code; try { const j = JSON.parse(txt); m = (j.error && (j.error.message || j.error.status)) || m; } catch (e) {} throw new Error(m); }
  return JSON.parse(txt);
}
function cacheBig(key, val, secs) { // CacheService keeps 100 KB a value: split longer ones
  const c = CacheService.getScriptCache(), s = JSON.stringify(val), parts = Math.ceil(s.length / 90000);
  const m = {}; for (let i = 0; i < parts; i++) m[key + ":" + i] = s.slice(i * 90000, (i + 1) * 90000);
  m[key] = String(parts);
  c.putAll(m, secs);
}
function cacheBigGet(key) {
  const c = CacheService.getScriptCache(), n = Number(c.get(key) || 0);
  if (!n) return null;
  const keys = []; for (let i = 0; i < n; i++) keys.push(key + ":" + i);
  const got = c.getAll(keys); let s = "";
  for (const k of keys) { if (got[k] == null) return null; s += got[k]; }
  try { return JSON.parse(s); } catch (e) { return null; }
}
function gdataAllowed(meRow, owner) { return owner || !!(meRow && userState(meRow) === "ok"); }
// Data hubs: small copies of this Google-data code running as OTHER Google accounts (the
// ones that can see the clients' properties), asked with their own secret key. The team
// hub merges what they see and forwards each report to the hub that owns the property,
// so the team hub's own account needs no client access. Script property GDATA_HUBS =
// [{ url, key }] (Admin › Team hub › Google data hubs).
function gdataRemotes() { const v = js(setting("GDATA_HUBS", "[]"), []); return Array.isArray(v) ? v : []; }
function gdataAsk(h, body) {
  const res = UrlFetchApp.fetch(h.url, { method: "post", contentType: "application/json", payload: JSON.stringify(Object.assign({}, body, { key: h.key })), muteHttpExceptions: true, followRedirects: true });
  let j = null; try { j = JSON.parse(res.getContentText()); } catch (e) {}
  if (!j) throw new Error("data hub said HTTP " + res.getResponseCode());
  if (!j.ok) throw new Error(j.error || "data hub error");
  return j;
}
function gdataPropsHub(q, meRow, owner) {
  if (!gdataAllowed(meRow, owner)) return { ok: false, error: "not allowed" };
  if (!q.force) { const hit = cacheBigGet("gd:props"); if (hit) return hit; }
  const out = { ok: true, at: now(), gsc: [], gscHub: {}, gscAcct: {}, ga: [], errs: [], account: Session.getEffectiveUser().getEmail(), accounts: [] };
  const remotes = gdataRemotes();
  // This hub's own account first (often sees nothing), then every data hub.
  const own = gdataPropsOwn();
  const addFrom = function (p, hubIdx, label) {
    let ng = 0, na = 0;
    (p.gsc || []).forEach(function (u) { if (!(u in out.gscHub)) { out.gsc.push(u); out.gscHub[u] = hubIdx; out.gscAcct[u] = label || ""; ng++; } });
    (p.ga || []).forEach(function (x) { if (!out.ga.some(function (y) { return y.id === x.id; })) { out.ga.push({ id: x.id, name: x.name, account: x.account, uris: x.uris || [], hub: hubIdx, acct: label || "" }); na++; } });
    (p.errs || []).forEach(function (e) { if (ng + na === 0 || hubIdx >= 0) out.errs.push((label ? label + ": " : "") + e); });
    out.accounts.push({ email: label || p.account || "", gsc: ng, ga: na });
  };
  addFrom(own, -1, own.account);
  remotes.forEach(function (h, i) {
    try { const p = gdataAsk(h, { action: "gdataProps", force: !!q.force }); addFrom(p, i, p.account || "data hub " + (i + 1)); }
    catch (e) { out.errs.push("data hub " + (i + 1) + ": " + e.message); }
  });
  if (remotes.length && own.gsc.length + own.ga.length === 0) out.errs = out.errs.filter(function (e) { return e.indexOf(own.account) !== 0; });
  out.account = out.accounts.filter(function (a) { return a.gsc + a.ga > 0; }).map(function (a) { return a.email; }).join(", ") || out.account;
  cacheBig("gd:props", out, 21600);
  return out;
}
// What THIS script's own Google account can see.
function gdataPropsOwn() {
  const out = { ok: true, gsc: [], ga: [], errs: [], account: Session.getEffectiveUser().getEmail() };
  try { const j = gfetch("https://www.googleapis.com/webmasters/v3/sites"); out.gsc = (j.siteEntry || []).filter(function (x) { return x && x.siteUrl && x.permissionLevel !== "siteUnverifiedUser"; }).map(function (x) { return x.siteUrl; }); }
  catch (e) { out.errs.push("Search Console: " + e.message); }
  try {
    let page = "", n = 0;
    do {
      const j = gfetch("https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
      (j.accountSummaries || []).forEach(function (a) { (a.propertySummaries || []).forEach(function (p) { out.ga.push({ id: String(p.property || "").replace("properties/", ""), name: String(p.displayName || ""), account: String(a.displayName || ""), uris: [] }); }); });
      page = j.nextPageToken || "";
    } while (page && ++n < 5);
    const list = out.ga.slice(0, 200), tok = ScriptApp.getOAuthToken();
    if (list.length) {
      const res = UrlFetchApp.fetchAll(list.map(function (p) { return { url: "https://analyticsadmin.googleapis.com/v1beta/properties/" + p.id + "/dataStreams?pageSize=20", headers: { Authorization: "Bearer " + tok }, muteHttpExceptions: true }; }));
      res.forEach(function (r, i) { try { if (r.getResponseCode() < 300) list[i].uris = (JSON.parse(r.getContentText()).dataStreams || []).map(function (d) { return d.webStreamData && d.webStreamData.defaultUri; }).filter(Boolean); } catch (e) {} });
    }
  } catch (e) { out.errs.push("Analytics: " + e.message); }
  return out;
}
function gdYmd(d) { return Utilities.formatDate(d, "UTC", "yyyy-MM-dd"); }
function gdAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; }
function gdPeriods(lag) { return { cur: [gdYmd(gdAgo(lag + 27)), gdYmd(gdAgo(lag))], prev: [gdYmd(gdAgo(lag + 55)), gdYmd(gdAgo(lag + 28))] }; }
function gdSum(rows, k) { return rows.reduce(function (a, r) { return a + (Number(r[k]) || 0); }, 0); }
function gdGsc(site) {
  const p = gdPeriods(3), base = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(site) + "/searchAnalytics/query";
  const daily = gfetch(base, { startDate: p.prev[0], endDate: p.cur[1], dimensions: ["date"], rowLimit: 100 });
  const rows = (daily.rows || []).map(function (r) { return { d: r.keys[0], clicks: r.clicks, imp: r.impressions, pos: r.position }; });
  const inCur = rows.filter(function (r) { return r.d >= p.cur[0]; }), inPrev = rows.filter(function (r) { return r.d < p.cur[0]; });
  const agg = function (rs) { const imp = gdSum(rs, "imp"), clicks = gdSum(rs, "clicks"); return { clicks: clicks, imp: imp, ctr: imp ? clicks / imp : 0, pos: imp ? rs.reduce(function (a, r) { return a + r.pos * r.imp; }, 0) / imp : null }; };
  const q = gfetch(base, { startDate: p.cur[0], endDate: p.cur[1], dimensions: ["query"], rowLimit: 10 });
  const pg = gfetch(base, { startDate: p.cur[0], endDate: p.cur[1], dimensions: ["page"], rowLimit: 5 });
  return { range: p, cur: agg(inCur), prev: agg(inPrev),
    daily: inCur.map(function (r) { return { d: r.d, v: r.clicks, imp: r.imp, pos: r.pos }; }), prevDaily: inPrev.map(function (r) { return { d: r.d, v: r.clicks, imp: r.imp }; }),
    queries: (q.rows || []).map(function (r) { return { q: r.keys[0], clicks: r.clicks, imp: r.impressions, pos: r.position }; }),
    pages: (pg.rows || []).map(function (r) { return { p: r.keys[0], clicks: r.clicks, imp: r.impressions }; }) };
}
function gdGa(id) {
  const p = gdPeriods(1), url = "https://analyticsdata.googleapis.com/v1beta/properties/" + encodeURIComponent(id) + ":runReport";
  const day = function (v) { return v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6); };
  const j = gfetch(url, { dateRanges: [{ startDate: p.prev[0], endDate: p.cur[1] }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }, { name: "totalUsers" }, { name: "engagedSessions" }, { name: "keyEvents" }], limit: 100 });
  const rows = (j.rows || []).map(function (r) { return { d: day(r.dimensionValues[0].value), s: +r.metricValues[0].value, u: +r.metricValues[1].value, e: +r.metricValues[2].value, k: +r.metricValues[3].value }; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
  const o = gfetch(url, { dateRanges: [{ startDate: p.prev[0], endDate: p.cur[1] }], dimensions: [{ name: "date" }], metrics: [{ name: "sessions" }], limit: 100, dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } } });
  const org = {}; (o.rows || []).forEach(function (r) { org[day(r.dimensionValues[0].value)] = +r.metricValues[0].value; });
  rows.forEach(function (r) { r.o = org[r.d] || 0; });
  const inCur = rows.filter(function (r) { return r.d >= p.cur[0]; }), inPrev = rows.filter(function (r) { return r.d < p.cur[0]; });
  const agg = function (rs) { const s = gdSum(rs, "s"); return { sessions: s, users: gdSum(rs, "u"), organic: gdSum(rs, "o"), engaged: s ? gdSum(rs, "e") / s : 0, keyEvents: gdSum(rs, "k") }; };
  return { range: p, cur: agg(inCur), prev: agg(inPrev), daily: inCur.map(function (r) { return { d: r.d, v: r.s, o: r.o, u: r.u }; }), prevDaily: inPrev.map(function (r) { return { d: r.d, v: r.s, o: r.o }; }) };
}
// One report for the properties the extension picked (q.gsc: a Search Console site, q.ga:
// a GA4 property id) - each read here or by the data hub that can see it.
function gdataReportHub(q, meRow, owner) {
  if (!gdataAllowed(meRow, owner)) return { ok: false, error: "not allowed" };
  const gsc = String(q.gsc || "").slice(0, 300), ga = String(q.ga || "").replace(/\D/g, "").slice(0, 20);
  const ck = "gd:r:" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, gsc + "|" + ga));
  if (!q.force) { const hit = cacheBigGet(ck); if (hit) return hit; }
  const out = { ok: true, at: now(), gsc: null, ga: null, errs: [] };
  const remotes = gdataRemotes(), p = remotes.length ? (cacheBigGet("gd:props") || gdataPropsHub({ force: false }, meRow, true)) : null;
  const hubOf = function (kind) {
    if (!p) return -1;
    if (kind === "gsc") return gsc in (p.gscHub || {}) ? p.gscHub[gsc] : -1;
    const x = (p.ga || []).find(function (y) { return y.id === ga; }); return x ? x.hub : -1;
  };
  const hg = gsc ? hubOf("gsc") : -1, ha = ga ? hubOf("ga") : -1;
  if (gsc && hg >= 0 && remotes[hg]) { try { out.gsc = gdataAsk(remotes[hg], { action: "gdataReport", gsc: gsc, force: !!q.force }).gsc; } catch (e) { out.errs.push("Search Console: " + e.message); } }
  else if (gsc) { try { out.gsc = gdGsc(gsc); } catch (e) { out.errs.push("Search Console: " + e.message); } }
  if (ga && ha >= 0 && remotes[ha]) { try { out.ga = gdataAsk(remotes[ha], { action: "gdataReport", ga: ga, force: !!q.force }).ga; } catch (e) { out.errs.push("Analytics: " + e.message); } }
  else if (ga) { try { out.ga = gdGa(ga); } catch (e) { out.errs.push("Analytics: " + e.message); } }
  cacheBig(ck, out, 21600);
  return out;
}
// ---- Monthly numbers for Client Wins (site-detail.js clientWins): whole calendar months
// from q.from ("YYYY-MM") up to this month (this month = month to date, not final). Per
// month: Search Console clicks / impressions / impression-weighted position, and GA4
// generate_lead by session source / medium (organic + all), organic sessions + page
// views, key events and all sessions (a month with no sessions = no GA data, never 0).
function gdMonthRange(from) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(from || ""));
  const s = m ? new Date(Date.UTC(+m[1], +m[2] - 1, 1)) : gdAgo(480);
  return { start: Utilities.formatDate(s, "UTC", "yyyy-MM-dd"), end: gdYmd(new Date()) };
}
function gdGscMonthly(site, from) {
  const r = gdMonthRange(from), out = {};
  const j = gfetch("https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(site) + "/searchAnalytics/query", { startDate: r.start, endDate: r.end, dimensions: ["date"], rowLimit: 25000 });
  (j.rows || []).forEach(function (x) {
    const k = String(x.keys[0]).slice(0, 7), o = out[k] || (out[k] = { clicks: 0, imp: 0, posw: 0, days: 0 });
    o.clicks += x.clicks || 0; o.imp += x.impressions || 0; o.posw += (x.position || 0) * (x.impressions || 0); o.days++;
  });
  return out;
}
function gdGaMonthly(id, from) {
  const r = gdMonthRange(from), url = "https://analyticsdata.googleapis.com/v1beta/properties/" + encodeURIComponent(id) + ":runReport";
  const ym = function (v) { return String(v).slice(0, 4) + "-" + String(v).slice(4, 6); }, out = {};
  const get = function (k) { return out[k] || (out[k] = { leadsOrg: 0, leadsAll: 0, orgSessions: 0, orgViews: 0, keyEvents: 0, sessions: 0 }); };
  const range = [{ startDate: r.start, endDate: r.end }];
  const all = gfetch(url, { dateRanges: range, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "keyEvents" }], limit: 100 });
  (all.rows || []).forEach(function (x) { const o = get(ym(x.dimensionValues[0].value)); o.sessions += +x.metricValues[0].value; o.keyEvents += +x.metricValues[1].value; });
  const org = gfetch(url, { dateRanges: range, dimensions: [{ name: "yearMonth" }], metrics: [{ name: "sessions" }, { name: "screenPageViews" }], limit: 100,
    dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup", stringFilter: { value: "Organic Search" } } } });
  (org.rows || []).forEach(function (x) { const o = get(ym(x.dimensionValues[0].value)); o.orgSessions += +x.metricValues[0].value; o.orgViews += +x.metricValues[1].value; });
  const leads = gfetch(url, { dateRanges: range, dimensions: [{ name: "yearMonth" }, { name: "sessionSourceMedium" }], metrics: [{ name: "eventCount" }], limit: 10000,
    dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { value: "generate_lead", matchType: "EXACT" } } } });
  (leads.rows || []).forEach(function (x) {
    const o = get(ym(x.dimensionValues[0].value)), sm = String(x.dimensionValues[1].value || "").trim().toLowerCase(), n = +x.metricValues[0].value;
    if (/^tagassistant\.google\.com\s*\/\s*referral$/.test(sm)) return;
    o.leadsAll += n;
    if (/\/\s*organic$/.test(sm)) { o.leadsOrg += n; o.srcOrg = o.srcOrg || {}; o.srcOrg[sm] = (o.srcOrg[sm] || 0) + n; }
  });
  return out;
}
function gdataMonthlyHub(q, meRow, owner) {
  if (!gdataAllowed(meRow, owner)) return { ok: false, error: "not allowed" };
  const gsc = String(q.gsc || "").slice(0, 300), ga = String(q.ga || "").replace(/\D/g, "").slice(0, 20), from = String(q.from || "").slice(0, 7);
  const ck = "gd:m:" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, gsc + "|" + ga + "|" + from));
  if (!q.force) { const hit = cacheBigGet(ck); if (hit) return hit; }
  const out = { ok: true, at: now(), from: from, today: gdYmd(new Date()), gsc: null, ga: null, errs: [] };
  const remotes = gdataRemotes(), p = remotes.length ? (cacheBigGet("gd:props") || gdataPropsHub({ force: false }, meRow, true)) : null;
  const hubOf = function (kind) {
    if (!p) return -1;
    if (kind === "gsc") return gsc in (p.gscHub || {}) ? p.gscHub[gsc] : -1;
    const x = (p.ga || []).find(function (y) { return y.id === ga; }); return x ? x.hub : -1;
  };
  const hg = gsc ? hubOf("gsc") : -1, ha = ga ? hubOf("ga") : -1;
  if (gsc && hg >= 0 && remotes[hg]) { try { out.gsc = gdataAsk(remotes[hg], { action: "gdataMonthly", gsc: gsc, from: from, force: !!q.force }).gsc; } catch (e) { out.errs.push("Search Console: " + e.message); } }
  else if (gsc) { try { out.gsc = gdGscMonthly(gsc, from); } catch (e) { out.errs.push("Search Console: " + e.message); } }
  if (ga && ha >= 0 && remotes[ha]) { try { out.ga = gdataAsk(remotes[ha], { action: "gdataMonthly", ga: ga, from: from, force: !!q.force }).ga; } catch (e) { out.errs.push("Analytics: " + e.message); } }
  else if (ga) { try { out.ga = gdGaMonthly(ga, from); } catch (e) { out.errs.push("Analytics: " + e.message); } }
  cacheBig(ck, out, 21600);
  return out;
}
// Admin › Team hub › Google data hubs: add { url, key }, remove an index, or just list (keys never sent back).
function gdataHubs(q) {
  let list = gdataRemotes();
  if (q.add) {
    const url = String(q.add.url || "").trim(), key = String(q.add.key || "").trim();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) return { ok: false, error: "That isn't a web app link (https://script.google.com/macros/s/…/exec)." };
    if (!/^[A-Za-z0-9]{24,64}$/.test(key)) return { ok: false, error: "Missing the data hub's key - copy the data hub script again." };
    try { const t = gdataAsk({ url: url, key: key }, { action: "gdataProps", force: true }); list = list.filter(function (h) { return h.url !== url; }); list.push({ url: url, key: key, account: String(t.account || "") }); }
    catch (e) { return { ok: false, error: "The data hub didn't answer: " + e.message }; }
  }
  if (q.remove != null) list = list.filter(function (h, i) { return i !== Number(q.remove); });
  if (q.add || q.remove != null) { props().setProperty("GDATA_HUBS", JSON.stringify(list)); CacheService.getScriptCache().remove("gd:props"); }
  return { ok: true, hubs: list.map(function (h, i) { return { i: i, account: h.account || "", url: h.url.replace(/\/s\/(.{6}).*(.{4})\/exec$/, "/s/$1…$2/exec") }; }) };
}
// ---------- Client report recipes (Site monitor › 📄 Export report) ----------
// Each client's fixed report recipe (format, title, Chrome profile, GA property, note,
// delivered history) lives HERE, never in the extension's public code. Admins save the
// list (Admin › Team hub › Report recipes); everyone's extension reads it. Delivered totals
// (what each month's client report printed) are recorded after every export, so next
// month's "rose from N" always matches what the client was sent. Script Properties keep 9
// KB a value, so both are stored in chunks.
function bigPropGet(name) {
  const p = props(), n = Number(p.getProperty(name + "_n") || 0);
  let s = ""; for (let i = 0; i < n; i++) s += p.getProperty(name + "_" + i) || "";
  return s;
}
function bigPropSet(name, s) {
  const p = props(), old = Number(p.getProperty(name + "_n") || 0), parts = [];
  for (let i = 0; i < s.length; i += 8000) parts.push(s.slice(i, i + 8000));
  const m = {}; parts.forEach(function (x, i) { m[name + "_" + i] = x; }); m[name + "_n"] = String(parts.length);
  p.setProperties(m);
  for (let i = parts.length; i < old; i++) p.deleteProperty(name + "_" + i);
}
function recipesGet(q, meRow, owner) {
  if (!gdataAllowed(meRow, owner)) return { ok: false, error: "not allowed" };
  return { ok: true, recipes: js(bigPropGet("REPORT_RECIPES"), []), delivered: js(bigPropGet("REPORT_DELIVERED"), {}) };
}
function recipesSave(q) {
  let list;
  try { list = JSON.parse(String(q.json || "")); } catch (e) { return { ok: false, error: "That isn't valid JSON: " + e.message }; }
  if (!Array.isArray(list)) return { ok: false, error: "Recipes must be a list [ … ]." };
  for (let i = 0; i < list.length; i++) { const r = list[i]; if (!r || !r.key || !r.name || !r.format) return { ok: false, error: "Recipe " + (i + 1) + " needs key, name and format." }; }
  const s = JSON.stringify(list);
  if (s.length > 200000) return { ok: false, error: "Too big (over 200 KB)." };
  bigPropSet("REPORT_RECIPES", s);
  return { ok: true, count: list.length };
}
// After an export: { key, ym, total } -> REPORT_DELIVERED[key][ym] = total (the client file's printed total).
function deliveredSave(q, meRow, owner) {
  if (!gdataAllowed(meRow, owner)) return { ok: false, error: "not allowed" };
  const key = String(q.key || "").slice(0, 60), ym = String(q.ym || ""), total = Number(q.total);
  if (!key || !/^\d{4}-\d{2}$/.test(ym) || !isFinite(total) || total < 0) return { ok: false, error: "bad delivered total" };
  const d = js(bigPropGet("REPORT_DELIVERED"), {});
  d[key] = d[key] || {}; d[key][ym] = { total: total, at: now(), by: String((meRow && meRow.name) || (owner ? "owner" : "")).slice(0, 60) };
  bigPropSet("REPORT_DELIVERED", JSON.stringify(d));
  return { ok: true };
}
function probe(q, meRow, owner) {
  if (!owner && !(meRow && userState(meRow) === "ok")) return { ok: false, error: "not allowed" };
  const url = String(q.url || "");
  if (url.length > 300 || !/^https?:\/\/[a-z0-9.-]+(?::\d+)?(?:[\/?#]|$)/i.test(url)) return { ok: false, error: "bad url" };
  const host = url.replace(/^https?:\/\//i, "").split(/[\/:?#]/)[0].toLowerCase();
  if (!/\.[a-z]{2,}$/.test(host) || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)|\.(?:local|internal|lan)$/.test(host)) return { ok: false, error: "bad url" };
  const cache = CacheService.getScriptCache(), ck = "probe:" + url.slice(0, 200);
  const hit = cache.get(ck);
  if (hit) return JSON.parse(hit);
  const t0 = Date.now();
  let r;
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true, headers: { "User-Agent": "Mozilla/5.0 (compatible; PCM site check)" } });
    const st = res.getResponseCode();
    r = { ok: true, status: st, up: st >= 200 && st < 400, ms: Date.now() - t0 };
  } catch (e) {
    r = { ok: true, status: 0, up: false, error: String((e && e.message) || e).slice(0, 120), ms: Date.now() - t0 };
  }
  cache.put(ck, JSON.stringify(r), 300);
  return r;
}

// ---------- users ----------
function findUser(install) { return readAll("Users").find((u) => String(u.install) === install) || null; }
function userState(u) {
  if (!u) return "ok";
  if (u.status === "banned") return "banned";
  if (Number(u.mutedUntil) > now()) return "muted";
  return "ok";
}
// A check-in rewrites the person's row only when something in it changed or
// 10 minutes passed (lastSeen), so the calls every few minutes cost no write.
function helloFields(q, u) {
  return {
    cuUserId: String(q.cuUserId || (u && u.cuUserId) || "").slice(0, 30),
    name: String(q.name || (u && u.name) || "").slice(0, 80),
    avatar: /^https:\/\//.test(String(q.avatar || "")) ? String(q.avatar).slice(0, 500) : String((u && u.avatar) || ""),
    version: String(q.version || (u && u.version) || "").slice(0, 20),
    perf: typeof q.perf === "string" && q.perf.length <= 900 ? q.perf : String((u && u.perf) || ""),
  };
}
function helloNeedsWrite(q, u) {
  if (!u) return true;
  if (now() - (Number(u.lastSeen) || 0) > 10 * 60000) return true;
  const f = helloFields(q, u);
  return Object.keys(f).some((k) => String(u[k] == null ? "" : u[k]) !== f[k]);
}
function helloReply(q, u) {
  const install = cleanInstall(q);
  return { ok: true, state: userState(u), mutedUntil: Number(u && u.mutedUntil) || 0, settings: pub(), role: install === setting("OWNER_INSTALL", "") ? "owner" : (u && u.role === "admin" ? "admin" : "user") };
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
  if (typeof q.perf === "string" && q.perf.length <= 900) u.perf = q.perf; // scores + counts, shown to admins
  u.lastSeen = t;
  writeRow("Users", u);
  return { ok: true, state: userState(u), mutedUntil: Number(u.mutedUntil) || 0, settings: pub(), role: install === setting("OWNER_INSTALL", "") ? "owner" : (u.role === "admin" ? "admin" : "user") };
}
function users() {
  const t = now();
  let pr = {};
  try { pr = props().getProperties() || {}; } catch (e) {} // presence is an extra: the list works without it
  const pres = (u) => js(pr["pres_" + String(u.install)] || "", null) || {};
  const list = readAll("Users").map((u) => ({
    onAt: Number(pres(u).on) || 0, actAt: Number(pres(u).act) || 0, day: pres(u).day || null,
    install: String(u.install), cuUserId: String(u.cuUserId), name: String(u.name), avatar: String(u.avatar), color: String(u.color), initials: String(u.initials),
    version: String(u.version), firstSeen: Number(u.firstSeen) || 0, lastSeen: Number(u.lastSeen) || 0, state: userState(u), mutedUntil: Number(u.mutedUntil) || 0,
    role: String(u.install) === setting("OWNER_INSTALL", "") ? "owner" : (u.role === "admin" ? "admin" : "user"),
    perf: js(String(u.perf || ""), null),
  })).sort((a, b) => b.lastSeen - a.lastSeen);
  const day = 86400000;
  return { ok: true, presence: true, users: list, total: list.length, activeToday: list.filter((u) => t - u.lastSeen < day).length, activeWeek: list.filter((u) => t - u.lastSeen < 7 * day).length, settings: pub() };
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
  // The person acted on. "install" is always the CALLER's own id (the extension
  // adds it to every call), so the target travels as "target".
  const target = String(q.target || "").replace(/[^a-z0-9]/gi, "").slice(0, 40);
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
  // Roles: the owner only. The owner's own row can't be changed.
  const ownerInstall = setting("OWNER_INSTALL", "");
  if (op === "role") {
    if (!q._owner) return { ok: false, error: "Only the hub's owner can make someone an admin." };
    if (target === ownerInstall) return { ok: false, error: "That's you - the owner stays an admin." };
    const u = findUser(target);
    if (!u) return { ok: false, error: "user not found" };
    u.role = q.role === "admin" ? "admin" : "";
    writeRow("Users", u);
    return { ok: true };
  }
  if (["forget", "mute", "unmute", "ban", "unban"].indexOf(op) >= 0 && !q._owner) {
    const t = findUser(target);
    if (target === ownerInstall || (t && t.role === "admin")) return { ok: false, error: "Only the owner can do that to an admin." };
  }
  if (op === "forget") {
    const u = findUser(target);
    if (!u) return { ok: true, gone: true }; // already off the list: nothing to do
    deleteRow("Users", u);
    return { ok: true };
  }
  if (["mute", "unmute", "ban", "unban"].indexOf(op) >= 0) {
    const u = findUser(target);
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
// Is there anything for this install's user to collect? (read only, no lock)
function nudgesWaiting(q) {
  const install = cleanInstall(q);
  const u = install ? findUser(install) : null;
  if (!u || !u.cuUserId) return false;
  const t = now();
  return readAll("Nudges").some((n) => String(n.toUser) === String(u.cuUserId) && !n.deliveredAt && t - Number(n.at) < 7 * 86400000);
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

// ---------- client notices ----------
// cnotePost { notes: JSON [{ id, client, ... }] }: added once per Slack message (id);
// a later copy with the AI's reading (ai = when it was read) replaces the fields.
function cnotePost(q) {
  const install = cleanInstall(q);
  const u = install ? findUser(install) : null;
  if (!u || userState(u) !== "ok") return { ok: false, error: "not allowed" };
  const list = js(String(q.notes || ""), []);
  if (!Array.isArray(list)) return { ok: false, error: "bad notes" };
  const rows = readAll("ClientNotes");
  const str = (v, n) => { const s = String(v == null ? "" : v).slice(0, n); return /^[=+\-@]/.test(s) ? "'" + s : s; };
  let added = 0;
  for (const n of list.slice(0, 10)) {
    const id = str(n && n.id, 60).replace(/[^A-Za-z0-9-]/g, "");
    if (!id || !n.client) continue;
    const row = rows.find((r) => String(r.id) === id);
    const ai = Number(n.ai) || 0;
    if (row && !(ai && ai > (Number(row.ai) || 0))) continue;
    const o = row || { id, byInstall: install, byName: str(u.name, 80), addedAt: now() };
    Object.assign(o, { client: str(n.client, 120), channel: str(n.channel, 20), at: Number(n.at) || 0, text: str(n.text, 1500),
      permalink: /^https:\/\/[a-z0-9.-]+\.slack\.com\//.test(String(n.permalink || "")) ? str(n.permalink, 300) : "",
      fromMs: Number(n.fromMs) || 0, untilMs: Number(n.untilMs) || 0, kind: str(n.kind, 40), summary: str(n.summary, 300),
      important: n.important === "0" || n.important === "1" ? n.important : "", onsite: str(n.onsite, 900), ai });
    writeRow("ClientNotes", o);
    if (!row) { rows.push(o); added++; }
  }
  return { ok: true, added };
}
// cnotes: the last 45 days' notices (newest first, at most 60).
function cnotes(q) {
  const install = cleanInstall(q);
  const u = install ? findUser(install) : null;
  if (!u || userState(u) !== "ok") return { ok: false, error: "not allowed" };
  const t = now();
  const list = readAll("ClientNotes").filter((r) => t - (Number(r.at) || 0) < CNOTES_KEEP_MS || Number(r.untilMs || r.fromMs) > t)
    .sort((a, b) => Number(b.at) - Number(a.at)).slice(0, 60)
    .map((r) => ({ id: String(r.id), client: String(r.client), channel: String(r.channel), at: Number(r.at) || 0, text: String(r.text), permalink: String(r.permalink),
      fromMs: Number(r.fromMs) || 0, untilMs: Number(r.untilMs) || 0, kind: String(r.kind), summary: String(r.summary), important: String(r.important), onsite: String(r.onsite), ai: Number(r.ai) || 0, byName: String(r.byName) }));
  return { ok: true, notes: list };
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
