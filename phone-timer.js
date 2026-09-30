// Phone shortcut helper (Options > ClickUp setup > "Start or stop the timer from
// your phone").
//
// A toggle on the phone that starts / stops the ClickUp timer, built from the same
// three API calls this extension already makes (lib-clickup getCurrentTimeEntry /
// startTimer / stopTimer). The phone talks to ClickUp DIRECTLY, so nothing has to
// run on the computer: a timer started from the phone is an ordinary ClickUp
// timer, and the extension picks it up on its next sync (up to the sync interval,
// or immediately if the popup is opened) - "Tracking now", the estimate alerts,
// the tracked totals and the badge all follow on their own.
//
// Deliberately timer-only: the desktop keyboard shortcut (Alt+Shift+1) also flips
// the ClickUp status and refreshes the extension itself, which a phone cannot do.
// The status is left alone here, and the card says so.
//
// No secret is stored or logged by this file. The ids come from
// CLICKUP_PHONE_SETUP; the token is only ever fetched by CLICKUP_PHONE_TOKEN when
// the owner presses "Copy my token", and is kept in a local variable for the copy.
(function () {
  "use strict";

  var API = "https://api.clickup.com/api/v2";
  var ROOT = "https://app.clickup.com/t/";

  function $(id) { return document.getElementById(id); }
  function send(msg, timeout) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          const e = chrome.runtime.lastError;
          if (e) return reject(new Error(e.message || "no response"));
          resolve(r || null);
        });
      } catch (e) { reject(e); }
    });
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return Promise.reject(new Error("clipboard not available"));
  }

  // ---------- pure helpers (unit-tested in dev-tools/t_phone_timer.js) ----------

  // The three requests a toggle needs, for one workspace.
  function ptUrls(ws) {
    const b = API + "/team/" + encodeURIComponent(String(ws || "")) + "/time_entries";
    return { current: b + "/current", start: b + "/start", stop: b + "/stop" };
  }

  // Does the reply to /time_entries/current mean a timer is running? ClickUp sends
  // the live entry as data.task, and an empty data (or an error body) when nothing
  // runs, so "no task id" is the only reliable test - the same one
  // getCurrentTimeEntry makes in lib-clickup.
  function ptRunningTaskId(reply) {
    if (reply == null) return "";
    if (typeof reply === "string") {
      try { reply = JSON.parse(reply); } catch (e) { return ""; }
    }
    const t = reply && reply.data && reply.data.task;
    return t && t.id != null && String(t.id) ? String(t.id) : "";
  }
  function ptRunningTaskName(reply) {
    if (typeof reply === "string") { try { reply = JSON.parse(reply); } catch (e) { return ""; } }
    const t = reply && reply.data && reply.data.task;
    return (t && t.name) || "";
  }

  // What a toggle should do next: "stop" when something is running, else "start".
  function ptTogglePlan(reply) {
    return ptRunningTaskId(reply) ? "stop" : "start";
  }

  // The body ClickUp wants for each action.
  function ptBody(action, taskId) {
    return action === "start" ? JSON.stringify({ tid: String(taskId || "") }) : "{}";
  }

  // ---------- the copy-paste setup blocks ----------

  function ptHeader(info) {
    return [
      "ClickUp timer from your phone",
      "------------------------------",
      "",
      "Your values (already filled in):",
      "  Workspace ID:  " + info.workspaceId,
      "  Extra Task ID: " + info.extraTaskId + (info.extraTaskName ? "  (" + info.extraTaskName + ")" : ""),
      "  Extra Task:    " + (info.extraTaskUrl || (info.extraTaskId ? ROOT + info.extraTaskId : "")),
      "",
      "The token is NOT in this text (that is on purpose). Press \"Copy my token\"",
      "in the extension and paste it where the steps below say <your token>.",
      "A ClickUp token is a full-access key for your account: on iPhone it lives",
      "inside the shortcut (iCloud-synced), on Android inside the app. Do not share",
      "the shortcut, and revoke the token in ClickUp if you ever do.",
      "",
    ].join("\n");
  }

  function ptIosText(info) {
    const u = ptUrls(info.workspaceId);
    return ptHeader(info) + [
      "iPhone - the built-in Shortcuts app",
      "--------------------------------",
      "Two shortcuts, one tap each. The stop one works whatever is running.",
      "",
      "START:",
      "1. Open Shortcuts > + (top right) > name it \"ClickUp start\".",
      "2. Add Action > search \"Get Contents of URL\".",
      "3. Fill in:",
      "     URL     " + u.start,
      "     Method  POST",
      "     Headers  Authorization      = <your token>",
      "              Content-Type      = application/json",
      "     Body    JSON > " + ptBody("start", info.extraTaskId),
      "4. Tap the play arrow at the top to try it. Your timer should start.",
      "5. Long-press the shortcut > Add to Home Screen.",
      "",
      "STOP:",
      "6. Tap \"ClickUp start\" > ... > Duplicate. Name the copy \"ClickUp stop\".",
      "7. In the copy change only these two things:",
      "     URL     " + u.stop,
      "     Body    JSON > " + ptBody("stop"),
      "8. Add it to the Home Screen as well.",
      "",
      "Check it worked:",
      "9. Open ClickUp (app or website): your Extra Task should show a running",
      "   timer, and the same thing appears in this extension on its next sync or",
      "   as soon as you open the popup.",
      "",
    ].join("\n");
  }

  function ptAndroidText(info) {
    const u = ptUrls(info.workspaceId);
    return ptHeader(info) + [
      "Android - HTTP Shortcuts (free, open source, from F-Droid)",
      "-----------------------------------------------------------",
      "Two shortcuts, one tap each. It has no if/else, so start and stop are",
      "separate - which also means one request per tap instead of two.",
      "",
      "1. Install \"HTTP Shortcuts\" from F-Droid.",
      "2. In the app: Settings > Variables > + > Text, three times:",
      "     cuToken   = <your token>",
      "     cuWs      = " + info.workspaceId,
      "     cuTask    = " + info.extraTaskId,
      "3. Shortcuts > + > name \"ClickUp start\" > tap the shortcut > HTTP Request.",
      "     Method  POST",
      "     URL     " + u.start,
      "     Headers  Authorization = $cuToken",
      "             Content-Type = application/json",
      "     Body    JSON > {\"tid\":\"$cuTask\"}",
      "     (the two $variables are used as typed; the URL above already has the",
      "      workspace id filled in, so it works even before you add the variables)",
      "4. + again for \"ClickUp stop\", same headers, and:",
      "     URL     " + u.stop,
      "     Body    JSON > {}",
      "5. Long-press each shortcut > Add to Home Screen.",
      "",
      "MacroDroid can do it as ONE icon (it has if/else): a Macro with",
      "HTTP Request (GET " + u.current + ", header Authorization $cuToken) >",
      "Parse JSON > if the task id is empty then HTTP Request POST start,",
      "else HTTP Request POST stop.",
      "",
    ].join("\n");
  }

  function ptOneIconText(info) {
    const u = ptUrls(info.workspaceId);
    return [
      "Optional: one icon that toggles",
      "------------------------------",
      "Every request needs the same two headers:",
      "  Authorization     = <your token>",
      "  Content-Type      = application/json",
      "",
      "Ask first (GET " + u.current + "), then:",
      "  the reply has data.task.id  -> POST " + u.stop + "   body {}",
      "  it is empty                  -> POST " + u.start + "   body " + ptBody("start", info.extraTaskId),
      "iPhone: add \"Get Dictionary Value\" on the reply (key data.task.id) and wrap",
      "the two POSTs in If / Otherwise.",
      "This costs 2 requests per tap instead of 1.",
      "",
    ].join("\n");
  }

  // ---------- UI ----------

  var info = null;      // ids from the worker (no secret)
  var token = "";      // only after an explicit "Copy my token"

  function say(text, bad) {
    const el = $("ptMsg");
    if (!el) return;
    el.textContent = text || "";
    el.style.color = bad ? "var(--red, #dc2626)" : "";
  }
  function flash(btn, text) {
    if (!btn) return;
    const was = btn.textContent;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = was; }, 1400);
  }
  async function copyBtn(btn, text, okMsg) {
    try {
      await copy(text);
      say(okMsg || "Copied ✓");
      flash(btn, "Copied ✓");
    } catch (e) {
      say("Couldn't copy: " + (e && e.message ? e.message : e), true);
    }
  }

  function render() {
    if (!info || !info.ok) return; // the card itself is shown by .cu-needs-config
    const ws = $("ptWs"), task = $("ptTask"), name = $("ptTaskName");
    if (!ws || !task) return;
    ws.textContent = info.workspaceId || "not set yet";
    if (info.extraTaskId) {
      task.textContent = info.extraTaskId;
      if (name) {
        name.textContent = info.extraTaskName ? "Extra Task: " + info.extraTaskName : "";
        const a = $("ptTaskLink");
        if (a) { a.href = info.extraTaskUrl || ROOT + info.extraTaskId; a.style.display = ""; }
      }
    } else {
      task.textContent = "not found yet";
      if (name) name.textContent = "The Extra Task is found automatically. Open the popup once, or start any task, then reload this page.";
    }
    const more = $("ptMore");
    if (more) {
      more.textContent = "";
      const pre = document.createElement("pre");
      pre.className = "pt-pre";
      pre.textContent = ptOneIconText(info);
      more.appendChild(pre);
    }
  }

  async function load() {
    try {
      info = await send({ type: "CLICKUP_PHONE_SETUP" });
    } catch (e) {
      info = { ok: false, reason: String(e && e.message ? e.message : e) };
    }
    render();
  }

  async function needToken() {
    if (token) return token;
    say("Reading your token from the extension…");
    let r = null;
    try { r = await send({ type: "CLICKUP_PHONE_TOKEN" }); } catch (e) { r = null; }
    if (!r || !r.ok || !r.token) { say("Couldn't get the token - is ClickUp connected?", true); return ""; }
    token = r.token;
    return token;
  }

  // One real call to /time_entries/current, so a problem with the token or the
  // workspace id shows up here instead of on the phone.
  async function test() {
    if (!info || !info.ok) { load(); return; }
    const t = await needToken();
    if (!t) return;
    if (!info.workspaceId) { say("No workspace id yet - pick your workspace in ClickUp setup first.", true); return; }
    say("Asking ClickUp…");
    let reply = null, err = "";
    try {
      const res = await fetch(ptUrls(info.workspaceId).current, { headers: { Authorization: t } });
      const text = await res.text();
      if (res.status === 401 || res.status === 403) { err = "ClickUp rejected the token."; token = ""; } // revoked, or a new one was saved
      else if (!res.ok) err = "ClickUp answered HTTP " + res.status + ".";
      else reply = text;
    } catch (e) { err = "Couldn't reach ClickUp: " + (e && e.message ? e.message : e); }
    if (err) { say(err + " Check the token in ClickUp > Apps > API.", true); return; }
    const id = ptRunningTaskId(reply);
    if (id) say("Token works ✓ Timer running on " + (ptRunningTaskName(reply) || "a task") + " (" + id + ").");
    else say("Token works ✓ Nothing is running right now, so the start button in your shortcut would start the timer.");
  }

  function on(id, fn) { const el = $(id); if (el) el.onclick = fn; }

  // Handlers read info at click time, so they bind before the ids arrive.
  function bind() {
    on("ptCopyWs", (e) => copyBtn(e.currentTarget, info.workspaceId || "", "Workspace ID copied ✓"));
    on("ptCopyTask", (e) => copyBtn(e.currentTarget, info.extraTaskId || "", info.extraTaskId ? "Extra Task ID copied ✓" : "No Extra Task found yet."));
    on("ptCopyIos", (e) => copyBtn(e.currentTarget, ptIosText(info), "iPhone steps copied ✓ Paste them into a note, then follow along."));
    on("ptCopyAndroid", (e) => copyBtn(e.currentTarget, ptAndroidText(info), "Android steps copied ✓ Paste them into a note, then follow along."));
    on("ptCopyToken", async (e) => {
      const t = await needToken();
      if (!t) return;
      await copyBtn(e.currentTarget, t, "Token copied ✓ Paste it into your shortcut; revoke it in ClickUp > Apps > API if it ever leaks.");
    });
    on("ptTest", test);
  }

  function boot() {
    if (!$("ptCard")) return;
    bind();
    load();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // Exposed for the unit test only (the page uses the module's own functions).
  window.PcmPhoneTimer = { urls: ptUrls, runningTaskId: ptRunningTaskId, runningTaskName: ptRunningTaskName, togglePlan: ptTogglePlan, body: ptBody, iosText: ptIosText, androidText: ptAndroidText, oneIconText: ptOneIconText };
})();
