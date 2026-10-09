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

  // ---------- strip styles (shared by the extension's floating timer and the taskbar app) ----------
  // d = { tp, tc, tt, dp, dt, anim }: task bar % / colour / text, day bar % / text, animate.
  // B (default): two "batteries" with the time inside.
  // L: two halves, "Task" and "Today", each a label over a bar.
  // F: two thin bars stacked, both times on the right. H: two small rings.
  // J: hairlines on the top / bottom edge.
  // anim: the fills flow (a shine runs along the bars, bubbles rise in the
  // batteries, the rings breathe); off with the system's "reduce motion".
  // Colours follow progress (ssColor): a light cool blue at the start, turning
  // green as the time reaches the estimate, then amber to red past it. The day
  // cell does the same towards the daily target but never turns red.
  const STRIP_STYLES = ["B", "L", "F", "H", "J"];
  // A task's share of its estimate for ONE day: the estimate spread over its
  // working days (Mon-Fri, start date to due date). A week-long 7h task is 1h24
  // a day; a one-day task (or one without a start date) gets all of it.
  function workDays(fromMs, toMs) {
    if (!fromMs || !toMs || toMs < fromMs) return 1;
    const d = new Date(fromMs), e = new Date(toMs);
    d.setHours(12, 0, 0, 0); e.setHours(12, 0, 0, 0);
    let wk = 0, all = 0;
    for (let i = 0; d <= e && i < 400; i++, d.setDate(d.getDate() + 1)) { all++; if (d.getDay() !== 0 && d.getDay() !== 6) wk++; }
    return wk || all || 1;
  }
  const dailyShare = (estMs, fromMs, toMs) => (estMs > 0 ? estMs / workDays(fromMs, toMs) : 0);
  const shortDur = (ms) => { const m = Math.round(Math.max(0, ms) / 60000); const h = Math.floor(m / 60); return h ? h + "h" + (m % 60 ? String(m % 60).padStart(2, "0") : "") : m + "m"; };
  function ssRing(pct, color) {
    const r = 9, c = 2 * Math.PI * r, f = Math.max(0, Math.min(100, pct)) / 100;
    return '<svg width="22" height="22" viewBox="0 0 22 22" class="ring"><circle cx="11" cy="11" r="9" fill="none" stroke="var(--track)" stroke-width="3"/>' +
      '<circle cx="11" cy="11" r="9" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + (c * f).toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 11 11)"/></svg>';
  }
  function ssColor(p, noRed) {
    if (p == null) return "var(--blue)";
    if (p <= 1) { const t = Math.max(0, p); return "hsl(" + (200 - 70 * t).toFixed(0) + " " + (78 - 18 * t).toFixed(0) + "% " + (66 - 20 * t).toFixed(0) + "%)"; }
    if (noRed || p <= 1.07) return "hsl(130 60% 46%)";
    const t = Math.min(1, (p - 1.07) / 0.35);
    return "hsl(" + (130 - 130 * t).toFixed(0) + " " + (60 + 12 * t).toFixed(0) + "% " + (46 + 6 * t).toFixed(0) + "%)";
  }
  // The face's mood for its animation: calm floats, on-estimate bounces, over
  // shakes, idle breathes - and it blinks now and then.
  const faceMood = (p) => (p === "sleep" ? "fz" : p == null ? "fn" : p > 1.07 ? "fo" : p >= 0.93 ? "fh" : "fc");
  const faceCls = (p, anim) => "face" + (anim === false ? "" : " live " + faceMood(p));
  function stripStyleHtml(style, d) {
    const s = STRIP_STYLES.includes(style) ? style : "B";
    const an = d.anim === false ? "" : " an";
    const tb = '<b style="width:' + d.tp.toFixed(1) + "%;background-color:" + d.tc + '"></b>', dc = d.dc || "var(--green)", db = '<b style="width:' + d.dp.toFixed(1) + "%;background-color:" + dc + '"></b>';
    if (s === "L") return '<div class="ss ssL' + an + '"><div class="c"><span class="lb">Task ' + d.tt + '</span><i class="tr">' + tb + '</i></div><div class="c"><span class="lb day">Today ' + d.dt + '</span><i class="tr">' + db + "</i></div></div>";
    if (s === "F") return '<div class="ss ssF' + an + '"><div class="bars"><i class="tr">' + tb + '</i><i class="tr">' + db + '</i></div><div class="tms"><span>' + d.tt + '</span><span class="day">' + d.dt + "</span></div></div>";
    if (s === "H") return '<div class="ss ssH' + an + '">' + ssRing(d.tp, d.tc) + "<span>" + d.tt + "</span>" + ssRing(d.dp, dc) + '<span class="day">' + d.dt + "</span></div>";
    if (s === "J") return '<div class="ss ssJ' + an + '"><i class="edge top" style="width:' + d.tp.toFixed(1) + "%;background-color:" + d.tc + '"></i><span class="big">' + d.tt + '</span><span class="sp"></span><span class="day">today ' + d.dt + '</span><i class="edge bot" style="width:' + d.dp.toFixed(1) + "%;background-color:" + dc + '"></i></div>';
    return '<div class="ss ssB' + an + '"><div class="cell">' + tb + "<span>" + d.tt + '</span></div><div class="cell day">' + db + "<span>Today " + d.dt + "</span></div></div>";
  }
  // The strip is redrawn often: start its animations where the clock says they
  // are, so a redraw never makes them jump back.
  function ssPhase(el) { if (el && el.style) el.style.setProperty("--ph", -((Date.now() % 12000) / 1000).toFixed(2) + "s"); }
  const STRIP_CSS = `
    .ss { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
    .ss .tr { display: block; height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; }
    .ss .tr b { display: block; position: relative; overflow: hidden; height: 100%; border-radius: 2px; transition: width .6s; }
    .ss .day { color: var(--green); }
    .ssL .c { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .ssL .lb { font-size: 10.5px; line-height: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
    .ssL .lb.day { color: var(--green); }
    .ssF .bars { flex: 1; display: flex; flex-direction: column; gap: 5px; }
    .ssF .tms { display: flex; flex-direction: column; align-items: flex-end; font-size: 11px; line-height: 13px; white-space: nowrap; }
    .ssH { gap: 4px; } .ssH .ring { flex: none; } .ssH span { flex: 1; min-width: 0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ssJ { align-self: stretch; position: relative; }
    .ssJ .edge { position: absolute; left: 0; height: 2px; border-radius: 0; overflow: hidden; }
    .ssJ .edge.top { top: 1px; } .ssJ .edge.bot { bottom: 1px; background-color: var(--green); }
    .ssJ .big { font-size: 13px; font-weight: 700; } .ssJ .sp { flex: 1; } .ssJ .day { font-size: 11px; white-space: nowrap; }
    .ssB .cell { flex: 1; min-width: 0; position: relative; height: 20px; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
    .ssB .cell b { position: absolute; left: 0; top: 0; bottom: 0; opacity: .38; border-radius: 0; overflow: hidden; transition: width .6s; }
    .ssB .cell span { position: relative; display: block; text-align: center; font-size: 10.5px; line-height: 18px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 3px; }
    /* animations: a shine flowing along each fill; bubbles rising in the batteries; rings breathing */
    .ss.an .tr b::after, .ss.an .edge::after, .ssB.an .cell b::after { content: ""; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.55), transparent) no-repeat; background-size: 36px 100%;
      animation: ssFlow 2.6s linear infinite; animation-delay: var(--ph, 0s); }
    .ssB.an .cell b::before { content: ""; position: absolute; inset: 0; pointer-events: none;
      background-image: radial-gradient(circle, rgba(255,255,255,.85) 0 1.2px, transparent 1.7px), radial-gradient(circle, rgba(255,255,255,.6) 0 .9px, transparent 1.4px);
      background-size: 17px 18px, 12px 14px; background-position: 0 0, 6px 5px; animation: ssRise 3.4s linear infinite; animation-delay: var(--ph, 0s); }
    .ssB.an .cell b { box-shadow: inset -2px 0 0 rgba(255,255,255,.5); }
    .ssH.an .ring circle + circle { animation: ssBreathe 2.8s ease-in-out infinite; animation-delay: var(--ph, 0s); }
    @keyframes ssFlow { from { background-position: -36px 0; } to { background-position: calc(100% + 36px) 0; } }
    @keyframes ssRise { from { background-position: 0 36px, 6px 33px; } to { background-position: 0 0, 6px 5px; } }
    @keyframes ssBreathe { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .face.live svg { transform-origin: 50% 60%; animation: fcFloat 3.2s ease-in-out infinite; animation-delay: var(--ph, 0s); }
    .face.live.fh svg { animation: fcBounce 1.4s ease-in-out infinite; animation-delay: var(--ph, 0s); }
    .face.live.fo svg { animation: fcShake 1.1s ease-in-out infinite; animation-delay: var(--ph, 0s); }
    .face.live.fz svg { animation: fcBreathe 4s ease-in-out infinite; animation-delay: var(--ph, 0s); }
    .face.live:not(.fz) svg ellipse { transform-box: fill-box; transform-origin: center; animation: fcBlink 4.6s linear infinite; animation-delay: var(--ph, 0s); }
    @keyframes fcFloat { 0%, 100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-1.5px) rotate(3deg); } }
    @keyframes fcBounce { 0%, 100% { transform: translateY(0) scale(1); } 35% { transform: translateY(-2.5px) scale(1.06); } 55% { transform: translateY(0) scale(.97, 1.03); } }
    @keyframes fcShake { 0%, 60%, 100% { transform: rotate(0); } 10%, 30%, 50% { transform: rotate(-8deg); } 20%, 40% { transform: rotate(8deg); } }
    @keyframes fcBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
    @keyframes fcBlink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(.1); } }
    @media (prefers-reduced-motion: reduce) { .ss.an *, .ss.an *::before, .ss.an *::after, .face.live svg, .face.live svg * { animation: none !important; } }
  `;

  { const ssCss = document.createElement("style"); ssCss.textContent = STRIP_CSS; document.head.appendChild(ssCss); }
  let peek = { on: false, dir: "up", h: 0, busy: false };
  const stripMode = () => !!(settings.dock || settings.slim);

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
    // Today on this task (before this timer + the part of it since midnight) and
    // every day's (for the hover card); its share for one day (estimate over its
    // working days) is what the strip measures against.
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const todayTask = (t ? t.closedMs : 0) + (run ? Math.max(0, Date.now() - Math.max(run.startMs, dayStart.getTime())) : 0);
    const tracked = t && t.totalClosedMs != null ? t.totalClosedMs + live : (t ? t.closedMs : 0) + live;
    const est = t ? t.estimateMs : 0;
    const share = dailyShare(est, t && t.startDateMs, t && t.dueDateMs);
    const dp = share ? todayTask / share : null;
    const p = est > 0 ? tracked / est : null;
    const over = p != null && tracked - est >= 60000;
    const today = st && st.today ? st.today.closedMs + live : 0;
    const target = st && st.today ? st.today.targetMs : 0;
    return {
      p, over, tracked, est, todayMs: today, target, todayTask, share, dp,
      overall: est > 0 ? "Overall " + fmt(tracked) + " / " + fmt(est) + (over ? " \u00b7 +" + fmt(tracked - est) + " over" : "") : "Overall " + fmt(tracked),
      time: p == null ? fmt(tracked) : over ? "+" + fmt(tracked - est) + " over" : fmt(tracked) + " / " + fmt(est),
      color: p == null ? "var(--blue)" : p > 1.07 ? "var(--red)" : p >= 0.8 ? "var(--green)" : "var(--blue)",
      width: p == null ? 100 : Math.min(100, p * 100),
      today: st && st.today ? "Today " + fmt(today) + "/" + fmt(st.today.targetMs) : "",
    };
  }

  // ---------- views ----------
  function view() {
    if (st === null) return "setup";
    if (stripMode()) return big && st.running ? "big" : "strip";
    if (big && st.running) return "big";
    if (!st.running) return full ? "idle-full" : "idle";
    return full ? "full" : "mini";
  }
  function render(force) {
    const v = view();
    const k = v + ":" + (peek.on ? peek.dir : "") + ":" + settings.style + ":" + (st && st.running ? st.running.taskId + ":" + st.running.startMs : "") + ":" + settings.size + ":" + !!settings.dock + ":" + (st && st.last ? st.last.id : "") + ":" + (st && st.nexts ? st.nexts.map((n) => n.id).join(",") : "");
    if (!force && k === key) { patch(); return; }
    // Keep what's typed when the view rebuilds.
    const c = $("cmt"), n = $("note");
    if (c) draft.text = c.value;
    if (n) draft.note = n.value;
    key = k;
    card.className = v === "big" ? "big" : v === "setup" ? "setup" : v === "strip" ? "stripwrap" + (peek.on ? " peek " + peek.dir : "") : "";
    card.innerHTML = v === "setup" ? setupHtml() : v === "big" ? bigHtml() : v === "strip" ? stripHtml() : v.startsWith("idle") ? idleHtml(v === "idle-full") : runHtml(v === "full");
    wire(v);
    patch();
  }
  // On the taskbar: one line - face, bar, time - and ▾ for the actions (a menu,
  // because the strip is only as tall as the taskbar).
  // The strip, and - while the pointer is on it - the hover card above (or below) it.
  function stripHtml() {
    const row = '<div class="srow"' + (peek.on ? ' style="height:' + peek.h + 'px"' : "") + ">" + stripRowHtml() + "</div>";
    if (!peek.on) return row;
    const pk = '<div class="pk">' + peekHtml() + "</div>";
    return peek.dir === "up" ? pk + row : row + pk;
  }
  function peekHtml() {
    if (!st.running) {
      const nexts = (st.nexts || []).slice(0, 2);
      return '<div class="lab" style="color:var(--amber)">No timer running</div>' +
        nexts.map((n) => '<button class="next" data-act="start" data-id="' + esc(n.id) + '" title="Start: ' + esc(n.name) + '">&#9654; ' + esc(n.name) + "</button>").join("") +
        '<div class="btns">' + (st.extra ? '<button data-act="extra" title="Start the Extra Task now">&#8644; Start Extra Task</button>' : "") +
        (st.last ? '<button data-act="resume" title="' + esc(st.last.name) + '">&#8617; Resume last</button>' : "") + '<span class="sp"></span><button data-act="menu" title="More">&#9662;</button></div>';
    }
    const t = st.task || {}, run = st.running;
    const meta = [t.client, t.dueDateMs ? "due " + new Date(t.dueDateMs).toLocaleDateString([], { month: "short", day: "numeric" }) : ""].filter(Boolean).join(" · ");
    return '<div class="row"><a class="nm" data-url="' + esc(t.url || "") + '" title="' + esc(run.taskName) + '">' + esc(run.taskName || "(task)") + '</a><button class="x" data-act="big" title="Bigger view: note, comments, files">&#10529;</button></div>' +
      '<div class="sub"><span id="pkAll"></span>' + (meta ? " \u00b7 " + esc(meta) : "") + "</div>" +
      '<div class="btns">' + (t.isExtra ? (st.last ? '<button class="pri" data-act="resume" title="Stop the Extra Task and go back to: ' + esc(st.last.name) + '">&#8617; Back to task</button>' : "")
        : (st.extra ? '<button data-act="extra" title="Stop this timer and start the Extra Task now">&#8644; Extra Task</button>' : "")) +
      '<span class="sp"></span><button data-act="stop">&#9632; Stop</button>' + (t.isExtra ? "" : '<button data-act="complete">&#10003; Done</button>') + '<button data-act="menu" title="More">&#9662;</button></div>';
  }
  function stripRowHtml() {
    const menu = '<button class="x menu" data-act="menu" title="More: Extra Task, bigger view, open in ClickUp…">&#9662;</button>';
    if (!st.running) {
      const next = st.last ? { act: "resume", id: "", name: st.last.name } : (st.nexts && st.nexts[0]) ? { act: "start", id: st.nexts[0].id, name: st.nexts[0].name } : null;
      return '<div class="face">' + face("sleep", 24) + '</div><span class="sub idle" id="today"></span>' +
        (next ? '<button class="x go" data-act="' + next.act + '" data-id="' + esc(next.id) + '" title="Start: ' + esc(next.name) + '">&#9654;</button>' : "") + menu;
    }
    const t = st.task || {};
    return '<div class="face" id="face"></div><div class="ssbox" id="ssbox"></div>' +
      '<button class="x" data-act="stop" title="Stop the timer">&#9632;</button>' +
      (t.isExtra ? (st.last ? '<button class="x" data-act="resume" title="Back to: ' + esc(st.last.name) + '">&#8617;</button>' : "") : '<button class="x done" data-act="complete" title="Done - mark the task complete">&#10003;</button>');
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
    const fp = stripMode() && !big ? n.dp : n.p; // the strip measures today against the day's share
    const f = $("face"); if (f) { f.innerHTML = face(fp, stripMode() && !big ? 22 : big ? 36 : full ? 42 : compact() ? 40 : 50); f.className = faceCls(fp, settings.anim); ssPhase(f); }
    const pa = $("pkAll"); if (pa) pa.textContent = n.overall;
    card.title = "";
    const ss = $("ssbox");
    if (ss) {
      // Task cell: this task today / its share for a day (7h over a week = 1h24).
      const html = stripStyleHtml(settings.style || "B", { tp: n.dp == null ? 100 : Math.min(100, n.dp * 100), tc: ssColor(n.dp), dc: n.target ? ssColor(n.todayMs / n.target, true) : "", tt: n.share ? shortDur(n.todayTask) + "/" + shortDur(n.share) : shortDur(n.todayTask),
        dp: n.target ? Math.min(100, (n.todayMs / n.target) * 100) : 0, dt: n.target ? shortDur(n.todayMs) + "/" + shortDur(n.target) : shortDur(n.todayMs), anim: settings.anim !== false });
      if (ss._html !== html) { ss._html = html; ss.innerHTML = html; ssPhase(ss); }
    }
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
    // The strip: pointing at it opens the hover card (name, Extra Task, Stop, Done).
    if (stripMode() && !big) { wantPeek(inside); return; }
    if (inside) { if (!full && !big && key !== "extra") { full = true; render(); } return; }
    if (big || !full || key === "extra") return;
    const a = document.activeElement;
    if ((a && (a.id === "cmt")) || pending()) return; // keep it open while writing
    full = false; render();
  });
  // The hover card: one wanted state, applied one step at a time. Opening waits
  // a moment (passing over the strip doesn't flash it), closing waits a bit
  // longer (a slip off the edge doesn't close it). A pointer that leaves while it
  // is still opening simply closes it afterwards - it can't get stuck or be
  // drawn before the window has grown.
  let peekT = 0, peekWant = false, peekBusy = false;
  function wantPeek(on) {
    peekWant = !!on;
    clearTimeout(peekT);
    peekT = setTimeout(applyPeek, on ? 120 : 380);
  }
  async function applyPeek() {
    if (peekBusy) return;
    peekBusy = true;
    try {
      for (let i = 0; i < 4 && !big && !!st && peek.on !== peekWant; i++) {
        if (peekWant) {
          const r = await T.peek(true);
          if (!r) break;
          peek = { on: true, dir: r.dir, h: r.stripH, busy: false };
        } else {
          await T.peek(false);
          peek = { on: false, dir: "up", h: 0, busy: false };
        }
        render(true);
      }
    } finally { peekBusy = false; }
  }
  async function setBig(on) {
    if (on) { peekWant = false; clearTimeout(peekT); }
    if (on && peek.on) { peek = { on: false, dir: "up", h: 0, busy: false }; await T.peek(false); }
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
