// One-click updater for the unpacked extension.
// Chrome never tells an extension where its folder is, so the user picks it once;
// the folder handle is kept in IndexedDB and reused for every update. Before
// writing anything, a random check file proves the remembered folder is the one
// Chrome is actually running this extension from (catches moved / copied /
// wrong folders). Every replaced file is backed up and restored on failure.
// Folder store, folder check and the install steps are shared with automatic
// background updates (offscreen-updater.js) - see lib-updater.js.
import { kvGet, kvSet, isRunningFolder, installPackage } from "./lib-updater.js";

const $ = (id) => document.getElementById(id);
const running = chrome.runtime.getManifest();
const setupMode = new URLSearchParams(location.search).has("setup");

// ---------- UI helpers ----------
function say(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + (kind || "");
}
function step(text) {
  const li = document.createElement("li");
  li.textContent = text;
  $("log").appendChild(li);
  $("log").hidden = false;
}
function busy(on) {
  for (const id of ["installBtn", "pickBtn", "checkBtn"]) if ($(id)) $(id).disabled = on;
}

// ---------- folder handling ----------
async function ensurePermission(handle) {
  const opts = { mode: "readwrite" };
  if ((await handle.queryPermission(opts)) === "granted") return true;
  return (await handle.requestPermission(opts)) === "granted";
}

// One-click updates need the File System Access API. Chrome, Edge, Opera,
// Vivaldi and Arc have it. Brave ships it switched off (a flag an extension
// can't change, but can open for the user); a work/school policy can also block
// it, which only shows up as a refusal when the picker is called.
const canPickFolder = typeof window.showDirectoryPicker === "function";
const isBrave = !!navigator.brave;
const BRAVE_FLAG_URL = "chrome://flags/#file-system-access-api";
function noPickerMessage() {
  if (isBrave) {
    return "Brave has folder access turned off, so one-click updates need one setting first. Click \"Open Brave setting\", choose Enabled, then click Relaunch at the bottom of that page. After Brave restarts, come back here and click Install.";
  }
  return "This browser doesn't let extensions write to a folder, so one-click updates can't work here. Use \"Download the zip instead\" below: unzip it over this extension's folder, then click Reload on this extension in the extensions page.";
}
function blockedByPolicyMessage() {
  return "This computer's settings (often set by a work or school IT team) block folder access, so one-click updates can't work here. Use \"Download the zip instead\" below: unzip it over this extension's folder, then click Reload on this extension in the extensions page.";
}

async function pickFolder() {
  if (!canPickFolder) throw new Error(noPickerMessage());
  let handle;
  try {
    handle = await window.showDirectoryPicker({ id: "pcm-extension-folder", mode: "readwrite", startIn: "downloads" });
  } catch (e) {
    if (e && (e.name === "SecurityError" || e.name === "NotAllowedError")) throw new Error(blockedByPolicyMessage());
    throw e;
  }
  if (!(await ensurePermission(handle))) throw new Error("Chrome didn't get permission to edit that folder.");
  if (!(await isRunningFolder(handle))) {
    throw new Error("That isn't the folder this extension runs from. In chrome://extensions open Details on this extension; the \"Source\" line shows the right folder.");
  }
  await kvSet("extDir", handle);
  return handle;
}

// Remembered folder, re-verified. Returns null when it's missing or has moved.
async function rememberedFolder() {
  const handle = await kvGet("extDir");
  if (!handle) return null;
  if (!(await ensurePermission(handle))) return null;
  return (await isRunningFolder(handle)) ? handle : null;
}

async function showFolderState() {
  if (!canPickFolder) {
    $("folderLine").textContent = noPickerMessage();
    $("pickBtn").hidden = true;
    $("braveBtn").hidden = !isBrave;
    return;
  }
  const handle = await kvGet("extDir").catch(() => null);
  let allowed = false;
  try { allowed = !!handle && (await handle.queryPermission({ mode: "readwrite" })) === "granted"; } catch (e) {}
  $("folderLine").textContent = !handle
    ? "One-click and automatic updates: not set up yet - choose this extension's folder once. When Chrome asks, pick \"Allow on every visit\"."
    : allowed
      ? "One-click and automatic updates: on (folder \u201c" + handle.name + "\u201d)."
      : "Folder \u201c" + handle.name + "\u201d is remembered, but Chrome will ask again before writing to it. For automatic updates, click Change folder, pick the same folder and choose \"Allow on every visit\".";
  $("pickBtn").textContent = handle ? "Change folder" : "Choose folder";
}

// ---------- the update ----------
async function install(target) {
  busy(true);
  $("log").innerHTML = "";
  try {
    let ui = target || null;
    if (!ui) {
      const got = await chrome.storage.local.get("updateInfo");
      ui = got.updateInfo;
      if (!ui || !ui.newer || !ui.zip) throw new Error("No newer version to install right now.");
    }
    if (!ui.zip) throw new Error("That version has no downloadable package.");
    const older = ui.latest && running.version && cmpVer(ui.latest, running.version) < 0;

    // 1. The folder: remembered + still valid, or ask for it (user gesture = this click).
    let root = await rememberedFolder();
    if (!root) {
      const had = await kvGet("extDir").catch(() => null);
      step(had ? "The extension's folder has moved - please choose its current folder." : "Choose the folder this extension is installed in.");
      root = await pickFolder();
      await showFolderState();
    }
    step("Folder confirmed: “" + root.name + "” is the folder Chrome runs this extension from.");

    // 2-4. Download, check it's this extension's expected version, back up, write
    // (restoring the old files if anything fails) - shared with auto-updates.
    say((older ? "Rolling back to v" : "Downloading v") + ui.latest + "\u2026");
    await installPackage(root, ui, running, step);

    // 5. Reload into the new version; the background confirms "Updated to vX".
    await chrome.storage.local.set({
      updateDownload: { version: ui.latest, done: true, at: Date.now(), via: "updater" },
      // The restart closes this page; open the dashboard in its place.
      reopenAfterReload: { url: chrome.runtime.getURL("options.html#dashboard"), at: Date.now() },
    });
    say("Done - restarting the extension on v" + ui.latest + (older ? " (rolled back)" : "") + "…", "ok");
    setTimeout(() => chrome.runtime.reload(), 900);
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "No folder chosen - nothing was changed." : (e && e.message ? e.message : String(e));
    say(msg, "err");
    busy(false);
  }
}

// ---------- page setup ----------
async function render() {
  $("current").textContent = "v" + running.version;
  await showFolderState();
  const { updateInfo: ui } = await chrome.storage.local.get("updateInfo");
  if (setupMode) {
    $("title").textContent = "Turn on one-click updates";
    $("lead").textContent = "Choose the folder you unzipped this extension into, and when Chrome asks, pick \"Allow on every visit\". It's done once; after that new versions install by themselves in the background.";
  }
  if (ui && ui.newer) {
    $("latest").textContent = "v" + ui.latest;
    $("installBtn").hidden = false;
    $("installBtn").textContent = "Install v" + ui.latest;
    $("notesLink").href = ui.url;
    $("notesLink").hidden = false;
    $("zipLink").href = ui.zip || ui.url;
    $("zipLink").hidden = false;
    if (!setupMode) say("v" + ui.latest + " is ready to install.");
  } else {
    $("latest").textContent = ui && ui.latest ? "v" + ui.latest : "-";
    $("installBtn").hidden = true;
    if (!setupMode) say("You're on the latest version.", "ok");
  }
}

// Compare "3.5.1" style versions: -1 / 0 / 1.
function cmpVer(a, b) {
  const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
// Every published release, so a bad version can be rolled back.
let releases = [];
async function loadVersions() {
  const sel = $("versSel");
  sel.innerHTML = "<option>Loading…</option>";
  let r = null;
  try { r = await chrome.runtime.sendMessage({ type: "LIST_RELEASES" }); } catch (e) {}
  if (!r || !r.ok || !Array.isArray(r.releases) || !r.releases.length) {
    sel.innerHTML = "<option>Couldn't load the version list</option>";
    sel.disabled = true;
    $("versBtn").disabled = true;
    return;
  }
  releases = r.releases;
  sel.innerHTML = releases.map((x, i) => {
    const when = x.publishedAt ? new Date(x.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
    const tag = x.version === running.version ? " - installed" : (cmpVer(x.version, running.version) < 0 ? " - older" : " - newer");
    return '<option value="' + i + '">v' + x.version + (when ? " (" + when + ")" : "") + tag + (x.prerelease ? " [pre-release]" : "") + "</option>";
  }).join("");
  const cur = releases.findIndex((x) => x.version === running.version);
  sel.value = String(cur >= 0 ? cur : 0);
}
$("versBtn").onclick = () => {
  const x = releases[Number($("versSel").value)];
  if (!x) return;
  if (x.version === running.version) { say("That's the version you're already running.", "ok"); return; }
  install({ latest: x.version, zip: x.zip, url: x.url, newer: cmpVer(x.version, running.version) > 0 });
};

$("installBtn").onclick = () => install();
$("braveBtn").onclick = () => {
  chrome.tabs.create({ url: BRAVE_FLAG_URL }).catch(() => say("Couldn't open it. Type brave://flags/#file-system-access-api in the address bar instead.", "err"));
};
$("pickBtn").onclick = async () => {
  busy(true);
  try {
    await pickFolder();
    await showFolderState();
    say("One-click updates are on ✓ - future updates install from this page with one click.", "ok");
  } catch (e) {
    say(e && e.name === "AbortError" ? "No folder chosen." : (e && e.message ? e.message : String(e)), "err");
  }
  busy(false);
};
$("checkBtn").onclick = async () => {
  busy(true);
  say("Checking GitHub for a new version…");
  try { await chrome.runtime.sendMessage({ type: "CHECK_UPDATE", force: true }); } catch (e) {}
  await render();
  busy(false);
};
$("skipBtn").onclick = () => { chrome.tabs.getCurrent((t) => { if (t) chrome.tabs.remove(t.id); else window.close(); }); };
try {
  chrome.storage.local.get("theme").then(({ theme }) => { if (theme) document.documentElement.dataset.theme = theme; });
} catch (e) {}
render();
loadVersions().then(() => {
  // Opened from Options > "Other versions…": jump straight to the list.
  if (location.hash === "#versions") {
    $("versBox").scrollIntoView({ block: "center" });
    $("versSel").focus();
  }
});
