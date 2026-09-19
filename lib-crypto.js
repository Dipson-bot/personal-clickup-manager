// lib-crypto.js
// -----------------------------------------------------------------------------
// Two things live here:
//   1. TOTP generation (RFC 6238 / RFC 4226) so the extension can produce the
//      6-digit authenticator code for a GitHub account from its stored secret.
//   2. At-rest obfuscation of stored credentials using AES-GCM.
//
// IMPORTANT SECURITY NOTE (read this):
//   For the extension to log in unattended, it must be able to decrypt your
//   credentials by itself, with no password from you. That means the AES key
//   is stored right next to the data (in chrome.storage.local). This is
//   OBFUSCATION, not real security: anyone with access to this browser profile
//   on this machine can recover the passwords and TOTP secrets. Treat these
//   accounts accordingly (don't reuse important passwords).
// -----------------------------------------------------------------------------

const KEY_STORAGE = "encKeyRaw"; // base64 of the raw AES-256 key

// ---------- base64 <-> bytes ----------
function bytesToB64(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- base32 decode (for TOTP secrets) ----------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Decode(input) {
  const clean = String(input || "")
    .toUpperCase()
    .replace(/=+$/, "")
    .replace(/[\s-]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

// ---------- TOTP ----------
// Returns the current code as a zero-padded string, e.g. "004213".
export async function generateTOTP(secretBase32, opts = {}) {
  const digits = opts.digits || 6;
  const period = opts.period || 30;
  const at = opts.timestamp ? Math.floor(opts.timestamp / 1000) : Math.floor(Date.now() / 1000);
  const counter = Math.floor(at / period);

  const keyBytes = base32Decode(secretBase32);
  if (keyBytes.length === 0) throw new Error("Empty TOTP secret");

  // 8-byte big-endian counter
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c = Math.floor(c / 256);
  }

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, msg));

  const offset = sig[sig.length - 1] & 0x0f;
  const binary =
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff);
  const otp = binary % Math.pow(10, digits);
  return String(otp).padStart(digits, "0");
}

// Seconds remaining in the current TOTP window (useful to avoid submitting a
// code that's about to expire).
export function totpSecondsRemaining(period = 30) {
  return period - (Math.floor(Date.now() / 1000) % period);
}

// ---------- AES-GCM at-rest obfuscation ----------
async function getKey() {
  const store = await chrome.storage.local.get(KEY_STORAGE);
  let rawB64 = store[KEY_STORAGE];
  if (!rawB64) {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    const raw = await crypto.subtle.exportKey("raw", key);
    rawB64 = bytesToB64(raw);
    await chrome.storage.local.set({ [KEY_STORAGE]: rawB64 });
    return key;
  }
  return crypto.subtle.importKey("raw", b64ToBytes(rawB64), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

// Encrypts any JSON-serializable value -> { iv, data } (both base64 strings).
export async function encryptJSON(obj) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return { iv: bytesToB64(iv), data: bytesToB64(ct) };
}

// Reverses encryptJSON. Returns the original value, or `fallback` on failure.
export async function decryptJSON(blob, fallback = null) {
  try {
    if (!blob || !blob.iv || !blob.data) return fallback;
    const key = await getKey();
    const iv = b64ToBytes(blob.iv);
    const ct = b64ToBytes(blob.data);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch (e) {
    return fallback;
  }
}

// ---------- passphrase-based encryption (for backup export / import) ----------
// Unlike the at-rest obfuscation above (key stored beside the data), this derives
// the AES key from a passphrase the USER supplies via PBKDF2. The key is never
// stored, so a backup file is only as recoverable as the passphrase - safe to
// move between machines. Used for Backup & restore, NOT for unattended login.
const PBKDF2_ITERATIONS = 210000;

async function derivePassphraseKey(passphrase, salt, iterations, hash, usages) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(String(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    usages
  );
}

// Encrypt any JSON value with a passphrase -> a self-describing backup object.
export async function encryptWithPassphrase(obj, passphrase) {
  if (!passphrase || String(passphrase).length < 6)
    throw new Error("Passphrase must be at least 6 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePassphraseKey(passphrase, salt, PBKDF2_ITERATIONS, "SHA-256", ["encrypt"]);
  const pt = new TextEncoder().encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  return {
    app: "daily-login-extension",
    type: "backup",
    v: 1,
    createdAt: new Date().toISOString(),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: bytesToB64(salt) },
    cipher: "AES-GCM",
    iv: bytesToB64(iv),
    data: bytesToB64(ct),
  };
}

// Reverse encryptWithPassphrase. Throws a clear error on a bad passphrase /
// corrupted or foreign file (so the UI can tell the user what went wrong).
export async function decryptWithPassphrase(payload, passphrase) {
  if (!payload || payload.cipher !== "AES-GCM" || !payload.kdf || !payload.iv || !payload.data)
    throw new Error("This file isn't a Daily Login backup.");
  const salt = b64ToBytes(payload.kdf.salt);
  const iv = b64ToBytes(payload.iv);
  const iterations = payload.kdf.iterations || PBKDF2_ITERATIONS;
  const hash = payload.kdf.hash || "SHA-256";
  const key = await derivePassphraseKey(passphrase, salt, iterations, hash, ["decrypt"]);
  let pt;
  try {
    pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64ToBytes(payload.data));
  } catch (e) {
    throw new Error("Wrong passphrase, or the backup file is corrupted.");
  }
  return JSON.parse(new TextDecoder().decode(pt));
}
