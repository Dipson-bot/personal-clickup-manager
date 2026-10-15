// ClickUp Tracker - desktop companion to the Personal ClickUp Manager extension.
// One small always-on-top window that stays exactly where you put it, with real
// transparency, plus a tray icon. All ClickUp calls happen here in the main
// process; the window only gets the data it shows (never the token).
"use strict";

const { app, BrowserWindow, Tray, Menu, ipcMain, screen, safeStorage, nativeImage, shell, nativeTheme, dialog } = require("electron");
const path = require("path");
const http = require("http");
const fs = require("fs");
const { ClickUp } = require("./clickup");
const clientdirs = require("./clientdirs");
const extupdate = require("./extupdate");

if (!app.requestSingleInstanceLock()) { app.quit(); }

// "slim" = the one-line strip (same as on the taskbar), used off the taskbar and on Mac.
const SIZES = { normal: [340, 124], compact: [300, 92], slim: [300, 46] };
const STYLES = ["B", "L", "F", "H", "J"];
const BIG = [460, 640];
const SETUP = [400, 300];
const REPO = "Dipson-bot/personal-clickup-manager";

// ---------- settings (userData/settings.json) ----------
const settingsFile = () => path.join(app.getPath("userData"), "settings.json");
let settings = { size: "slim", stripStyle: "B", stripAnim: true, opacity: 0.92, targetHours: 7, bounds: null, teamId: null, tokenEnc: null, commentsSeen: {} };
function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    // Up to 0.2.0 "Normal" was the default and got saved with everything else:
    // move those copies to the new default (the slim strip) once.
    if (saved && saved.stripStyle === undefined && saved.size === "normal") {
      saved.size = "slim";
      const b = saved.bounds; // keep its bottom-right corner where it was
      if (b && b.width && b.height) saved.bounds = { x: b.x + b.width - SIZES.slim[0], y: b.y + b.height - SIZES.slim[1], width: SIZES.slim[0], height: SIZES.slim[1] };
    }
    settings = { ...settings, ...saved };
  } catch (e) {}
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (e) {} }, 300);
}
// The ClickUp token is encrypted by the operating system (DPAPI on Windows,
// Keychain on macOS, the keyring on Linux).
function getToken() {
  if (!settings.tokenEnc) return null;
  try { return safeStorage.decryptString(Buffer.from(settings.tokenEnc, "base64")); } catch (e) { return null; }
}
function setToken(t) {
  settings.tokenEnc = t ? safeStorage.encryptString(t).toString("base64") : null;
  saveSettings();
}

// ---------- window ----------
let win = null, tray = null, cu = null;
let expanded = false, beforeBig = null;
function smallSize() { return SIZES[settings.size] || SIZES.normal; }

// ---------- on the taskbar (Windows) ----------
// The taskbar is the part of the screen outside the work area. A strip the
// height of the taskbar sits inside it (left/right slidable, remembered) and is
// kept above it: the taskbar is "always on top" too, so whenever Windows puts
// it back in front the strip is put back above it a moment later. A taskbar on
// the left/right edge (too narrow) or set to auto-hide has no band to sit in -
// then it's the normal floating window.
const STRIP_W = 300;
function taskbarOf(display) {
  const b = display.bounds, wa = display.workArea;
  if (wa.y + wa.height < b.y + b.height) return { x: b.x, y: wa.y + wa.height, width: b.width, height: b.y + b.height - (wa.y + wa.height) };
  if (wa.y > b.y) return { x: b.x, y: b.y, width: b.width, height: wa.y - b.y };
  return null;
}
const canDock = () => process.platform === "win32" && !!taskbarOf(screen.getPrimaryDisplay());
const docked = () => !!cu && settings.dock !== false && canDock();
function dockBounds() {
  const tb = taskbarOf(screen.getPrimaryDisplay());
  const h = Math.max(26, Math.min(48, tb.height - 6)), w = STRIP_W;
  const off = settings.dockX != null ? Number(settings.dockX) : 170; // clear of Windows' own Widgets corner
  const x = Math.round(Math.max(tb.x, Math.min(tb.x + tb.width - w, tb.x + off)));
  return { x, y: tb.y + Math.round((tb.height - h) / 2), width: w, height: h };
}
// ---------- the hover card's room ----------
// Growing the window when the pointer came onto the strip (and shrinking it when
// it left) flickered on Windows: a see-through window that moves and resizes at
// once paints a frame or two of the old picture. Now the strip's window keeps
// the card's room above it (below it at the top of the screen) all the time:
// that part is see-through and lets every click through to what's underneath,
// and hovering only shows or hides the card inside. Nothing moves, so nothing
// can flicker. Only the strip (on the taskbar, or the Slim size); the other sizes
// and the bigger view are ordinary windows.
const CARD_ROOM = 264; // the tallest hover card (peekH) + the gap
let room = null; // { dir: "up" | "down", h } while the window holds the card's room
let cardH = 0, solid = null;
const stripTall = () => !!cu && !expanded && (docked() || settings.size === "slim");
// The strip's own place, from the window's.
function baseOf(full) {
  if (!room) return full;
  return { x: full.x, y: room.dir === "up" ? full.y + room.h : full.y, width: full.width, height: full.height - room.h };
}
function withRoom(base) {
  const disp = screen.getDisplayMatching(base);
  const dir = base.y - CARD_ROOM >= disp.bounds.y ? "up" : "down";
  room = { dir, h: CARD_ROOM };
  return { x: base.x, y: dir === "up" ? base.y - CARD_ROOM : base.y, width: base.width, height: base.height + CARD_ROOM };
}
// Put the window at a strip place: with the card's room when it's the strip.
function placeStrip(base) {
  if (!win || win.isDestroyed()) return;
  if (stripTall()) {
    const want = withRoom(base), cur = win.getBounds();
    if (cur.x !== want.x || cur.y !== want.y || cur.width !== want.width || cur.height !== want.height) win.setBounds(want);
    setSolid(false);
  } else {
    room = null;
    const cur = win.getBounds();
    if (cur.x !== base.x || cur.y !== base.y || cur.width !== base.width || cur.height !== base.height) win.setBounds(base);
    setSolid(true);
  }
}
// Clicks: caught only where something is drawn (the strip, the open card).
function setSolid(on) {
  if (!win || win.isDestroyed() || solid === on) return;
  solid = on;
  if (on) win.setIgnoreMouseEvents(false);
  else win.setIgnoreMouseEvents(true, { forward: true });
}
function keepOnTop() {
  if (!win || win.isDestroyed() || !win.isVisible() || !docked()) return;
  win.setAlwaysOnTop(true, "screen-saver");
  win.moveTop();
}
function setDock(on) {
  settings.dock = !!on; saveSettings();
  expanded = false; beforeBig = null;
  recreate();
  send("settings", publicSettings());
}

// A Mac has no taskbar: the time lives in the menu bar, and the floating strip
// (which on Windows sits on the taskbar) would just hang at the bottom of the
// screen. So on a Mac the strip is off unless chosen in the menu-bar menu.
const isMac = process.platform === "darwin";
function stripWanted() { return !settings.hiddenByExt && (!isMac || settings.macStrip === true); }
function createWindow() {
  const [w, h] = cu ? smallSize() : SETUP;
  const wa = screen.getPrimaryDisplay().workArea;
  const dock = docked();
  const b0 = dock ? dockBounds() : settings.bounds && cu ? settings.bounds : { x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16, width: w, height: h };
  room = null; solid = null; cardH = 0;
  const b = stripTall() ? withRoom({ ...b0, width: dock ? b0.width : w, height: dock ? b0.height : h }) : b0;
  win = new BrowserWindow({
    x: b.x, y: b.y, width: room ? b.width : dock ? b.width : cu ? w : SETUP[0], height: room ? b.height : dock ? b.height : cu ? h : SETUP[1],
    frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
    // On the taskbar the strip is only ~42 px tall: without a thick frame Windows
    // does not hold it to its minimum window height (which made it 64 px).
    thickFrame: !dock, minHeight: dock ? 20 : undefined,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: !room, // a shadow on a see-through window flashes when it changes
    title: "ClickUp Tracker", backgroundColor: "#00000000",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setAlwaysOnTop(true, dock ? "screen-saver" : "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setOpacity(dock ? 1 : Number(settings.opacity) || 1);
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => { if (stripWanted()) win.showInactive(); });
  setSolid(!room);
  // Remember where it is (only the small window's place).
  const remember = () => {
    if (!win || expanded || !cu || peekBase) return; // not while the hover card has it grown
    if (docked()) {
      // Slide along the taskbar only: keep the new left/right place, snap back into the band.
      const tb = taskbarOf(screen.getPrimaryDisplay()), nb = baseOf(win.getBounds());
      settings.dockX = nb.x - tb.x; saveSettings();
      placeStrip(dockBounds());
      return;
    }
    settings.bounds = baseOf(win.getBounds()); saveSettings();
  };
  win.on("moved", remember);
  if (process.env.PCM_DEMO) { const log = (w) => console.log("[demo] " + w + " " + JSON.stringify(win && win.getBounds())); win.on("move", () => log("move")); win.on("resize", () => log("resize")); log("created dock=" + dock); }
  win.on("blur", () => setTimeout(keepOnTop, 150));
  win.on("resized", remember);
  win.on("closed", () => { win = null; });
}
// Bigger view: grows away from the screen edges, then goes back to exactly the
// same place and size.
function setExpanded(on) {
  if (process.env.PCM_DEMO) console.log("[demo] setExpanded " + on);
  if (!win || !cu || on === expanded) return;
  if (on) {
    beforeBig = baseOf(win.getBounds());
    room = null; setSolid(true);
    const wa = screen.getDisplayMatching(beforeBig).workArea;
    const w = Math.min(BIG[0], wa.width), h = Math.min(BIG[1], wa.height);
    const x = Math.max(wa.x, Math.min(beforeBig.x, wa.x + wa.width - w));
    const y = Math.max(wa.y, Math.min(beforeBig.y + beforeBig.height - h, wa.y + wa.height - h));
    expanded = true;
    win.setBounds({ x, y, width: w, height: h });
    win.setOpacity(1);
  } else {
    expanded = false;
    if (beforeBig) placeStrip(docked() ? dockBounds() : beforeBig);
    win.setOpacity(docked() ? 1 : Number(settings.opacity) || 1);
  }
}

// ---------- the time in the menu bar (Mac) / the tray tooltip ----------
const fmtD = (ms) => { const m = Math.round(Math.max(0, ms) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
function timeText() {
  const run = state && state.running, t = state && state.task;
  if (!run) return "";
  const tracked = (t ? (t.totalClosedMs != null ? t.totalClosedMs : t.closedMs) + (Number(t.othersMs) || 0) + (Number(t.subtasksMs) || 0) : 0) + Math.max(0, Date.now() - run.startMs), est = t ? t.estimateMs : 0;
  if (!est) return fmtD(tracked);
  return tracked - est >= 60000 ? "+" + fmtD(tracked - est) + " over" : fmtD(tracked) + " / " + fmtD(est);
}
function paintTrayText() {
  if (!tray) return;
  const tt = timeText(), today = state && state.today ? "Today " + fmtD(state.today.closedMs + (state.running ? Math.max(0, Date.now() - state.running.startMs) : 0)) + "/" + fmtD(state.today.targetMs) : "";
  tray.setToolTip("ClickUp Tracker" + (state && state.running ? " - " + (state.running.taskName || "") + " - " + tt : " - no timer running") + (today ? " · " + today : ""));
  // Mac menu bar: this task's time and today's, e.g. "25m / 1h · 3h 10m/7h".
  const todayShort = state && state.today ? fmtD(state.today.closedMs + (state.running ? Math.max(0, Date.now() - state.running.startMs) : 0)) + "/" + fmtD(state.today.targetMs) : "";
  if (process.platform === "darwin") tray.setTitle(settings.menubar !== false && !settings.hiddenByExt && tt ? " " + tt + (todayShort ? " · " + todayShort : "") : "");
}

// ---------- the actions menu (the strip's ▾, the tray) ----------
function actionItems() {
  const run = state && state.running, t = (state && state.task) || {};
  const short = (s) => { s = String(s || ""); return s.length > 60 ? s.slice(0, 58) + "…" : s; };
  const go = (a) => () => doAction(a);
  const items = [];
  if (run) {
    items.push({ label: short(run.taskName) + "  ·  " + timeText(), enabled: false });
    items.push({ label: "■ Stop", click: go({ type: "stop" }) });
    if (!t.isExtra) items.push({ label: "✓ Done", click: go({ type: "complete" }) });
    if (!t.isExtra && state.extra) items.push({ label: "⇄ Switch to the Extra Task (Meeting)", click: go({ type: "extra", note: "Meeting" }) }, { label: "⇄ Switch to the Extra Task", click: go({ type: "extra" }) });
    if (t.isExtra && state.last) items.push({ label: "↩ Back to " + short(state.last.name), click: go({ type: "resume" }) });
  } else {
    items.push({ label: "No timer running", enabled: false });
    for (const n of (state && state.nexts) || []) items.push({ label: "▶ " + short(n.name), click: go({ type: "start", taskId: n.id }) });
    if (state && state.extra) items.push({ label: "▶ Start the Extra Task", click: go({ type: "extra" }) });
    if (state && state.last) items.push({ label: "▶ Resume " + short(state.last.name), click: go({ type: "resume" }) });
  }
  return items;
}
function showStripMenu() {
  if (!win) return;
  const run = state && state.running, t = (state && state.task) || {};
  const menu = Menu.buildFromTemplate([
    ...actionItems(),
    { type: "separator" },
    ...(run ? [{ label: "⤢ Bigger view (note, comments, files)", click: () => send("big", true) }] : []),
    ...(run && t.url ? [{ label: "Open in ClickUp", click: () => shell.openExternal(t.url) }] : []),
    { label: "Refresh now", click: () => refresh() },
    { label: "Move off the taskbar (floating window)", click: () => setDock(false) },
  ]);
  menu.popup({ window: win });
}

// ---------- tray ----------
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, "icon.png"));
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}
function buildTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip("ClickUp Tracker");
    tray.on("click", toggleWindow);
  }
  const op = (v) => ({ label: Math.round(v * 100) + "%", type: "radio", checked: Math.abs((settings.opacity || 1) - v) < 0.01, click: () => setOpacity(v) });
  const login = app.getLoginItemSettings();
  tray.setContextMenu(Menu.buildFromTemplate([
    ...(cu ? [...actionItems(), { type: "separator" }] : []),
    isMac
      ? { label: "Also show the floating strip", type: "checkbox", checked: !!(win && win.isVisible()), toolTip: "The timer is in the menu bar; this adds the small floating window too", click: toggleWindow }
      : { label: win && win.isVisible() ? "Hide tracker" : "Show tracker", click: toggleWindow },
    ...(process.platform === "win32" ? [{ label: "On the taskbar", type: "checkbox", checked: settings.dock !== false, enabled: canDock(), toolTip: canDock() ? "" : "Needs the taskbar at the top or bottom of the screen, not auto-hidden", click: (m) => setDock(m.checked) }] : []),
    ...(process.platform === "darwin" ? [{ label: "Show the time in the menu bar", type: "checkbox", checked: settings.menubar !== false, click: (m) => { settings.menubar = m.checked; saveSettings(); paintTrayText(); } }] : []),
    { label: "Refresh now", click: () => refresh(true) },
    { type: "separator" },
    { label: "Size", submenu: [
      { label: "Slim strip", type: "radio", checked: settings.size === "slim", click: () => setSize("slim") },
      { label: "Normal", type: "radio", checked: settings.size === "normal" || !SIZES[settings.size], click: () => setSize("normal") },
      { label: "Compact", type: "radio", checked: settings.size === "compact", click: () => setSize("compact") },
    ] },
    { label: "See-through (when not pointed at)", submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5].map(op) },
    { label: "Daily target: " + (settings.targetHours || 7) + "h", submenu: [4, 5, 6, 7, 8, 9].map((hrs) => ({ label: hrs + " hours", type: "radio", checked: Number(settings.targetHours) === hrs, click: () => { settings.targetHours = hrs; saveSettings(); refresh(); buildTray(); } })) },
    { label: "Start with " + (process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "the computer"), type: "checkbox", checked: !!login.openAtLogin, click: (m) => { app.setLoginItemSettings({ openAtLogin: m.checked }); } },
    ...(updateInfo ? [{ type: "separator" }, { label: "Update available: v" + updateInfo.version + " (download)", click: () => shell.openExternal(updateInfo.url) }] : []),
    { type: "separator" },
    { label: "Change ClickUp token…", click: () => { setToken(null); cu = null; state = null; recreate(); } },
    { label: "Quit", click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function toggleWindow() {
  if (!win) { createWindow(); return; }
  if (win.isVisible()) win.hide(); else { win.showInactive(); }
  // Shown / hidden by hand: remembered (the extension's next change still applies).
  settings.hiddenByExt = !win.isVisible();
  if (isMac) settings.macStrip = win.isVisible();
  saveSettings();
  buildTray();
}
function setOpacity(v) { settings.opacity = v; saveSettings(); if (win && !expanded) win.setOpacity(v); buildTray(); }
function setSize(s) {
  settings.size = s; saveSettings();
  if (win && !expanded) {
    const b = baseOf(win.getBounds()); const [w, h] = smallSize();
    const nb = { x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h };
    placeStrip(nb);
    settings.bounds = nb; saveSettings();
  }
  send("settings", publicSettings());
  buildTray();
}
function recreate() { if (win) { win.destroy(); win = null; } createWindow(); buildTray(); }

// ---------- data ----------
let state = null;
let resumeTask = null; // the task switched away from for the Extra Task
let lastStopped = null;
function send(ch, v) { if (win && !win.isDestroyed()) win.webContents.send(ch, v); }
function publicSettings() { return { size: settings.size, opacity: settings.opacity, targetHours: settings.targetHours, dark: nativeTheme.shouldUseDarkColors, dock: docked(), slim: settings.size === "slim", style: STYLES.includes(settings.stripStyle) ? settings.stripStyle : "B", anim: settings.stripAnim !== false }; }
let refreshing = null;
async function refresh() {
  if (!cu) return null;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      if (!cu.teamId) { await cu.init(settings.teamId); settings.teamId = cu.teamId; saveSettings(); } // offline at start
      const [run, today, extra] = await Promise.all([cu.running(), cu.todayEntries(), cu.extraTask().catch(() => ({ id: null }))]);
      let task = null;
      if (run) task = await cu.task(run.taskId).catch(() => null);
      const totalMs = run ? await cu.trackedTotal(run.taskId, run.startMs).catch(() => null) : null;
      const nexts = run ? [] : await cu.dueToday().catch(() => []);
      state = {
        at: Date.now(),
        me: cu.userId,
        running: run ? { ...run, taskName: (task && task.name) || run.taskName } : null,
        task: run ? {
          id: run.taskId, estimateMs: (task && task.estimateMs) || 0, client: (task && task.client) || "", url: task && task.url,
          // closedMs = today's time on it before this timer; totalClosedMs = every day's.
          closedMs: today.byTask.get(run.taskId) || 0, totalClosedMs: totalMs,
          // Time someone else tracked on it (e.g. before it was handed to you): the
          // task's total for everyone minus your own entries. It counts against the
          // estimate; your Today total stays your own time.
          // (Should ClickUp ever put the subtasks' time in the parent's total, it is
          // taken out here so it isn't counted twice.)
          othersMs: (() => {
            if (!task || totalMs == null) return 0;
            const subs = Number(task.subtasksMs) || 0;
            const own = task.spentAllMs - (subs && task.spentAllMs >= totalMs + subs - 60000 ? subs : 0);
            return own - totalMs >= 60000 ? own - totalMs : 0;
          })(),
          // Its subtasks' time, when its estimate covers them (clickup.js task()).
          subtasksMs: (task && task.subtasksMs) || 0,
          dueDateMs: task && task.dueDateMs, startDateMs: task && task.startDateMs, status: task && task.status,
          isExtra: !!(extra.id && extra.id === run.taskId) || /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(run.taskName || ""),
        } : null,
        today: { closedMs: today.total, targetMs: (Number(settings.targetHours) || 7) * 3600000 },
        extra: extra.id ? { id: extra.id, name: extra.name } : null,
        last: resumeTask || lastStopped,
        nexts: nexts.slice(0, 3),
        error: null,
      };
    } catch (e) {
      state = { ...(state || {}), error: String(e && e.message ? e.message : e), at: Date.now() };
    }
    send("state", state);
    paintTrayText();
    buildTray();
    return state;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// New comments from someone else on the running task (every 3 minutes).
let commentsAt = 0, commentsFor = "";
async function checkComments(force) {
  if (!cu || !state || !state.running) return;
  const id = state.running.taskId;
  if (!force && commentsFor === id && Date.now() - commentsAt < 180000) return;
  commentsFor = id; commentsAt = Date.now();
  const cs = await cu.comments(id).catch(() => null);
  if (!cs) return;
  const latest = cs.reduce((m, c) => Math.max(m, c.at), 0);
  if (settings.commentsSeen[id] == null) { settings.commentsSeen[id] = latest || Date.now(); saveSettings(); }
  const seen = settings.commentsSeen[id];
  send("comments", { taskId: id, list: cs.slice(0, 8), seen, newCount: cs.filter((c) => c.at > seen && c.userId !== cu.userId).length });
}

// ---------- the extension link (127.0.0.1:47615, this computer only) ----------
// The Personal ClickUp Manager extension knocks here every minute: it says
// whether the timer should show (its Settings › Where the timer shows) and, while
// this app isn't signed in, hands over the ClickUp connection - so nobody has to
// paste a token. Only browser extensions are answered, and the token is never
// sent back out.
const LINK_PORT = 47615;
let extShow = null; // the extension's last "show it" (null = not heard from yet)
function startLink() {
  const srv = http.createServer((req, res) => {
    const origin = String(req.headers.origin || "");
    const fromExt = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    res.setHeader("Cache-Control", "no-store");
    if (fromExt) res.setHeader("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS" && fromExt) { res.writeHead(204, { "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type" }); res.end(); return; }
    // /pcm/files: client folders (briefs, task files) - bigger bodies, own answers.
    if (req.method === "POST" && req.url === "/pcm/files" && fromExt) {
      const chunks = []; let size = 0;
      req.on("data", (c) => { size += c.length; if (size > 80 * 1048576) req.destroy(); else chunks.push(c); });
      req.on("end", async () => {
        let out;
        try { out = await filesOp(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    // /pcm/update: install a new version of the extension into its own folder
    // (no browser permission or click needed) - see extupdate.js for the checks.
    if (req.method === "POST" && req.url === "/pcm/update" && fromExt) {
      let body = "";
      req.on("data", (c) => { body += c; if (body.length > 4000) req.destroy(); });
      req.on("end", async () => {
        let out;
        try { out = await extupdate.handle(origin, JSON.parse(body || "{}")); } catch (e) { out = { ok: false, error: String((e && e.message) || e) }; }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(out));
      });
      return;
    }
    if (req.method !== "POST" || req.url !== "/pcm" || !fromExt) { res.writeHead(404); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on("end", async () => {
      let m = {};
      try { m = JSON.parse(body); } catch (e) {}
      try { await fromExtension(m); } catch (e) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ app: "clickup-tracker", version: app.getVersion(), signedIn: !!cu, user: (cu && cu.username) || "", shown: isMac ? !settings.hiddenByExt : !!(win && !win.isDestroyed() && win.isVisible()), platform: process.platform, folders: true, folderFiles: true, extUpdate: true }));
    });
  });
  srv.on("error", () => {}); // port in use (another copy): no link, the app still works
  srv.listen(LINK_PORT, "127.0.0.1");
}
// ---------- client folders (the extension's Send to Claude Code / Show in folder) ----------
// Written here because a browser extension can only save into Downloads. The
// work happens in the background; only "Choose…" shows a folder picker.
const defaultClientsRoot = () => path.join(app.getPath("documents"), "Personal ClickUp Manager", "Clients");
const clientsRoot = () => settings.clientsRoot || defaultClientsRoot();
const clientLinks = () => (settings.clientLinks && typeof settings.clientLinks === "object" ? settings.clientLinks : {});
async function pickFolder(title, at) {
  // An invisible always-on-top owner so the picker opens in front of the browser.
  const owner = new BrowserWindow({ show: false, alwaysOnTop: true, skipTaskbar: true, width: 1, height: 1 });
  try {
    const r = await dialog.showOpenDialog(owner, { title, defaultPath: at, properties: ["openDirectory", "createDirectory"] });
    return r.canceled || !r.filePaths[0] ? "" : r.filePaths[0];
  } finally { owner.destroy(); }
}
async function filesOp(m) {
  const op = String(m.op || "");
  const links = clientLinks();
  if (op === "status") {
    const k = clientdirs.key(m.client);
    return { ok: true, root: clientsRoot(), isDefault: !settings.clientsRoot, linked: Object.keys(links).length, clientDir: m.client ? (links[k] || "") : "" };
  }
  if (op === "pickRoot") {
    const p = await pickFolder("Folder that holds your client folders", clientsRoot());
    if (p) { settings.clientsRoot = p; saveSettings(); }
    return { ok: true, root: clientsRoot(), picked: !!p };
  }
  if (op === "resetRoot") { delete settings.clientsRoot; saveSettings(); return { ok: true, root: clientsRoot() }; }
  if (op === "pickClient") {
    let at = clientsRoot();
    try { at = clientdirs.clientDir(clientsRoot(), m.client, links, false); } catch (e) {}
    const p = await pickFolder("Folder for " + String(m.client || "this client"), at);
    if (p) { settings.clientLinks = { ...links, [clientdirs.key(m.client)]: p }; saveSettings(); }
    return { ok: true, dir: p || "", picked: !!p };
  }
  if (op === "unlinkClient") { const l = { ...links }; delete l[clientdirs.key(m.client)]; settings.clientLinks = l; saveSettings(); return { ok: true }; }
  if (op === "task") {
    const r = await clientdirs.writeTask(clientsRoot(), links, m, (u, o) => fetch(u, o), getToken());
    return { ok: true, ...r };
  }
  if (op === "clientFile") {
    const r = clientdirs.writeClientFile(clientsRoot(), links, m);
    if (m.show) shell.showItemInFolder(r.file);
    return { ok: true, ...r };
  }
  if (op === "list") return { ok: true, ...clientdirs.listClientFiles(clientsRoot(), links, m.client) };
  if (op === "read") return { ok: true, ...clientdirs.readClientFile(clientsRoot(), links, m.client, m.rel) };
  if (op === "openFile") { const err = await shell.openPath(clientdirs.clientFilePath(clientsRoot(), links, m.client, m.rel)); return { ok: !err, error: err || undefined }; }
  if (op === "showFile") { shell.showItemInFolder(clientdirs.clientFilePath(clientsRoot(), links, m.client, m.rel)); return { ok: true }; }
  if (op === "open") {
    const dir = clientdirs.clientDir(clientsRoot(), m.client, links, true);
    let p = dir;
    if (m.task) { const t = path.join(dir, "tasks", clientdirs.safeName(m.task, 80)); if (fs.existsSync(t)) p = t; }
    const err = await shell.openPath(p);
    return { ok: !err, dir: p, error: err || undefined };
  }
  return { ok: false, error: "Unknown request - update the ClickUp Tracker app." };
}

let linking = false;
async function fromExtension(m) {
  // The strip style picked in the extension (General › Floating tracker › Strip style).
  if (STYLES.includes(m.style) && m.style !== settings.stripStyle) { settings.stripStyle = m.style; saveSettings(); send("settings", publicSettings()); }
  if (typeof m.anim === "boolean" && m.anim !== (settings.stripAnim !== false)) { settings.stripAnim = m.anim; saveSettings(); send("settings", publicSettings()); }
  // "Ask before completing a task with nothing to show for it" (the extension's setting).
  if (typeof m.warnEmpty === "boolean" && m.warnEmpty !== (settings.warnEmpty !== false)) { settings.warnEmpty = m.warnEmpty; saveSettings(); }
  if (typeof m.show === "boolean" && m.show !== extShow) {
    extShow = m.show;
    settings.hiddenByExt = !m.show; saveSettings();
    if (win) { if (m.show && stripWanted()) win.showInactive(); else win.hide(); }
    buildTray();
  }
  if (m.token && !cu && !linking) {
    linking = true;
    try {
      const c = new ClickUp(String(m.token).trim());
      const info = await c.init(m.teamId || settings.teamId);
      cu = c; settings.teamId = info.teamId; setToken(String(m.token).trim());
      recreate();
      refresh();
    } catch (e) { /* a token ClickUp turned down: wait for the next one */ }
    finally { linking = false; }
  }
}

// ---------- update check (GitHub releases tagged desktop-v*) ----------
let updateInfo = null;
async function checkUpdate() {
  try {
    const res = await fetch("https://api.github.com/repos/" + REPO + "/releases?per_page=20", { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    const rel = (await res.json()).filter((r) => /^desktop-v/.test(r.tag_name || "") && !r.draft)[0];
    if (!rel) return;
    const v = rel.tag_name.replace(/^desktop-v/, "");
    const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
    if (cmp(v, app.getVersion()) > 0) { updateInfo = { version: v, url: rel.html_url }; buildTray(); send("update", updateInfo); }
  } catch (e) {}
}

// ---------- IPC ----------
ipcMain.handle("state", async () => state || (cu ? refresh() : null));
ipcMain.handle("settings", () => publicSettings());
ipcMain.handle("setup", async (e, token) => {
  try {
    const c = new ClickUp(String(token || "").trim());
    const info = await c.init(settings.teamId);
    cu = c; settings.teamId = info.teamId; setToken(String(token).trim());
    recreate();
    refresh();
    return { ok: true, username: info.username };
  } catch (err) {
    return { ok: false, error: err.status === 401 ? "ClickUp didn't accept that token." : String(err.message || err) };
  }
});
ipcMain.handle("expand", (e, on) => { if (on) peek(false); setExpanded(!!on); return expanded; });
// The hover card over the strip: the window grows up (or down, at the top of the
// screen) by the card's own height while the pointer is on it, then goes back
// exactly. The window draws the new layout first ("plan"), so growing or
// shrinking never shows the strip in the wrong place for a frame.
const PEEK_H = 92; // when the window doesn't say how tall its card is
const peekH = (need) => Math.max(56, Math.min(260, Math.round(Number(need) || PEEK_H)));
// peekOn = the window is grown right now; peekBase = the strip's own place,
// kept a moment after shrinking so a "moved" from the resize isn't remembered.
// (Before, pointing back within that moment found peekBase still set, answered
// "open" without growing the window, and the card was drawn squashed.)
let peekBase = null, peekDir = "up", peekOn = false, peekClear = 0;
function peek(on, need) {
  if (!win || win.isDestroyed()) return null;
  if (room && !expanded) {
    // The card's room is already there: only say where, and remember how tall
    // the card is (the pointer counts as on it there).
    const stripH = baseOf(win.getBounds()).height;
    if (on === "plan") return { dir: room.dir, stripH, room: true };
    if (on) { peekOn = true; cardH = peekH(need); return { dir: room.dir, stripH, room: true }; }
    peekOn = false; cardH = 0;
    return null;
  }
  if (on === "plan") {
    // Which way it will open, without growing yet.
    if (expanded) return null;
    const b = peekOn && peekBase ? peekBase : win.getBounds(), disp = screen.getDisplayMatching(b);
    return { dir: b.y - peekH(need) >= disp.bounds.y ? "up" : "down", stripH: b.height };
  }
  if (on) {
    if (expanded) return null;
    const H = peekH(need);
    clearTimeout(peekClear);
    const b = peekOn && peekBase ? peekBase : (peekBase || win.getBounds()), disp = screen.getDisplayMatching(b);
    if (!peekOn) peekDir = b.y - H >= disp.bounds.y ? "up" : "down";
    peekBase = b; peekOn = true;
    // Also when it's already open and its content got taller or shorter.
    const want = { x: b.x, y: peekDir === "up" ? b.y - H : b.y, width: b.width, height: b.height + H };
    const cur = win.getBounds();
    if (cur.x !== want.x || cur.y !== want.y || cur.width !== want.width || cur.height !== want.height) win.setBounds(want);
    return { dir: peekDir, stripH: b.height };
  }
  if (!peekOn || !peekBase) return null;
  peekOn = false;
  win.setBounds(peekBase);
  clearTimeout(peekClear);
  peekClear = setTimeout(() => { if (!peekOn) peekBase = null; }, 250);
  return null;
}
ipcMain.handle("peek", (e, on, need) => peek(on === "plan" ? "plan" : !!on, need));
ipcMain.handle("hover", (e, on) => { if (win && !expanded) win.setOpacity(on ? 1 : Number(settings.opacity) || 1); });
// Windows doesn't send mouse events over a drag area, so watch the cursor here.
let pointerIn = false;
// The strip belongs on the taskbar: after sleep, an Explorer restart, a DPI or
// display change Windows can leave it elsewhere - put it back (checked once a
// second, never while it's grown, being dragged or in the bigger view).
let dockTick = 0;
function keepDocked() {
  if (!win || win.isDestroyed() || !win.isVisible() || expanded || peekBase || !docked()) return;
  if (!room && peekOn) return;
  const d = dockBounds();
  if (room) { const want = withRoom(d), b = win.getBounds(); if (b.x !== want.x || b.y !== want.y || b.width !== want.width || b.height !== want.height) win.setBounds(want); return; }
  const b = win.getBounds();
  if (b.x !== d.x || b.y !== d.y || b.width !== d.width || b.height !== d.height) win.setBounds(d);
}
function watchPointer() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (++dockTick % 15 === 0 && !pointerIn) keepDocked();
  const p = screen.getCursorScreenPoint(), full = win.getBounds();
  const hit = (r) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  let inside;
  if (room && !expanded) {
    const s = baseOf(full);
    const c = peekOn && cardH ? { x: s.x, y: room.dir === "up" ? s.y - cardH : s.y + s.height, width: s.width, height: cardH } : null;
    inside = hit(s) || (!!c && hit(c));
    setSolid(inside);
  } else inside = hit(full);
  if (inside === pointerIn) return;
  pointerIn = inside;
  if (!expanded) win.setOpacity(inside ? 1 : Number(settings.opacity) || 1);
  send("pointer", inside);
}
ipcMain.handle("open", (e, url) => { if (/^https:\/\/(app\.)?clickup\.com\//.test(String(url))) shell.openExternal(url); });
ipcMain.handle("comments", async (e, force) => { await checkComments(!!force); });
ipcMain.handle("seen", (e, taskId) => { settings.commentsSeen[taskId] = Date.now(); saveSettings(); });
ipcMain.handle("action", async (e, a) => doAction(a));
ipcMain.handle("menu", () => { showStripMenu(); });
// Nothing to show for a task: no filled Description: "..." or File: "..." in its
// description and no comment. A failed read never stops it being completed.
async function nothingToShow(taskId) {
  try {
    const t = await cu.task(taskId, true);
    const desc = String((t && t.description) || "");
    const filled = (n) => { const m = new RegExp("(?:^|\\n)[ \\t*_>-]*" + n + "\\s*:\\s*[*_]*\\s*\"([\\s\\S]*?)\"", "i").exec(desc); return !!(m && m[1].replace(/[*_\s]/g, "")); };
    if (filled("Description") || filled("File")) return false;
    return !(await cu.comments(taskId)).length;
  } catch (e) { return false; }
}
async function doAction(a) {
  try {
    const run = state && state.running;
    if (a.type === "stop" && run) {
      await cu.stopTimer();
      await cu.setStatus(run.taskId, "to do").catch(() => {});
      lastStopped = state.task && state.task.isExtra ? lastStopped : { id: run.taskId, name: run.taskName };
    } else if (a.type === "complete" && run) {
      if (state.task && state.task.isExtra) throw new Error("The recurring Extra Task can't be completed here.");
      if (settings.warnEmpty !== false && (await nothingToShow(run.taskId))) {
        const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
          type: "warning", buttons: ["Complete anyway", "Cancel"], defaultId: 1, cancelId: 1, noLink: true,
          title: "ClickUp Tracker", message: "\u201c" + (run.taskName || "This task") + "\u201d has nothing to show for it yet",
          detail: "No Description: \"\u2026\", no File: \"\u2026\" and no comment. Add one in ClickUp (or a comment here), or complete it anyway.",
        });
        if (r.response !== 0) return { ok: true, cancelled: true };
      }
      await cu.stopTimer().catch(() => {});
      await cu.setStatus(run.taskId, "complete");
      if (resumeTask && resumeTask.id === run.taskId) resumeTask = null;
    } else if (a.type === "start" || a.type === "extra" || a.type === "resume") {
      const target = a.type === "extra" ? state.extra && state.extra.id : a.type === "resume" ? state.last && state.last.id : a.taskId;
      if (!target) throw new Error(a.type === "extra" ? "No Extra Task found for you." : "Nothing to start.");
      if (run) {
        await cu.stopTimer().catch(() => {});
        if (run.taskId !== target) await cu.setStatus(run.taskId, "to do").catch(() => {});
        if (a.type === "extra" && run.taskId !== target) resumeTask = { id: run.taskId, name: run.taskName };
      }
      await cu.setStatus(target, "in progress").catch(() => {});
      await cu.startTimer(target, a.note || "");
      if (a.type === "resume") resumeTask = null;
    } else if (a.type === "comment") {
      await cu.comment(a.taskId, a.text, a.files);
      commentsAt = 0;
    } else if (a.type === "note" && run && run.entryId) {
      await cu.setEntryNote(run.entryId, a.text);
    }
    await refresh();
    return { ok: true };
  } catch (err) {
    await refresh().catch(() => {});
    send("error", String(err && err.message ? err.message : err));
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// ---------- start ----------
app.whenReady().then(async () => {
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  loadSettings();
  // Installed: start with the computer from the first run on (the tray menu's
  // "Start with Windows / macOS" turns it off).
  if (app.isPackaged && !settings.autostartSet) {
    try { app.setLoginItemSettings({ openAtLogin: true }); } catch (e) {}
    settings.autostartSet = true; saveSettings();
  }
  startLink();
  const token = process.env.PCM_DEMO ? null : getToken();
  if (process.env.PCM_DEMO) cu = demoClickUp(); // made-up data for testing - never set in a release
  if (token) {
    try { cu = new ClickUp(token); await cu.init(settings.teamId); settings.teamId = cu.teamId; saveSettings(); }
    catch (e) { if (e.status === 401) { cu = null; setToken(null); } }
  }
  createWindow();
  buildTray();
  refresh();
  setInterval(watchPointer, 70); // quick enough that a click on the strip is never let through
  setInterval(keepOnTop, 1500);                      // back above the taskbar if Windows covered it
  setInterval(paintTrayText, 15000);                 // menu-bar time / tooltip
  screen.on("display-metrics-changed", () => { if (win && docked() && !expanded && !peekBase) placeStrip(dockBounds()); });
  setInterval(() => refresh(), 60000);       // the timer, today's time, next tasks
  setInterval(() => checkComments(false), 30000); // each task at most every 3 minutes
  checkUpdate();
  setInterval(checkUpdate, 6 * 3600000);
  nativeTheme.on("updated", () => send("settings", publicSettings()));
});
app.on("second-instance", () => { if (win) { win.show(); settings.hiddenByExt = false; if (isMac) settings.macStrip = true; saveSettings(); buildTray(); } });

// PCM_DEMO=1: made-up data so the window and the taskbar strip can be looked at
// without a ClickUp token. Never used in normal running.
function demoClickUp() {
  const start = Date.now() - 27 * 60000;
  return {
    teamId: "1", userId: "1",
    init: async () => ({ teamId: "1", username: "Demo" }),
    running: async () => ({ entryId: "e1", taskId: "t1", taskName: "Fix the redirect rule on the service pages", startMs: start, description: "" }),
    todayEntries: async () => ({ total: 3 * 3600000, byTask: new Map([["t1", 15 * 60000]]) }),
    extraTask: async () => ({ id: "x1", name: "Extra Tasks - Demo" }),
    task: async () => ({ name: "Fix the redirect rule on the service pages", estimateMs: 3600000, client: "Acme", url: "https://app.clickup.com/t/t1", dueDateMs: Date.now(), status: "in progress" }),
    dueToday: async () => [],
    comments: async () => [],
    stopTimer: async () => { console.log("[demo] stopTimer"); }, setStatus: async (id, s) => { console.log("[demo] setStatus " + id + " " + s); }, startTimer: async (id) => { console.log("[demo] startTimer " + id); }, setEntryNote: async () => {}, comment: async () => {},
  };
}
app.on("window-all-closed", (e) => { /* keep running in the tray */ });
