// Updates the Personal ClickUp Manager extension's folder for it - no browser
// permission, no click. A browser extension installed from a folder can't write
// to that folder by itself without the person's OK; this app can.
//
// Safe by design (any extension could knock on the app's door):
//   - only the extension that asks is updated, and only in the folder the
//     browser has on record for THAT extension (its profile's settings file);
//   - only a package from this project's GitHub releases is downloaded;
//   - the package must be the same extension (name and key) and the asked version;
//   - before writing, the extension proves the folder is the one it runs from: a
//     random code is written here and must be read back by the extension itself.
// Files are written with a backup and put back if anything fails (manifest last).
const fs = require("fs");
const path = require("path");
const os = require("os");
const zlib = require("zlib");

const REPO_ZIP = /^https:\/\/github\.com\/Dipson-bot\/personal-clickup-manager\/releases\/download\/v\d+(\.\d+){1,3}\/[\w.-]+\.zip$/;
const CHECK_FILE = "pcm-folder-check.txt";

// Where Chromium browsers keep their profiles on this computer.
function browserRoots() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const la = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome SxS", "Microsoft/Edge", "BraveSoftware/Brave-Browser", "Chromium", "Vivaldi", "Perplexity/Comet"].map((p) => path.join(la, p, "User Data"));
  }
  if (process.platform === "darwin") {
    const as = path.join(home, "Library", "Application Support");
    return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Microsoft Edge", "BraveSoftware/Brave-Browser", "Chromium", "Vivaldi", "Comet"].map((p) => path.join(as, p));
  }
  const cfg = path.join(home, ".config");
  return ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser", "vivaldi"].map((p) => path.join(cfg, p));
}
// Every folder a browser has on record for this extension id (installed from a folder).
function findFolders(extId) {
  const out = new Set();
  for (const root of browserRoots()) {
    let profiles = [];
    try { profiles = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) { continue; }
    for (const prof of profiles) {
      for (const file of ["Secure Preferences", "Preferences"]) {
        let j = null;
        try { j = JSON.parse(fs.readFileSync(path.join(root, prof, file), "utf8")); } catch (e) { continue; }
        const e = j && j.extensions && j.extensions.settings && j.extensions.settings[extId];
        const p = e && e.path;
        if (p && path.isAbsolute(p)) {
          try { if (fs.statSync(path.join(p, "manifest.json")).isFile()) out.add(path.resolve(p)); } catch (x) {}
        }
      }
    }
  }
  return [...out];
}

// A .zip (stored or deflated entries) -> [{ path, data }].
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("broken zip directory");
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error("unsupported zip compression in " + name);
    files.push({ path: name, data });
  }
  return files;
}
const safePath = (p) => !!p && !p.startsWith("/") && !/^[a-zA-Z]:/.test(p) && !p.split("/").some((s) => s === ".." || s === "");

async function locate(extId, nonce, find = findFolders) {
  if (!/^[a-p]{32}$/.test(extId) || !/^[a-z0-9]{8,64}$/.test(String(nonce || ""))) return { ok: false, error: "bad request" };
  const folders = find(extId);
  if (!folders.length) return { ok: false, reason: "not-found", error: "The browser has no folder on record for this extension (not installed from a folder?)" };
  let wrote = 0;
  for (const f of folders) { try { fs.writeFileSync(path.join(f, CHECK_FILE), String(nonce)); wrote++; } catch (e) {} }
  return wrote ? { ok: true, folders: folders.length } : { ok: false, reason: "not-writable", error: "Couldn't write to the extension's folder" };
}

async function install(extId, msg, find = findFolders, get = fetch) {
  const nonce = String(msg.nonce || ""), version = String(msg.version || ""), zip = String(msg.zip || "");
  if (!/^[a-p]{32}$/.test(extId) || !/^[a-z0-9]{8,64}$/.test(nonce) || !/^\d+(\.\d+){1,3}$/.test(version)) return { ok: false, error: "bad request" };
  if (!REPO_ZIP.test(zip)) return { ok: false, error: "only this project's GitHub releases are installed" };
  // The folder the extension proved it runs from (it read our code back).
  const root = find(extId).find((f) => { try { return fs.readFileSync(path.join(f, CHECK_FILE), "utf8").trim() === nonce; } catch (e) { return false; } });
  if (!root) return { ok: false, reason: "not-found", error: "the extension's folder wasn't confirmed" };
  let cur;
  try { cur = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")); } catch (e) { return { ok: false, error: "the installed manifest.json can't be read" }; }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120000);
  let buf;
  try {
    const res = await get(zip, { signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("download failed (HTTP " + res.status + ")");
    buf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, reason: "download", error: e && e.name === "AbortError" ? "the download took over 2 minutes" : String((e && e.message) || e) };
  } finally { clearTimeout(t); }
  let files;
  try { files = unzip(buf); } catch (e) { return { ok: false, error: "the download isn't a valid package (" + e.message + ")" }; }
  const mf = files.find((f) => f.path === "manifest.json");
  if (!mf) return { ok: false, error: "the package has no manifest.json" };
  let next;
  try { next = JSON.parse(mf.data.toString("utf8")); } catch (e) { return { ok: false, error: "the package's manifest.json is broken" }; }
  if (next.version !== version) return { ok: false, error: "the package is v" + next.version + ", expected v" + version };
  if (next.name !== cur.name) return { ok: false, error: "the package is a different extension" };
  if ((next.key || cur.key) && next.key !== cur.key) return { ok: false, error: "the package has a different extension key" };
  const bad = files.find((f) => !safePath(f.path));
  if (bad) return { ok: false, error: "unsafe file path in the package: " + bad.path };
  // Write (manifest last), with a backup of each file to put back if anything fails.
  const ordered = files.filter((f) => f.path !== "manifest.json").concat([mf]);
  const backup = new Map(), written = [];
  try {
    for (const f of ordered) {
      const full = path.join(root, ...f.path.split("/"));
      let old = null;
      try { old = fs.readFileSync(full); } catch (e) {}
      backup.set(full, old);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, f.data);
      written.push(full);
    }
  } catch (e) {
    for (const full of written.reverse()) {
      const old = backup.get(full);
      try { if (old) fs.writeFileSync(full, old); else fs.unlinkSync(full); } catch (x) {}
    }
    return { ok: false, error: "couldn't write the new files (" + e.message + ") - nothing was changed" };
  }
  try { fs.unlinkSync(path.join(root, CHECK_FILE)); } catch (e) {}
  return { ok: true, version: next.version, files: written.length };
}

// The extension's request: { op: "locate", nonce } or { op: "install", nonce, version, zip }.
async function handle(origin, msg, opts = {}) {
  const extId = (String(origin).match(/^chrome-extension:\/\/([a-p]{32})$/) || [])[1] || "";
  if (!msg || typeof msg !== "object") return { ok: false, error: "bad request" };
  if (msg.op === "locate") return locate(extId, msg.nonce, opts.find);
  if (msg.op === "install") return install(extId, msg, opts.find, opts.fetch);
  return { ok: false, error: "unknown op" };
}
module.exports = { handle, findFolders, unzip, browserRoots };
