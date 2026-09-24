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
    :root { --bg: #fff; --text: #1f2937; --muted: #6b7280; --border: #e5e7eb; --track: #eef0f3; --blue: #378ADD; --green: #16a34a; --red: #dc2626; --amber: #b45309; color-scheme: light; }
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
    #fNote { font-size: 11.5px; padding: 2px 7px; }
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
    const root = d.createElement("div");
    root.id = "root";
    d.body.appendChild(root);
    root.addEventListener("mouseenter", () => { if (data.settings.floatHover !== false) { full = true; paint(); } });
    root.addEventListener("mouseleave", () => { if (data.settings.floatHover !== false && !note.busy()) { full = false; paint(); } });
    // Moving: only Chrome's own top bar (the empty part, not the extension name
    // chip) drags a floating window - Chrome ignores moveBy from the page (tested).
    root.addEventListener("click", (e) => {
      if (data.settings.floatHover === false && !e.target.closest("button,a")) { full = !full; paint(); }
    });
    root.addEventListener("click", onAction);
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
      const canResume = data.last && data.last.id;
      const extra = st.extraTask && st.extraTask.id;
      root.dataset.key = "";
      root.innerHTML = '<div class="face">' + faceSVG("sleep", full ? 40 : 50) + '</div><div class="col">' +
        '<div class="lab" style="color:var(--amber)">No timer running</div>' +
        (today ? '<div class="sub">' + esc(today) + "</div>" : "") +
        (full
          ? '<div class="row"><span class="btns" style="margin-left:0">' +
            (extra ? '<button data-act="xopen">Start Extra Task</button>' : "") + (canResume ? '<button data-act="resume" title="' + esc(data.last.name || "") + '">Resume last</button>' : "") + "</span></div>"
          : (today ? "" : '<div class="sub">Point here to start a task</div>')) +
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
          (client ? '<span class="chip" title="Client">' + esc(client) + "</span>" : "") +
          (!isExtra && st.extraTask && st.extraTask.id ? '<button class="x" data-act="xopen" title="Switch to the Extra Task now (meeting or a quick note)">&#8644; Extra</button>' : "") +
          (isExtra && data.last && data.last.id ? '<button class="x pri" data-act="resume" title="Stop the Extra Task and go back to: ' + esc(data.last.name || "your task") + '">&#8617; Back to task</button>' : "") + "</div>" +
          '<div class="row"><div class="trk"><b id="fBar"></b></div><span class="tm" id="fTime"></span></div>' +
          '<div class="row"><input class="xin" id="fNote" maxlength="500" placeholder="Add a note to this time entry" title="Shows in the Description column of your ClickUp Timesheet. Enter to save; it\'s also saved when you press Stop or Done." /><span class="sub" id="fSaved"></span></div>' +
          '<div class="row"><span class="sub" id="fToday" style="font-size:11.5px"></span><span class="btns"><button data-act="stop" title="Save the note and stop the timer">&#9632; Stop</button>' +
          (isExtra ? "" : '<button data-act="complete" title="Save the note and mark the task complete (stops the timer)">&#10003; Done</button>') + "</span></div></div>";
        note.bind(pip.document.getElementById("fNote"), pip.document.getElementById("fSaved"), run);
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
      root.innerHTML = '<div class="face">' + faceSVG(p, 50) + '</div><div class="col">' + bar +
        '<div class="lab" style="color:' + labColor + '">' + esc(label) + "</div></div>";
    }
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
    if (b.dataset.act === "xopen") { note.commit(); openExtraPanel(); return; }
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
    if (act === "stop" || act === "complete" || act === "resume") await note.commit(); // the note lands on this entry first
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
      pip = await window.documentPictureInPicture.requestWindow({ width: 340, height: 116 });
    } catch (e) {
      $("lead").textContent = "Chrome didn't open it (" + (e && e.message ? e.message : e) + "). Click again.";
      return;
    }
    build();
    theme();
    paint();
    chrome.storage.local.set({ floatOpen: true }).catch(() => {});
    hostState("floating");
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
  // A timer started or stopped in ClickUp itself shows up within a minute.
  setInterval(() => { if (pip) send({ type: "CLICKUP_SYNC_RUNNING" }); }, 60000);
})();
