// Client notices: instructions a client sent through its Slack channel ("hold off
// any changes from Wednesday", "focus on backlinks", a launch date...), found by
// the background's 20-minute Slack check or by a teammate's (team hub). Here:
//  - a "Client notices" card at the top of the Dashboard: what the client said,
//    from when, Open in Slack, and that client's open tasks it touches, each
//    with "Due → <day before>" (nothing changes in ClickUp unless clicked);
//  - a ⚠ pill on those tasks in every list (dashboard, popup, side panel);
//  - a short banner in the popup / side panel;
//  - with Chrome's built-in AI: a one-line summary, the exact dates and which
//    tasks change the site - read once per notice and shared with the team.
(() => {
  "use strict";
  if (window.PcmClientNotices) return;
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const key = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const DAY = 86400000;
  const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const KINDS = {
    freeze: { icon: "⛔", label: "No site changes" }, focus: { icon: "🎯", label: "New focus" }, pause: { icon: "⏸", label: "Work paused" },
    deadline: { icon: "⏰", label: "Deadline" }, approval: { icon: "✋", label: "Waiting on approval" }, access: { icon: "🔑", label: "Access change" },
    other: { icon: "📣", label: "Client instruction" },
  };
  const kindOf = (n) => KINDS[n.kind] || (n.ai ? KINDS.other : { icon: "⚠️", label: "Possible client instruction" });

  let notices = [], dismissed = {}, openTasks = null, tasksAsked = false;
  // Showing: not hidden here, not judged unimportant, and still current - until a
  // week after its last date, or two weeks after it was posted when it names none.
  // ...and only for clients I have open tasks for (assigned to me) - none until those are known.
  function active() {
    const now = Date.now();
    const cur = notices.filter((n) => n && !dismissed[n.id] && n.important !== false &&
      ((n.untilMs ? n.untilMs + DAY : n.fromMs ? n.fromMs + 14 * DAY : Number(n.at) + 14 * DAY) > now));
    if (!cur.length) return [];
    if (!openTasks) { if (!tasksAsked) loadTasks(); return []; } // my tasks are only looked up while a notice is current
    return cur.filter((n) => openTasks.some((t) => sameClient(t, n.client)));
  }
  // The client a task belongs to (its client label or list name) - letters and
  // digits only, so "Acme Roofing", "Acme Roofing SEO" and "🔥 ACME-ROOFING" match.
  function sameClient(t, client) {
    const k = key(client);
    if (k.length < 3 || !t) return false;
    for (const n of [t.client, t.container && t.container.listName]) {
      const x = key(n);
      if (x && (x === k || (x.length >= 4 && k.length >= 4 && (x.startsWith(k) || k.startsWith(x))))) return true;
    }
    return false;
  }
  // The open tasks a notice touches: that client's, due on or after its start
  // date (or with no due date). When the AI picked the site-changing ones, those.
  function touches(n, t) {
    if (!t || t.done || !sameClient(t, n.client)) return false;
    if (n.ai && Array.isArray(n.onsite) && n.onsite.length && !n.onsite.includes(String(t.id))) return false;
    if (!n.fromMs) return true;
    const due = Number(t.dueDateMs) || 0;
    return !due || dayStart(due) >= dayStart(n.fromMs);
  }
  const noticeFor = (t) => active().find((n) => touches(n, t)) || null;
  // The working day before a date (Friday for a Monday).
  function dayBefore(ms) { const d = new Date(dayStart(ms)); do d.setDate(d.getDate() - 1); while (d.getDay() === 0 || d.getDay() === 6); return d.getTime(); }
  const shown = (t) => String(t || "").replace(/(?:@someone\b[ \t,]*)+/g, "").replace(/[*_~]{1,2}([^*_~\n]+)[*_~]{1,2}/g, "$1");
  // In a line: the AI's summary, else the client's own words (after "Client message:"), without @tags or *bold*.
  function say(n) {
    if (n.summary) return shown(n.summary).replace(/\s+/g, " ").trim();
    let t = String(n.text || "");
    const m = t.match(/client(?:'s)?\s+(?:message|email|said|says|wrote|request)\s*\**\s*:\s*\**([\s\S]+)/i);
    if (m) t = m[1];
    return t.replace(/@(channel|here|everyone|someone)\b/g, "").replace(/[*_~]/g, "").replace(/^\s*(hi|hello|hey|dear)\b[^\n]*\n/i, "").replace(/\s+/g, " ").trim();
  }

  const when = (n) => (n.fromMs ? "from " + fmtDay(n.fromMs) : "") + (n.untilMs ? " until " + fmtDay(n.untilMs) : n.fromMs && /until further notice/i.test(n.text || "") ? " until further notice" : "");

  // ---------- pills on task rows ----------
  function paintRow(row) {
    const t = row._cuTask;
    const n = t ? noticeFor(t) : null;
    let pill = row.querySelector(".pcm-cnote-pill");
    if (!n) { if (pill) pill.remove(); return; }
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "pcm-cnote-pill";
      const nm = row.querySelector(".nm");
      if (nm && nm.parentElement) nm.after(pill); else row.appendChild(pill);
    }
    const k = kindOf(n);
    const html = "<b>⚠</b><span class=\"t\"> " + esc(k.label) + "</span>";
    if (pill.innerHTML !== html) pill.innerHTML = html;
    pill.title = n.client + " - " + k.label + (when(n) ? " " + when(n) : "") + ":\n" + say(n).slice(0, 300) + "\n\nClick for the details (Dashboard › Client notices).";
    pill.dataset.cnote = n.id;
  }
  let queued = false;
  function paint() {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; document.querySelectorAll(".cu-task").forEach((row) => { if (row._cuTask || row.querySelector(".pcm-cnote-pill")) paintRow(row); }); paintCard(); paintBanner(); }, 60);
  }
  document.addEventListener("click", (e) => {
    const pill = e.target && e.target.closest && e.target.closest(".pcm-cnote-pill");
    if (!pill) return;
    e.preventDefault(); e.stopPropagation();
    openCard(pill.dataset.cnote);
  }, true);
  function openCard(id) {
    const card = document.getElementById("cnoteCard");
    if (card) { const tab = document.querySelector('[data-tab="dashboard"], [data-goto="dashboard"]'); if (tab && !card.offsetParent) tab.click(); card.scrollIntoView({ behavior: "smooth", block: "start" }); const it = id && card.querySelector('[data-cn="' + CSS.escape(id) + '"]'); if (it) { it.classList.add("flash"); setTimeout(() => it.classList.remove("flash"), 1600); } return; }
    try { chrome.tabs.create({ url: chrome.runtime.getURL("options.html#dashboard") }); } catch (e) {}
  }

  // ---------- Dashboard card (Options) ----------
  function cardHost() {
    let host = document.getElementById("cnoteCard");
    if (host) return host;
    const dash = document.querySelector('section.panel[data-panel="dashboard"]');
    if (!dash) return null;
    host = document.createElement("div");
    host.id = "cnoteCard";
    host.className = "card cnote-card";
    const empty = document.getElementById("cuDashEmpty");
    if (empty) empty.after(host); else dash.prepend(host);
    host.addEventListener("click", onCardClick);
    return host;
  }
  function paintCard() {
    const host = cardHost();
    if (!host) return;
    const list = active();
    if (!list.length) { host.hidden = true; host.innerHTML = ""; lastCard = ""; return; }
    host.hidden = false;
    const items = list.map((n) => {
      const k = kindOf(n);
      const tasks = (openTasks || []).filter((t) => touches(n, t)).sort((a, b) => (Number(a.dueDateMs) || 9e15) - (Number(b.dueDateMs) || 9e15)).slice(0, 12);
      const before = n.fromMs ? dayBefore(n.fromMs) : 0;
      const taskRows = openTasks == null ? '<div class="hint">Looking up ' + esc(n.client) + "'s open tasks…</div>"
        : !tasks.length ? '<div class="hint">None of your open ' + esc(n.client) + " tasks " + (n.fromMs ? "fall on or after " + esc(fmtDay(n.fromMs)) : "are open") + ".</div>"
        : '<div class="cn-tasks"><div class="hint">' + (n.ai && n.onsite && n.onsite.length ? "Your tasks that change the site" : "Your open " + esc(n.client) + " tasks") + (n.fromMs ? " due " + esc(fmtDay(n.fromMs)) + " or later (or with no due date)" : "") + ":</div>" +
          tasks.map((t) => '<div class="cn-task"><a href="' + esc(t.url || "#") + '" target="_blank" rel="noopener">' + esc(t.name) + "</a>" +
            ' <span class="hint">' + (t.dueDateMs ? "due " + esc(fmtDay(Number(t.dueDateMs))) : "no due date") + "</span>" +
            (before && before >= dayStart(Date.now()) ? ' <button type="button" class="cn-btn" data-cn-due="' + esc(t.id) + '" data-cn-ms="' + before + '" data-cn-was="' + (Number(t.dueDateMs) || 0) + '" title="Set its due date to ' + esc(fmtDay(before)) + ' in ClickUp, so it\'s done before the client\'s date">Due → ' + esc(fmtDay(before)) + "</button>" : "") + "</div>").join("") + "</div>";
      return '<div class="cn-item" data-cn="' + esc(n.id) + '"><div class="cn-head"><span class="cn-kind">' + k.icon + " " + esc(k.label) + "</span> <b>" + esc(n.client) + "</b>" +
        (when(n) ? ' <span class="cn-when">' + esc(when(n)) + "</span>" : "") +
        ' <span class="hint">' + esc(new Date(Number(n.at)).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + (n.by ? " · found by " + esc(n.by) : "") + "</span></div>" +
        '<div class="cn-sum">' + esc(say(n)) + "</div>" +
        '<details class="cn-msg"><summary>The whole Slack message</summary><div class="cn-text">' + esc(shown(n.text)) + "</div></details>" +
        taskRows +
        '<div class="cn-acts">' + (n.permalink ? '<a class="cn-btn" href="' + esc(n.permalink) + '" target="_blank" rel="noopener">Open in Slack</a>' : "") +
        '<button type="button" class="cn-btn" data-cn-hide="' + esc(n.id) + '" title="Hide it on this computer">Got it - hide</button>' +
        '<button type="button" class="cn-btn" data-cn-noimp="' + esc(n.id) + '" title="Not a client instruction - hide it">Not important</button></div></div>';
    });
    const html = '<div class="cn-top"><h2>⚠️ Client notices <span class="hint">(from the clients\' Slack channels)</span></h2>' +
      '<button type="button" class="cn-btn" data-cn-refresh="1" title="Look in the client channels now">Check Slack now</button></div>' + items.join("");
    if (html !== lastCard) { lastCard = html; host.innerHTML = html; }
  }
  let lastCard = "";
  async function onCardClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.cnHide || b.dataset.cnNoimp) {
      dismissed[b.dataset.cnHide || b.dataset.cnNoimp] = b.dataset.cnNoimp ? "noimp" : Date.now();
      try { await chrome.storage.local.set({ cnoteDismissed: dismissed }); } catch (err) {}
      paint();
      return;
    }
    if (b.dataset.cnRefresh) {
      b.disabled = true; b.textContent = "Checking…";
      const r = await send({ type: "CNOTE_REFRESH" });
      b.disabled = false; b.textContent = r && r.ok === false && r.error ? "Couldn't: " + String(r.error).slice(0, 60) : "Checked ✓";
      return;
    }
    if (b.dataset.cnDue) {
      const was = Number(b.dataset.cnWas) || 0, d = new Date(Number(b.dataset.cnMs));
      if (was) { const w = new Date(was); d.setHours(w.getHours(), w.getMinutes(), 0, 0); } else d.setHours(17, 0, 0, 0);
      b.disabled = true; b.textContent = "Saving…";
      const r = await send({ type: "CLICKUP_SET_DUE", taskId: b.dataset.cnDue, dueMs: d.getTime() });
      if (r && r.ok) { b.textContent = "Moved ✓"; const t = (openTasks || []).find((x) => String(x.id) === b.dataset.cnDue); if (t) t.dueDateMs = d.getTime(); send({ type: "CNOTE_TASKS", force: true }); setTimeout(paint, 1200); }
      else { b.disabled = false; b.textContent = "Couldn't - try again"; b.title = (r && (r.error || r.reason)) || "no answer"; }
    }
  }
  function loadTasks() {
    tasksAsked = true;
    send({ type: "CNOTE_TASKS" }).then((r) => {
      openTasks = r && r.ok && Array.isArray(r.tasks) ? r.tasks : [];
      paint();
      runAi();
    });
  }

  // ---------- popup / side panel banner ----------
  function paintBanner() {
    if (document.getElementById("cnoteCard") || document.querySelector('section.panel[data-panel="dashboard"]')) return; // Options has the card
    let host = document.getElementById("cnoteBar");
    const list = active().slice(0, 2);
    if (!host) {
      if (!list.length) return;
      host = document.createElement("div"); host.id = "cnoteBar";
      const anchor = document.getElementById("pcmNoticeBar") || document.querySelector(".status-row");
      const header = document.querySelector(".header");
      if (anchor) anchor.before(host); else if (header) header.after(host); else return;
      host.addEventListener("click", (e) => { const a = e.target.closest("[data-cn-open]"); if (a) { e.preventDefault(); openCard(a.dataset.cnOpen); } });
    }
    host.innerHTML = list.map((n) => { const k = kindOf(n); return '<div class="cn-bar"><span>' + k.icon + '</span><div class="tx"><b>' + esc(n.client) + ": " + esc(k.label) + (when(n) ? " " + esc(when(n)) : "") + "</b>" + esc(say(n).slice(0, 140)) + '</div><a href="#" data-cn-open="' + esc(n.id) + '">Details</a></div>'; }).join("");
  }

  // ---------- Chrome's built-in AI: what the notice says ----------
  const AI_TRIED = "pcm.cnoteAiTried";
  const tried = () => { try { return JSON.parse(localStorage.getItem(AI_TRIED) || "{}"); } catch (e) { return {}; } };
  let aiBusy = false;
  async function runAi() {
    if (aiBusy || typeof LanguageModel === "undefined" || openTasks == null) return;
    const todo = active().filter((n) => !n.ai && !tried()[n.id]);
    if (!todo.length) return;
    let avail = "unavailable";
    try { avail = await LanguageModel.availability({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] }); } catch (e) {}
    if (avail !== "available") return; // never starts a model download by itself
    aiBusy = true;
    try {
      for (const n of todo.slice(0, 3)) {
        const t = tried(); t[n.id] = Date.now();
        try { localStorage.setItem(AI_TRIED, JSON.stringify(t)); } catch (e) {}
        const tasks = (openTasks || []).filter((x) => sameClient(x, n.client)).slice(0, 30);
        const a = await aiRead(n, tasks).catch(() => null);
        if (!a) continue;
        a.onsite = (Array.isArray(a.siteTasks) ? a.siteTasks : []).map((i) => tasks[Number(i) - 1]).filter(Boolean).map((x) => String(x.id));
        await send({ type: "CNOTE_AI", id: n.id, ai: a });
      }
    } finally { aiBusy = false; }
  }
  const AI_SCHEMA = {
    type: "object", required: ["important", "kind", "summary", "from", "until", "siteTasks"],
    properties: {
      important: { type: "boolean" },
      kind: { type: "string", enum: ["freeze", "focus", "pause", "deadline", "approval", "access", "other", "none"] },
      summary: { type: "string" }, from: { type: "string" }, until: { type: "string" },
      siteTasks: { type: "array", items: { type: "integer" } },
    },
  };
  async function aiRead(n, tasks) {
    const ymd = (ms) => { const d = new Date(ms); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
    const prompt = "A message was posted in the Slack channel of our client \"" + n.client + "\" on " + new Date(Number(n.at)).toDateString() + " (" + ymd(Number(n.at)) + ").\n" +
      "Decide if it carries an instruction from the client that changes what our team should do or when (stop or hold work, no changes to the website from a date, a new priority, a deadline or launch date, waiting for approval, a change of access or developer).\n" +
      "kind: freeze = no website changes; focus = work on something else instead; pause = stop work; deadline; approval; access; other; none = not an instruction (then important=false).\n" +
      "summary: one short sentence, plain words, what the team must do, with the date.\n" +
      "from / until: the dates it applies, as YYYY-MM-DD, worked out from the posting date (\"this Wednesday\" = the next Wednesday after it); \"\" when none.\n" +
      "siteTasks: the numbers of the tasks below that change the client's website (content edits, pages, plugins, speed, schema, redirects...) and so are affected by a freeze; [] when none.\n\n" +
      "Message:\n" + shown(n.text).slice(0, 1500) + "\n\nOpen tasks:\n" + (tasks.length ? tasks.map((t, i) => (i + 1) + ". " + t.name).join("\n") : "(none)");
    const s = await LanguageModel.create({ expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] });
    try {
      let out;
      try { out = await s.prompt(prompt, { responseConstraint: AI_SCHEMA }); }
      catch (e) { out = await s.prompt(prompt + "\n\nAnswer with JSON only: {\"important\":true,\"kind\":\"\",\"summary\":\"\",\"from\":\"\",\"until\":\"\",\"siteTasks\":[]}"); }
      const m = String(out || "").match(/\{[\s\S]*\}/);
      const j = m ? JSON.parse(m[0]) : null;
      if (!j || typeof j !== "object") return null;
      if (j.kind === "none") j.important = false;
      const okDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
      return { important: j.important !== false, kind: KINDS[j.kind] ? j.kind : j.kind === "none" ? "none" : "other", summary: String(j.summary || "").slice(0, 300), from: okDay(j.from), until: okDay(j.until), siteTasks: j.siteTasks };
    } finally { try { s.destroy(); } catch (e) {} }
  }

  // ---------- styles, loading ----------
  const css = document.createElement("style");
  css.textContent = `
  .pcm-cnote-pill { flex: none; margin-left: 4px; padding: 0 5px; border-radius: 999px; font-size: 10.5px; font-weight: 700; line-height: 1.6; white-space: nowrap; cursor: pointer;
    color: #9a3412; background: rgba(234, 88, 12, .14); border: 1px solid rgba(234, 88, 12, .45); }
  html[data-theme="dark"] .pcm-cnote-pill { color: #fdba74; background: rgba(234, 88, 12, .16); }
  @container cutl (max-width: 560px) { .pcm-cnote-pill .t { display: none; } }
  .cnote-card { border-color: rgba(234, 88, 12, .45) !important; }
  .cnote-card[hidden] { display: none !important; }
  .cnote-card .cn-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cnote-card .cn-top h2 { margin: 0; flex: 1; font-size: 15px; }
  .cnote-card .cn-item { border-top: 1px solid var(--border); padding: 10px 0 4px; margin-top: 8px; border-radius: 6px; transition: background .4s; }
  .cnote-card .cn-item.flash { background: rgba(234, 88, 12, .12); }
  .cnote-card .cn-head { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 13px; }
  .cnote-card .cn-kind { font-weight: 700; color: #c2410c; }
  html[data-theme="dark"] .cnote-card .cn-kind { color: #fdba74; }
  .cnote-card .cn-when { font-weight: 600; }
  .cnote-card .cn-sum { margin: 4px 0; font-size: 13px; }
  .cnote-card .cn-msg { margin: 4px 0; font-size: 12px; }
  .cnote-card .cn-msg summary { cursor: pointer; color: var(--muted); }
  .cnote-card .cn-text { white-space: pre-line; overflow-wrap: anywhere; padding: 6px 10px; margin-top: 4px; border-left: 3px solid rgba(234, 88, 12, .45); color: var(--text); max-height: 220px; overflow: auto; }
  .cnote-card .cn-tasks { margin: 6px 0; display: grid; gap: 4px; font-size: 12.5px; }
  .cnote-card .cn-task { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .cnote-card .cn-task a { color: var(--text); }
  .cnote-card .cn-acts { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
  .cnote-card .cn-btn, .cn-bar a { font: inherit; font-size: 11.5px; padding: 2px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; text-decoration: none; }
  .cn-bar { display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border-radius: 10px; margin: 0 0 10px; font-size: 12px; line-height: 1.45; border: 1px solid rgba(234, 88, 12, .45); background: rgba(234, 88, 12, .1); }
  .cn-bar .tx { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .cn-bar b { display: block; }`;
  (document.head || document.documentElement).appendChild(css);

  async function load() {
    try {
      const g = await chrome.storage.local.get(["clientNotices", "cnoteDismissed"]);
      notices = (g.clientNotices && Array.isArray(g.clientNotices.list)) ? g.clientNotices.list : [];
      dismissed = g.cnoteDismissed && typeof g.cnoteDismissed === "object" ? g.cnoteDismissed : {};
    } catch (e) {}
    paint();
  }
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== "local") return;
      if (ch.clientNotices) { notices = (ch.clientNotices.newValue && ch.clientNotices.newValue.list) || []; paint(); runAi(); }
      if (ch.cnoteDismissed) { dismissed = ch.cnoteDismissed.newValue || {}; paint(); }
    });
  } catch (e) {}
  const mo = new MutationObserver((recs) => { if (recs.some((r) => [...r.addedNodes].some((x) => x.nodeType === 1 && !(x.closest && x.closest("#cnoteCard, #cnoteBar, .pcm-cnote-pill"))))) paint(); });
  const start = () => { mo.observe(document.body, { childList: true, subtree: true }); load(); };
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
  window.PcmClientNotices = { get list() { return active(); }, noticeFor, touches, sameClient, dayBefore, refresh: load };
})();
