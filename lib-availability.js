// lib-availability.js
// -----------------------------------------------------------------------------
// Active availability probe for Agent Router (a new-api LLM gateway). Answers the
// question the leftover *balance* can't: "will a Claude relay call actually go
// through right now, or is this account in a 'blocked till the next quota window'
// state despite a positive balance?" That block only surfaces on a real relay
// call, so we make the smallest possible one.
//
// Auth reuses the per-account session creds already captured at login
// (arToken + arId) - the same pair pollBalancesInBackground replays. Management
// (/api/*) calls send them as "New-API-User" + "Authorization: Bearer"; relay
// (/v1/*) calls use a minted/reused sk- token key.
//
// SAFETY CONTRACT (relied on by background.js):
//   * Reuse an existing token by default; only create one when allowCreate=true
//     (a user-initiated "Enable" click) - never a silent write to the account.
//   * Probe with the smallest request (max_tokens tiny); when the account is
//     blocked the gateway rejects it pre-billing, so it costs ~nothing.
//   * EVERY failure path degrades to { ok: null } ("Unknown"). We never return a
//     false ok:true, so the UI can never show a misleading "Available".
//
// new-api specifics confirmed against QuantumNous/new-api:
//   GET  /api/token/            -> list (keys are MASKED here; gives id + status)
//   POST /api/token/:id/key     -> full key (rate-limited; needs POST)
//   POST /api/token/            -> create (returns {success,message}, NO key)
//   stored keys omit the "sk-" prefix; relay clients add it.
// Any deployment drift is caught by the ok:null fallback rather than crashing.
// -----------------------------------------------------------------------------

const AR = "https://agentrouter.org";

// Session-token auth for the management API (mirrors pollBalancesInBackground).
function authHeaders(auth) {
  return {
    "New-API-User": String(auth.arId),
    Authorization: "Bearer " + auth.arToken,
  };
}

// Resolve a usable relay key for this account. Reuse-first: list existing tokens,
// pick an enabled one (preferring our own "arr-ext-probe"), and read its full key.
// Only mint a new token when allowCreate is set. Returns { key, tokenId } on
// success (key always sk-prefixed) or { key: null, reason } otherwise.
export async function resolveRelayKey(auth, opts) {
  const allowCreate = !!(opts && opts.allowCreate);
  if (auth == null || auth.arId == null || !auth.arToken) return { key: null, reason: "no-session" };
  try {
    let picked = await findEnabledToken(auth);
    if (picked == null && allowCreate) {
      await createProbeToken(auth);
      picked = await findEnabledToken(auth);
      if (picked == null) return { key: null, reason: "create-failed" };
    }
    if (picked == null) return { key: null, reason: "no-key" };
    // Older new-api returns the full key right in the list; newer versions mask
    // it and only hand out the real one via POST /api/token/:id/key. Use the
    // listed key when it's usable, otherwise fetch it.
    let raw = isUsableKey(picked.key) ? picked.key : await fetchFullKey(auth, picked.id);
    if (!raw) return { key: null, reason: "key-unreadable" };
    return { key: raw.startsWith("sk-") ? raw : "sk-" + raw, tokenId: picked.id };
  } catch (e) {
    return { key: null, reason: "resolve-error" };
  }
}

// A key is usable as-is only if it's a plausibly full secret - masked keys carry
// a '*'/'…' placeholder and short forms aren't real keys.
function isUsableKey(k) {
  if (typeof k !== "string") return false;
  const body = k.replace(/^sk-/, "").trim();
  return body.length >= 16 && !/[*…]/.test(body);
}

// GET /api/token/ -> newest enabled token { id, key }. Tolerates the several
// list-envelope shapes new-api has shipped (data array, data.items, data.records).
async function findEnabledToken(auth) {
  const r = await fetch(AR + "/api/token/?p=0&size=100", {
    method: "GET",
    credentials: "include",
    headers: authHeaders(auth),
  });
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  const list = extractList(j);
  if (!Array.isArray(list) || !list.length) return null;
  // status 1 = enabled in new-api; treat a missing status as usable too.
  const enabled = list.filter((t) => t && t.id != null && (t.status === 1 || t.status == null));
  if (!enabled.length) return null;
  const mine = enabled.find((t) => (t.name || "") === "arr-ext-probe");
  const pick = mine || enabled[0];
  return pick && pick.id != null ? { id: pick.id, key: pick.key || pick.Key || "" } : null;
}

function extractList(j) {
  if (!j) return null;
  if (Array.isArray(j.data)) return j.data;
  if (j.data && Array.isArray(j.data.items)) return j.data.items;
  if (j.data && Array.isArray(j.data.records)) return j.data.records;
  if (Array.isArray(j.items)) return j.items;
  if (Array.isArray(j)) return j;
  return null;
}

// POST /api/token/:id/key -> the full (unmasked) key. new-api returns it either as
// a bare string in `data` or as { key }/{ token } - handle both.
async function fetchFullKey(auth, id) {
  const r = await fetch(AR + "/api/token/" + id + "/key", {
    method: "POST",
    credentials: "include",
    headers: authHeaders(auth),
  });
  if (!r || !r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j) return null;
  const d = j.data != null ? j.data : j;
  if (typeof d === "string" && d.trim()) return d.trim();
  if (d && typeof d === "object") {
    const k = d.key || d.token || d.Key || "";
    return k && String(k).trim() ? String(k).trim() : null;
  }
  return null;
}

// POST /api/token/ -> mint an unlimited, non-expiring probe token. The create
// response carries no key (by new-api design), so the caller re-lists to find it.
async function createProbeToken(auth) {
  const body = {
    name: "arr-ext-probe",
    remain_quota: 0,
    expired_time: -1,
    unlimited_quota: true,
    model_limits_enabled: false,
    model_limits: "",
    allow_ips: "",
    group: "",
  };
  const r = await fetch(AR + "/api/token/", {
    method: "POST",
    credentials: "include",
    headers: { ...authHeaders(auth), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return !!(r && r.ok);
}

// GET /v1/models with the relay key -> a model this token may call. Prefer Claude
// (the thing the user cares about), cheapest first, so a Claude-only window block
// is actually observed instead of hidden behind an always-on cheap model.
export async function pickProbeModel(relayKey) {
  try {
    const r = await fetch(AR + "/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer " + relayKey },
    });
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    const list = j && Array.isArray(j.data) ? j.data : (Array.isArray(j) ? j : null);
    if (!list || !list.length) return null;
    const ids = list.map((m) => (typeof m === "string" ? m : (m && m.id) || "")).filter(Boolean);
    if (!ids.length) return null;
    const claude = ids.filter((id) => /claude/i.test(id));
    return claude.find((id) => /haiku/i.test(id)) || claude[0] || ids[0];
  } catch (e) {
    return null;
  }
}

// POST /v1/chat/completions with the tiniest possible request. Interpret the
// result into { ok, reason, status }:
//   ok:true   -> 200, the account can use this model right now.
//   ok:false  -> a quota/rate/billing rejection (the "blocked" state we hunt for).
//   ok:null   -> anything ambiguous (bad key, bad model/param, network, 5xx) so
//                the UI shows "Unknown" rather than a wrong state.
export async function probeRelay(relayKey, model) {
  let status = 0;
  let text = "";
  try {
    const r = await fetch(AR + "/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + relayKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
    });
    status = r.status;
    if (r.ok) return { ok: true, reason: "", status };
    text = await r.text().catch(() => "");
  } catch (e) {
    return { ok: null, reason: "network", status: 0 };
  }
  const reason = reasonFrom(text);
  const low = (text || "").toLowerCase();
  // Words that mark a quota/rate/billing block, in both the English and the
  // Chinese new-api error strings.
  const blocked = /quota|insufficient|balance|billing|exceed|limit|rate|too many|额度|欠费|余额|无可用|上限|分组|不足/.test(low);
  if (status === 401) return { ok: null, reason: reason || "key-rejected", status };
  if (status === 429) return { ok: false, reason: reason || "Rate/quota limit - blocked until the next window", status };
  if (status === 403) return { ok: false, reason: reason || "Access blocked (billing / permission)", status };
  if (status === 400 && blocked) return { ok: false, reason: reason || "Blocked - quota or billing", status };
  // Other 400s (bad model/param) and 5xx are inconclusive, not a real block.
  return { ok: null, reason: reason || ("http-" + status), status };
}

// Pull a short human reason out of a new-api / OpenAI-style error body.
function reasonFrom(text) {
  if (!text) return "";
  try {
    const j = JSON.parse(text);
    const m =
      (j && j.error && (j.error.message || j.error.type)) ||
      (j && (j.message || j.msg)) ||
      "";
    return String(m).slice(0, 160);
  } catch (e) {
    return String(text).slice(0, 160);
  }
}
