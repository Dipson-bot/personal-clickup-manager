// lib-drivemove.js
// -----------------------------------------------------------------------------
// Drive Sync with two Google accounts (Options > General > Drive Sync):
//
//  1. Move everything to another Google account (driveMoveJob). Copies, from the
//     old account's Drive to the new one's:
//       - every file in the hidden app data (accounts, the key that unlocks them,
//         status, settings, history, saved files) - phase "appdata";
//       - every client-folder file (My Drive > Personal ClickUp Manager > Clients)
//         with its folders and dates - phase "files", a part per step;
//     then the background switches Drive Sync to the new account ("switch"),
//     leaves a small "moved to <email>" note in the old hidden app data (the
//     other computer follows it), and - only if the person ticked it - moves the
//     old client-folder copies to the old Drive's trash ("trash").
//  2. Spare Drive: lib-syncall.js puts new client-folder files in a second
//     account's Drive when the main one is almost full (the background passes it).
//
// Everything here takes tokens; signing in is lib-drive.js's job.
// -----------------------------------------------------------------------------

import { listRemote, folderFor, uploadNew, download, ROOT_PARTS } from "./lib-syncall.js";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
export const MOVED_NAME = "pcm-moved.json";
const STEP_FILES = 40;
const STEP_BYTES = 200 * 1048576;
const STEP_TRASH = 100;

async function dj(token, url, opts) {
  const res = await fetch(url, { ...(opts || {}), headers: { Authorization: "Bearer " + token, ...((opts && opts.headers) || {}) } });
  if (res.status === 401) { const e = new Error("Google sign-in expired."); e.auth = true; throw e; }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const e = new Error(/storageQuota|quotaExceeded|insufficient.?storage/i.test(t) || res.status === 507 ? "The new Google Drive is full." : "Google Drive said HTTP " + res.status + ".");
    e.full = /storageQuota|quotaExceeded|insufficient.?storage/i.test(t) || res.status === 507;
    throw e;
  }
  return res.status === 204 ? {} : res.json().catch(() => ({}));
}

// How full a Drive is (any token with a Drive scope). Free bytes, or Infinity.
export async function driveFree(token) {
  const j = await dj(token, "https://www.googleapis.com/drive/v3/about?fields=storageQuota(limit,usage)");
  const q = (j && j.storageQuota) || {};
  const limit = Number(q.limit) || 0, usage = Number(q.usage) || 0;
  return { limit, usage, free: limit ? Math.max(0, limit - usage) : Infinity };
}

// ---------- the hidden app data ----------
export async function listAppData(token) {
  const out = [];
  let page = "";
  for (let i = 0; i < 20; i++) {
    const j = await dj(token, API + "?spaces=appDataFolder&pageSize=200&fields=nextPageToken,files(id,name,size)" + (page ? "&pageToken=" + encodeURIComponent(page) : ""));
    for (const f of j.files || []) out.push({ id: f.id, name: f.name, size: Number(f.size) || 0 });
    page = j.nextPageToken || "";
    if (!page) break;
  }
  return out;
}
async function readRaw(token, id) {
  const res = await fetch(API + "/" + id + "?alt=media", { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error("Couldn't read from Google Drive (HTTP " + res.status + ").");
  return new Uint8Array(await res.arrayBuffer());
}
function multipart(meta, blob) {
  const boundary = "pcm" + Math.random().toString(36).slice(2);
  return {
    type: "multipart/related; boundary=" + boundary,
    body: new Blob(["--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n--" + boundary + "\r\nContent-Type: application/octet-stream\r\n\r\n", blob, "\r\n--" + boundary + "--"]),
  };
}
// Write one app-data file by name (replacing one of the same name).
async function putAppData(token, name, bytes, existingId) {
  if (existingId) {
    const m = multipart({}, new Blob([bytes]));
    return dj(token, UPLOAD + "/" + existingId + "?uploadType=multipart&fields=id", { method: "PATCH", headers: { "Content-Type": m.type }, body: m.body });
  }
  const m = multipart({ name, parents: ["appDataFolder"] }, new Blob([bytes]));
  return dj(token, UPLOAD + "?uploadType=multipart&fields=id", { method: "POST", headers: { "Content-Type": m.type }, body: m.body });
}

// The "moved to" note left in the old account's hidden app data.
export async function readMoved(token) {
  const f = (await listAppData(token)).find((x) => x.name === MOVED_NAME);
  if (!f) return null;
  try { return JSON.parse(new TextDecoder().decode(await readRaw(token, f.id))); } catch (e) { return null; }
}
export async function writeMoved(token, note) {
  const f = (await listAppData(token)).find((x) => x.name === MOVED_NAME);
  await putAppData(token, MOVED_NAME, new TextEncoder().encode(JSON.stringify(note)), f && f.id);
}

// What a move job looks like at the start.
export function newMoveJob({ from, to, toName, trashOld }) {
  return { from, to, toName: toName || "", trashOld: !!trashOld, state: "running", phase: "appdata", startedAt: Date.now(),
    app: 0, total: 0, copied: 0, same: 0, bytes: 0, trashed: 0, map: {}, failed: {}, firstError: "", msg: "" };
}

// One step of a move. fromApp / fromFile: the OLD account's tokens (hidden app
// data / visible files); to: the NEW account's token (both). Returns the job,
// changed; the caller saves it and calls again until phase is "switch" (then
// switches the account itself), "trash" (call again with the old file token)
// or "done".
export async function moveStep({ fromApp, fromFile, to, job }) {
  job = { ...job, map: { ...(job.map || {}) }, failed: { ...(job.failed || {}) } };
  if (job.phase === "appdata") {
    const src = await listAppData(fromApp), dst = await listAppData(to);
    const there = new Map(dst.map((f) => [f.name, f.id]));
    let n = 0;
    for (const f of src) {
      if (f.name === MOVED_NAME) continue; // the old account's own note stays there
      await putAppData(to, f.name, await readRaw(fromApp, f.id), there.get(f.name));
      n++;
    }
    // A "moved away" note in the NEW account (it was moved from before) is old news.
    const stale = there.get(MOVED_NAME);
    if (stale) await dj(to, API + "/" + stale, { method: "DELETE" }).catch(() => {});
    job.app = n;
    job.phase = "files";
    return job;
  }
  if (job.phase === "files") {
    const src = await listRemote(fromFile), dst = await listRemote(to);
    job.total = src.size;
    const caches = new Map();
    let top = "", files = 0, bytes = 0;
    for (const [key, R] of src) {
      if (job.map[R.id] || job.failed[key]) continue;
      if (files >= STEP_FILES || (files > 0 && bytes + R.size > STEP_BYTES)) return job; // the rest next step
      const D = dst.get(key);
      if (D && D.md5 && D.md5 === R.md5) { job.map[R.id] = { id: D.id, md5: D.md5 }; job.same++; continue; }
      files++; bytes += R.size;
      try {
        if (!top) top = await folderFor(to, caches, "root", ROOT_PARTS);
        const parts = key.split("/"), name = parts.pop();
        const u8 = await download(fromFile, R.id);
        const up = await uploadNew(to, await folderFor(to, caches, top, parts), key, name, new Blob([u8]), R.mt);
        job.map[R.id] = { id: up.id, md5: up.md5Checksum || R.md5 };
        job.copied++; job.bytes += R.size;
      } catch (e) {
        if (e && (e.auth || e.full)) throw e;
        job.failed[key] = String((e && e.message) || e).slice(0, 160);
        if (!job.firstError) job.firstError = key + ": " + job.failed[key];
      }
    }
    job.phase = "switch";
    return job;
  }
  if (job.phase === "trash") {
    // Only the copies that are safely in the new Drive; to the TRASH (Google
    // empties it after 30 days; emptying it sooner frees the space now).
    const ids = Object.keys(job.map).filter((id) => !(job.trashedIds || {})[id]);
    job.trashedIds = { ...(job.trashedIds || {}) };
    for (const id of ids.slice(0, STEP_TRASH)) {
      let ok = true;
      await dj(fromFile, API + "/" + id + "?fields=id", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) }).catch((e) => { if (e && e.auth) throw e; ok = false; });
      job.trashedIds[id] = 1; if (ok) job.trashed++;
    }
    if (ids.length <= STEP_TRASH) job.phase = "done";
    return job;
  }
  return job;
}

// The client-folder sync's memory, pointed at the new account's copies, so the
// first sync there moves nothing (a copy that failed is simply looked at again).
export function remapSyncState(st, job) {
  if (!st || !st.files) return st;
  const byOld = job.map || {}, files = {};
  for (const [k, f] of Object.entries(st.files)) {
    const m = byOld[f.id];
    if (m) files[k] = { ...f, id: m.id, md5: m.md5 || f.md5 };
  }
  return { ...st, account: job.to, files };
}
