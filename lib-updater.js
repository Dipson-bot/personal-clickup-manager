// Shared installer for the unpacked extension, used by the one-click updater page
// (update.js) and by automatic background updates (offscreen-updater.js).
// Chrome never tells an extension where its folder is, so the user picks it once;
// the folder handle is kept in IndexedDB and reused for every update. Before
// writing anything, a random check file proves the remembered folder is the one
// Chrome is actually running this extension from (catches moved / copied /
// wrong folders). Every replaced file is backed up and restored on failure.
import { unzip, isSafePath } from "./lib-unzip.js";

// ---------- small IndexedDB store for the folder handle ----------
function db() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("pcm-updater", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function kvGet(k) {
  const d = await db();
  return new Promise((res, rej) => { const q = d.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
export async function kvSet(k, v) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction("kv", "readwrite"); t.objectStore("kv").put(v, k); t.oncomplete = res; t.onerror = () => rej(t.error); });
}

// True only if `handle` is the folder Chrome is running this extension from:
// write a random file there, then read it back THROUGH the extension's own URL.
export async function isRunningFolder(handle) {
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

// Download `ui.zip`, check it really is version `ui.latest` of THIS extension,
// back up what it replaces, then write it (manifest.json last). Any failure
// while writing restores the previous files. Throws on any problem.
// `running` = chrome.runtime.getManifest(); `step(text)` reports progress.
export async function installPackage(root, ui, running, step = () => {}) {
  const res = await fetch(ui.zip, { cache: "no-store" });
  if (!res.ok) throw new Error("Download failed (HTTP " + res.status + ").");
  const files = await unzip(await res.arrayBuffer());
  step("Downloaded and unpacked " + files.length + " files.");

  const mf = files.find((f) => f.path === "manifest.json");
  if (!mf) throw new Error("The download has no manifest.json - not an extension package.");
  const next = JSON.parse(new TextDecoder().decode(mf.data));
  if (next.version !== ui.latest) throw new Error("The download is v" + next.version + ", expected v" + ui.latest + ".");
  if (next.name !== running.name) throw new Error("The download is a different extension (“" + next.name + "”).");
  if (next.key && running.key && next.key !== running.key) throw new Error("The download has a different extension ID - refusing to install it.");
  const bad = files.find((f) => !isSafePath(f.path));
  if (bad) throw new Error("Unsafe file path in the package: " + bad.path);
  step("Checked: v" + next.version + " of " + next.name + ".");

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
  return { version: next.version, files: written.length };
}
