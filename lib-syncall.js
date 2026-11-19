// lib-syncall.js
// -----------------------------------------------------------------------------
// "Sync everything with my other computers" (Drive Sync card, settings.syncEverything).
// The client folders (the taskbar app's folder of client folders) are copied both
// ways through the user's own Google Drive, in a folder they can see:
//   My Drive > Personal ClickUp Manager > Clients > <client folder> > <subfolders>
// Each file there carries appProperties { pcm: "cf", mt: <its modified time> }
// and its path ("<client folder>/<path inside it>") as its description, so one
// search finds them all - no walking folders.
//
// Rules (the owner's choices):
//  - New or changed on one computer -> copied to Drive -> copied to the other.
//  - Deleting a file on one computer never deletes it anywhere else, and it is
//    not brought back to the computer it was deleted on (state.gone).
//  - Changed on BOTH since the last sync: both kept - the other computer's copy
//    arrives as "name (other computer).ext"; nothing is silently overwritten.
//  - Files over 30 MB are skipped (and counted). Each run moves at most
//    RUN_FILES files / RUN_BYTES, so a first big sync spreads over a few runs.
//  - Spare Drive (optional, lib-drivemove.js): when the main Drive is almost
//    full (mainFull), NEW files go to a second Google account's Drive (spare);
//    files already in the main Drive keep updating there, and one the main
//    Drive refuses (full) moves to the spare. Both Drives are listed each run.
// Local state (chrome.storage.local syncAllState):
//   { files: { [key]: { size, mtime, id, md5 } }, gone: { [key]: at }, last: {...} }
// -----------------------------------------------------------------------------

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const MAX_FILE = 30 * 1048576;
const RUN_FILES = 60;
const RUN_BYTES = 300 * 1048576;
const SAME_MS = 2000; // file systems round modified times

function authHeaders(token, extra) { return { Authorization: "Bearer " + token, ...(extra || {}) }; }
async function driveJson(token, url, opts) {
  const res = await fetch(url, { ...(opts || {}), headers: authHeaders(token, (opts && opts.headers) || {}) });
  if (res.status === 401) { const e = new Error("Google sign-in expired - press Sync now to sign in again."); e.auth = true; throw e; }
  if (res.status === 403 || res.status === 507) {
    const t = await res.text().catch(() => "");
    const e = new Error("Google Drive is full or refused it (HTTP " + res.status + ").");
    e.full = res.status === 507 || /storageQuota|quotaExceeded|insufficient.?storage/i.test(t);
    throw e;
  }
  if (!res.ok) throw new Error("Google Drive said HTTP " + res.status + ".");
  return res.json();
}
// A file's path in a form both Windows and Mac accept, compared without case:
// characters Windows refuses (: * ? " < > |) become spaces, no leading / trailing
// dots or spaces, Windows' reserved names get a _ in front, accents in one
// Unicode form (a Mac may store them differently). Same rule in clientdirs.js
// and lib-syncall.js.
function portSeg(s) {
  let n = String(s || "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
  n = n.replace(/^[.\s]+|[.\s]+$/g, "");
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = "_" + n;
  return n || "file";
}
const portKey = (k) => String(k || "").split("/").filter(Boolean).map(portSeg).join("/");
export { portKey };
const mk = (k) => portKey(k).toLowerCase(); // how paths are matched across computers
const qs = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// Every synced file in Drive, newest first per path.
export async function listRemote(token) {
  const out = new Map();
  let page = "";
  for (let i = 0; i < 50; i++) {
    const q = "appProperties has { key='pcm' and value='cf' } and trashed = false";
    const j = await driveJson(token, API + "?pageSize=1000&fields=nextPageToken,files(id,name,size,md5Checksum,modifiedTime,description,appProperties,parents)&q=" + encodeURIComponent(q) + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
    for (const f of j.files || []) {
      const key = String(f.description || "");
      if (!key) continue;
      const rec = { key, id: f.id, size: Number(f.size) || 0, md5: f.md5Checksum || "", mt: Number(f.appProperties && f.appProperties.mt) || Date.parse(f.modifiedTime) || 0, at: Date.parse(f.modifiedTime) || 0, parent: (f.parents || [])[0] || "" };
      const had = out.get(mk(key));
      if (!had || rec.at > had.at) out.set(mk(key), rec);
    }
    page = j.nextPageToken || "";
    if (!page) break;
  }
  return out;
}

// The Drive folder for a path's folders (created when missing), cached per run.
export async function folderFor(token, cache, rootId, parts) {
  let parent = rootId, sofar = "";
  for (const p of parts) {
    sofar += "/" + p;
    if (cache.has(sofar)) { parent = cache.get(sofar); continue; }
    const q = "name = '" + qs(p) + "' and mimeType = 'application/vnd.google-apps.folder' and '" + parent + "' in parents and trashed = false";
    const j = await driveJson(token, API + "?fields=files(id)&q=" + encodeURIComponent(q));
    let id = j.files && j.files[0] && j.files[0].id;
    if (!id) id = (await driveJson(token, API + "?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: p, mimeType: "application/vnd.google-apps.folder", parents: [parent] }) })).id;
    cache.set(sofar, id);
    parent = id;
  }
  return parent;
}
function multipart(meta, blob) {
  const boundary = "pcm" + Math.random().toString(36).slice(2);
  return {
    type: "multipart/related; boundary=" + boundary,
    body: new Blob(["--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + boundary + "\r\nContent-Type: application/octet-stream\r\n\r\n", blob, "\r\n--" + boundary + "--"]),
  };
}
export async function uploadNew(token, parentId, key, name, blob, mtime) {
  const m = multipart({ name, parents: [parentId], description: key, appProperties: { pcm: "cf", mt: String(Math.round(mtime)) } }, blob);
  return driveJson(token, UPLOAD + "?uploadType=multipart&fields=id,md5Checksum", { method: "POST", headers: { "Content-Type": m.type }, body: m.body });
}
async function uploadOver(token, id, blob, mtime) {
  const m = multipart({ appProperties: { pcm: "cf", mt: String(Math.round(mtime)) } }, blob);
  return driveJson(token, UPLOAD + "/" + id + "?uploadType=multipart&fields=id,md5Checksum", { method: "PATCH", headers: { "Content-Type": m.type }, body: m.body });
}
export async function download(token, id) {
  const res = await fetch(API + "/" + id + "?alt=media", { headers: authHeaders(token) });
  if (!res.ok) throw new Error("Couldn't download from Google Drive (HTTP " + res.status + ").");
  return new Uint8Array(await res.arrayBuffer());
}
// Removes a file this extension made (an older copy whose newer version is
// already saved elsewhere) - frees its space at once.
export async function deleteFile(token, id) {
  const res = await fetch(API + "/" + id, { method: "DELETE", headers: authHeaders(token) });
  if (!res.ok && res.status !== 404) throw new Error("Google Drive said HTTP " + res.status + ".");
}
export const ROOT_PARTS = ["Personal ClickUp Manager", "Clients"];
const b64ToBytes = (b64) => { const bin = atob(String(b64 || "")); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
function bytesToB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
// "audits/report.docx" -> "audits/report (conflicted copy 2026-11-18 14.05).docx"
export function conflictKey(key, when) {
  const d = new Date(when || Date.now()), p = (n) => String(n).padStart(2, "0");
  const tag = " (conflicted copy " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "." + p(d.getMinutes()) + ")";
  const i = key.lastIndexOf("/"), dir = key.slice(0, i + 1), name = key.slice(i + 1);
  const dot = name.lastIndexOf(".");
  return dir + (dot > 0 ? name.slice(0, dot) + tag + name.slice(dot) : name + tag);
}

// What to do with one path. L = this computer's file, R = Drive's, S = what the
// last sync saw, gone = deleted on this computer since. Pure, so it is tested.
export function decide(L, R, S, gone) {
  if (gone) return L ? "upload-new-again" : "skip";
  if (L && !R) return L.size > MAX_FILE ? "too-big" : "upload";
  if (!L && R) return S ? "deleted-here" : R.size > MAX_FILE ? "too-big" : "download";
  if (!L && !R) return "skip";
  // Both have it but no sync has seen it yet (copied by hand, say): the same file
  // when size and date match, otherwise keep both.
  if (!S) return L.size === R.size && Math.abs(L.mtime - R.mt) <= SAME_MS ? "same" : L.size > MAX_FILE || R.size > MAX_FILE ? "too-big" : "conflict";
  const lChanged = L.size !== S.size || Math.abs(L.mtime - S.mtime) > SAME_MS;
  const rChanged = R.id !== S.id || (R.md5 && S.md5 ? R.md5 !== S.md5 : R.size !== S.size);
  if (!lChanged && !rChanged) return "same";
  if (lChanged && !rChanged) return L.size > MAX_FILE ? "too-big" : "upload-over";
  if (!lChanged && rChanged) return R.size > MAX_FILE ? "too-big" : "download";
  return L.size > MAX_FILE || R.size > MAX_FILE ? "too-big" : "conflict";
}

// One run. desk(body, ms) talks to the taskbar app; token is a Drive token.
export async function syncClientFolders({ token, desk, get, set, onProgress, account, spare, mainFull }) {
  let st0 = (await get("syncAllState")) || {};
  // Another Google account than last time (moved to a new Drive): start fresh
  // there - its file ids are new; what was deleted here stays deleted here.
  if (account && st0.account && st0.account !== account) st0 = { gone: st0.gone };
  // Paths are matched in their portable lower-case form (older states are re-keyed).
  const rekey = (o) => { const r = {}; for (const [k, v] of Object.entries(o || {})) r[mk(k)] = v; return r; };
  const state = { files: rekey(st0.files), gone: rekey(st0.gone) };
  const ls = await desk({ op: "syncList" }, 30000);
  if (!ls || !ls.ok) return { ok: false, reason: ls ? "app-old" : "no-app", error: ls && ls.error };
  const local = new Map();
  for (const f of ls.files || []) if (!local.has(mk(f.key))) local.set(mk(f.key), f);
  const remote = await listRemote(token);
  const sp = spare && spare.token ? spare : null;
  if (sp) {
    for (const [k, r] of await listRemote(sp.token)) { r.acct = "spare"; const had = remote.get(k); if (!had || r.at > had.at) remote.set(k, r); }
  }
  const tokOf = (acct) => (acct === "spare" && sp ? sp.token : token);
  const caches = { main: new Map(), spare: new Map() }, tops = {};
  const topOf = async (acct) => tops[acct] || (tops[acct] = await folderFor(tokOf(acct), caches[acct], "root", ROOT_PARTS));
  const newAcct = () => (mainFull && sp && !sp.full ? "spare" : "main");
  // A new file in Drive (main, or the spare when the main is full).
  const putNew = async (acct, key, blob, mtime) => {
    const parts = key.split("/"), name = parts.pop();
    const r = await uploadNew(tokOf(acct), await folderFor(tokOf(acct), caches[acct], await topOf(acct), parts), key, name, blob, mtime);
    if (acct === "spare") out.toSpare++;
    return r;
  };
  if (!sp || !mainFull) await topOf("main");
  // Deleted here since the last run: a file the last sync saw locally, now missing here.
  for (const k of Object.keys(state.files)) if (!local.has(k) && !state.gone[k] && state.files[k].local) state.gone[k] = Date.now();
  const keys = [...new Set([...local.keys(), ...remote.keys()])].sort();
  const out = { up: 0, down: 0, conflicts: 0, tooBig: 0, left: 0, errors: 0, firstError: "", toSpare: 0 };
  let files = 0, bytes = 0;
  const save = () => set("syncAllState", { account: account || st0.account || "", files: state.files, gone: state.gone, last: { at: Date.now(), ...out } });
  for (const k of keys) {
    const L = local.get(k), R = remote.get(k), S = state.files[k];
    const key = (L && L.key) || (R && R.key) || k; // the name as this computer / Drive spells it
    let act = decide(L, R, S, !!state.gone[k]);
    if (act === "upload-new-again") { delete state.gone[k]; act = R ? "upload-over" : "upload"; } // made again here
    if (act === "skip" || act === "same") { if (act === "same" && L && R) state.files[k] = { size: L.size, mtime: L.mtime, id: R.id, md5: R.md5, local: true }; continue; }
    if (act === "deleted-here") { state.gone[k] = state.gone[k] || Date.now(); delete state.files[k]; continue; }
    if (act === "too-big") { out.tooBig++; continue; }
    const size = Math.max(L ? L.size : 0, R ? R.size : 0);
    if (files >= RUN_FILES || (bytes + size > RUN_BYTES && files > 0)) { out.left++; continue; }
    files++; bytes += size;
    try {
      if (act === "upload" || act === "upload-over") {
        const rd = await desk({ op: "syncRead", key }, 60000);
        if (!rd || !rd.ok) throw new Error((rd && rd.error) || "the taskbar app didn't read it");
        const blob = new Blob([b64ToBytes(rd.b64)]);
        let r;
        if (act === "upload-over" && R) {
          try { r = await uploadOver(tokOf(R.acct), R.id, blob, L.mtime); }
          catch (e) {
            // The main Drive is full: the newer version goes to the spare and the
            // older copy is removed from the main (that also frees its space).
            if (!(e && e.full) || R.acct === "spare" || !sp || sp.full) throw e;
            r = await putNew("spare", key, blob, L.mtime);
            await deleteFile(token, R.id).catch(() => {});
          }
        } else r = await putNew(newAcct(), key, blob, L.mtime);
        state.files[k] = { size: L.size, mtime: L.mtime, id: r.id, md5: r.md5Checksum || "", local: true };
        out.up++;
      } else if (act === "download") {
        const u8 = await download(tokOf(R.acct), R.id);
        const w = await desk({ op: "syncWrite", key, b64: bytesToB64(u8), mtime: R.mt }, 60000);
        if (!w || !w.ok) throw new Error((w && w.error) || "the taskbar app didn't save it");
        state.files[k] = { size: u8.length, mtime: Number(w.mtime) || R.mt, id: R.id, md5: R.md5, local: true };
        out.down++;
      } else if (act === "conflict") {
        // Changed here AND on the other computer: this computer's version is kept
        // as "name (conflicted copy <date time>)" (here and in Drive), and the
        // shared version stays the main file - so the other computer has nothing
        // to undo, it just gets the copy. Nothing is lost.
        const rd = await desk({ op: "syncRead", key }, 60000);
        if (!rd || !rd.ok) throw new Error((rd && rd.error) || "the taskbar app didn't read it");
        const ck = conflictKey(key);
        const wc = await desk({ op: "syncWrite", key: ck, b64: rd.b64, mtime: L.mtime }, 60000);
        if (!wc || !wc.ok) throw new Error((wc && wc.error) || "the taskbar app didn't save it");
        const u8 = await download(tokOf(R.acct), R.id);
        const w = await desk({ op: "syncWrite", key, b64: bytesToB64(u8), mtime: R.mt }, 60000);
        if (!w || !w.ok) throw new Error((w && w.error) || "the taskbar app didn't save it");
        state.files[k] = { size: u8.length, mtime: Number(w.mtime) || R.mt, id: R.id, md5: R.md5, local: true };
        const up = await putNew(newAcct(), ck, new Blob([b64ToBytes(rd.b64)]), L.mtime);
        state.files[mk(ck)] = { size: L.size, mtime: Number(wc.mtime) || L.mtime, id: up.id, md5: up.md5Checksum || "", local: true };
        out.conflicts++;
      }
    } catch (e) {
      if (e && e.auth) throw e;
      out.errors++;
      if (!out.firstError) out.firstError = key + ": " + String((e && e.message) || e);
    }
    if (onProgress && (out.up + out.down + out.conflicts) % 5 === 0) onProgress(out);
    if ((out.up + out.down + out.conflicts) % 10 === 0) await save();
  }
  await save();
  return { ok: true, ...out, total: local.size };
}
