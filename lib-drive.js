// lib-drive.js
// -----------------------------------------------------------------------------
// OPTIONAL Google Drive sync. The extension works fully without it (status is
// always kept in chrome.storage.local). If you sign in with Google, two things
// are mirrored to a tiny hidden file in your Drive appData folder:
//
//   1. Per-account STATUS (login timestamps, done/pending/needs-attention) so
//      another browser signed in with the same Google account sees today's
//      login is already done.
//
//   2. The encrypted ACCOUNTS blob (username, password, TOTP secret) so you
//      don't have to re-add accounts on a new machine. The accounts are
//      encrypted with an AES key that is ALSO stored in Drive (in a separate
//      hidden file). This is OBFUSCATION across machines, not real security -
//      anyone with read access to your Drive appData can recover them. Same
//      threat model as the local at-rest obfuscation; documented in the README.
//
// This only ever touches the extension's own hidden appDataFolder files - it
// cannot see or modify any of your real Drive files.
// -----------------------------------------------------------------------------

// Google OAuth client ID from your Google Cloud project (for Drive sync only).
export const GOOGLE_CLIENT_ID =
  "580516811198-4bmkp6engsi6bbousfip7g5lrqstfnie.apps.googleusercontent.com";

const SCOPE = "https://www.googleapis.com/auth/drive.appdata";
const STATE_FILENAME = "daily-login-state.json";
const ACCOUNTS_FILENAME = "daily-login-accounts.json";
const KEY_FILENAME = "daily-login-key.json";

function buildAuthUrl({ prompt = "", scope = SCOPE, loginHint = "" } = {}) {
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: "token",
    redirect_uri: redirectUri,
    scope,
  });
  if (prompt) params.set("prompt", prompt);
  // Which account to renew for. Without it, a browser signed into several Google
  // accounts can't refresh silently ("account selection required") and the user
  // looks signed out every hour.
  if (loginHint) params.set("login_hint", loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function launchAuth({ interactive = false, prompt = "", scope = SCOPE, loginHint = "" } = {}) {
  try {
    const redirectedTo = await chrome.identity.launchWebAuthFlow({
      url: buildAuthUrl({ prompt, scope, loginHint }),
      interactive,
    });
    const hash = new URL(redirectedTo).hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
    return token ? { token, expiresIn } : null;
  } catch (e) {
    return null;
  }
}

// ---------- "create files in Drive" (export to Google Sheets / Docs) ----------
// Kept apart from the sync scope above: the extension only asks for it the first
// time someone exports, and the sync token is untouched.
const SCOPE_FILE = "https://www.googleapis.com/auth/drive.file";
export async function getFileToken(interactive = true) {
  const now = Date.now();
  const { driveFileToken: c } = await chrome.storage.local.get("driveFileToken");
  if (c && c.token && c.expiresAt > now + 60000) return c.token;
  let r = await launchAuth({ interactive: false, scope: SCOPE_FILE });
  if (!r && interactive) r = await launchAuth({ interactive: true, scope: SCOPE_FILE });
  if (!r || !r.token) return null;
  await chrome.storage.local.set({ driveFileToken: { token: r.token, expiresAt: now + (r.expiresIn - 60) * 1000 } });
  return r.token;
}
// Upload an HTML table and let Drive convert it into a Google Sheet / Doc,
// which keeps the bold "main" rows and the header row.
export async function createGoogleFile(token, { name, html, csv, kind }) {
  // Drive imports HTML as a DOC only; Sheets accepts csv/tsv/xls(x)/ods. Sending
  // HTML with a spreadsheet target produced an empty Google Doc, so each target
  // gets the source format it actually supports.
  const docs = kind === "docs";
  const mimeType = docs ? "application/vnd.google-apps.document" : "application/vnd.google-apps.spreadsheet";
  const srcType = docs ? "text/html" : "text/csv";
  const content = docs ? html : csv;
  if (!content) throw new Error("Nothing to export.");
  const boundary = "pcm" + Math.random().toString(36).slice(2);
  const body =
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" +
    JSON.stringify({ name, mimeType }) + "\r\n" +
    "--" + boundary + "\r\nContent-Type: " + srcType + "; charset=UTF-8\r\n\r\n" +
    content + "\r\n--" + boundary + "--";
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,mimeType", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  });
  if (res.status === 401) {
    await chrome.storage.local.remove("driveFileToken");
    throw new Error("Google sign-in expired - try the export again.");
  }
  if (!res.ok) throw new Error("Google Drive refused the file (HTTP " + res.status + ").");
  const j = await res.json();
  const id = j && j.id;
  if (!id) throw new Error("Google Drive returned no file id.");
  if (j.mimeType && j.mimeType !== mimeType) {
    throw new Error("Google Drive created a " + (j.mimeType.includes("document") ? "Doc" : j.mimeType) + " instead - try the other format.");
  }
  return { id, url: (j && j.webViewLink) || (docs ? "https://docs.google.com/document/d/" : "https://docs.google.com/spreadsheets/d/") + id + "/edit" };
}

// Cached token so we don't re-auth on every check.
// Two-tier cache:
//  1. In-memory (this service-worker session)
//  2. chrome.storage.local (persists across restarts)
// If the cached token is expired or rejected, try silent re-auth first
// (prompt=none) before bothering the user with an interactive prompt.
let lastSilentFailAt = 0;
let memToken = null;
let memTokenExpiresAt = 0;

export async function getValidToken(allowInteractive) {
  const now = Date.now();

  // 1. In-memory
  if (memToken && memTokenExpiresAt > now + 60000) return memToken;

  // 2. chrome.storage.local
  const { authCache } = await chrome.storage.local.get("authCache");
  if (authCache && authCache.accessToken && authCache.expiresAt > now + 60000) {
    memToken = authCache.accessToken;
    memTokenExpiresAt = authCache.expiresAt;
    return memToken;
  }

  // A silent attempt that just failed is not worth repeating on every poll.
  if (!allowInteractive && Date.now() - lastSilentFailAt < 60000) return null;
  // 3. Silent re-auth, naming the account that was connected (see login_hint).
  const hint = await getDriveAccount();
  let result = await launchAuth({ interactive: false, prompt: "none", loginHint: hint });
  if (!result && hint) result = await launchAuth({ interactive: false, prompt: "none" }); // stale hint
  // 4. Last resort: interactive (only if caller allows it)
  if (!result && allowInteractive) result = await launchAuth({ interactive: true, loginHint: hint });
  if (!result) { lastSilentFailAt = Date.now(); return null; }
  lastSilentFailAt = 0;

  const expiresAt = now + result.expiresIn * 1000;
  memToken = result.token;
  memTokenExpiresAt = expiresAt;
  await chrome.storage.local.set({
    authCache: { accessToken: result.token, expiresAt },
  });
  rememberDriveAccount(result.token).catch(() => {});
  return result.token;
}

// The connected Google account's email, used as login_hint above. Looked up once
// (Drive's own "about" endpoint, no extra scope) and kept until sign-out.
export async function getDriveAccount() {
  const { driveAccount } = await chrome.storage.local.get("driveAccount");
  return (driveAccount && driveAccount.email) || "";
}
async function rememberDriveAccount(token) {
  if (await getDriveAccount()) return;
  try {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress,displayName)", {
      headers: { Authorization: "Bearer " + token },
    });
    if (!res.ok) return;
    const j = await res.json();
    const email = j && j.user && j.user.emailAddress;
    if (email) await chrome.storage.local.set({ driveAccount: { email, name: (j.user && j.user.displayName) || "" } });
  } catch (e) {}
}

// Invalidate the cached token WITHOUT revoking the grant. Used to self-heal a
// rejected/expired token: we drop it so the next getValidToken() silently
// re-mints one (the grant is still valid, so prompt=none succeeds). This is the
// key to NOT having to re-sign-in every hour - an expired implicit-flow token
// no longer bricks sync; it just triggers a silent refresh.
export function invalidateToken() {
  memToken = null;
  memTokenExpiresAt = 0;
  return chrome.storage.local.remove("authCache");
}

// Clear both in-memory and persisted tokens. Also tell Google's authorization
// server to forget the grant so a re-sign-in is required.
export async function signOut() {
  await chrome.storage.local.remove(["driveAccount", "driveFileToken"]);
  // Read the cached token BEFORE clearing it, so the server-side revoke can run
  // (previously we removed authCache first, so the revoke never had a token).
  let cachedToken = memToken;
  try {
    const { authCache } = await chrome.storage.local.get("authCache");
    if (authCache && authCache.accessToken) cachedToken = authCache.accessToken;
  } catch (e) {}
  memToken = null;
  memTokenExpiresAt = 0;
  await chrome.storage.local.remove("authCache");
  // Best-effort: revoke the grant server-side.
  try {
    if (cachedToken) {
      await fetch(
        `https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(cachedToken)}`,
        { method: "GET", mode: "no-cors" }
      );
    }
  } catch (e) {}
}

async function driveFetch(path, token, options = {}, _retried = false) {
  const res = await fetch(`https://www.googleapis.com${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    // 401/403 = the token was rejected (expired or revoked mid-flight). Drop the
    // cached token and silently re-mint one, then retry ONCE. This means a token
    // that expired between operations self-heals instead of surfacing as "Drive
    // sync off" and forcing a manual sign-in.
    if ((res.status === 401 || res.status === 403) && !_retried) {
      await invalidateToken();
      const fresh = await getValidToken(false);
      if (fresh) return driveFetch(path, fresh, options, true);
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Drive API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function findFileId(token, name) {
  const res = await driveFetch(
    `/drive/v3/files?spaces=appDataFolder&q=name='${name}'&fields=files(id)`,
    token
  );
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function readFile(token, name) {
  const id = await findFileId(token, name);
  if (!id) return null;
  const res = await driveFetch(`/drive/v3/files/${id}?alt=media`, token);
  return await res.json().catch(() => null);
}

async function writeFile(token, name, body) {
  const id = await findFileId(token, name);
  if (id) {
    await driveFetch(`/upload/drive/v3/files/${id}?uploadType=media`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return id;
  }
  const metadata = { name, parents: ["appDataFolder"] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([JSON.stringify(body)], { type: "application/json" }));
  await driveFetch(`/upload/drive/v3/files?uploadType=multipart`, token, {
    method: "POST",
    body: form,
  });
  return null;
}

// True if we currently hold (or can silently get) a Google token.
export async function isSignedIn() {
  const token = await getValidToken(false);
  return !!token;
}

// ---------- KEY (used to encrypt accounts) ----------
// We store an AES-GCM key in Drive as raw base64. Anyone with read access to
// the Drive appData folder can recover it, so this is OBFUSCATION, not security.
// This is consistent with the README's threat model.
async function getOrCreateDriveKey(token) {
  const existing = await readFile(token, KEY_FILENAME);
  if (existing && existing.keyB64) {
    return existing.keyB64;
  }
  // Create a new 256-bit AES key, base64-encoded.
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (let i = 0; i < keyBytes.length; i++) bin += String.fromCharCode(keyBytes[i]);
  const keyB64 = btoa(bin);
  await writeFile(token, KEY_FILENAME, { keyB64, createdAt: Date.now() });
  return keyB64;
}

async function importKeyB64(keyB64) {
  const bin = atob(keyB64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// ---------- ACCOUNTS (encrypted) ----------
// Format on Drive: { v: 5, iv: <b64>, data: <b64>, updatedAt: <ms> }
// v5 payload: { accounts: [...], clickup: {...}|null, departments: [...]|null,
//               settings: {...}|null, settingsAt: <ms> }
//   - settings carries ALL user prefs (target hours, deadline task URLs,
//     notification toggles, Agent Router URL, ClickUp prefs, departments) so a
//     new machine / reinstall restores everything, not just credentials.
//   - settingsAt is settings._updatedAt so the puller can tell whose settings
//     are newer and avoid clobbering fresh local changes with a stale remote.
// (v4 blobs stored accounts+clickup+departments; v3 accounts+clickup; v2 just
// the accounts array - pull still reads all of them.)
export async function pushAccountsToDrive(token, accounts, clickup = null, departments = null, settings = null, extras = null) {
  const keyB64 = await getOrCreateDriveKey(token);
  const key = await importKeyB64(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const settingsAt = settings && Number(settings._updatedAt) ? Number(settings._updatedAt) : 0;
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      accounts: accounts || [],
      clickup: clickup || null,
      departments: departments || null,
      settings: settings || null,
      settingsAt,
      extras: extras || null, // { values: {key: value}, stamps: {key: ms} } - site list, theme, filters, sounds
    })
  );
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const toB64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  };
  await writeFile(token, ACCOUNTS_FILENAME, {
    v: 5,
    iv: toB64(iv),
    data: toB64(new Uint8Array(ct)),
    updatedAt: Date.now(),
  });
}

export async function pullAccountsFromDrive(token) {
  const blob = await readFile(token, ACCOUNTS_FILENAME);
  if (!blob || !blob.data || !blob.iv) return null;
  // The AES key lives in Drive too - read it.
  const keyBlob = await readFile(token, KEY_FILENAME);
  if (!keyBlob || !keyBlob.keyB64) return null;
  const key = await importKeyB64(keyBlob.keyB64);
  const fromB64 = (s) => {
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromB64(blob.iv) },
      key,
      fromB64(blob.data)
    );
    const arr = JSON.parse(new TextDecoder().decode(pt));
    if (Array.isArray(arr)) {
      // v2 blob: just the accounts array.
      return { accounts: arr, clickup: null, departments: null, settings: null, settingsAt: 0, updatedAt: blob.updatedAt || 0 };
    }
    return {
      accounts: Array.isArray(arr.accounts) ? arr.accounts : [],
      clickup: arr.clickup || null,
      departments: Array.isArray(arr.departments) ? arr.departments : null,
      settings: arr.settings && typeof arr.settings === "object" ? arr.settings : null,
      settingsAt: Number(arr.settingsAt) || 0,
      extras: arr.extras && typeof arr.extras === "object" ? arr.extras : null,
      updatedAt: blob.updatedAt || 0,
    };
  } catch (e) {
    return null;
  }
}

// ---------- STATUS (clear JSON, just timestamps) ----------
export async function readRemoteState(token) {
  const blob = await readFile(token, STATE_FILENAME);
  return blob ? blob.accounts || {} : {};
}

export async function writeRemoteState(token, statusByAccount) {
  await writeFile(token, STATE_FILENAME, {
    version: 4,
    accounts: statusByAccount || {},
    updatedAt: Date.now(),
  });
}

// The Agent Router $25 daily credit is earned once per rolling 24h window, at the
// FIRST successful login of that window. `lastDoneAt` is that earning checkpoint;
// `lastRunAt` is merely the most recent attempt. A naive "newest lastRunAt wins"
// merge loses the checkpoint the moment a new machine (or a reinstall) does a
// fresh Run - its later lastRunAt outranks the good remote record and the real
// credit time is overwritten. So merge the two concerns SEPARATELY.
const RESET_MS = 24 * 3600000;
function doneAtOf(r) {
  if (!r) return 0;
  if (r.lastDoneAt) return r.lastDoneAt;
  if (r.lastDone && r.lastRunAt) return r.lastRunAt; // legacy records w/o lastDoneAt
  return 0;
}
// Merge two status records for the SAME account (order-agnostic):
//  - activity fields (lastRunAt/lastResult/note): newest lastRunAt wins.
//  - checkpoint fields (lastDone/lastDoneAt): if both sides were credited within
//    the same 24h window, keep the EARLIER checkpoint (the true first-login time);
//    across different windows, keep the later window's credit.
function mergeStatusRec(a, b) {
  if (!a) return b;
  if (!b) return a;
  const newest = (a.lastRunAt || 0) >= (b.lastRunAt || 0) ? a : b;
  const merged = { ...newest };
  const da = doneAtOf(a);
  const db = doneAtOf(b);
  if (da && db) {
    if (Math.abs(da - db) < RESET_MS) {
      const earlier = da <= db ? a : b; // same window -> earliest credit is the checkpoint
      merged.lastDone = earlier.lastDone;
      merged.lastDoneAt = doneAtOf(earlier);
    } else {
      const later = da >= db ? a : b; // different windows -> newest credit
      merged.lastDone = later.lastDone;
      merged.lastDoneAt = doneAtOf(later);
    }
  } else if (da || db) {
    const only = da ? a : b;
    merged.lastDone = only.lastDone;
    merged.lastDoneAt = doneAtOf(only);
  }
  return merged;
}

// Best-effort mirror of local status to Drive. Silent (won't prompt). Merges
// local status onto whatever is in Drive, preserving each account's earning
// checkpoint (see mergeStatusRec).
export async function mirrorToDrive(localStatus) {
  const token = await getValidToken(false);
  if (!token) return { ok: false, reason: "not signed in" };
  try {
    const remoteStatus = await readRemoteState(token);
    const merged = { ...remoteStatus };
    for (const [id, rec] of Object.entries(localStatus || {})) {
      merged[id] = mergeStatusRec(rec, merged[id]);
    }
    await writeRemoteState(token, merged);
    return { ok: true, statusByAccount: merged };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

// Pull remote status and merge into local, preserving each account's earning
// checkpoint (see mergeStatusRec). Used to hydrate a fresh install / new browser
// with the real credit time BEFORE the first Run, so a manual Run isn't mistaken
// for a first-time login and doesn't move the checkpoint.
export async function pullFromDrive(localStatus) {
  const token = await getValidToken(false);
  if (!token) return { ok: false, reason: "not signed in", status: localStatus };
  try {
    const remoteStatus = await readRemoteState(token);
    const merged = { ...(localStatus || {}) };
    for (const [id, rec] of Object.entries(remoteStatus || {})) {
      merged[id] = mergeStatusRec(merged[id], rec);
    }
    return { ok: true, status: merged };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e), status: localStatus };
  }
}
