// Automatic update from a tab. The hidden offscreen page can't always use the
// folder permission, so the background opens THIS page in a tab that is not
// focused (the tab you're working in stays in front) and it installs with the
// same code as the update page.
//   - Chrome allows it: install, then restart the extension FROM HERE (and put
//     the tab you were using back in front) - so it never depends on the
//     background being awake when the install finishes.
//   - Chrome says the folder needs permission: ask the background to bring this
//     tab to the front (a visible page can use it), try again; if Chrome still
//     wants a click, show one "Finish update" button (no folder picking).
// It reports every outcome back (AUTO_UPDATE_TAB_RESULT), so the background can
// record exactly what happened.
import { kvGet, isRunningFolder, installPackage } from "./lib-updater.js";

const nonce = new URLSearchParams(location.search).get("n") || "";
const $ = (id) => document.getElementById(id);
const tell = (msg) => chrome.runtime.sendMessage({ nonce, ...msg }).catch(() => {});
let ui = null, root = null, busy = false, finished = false;

async function check(ask) {
  const g = await chrome.storage.local.get("updateInfo");
  ui = g.updateInfo || null;
  if (!ui || !ui.zip || !ui.latest) return { ok: false, reason: "no-update" };
  $("t").textContent = "Installing v" + ui.latest + "…";
  root = await kvGet("extDir").catch(() => null);
  if (!root) return { ok: false, reason: "no-folder" };
  let perm = await root.queryPermission({ mode: "readwrite" });
  if (perm !== "granted" && ask) perm = await root.requestPermission({ mode: "readwrite" });
  if (perm !== "granted") return { ok: false, reason: "permission", visible: document.visibilityState };
  if (!(await isRunningFolder(root))) return { ok: false, reason: "moved" };
  return { ok: true };
}
async function install() {
  // Progress on the page, so it never just says "Installing…" while nothing moves.
  const r = await installPackage(root, { latest: ui.latest, zip: ui.zip }, chrome.runtime.getManifest(), (msg) => { if (!finished) $("s").textContent = msg; });
  return { ok: true, version: r.version };
}
async function done(r) {
  if (finished) return;
  finished = true;
  $("go").hidden = true;
  $("t").textContent = r.ok ? "Updated to v" + r.version + " ✓" : "Couldn't install the update here";
  $("s").textContent = r.ok ? "The extension restarts now; this tab closes by itself." : (r.reason === "moved"
    ? "The extension's folder has moved - choose it again in the update page (Options › Version and updates)."
    : "This tab closes by itself. You'll get a notice with what to do.");
  tell({ type: "AUTO_UPDATE_TAB_RESULT", ...r });
  if (!r.ok) {
    // Normally the background closes this tab. Still here 20 s later (it was
    // asleep): don't leave it looking stuck - offer the way to finish.
    setTimeout(() => {
      $("s").textContent = (r.error ? "It stopped with: " + r.error + ". " : "") + "You can close this tab, or install the update from the update page - it takes a few seconds.";
      if (!$("page")) {
        const b = document.createElement("button");
        b.id = "page"; b.type = "button"; b.textContent = "Open the update page";
        b.style.cssText = "margin-top:14px;font:inherit;font-size:14px;font-weight:600;padding:10px 20px;border:0;border-radius:10px;background:#4f46e5;color:#fff;cursor:pointer;";
        b.onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("update.html") }).catch(() => {}); };
        $("s").after(b);
      }
    }, 20000);
    return;
  }
  // Record the update and restart from here: works even if the background went to sleep meanwhile.
  try {
    const { autoUpdateWake: w } = await chrome.storage.local.get("autoUpdateWake");
    await chrome.storage.local.set({
      updateDownload: { version: r.version, done: true, at: Date.now(), via: "auto" },
      autoUpdateState: { version: r.version, installedAt: Date.now(), fails: 0, trace: ["installed v" + r.version + " from a tab"] },
    });
    if (w && w.prevTabId != null) await chrome.tabs.update(w.prevTabId, { active: true }).catch(() => {});
    if (w && w.prevWindowId != null) await chrome.windows.update(w.prevWindowId, { focused: true }).catch(() => {});
    await chrome.storage.local.remove("autoUpdateWake").catch(() => {});
  } catch (e) {}
  setTimeout(() => chrome.runtime.reload(), 1200);
}
async function attempt(ask) {
  if (busy || finished) return;
  busy = true;
  try {
    const c = await check(ask);
    if (!c.ok) {
      if (c.reason === "permission") return c; // the caller decides: come to the front / ask for a click
      await done(c);
      return c;
    }
    await done(await install());
    return { ok: true };
  } catch (e) {
    const r = { ok: false, reason: "failed", error: String(e && e.message ? e.message : e) };
    await done(r);
    return r;
  } finally { busy = false; }
}

// One click is enough: the user's click lets Chrome restore "Allow on every visit".
$("go").onclick = () => attempt(true).then((r) => {
  if (r && !r.ok && r.reason === "permission") done({ ok: false, reason: "permission", clicked: true });
});

// A tab Chrome brought back after a restart, or one left over from an earlier
// try, or the update is already in: close it instead of asking again.
const closeMe = async () => {
  try { const t = await chrome.tabs.getCurrent(); if (t && t.id != null) { await chrome.tabs.remove(t.id); return; } } catch (e) {}
  window.close();
};
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0; } return false; };
async function stale() {
  const s = await chrome.storage.session.get("autoUpdateTab").catch(() => ({}));
  if (!s.autoUpdateTab || s.autoUpdateTab.nonce !== nonce) return true;
  const g = await chrome.storage.local.get("updateInfo");
  const u = g.updateInfo;
  return !u || !u.latest || !newer(u.latest, chrome.runtime.getManifest().version);
}

// Watchdog: still not done after 2 minutes (a stalled download, or the extension's
// background went to sleep and never answered) - say so plainly instead of
// sitting on "Installing…", with a way to finish it.
setTimeout(() => {
  if (finished || !$("go").hidden) return;
  $("t").textContent = "The update is taking longer than it should";
  $("s").textContent = "Something held it up (often a slow or blocked download). Try again, or install it from the update page - it takes a few seconds.";
  document.title = "\u26A0 Update didn't finish";
  $("go").textContent = "Try again";
  $("go").hidden = false;
  $("go").onclick = () => location.reload();
  if (!$("page")) {
    const b = document.createElement("button");
    b.id = "page"; b.type = "button"; b.textContent = "Open the update page";
    b.style.cssText = "margin:14px 0 0 8px;font:inherit;font-size:14px;padding:10px 16px;border:1px solid #c9c0b3;border-radius:10px;background:none;color:inherit;cursor:pointer;";
    b.onclick = () => { chrome.tabs.create({ url: chrome.runtime.getURL("update.html") }).catch(() => {}); };
    $("go").after(b);
  }
  tell({ type: "AUTO_UPDATE_TAB_RESULT", ok: false, reason: "stalled", error: "no result after 2 minutes" });
}, 120000);

(async () => {
  if (await stale().catch(() => false)) { finished = true; closeMe(); return; }
  let r = await attempt(false);
  if (!r || r.ok || r.reason !== "permission") return;
  // Not allowed while hidden: ask to be shown, then try once more.
  tell({ type: "AUTO_UPDATE_TAB_FRONT" });
  const visible = () => new Promise((ok) => {
    if (document.visibilityState === "visible") return ok();
    const on = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", on); ok(); } };
    document.addEventListener("visibilitychange", on);
    setTimeout(ok, 8000);
  });
  await visible();
  await new Promise((ok) => setTimeout(ok, 400));
  r = await attempt(false);
  if (!r || r.ok || r.reason !== "permission") return;
  // Chrome wants a click this time.
  $("t").textContent = "One click to finish the update";
  document.title = "\uD83D\uDC49 Click to finish the update";
  $("s").textContent = "Chrome needs your OK once to let the extension update its own folder. Click the button - it installs and the extension restarts.";
  $("go").hidden = false;
  $("go").focus();
  tell({ type: "AUTO_UPDATE_TAB_RESULT", ok: false, reason: "needs-click" });
})();
