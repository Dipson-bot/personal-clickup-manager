// lib-automation.js
// -----------------------------------------------------------------------------
// The login state machine. Given one account, it drives a single browser tab
// through the full flow and reports success / needs-attention / failed.
//
// Flow (started from Agent Router so the OAuth chain happens naturally):
//   agentrouter.org/login
//     -> click "Sign in with GitHub"
//        -> github.com/login/oauth/authorize (bounces to login while logged out)
//           -> github.com/login          : fill username + password, submit
//           -> github 2FA (TOTP)          : generate code from secret, submit
//           -> github authorize button    : click "Authorize"
//        -> back to agentrouter.org/oauth/github?code=...  (SPA completes login)
//     -> agentrouter app (logged in)      : SUCCESS
//
// Anything it can't pass automatically (device-verification email, CAPTCHA,
// wrong password, an unexpected page) => it stops on that account, leaves the
// tab open, and reports "needs-attention" so you can finish by hand.
//
// If GitHub/Agent Router change their pages, update SELECTORS / classifyUrl
// below - those are the only site-specific parts.
// -----------------------------------------------------------------------------

import { generateTOTP, totpSecondsRemaining } from "./lib-crypto.js";

// ============================ EDITABLE SITE CONFIG ===========================
export const URLS = {
  agentRouterLogin: "https://agentrouter.org/login",
};

export const SELECTORS = {
  githubUser: ["#login_field", 'input[name="login"]'],
  githubPass: ["#password", 'input[name="password"]'],
  githubLoginSubmit: ['input[name="commit"]', 'button[type="submit"]', ".js-login-form button"],
  githubOtp: [
    'input[name="otp"]',
    'input#otp',
    'input#app_totp',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"]',
  ],
  githubOtpSubmit: ['button[type="submit"]', 'input[type="submit"]', 'button.btn-primary'],
  githubAuthorize: [
    'button[name="authorize"][value="1"]',
    "#js-oauth-authorize-btn",
    "button.js-oauth-authorize-btn",
    'button[type="submit"]',
  ],
  // GitHub passkey flow: on /sessions/two-factor (when a passkey is enrolled) the
  // "More options" dropdown shows a "Passkey" link that navigates to
  // /sessions/two-factor/webauthn (web authentication, browser-native). The
  // extension CLICKS that link (it can't answer the WebAuthn challenge itself),
  // then waits a few seconds for the browser's passkey prompt so the user can
  // tap Continue / press Enter. This replaces the old 2FA TOTP submit.
  githubPasskeyLink: [
    'a[data-test-selector="webauthn-link"]',
    'a[href*="/sessions/two-factor/webauthn"]',
    'input[type="submit"][value*="asskey" i]',
  ],
  githubPasskeySubmit: ['button[type="submit"]', 'input[type="submit"]', '.js-continue-button'],
};

// Cookies to PRESERVE on github.com when we "log out" between accounts.
// GitHub's _device_id cookie is how it recognizes a trusted device. If we wipe
// it on every switch, GitHub treats each login as a brand-new device and emails
// a "device verification" code. Keeping it (while still clearing the SESSION
// cookies that keep you signed in) lets GitHub remember this browser and stop
// prompting after the first verification per account. Add names here if GitHub
// introduces new device-trust cookies.
export const GITHUB_KEEP_COOKIES = ["_device_id"];
// =============================================================================

const MAX_STEPS = 30;
const STEP_TIMEOUT_MS = 40000; // per navigation wait
const PER_ACCOUNT_CAP_MS = 240000; // 4 min hard cap per account

// ---------- small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // Touching a chrome API resets the service-worker idle timer.
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
  }, 20000);
}
function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (e) {
    return null;
  }
}

async function inject(tabId, func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
    });
    return res ? res.result : null;
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Inject repeatedly until the result passes `ok`, or attempts run out. Handles
// the common case where waitForTab matched the URL before the DOM finished
// rendering (so fields/buttons aren't there on the first try).
async function injectUntil(tabId, func, args = [], ok = (r) => r && r.ok, tries = 8, delayMs = 700) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    last = await inject(tabId, func, args);
    if (ok(last)) return last;
    await sleep(delayMs);
  }
  return last;
}

// Wait until predicate(url, tab) is true for `tabId`, else timeout. Uses both
// onUpdated events and polling (SPA route changes don't always fire onUpdated).
function waitForTab(tabId, predicate, timeoutMs = STEP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(val);
    };
    const check = async () => {
      const tab = await getTab(tabId);
      if (!tab) return finish({ ok: false, reason: "tab-closed" });
      if (tab.url && predicate(tab.url, tab)) finish({ ok: true, tab });
    };
    const onUpd = (id) => {
      if (id === tabId) check();
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    const poll = setInterval(check, 700);
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    check();
  });
}

// After clicking the Agent Router GitHub button, the auth flow may continue in
// the same tab OR (rarely) a popup/new tab. Resolve to whichever tab is now on
// a github/agentrouter auth URL.
function waitForAuthProgress(tabId, sinceTs, timeoutMs = STEP_TIMEOUT_MS) {
  const isAuthUrl = (url) =>
    /github\.com\/(login|session|sessions)/.test(url) ||
    /agentrouter\.org\/(oauth|$|\/$)/.test(url) ||
    (/agentrouter\.org/.test(url) && !/agentrouter\.org\/login/.test(url));
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpd);
      chrome.tabs.onCreated.removeListener(onCre);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(val);
    };
    const consider = (tab) => {
      if (tab && tab.url && isAuthUrl(tab.url)) finish({ ok: true, tabId: tab.id, url: tab.url });
    };
    const onUpd = (id, info, tab) => consider(tab);
    const onCre = (tab) => {
      if (tab.id && tab.id !== tabId) consider(tab);
    };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.onCreated.addListener(onCre);
    const poll = setInterval(async () => {
      const t = await getTab(tabId);
      consider(t);
    }, 700);
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
  });
}

// ---------- URL classification ----------
function classifyUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return "other";
  }
  const host = u.hostname;
  const route = (u.pathname + u.hash).toLowerCase();

  if (host === "github.com" || host.endsWith(".github.com")) {
    if (route.includes("/login/oauth/authorize")) return "gh-authorize";
    if (route.includes("/sessions/two-factor/webauthn")) return "gh-passkey";
    if (route.includes("/sessions/two-factor")) return "gh-2fa";
    if (route.includes("/sessions/verified-device")) return "gh-deviceverify";
    if (route.startsWith("/login") || route.startsWith("/session")) return "gh-login";
    return "gh-home";
  }
  // Google's sign-in flow (used by "Sign in with Google" SSO on GitHub). The
  // extension can't automate Google credentials, so hitting this means the flow
  // must hand off to the user.
  if (host === "accounts.google.com" || host === "id.google.com" || host.endsWith(".google.com")) return "google-sso";
  if (host === "agentrouter.org" || host.endsWith(".agentrouter.org")) {
    if (route.includes("/oauth")) return "ar-callback";
    if (route.includes("/login")) return "ar-login";
    return "ar-app";
  }
  return "other";
}

// ================= INJECTED PAGE FUNCTIONS (must be self-contained) ==========
function inj_setInputAndSubmit(selectorsUser, selectorsPass, username, password, submitSelectors) {
  const q = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const setVal = (el, val) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value").set;
    setter.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const userEl = q(selectorsUser);
  const passEl = q(selectorsPass);
  if (!userEl || !passEl) return { ok: false, reason: "login-fields-not-found" };
  setVal(userEl, username);
  setVal(passEl, password);
  const btn = q(submitSelectors);
  if (btn) {
    btn.click();
    return { ok: true, submitted: "button" };
  }
  const form = userEl.form || passEl.form;
  if (form) {
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
    return { ok: true, submitted: "form" };
  }
  return { ok: false, reason: "no-submit" };
}

function inj_fillOtp(otpSelectors, submitSelectors, code) {
  const q = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  const el = q(otpSelectors);
  if (!el) return { ok: false, reason: "otp-field-not-found" };
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, code);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  // GitHub's 2FA input auto-submits once all 6 digits are present
  // (js-verification-code-input-auto-submit). If we ALSO click the Verify button
  // in the same tick, we can double-submit and GitHub flags rapid failed attempts
  // (which then rejects even a manually-typed correct code for a cooldown).
  // So: give GitHub's own JS a moment to accept the value, then click once.
  setTimeout(() => {
    const btn = q(submitSelectors);
    if (btn) btn.click();
    else {
      const form = el.form;
      if (form && form.requestSubmit) form.requestSubmit();
      else if (form) form.submit();
    }
  }, 250);
  return { ok: true };
}

function inj_clickAuthorize(authSelectors) {
  const q = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && !el.disabled) return el;
    }
    return null;
  };
  const btn = q(authSelectors);
  if (!btn) return { ok: false, reason: "authorize-btn-not-found" };
  btn.click();
  return { ok: true };
}

// On GitHub's 2FA page, when the account has a passkey enrolled, GitHub first
// shows the security-key / WebAuthn screen. Rather than being forced through the
// authenticator-app code flow (which may not exist on the account), we prefer
// to click the "Passkey" option that lives under the "More options" disclosure.
// Returns { ok: true, mode: "passkey-found" } when we found + clicked the
// passkey link, { ok: false, reason } otherwise.
function inj_findAndClickGithubPasskey(linkSelectors) {
  const q = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };

  // 1) If we're ALREADY on /sessions/two-factor/webauthn (the passkey page), there's
  //    nothing to click - the browser passkey prompt is up, and we just wait for the
  //    user to Continue. Report done so the state loop moves on to waiting.
  if (/\/sessions\/two-factor\/webauthn/i.test(location.pathname + location.search + location.hash))
    return { ok: true, mode: "webauthn-already" };

  // 2) A direct passkey link may be present:
  const link = q(linkSelectors);
  if (link) {
    link.click();
    return { ok: true, mode: "passkey-clicked", href: link.getAttribute("href") || "" };
  }

  // 3) Find the "More options" disclosure button and expand it, which reveals the
  //    "Passkey" alternative. GitHub renders this as a <button class="js-details-target">.
  const moreOptions = Array.from(document.querySelectorAll("button, [role='button']")).find((el) => {
    const t = (el.textContent || "").toLowerCase();
    return /more options|more\s*options|alternatives|passkey/i.test(t) && !/passkey/.test(t);
  });
  if (moreOptions) {
    moreOptions.click();
    // Give GitHub's disclosure time to populate the alternative links, then click passkey.
    setTimeout(() => {
      const passkey = q([
        'a[data-test-selector="webauthn-link"]',
        'a[href*="/sessions/two-factor/webauthn"]',
        '.two-factor-alternatives-item a',
      ]);
      if (passkey) passkey.click();
    }, 500);
    return { ok: true, mode: "more-options-then-passkey" };
  }

  // 4) A <a> that literally says "Passkey":
  const byText = Array.from(document.querySelectorAll("a, button")).find((el) => {
    const t = (el.textContent || "").toLowerCase();
    return t.trim() === "passkey" || (t.includes("passkey") && t.length < 15);
  });
  if (byText) {
    byText.click();
    return { ok: true, mode: "passkey-by-text" };
  }

  return { ok: false, reason: "passkey-link-not-found" };
}

// After clicking the passkey link, GitHub/browser shows the native passkey
// (WebAuthn) prompt. We can't programmatically confirm it, but we can nudge the
// user, then simply wait - and (optionally) submit the page form so the browser
// uses the "Continue" webauthn dialog. This helper tries to click any visible
// "Continue" / submit button on the webauthn page after a short delay, which
// mirrors the user pressing Enter.
function inj_confirmPasskeyPrompt(submitSelectors) {
  const q = (sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  };
  // We're now on the webauthn screen. There may be a "Continue" button that
  // triggers the browser's native prompt. Find and click it (best-effort).
  const candidates = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"));
  const continueBtn = candidates.find((el) => {
    const t = (el.textContent || (el.value || "")).trim().toLowerCase();
    return /continue|verify|use passkey|authenticate|sign.?in/i.test(t);
  });
  if (continueBtn) {
    continueBtn.click();
    return { ok: true, clicked: "continue" };
  }
  const generic = q(submitSelectors);
  if (generic) {
    generic.click();
    return { ok: true, clicked: "submit" };
  }
  return { ok: false, reason: "no-continue-button" };
}

// Find the "Sign in with GitHub" control on Agent Router's SPA and return the URL.
// Returns { ok: true, navigate: <url>, needClick: false } to navigate directly,
// OR { ok: true, needClick: true } if we need the caller to click (fallback).
function inj_clickAgentRouterGitHub() {
  // 1) direct oauth links in <a href> elements
  const links = Array.from(document.querySelectorAll("a[href]"));
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (href.includes("github.com/login/oauth") || href.includes("/oauth/github")) {
      return { ok: true, via: "href", navigate: href };
    }
  }

  // 2) any clickable element that references GitHub by text/aria/title/svg
  const candidates = Array.from(
    document.querySelectorAll('button, a, [role="button"], .semi-button, [class*="oauth"], [class*="github" i]')
  );
  const looksGithub = (el) => {
    const t = (el.textContent || "").toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    const title = (el.getAttribute("title") || "").toLowerCase();
    const cls = (el.className || "").toString().toLowerCase();
    if (t.includes("github") || aria.includes("github") || title.includes("github") || cls.includes("github"))
      return true;
    const svg = el.querySelector("svg");
    if (svg) {
      const html = svg.outerHTML.toLowerCase();
      if (html.includes("github")) return true;
    }
    return false;
  };

  // Try to find the GitHub OAuth URL from the page.
  // Method 1: Look for a hidden input or data attribute with the URL
  for (const el of candidates) {
    if (looksGithub(el)) {
      const directUrl = el.getAttribute("data-oauth-url") || el.getAttribute("data-github-url") || el.getAttribute("href");
      if (directUrl && (directUrl.includes("github.com/login/oauth") || directUrl.includes("/oauth/github"))) {
        return { ok: true, via: "data-url", navigate: directUrl };
      }
    }
  }

  // Method 2: Look for an <a> with href directly
  for (const a of document.querySelectorAll('a[role="button"], a.semi-button')) {
    const href = a.getAttribute("href") || "";
    if (href.includes("github.com/login/oauth") || href.includes("/oauth/github")) {
      return { ok: true, via: "a-href", navigate: href };
    }
  }

  // Method 3: Check if there's an element with the OAuth URL in its href attribute
  for (const a of document.querySelectorAll("a[href*='github']")) {
    const href = a.getAttribute("href") || "";
    if (href.includes("github.com/login/oauth")) {
      return { ok: true, via: "github-link", navigate: href };
    }
  }

  // Fallback: click the button (may be blocked by Chrome popup blocker, but the
  // caller already tried direct navigation first via inj_getAndNavigateToGithubOAuth).
  for (const el of candidates) {
    if (looksGithub(el)) {
      const target = el.closest('button, a, [role="button"]') || el;
      target.click();
      return { ok: true, via: "text/icon-click", clicked: true };
    }
  }

  return { ok: false, reason: "github-button-not-found" };
}

// Heuristic: is the Agent Router SPA logged in? new-api stores the user object
// in localStorage under "user" after a successful login.
function inj_agentRouterLoggedIn() {
  let hasUser = false;
  try {
    hasUser = !!localStorage.getItem("user");
  } catch (e) {}
  const route = (location.pathname + location.hash).toLowerCase();
  const onLogin = route.includes("/login");
  return { loggedIn: hasUser && !onLogin, hasUser, onLogin, route };
}

// Detect a GitHub sign-in error (bad password etc.) so we can fail fast.
function inj_githubError() {
  const flash = document.querySelector(".flash-error, .flash.flash-error, #js-flash-container .flash-error");
  const alert = document.querySelector('[role="alert"]');
  const txt = ((flash && flash.textContent) || (alert && alert.textContent) || "").trim();
  return { error: !!txt, text: txt.slice(0, 200) };
}

// Click (or return a direct URL for) GitHub's "Continue with Google" / SSO
// button on the login page. Returns { ok, url? } where `url` (when present) is a
// URL we can navigate straight to, avoiding popup blockers. GitHub renders the
// Google button as a <form method="get" action="/sessions/social/google/initiate">
// pointing at GitHub's SSO endpoint, so prefer walking up to that form and
// building the GET URL; fall back to clicking its submit button.
function inj_clickGithubGoogle() {
  const wanted = /sign\s*in\s*with\s*google|continue\s*with\s*google|google/i;
  const els = Array.from(document.querySelectorAll('button[type="submit"], button, input[type="submit"], a, [role="button"]'));
  for (const el of els) {
    let txt = "";
    try { txt = (el.textContent || "").trim(); } catch (e) {}
    if (!txt) txt = (el.value || "").trim();
    if (!txt || !wanted.test(txt)) continue;
    // If this control lives in a GET form, build the direct URL from form.action +
    // hidden inputs so we can navigate straight to it (bypasses popup blockers).
    const form = el.closest && el.closest("form");
    if (form && form.action) {
      if ((form.method || "get").toLowerCase() === "get") {
        const params = [];
        for (const inp of form.querySelectorAll("input")) {
          if (inp.name && inp.value != null) params.push(encodeURIComponent(inp.name) + "=" + encodeURIComponent(inp.value));
        }
        const sep = form.action.includes("?") ? "&" : "?";
        return { ok: true, url: form.action + sep + params.join("&") };
      }
    }
    const href = el.getAttribute && el.getAttribute("href");
    if (href) return { ok: true, url: href };
    el.click();
    return { ok: true, clicked: true };
  }
  return { ok: false };
}

// Best-effort kick of Google's passkey flow from a Google sign-in page (account
// chooser, "Confirm it's you", etc.). Google renders a "use a passkey" control
// somewhere on those pages; click it so the browser raises the native passkey
// prompt for the user to confirm. We don't know Google's exact DOM (it changes),
// so just find the most specific passkey-labelled element we can click.
function inj_clickGooglePasskey() {
  const els = Array.from(
    document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], label, [role="checkbox"]'
    )
  );
  let fallback = null;
  let best = null;
  for (const el of els) {
    let t = "";
    try {
      t = (el.textContent || "").trim();
    } catch (e) {}
    if (!t) t = (el.getAttribute && el.getAttribute("aria-label")) || "";
    if (!t) continue;
    if (!/passkey|face\d*|finger|hardware\s*key/i.test(t)) continue;
    // Exact-enough action labels beat generic mentions ("passkey" in a help text).
    const label = t.toLowerCase();
    const action = /use\s*(a|your)?\s*passkey|sign\s*in\s*with|continue\s*with|verify/i.test(label);
    if (/setting|manage|edit|learn\s*more|help|support/.test(label)) continue;
    if (action && !best) best = el;
    if (!fallback) fallback = el;
  }
  const pick = best || fallback;
  if (!pick) return { ok: false, reason: "no-passkey-control" };
  try {
    pick.click();
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const label = (pick.textContent || pick.getAttribute("aria-label") || "").trim().slice(0, 40);
  return { ok: true, clicked: true, label };
}

// Read which GitHub account is signed in on the current github.com page. The
// login handle lives in a <meta> tag on every page; the email is usually private
// so it's a best-effort bonus. Used to record which account actually logged in.
function inj_readGithubIdentity() {
  try {
    const meta = (n) => {
      const m = document.querySelector('meta[name="' + n + '"]');
      return m ? (m.getAttribute("content") || "").trim() : "";
    };
    const login = meta("user-login") || meta("octolytics-actor-login") || "";
    let email = "";
    const emailEl = document.querySelector('[itemprop="email"], a[href^="mailto:"]');
    if (emailEl) email = (emailEl.getAttribute("href") || emailEl.textContent || "").replace(/^mailto:/, "").trim();
    return { ok: true, login, email };
  } catch (e) {
    return { ok: false };
  }
}

// Read the Agent Router user record (new-api stores it in localStorage.user).
// It often carries the account's username/email, which we surface in the UI.
function inj_readAgentRouterUser() {
  try {
    const raw = localStorage.getItem("user");
    if (!raw) return { ok: true, user: null };
    const u = JSON.parse(raw);
    // new-api stores the remaining quota on the user record. Return it RAW
    // (unformatted) - the UI decides how to divide/label it. Try the common
    // field names across new-api / One API forks.
    let balance = u.quota ?? u.balance ?? u.credits ?? u.remaining ?? null;
    if (typeof balance === "string" && balance.trim() !== "") balance = Number(balance);
    if (!Number.isFinite(balance)) balance = null;
    return {
      ok: true,
      user: {
        username: u.username || "",
        email: u.email || "",
        display_name: u.display_name || "",
        balance,
        // Cache the id + access_token so the service worker can later poll the
        // balance in the BACKGROUND (no tab) by replaying these as the
        // New-API-User / Authorization headers /api/user/self requires.
        id: u.id != null ? u.id : null,
        accessToken: u.access_token || "",
      },
    };
  } catch (e) {
    return { ok: false };
  }
}

// Read the signed-in user from Agent Router's own API - the authoritative source
// for BOTH the live balance and the identity (username github_<id>).
// CRITICAL: this must send the same auth the new-api SPA sends. Besides the
// session cookie, its frontend attaches a "New-API-User" header carrying the
// signed-in user id (and a bearer access token when one is present). A
// cookie-only request is rejected with 401 - which is exactly why the balance
// came back empty ($0.00 from the stale cache) and the ⟳ refresh said "not
// logged in". Replay the id/token from localStorage.user so the request matches.
async function inj_fetchAgentRouterBalance() {
  const headers = {};
  try {
    const raw = localStorage.getItem("user");
    if (raw) {
      const u = JSON.parse(raw);
      if (u && u.id != null) headers["New-API-User"] = String(u.id);
      if (u && u.access_token) headers["Authorization"] = "Bearer " + u.access_token;
    }
  } catch (e) {}
  try {
    const res = await fetch("/api/user/self", { credentials: "include", headers });
    if (!res || !res.ok) return { ok: false, status: res ? res.status : 0 };
    const j = await res.json();
    const d = j && j.data ? j.data : j;
    if (!d || typeof d !== "object") return { ok: false };
    let balance = d.quota ?? d.balance ?? d.credits ?? d.remaining ?? null;
    if (typeof balance === "string" && balance.trim() !== "") balance = Number(balance);
    if (!Number.isFinite(balance)) balance = null;
    return {
      ok: true,
      balance,
      username: d.username || "",
      email: d.email || "",
      display_name: d.display_name || "",
    };
  } catch (e) {
    return { ok: false };
  }
}
// This lets us build the OAuth URL directly instead of relying on window.open (which
// gets blocked when triggered from an extension-injected script).
function inj_getGithubClientId() {
  const strategies = [
    // Check for a global config object with github_client_id
    () => {
      if (window.__CONFIG__ && window.__CONFIG__.github_client_id) return window.__CONFIG__.github_client_id;
      if (window.__CONFIG__ && window.__CONFIG__.github && window.__CONFIG__.github.client_id) return window.__CONFIG__.github.client_id;
    },
    // Check for React Query / TanStack Query cached data
    () => {
      const keys = Object.keys(window).filter(k => k.startsWith("__") || k.includes("Query") || k.includes("query") || k.includes("cache") || k.includes("Cache"));
      for (const key of keys) {
        try {
          const val = window[key];
          if (val && typeof val === "object") {
            const str = JSON.stringify(val);
            const match = str.match(/"github_client_id"\s*:\s*"([^"]+)"/);
            if (match) return match[1];
          }
        } catch (e) {}
      }
    },
    // Check localStorage for any cached config
    () => {
      const keys = Object.keys(localStorage);
      for (const key of keys) {
        try {
          const val = localStorage.getItem(key);
          if (val) {
            const match = String(val).match(/"github_client_id"\s*:\s*"([^"]+)"/);
            if (match) return match[1];
            // Also try simple key-value patterns
            const simple = String(val).match(/github_client_id[=:]["']([^"']+)["']/);
            if (simple) return simple[1];
          }
        } catch (e) {}
      }
    },
    // Check all global variables for a string that looks like a GitHub OAuth client_id
    // (Iv1. + 40 hex chars is the standard format)
    () => {
      for (const key of Object.keys(window)) {
        try {
          const val = window[key];
          if (typeof val === "string" && /^Iv1\.[a-f0-9]{20,40}$/i.test(val)) return val;
        } catch (e) {}
      }
    },
    // Check for the state token we can decode to find the client_id hint
    () => {
      // Agent Router stores oauth state in localStorage
      const aff = localStorage.getItem("aff") || "";
      return ""; // can't get client_id from aff alone
    }
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy();
      if (result && typeof result === "string" && result.length > 5) return result;
    } catch (e) {}
  }
  return "";
}

// Fetch the GitHub OAuth state token from Agent Router's API and build the full
// authorize URL, then navigate the current tab to it - bypassing the window.open
// popup blocker. Returns { ok, url } or { ok: false, reason }.
async function inj_getAndNavigateToGithubOAuth() {
  // Resolve the GitHub OAuth client_id from Agent Router's own status API - the
  // authoritative source, and it still works right after we purge localStorage
  // for a clean login (page-scraped config would be gone). This function is
  // injected standalone, so it MUST be fully self-contained (it cannot call
  // other inj_* helpers - those don't exist in the page's context).
  let clientId = "";
  try {
    const sres = await fetch("/api/status", { credentials: "include" });
    if (sres.ok) {
      const sj = await sres.json();
      const sd = sj && sj.data ? sj.data : sj;
      if (sd && sd.github_client_id) clientId = sd.github_client_id;
    }
  } catch (e) {}
  // Fallbacks: a global config object, then any cached JSON in localStorage.
  if (!clientId) {
    try {
      if (window.__CONFIG__ && window.__CONFIG__.github_client_id) clientId = window.__CONFIG__.github_client_id;
    } catch (e) {}
  }
  if (!clientId) {
    try {
      for (const key of Object.keys(localStorage)) {
        const m = String(localStorage.getItem(key) || "").match(/"github_client_id"\s*:\s*"([^"]+)"/);
        if (m) { clientId = m[1]; break; }
      }
    } catch (e) {}
  }
  if (!clientId) return { ok: false, reason: "github_client_id not found" };

  // Fetch the anti-forgery state token. Must be a same-origin fetch so the
  // session cookie set here is the one validated when GitHub calls back.
  let state = "";
  try {
    const resp = await fetch("/api/oauth/state?mode=login", { credentials: "include" });
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.data) state = data.data;
    }
  } catch (e) {
    return { ok: false, reason: "state-fetch-failed: " + String(e) };
  }
  if (!state) return { ok: false, reason: "no-state-token" };

  const oauthUrl =
    "https://github.com/login/oauth/authorize?client_id=" + encodeURIComponent(clientId) +
    "&state=" + encodeURIComponent(state) + "&scope=user:email";
  // Same-tab navigation - bypasses the popup blocker entirely.
  window.location.href = oauthUrl;
  return { ok: true, url: oauthUrl, navigated: true };
}
// =============================================================================

// ---------- cookies / logout ----------
async function clearCookiesForDomains(domains, keepByDomain = {}) {
  for (const domain of domains) {
    const keep = new Set(keepByDomain[domain] || []);
    let cookies = [];
    try {
      cookies = await chrome.cookies.getAll({ domain });
    } catch (e) {
      continue;
    }
    for (const c of cookies) {
      if (keep.has(c.name)) continue; // preserve device-trust cookies (e.g. _device_id)
      const prefix = c.secure ? "https://" : "http://";
      const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const url = `${prefix}${host}${c.path}`;
      try {
        await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId });
      } catch (e) {}
    }
  }
}

// ---------- main per-account routine ----------
export async function runAccountLogin(account, opts = {}) {
  const targetUrl = opts.targetUrl || URLS.agentRouterLogin;
  const runStart = Date.now();
  let note = "";

  // Timeout scaling: on a slow/unreliable connection, wait proportionally longer
  // before giving up on each navigation (opts.timeoutScale, default 1).
  const scale = Math.max(1, Number(opts.timeoutScale) || 1);
  const T = (ms) => Math.round(ms * scale);
  const capMs = T(PER_ACCOUNT_CAP_MS);
  const fillTries = Math.round(8 * scale);

  // Identity actually signed in (captured during the flow, best-effort).
  const detected = { githubLogin: "", githubEmail: "", arUsername: "", arEmail: "", balance: null };
  const grabGithubIdentity = async () => {
    const id = await inject(tabId, inj_readGithubIdentity);
    if (id && id.ok) {
      if (id.login) detected.githubLogin = id.login;
      if (id.email && id.email.includes("@")) detected.githubEmail = id.email;
    }
  };

  // Fresh session: fully clear Agent Router, and clear GitHub's SESSION cookies
  // (so we log in as THIS account) while KEEPING its device-trust cookie - that
  // stops GitHub from emailing a new-device verification code on every switch.
  await clearCookiesForDomains(["github.com", "agentrouter.org"], {
    "github.com": GITHUB_KEEP_COOKIES,
  });

  // Buffer so the logout (cookie removal) fully settles before the new login -
  // prevents a too-fast logout/login race, especially on slow connections.
  await sleep(T(900));

  // Open (or reuse) a tab on the Agent Router login page.
  let tab;
  try {
    tab = await chrome.tabs.create({ url: targetUrl, active: !!opts.active });
    if (opts.tabRegistry) opts.tabRegistry.add(tab.id);
  } catch (e) {
    return { result: "failed", note: "could not open tab: " + e.message };
  }
  let tabId = tab.id;

  // Wait for the login SPA to be ready.
  await waitForTab(tabId, (u) => classifyUrl(u) === "ar-login" || classifyUrl(u) === "ar-app", T(25000));

  // CRITICAL for account switching: clearing cookies (above) ends the session
  // server-side, but new-api ALSO caches the signed-in user in localStorage, and
  // that survives a cookie clear. The SPA (and our inj_agentRouterLoggedIn check)
  // then reports "logged in" as whoever used this browser last - so the GitHub
  // OAuth step gets skipped and the account never actually switches (every run
  // just re-reads the same stale cached user). Purge the cached SPA session and
  // reload so each account logs in fresh.
  await inject(tabId, () => {
    try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
  });
  await chrome.tabs.update(tabId, { url: targetUrl });
  await waitForTab(tabId, (u) => classifyUrl(u) === "ar-login" || classifyUrl(u) === "ar-app", T(25000));

  // If STILL logged in after that purge (a valid session cookie somehow
  // survived), we're already done - capture identity + balance and return.
  let ar = await inject(tabId, inj_agentRouterLoggedIn);
  if (ar && ar.loggedIn) {
    const arRes = await inject(tabId, inj_readAgentRouterUser);
    if (arRes && arRes.ok && arRes.user) {
      if (arRes.user.username) detected.arUsername = arRes.user.username;
      if (arRes.user.email && arRes.user.email.includes("@")) detected.arEmail = arRes.user.email;
      if (arRes.user.id != null) detected.arId = arRes.user.id;
      if (arRes.user.accessToken) detected.arToken = arRes.user.accessToken;
    }
    // Balance + identity from the API (authoritative - see the ar-app path).
    const bal = await inject(tabId, inj_fetchAgentRouterBalance);
    if (bal && bal.ok) {
      if (bal.balance != null) detected.balance = bal.balance;
      if (bal.username) detected.arUsername = bal.username;
      if (bal.email && bal.email.includes("@")) detected.arEmail = bal.email;
    } else {
      detected.balanceErr = bal && bal.status ? "HTTP " + bal.status : "no response";
    }
    if (detected.balance == null && arRes && arRes.ok && arRes.user && Number(arRes.user.balance) > 0)
      detected.balance = arRes.user.balance;
    return { result: "success", note: "already logged in", tabId, detected };
  }

  // Click GitHub button (retry while SPA finishes rendering).
  // PREFERRED: try the direct OAuth URL navigation first (bypasses popup blocker).
  // FALLBACK: click the button (may be blocked by Chrome's popup blocker).
  let clicked = null;
  let usedDirectNav = false;
  for (let i = 0; i < 8; i++) {
    // Try direct navigation to GitHub OAuth URL (bypasses popup blocker)
    const directNav = await inject(tabId, inj_getAndNavigateToGithubOAuth);
    if (directNav && directNav.ok) {
      clicked = { ok: true, via: "direct-nav", navigated: true };
      usedDirectNav = true;
      break;
    }
    // Fallback: try clicking the button
    clicked = await inject(tabId, inj_clickAgentRouterGitHub);
    if (clicked && clicked.ok) break;
    await sleep(800);
  }
  if (!clicked || !clicked.ok) {
    return {
      result: "needs-attention",
      note: "Couldn't find the 'Sign in with GitHub' button on Agent Router - finish in the open tab.",
      tabId,
    };
  }

  // Follow the auth flow into GitHub (same tab or a popup).
  // If we used direct navigation, the current tab IS now on github.com - no waiting needed.
  // If we clicked, wait for the new tab/popup to appear.
  if (!usedDirectNav) {
    const prog = await waitForAuthProgress(tabId, runStart, T(30000));
    if (prog && prog.ok && prog.tabId) tabId = prog.tabId;
  } else {
    // Same-tab navigation is underway - wait until we've left the AR login page
    // (arriving at github.com, or bouncing straight back to the app if GitHub
    // had already authorized) before the state loop inspects the URL.
    await waitForTab(tabId, (u) => classifyUrl(u) !== "ar-login", T(20000));
  }

  // ---- state loop ----
  let loginAttempts = 0;
  let twofaAttempts = 0;
  let forced2faApp = false;
  let passkeyAttempted = false;
  let googlePasskeyAttempted = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    // Respect an external "stop" signal (Debug → Stop). Bails out of the loop so
    // a run never keeps going after the user asks it to stop.
    if (opts.isCancelled && (await opts.isCancelled()))
      return { result: "needs-attention", note: "Stopped by user.", tabId };
    if (Date.now() - runStart > capMs)
      return { result: "needs-attention", note: "Timed out - finish in the open tab.", tabId };

    const t = await getTab(tabId);
    if (!t) return { result: "failed", note: "Tab was closed during login." };
    const cls = classifyUrl(t.url || "");

    if (cls === "ar-login") {
      // Bounced back to login: try direct navigation, then click GitHub once, else bail.
      const directNav = await inject(tabId, inj_getAndNavigateToGithubOAuth);
      if (directNav && directNav.ok) continue;
      const c = await inject(tabId, inj_clickAgentRouterGitHub);
      if (!c || !c.ok)
        return { result: "needs-attention", note: "Returned to Agent Router login - finish manually.", tabId };
      const p = await waitForAuthProgress(tabId, runStart, T(25000));
      if (p && p.ok && p.tabId) tabId = p.tabId;
      continue;
    }

    if (cls === "gh-login") {
      // "Sign in with Google" accounts have no GitHub password to fill. Click the
      // Google/SSO button so the browser lands on Google's sign-in, then carry on
      // (Google credentials can't be automated safely - see the google-sso branch).
      if (account.authMethod === "google" || account.authMethod === "google-passkey") {
        // Retry finding/clicking the Google button (the OAuth login page renders
        // it a touch late). Navigate straight to GitHub's Google-SSO initiate URL
        // (bypasses popup blockers), then the loop waits on the google-sso page
        // for you to finish Google sign-in. Once back on GitHub, the loop
        // auto-continues (OAuth + 2FA via the saved TOTP secret).
        const g = await injectUntil(tabId, inj_clickGithubGoogle, [], (x) => x && x.ok, 6, 900);
        if (g && g.ok) {
          if (g.url) await chrome.tabs.update(tabId, { url: g.url });
          await waitForTab(tabId, (u) => classifyUrl(u) === "google-sso" || classifyUrl(u) !== "gh-login", T(15000));
          continue;
        }
        const errTxt = g && g.error && !String(g.error).includes("ok") ? " (" + g.error + ")" : "";
        return {
          result: "needs-attention",
          note:
            "Couldn't find the 'Continue with Google' button on GitHub" + errTxt +
            " - this GitHub login may not be linked to Google. Finish in the open tab, " +
            "or switch this account to 'GitHub password' if it has one.",
          tabId,
        };
      }
      if (!account.username || !account.password)
        return { result: "needs-attention", note: "This account is missing its username or password - add it in Manage.", tabId };
      const err = await inject(tabId, inj_githubError);
      if (err && err.error && /incorrect|invalid|not\s|unable|wrong/i.test(err.text))
        return { result: "failed", note: "GitHub rejected the credentials: " + err.text, tabId };
      if (loginAttempts >= 2)
        return { result: "needs-attention", note: "GitHub login isn't completing - finish manually.", tabId };
      loginAttempts++;
      const r = await injectUntil(
        tabId,
        inj_setInputAndSubmit,
        [SELECTORS.githubUser, SELECTORS.githubPass, account.username, account.password, SELECTORS.githubLoginSubmit],
        (x) => x && x.ok,
        fillTries,
        T(700)
      );
      if (!r || !r.ok)
        return { result: "needs-attention", note: "Couldn't fill GitHub login (" + (r && (r.reason || r.error)) + ") - finish manually.", tabId };
      await waitForTab(tabId, (u) => classifyUrl(u) !== "gh-login", T(15000));
      continue;
    }

    if (cls === "gh-2fa") {
      // GitHub 2FA page. If this account has a passkey enrolled, GitHub shows the
      // security-key / WebAuthn screen here. We PREFER the passkey flow: the user
      // taps Continue / presses Enter on the browser's native passkey prompt, and
      // we wait. If no passkey is available, fall back to the authenticator-app
      // TOTP code (generated from the stored secret).
      //
      // TOTP is the default for password accounts: the whole point of saving a
      // TOTP secret is to auto-fill the 6-digit authenticator code, so we go
      // STRAIGHT to GitHub's authenticator-app page and skip the WebAuthn/passkey
      // screen. The passkey detour is opt-in only (opts.usePasskey === true) - it
      // used to be the default, which is why every login "always moved to the
      // passkey option" even when a TOTP secret was saved.
      const usePasskey = opts.usePasskey === true;

      if (usePasskey && !forced2faApp && !passkeyAttempted && !twofaAttempts) {
        // Try to click the passkey link (it may be under the "More options"
        // disclosure, or we may already be on the webauthn screen).
        passkeyAttempted = true;
        const pk = await injectUntil(tabId, inj_findAndClickGithubPasskey, [SELECTORS.githubPasskeyLink], (x) => x && x.ok, 6, 800);
        if (pk && pk.ok) {
          // The passkey click may navigate to /sessions/two-factor/webauthn, where
          // the browser passkey prompt appears. Wait a moment for the page to load,
          // then try to click its Continue/submit so the user's ENTER on the prompt
          // proceeds. Leave a few seconds for the user to interact.
          await waitForTab(
            tabId,
            (u) => /\/sessions\/two-factor\/webauthn/i.test(u) || classifyUrl(u) !== "gh-2fa",
            T(12000)
          );
          // Best-effort: click Continue on the webauthn page (mirrors pressing Enter).
          const cont = await injectUntil(tabId, inj_confirmPasskeyPrompt, [SELECTORS.githubPasskeySubmit], (x) => x && x.ok, 4, 700);
          void cont;
          // Loop again - it will land on gh-passkey (webauthn page) or past 2FA.
          continue;
        }
      }

      // Fall through to the TOTP authenticator-app code flow.
      if (!account.totpSecret)
        return { result: "needs-attention", note: "2FA required but no TOTP secret saved - enter the code manually.", tabId };
      // GitHub defaults to the security-key / passkey screen
      // (…/sessions/two-factor/webauthn) when the account has a passkey enrolled.
      // The extension can't answer a WebAuthn challenge, but it CAN type a TOTP
      // code - so switch to GitHub's authenticator-app page, which has the numeric
      // input. Do it once; if GitHub bounces back (no authenticator app on the
      // account), fall through and let the fill report a clear needs-attention.
      let route2fa = "";
      try { route2fa = new URL(t.url || "").pathname.toLowerCase(); } catch (e) {}
      if (!route2fa.includes("/sessions/two-factor/app") && !forced2faApp) {
        forced2faApp = true;
        await chrome.tabs.update(tabId, { url: "https://github.com/sessions/two-factor/app" });
        await waitForTab(
          tabId,
          (u) => /\/sessions\/two-factor\/app/i.test(u) || classifyUrl(u) !== "gh-2fa",
          T(15000)
        );
        continue;
      }
      if (twofaAttempts >= 2)
        return { result: "needs-attention", note: "2FA code was not accepted - enter it manually.", tabId };
      twofaAttempts++;
      // Avoid submitting a code that's about to roll over.
      if (totpSecondsRemaining() < 3) await sleep(3500);
      let code;
      try {
        code = await generateTOTP(account.totpSecret);
      } catch (e) {
        return { result: "needs-attention", note: "TOTP secret looks invalid - enter the code manually.", tabId };
      }
      const r = await injectUntil(
        tabId,
        inj_fillOtp,
        [SELECTORS.githubOtp, SELECTORS.githubOtpSubmit, code],
        (x) => x && x.ok,
        fillTries,
        T(700)
      );
      if (!r || !r.ok)
        return { result: "needs-attention", note: "Couldn't fill the 2FA code - enter it manually.", tabId };
      const moved = await waitForTab(tabId, (u) => classifyUrl(u) !== "gh-2fa", T(20000));
      if (!moved.ok) {
        const err = await inject(tabId, inj_githubError);
        if (err && err.error)
          return { result: "needs-attention", note: "2FA code was not accepted - enter it manually.", tabId };
      }
      continue;
    }

    if (cls === "gh-passkey") {
      // GitHub landed on the WebAuthn / passkey page. When the account has a
      // saved TOTP secret and passkey mode isn't explicitly opted in, this is
      // exactly the "it always moves to the passkey option" case the user hit:
      // we want the authenticator-app code instead. Redirect to GitHub's
      // authenticator page (once) so the numeric OTP field appears and the
      // gh-2fa branch fills it from the saved secret.
      const passkeyOptIn = opts.usePasskey === true;
      if (!passkeyOptIn && account.totpSecret && !forced2faApp) {
        forced2faApp = true;
        await chrome.tabs.update(tabId, { url: "https://github.com/sessions/two-factor/app" });
        await waitForTab(
          tabId,
          (u) => /\/sessions\/two-factor\/app/i.test(u) || classifyUrl(u) === "gh-2fa" || classifyUrl(u) !== "gh-passkey",
          T(15000)
        );
        continue;
      }

      // We're on the WebAuthn / passkey page. The browser shows the native
      // passkey prompt (a modal asking to confirm the sign-in with the passkey /
      // Windows Hello fingerprint / PIN). The extension CANNOT answer the
      // WebAuthn challenge itself - it must hand control to the user, who
      // presses Enter (or clicks Continue) on the prompt.
      //
      // We wait here, re-checking the tab until:
      //   • the user completes the passkey and GitHub continues (URL changes), OR
      //   • the hard account cap elapses (we return needs-attention).
      // Meanwhile, best-effort: click any Continue/Verify button on the page so
      // the user's ENTER is all that's needed. Also nudge the user with a note.
      note = note || "Waiting for passkey confirmation - press Enter / Continue on the passkey prompt in the open tab.";
      const prev = await getTab(tabId);
      // If the user already finished, the class re-loop handles it.
      await sleep(T(2500));
      const passkeyCont = await injectUntil(
        tabId,
        inj_confirmPasskeyPrompt,
        [SELECTORS.githubPasskeySubmit],
        (x) => x && x.ok,
        5,
        700
      );
      if (!passkeyCont || !passkeyCont.ok) {
        // No Continue button visible - the browser prompt is up; just wait and
        // let it resolve on the next loop iterations.
        await sleep(T(3500));
      }
      // Let the loop re-inspect the URL (it will classify as authorize / app /
      // login and continue). Give the passkey a few seconds to complete.
      continue;
    }

    if (cls === "gh-authorize") {
      // On the authorize page we're signed into GitHub - grab which handle it is.
      await grabGithubIdentity();
      let ok = false;
      for (let i = 0; i < 6; i++) {
        const r = await inject(tabId, inj_clickAuthorize, [SELECTORS.githubAuthorize]);
        if (r && r.ok) {
          ok = true;
          break;
        }
        await sleep(600);
      }
      if (!ok)
        return { result: "needs-attention", note: "Couldn't click GitHub 'Authorize' - finish manually.", tabId };
      await waitForTab(tabId, (u) => classifyUrl(u) !== "gh-authorize", T(STEP_TIMEOUT_MS));
      continue;
    }

    if (cls === "google-sso") {
      // The user is completing Google sign-in (choosing a profile / entering
      // credentials). We can't automate Google's password entry safely, so just
      // wait - once they finish, GitHub returns to the OAuth/2FA flow and the
      // loop continues (2FA, if the account has a TOTP secret, gets auto-filled
      // below). The one exception: "google-passkey" accounts - best-effort start
      // Google's passkey flow (like GitHub's 2FA passkey), then wait for the
      // native prompt the user confirms. Attempted once so the loop doesn't
      // re-click the control on every pass.
      if (account.authMethod === "google-passkey" && !googlePasskeyAttempted) {
        googlePasskeyAttempted = true;
        await injectUntil(tabId, inj_clickGooglePasskey, [], (x) => x && x.ok, 4, 900);
      }
      await sleep(T(4000));
      continue;
    }

    if (cls === "gh-deviceverify")
      return {
        result: "needs-attention",
        note:
          "GitHub emailed a device-verification code for this account (it has no authenticator 2FA). " +
          "The extension can't read your email, so type the code in the open tab this once. " +
          "To make it fully automatic: turn on authenticator (TOTP) 2FA for this GitHub account, then " +
          "paste that account's setup key into its TOTP field here - GitHub will then ask for an " +
          "authenticator code (which the extension generates) instead of emailing you.",
        tabId,
      };

    if (cls === "gh-home") {
      // Logged into GitHub but OAuth didn't return us - grab identity, go to Agent Router.
      await grabGithubIdentity();
      await chrome.tabs.update(tabId, { url: targetUrl });
      await waitForTab(tabId, (u) => {
        const c = classifyUrl(u);
        return c === "ar-login" || c === "ar-app";
      }, T(20000));
      continue;
    }

    if (cls === "ar-callback") {
      // SPA is exchanging the code; wait for it to settle.
      await sleep(1500);
      continue;
    }

    if (cls === "ar-app") {
      await sleep(T(1500)); // let the SPA persist the session
      const check = await inject(tabId, inj_agentRouterLoggedIn);
      if (check && (check.loggedIn || check.hasUser)) {
        // Capture the Agent Router user record (username/email/balance) for the UI.
        const arRes = await inject(tabId, inj_readAgentRouterUser);
        if (arRes && arRes.ok && arRes.user) {
          if (arRes.user.username) detected.arUsername = arRes.user.username;
          if (arRes.user.email && arRes.user.email.includes("@")) detected.arEmail = arRes.user.email;
          if (arRes.user.id != null) detected.arId = arRes.user.id;
          if (arRes.user.accessToken) detected.arToken = arRes.user.accessToken;
        }
        // Balance + identity: /api/user/self is authoritative. localStorage.user
        // is frequently stale (its quota is 0, and it can lag the real account),
        // so prefer the API for BOTH the balance and the AR username - that way
        // the value we store and the ⟳ refresh compare the exact same identity.
        const bal = await inject(tabId, inj_fetchAgentRouterBalance);
        if (bal && bal.ok) {
          if (bal.balance != null) detected.balance = bal.balance;
          if (bal.username) detected.arUsername = bal.username;
          if (bal.email && bal.email.includes("@")) detected.arEmail = bal.email;
        } else {
          detected.balanceErr = bal && bal.status ? "HTTP " + bal.status : "no response";
        }
        // Only trust the cached quota when the API gave us nothing AND it's
        // positive - storing a stale $0.00 is worse than leaving it unknown.
        if (detected.balance == null && arRes && arRes.ok && arRes.user && Number(arRes.user.balance) > 0)
          detected.balance = arRes.user.balance;
        return { result: "success", note: note || "Logged in.", tabId, detected };
      }
      // On the app route but not logged in -> likely bounced; loop will catch ar-login.
      await sleep(T(1500));
      continue;
    }

    // Unknown / CAPTCHA / other -> give it a moment, then bail to manual.
    await sleep(1500);
    const again = await getTab(tabId);
    if (again && classifyUrl(again.url || "") === "other")
      return { result: "needs-attention", note: "Unexpected page (possibly a CAPTCHA) - finish in the open tab.", tabId };
  }

  return { result: "needs-attention", note: "Login didn't complete in time - finish in the open tab.", tabId };
}

// Run several accounts back to back. onProgress({ accountId, phase, result }).
export async function runAllAccounts(accounts, opts = {}, onProgress = () => {}) {
  const results = {};
  const scale = Math.max(1, Number(opts.timeoutScale) || 1);
  // Every tab this run opens: the login tab per account (registered by
  // runAccountLogin) plus anything those tabs spawn themselves (OAuth pop-outs,
  // redirects into a new tab) - found via openerTabId. Swept at the end.
  const runTabs = new Set();
  const keepOpen = new Set(); // tabs of accounts that need the user (CAPTCHA/2FA)
  const onTabCreated = (t) => { if (t && t.openerTabId != null && runTabs.has(t.openerTabId)) runTabs.add(t.id); };
  chrome.tabs.onCreated.addListener(onTabCreated);
  opts = { ...opts, tabRegistry: runTabs };
  startKeepAlive();
  try {
    for (const acc of accounts) {
      // Selection (mode/enabled gating) is the background's job now - this
      // runner logs in every account it is handed.
      onProgress({ accountId: acc.id, phase: "start" });
      let outcome;
      try {
        outcome = await runAccountLogin(acc, opts);
      } catch (e) {
        outcome = { result: "failed", note: String(e && e.message ? e.message : e) };
      }
      results[acc.id] = outcome;
      onProgress({
        accountId: acc.id,
        phase: "done",
        result: outcome.result,
        note: outcome.note,
        detected: outcome.detected,
      });

      // Close the tab right away on success; a tab that needs the user stays.
      if (outcome.result === "needs-attention" && outcome.tabId) keepOpen.add(outcome.tabId);
      if (outcome.result === "success" && outcome.tabId && !opts.keepTabs) {
        try {
          await chrome.tabs.remove(outcome.tabId);
        } catch (e) {}
      }
      // Small human-ish gap between accounts, stretched on slow connections.
      await sleep(rand(Math.round(1500 * scale), Math.round(3500 * scale)));
    }
  } finally {
    chrome.tabs.onCreated.removeListener(onTabCreated);
    // End-of-run sweep (auto AND manual runs): close every tab the run opened -
    // including ones Agent Router/GitHub opened themselves - except tabs of an
    // account that needs the user. Skipped only when the user chose to keep tabs.
    if (!opts.keepTabs) {
      for (const id of runTabs) {
        if (keepOpen.has(id)) continue;
        try { await chrome.tabs.remove(id); } catch (e) {} // already closed is fine
      }
    }
    stopKeepAlive();
  }
  return results;
}
