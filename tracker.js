// Floating tracker: a small always-on-top window (Chrome's Document
// Picture-in-Picture) showing the running ClickUp task, a bar towards its
// estimate and a face that goes from sad (just started) to happy (on estimate)
// to angry (over). Mini by default; pointing at it shows the full view with
// Stop / Complete. This page is the small pinned tab that hosts the window:
// Chrome only opens it after a click here and closes it with this page.
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const backTab = Number(new URLSearchParams(location.search).get("back")) || null;
  const supported = "documentPictureInPicture" in window;
  let pip = null;

  // ---------- data ----------
  let data = { st: null, rp: null, settings: {}, last: null, theme: "" };
  async function load() {
    const g = await chrome.storage.local.get(["clickupState", "runningProgress", "settings", "lastStoppedTask", "resumeTask", "theme"]);
    const st = g.clickupState && typeof g.clickupState === "object" ? g.clickupState : null;
    const extraId = st && st.extraTask && st.extraTask.id ? String(st.extraTask.id) : "";
    // The task to go back to after a meeting / Extra Task (switched away from within
    // the last 12 hours); otherwise the last task stopped, unless that was the Extra Task.
    const rt = g.resumeTask && Date.now() - (g.resumeTask.at || 0) < 12 * 3600000 ? g.resumeTask : null;
    const ls = g.lastStoppedTask && String(g.lastStoppedTask.id) !== extraId ? g.lastStoppedTask : null;
    data = { st, rp: g.runningProgress || null, settings: g.settings || {}, last: rt || ls, theme: g.theme || "" };
  }
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); }
  });

  // ---------- face ----------
  const INK = "#2C2C2A";
  const lerp = (a, b, t) => a + (b - a) * t;
  const cl = (x) => Math.max(0, Math.min(1, x));
  // p = tracked / estimate (null = no estimate, "sleep" = no timer).
  function faceSVG(p, size) {
    const svg = (inner, fill) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 40 40" aria-hidden="true">' +
      '<circle cx="20" cy="20" r="17" fill="' + fill + '" stroke="' + INK + '" stroke-opacity=".25" stroke-width="1"/>' + inner + "</svg>";
    if (p === "sleep") {
      return svg('<path d="M10.5 19 Q14 21.5 17.5 19 M22.5 19 Q26 21.5 29.5 19" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>' +
        '<ellipse cx="20" cy="28.5" rx="2.6" ry="1.8" fill="' + INK + '"/>' +
        '<text x="30" y="11" font-size="8" font-weight="700" fill="#7F77DD" font-family="sans-serif">z</text><text x="34" y="6" font-size="6" font-weight="700" fill="#7F77DD" font-family="sans-serif">z</text>', "hsl(250 25% 72%)");
    }
    if (p == null) {
      return svg('<ellipse cx="14" cy="19" rx="2.2" ry="2.5" fill="' + INK + '"/><ellipse cx="26" cy="19" rx="2.2" ry="2.5" fill="' + INK + '"/>' +
        '<path d="M13 28 L27 28" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"/>', "hsl(45 60% 66%)");
    }
    const s = p <= 1 ? -1 + 2 * p : 1 - 2 * cl((p - 1) / 0.4);
    const anger = p > 1.07 ? cl((p - 1.07) / 0.45) : 0;
    const sad = p < 1 ? cl(-s) : 0;
    const hue = p <= 1 ? lerp(210, 130, p) : lerp(130, 0, cl((p - 1) / 0.4));
    const sat = p <= 1 ? lerp(30, 55, p) : lerp(55, 70, anger);
    const fill = "hsl(" + hue.toFixed(0) + " " + sat.toFixed(0) + "% 64%)";
    const w = lerp(7.5, 5.5, anger);
    const my = 29 + sad;
    const mouth = "M" + (20 - w).toFixed(2) + " " + my + " Q20 " + (my + 7 * s).toFixed(2) + " " + (20 + w).toFixed(2) + " " + my;
    const happy = p >= 0.93 && p <= 1.07;
    const bs = sad * 3.5, ba = anger * 4.5;
    const outerY = 13.5 + bs * 0.6 - ba * 0.7, innerY = 13.5 - bs + ba;
    const brows = (sad > 0.12 || anger > 0.05)
      ? '<path d="M9.5 ' + outerY.toFixed(2) + " L16.5 " + innerY.toFixed(2) + " M30.5 " + outerY.toFixed(2) + " L23.5 " + innerY.toFixed(2) + '" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>' : "";
    const ey = 19 + sad * 0.8;
    const eyes = happy
      ? '<path d="M11 19.5 Q14 15.5 17 19.5 M23 19.5 Q26 15.5 29 19.5" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>'
      : '<ellipse cx="14" cy="' + ey + '" rx="2.2" ry="' + (2.5 - anger * 1.1).toFixed(2) + '" fill="' + INK + '"/><ellipse cx="26" cy="' + ey + '" rx="2.2" ry="' + (2.5 - anger * 1.1).toFixed(2) + '" fill="' + INK + '"/>' +
        (sad > 0.3 ? '<circle cx="14.8" cy="' + (ey - 0.9) + '" r=".7" fill="#fff"/><circle cx="26.8" cy="' + (ey - 0.9) + '" r=".7" fill="#fff"/>' : "");
    const cheeks = happy ? '<circle cx="10" cy="25" r="2.4" fill="#F09595" opacity=".85"/><circle cx="30" cy="25" r="2.4" fill="#F09595" opacity=".85"/>' : "";
    const tearOp = cl((sad - 0.45) / 0.35);
    const tear = tearOp > 0 ? '<path d="M27.2 21.5 q2.4 3.6 0 5.2 q-2.4 -1.6 0 -5.2z" fill="#378ADD" stroke="#185FA5" stroke-width=".5" opacity="' + tearOp.toFixed(2) + '"/>' : "";
    const steam = anger > 0.75 ? '<path d="M5 7 q2 -2 0 -4 M35 7 q-2 -2 0 -4" stroke="#E24B4A" stroke-width="1.6" fill="none" stroke-linecap="round"/>' : "";
    return svg(cheeks + eyes + brows + '<path d="' + mouth + '" fill="none" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"/>' + tear + steam, fill);
  }
  function moodLabel(p) {
    if (p == null) return "No estimate set";
    if (p < 0.25) return "Just started";
    if (p < 0.5) return "Warming up";
    if (p < 0.8) return "Halfway there";
    if (p < 0.93) return "Almost there";
    if (p <= 1.07) return "Right on estimate";
    if (p < 1.25) return "A little over";
    if (p < 1.45) return "Over estimate";
    return "Way over!";
  }
  const fmt = (ms) => {
    const m = Math.round(Math.max(0, ms) / 60000); // same rounding as the dashboard
    const h = Math.floor(m / 60);
    return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m";
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- the floating window ----------
  const PIP_CSS = `
    :root { --bg: #faf7f2; --text: #2e2a26; --muted: #7b7064; --border: #e0d7ca; --track: #ece5da; --blue: #378ADD; --green: #16a34a; --red: #dc2626; --amber: #b45309; color-scheme: light; }
    html[data-theme="dark"] { --bg: #181b21; --text: #e8eaed; --muted: #9aa3b2; --border: #2b3038; --track: #2b3038; --blue: #60a5fa; --green: #22c55e; --red: #f87171; --amber: #fbbf24; color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 12.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; user-select: none; }
    #root { height: 100%; box-sizing: border-box; padding: 8px 10px; display: flex; align-items: center; gap: 10px; }
    .face { flex: none; display: grid; }
    .col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .nm { display: block; flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); text-decoration: none; }
    .nm:hover { text-decoration: underline; }
    .row { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .trk { flex: 1; height: 7px; border-radius: 999px; background: var(--track); overflow: hidden; }
    .trk b { display: block; height: 100%; border-radius: 999px; transition: width .6s, background .6s; }
    .tm { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
    .lab { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .sub { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .btns { display: flex; gap: 6px; margin-left: auto; flex: none; }
    button { font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg); color: var(--text); cursor: pointer; }
    button:hover { border-color: var(--muted); }
    button:disabled { opacity: .5; cursor: default; }
    button.x { flex: none; font-size: 11px; padding: 1px 7px; }
    button.pri { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .xin { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 3px 7px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
    .xin:focus { outline: 2px solid #6366f1; outline-offset: -1px; }
    .chip { flex: none; max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; font-weight: 600; padding: 1px 7px; border-radius: 999px; background: rgba(99,102,241,.16); color: #6366f1; }
    html[data-theme="dark"] .chip { color: #a5b4fc; }
    #fCmt { font-size: 11.5px; padding: 2px 7px; }
    #fPick, #fClear { padding: 1px 6px; }
    #root.big { display: block; overflow: auto; padding: 10px 12px; user-select: text; }
    #root.big .bhead { display: flex; gap: 10px; align-items: flex-start; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    #root.big .bsec { margin-top: 10px; }
    #root.big .bh { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 5px; cursor: default; }
    #root.big details > summary.bh { cursor: pointer; }
    #root.big textarea.xin { width: 100%; box-sizing: border-box; resize: vertical; font-size: 12.5px; margin-bottom: 6px; }
    #root.big #eDesc { min-height: 120px; line-height: 1.45; }
    #root.big .dmsg { font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 4px; }
    #root.big .wrap { white-space: normal; overflow: visible; line-height: 1.5; }
    #root.big .wrap a { color: #6366f1; word-break: break-all; }
    #root.big .cmt { padding: 6px 0; border-top: 1px solid var(--border); color: var(--text); }
    #root.big .cmt:first-child { border-top: 0; }
    #root.big .cmt .when { color: var(--muted); font-size: 11px; }
    #root.big .files { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
    #root.big .file { font-size: 11.5px; padding: 2px 4px 2px 8px; border: 1px solid var(--border); border-radius: 999px; display: inline-flex; align-items: center; gap: 4px; }
    #root.big .file .rm { border: 0; background: none; padding: 0 3px; font-size: 11px; color: var(--muted); }
    #root.big #eDrop.over { outline: 2px dashed #6366f1; outline-offset: 3px; border-radius: 8px; }
    #root.big .bfoot { margin-top: 12px; padding-top: 8px; border-top: 1px solid var(--border); }
    button.next { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
    #cBadge { position: fixed; top: 3px; left: 3px; z-index: 5; font: 700 10.5px/1.2 -apple-system, "Segoe UI", sans-serif; padding: 2px 6px; border-radius: 999px; background: #ef4444; border: 0; color: #fff; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.3); }
    #cBadge[hidden] { display: none; }
    .newtag { font-size: 9.5px; font-weight: 700; padding: 0 5px; border-radius: 999px; background: #ef4444; color: #fff; margin-left: 4px; }
    .close { margin-left: auto; background: none; border: 0; color: var(--muted); font-size: 14px; padding: 0 2px; }
  `;
  let full = false;
  let busy = false;
  // "Switch to Extra Task" panel (meeting / quick note). While it's open the
  // regular repaint is paused, so a note being typed is never wiped.
  let xPanel = false;
  function openExtraPanel() {
    xPanel = true;
    const root = pip.document.getElementById("root");
    root.dataset.key = "";
    root.innerHTML = '<div class="face">' + faceSVG(0.5, 40) + '</div><div class="col">' +
      '<div class="row"><span class="lab">Switch to the Extra Task</span><button class="close" data-act="xcancel" title="Cancel">&#10005;</button></div>' +
      '<div class="row"><button class="x" data-act="xmeet" title="Start the Extra Task with the note &quot;Meeting&quot;">Meeting</button>' +
      '<input class="xin" id="xnote" maxlength="200" placeholder="or a note + Enter" /><button class="x pri" data-act="xgo">Start</button></div>' +
      '<div class="sub" id="xmsg">Your current timer stops first.</div></div>';
    const inp = pip.document.getElementById("xnote");
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); startExtra(inp.value.trim()); }
      if (e.key === "Escape") { xPanel = false; paint(); }
    });
    setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
  }
  async function startExtra(note) {
    if (busy) return;
    busy = true;
    const msg = pip.document.getElementById("xmsg");
    if (msg) { msg.style.color = ""; msg.textContent = "Starting the Extra Task…"; }
    pip.document.querySelectorAll("#root button").forEach((b) => { b.disabled = true; });
    const r = await send({ type: "CLICKUP_START_TIMER", description: note || undefined });
    busy = false;
    if (!r || r.ok === false) {
      pip.document.querySelectorAll("#root button").forEach((b) => { b.disabled = false; });
      if (msg) {
        msg.style.color = "var(--red)";
        msg.textContent = "Couldn't start: " + ((r && (r.error || r.reason)) || "no reply") + ".";
      }
      return;
    }
    xPanel = false;
    await load();
    paint();
  }
  let lastProgressAsk = 0;
  function build() {
    const d = pip.document;
    d.title = "Tracker";
    const st = d.createElement("style");
    st.textContent = PIP_CSS;
    d.head.appendChild(st);
    // 💬 badge: new comments from someone else on the running task.
    const badge = d.createElement("button");
    badge.id = "cBadge";
    badge.hidden = true;
    badge.onclick = (e) => { e.stopPropagation(); openBig(); };
    d.body.appendChild(badge);
    const root = d.createElement("div");
    root.id = "root";
    d.body.appendChild(root);
    root.addEventListener("mouseenter", () => { if (!expanded && data.settings.floatHover !== false) { full = true; paint(); } });
    root.addEventListener("mouseleave", () => { if (!expanded && data.settings.floatHover !== false && !note.busy() && !qc.busy()) { full = false; paint(); } });
    // Moving: only Chrome's own top bar (the empty part, not the extension name
    // chip) drags a floating window - Chrome ignores moveBy from the page (tested).
    root.addEventListener("click", (e) => {
      // Expanded: a click on blank space (not text, buttons or boxes) shrinks it back.
      if (expanded && (e.target === root || e.target.classList.contains("bfoot") || e.target.classList.contains("btns"))) { closeBig(); return; }
      if (!expanded && data.settings.floatHover === false && !e.target.closest("button,a,input,textarea")) { full = !full; paint(); }
    });
    root.addEventListener("click", onAction);
    // Files dropped on the small tracker go with the next comment.
    root.addEventListener("dragenter", () => { if (!expanded && !full) { full = true; paint(); } });
    root.addEventListener("dragover", (e) => { if (!expanded && pip.document.getElementById("fCmt")) e.preventDefault(); });
    root.addEventListener("drop", (e) => {
      if (expanded || !pip.document.getElementById("fCmt")) return;
      e.preventDefault();
      qc.addFiles([...(e.dataTransfer.files || [])]);
    });
  }
  function theme() {
    const t = data.theme === "dark" || data.theme === "light" ? data.theme
      : (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    if (pip) pip.document.documentElement.dataset.theme = t;
    document.documentElement.dataset.theme = t;
  }
  function paint() {
    if (!pip) return;
    const root = pip.document.getElementById("root");
    if (!root || xPanel) return;
    const st = data.st || {};
    const run = st.running && st.running.taskId ? st.running : null;
    const now = Date.now();
    const showToday = data.settings.floatToday !== false && Number(st.targetMs) > 0;
    let spent = Number(st.spentMs) || 0;
    if (run && run.startMs && st.at) spent += Math.max(0, now - Math.max(run.startMs, st.at));
    const today = showToday ? "Today " + fmt(spent) + "/" + fmt(st.targetMs) : "";
    if (!run) {
      if (expanded) { closeBig(); return; }
      const canResume = data.last && data.last.id;
      const extra = st.extraTask && st.extraTask.id;
      // Suggest what to do next: today's open tasks, most urgent first.
      const nexts = nextTasks(st, compact() ? 1 : 2);
      root.dataset.key = "";
      root.innerHTML = '<div class="face">' + faceSVG("sleep", full || compact() ? 38 : 50) + '</div><div class="col">' +
        '<div class="lab" style="color:var(--amber)">No timer running</div>' +
        (full
          ? nexts.map((t) => '<div class="row"><button class="x next" data-act="startid" data-id="' + esc(t.id) + '" title="Start: ' + esc(t.name) + '">&#9654; ' + esc(t.name) + "</button></div>").join("") +
            '<div class="row"><span class="btns" style="margin-left:0">' +
            (extra ? '<button data-act="xopen">Start Extra Task</button>' : "") + (canResume ? '<button data-act="resume" title="' + esc(data.last.name || "") + '">Resume last</button>' : "") + "</span></div>"
          : (nexts.length ? '<div class="sub">Next: ' + esc(nexts[0].name) + "</div>" : "") +
            (today ? '<div class="sub">' + esc(today) + "</div>" : nexts.length ? "" : '<div class="sub">Point here to start a task</div>')) +
        "</div>";
      return;
    }
    const rp = data.rp && String(data.rp.taskId) === String(run.taskId) ? data.rp : null;
    if (!rp && now - lastProgressAsk > 60000) { lastProgressAsk = now; send({ type: "TRACKER_PROGRESS" }); }
    const live = Math.max(0, now - (run.startMs || now));
    const tracked = (rp ? rp.closedMs : 0) + live;
    const est = rp ? Number(rp.estimateMs) || 0 : 0;
    const p = est > 0 ? tracked / est : null;
    const over = p != null && tracked - est >= 60000; // a full minute past the estimate
    const barColor = p == null ? "var(--blue)" : p > 1.07 ? "var(--red)" : p >= 0.8 ? "var(--green)" : "var(--blue)";
    const width = p == null ? 100 : Math.min(100, p * 100);
    const time = p == null ? fmt(tracked) : over ? "+" + fmt(tracked - est) + " over" : fmt(tracked) + " / " + fmt(est);
    const label = moodLabel(p);
    const labColor = over && p > 1.07 ? "var(--red)" : p != null && p >= 0.93 ? "var(--green)" : "var(--text)";
    // The recurring Extra Task must never offer Done: completing it makes ClickUp
    // create next week's copy early. Recognised by id AND by name (same rule as the
    // popup), so a renamed/other occurrence is still protected.
    const isExtra = !!((st.extraTask && String(st.extraTask.id) === String(run.taskId)) ||
      /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(String(run.taskName || "")));
    const bar = '<div class="row"><div class="trk"><b style="width:' + width.toFixed(1) + "%;background:" + barColor + (p == null ? ";opacity:.35" : "") + '"></b></div><span class="tm"' + (over ? ' style="color:var(--red)"' : "") + ">" + esc(time) + "</span></div>";
    if (expanded) {
      if (bigKey !== run.taskId + ":" + run.startMs) { closeBig(); return; }
      const d = pip.document;
      d.getElementById("eFace").innerHTML = faceSVG(p, 36);
      const eb = d.getElementById("eBar");
      eb.style.width = width.toFixed(1) + "%";
      eb.style.background = barColor;
      eb.style.opacity = p == null ? ".35" : "";
      const et = d.getElementById("eTime");
      et.textContent = time + (today ? " · " + today : "");
      et.style.color = over ? "var(--red)" : "";
      return;
    }
    if (full) {
      // Built once per timer, then only the face / bar / numbers are updated, so
      // the note being typed is never wiped by the every-second refresh.
      const key = run.taskId + ":" + (run.startMs || "") + ":" + isExtra + ":" + !!(data.last && data.last.id);
      if (root.dataset.key !== key) {
        root.dataset.key = key;
        if (note.key !== run.taskId + ":" + run.startMs) note.reset(run);
        const client = clientOf(st, run.taskId);
        root.innerHTML = '<div class="face" id="fFace"></div><div class="col">' +
          '<div class="row"><a class="nm" href="https://app.clickup.com/t/' + encodeURIComponent(run.taskId) + '" target="_blank" title="' + esc(run.taskName) + '">' + esc(run.taskName || "(task)") + "</a>" +
          (client && !compact() ? '<span class="chip" title="Client">' + esc(client) + "</span>" : "") +
          '<button class="x" data-act="big" title="Bigger view: comments, attach screenshots and files, description">&#10529;</button>' +
          (!isExtra && st.extraTask && st.extraTask.id ? '<button class="x" data-act="xopen" title="Switch to the Extra Task now (meeting or a quick note)">&#8644; Extra</button>' : "") +
          (isExtra && data.last && data.last.id ? '<button class="x pri" data-act="resume" title="Stop the Extra Task and go back to: ' + esc(data.last.name || "your task") + '">&#8617; Back to task</button>' : "") + "</div>" +
          '<div class="row"><div class="trk"><b id="fBar"></b></div><span class="tm" id="fTime"></span></div>' +
          (compact() ? "" : '<div class="row"><input class="xin" id="fCmt" maxlength="2000" placeholder="Comment + Enter" title="Posts a comment on the task. Paste screenshots with Ctrl+V, drop files on the tracker or use the paperclip. Anything still here is posted when you press Stop or Done." /><button class="x" data-act="qcpick" id="fPick" title="Attach files">&#128206;</button><button class="x" data-act="qcclear" id="fClear" hidden title="Remove the attached files">&#10005;</button><input type="file" id="fFileIn" multiple hidden /><span class="sub" id="fCmsg"></span></div>') +
          '<div class="row"><span class="sub" id="fToday" style="font-size:11.5px"></span><span class="btns"><button data-act="stop" title="Post the comment (if any) and stop the timer">&#9632; Stop</button>' +
          (isExtra ? "" : '<button data-act="complete" title="Post the comment (if any) and mark the task complete (stops the timer)">&#10003; Done</button>') + "</span></div></div>";
        if (!compact()) qc.bind(pip.document, String(run.taskId));
      }
      const d = pip.document;
      d.getElementById("fFace").innerHTML = faceSVG(p, 40);
      const b = d.getElementById("fBar");
      b.style.width = width.toFixed(1) + "%";
      b.style.background = barColor;
      b.style.opacity = p == null ? ".35" : "";
      const tm = d.getElementById("fTime");
      tm.textContent = time;
      tm.style.color = over ? "var(--red)" : "";
      d.getElementById("fToday").textContent = today || label;
    } else {
      root.dataset.key = "";
      root.innerHTML = '<div class="face">' + faceSVG(p, compact() ? 40 : 50) + '</div><div class="col">' + bar +
        '<div class="lab" style="color:' + labColor + '">' + esc(label) + "</div></div>";
    }
  }
  // Today's open tasks to suggest when nothing is running: not done, not the
  // Extra Task, single-assignee, most urgent first, then earliest due.
  const PRIO_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
  const DONE_RE = /^(closed|done|complete|completed|resolved|shipped|approved)$/i;
  function nextTasks(st, n) {
    const extraId = st.extraTask && st.extraTask.id ? String(st.extraTask.id) : "";
    const seen = new Set();
    const out = [];
    const dayStart = new Date().setHours(0, 0, 0, 0), dayEnd = dayStart + 86400000;
    for (const t of st.tasks || []) {
      const due = Number(t && t.dueDateMs) || 0;
      if (due < dayStart || due >= dayEnd) continue; // due TODAY only
      const id = t && String(t.id != null ? t.id : t.taskId || "");
      if (!id || seen.has(id) || t.error) continue;
      seen.add(id);
      if (id === extraId || /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(String(t.name || ""))) continue;
      if (t.done || DONE_RE.test(String(t.status || "").trim())) continue;
      if (Number(t.assigneeCount) > 1) continue;
      out.push({ id, name: t.name || "(task)", r: PRIO_RANK[String(t.priority || "").toLowerCase()] ?? 4, due: Number(t.dueDateMs) || Infinity });
    }
    return out.sort((a, b) => a.r - b.r || a.due - b.due).slice(0, n);
  }
  // The running task's client, from the task lists already loaded.
  function clientOf(st, id) {
    for (const b of [st, st.todayFilter, st.thisWeek, st.nextWeek]) {
      if (!b) continue;
      for (const k of ["tasks", "deadlineTasks", "trackedTasks"]) {
        const t = Array.isArray(b[k]) && b[k].find((x) => x && String(x.id != null ? x.id : x.taskId) === String(id));
        if (t) return String(t.client || (t.container && t.container.listName) || "").trim();
      }
    }
    return "";
  }
  // Quick comment in the small hover view (most people comment rather than write
  // a time-entry note). Enter posts it; Stop / Done / switching post a comment
  // still in the box first, so nothing typed is lost.
  const qc = {
    value: "", files: [], taskId: "", d: null,
    el(id) { return this.d && this.d.getElementById(id); },
    bind(doc, taskId) {
      if (this.taskId !== taskId) { this.value = ""; this.files = []; }
      this.taskId = taskId; this.d = doc;
      const input = this.el("fCmt");
      if (!input) return;
      input.value = this.value;
      input.oninput = () => { this.value = input.value; this.msg(""); };
      input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); this.post(); } };
      input.addEventListener("paste", (e) => {
        const fl = [...((e.clipboardData && e.clipboardData.files) || [])];
        if (fl.length) { e.preventDefault(); this.addFiles(fl); }
      });
      this.el("fFileIn").onchange = (e) => { this.addFiles([...(e.target.files || [])]); e.target.value = ""; };
      this.paintFiles();
    },
    msg(t, bad) { const m = this.el("fCmsg"); if (m) { m.textContent = t; m.style.color = bad ? "var(--red)" : ""; } },
    busy() { return !!((this.d && this.d.activeElement === this.el("fCmt")) || this.value.trim() || this.files.length); },
    addFiles(list) {
      for (const f of list.slice(0, 10)) {
        if (f.size > 10 * 1024 * 1024) { this.msg(f.name + " is over 10 MB", true); continue; }
        const fr = new FileReader();
        fr.onload = () => {
          const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
          this.files.push({ name, type: f.type || "application/octet-stream", b64: String(fr.result || "").split(",")[1] || "" });
          this.paintFiles();
        };
        fr.readAsDataURL(f);
      }
    },
    paintFiles() {
      const pick = this.el("fPick"), clr = this.el("fClear");
      if (!pick) return;
      pick.innerHTML = "&#128206;" + (this.files.length ? this.files.length : "");
      pick.title = this.files.length ? "Attached: " + this.files.map((f) => f.name).join(", ") + " (click to add more)" : "Attach files";
      if (clr) clr.hidden = !this.files.length;
    },
    async post() {
      const text = this.value.trim();
      if ((!text && !this.files.length) || !this.taskId) return true;
      this.msg(this.files.length ? "Uploading…" : "Posting…");
      const r = this.files.length
        ? await send({ type: "CLICKUP_TASK_ATTACH", taskId: this.taskId, text, files: this.files })
        : await send({ type: "CLICKUP_TASK_COMMENT", taskId: this.taskId, text });
      if (r && r.ok) {
        this.value = ""; this.files = [];
        const i = this.el("fCmt"); if (i) i.value = "";
        this.paintFiles();
        this.msg("Posted ✓");
        setTimeout(() => { const m = this.el("fCmsg"); if (m && m.textContent === "Posted ✓") m.textContent = ""; }, 1800);
        return true;
      }
      this.msg("Not posted", true);
      const m = this.el("fCmsg"); if (m) m.title = (r && r.error) || "";
      return false;
    },
  };
  // Note = the running time entry's Description in ClickUp (same as the popup's
  // "Add a note to this time entry"). Saved on Enter, when the box loses focus,
  // and before Stop / Done / switching tasks.
  const note = {
    key: "", value: "", saved: "", run: null, input: null, label: null, saving: null,
    reset(run) { this.key = run.taskId + ":" + run.startMs; this.value = this.saved = run.description || ""; this.run = run; },
    dirty() { return this.value.trim() !== this.saved.trim(); },
    busy() { return !!(this.input && (pip.document.activeElement === this.input || this.dirty())); },
    bind(input, label, run) {
      this.input = input; this.label = label; this.run = run;
      input.value = this.value;
      input.oninput = () => { this.value = input.value; label.textContent = ""; };
      input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); this.commit(); } };
      input.onblur = () => { this.commit(); };
    },
    async commit() {
      if (!this.run || !this.dirty()) return this.saving || true;
      const v = this.value.trim();
      if (this.label) { this.label.style.color = ""; this.label.textContent = "Saving…"; }
      this.saving = send({ type: "CLICKUP_SET_ENTRY_NOTE", entryId: this.run.id || null, taskId: String(this.run.taskId), description: v }).then((r) => {
        this.saving = null;
        if (r && r.ok) {
          this.saved = v;
          if (this.label) { this.label.textContent = "Saved ✓"; setTimeout(() => { if (this.label && this.label.textContent === "Saved ✓") this.label.textContent = ""; }, 1800); }
          return true;
        }
        if (this.label) { this.label.style.color = "var(--red)"; this.label.textContent = "Not saved"; this.label.title = (r && (r.error || r.reason)) || ""; }
        return false;
      });
      return this.saving;
    },
  };
  async function onAction(e) {
    const b = e.target.closest("button[data-act]");
    if (!b || busy) return;
    if (b.dataset.act === "startid") {
      busy = true;
      b.disabled = true;
      b.textContent = "Starting…";
      const r = await send({ type: "CLICKUP_TASK_START", taskId: String(b.dataset.id), force: true });
      busy = false;
      await load();
      paint();
      if (r && r.ok === false && pip) {
        const col = pip.document.querySelector("#root .col");
        if (col) { const m = pip.document.createElement("div"); m.className = "sub"; m.style.color = "var(--red)"; m.textContent = r.reason === "multi-assignee" ? "Shared task: start it from the popup" : "Couldn't start it"; col.appendChild(m); }
      }
      return;
    }
    if (b.dataset.act === "qcpick") { pip.document.getElementById("fFileIn").click(); return; }
    if (b.dataset.act === "qcclear") { qc.files = []; qc.paintFiles(); return; }
    if (b.dataset.act === "big") { openBig(); return; }
    if (b.dataset.act === "small") { closeBig(); return; }
    if (b.dataset.act === "pickfiles") { pip.document.getElementById("eFileIn").click(); return; }
    if (b.dataset.act === "rmfile") { bigFiles.splice(Number(b.dataset.i), 1); paintFiles(); return; }
    if (b.dataset.act === "comment") { postComment(); return; }
    if (b.dataset.act === "descfile") { pip.document.getElementById("eDescIn").click(); return; }
    if (b.dataset.act === "descsave") { dsc.save(); return; }
    if (b.dataset.act === "xopen") { note.commit(); qc.post(); dsc.save(); if (expanded) closeBig(); openExtraPanel(); return; }
    if (b.dataset.act === "xcancel") { xPanel = false; paint(); return; }
    if (b.dataset.act === "xmeet") { startExtra("Meeting"); return; }
    if (b.dataset.act === "xgo") { const i = pip.document.getElementById("xnote"); startExtra(i ? i.value.trim() : ""); return; }
    busy = true;
    b.disabled = true;
    b.textContent = "…";
    const st = data.st || {};
    const run = st.running;
    const act = b.dataset.act;
    let r = null;
    if (act === "stop" || act === "complete" || act === "resume") { await note.commit(); await qc.post(); await dsc.save(); } // note + a typed comment land first
    if (act === "stop" && run) r = await send({ type: "CLICKUP_TASK_STOP", taskId: String(run.taskId) });
    else if (act === "complete" && run) {
      const extraRun = (st.extraTask && String(st.extraTask.id) === String(run.taskId)) || /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(String(run.taskName || ""));
      if (extraRun) { busy = false; paint(); return; } // never complete the recurring Extra Task
      r = await send({ type: "CLICKUP_TASK_COMPLETE", taskId: String(run.taskId) });
    }
    else if (act === "extra" && st.extraTask) r = await send({ type: "CLICKUP_TASK_START", taskId: String(st.extraTask.id), force: true });
    else if (act === "resume" && data.last) {
      r = await send({ type: "CLICKUP_TASK_START", taskId: String(data.last.id), force: true });
      if (r && r.ok !== false) { try { await chrome.storage.local.set({ resumeTask: null }); } catch (e) {} }
    }
    busy = false;
    await load();
    if (r && r.ok === false && pip) {
      paint();
      const root = pip.document.getElementById("root");
      const msg = pip.document.createElement("div");
      msg.className = "sub";
      msg.style.color = "var(--red)";
      msg.textContent = r.reason === "multi-assignee" ? "Shared task: start it from the popup" : "Didn't work - try from the popup";
      root.querySelector(".col") && root.querySelector(".col").appendChild(msg);
      return;
    }
    paint();
  }

  // ---------- big view (⤢): note, comment with files, comments, description ----------
  // The window grows (Chrome allows resizeTo after a click; if it refuses, the
  // user can drag a corner) and shows the running task like the task details
  // panel. The every-second refresh only touches the face / bar / time here.
  let expanded = false;
  let bigKey = "";
  // Content sizes (Chrome adds its own title bar on top). resizeTo() takes the
  // OUTER size, so the small window is put back to exactly what it was.
  const SMALL = [340, 140], BIG = [460, 640];
  // Options > Floating tracker > Size: Compact covers less of the screen (no
  // comment box on hover - ⤢ has it), applied when the tracker is (re)opened.
  const COMPACT = [300, 96];
  const compact = () => data.settings.floatSize === "compact";
  let savedPos = null, savedOuter = null;
  const tryResize = (w, h) => { try { pip.resizeTo(w, h); } catch (e) {} };
  const bigFiles = []; // { name, type, b64, size }
  function linkify(text) {
    return esc(text).replace(/https?:\/\/[^\s<"']+/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u + "</a>").replace(/\n/g, "<br>");
  }
  function openBig() {
    const st = data.st || {};
    const run = st.running;
    if (!run) return;
    expanded = true;
    bigKey = run.taskId + ":" + run.startMs;
    // Remember where the small tracker was: Chrome may shift the window to keep
    // the bigger one on screen, and we ask it to go back there on ⤡.
    savedPos = { x: pip.screenX, y: pip.screenY };
    savedOuter = { w: pip.outerWidth, h: pip.outerHeight };
    // Grow only into the free space right of / below the window when it fits:
    // Chrome can't be asked to move a floating window, so if the bigger window
    // would run off screen Chrome shifts it and it can't be put back.
    const scr = pip.screen || screen;
    const frameH = Math.max(0, pip.outerHeight - pip.innerHeight), frameW = Math.max(0, pip.outerWidth - pip.innerWidth);
    const roomW = (scr.availLeft || 0) + scr.availWidth - pip.screenX;
    const roomH = (scr.availTop || 0) + scr.availHeight - pip.screenY;
    const w = BIG[0] + frameW, h = BIG[1] + frameH;
    const fitW = roomW >= 360 ? Math.min(w, roomW) : w;
    const fitH = roomH >= 380 ? Math.min(h, roomH) : h;
    tryResize(fitW, fitH);
    const d = pip.document;
    const root = d.getElementById("root");
    root.dataset.key = "";
    root.classList.add("big");
    const isExtra = !!((st.extraTask && String(st.extraTask.id) === String(run.taskId)) || /\bextra(?:\(s\)|s)?\s+task(?:\(s\)|s)?\b/i.test(String(run.taskName || "")));
    const client = clientOf(st, run.taskId);
    root.innerHTML =
      '<div class="bhead"><span class="face" id="eFace"></span><div class="col">' +
        '<div class="row"><a class="nm" href="https://app.clickup.com/t/' + encodeURIComponent(run.taskId) + '" target="_blank" title="' + esc(run.taskName) + '">' + esc(run.taskName || "(task)") + "</a>" +
        '<button class="x" data-act="small" title="Back to the small tracker">&#10530; Smaller</button></div>' +
        '<div class="row">' + (client ? '<span class="chip">' + esc(client) + "</span>" : "") + '<span class="sub" id="eMeta">Loading task…</span></div>' +
        '<div class="row"><div class="trk"><b id="eBar"></b></div><span class="tm" id="eTime"></span></div></div></div>' +
      '<div class="bsec"><div class="bh">Note on this time entry</div><div class="row"><input class="xin" id="eNote" maxlength="500" placeholder="Shows in your ClickUp Timesheet" /><span class="sub" id="eSaved"></span></div></div>' +
      '<div class="bsec" id="eDrop"><div class="bh">Comment on the task</div>' +
        '<textarea class="xin" id="eComment" rows="3" placeholder="Write a comment. Paste a screenshot with Ctrl+V, or drop files here."></textarea>' +
        '<div id="eFiles" class="files"></div>' +
        '<div class="row"><button class="x" data-act="pickfiles">&#128206; Attach</button><input type="file" id="eFileIn" multiple hidden />' +
        '<span class="sub" id="eCmsg"></span><span class="btns"><button class="x pri" data-act="comment">Comment</button></span></div></div>' +
      '<div class="bsec" id="eDescBox"><div class="bh">Description <span id="eDmsg" class="dmsg"></span></div>' +
        '<textarea class="xin" id="eDesc" rows="8" placeholder="Loading…"></textarea>' +
        '<div class="row"><button class="x" data-act="descfile" title="Upload a file to the task and put its link where the cursor is (e.g. inside File: &quot;&quot;). You can also paste a screenshot or drop a file on the box.">&#128206; Add file</button><input type="file" id="eDescIn" multiple hidden />' +
        '<span class="btns"><button class="x pri" data-act="descsave" id="eDescSave" disabled title="Save the description to ClickUp (Ctrl+S)">Save</button></span></div></div>' +
      '<div class="bsec"><div class="bh">Comments</div><div id="eComments" class="sub wrap">Loading…</div></div>' +
      '<div class="bfoot"><span class="btns" style="margin-left:0"><button data-act="stop">&#9632; Stop</button>' +
        (isExtra ? "" : '<button data-act="complete">&#10003; Done</button>') +
        (!isExtra && st.extraTask && st.extraTask.id ? '<button data-act="xopen">&#8644; Extra</button>' : "") +
        (isExtra && data.last && data.last.id ? '<button class="pri" data-act="resume">&#8617; Back to task</button>' : "") + "</span></div>";
    if (note.key !== run.taskId + ":" + run.startMs) note.reset(run);
    note.bind(d.getElementById("eNote"), d.getElementById("eSaved"), run);
    bigFiles.length = 0;
    const ta = d.getElementById("eComment");
    ta.addEventListener("paste", (e) => {
      const items = [...((e.clipboardData && e.clipboardData.files) || [])];
      if (items.length) { e.preventDefault(); addFiles(items); }
    });
    const drop = d.getElementById("eDrop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles([...(e.dataTransfer.files || [])]); });
    d.getElementById("eFileIn").addEventListener("change", (e) => { addFiles([...(e.target.files || [])]); e.target.value = ""; });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(); } });
    dsc.bind(d, run);
    loadPanel(run.taskId, true);
    cw.seenBefore = cw.seen || 0;
    markSeen();
    paint();
  }
  function closeBig() {
    expanded = false;
    bigKey = "";
    if (savedOuter) tryResize(savedOuter.w, savedOuter.h); else tryResize(SMALL[0], SMALL[1] + 32);
    // Back where it was. Chrome may ignore this for floating windows; then it
    // stays put and can be dragged back by its top bar.
    if (savedPos) { const p = savedPos; setTimeout(() => { try { pip.moveTo(p.x, p.y); } catch (e) {} }, 60); }
    const root = pip.document.getElementById("root");
    root.classList.remove("big");
    paintBadge();
    root.dataset.key = "";
    full = false;
    paint();
  }
  async function loadPanel(taskId, force) {
    const r = await send({ type: "CLICKUP_TASK_PANEL", taskId: String(taskId), force: !!force });
    if (!expanded || !pip) return;
    const d = pip.document;
    if (!r || !r.ok || !r.data) { d.getElementById("eComments").textContent = "Couldn't load the task: " + ((r && r.error) || "no reply"); return; }
    paintPanel(r.data);
  }
  // ---------- new-comment watch (running task, every 3 minutes while open) ----------
  const cw = { taskId: "", at: 0, seen: 0, seenBefore: 0, latestAt: 0, newCount: 0, busy: false, me: null };
  async function myUserId() {
    if (cw.me != null) return cw.me;
    const r = await send({ type: "GET_STATE" });
    cw.me = String((r && r.clickup && r.clickup.user && r.clickup.user.id) || "");
    return cw.me;
  }
  async function pollComments(force) {
    if (!pip || cw.busy) return;
    const run = data.st && data.st.running;
    if (!run) { cw.taskId = ""; cw.newCount = 0; paintBadge(); return; }
    const id = String(run.taskId);
    if (!force && cw.taskId === id && Date.now() - cw.at < 180000) return;
    cw.busy = true;
    try {
      const me = await myUserId();
      const r = await send({ type: "CLICKUP_TASK_PANEL", taskId: id, force: true });
      if (!r || !r.ok || !r.data) return;
      const cs = r.data.comments || [];
      const g = await chrome.storage.local.get("commentsSeen").catch(() => ({}));
      const seenMap = (g && g.commentsSeen) || {};
      const latest = cs.reduce((m, c) => Math.max(m, Number(c.at) || 0), 0);
      // First look at this task: older comments don't count as new.
      if (seenMap[id] == null) { seenMap[id] = latest || Date.now(); await saveSeen(seenMap); }
      cw.taskId = id; cw.at = Date.now(); cw.latestAt = latest; cw.seen = seenMap[id];
      cw.newCount = cs.filter((c) => Number(c.at) > seenMap[id] && (!me || c.userId !== me)).length;
      paintBadge();
      if (expanded && bigKey.startsWith(id + ":")) paintPanel(r.data);
    } finally { cw.busy = false; }
  }
  async function saveSeen(map) {
    const keys = Object.keys(map).sort((a, b) => map[b] - map[a]).slice(0, 200);
    const out = {};
    for (const k of keys) out[k] = map[k];
    try { await chrome.storage.local.set({ commentsSeen: out }); } catch (e) {}
  }
  async function markSeen() {
    if (!cw.taskId) return;
    const g = await chrome.storage.local.get("commentsSeen").catch(() => ({}));
    const m = (g && g.commentsSeen) || {};
    m[cw.taskId] = Math.max(cw.latestAt || 0, Date.now());
    await saveSeen(m);
    cw.seen = m[cw.taskId];
    cw.newCount = 0;
    paintBadge();
  }
  function paintBadge() {
    const b = pip && pip.document.getElementById("cBadge");
    if (!b) return;
    b.hidden = !cw.newCount || expanded;
    b.textContent = "💬 " + cw.newCount;
    b.title = cw.newCount + " new comment" + (cw.newCount === 1 ? "" : "s") + " from others on this task - click to read";
  }
  // ---------- description: editable (fill in File: "" with links or notes) ----------
  // Saved to ClickUp as markdown. Unsaved text survives shrinking the view and
  // the 3-minute refresh, and is saved before Stop / Done / Back / Extra. If
  // the description was changed in ClickUp meanwhile, nothing is overwritten.
  const dsc = {
    taskId: "", from: null, draft: null, saving: null,
    dirty() { return this.draft != null && this.from != null && this.draft !== this.from; },
    el(id) { return pip && pip.document.getElementById(id); },
    msg(t, bad) { const m = this.el("eDmsg"); if (m) { m.textContent = t; m.style.color = bad ? "var(--red)" : ""; } },
    sync() { const b = this.el("eDescSave"); if (b) b.disabled = !this.dirty(); if (this.dirty()) this.msg("unsaved"); },
    bind(d, run) {
      if (this.taskId !== String(run.taskId)) { this.taskId = String(run.taskId); this.from = null; this.draft = null; }
      const ta = d.getElementById("eDesc");
      if (this.from != null) { ta.value = this.draft != null ? this.draft : this.from; ta.placeholder = "No description yet. Write one here."; }
      ta.addEventListener("input", () => { this.draft = ta.value; this.sync(); });
      ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); this.save(); } });
      ta.addEventListener("paste", (e) => { const fl = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fl.length) { e.preventDefault(); this.upload(fl); } });
      ta.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
      ta.addEventListener("drop", (e) => { const fl = [...((e.dataTransfer && e.dataTransfer.files) || [])]; if (fl.length) { e.preventDefault(); e.stopPropagation(); this.upload(fl); } });
      d.getElementById("eDescIn").addEventListener("change", (e) => { this.upload([...(e.target.files || [])]); e.target.value = ""; });
      this.sync();
    },
    // From ClickUp (open, refresh, 3-minute poll): never replaces unsaved typing.
    loaded(text) {
      if (this.dirty()) return;
      this.from = text; this.draft = null;
      const ta = this.el("eDesc");
      if (ta) { ta.value = text; ta.placeholder = "No description yet. Write one here."; }
      this.sync();
    },
    async upload(files) {
      const list = files.slice(0, 10).filter((f) => f.size <= 10 * 1024 * 1024);
      if (!list.length) { this.msg("files over 10 MB: attach them in ClickUp", true); return; }
      this.msg("uploading " + list.length + " file" + (list.length === 1 ? "" : "s") + "…");
      const payload = await Promise.all(list.map((f) => new Promise((ok) => {
        const fr = new FileReader();
        fr.onload = () => ok({ name: f.name && f.name !== "image.png" ? f.name : "screenshot-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png", type: f.type || "application/octet-stream", b64: String(fr.result || "").split(",")[1] || "" });
        fr.readAsDataURL(f);
      })));
      const r = await send({ type: "CLICKUP_TASK_ATTACH", taskId: this.taskId, files: payload, noComment: true });
      if (!r || !r.ok) { this.msg("upload failed: " + ((r && r.error) || "no reply"), true); return; }
      const ta = this.el("eDesc");
      const add = (r.files || []).map((f) => f.url || f.name).join("\n");
      const cur = this.draft != null ? this.draft : (this.from || "");
      if (ta) {
        const s = ta.selectionStart != null ? ta.selectionStart : ta.value.length, e = ta.selectionEnd != null ? ta.selectionEnd : s;
        ta.value = ta.value.slice(0, s) + add + ta.value.slice(e);
        ta.selectionStart = ta.selectionEnd = s + add.length;
        this.draft = ta.value;
      } else this.draft = cur + (cur ? "\n" : "") + add;
      this.sync();
      this.msg("link added, Save to keep it");
    },
    async save() {
      if (!this.dirty()) return true;
      if (this.saving) return this.saving;
      const b = this.el("eDescSave");
      if (b) { b.disabled = true; b.textContent = "Saving…"; }
      this.saving = send({ type: "CLICKUP_TASK_DESCRIPTION", taskId: this.taskId, text: this.draft, expected: this.from }).then((r) => {
        this.saving = null;
        const b2 = this.el("eDescSave");
        if (b2) b2.textContent = "Save";
        if (r && r.ok && r.data) { this.from = r.data.description; this.draft = null; const ta = this.el("eDesc"); if (ta) ta.value = this.from; this.sync(); this.msg("saved ✓"); return true; }
        if (r && r.changed) { this.from = r.current || ""; this.sync(); this.msg("changed in ClickUp meanwhile - Save again to replace it", true); return false; }
        this.sync();
        this.msg("not saved: " + ((r && r.error) || "no reply"), true);
        return false;
      });
      return this.saving;
    },
  };
  function paintPanel(p) {
    const d = pip.document;
    const bits = [p.status ? "Status " + p.status : "", p.dueDateMs ? "Due " + new Date(p.dueDateMs).toLocaleDateString([], { month: "short", day: "numeric" }) : "No due date", p.estimateMs ? "Est " + fmt(p.estimateMs) : ""];
    d.getElementById("eMeta").textContent = bits.filter(Boolean).join(" · ");
    const cs = (p.comments || []).slice(0, 5);
    d.getElementById("eComments").innerHTML = cs.length
      ? cs.map((c) => '<div class="cmt"><b>' + esc(c.who) + '</b>' + (cw.seenBefore && Number(c.at) > cw.seenBefore && c.userId !== cw.me ? '<span class="newtag">NEW</span>' : "") + ' <span class="when">' + (c.at ? esc(new Date(c.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) : "") + "</span><div>" + linkify(c.text) + "</div></div>").join("")
      : "No comments yet.";
    dsc.loaded(String(p.description || "").trim());
  }
  function addFiles(list) {
    for (const f of list.slice(0, 10)) {
      if (f.size > 10 * 1024 * 1024) { setCmsg("“" + f.name + "” is over 10 MB - attach it in ClickUp instead.", true); continue; }
      const fr = new FileReader();
      fr.onload = () => {
        const b64 = String(fr.result || "").split(",")[1] || "";
        const name = f.name && f.name !== "image.png" ? f.name : "screenshot-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png";
        bigFiles.push({ name, type: f.type || "application/octet-stream", b64, size: f.size });
        paintFiles();
      };
      fr.readAsDataURL(f);
    }
  }
  function paintFiles() {
    const box = pip.document.getElementById("eFiles");
    box.innerHTML = bigFiles.map((f, i) => '<span class="file">' + esc(f.name) + ' <button class="rm" data-act="rmfile" data-i="' + i + '" title="Remove">&#10005;</button></span>').join("");
  }
  function setCmsg(t, bad) { const m = pip.document.getElementById("eCmsg"); if (m) { m.textContent = t; m.style.color = bad ? "var(--red)" : ""; } }
  async function postComment() {
    const d = pip.document;
    const ta = d.getElementById("eComment");
    const text = ta.value.trim();
    if (!text && !bigFiles.length) { setCmsg("Write a comment or attach a file first.", true); return; }
    const run = (data.st || {}).running;
    if (!run) return;
    setCmsg(bigFiles.length ? "Uploading " + bigFiles.length + " file" + (bigFiles.length === 1 ? "" : "s") + "…" : "Posting…");
    d.querySelectorAll('[data-act="comment"]').forEach((b) => { b.disabled = true; });
    const r = bigFiles.length
      ? await send({ type: "CLICKUP_TASK_ATTACH", taskId: String(run.taskId), text, files: bigFiles.map(({ name, type, b64 }) => ({ name, type, b64 })) })
      : await send({ type: "CLICKUP_TASK_COMMENT", taskId: String(run.taskId), text });
    d.querySelectorAll('[data-act="comment"]').forEach((b) => { b.disabled = false; });
    if (!r || !r.ok) { setCmsg("Not posted: " + ((r && r.error) || "no reply"), true); return; }
    ta.value = "";
    bigFiles.length = 0;
    paintFiles();
    setCmsg("Posted ✓");
    if (r.data) paintPanel(r.data); else loadPanel(run.taskId, true);
  }

  // ---------- host page ----------
  function hostState(kind) {
    const title = $("title"), lead = $("lead"), action = $("action"), note = $("note");
    $("face").innerHTML = faceSVG(kind === "floating" ? 1 : kind === "closed" ? "sleep" : 0.05, 64);
    if (kind === "unsupported") {
      title.textContent = "This browser can't float the tracker";
      lead.textContent = "Floating windows need Chrome or Edge (version 116 or newer). Everything else in the extension still works.";
      action.innerHTML = "";
      note.textContent = "";
      document.body.style.cursor = "default";
    } else if (kind === "floating") {
      title.textContent = "Your tracker is floating ✓";
      lead.textContent = "To move it, drag the empty part of its top bar, to the right of the extension's name (Chrome doesn't let the name label or the tracker itself be dragged). Resize it from a corner. Point at it for the task name and the Stop / Done buttons.";
      action.innerHTML = '<button class="link" id="closeBtn">Close the tracker</button>';
      note.textContent = "Keep this pinned tab open: closing it closes the tracker.";
      document.body.style.cursor = "default";
      $("closeBtn").onclick = (e) => { e.stopPropagation(); if (pip) pip.close(); };
    } else {
      title.textContent = kind === "closed" ? "The tracker is closed" : "Click anywhere to float your tracker";
      lead.textContent = "Your timer will stay on top of every app, so you always see what you're tracking and how close it is to the estimate.";
      action.innerHTML = '<span class="big">' + (kind === "closed" ? "Float it again" : "Float the tracker") + "</span>";
      note.textContent = "Chrome needs one click here to show a window over other apps. Keep this pinned tab open: closing it closes the tracker.";
      document.body.style.cursor = "pointer";
    }
  }
  async function openPip() {
    if (pip || !supported) return;
    try {
      pip = await window.documentPictureInPicture.requestWindow({ width: (compact() ? COMPACT : SMALL)[0], height: (compact() ? COMPACT : SMALL)[1] });
    } catch (e) {
      $("lead").textContent = "Chrome didn't open it (" + (e && e.message ? e.message : e) + "). Click again.";
      return;
    }
    build();
    theme();
    paint();
    chrome.storage.local.set({ floatOpen: true }).catch(() => {});
    hostState("floating");
    pollComments(true); // new comments on the running task
    pip.addEventListener("pagehide", () => {
      pip = null;
      chrome.storage.local.set({ floatOpen: false }).catch(() => {});
      hostState("closed");
    });
    // Back to where the user was; this pinned tab only has to stay open.
    if (backTab) chrome.tabs.update(backTab, { active: true }).catch(() => {});
  }
  document.addEventListener("click", () => { if (!pip) openPip(); });
  window.addEventListener("pagehide", () => { chrome.storage.local.set({ floatOpen: false }).catch(() => {}); });

  // ---------- live updates ----------
  load().then(() => { theme(); hostState(supported ? "intro" : "unsupported"); });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local") return;
    if (ch.clickupState || ch.runningProgress || ch.settings || ch.lastStoppedTask || ch.resumeTask || ch.theme) load().then(() => { theme(); paint(); });
  });
  setInterval(paint, 1000);
  setInterval(() => { pollComments(false); }, 30000); // each task is checked at most every 3 minutes
  // A timer started or stopped in ClickUp itself shows up within a minute.
  setInterval(() => { if (pip) send({ type: "CLICKUP_SYNC_RUNNING" }); }, 60000);
})();
