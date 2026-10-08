// ClickUp Tracker window: mini / pointed-at / bigger views, the mood face,
// comments with screenshots and files, Extra Task switching, next tasks.
// Data comes from the main process (window.tracker); nothing here talks to
// ClickUp directly.
"use strict";
(() => {
  const T = window.tracker;
  const $ = (id) => document.getElementById(id);
  const card = $("card");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (ms) => { const m = Math.round(Math.max(0, ms) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? " " + (m % 60) + "m" : "") : m + "m"; };
  const linkify = (t) => esc(t).replace(/https?:\/\/[^\s<"']+/g, (u) => '<a href="#" data-url="' + u + '">' + u + "</a>").replace(/\n/g, "<br>");

  let st = null, settings = { size: "normal" }, full = false, big = false, busy = false, key = "";
  let comments = { taskId: "", list: [], seen: 0, newCount: 0 }, seenBefore = 0;
  const draft = { taskId: "", text: "", files: [], note: null };
  const compact = () => settings.size === "compact";

  // ---------- face (same as the extension's floating tracker) ----------
  const INK = "#2C2C2A", lerp = (a, b, t) => a + (b - a) * t, cl = (x) => Math.max(0, Math.min(1, x));
  function face(p, size) {
    const svg = (inner, fill) => '<svg width="' + size + '" height="' + size + '" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="' + fill + '" stroke="' + INK + '" stroke-opacity=".25"/>' + inner + "</svg>";
    if (p === "sleep") return svg('<path d="M10.5 19 Q14 21.5 17.5 19 M22.5 19 Q26 21.5 29.5 19" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/><ellipse cx="20" cy="28.5" rx="2.6" ry="1.8" fill="' + INK + '"/><text x="30" y="11" font-size="8" font-weight="700" fill="#7F77DD">z</text>', "hsl(250 25% 72%)");
    if (p == null) return svg('<ellipse cx="14" cy="19" rx="2.2" ry="2.5" fill="' + INK + '"/><ellipse cx="26" cy="19" rx="2.2" ry="2.5" fill="' + INK + '"/><path d="M13 28 L27 28" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"/>', "hsl(45 60% 66%)");
    const s = p <= 1 ? -1 + 2 * p : 1 - 2 * cl((p - 1) / 0.4);
    const anger = p > 1.07 ? cl((p - 1.07) / 0.45) : 0, sad = p < 1 ? cl(-s) : 0;
    const fill = "hsl(" + (p <= 1 ? lerp(210, 130, p) : lerp(130, 0, cl((p - 1) / 0.4))).toFixed(0) + " " + (p <= 1 ? lerp(30, 55, p) : lerp(55, 70, anger)).toFixed(0) + "% 64%)";
    const w = lerp(7.5, 5.5, anger), my = 29 + sad, happy = p >= 0.93 && p <= 1.07;
    const bs = sad * 3.5, ba = anger * 4.5, oy = 13.5 + bs * 0.6 - ba * 0.7, iy = 13.5 - bs + ba, ey = 19 + sad * 0.8;
    const brows = sad > 0.12 || anger > 0.05 ? '<path d="M9.5 ' + oy.toFixed(2) + " L16.5 " + iy.toFixed(2) + " M30.5 " + oy.toFixed(2) + " L23.5 " + iy.toFixed(2) + '" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>' : "";
    const eyes = happy ? '<path d="M11 19.5 Q14 15.5 17 19.5 M23 19.5 Q26 15.5 29 19.5" fill="none" stroke="' + INK + '" stroke-width="2" stroke-linecap="round"/>'
      : '<ellipse cx="14" cy="' + ey + '" rx="2.2" ry="' + (2.5 - anger * 1.1).toFixed(2) + '" fill="' + INK + '"/><ellipse cx="26" cy="' + ey + '" rx="2.2" ry="' + (2.5 - anger * 1.1).toFixed(2) + '" fill="' + INK + '"/>';
    const cheeks = happy ? '<circle cx="10" cy="25" r="2.4" fill="#F09595" opacity=".85"/><circle cx="30" cy="25" r="2.4" fill="#F09595" opacity=".85"/>' : "";
    const tearOp = cl((sad - 0.45) / 0.35);
    const tear = tearOp > 0 ? '<path d="M27.2 21.5 q2.4 3.6 0 5.2 q-2.4 -1.6 0 -5.2z" fill="#378ADD" opacity="' + tearOp.toFixed(2) + '"/>' : "";
    const steam = anger > 0.75 ? '<path d="M5 7 q2 -2 0 -4 M35 7 q-2 -2 0 -4" stroke="#E24B4A" stroke-width="1.6" fill="none" stroke-linecap="round"/>' : "";
    return svg(cheeks + eyes + brows + '<path d="M' + (20 - w).toFixed(2) + " " + my + " Q20 " + (my + 7 * s).toFixed(2) + " " + (20 + w).toFixed(2) + " " + my + '" fill="none" stroke="' + INK + '" stroke-width="2.2" stroke-linecap="round"/>' + tear + steam, fill);
  }
  const mood = (p) => p == null ? "No estimate set" : p < 0.25 ? "Just started" : p < 0.5 ? "Warming up" : p < 0.8 ? "Halfway there" : p < 0.93 ? "Almost there" : p <= 1.07 ? "Right on estimate" : p < 1.25 ? "A little over" : p < 1.45 ? "Over estimate" : "Way over!";

  // ---------- live numbers ----------
  function numbers() {
    const run = st && st.running, t = st && st.task;
    const live = run ? Math.max(0, Date.now() - run.startMs) : 0;
    const tracked = (t ? t.closedMs : 0) + live;
    const est = t ? t.estimateMs : 0;
    const p = est > 0 ? tracked / est : null;
    const over = p != null && tracked - est >= 60000;
    const today = st && st.today ? st.today.closedMs + live : 0;
    return {
      p, over, tracked, est,
      time: p == null ? fmt(tracked) : over ? "+" + fmt(tracked - est) + " over" : fmt(tracked) + " / " + fmt(est),
      color: p == null ? "var(--blue)" : p > 1.07 ? "var(--red)" : p >= 0.8 ? "var(--green)" : "var(--blue)",
      width: p == null ? 100 : Math.min(100, p * 100),
      today: st && st.today ? "Today " + fmt(today) + "/" + fmt(st.today.targetMs) : "",
    };
  }

  // ---------- views ----------
  function view() {
    if (st === null) return "setup";
    if (settings.dock) return big && st.running ? "big" : "strip";
    if (big && st.running) return "big";
    if (!st.running) return full ? "idle-full" : "idle";
    return full ? "full" : "mini";
  }
  function render(force) {
    const v = view();
    const k = v + ":" + (st && st.running ? st.running.taskId + ":" + st.running.startMs : "") + ":" + settings.size + ":" + !!settings.dock + ":" + (st && st.last ? st.last.id : "") + ":" + (st && st.nexts ? st.nexts.map((n) => n.id).join(",") : "");
    if (!force && k === key) { patch(); return; }
    // Keep what's typed when the view rebuilds.
    const c = $("cmt"), n = $("note");
    if (c) draft.text = c.value;
    if (n) draft.note = n.value;
    key = k;
    card.className = v === "big" ? "big" : v === "setup" ? "setup" : v === "strip" ? "strip" : "";
    card.innerHTML = v === "setup" ? setupHtml() : v === "big" ? bigHtml() : v === "strip" ? stripHtml() : v.startsWith("idle") ? idleHtml(v === "idle-full") : runHtml(v === "full");
    wire(v);
    patch();
  }
  // On the taskbar: one line - face, bar, time - and ▾ for the actions (a menu,
  // because the strip is only as tall as the taskbar).
  function stripHtml() {
    const menu = '<button class="x menu" data-act="menu" title="More: Extra Task, bigger view, open in ClickUp…">&#9662;</button>';
    if (!st.running) {
      const next = st.last ? { act: "resume", id: "", name: st.last.name } : (st.nexts && st.nexts[0]) ? { act: "start", id: st.nexts[0].id, name: st.nexts[0].name } : null;
      return '<div class="face">' + face("sleep", 24) + '</div><span class="sub idle" id="today"></span>' +
        (next ? '<button class="x go" data-act="' + next.act + '" data-id="' + esc(next.id) + '" title="Start: ' + esc(next.name) + '">&#9654;</button>' : "") + menu;
    }
    const t = st.task || {};
    return '<div class="face" id="face"></div><div class="trk"><b id="bar"></b></div><span class="tm" id="time"></span>' +
      '<button class="x" data-act="stop" title="Stop the timer">&#9632;</button>' +
      (t.isExtra ? (st.last ? '<button class="x" data-act="resume" title="Back to: ' + esc(st.last.name) + '">&#8617;</button>' : "") : '<button class="x done" data-act="complete" title="Done - mark the task complete">&#10003;</button>') + menu;
  }
  function setupHtml() {
    return '<h1>Connect ClickUp</h1><p><b>Signing in by itself…</b> Keep Chrome (or Edge / Brave) open with the Personal ClickUp Manager extension - it connects this app within a minute. Or paste your ClickUp personal API token: in ClickUp, your avatar &rarr; Settings &rarr; Apps &rarr; API Token. It\'s stored encrypted by your computer and only sent to ClickUp.</p>' +
      '<input class="xin" id="tok" type="password" placeholder="pk_..." autocomplete="off" /><div class="row"><button class="pri" id="tokSave">Connect</button><span class="sub" id="tokMsg"></span></div>';
  }
  function runHtml(isFull) {
    const t = st.task || {}, run = st.running;
    if (!isFull) return '<div class="face" id="face"></div><div class="col"><div class="row"><div class="trk"><b id="bar"></b></div><span class="tm" id="time"></span></div><div class="lab" id="mood"></div></div>';
    return '<div class="face" id="face"></div><div class="col">' +
      '<div class="row"><a class="nm" data-url="' + esc(t.url || "") + '" title="' + esc(run.taskName) + '">' + esc(run.taskName) + "</a>" +
      (t.client && !compact() ? '<span class="chip" title="Client">' + esc(t.client) + "</span>" : "") +
      '<button class="x" data-act="big" title="Bigger view: note, comments, files">&#10529;</button>' +
      (!t.isExtra && st.extra ? '<button class="x" data-act="xopen" title="Switch to the Extra Task (meeting or a quick note)">&#8644; Extra</button>' : "") +
      (t.isExtra && st.last ? '<button class="x pri" data-act="resume" title="Back to: ' + esc(st.last.name) + '">&#8617; Back</button>' : "") + "</div>" +
      '<div class="row"><div class="trk"><b id="bar"></b></div><span class="tm" id="time"></span></div>' +
      (compact() ? "" : '<div class="row"><input class="xin" id="cmt" maxlength="2000" placeholder="Comment + Enter" title="Paste screenshots with Ctrl+V, drop files here, or use the paperclip" /><button class="x" data-act="pick" id="pick" title="Attach files">&#128206;</button><button class="x" data-act="clearfiles" id="clr" hidden>&#10005;</button><span class="sub" id="cmsg"></span></div>') +
      '<div class="row"><span class="sub" id="today" style="font-size:11.5px"></span><span class="btns"><button data-act="stop">&#9632; Stop</button>' +
      (t.isExtra ? "" : '<button data-act="complete">&#10003; Done</button>') + "</span></div></div>";
  }
  function idleHtml(isFull) {
    const nexts = (st.nexts || []).slice(0, compact() ? 1 : 2);
    return '<div class="face">' + face("sleep", compact() ? 38 : 46) + '</div><div class="col"><div class="lab" style="color:var(--amber)">No timer running</div>' +
      (isFull
        ? nexts.map((n) => '<div class="row"><button class="x" data-act="start" data-id="' + esc(n.id) + '" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left" title="Start: ' + esc(n.name) + '">&#9654; ' + esc(n.name) + "</button></div>").join("") +
          '<div class="row"><span class="btns" style="margin-left:0">' + (st.extra ? '<button data-act="xopen">Start Extra Task</button>' : "") + (st.last ? '<button data-act="resume" title="' + esc(st.last.name) + '">Resume last</button>' : "") + "</span></div>"
        : (nexts[0] ? '<div class="sub">Next: ' + esc(nexts[0].name) + "</div>" : "") + '<div class="sub" id="today"></div>') +
      (st.error ? '<div class="sub err">' + esc(st.error) + "</div>" : "") + "</div>";
  }
  function bigHtml() {
    const t = st.task || {}, run = st.running;
    seenBefore = comments.seen || 0;
    return '<div class="bhead"><span class="face" id="face"></span><div class="col">' +
      '<div class="row"><a class="nm" data-url="' + esc(t.url || "") + '">' + esc(run.taskName) + '</a><button class="x" data-act="small">&#10530; Smaller</button></div>' +
      '<div class="row">' + (t.client ? '<span class="chip">' + esc(t.client) + "</span>" : "") + '<span class="sub">' + esc([t.status ? "Status " + t.status : "", t.dueDateMs ? "Due " + new Date(t.dueDateMs).toLocaleDateString([], { month: "short", day: "numeric" }) : "", t.estimateMs ? "Est " + fmt(t.estimateMs) : ""].filter(Boolean).join(" · ")) + "</span></div>" +
      '<div class="row"><div class="trk"><b id="bar"></b></div><span class="tm" id="time"></span></div></div></div>' +
      '<div class="bsec"><div class="bh">Note on this time entry</div><div class="row"><input class="xin" id="note" maxlength="500" placeholder="Shows in your ClickUp Timesheet (Enter saves)" /><span class="sub" id="nmsg"></span></div></div>' +
      '<div class="bsec" id="drop"><div class="bh">Comment on the task</div><textarea class="xin" id="cmt" placeholder="Write a comment. Paste a screenshot with Ctrl+V, or drop files here. Ctrl+Enter posts."></textarea>' +
      '<div class="files" id="files"></div><div class="row"><button class="x" data-act="pick">&#128206; Attach</button><span class="sub" id="cmsg"></span><span class="btns"><button class="x pri" data-act="post">Comment</button></span></div></div>' +
      '<div class="bsec"><div class="bh">Comments</div><div id="clist" class="sub" style="white-space:normal">Loading…</div></div>' +
      '<div class="bfoot"><span class="btns" style="margin-left:0"><button data-act="stop">&#9632; Stop</button>' + (t.isExtra ? "" : '<button data-act="complete">&#10003; Done</button>') +
      (t.isExtra && st.last ? '<button class="pri" data-act="resume">&#8617; Back to task</button>' : "") + "</span></div>";
  }
  function paintComments() {
    const box = $("clist");
    if (!box) return;
    const list = comments.taskId === (st.running && st.running.taskId) ? comments.list : [];
    box.innerHTML = list.length ? list.slice(0, 6).map((c) => '<div class="cmt"><b>' + esc(c.who) + "</b>" +
      (seenBefore && c.at > seenBefore && c.userId !== st.me ? '<span class="newtag">NEW</span>' : "") +
      ' <span class="when">' + esc(new Date(c.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })) + "</span><div>" + linkify(c.text) + "</div></div>").join("") : "No comments yet.";
  }
  function patch() {
    const b = $("badge");
    b.hidden = !(st && st.running && comments.taskId === st.running.taskId && comments.newCount > 0) || big;
    b.textContent = "\u{1F4AC} " + comments.newCount;
    if (!st || !st.running) { const td = $("today"); if (td && st) td.textContent = numbers().today; return; }
    const n = numbers();
    const f = $("face"); if (f) f.innerHTML = face(n.p, settings.dock && !big ? 24 : big ? 36 : full ? 42 : compact() ? 40 : 50);
    card.title = settings.dock && !big ? (st.running.taskName || "") + " - " + n.time + (n.today ? " · " + n.today : "") : "";
    const bar = $("bar"); if (bar) { bar.style.width = n.width.toFixed(1) + "%"; bar.style.background = n.color; bar.style.opacity = n.p == null ? ".35" : ""; }
    const tm = $("time"); if (tm) { tm.textContent = n.time + (big && n.today ? " · " + n.today : ""); tm.style.color = n.over ? "var(--red)" : ""; }
    const md = $("mood"); if (md) { md.textContent = mood(n.p); md.style.color = n.over && n.p > 1.07 ? "var(--red)" : n.p != null && n.p >= 0.93 ? "var(--green)" : ""; }
    const td = $("today"); if (td) td.textContent = n.today;
  }

  // ---------- files for comments ----------
  function addFiles(list) {
    for (const f of [...list].slice(0, 10)) {
      if (f.size > 10 * 1024 * 1024) { msg("cmsg", f.name + " is over 10 MB", true); continue; }
      const fr = new FileReader();
      fr.onload = () => {
        draft.files.push({ name: f.name && f.name !== "image.png" ? f.name : "screenshot-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + ".png", type: f.type || "application/octet-stream", b64: String(fr.result || "").split(",")[1] || "" });
        paintFiles();
      };
      fr.readAsDataURL(f);
    }
  }
  function paintFiles() {
    const pick = $("pick"), clr = $("clr"), box = $("files");
    if (pick) pick.innerHTML = "&#128206;" + (draft.files.length ? draft.files.length : "");
    if (clr) clr.hidden = !draft.files.length;
    if (box) box.innerHTML = draft.files.map((f, i) => '<span class="file">' + esc(f.name) + ' <button data-act="rmfile" data-i="' + i + '">&#10005;</button></span>').join("");
  }
  const msg = (id, t, bad) => { const m = $(id); if (m) { m.textContent = t; m.style.color = bad ? "var(--red)" : ""; } };
  async function postComment() {
    const run = st && st.running;
    const c = $("cmt");
    const text = (c ? c.value : draft.text).trim();
    if (!run || (!text && !draft.files.length)) return true;
    msg("cmsg", draft.files.length ? "Uploading…" : "Posting…");
    const r = await T.action({ type: "comment", taskId: run.taskId, text, files: draft.files });
    if (r && r.ok) {
      draft.text = ""; draft.files = []; if (c) c.value = "";
      paintFiles(); msg("cmsg", "Posted ✓");
      T.comments(true);
      return true;
    }
    msg("cmsg", "Not posted: " + ((r && r.error) || "no reply"), true);
    return false;
  }
  const pending = () => !!(draft.files.length || ($("cmt") ? $("cmt").value.trim() : draft.text.trim()));

  // ---------- wiring ----------
  function wire(v) {
    if (v === "setup") {
      $("tokSave").onclick = async () => {
        msg("tokMsg", "Checking…");
        const r = await T.setup($("tok").value);
        if (!r || !r.ok) msg("tokMsg", (r && r.error) || "Couldn't connect", true);
      };
      $("tok").onkeydown = (e) => { if (e.key === "Enter") $("tokSave").click(); };
      return;
    }
    const c = $("cmt");
    if (c) {
      if (draft.taskId !== (st.running && st.running.taskId)) { draft.taskId = st.running ? st.running.taskId : ""; draft.text = ""; draft.files = []; }
      c.value = draft.text;
      c.oninput = () => { draft.text = c.value; msg("cmsg", ""); };
      c.onkeydown = (e) => { if (e.key === "Enter" && (v !== "big" || e.ctrlKey || e.metaKey)) { e.preventDefault(); postComment(); } };
      c.addEventListener("paste", (e) => { const fl = [...((e.clipboardData && e.clipboardData.files) || [])]; if (fl.length) { e.preventDefault(); addFiles(fl); } });
      paintFiles();
    }
    const n = $("note");
    if (n) {
      n.value = draft.note != null ? draft.note : (st.running.description || "");
      n.onkeydown = async (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        msg("nmsg", "Saving…");
        const r = await T.action({ type: "note", text: n.value });
        msg("nmsg", r && r.ok ? "Saved ✓" : "Not saved", !(r && r.ok));
        draft.note = null;
      };
    }
    if (v === "big") paintComments();
  }
  document.addEventListener("click", async (e) => {
    const link = e.target.closest("[data-url]");
    if (link) { e.preventDefault(); if (link.dataset.url) T.open(link.dataset.url); return; }
    if (big && (e.target === card || e.target.classList.contains("bfoot"))) { setBig(false); return; } // blank space shrinks it
    const b = e.target.closest("button[data-act]");
    if (!b || busy) return;
    const act = b.dataset.act;
    if (act === "big") return setBig(true);
    if (act === "small") return setBig(false);
    if (act === "pick") return $("fileIn").click();
    if (act === "clearfiles") { draft.files = []; return paintFiles(); }
    if (act === "rmfile") { draft.files.splice(Number(b.dataset.i), 1); return paintFiles(); }
    if (act === "post") return postComment();
    if (act === "xopen") return extraPanel();
    if (act === "menu") return T.menu();
    busy = true; b.disabled = true;
    if (act === "stop" || act === "complete" || act === "resume") { if (pending()) await postComment(); }
    const r = await T.action({ type: act, taskId: b.dataset.id });
    busy = false;
    if (r && !r.ok) { const col = card.querySelector(".col") || card; const m = document.createElement("div"); m.className = "sub err"; m.textContent = r.error; col.appendChild(m); }
    if (big && act !== "resume") setBig(false);
  });
  $("fileIn").onchange = (e) => { addFiles(e.target.files || []); e.target.value = ""; };
  $("badge").onclick = () => setBig(true);
  // Files dropped anywhere on the tracker go with the next comment.
  document.addEventListener("dragenter", () => { if (!full && !big && st && st.running) { full = true; render(); } });
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => { e.preventDefault(); if (st && st.running) addFiles(e.dataTransfer.files || []); });
  // Pointing at it shows the full view (the app watches the cursor and sets the opacity).
  T.on("pointer", (inside) => {
    if (settings.dock && !big) return; // the strip doesn't grow on hover - ▾ has the actions
    if (inside) { if (!full && !big && key !== "extra") { full = true; render(); } return; }
    if (big || !full || key === "extra") return;
    const a = document.activeElement;
    if ((a && (a.id === "cmt")) || pending()) return; // keep it open while writing
    full = false; render();
  });
  async function setBig(on) {
    if (on && !(st && st.running)) return;
    big = on;
    await T.expand(on);
    if (on) { T.comments(true); if (st.running) T.seen(st.running.taskId); }
    render(true);
    if (on) setTimeout(() => { const c = $("cmt"); if (c) c.focus(); }, 60);
  }
  function extraPanel() {
    key = "extra";
    card.className = "";
    card.innerHTML = '<div class="face">' + face(0.5, 40) + '</div><div class="col"><div class="row"><span class="lab">Switch to the Extra Task</span><span class="btns"><button class="x" id="xc">&#10005;</button></span></div>' +
      '<div class="row"><button class="x" id="xm">Meeting</button><input class="xin" id="xn" maxlength="200" placeholder="or a note + Enter" /><button class="x pri" id="xg">Start</button></div><div class="sub" id="xmsg">Your current timer stops first.</div></div>';
    const go = async (note) => {
      $("xmsg").textContent = "Starting the Extra Task…";
      if (pending()) await postComment();
      const r = await T.action({ type: "extra", note });
      if (r && !r.ok) { $("xmsg").textContent = r.error; $("xmsg").className = "sub err"; return; }
      render(true);
    };
    $("xc").onclick = () => render(true);
    $("xm").onclick = () => go("Meeting");
    $("xg").onclick = () => go($("xn").value.trim());
    $("xn").onkeydown = (e) => { if (e.key === "Enter") go($("xn").value.trim()); if (e.key === "Escape") render(true); };
    setTimeout(() => $("xn").focus(), 30);
  }

  // ---------- data ----------
  T.on("state", (s) => { st = s; if (key !== "extra") render(); });
  T.on("comments", (c) => { comments = c; patch(); if (big) paintComments(); });
  T.on("settings", (s) => { settings = s; render(true); });
  T.on("big", (on) => { setBig(!!on); });
  (async () => {
    settings = (await T.settings()) || settings;
    st = await T.state();
    render(true);
    T.comments(true);
  })();
  setInterval(() => { if (key !== "extra") patch(); }, 1000);
})();
