// One-click updater for the unpacked extension.
// Chrome never tells an extension where its folder is, so the user picks it once;
// the folder handle is kept in IndexedDB and reused for every update. Before
// writing anything, a random check file proves the remembered folder is the one
// Chrome is actually running this extension from (catches moved / copied /
// wrong folders). Every replaced file is backed up and restored on failure.
import { unzip, isSafePath } from "./lib-unzip.js";

const $ = (id) => document.getElementById(id);
const running = chrome.runtime.getManifest();
const setupMode = new URLSearchParams(location.search).has("setup");

// ---------- small IndexedDB store for the folder handle ----------
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pcm-updater", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) {
  const d = await db();
  return new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function kvSet(k, v) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

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

// True only if `handle` is the folder Chrome is running this extension from:
// write a random file there, then read it back THROUGH the extension's own URL.
async function isRunningFolder(handle) {
  const name = "pcm-folder-check.txt";
  const token = crypto.randomUUID();
  let wrote = false;
  try {
    const fh = await handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(token);
    await w.close();
    wrote = true;
    const res = await fetch(chrome.runtime.getURL(name) + "?t=" + Date.now(), { cache: "no-store" });
    return res.ok && (await res.text()).trim() === token;
  } catch (e) {
    return false;
  } finally {
    if (wrote) { try { await handle.removeEntry(name); } catch (e) {} }
  }
}

async function pickFolder() {
  const handle = await window.showDirectoryPicker({ id: "pcm-extension-folder", mode: "readwrite", startIn: "downloads" });
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
  const handle = await kvGet("extDir").catch(() => null);
  $("folderLine").textContent = handle
    ? "One-click updates: on (folder “" + handle.name + "”)."
    : "One-click updates: not set up yet - choose this extension's folder once.";
  $("pickBtn").textContent = handle ? "Change folder" : "Choose folder";
}

// ---------- write files with backup / rollback ----------
async function dirFor(root, path, create) {
  const parts = path.split("/");
  let dir = root;
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name: parts[parts.length - 1] };
}
async function readIfExists(root, path) {
  try {
    const { dir, name } = await dirFor(root, path, false);
    const f = await (await dir.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch (e) { return null; }
}
async function writeFile(root, path, data) {
  const { dir, name } = await dirFor(root, path, true);
  const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
  await w.write(data);
  await w.close();
}
async function removeFile(root, path) {
  try { const { dir, name } = await dirFor(root, path, false); await dir.removeEntry(name); } catch (e) {}
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

    // 2. Download + unpack.
    say((older ? "Rolling back to v" : "Downloading v") + ui.latest + "…");
    const res = await fetch(ui.zip, { cache: "no-store" });
    if (!res.ok) throw new Error("Download failed (HTTP " + res.status + ").");
    const files = await unzip(await res.arrayBuffer());
    step("Downloaded and unpacked " + files.length + " files.");

    // 3. Check it's really the expected version of THIS extension.
    const mf = files.find((f) => f.path === "manifest.json");
    if (!mf) throw new Error("The download has no manifest.json - not an extension package.");
    const next = JSON.parse(new TextDecoder().decode(mf.data));
    if (next.version !== ui.latest) throw new Error("The download is v" + next.version + ", expected v" + ui.latest + ".");
    if (next.name !== running.name) throw new Error("The download is a different extension (“" + next.name + "”).");
    if (next.key && running.key && next.key !== running.key) throw new Error("The download has a different extension ID - refusing to install it.");
    const bad = files.find((f) => !isSafePath(f.path));
    if (bad) throw new Error("Unsafe file path in the package: " + bad.path);
    step("Checked: v" + next.version + " of " + next.name + ".");

    // 4. Back up what we're about to replace, then write (manifest.json last).
    say("Installing v" + ui.latest + "…");
    const backup = new Map();
    for (const f of files) backup.set(f.path, await readIfExists(root, f.path));
    const ordered = files.filter((f) => f.path !== "manifest.json").concat([mf]);
    const written = [];
    try {
      for (const f of ordered) { await writeFile(root, f.path, f.data); written.push(f.path); }
    } catch (e) {
      step("Something failed while writing - restoring the previous version…");
      for (const p of written.reverse()) {
        const old = backup.get(p);
        if (old) await writeFile(root, p, old).catch(() => {});
        else await removeFile(root, p);
      }
      throw new Error("Couldn't write the new files (" + (e && e.message ? e.message : e) + "). Nothing was changed.");
    }
    step("Installed " + written.length + " files.");

    // 5. Reload into the new version; the background confirms "Updated to vX".
    await chrome.storage.local.set({ updateDownload: { version: ui.latest, done: true, at: Date.now(), via: "updater" } });
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
    $("lead").textContent = "Choose the folder you just unzipped this extension into. It's done once; future updates install with one click.";
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
