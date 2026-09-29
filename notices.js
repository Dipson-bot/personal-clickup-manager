// Notices from the admin (maintenance break, sudden holiday, anything urgent):
//  - a banner at the top of the dashboard, popup and side panel while a notice is
//    active (each one can be dismissed on this computer),
//  - the full list in Options > Help & issues, where the admin also posts and ends
//    them.
// Notices live in the Team hub (the admin's Google Apps Script); the background
// checks for them every 10 minutes and keeps them in storage (hubNotices).
(() => {
  "use strict";
  const DISMISS_KEY = "pcm.noticesDismissed";
  const LEVELS = { info: { label: "Info", icon: "📢" }, important: { label: "Important", icon: "⚠️" }, urgent: { label: "Urgent", icon: "🚨" } };
  const send = (msg) => new Promise((res) => { try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } });
  const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
  const fmtUntil = (ms) => new Date(ms).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const dismissed = () => { try { return JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]"); } catch (e) { return []; } };
  const dismiss = (id) => { try { localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed().concat(id).slice(-50))); } catch (e) {} };

  const css = document.createElement("style");
  css.textContent = `
    .pnt-bar { display: flex; align-items: flex-start; gap: 10px; padding: 9px 12px; border-radius: 10px; margin: 0 0 12px; font-size: 12.5px; line-height: 1.45; border: 1px solid; }
    .pnt-bar b { display: block; font-size: 13px; }
    .pnt-bar .tx { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-line; }
    .pnt-bar .x { flex: none; border: 0; background: none; cursor: pointer; color: inherit; opacity: .7; font-size: 14px; }
    .pnt-info { background: rgba(99,102,241,.1); border-color: rgba(99,102,241,.35); }
    .pnt-important { background: rgba(217,119,6,.12); border-color: rgba(217,119,6,.45); }
    .pnt-urgent { background: rgba(220,38,38,.12); border-color: rgba(220,38,38,.5); }
    .pnt-list { display: grid; gap: 8px; margin: 0 0 14px; }
    .pnt-list .meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .pnt-list .end { flex: none; font: inherit; font-size: 11.5px; padding: 2px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; }
    .pnt-form { border: 1px dashed var(--border); border-radius: 10px; padding: 10px 12px; margin: 0 0 16px; display: grid; gap: 7px; }
    .pnt-form h3 { margin: 0; font-size: 13px; }
    .pnt-form input, .pnt-form textarea, .pnt-form select { font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg2, transparent); color: var(--text); color-scheme: light dark; }
    .pnt-form textarea { min-height: 54px; resize: vertical; }
    .pnt-form .row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .pnt-form .row label { font-size: 12px; color: var(--muted); }
    .pnt-form .post { font: inherit; font-size: 12.5px; font-weight: 600; padding: 5px 14px; border-radius: 7px; border: 1px solid var(--indigo, #6366f1); background: var(--indigo, #6366f1); color: #fff; cursor: pointer; margin-left: auto; }
    .pnt-form .msg { font-size: 11.5px; color: var(--muted); }
    .pnt-form .msg.err { color: var(--red, #dc2626); }
  `;
  document.head.appendChild(css);

  let list = [];
  const active = () => list.filter((n) => n && Number(n.until) > Date.now());

  function bar(n, closable) {
    const lv = LEVELS[n.level] || LEVELS.info;
    const b = el("div", "pnt-bar pnt-" + (LEVELS[n.level] ? n.level : "info"));
    b.appendChild(el("span", "", lv.icon));
    const tx = el("div", "tx");
    tx.appendChild(el("b", "", n.title));
    if (n.text) tx.append(n.text);
    b.appendChild(tx);
    if (closable) {
      const x = el("button", "x", "✕"); x.type = "button"; x.title = "Hide this notice on this computer";
      x.onclick = () => { dismiss(n.id); paint(); };
      b.appendChild(x);
    }
    return b;
  }

  // Banner at the top of the page (every page except the Help & issues list).
  function paintBanner() {
    let host = document.getElementById("pcmNoticeBar");
    if (!host) {
      host = el("div"); host.id = "pcmNoticeBar";
      const opt = document.querySelector(".status-row");
      const header = document.querySelector(".header");
      if (opt) opt.before(host); else if (header) header.after(host); else return;
    }
    host.textContent = "";
    const hide = new Set(dismissed());
    for (const n of active().filter((x) => !hide.has(x.id)).slice(0, 3)) host.appendChild(bar(n, true));
  }

  // Options > Help & issues: every active notice, and the admin's post / end tools.
  let adminMode = false;
  function paintHub() {
    const host = document.getElementById("hubNotices");
    if (!host) return;
    host.textContent = "";
    const now = active();
    if (now.length) {
      const wrap = el("div", "pnt-list");
      for (const n of now) {
        const b = bar(n, false);
        const meta = el("div", "meta", "Showing until " + fmtUntil(n.until) + (n.createdAt ? " · posted " + fmtUntil(n.createdAt) : ""));
        b.querySelector(".tx").appendChild(meta);
        if (adminMode) {
          const end = el("button", "end", "End"); end.type = "button"; end.title = "Stop showing this notice for everyone";
          end.onclick = async () => { end.disabled = true; end.textContent = "Ending…"; await send({ type: "HUB", action: "notice", payload: { op: "end", id: n.id }, admin: true }); };
          b.appendChild(end);
        }
        wrap.appendChild(b);
      }
      host.appendChild(wrap);
    }
    if (adminMode) host.appendChild(form());
  }
  function form() {
    const f = el("form", "pnt-form");
    f.appendChild(el("h3", "", "📢 Post a notice to everyone"));
    const title = el("input"); title.type = "text"; title.maxLength = 150; title.placeholder = "Title, e.g. Maintenance break today 3-4 PM";
    const text = el("textarea"); text.maxLength = 4000; text.placeholder = "Details (optional)";
    const row = el("div", "row");
    const level = el("select");
    for (const [v, l] of Object.entries(LEVELS)) { const o = el("option", "", l.icon + " " + l.label); o.value = v; level.appendChild(o); }
    const untilLab = el("label", "", "Show until");
    const until = el("input"); until.type = "datetime-local";
    const d = new Date(Date.now() + 86400000); d.setMinutes(0, 0, 0);
    const pad = (x) => String(x).padStart(2, "0");
    until.value = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":00";
    const post = el("button", "post", "Post notice"); post.type = "submit";
    row.append(level, untilLab, until, post);
    const msg = el("div", "msg", "Everyone's extension shows it within 10 minutes (a pop-up once, then a banner until the time above). Urgent ones use the alarm sound.");
    f.append(title, text, row, msg);
    f.onsubmit = async (e) => {
      e.preventDefault();
      const u = new Date(until.value).getTime();
      if (!title.value.trim()) { msg.className = "msg err"; msg.textContent = "Write a title."; title.focus(); return; }
      if (!(u > Date.now())) { msg.className = "msg err"; msg.textContent = "Pick a time in the future for Show until."; return; }
      post.disabled = true; msg.className = "msg"; msg.textContent = "Posting…";
      const r = await send({ type: "HUB", action: "notice", payload: { op: "post", title: title.value.trim(), text: text.value.trim(), level: level.value, until: u }, admin: true });
      post.disabled = false;
      if (r && r.ok) { title.value = ""; text.value = ""; msg.textContent = "Posted ✓ Everyone will see it within 10 minutes."; }
      else {
        msg.className = "msg err";
        const e2 = String((r && r.error) || "no answer");
        msg.textContent = /unknown action/i.test(e2)
          ? "Your Team hub script is older than this feature. Update it once: Admin > Team hub > Copy the script, paste it into Apps Script, then Deploy > Manage deployments > edit > New version."
          : "Couldn't post it: " + e2;
      }
    };
    return f;
  }

  function paint() { paintBanner(); paintHub(); }
  async function load() {
    try { const g = await chrome.storage.local.get("hubNotices"); list = (g.hubNotices && Array.isArray(g.hubNotices.list)) ? g.hubNotices.list : []; } catch (e) {}
    paint();
  }
  async function init() {
    const i = await send({ type: "HUB_INFO" });
    adminMode = !!(i && i.adminKey) && !document.body.classList.contains("no-admin");
    await load();
    // Fresh copy when the Help & issues tab is open (and on every page open).
    if (i && i.url) send({ type: "HUB", action: "notices", payload: {} });
  }
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.hubNotices) load(); }); } catch (e) {}
  setInterval(paint, 60000); // a notice disappears on its own when its time is up
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  window.PcmNotices = { refresh: load, init };
})();
