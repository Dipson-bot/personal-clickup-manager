// Client folders on this computer, for the extension's "Send to Claude Code" and
// "Show in folder". One root folder (picked in the extension, default
// Documents/Personal ClickUp Manager/Clients) with a folder per client. An
// existing folder is reused when its name is the client's ignoring case, spaces
// and punctuation ("bright roofing" for "Bright Roofing"), or the one folder that
// starts the same (6+ letters); a client can also be pointed at any folder.
// Plain Node (no Electron) so it can be tested on its own.
"use strict";
const fs = require("fs");
const path = require("path");

const key = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
// A safe single folder / file name: no slashes, dots-only or reserved characters.
const safeName = (s, max = 120) => {
  let n = String(s || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  n = n.replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = "_" + n;
  return n || "file";
};

// Words of a name, without emoji, symbols or accents.
const words = (s) => String(s || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const plainName = (s) => String(s || "").replace(/[^\p{L}\p{N} &'().,_-]+/gu, " ").replace(/\s+/g, " ").trim() || String(s || "");
// Words a ClickUp List often adds after the client's own name ("BRC Service SEO",
// "Acme Plumbing SEO"): dropped from the end when looking for the client's folder.
const TAIL = new Set(["seo", "service", "services", "website", "web", "site", "marketing", "digital", "client", "project", "account", "team"]);
function core(s) { const w = words(s); while (w.length > 1 && TAIL.has(w[w.length - 1])) w.pop(); return w; }
// Which existing folder is this client's: the same name (any case, spacing,
// emoji); the same name without those added words ("BRC" for "♨ BRC Service SEO");
// one folder whose words start the client's name or the other way round
// ("north star" for "North Star Roofing"); one folder that starts with the
// same 6+ letters ("zenhvac" for "Zen HVAC Pros"). Never a guess between two.
function matchFolder(names, client) {
  const k = key(client), ck = core(client).join("");
  const one = (list) => (list.length === 1 ? list[0] : null);
  const exact = names.find((n) => key(n) === k);
  if (exact) return exact;
  const byCore = names.filter((n) => { const h = key(n); return h === ck || core(n).join("") === ck; });
  if (byCore.length) return one(byCore);
  const cw = words(client);
  const lead = (a, b) => a.length && a.length <= b.length && a.every((w, i) => w === b[i]);
  const byWords = names.filter((n) => { const fw = words(n); return fw.join("").length >= 3 && (lead(fw, cw) || lead(cw, fw)); });
  if (byWords.length) return one(byWords);
  return one(names.filter((n) => { const h = key(n); return Math.min(h.length, k.length) >= 6 && (h.startsWith(k) || k.startsWith(h) || h.startsWith(ck) || ck.startsWith(h)); }));
}

// The folder for a client: its own pick, else a matching folder under root, else
// a new one named after the client. create=false only finds it.
function clientDir(root, client, links, create = true) {
  const k = key(client);
  if (!k) throw new Error("No client for this task.");
  const own = links && links[k];
  if (own && fs.existsSync(own)) return own;
  if (!root) throw new Error("No client folders location.");
  if (create) fs.mkdirSync(root, { recursive: true });
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (e) {}
  const found = matchFolder(names, client);
  if (found) return path.join(root, found);
  // A new folder: the client's name without emoji or symbols.
  const dir = path.join(root, safeName(plainName(client), 80));
  if (create) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Keeps a path inside its folder (a name can't climb out with "..").
function inside(dir, name) {
  const p = path.join(dir, safeName(name));
  if (path.relative(dir, p).startsWith("..")) throw new Error("Bad file name.");
  return p;
}

// Attachments only come from ClickUp's own file hosts.
const ATTACH_HOST = /^https:\/\/([a-z0-9-]+\.)*(clickup\.com|clickup-attachments\.com|clickupusercontent\.com)\//i;
const MAX_FILE = 30 * 1048576;

// Writes a task's brief (and its files) into <client folder>/tasks/<folder>/.
// files: [{ name, text } | { name, b64 }]; attach: [{ name, url }] fetched here.
// Files already there with the same size are left alone.
async function writeTask(root, links, m, fetchImpl, token) {
  // made: no folder of this client was found, so a new one was made.
  const made = !fs.existsSync(clientDir(root, m.client, links, false));
  const dir = clientDir(root, m.client, links, true);
  const tdir = path.join(dir, "tasks", safeName(m.folder || "task", 80));
  fs.mkdirSync(tdir, { recursive: true });
  fs.writeFileSync(path.join(tdir, "brief.md"), String(m.brief || ""), "utf8");
  const saved = [], failed = [];
  for (const f of Array.isArray(m.files) ? m.files.slice(0, 40) : []) {
    try {
      const buf = f.b64 != null ? Buffer.from(String(f.b64), "base64") : Buffer.from(String(f.text || ""), "utf8");
      if (buf.length > MAX_FILE) { failed.push(f.name); continue; }
      const p = inside(f.toClient ? dir : tdir, f.name);
      if (f.toClient && fs.existsSync(p) && fs.statSync(p).size === buf.length) { saved.push(f.name); continue; }
      fs.writeFileSync(p, buf); saved.push(f.name);
    } catch (e) { failed.push(f && f.name); }
  }
  for (const a of Array.isArray(m.attach) ? m.attach.slice(0, 30) : []) {
    try {
      if (!ATTACH_HOST.test(String(a.url || ""))) { failed.push(a.name); continue; }
      let res = await fetchImpl(a.url);
      if (!res.ok && token) res = await fetchImpl(a.url, { headers: { Authorization: token } });
      if (!res.ok) { failed.push(a.name); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_FILE) { failed.push(a.name); continue; }
      fs.writeFileSync(inside(tdir, a.name), buf); saved.push(a.name);
    } catch (e) { failed.push(a && a.name); }
  }
  return { dir, taskDir: tdir, saved, failed, made };
}

// One client file (from the extension's Clients page) into the client's folder.
function writeClientFile(root, links, m) {
  const dir = clientDir(root, m.client, links, true);
  const buf = Buffer.from(String(m.b64 || ""), "base64");
  if (buf.length > MAX_FILE) throw new Error("File over 30 MB.");
  const p = inside(dir, m.name);
  if (!(fs.existsSync(p) && fs.statSync(p).size === buf.length)) fs.writeFileSync(p, buf);
  return { dir, file: p };
}

// What's already in a client's folder, so the extension shows it and its AI
// reads it instead of keeping a second copy. Skips the task briefs, code
// folders and hidden files; a few levels deep at most.
const SKIP_DIRS = /^(tasks|node_modules|vendor|dist|build|\..*)$/i;
function listClientFiles(root, links, client, max = 300) {
  const dir = clientDir(root, client, links, false);
  if (!fs.existsSync(dir)) return { dir, exists: false, files: [] };
  const files = [];
  const walk = (d, rel, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (files.length >= max) return;
      if (e.name.startsWith(".") || e.name.startsWith("~$")) continue;
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) { if (depth < 3 && !SKIP_DIRS.test(e.name)) walk(path.join(d, e.name), r, depth + 1); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.statSync(path.join(d, e.name)); files.push({ rel: r, name: e.name, size: st.size, mtime: st.mtimeMs }); } catch (x) {}
    }
  };
  walk(dir, "", 0);
  files.sort((a, b) => b.mtime - a.mtime);
  return { dir, exists: true, files };
}
// A file inside the client's folder by its relative path ("audits/x.docx");
// never anything outside it.
function clientFilePath(root, links, client, rel) {
  const dir = clientDir(root, client, links, false);
  const p = path.resolve(dir, String(rel || "").replace(/\\/g, "/"));
  const r = path.relative(dir, p);
  if (!rel || r.startsWith("..") || path.isAbsolute(r)) throw new Error("Not in the client's folder.");
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("That file isn't there any more.");
  return p;
}
function readClientFile(root, links, client, rel) {
  const p = clientFilePath(root, links, client, rel);
  const st = fs.statSync(p);
  if (st.size > MAX_FILE) throw new Error("File over 30 MB.");
  return { name: path.basename(p), size: st.size, mtime: st.mtimeMs, b64: fs.readFileSync(p).toString("base64") };
}

module.exports = { key, safeName, matchFolder, clientDir, writeTask, writeClientFile, inside, listClientFiles, clientFilePath, readClientFile };
